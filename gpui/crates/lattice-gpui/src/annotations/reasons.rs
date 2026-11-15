//! Citation reasons (`citation-reasons.ts`): a reason is a local annotation
//! whose quote is one citation key, filed with "Why cited" on that `\cite`.
//! It remembers its key's offsets and the text around it, as every
//! annotation does, and is found again by that context
//! (`crate::papers::anchor_reasons`); one whose cite was deleted is left
//! without one (orphaned) rather than moving onto a sibling cite of the
//! same paper, and joins the notes in the Annotations panel.

use std::{collections::HashMap, ops::Range};

use lattice_core::project::{CitationReason, CitationSite, EditorComment, citation_sites};

use super::model::{self, Author, Utf16};

/// The five roles, in the order the popover offers them (`CITATION_ROLES`).
pub const ROLES: [&str; 5] = [
    "supporting",
    "counterexample",
    "method",
    "comparison",
    "background",
];

/// A new reason on the key at bytes `range` of `text` in `path`
/// (`createCitationReason`).
pub fn new_reason(
    path: &str,
    text: &str,
    range: Range<usize>,
    key: &str,
    role: &str,
    body: &str,
    author: &Author,
) -> Option<EditorComment> {
    let mut reason = model::new_note(path, text, range.start, range.end, body, None, author)?;
    reason.citation = Some(CitationReason {
        key: key.to_string(),
        role: role.to_string(),
    });
    Some(reason)
}

/// What a reason stores of where it sits, with its offsets in UTF-16 units
/// as the Tauri app writes them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub from: u32,
    pub to: u32,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
}

/// The reason's stored anchor moved to the cite at bytes `site`, or `None`
/// when it already says exactly that (`reanchoredReason`).
pub fn reanchored(text: &str, reason: &EditorComment, site: Range<usize>) -> Option<Anchor> {
    let quote = text.get(site.clone())?.to_string();
    let (prefix, suffix) = model::context(text, site.start, site.end);
    let units = Utf16::new(text);
    let next = Anchor {
        from: units.to_units(site.start) as u32,
        to: units.to_units(site.end) as u32,
        quote,
        prefix,
        suffix,
    };
    let same = next.from == reason.from
        && next.to == reason.to
        && next.quote == reason.quote
        && next.prefix == reason.prefix
        && next.suffix == reason.suffix;
    (!same).then_some(next)
}

/// `path`'s open reasons among `all`.
pub fn open_on<'a>(all: &'a [EditorComment], path: &str) -> Vec<&'a EditorComment> {
    all.iter()
        .filter(|item| item.citation.is_some() && item.path == path && !item.resolved)
        .collect()
}

/// Each open reason of `path` placed on its cite in `text`: the cite's bytes
/// by the reason's id.
pub fn placed(
    text: &str,
    path: &str,
    all: &[EditorComment],
) -> (Vec<CitationSite>, HashMap<String, Range<usize>>) {
    let sites = citation_sites(text);
    let open = open_on(all, path);
    let at = crate::papers::anchor_reasons(text, &sites, &open);
    let by_id = at
        .into_iter()
        .filter_map(|(from, reason)| {
            let site = sites.iter().find(|site| site.from == from)?;
            Some((reason.id.clone(), site.from..site.to))
        })
        .collect();
    (sites, by_id)
}

/// The reasons the Annotations panel lists (`panelCitationReasons`): those
/// whose cite is gone from their file (orphaned), and those resolved there.
/// An anchored reason belongs to its citation card, not the panel.
/// `source_for` gives a file's text: `Some(None)` for a file that is gone,
/// `None` while it is unread.
pub fn panel_reasons<'a>(
    all: &'a [EditorComment],
    source_for: impl Fn(&str) -> Option<Option<String>>,
) -> Vec<&'a EditorComment> {
    let mut placed_in: HashMap<String, Option<HashMap<String, Range<usize>>>> = HashMap::new();
    all.iter()
        .filter(|reason| reason.citation.is_some())
        .filter(|reason| {
            if reason.resolved {
                return true;
            }
            let entry = placed_in.entry(reason.path.clone()).or_insert_with(|| {
                source_for(&reason.path).map(|text| {
                    text.map(|text| placed(&text, &reason.path, all).1)
                        .unwrap_or_default()
                })
            });
            match entry {
                // Unread: nothing is known yet.
                None => false,
                Some(placed) => !placed.contains_key(&reason.id),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn author() -> Author {
        Author {
            id: "me".into(),
            name: "Me".into(),
        }
    }

    const TEXT: &str = "Attention is all you need~\\cite{vaswani2017}. \
        Later work extends it at length~\\cite{vaswani2017}.";

    fn second_cite() -> Range<usize> {
        let at = TEXT.rfind("vaswani2017").unwrap();
        at..at + "vaswani2017".len()
    }

    /// `citation-reasons.ts`: a reason sits on the cite it was filed on,
    /// not a sibling cite of the same key, and is orphaned once that cite
    /// is deleted.
    #[test]
    fn a_reason_keeps_its_own_cite_and_is_orphaned_when_it_goes() {
        let reason = new_reason(
            "main.tex",
            TEXT,
            second_cite(),
            "vaswani2017",
            "method",
            "",
            &author(),
        )
        .expect("a key is a quote");
        let all = vec![reason.clone()];
        let (_, at) = placed(TEXT, "main.tex", &all);
        assert_eq!(at.get(&reason.id), Some(&second_cite()));
        let without = TEXT.replace(" Later work extends it at length~\\cite{vaswani2017}.", "");
        let (_, at) = placed(&without, "main.tex", &all);
        assert!(at.get(&reason.id).is_none());
        let listed = panel_reasons(&all, |_| Some(Some(without.clone())));
        assert_eq!(listed.len(), 1);
        let listed = panel_reasons(&all, |_| Some(Some(TEXT.to_string())));
        assert!(listed.is_empty());
        // A file not read yet lists nothing; one that is gone lists it.
        assert!(panel_reasons(&all, |_| None).is_empty());
        assert_eq!(panel_reasons(&all, |_| Some(None)).len(), 1);
    }

    /// `reanchoredReason`: nothing to save while the anchor still says
    /// where the cite is; the new context once the text around it changed.
    #[test]
    fn a_reason_is_saved_again_only_when_its_context_changed() {
        let reason = new_reason(
            "main.tex",
            TEXT,
            second_cite(),
            "vaswani2017",
            "method",
            "",
            &author(),
        )
        .expect("a key is a quote");
        assert_eq!(reanchored(TEXT, &reason, second_cite()), None);
        let edited = TEXT.replace("Later work", "Much later work");
        let at = edited.rfind("vaswani2017").unwrap();
        let moved = reanchored(&edited, &reason, at..at + 11).expect("the context changed");
        assert!(moved.prefix.ends_with("extends it at length~\\cite{"));
        assert_eq!(moved.quote, "vaswani2017");
        assert_eq!(moved.from as usize, at);
    }
}
