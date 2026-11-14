//! What a use of a paper says beyond its line (`citation-use-details.ts`):
//! the page its note names and why it cites the paper, a citation reason
//! the writer filed on that `\cite` (`citation-reasons.ts`).
//!
//! A reason remembers its key's offsets and the text around it; the same
//! key usually appears more than once, so each reason scores every cite of
//! its key by how much of that context still surrounds it, and the reasons
//! of one file share the cites out best match first: two reasons never land
//! on one cite, and one whose cite was deleted lands on none.

use std::collections::HashMap;

use gpui::{AppContext as _, Context, Task};
use lattice_core::models::SymbolOccurrence;
use lattice_core::project::{CitationSite, EditorComment, citation_sites};

use crate::papers::PapersPanel;

/// How much text a reason keeps on either side of its key.
const CONTEXT: usize = 32;

/// The least context, both sides together, that still places a reason: a
/// citation command's own scaffolding (`~\cite{` and `}.`) matches at any
/// cite, so a reason must keep more than that.
const MIN_SCORE: usize = 16;

/// One use's detail.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UseDetail {
    pub page: Option<u32>,
    /// The reason's role and what it says.
    pub reason: Option<(String, String)>,
}

/// A citation role's name, as its chip shows it.
pub fn role_label(role: &str) -> Option<&'static str> {
    Some(match role {
        "supporting" => lattice_i18n::tc!("why a passage cites a paper", "Supporting"),
        "counterexample" => lattice_i18n::tc!("why a passage cites a paper", "Counterexample"),
        "method" => lattice_i18n::tc!("why a passage cites a paper", "Method"),
        "comparison" => lattice_i18n::tc!("why a passage cites a paper", "Comparison"),
        "background" => lattice_i18n::tc!("why a passage cites a paper", "Background"),
        _ => return None,
    })
}

fn common_suffix(a: &str, b: &str) -> usize {
    a.chars()
        .rev()
        .zip(b.chars().rev())
        .take_while(|(a, b)| a == b)
        .count()
}

fn common_prefix(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(a, b)| a == b).count()
}

fn score(source: &str, site: &CitationSite, reason: &EditorComment) -> usize {
    let before = &source[..site.from];
    let start = before
        .char_indices()
        .rev()
        .nth(CONTEXT - 1)
        .map_or(0, |(at, _)| at);
    let after: String = source[site.to..].chars().take(CONTEXT).collect();
    // The stored offsets count UTF-16 units, as the Tauri app wrote them.
    let at_own = before.encode_utf16().count() == reason.from as usize;
    common_suffix(&reason.prefix, &before[start..])
        + common_prefix(&reason.suffix, &after)
        + usize::from(at_own)
}

/// The cite each of `reasons` belongs to in `source`, by the cite's offset.
fn anchor_reasons<'a>(
    source: &str,
    sites: &[CitationSite],
    reasons: &[&'a EditorComment],
) -> HashMap<usize, &'a EditorComment> {
    let mut candidates: Vec<(usize, usize, &EditorComment)> = Vec::new();
    for reason in reasons {
        let Some(citation) = &reason.citation else {
            continue;
        };
        for (at, site) in sites.iter().enumerate() {
            if !site.key.eq_ignore_ascii_case(&citation.key) {
                continue;
            }
            let value = score(source, site, reason);
            if value >= MIN_SCORE {
                candidates.push((value, at, reason));
            }
        }
    }
    // Best match first; an equal score goes to the reason made first.
    candidates.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.2.created_at.cmp(&b.2.created_at))
    });
    let mut placed: HashMap<&str, usize> = HashMap::new();
    let mut at_site: HashMap<usize, &EditorComment> = HashMap::new();
    for (_, at, reason) in candidates {
        if placed.contains_key(reason.id.as_str()) || at_site.contains_key(&sites[at].from) {
            continue;
        }
        placed.insert(&reason.id, at);
        at_site.insert(sites[at].from, reason);
    }
    at_site
}

/// Each use's detail, in the order of `usages` (the manuscript scan's uses
/// of one key): a use is matched to its cite by file, line and its place
/// among the key's cites on that line, in the text `sources` holds.
pub fn use_details(
    usages: &[SymbolOccurrence],
    sources: &HashMap<String, String>,
    reasons: &[EditorComment],
) -> Vec<UseDetail> {
    let mut by_path: HashMap<&str, HashMap<(u32, usize), UseDetail>> = HashMap::new();
    let mut seen: HashMap<(&str, u32), usize> = HashMap::new();
    usages
        .iter()
        .map(|usage| {
            let ordinal = seen.entry((&usage.path, usage.line)).or_default();
            let place = (usage.line, *ordinal);
            *ordinal += 1;
            let details = by_path.entry(&usage.path).or_insert_with(|| {
                let Some(source) = sources.get(&usage.path) else {
                    return HashMap::new();
                };
                let sites = citation_sites(source);
                let open: Vec<&EditorComment> = reasons
                    .iter()
                    .filter(|reason| reason.path == usage.path && !reason.resolved)
                    .collect();
                let reason_at = anchor_reasons(source, &sites, &open);
                let mut lines: HashMap<u32, usize> = HashMap::new();
                sites
                    .iter()
                    .filter(|site| site.key.eq_ignore_ascii_case(&usage.symbol))
                    .map(|site| {
                        let ordinal = lines.entry(site.line).or_default();
                        let place = (site.line, *ordinal);
                        *ordinal += 1;
                        let reason = reason_at.get(&site.from).and_then(|reason| {
                            let role = reason.citation.as_ref()?.role.clone();
                            Some((role, reason.body.trim().to_string()))
                        });
                        (
                            place,
                            UseDetail {
                                page: site.page,
                                reason,
                            },
                        )
                    })
                    .collect()
            });
            details.get(&place).cloned().unwrap_or_default()
        })
        .collect()
}

/// The details of the paper in the inspector, read off the main thread for
/// the uses they were read for.
#[derive(Default)]
pub struct UseDetails {
    read: Option<(String, Vec<UseDetail>)>,
    pending: Option<(String, Task<()>)>,
}

/// What the details were read for: the key and every use as the scan saw
/// it, so a rescan that moved or changed a use reads them again.
fn read_key(key: &str, usages: &[SymbolOccurrence]) -> String {
    let mut out = key.to_string();
    for usage in usages {
        out.push_str(&format!(
            "\0{}:{}:{}",
            usage.path, usage.line, usage.snippet
        ));
    }
    out
}

impl PapersPanel {
    /// Each use's page and reason; empty until read.
    pub(super) fn use_details_of(
        &mut self,
        key: &str,
        usages: &[SymbolOccurrence],
        cx: &mut Context<Self>,
    ) -> Vec<UseDetail> {
        let wanted = read_key(key, usages);
        if let Some((read, details)) = &self.use_details.read
            && *read == wanted
        {
            return details.clone();
        }
        if self
            .use_details
            .pending
            .as_ref()
            .is_some_and(|(at, _)| *at == wanted)
        {
            return Vec::new();
        }
        let Some(root) = self.root.clone() else {
            return Vec::new();
        };
        let owned = usages.to_vec();
        let read = cx.background_spawn(async move {
            let reasons: Vec<EditorComment> = lattice_core::project::read_annotations(&root)
                .map(|annotations| {
                    annotations
                        .annotations
                        .into_iter()
                        .filter(|annotation| annotation.citation.is_some())
                        .collect()
                })
                .unwrap_or_default();
            let mut sources = HashMap::new();
            for usage in &owned {
                if !sources.contains_key(&usage.path)
                    && let Ok(text) = std::fs::read_to_string(root.join(&usage.path))
                {
                    sources.insert(usage.path.clone(), text);
                }
            }
            use_details(&owned, &sources, &reasons)
        });
        let at = wanted.clone();
        let task = cx.spawn(async move |this, cx| {
            let details = read.await;
            this.update(cx, |this, cx| {
                this.use_details.read = Some((at, details));
                this.use_details.pending = None;
                cx.notify();
            })
            .ok();
        });
        self.use_details.pending = Some((wanted, task));
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(path: &str, line: u32) -> SymbolOccurrence {
        SymbolOccurrence {
            kind: "citation".into(),
            symbol: "smith".into(),
            role: "reference".into(),
            path: path.into(),
            line,
            snippet: String::new(),
        }
    }

    fn reason(
        id: &str,
        from: u32,
        prefix: &str,
        suffix: &str,
        role: &str,
        body: &str,
    ) -> EditorComment {
        serde_json::from_value(serde_json::json!({
            "id": id, "path": "main.tex", "from": from, "to": from + 5, "quote": "smith",
            "prefix": prefix, "suffix": suffix, "body": body,
            "citation": { "key": "smith", "role": role },
            "authorId": "a", "authorName": "A", "createdAt": "1", "updatedAt": "1",
        }))
        .unwrap()
    }

    /// Two cites of one key on one line, the second with a page note: each
    /// use gets its own page, and the reason filed on the second cite (by
    /// the text around it) lands there, not on the first.
    #[test]
    fn each_use_reads_its_own_page_and_reason() {
        let source = "Prior work \\cite{smith} disagrees; we follow \\cite[p.~7]{smith} closely.\n";
        let second = source.rfind("smith").unwrap() as u32;
        let reasons = [reason(
            "why",
            second,
            "agrees; we follow \\cite[p.~7]{",
            "} closely.\n",
            "method",
            "We use their estimator",
        )];
        let sources = HashMap::from([("main.tex".to_string(), source.to_string())]);
        let details = use_details(
            &[usage("main.tex", 1), usage("main.tex", 1)],
            &sources,
            &reasons,
        );
        assert_eq!(
            details[0],
            UseDetail {
                page: None,
                reason: None
            }
        );
        assert_eq!(
            details[1],
            UseDetail {
                page: Some(7),
                reason: Some(("method".into(), "We use their estimator".into())),
            }
        );
    }

    /// A reason whose context is gone from the file (its cite deleted)
    /// lands on no other cite of the same paper.
    #[test]
    fn a_reason_whose_cite_is_gone_lands_nowhere() {
        let source = "Only \\cite{smith} is left.\n";
        let reasons = [reason(
            "why",
            90,
            "an unrelated sentence entirely {",
            "} gone",
            "background",
            "x",
        )];
        let sources = HashMap::from([("main.tex".to_string(), source.to_string())]);
        let details = use_details(&[usage("main.tex", 1)], &sources, &reasons);
        assert_eq!(details, [UseDetail::default()]);
    }

    #[test]
    fn roles_read_as_the_tauri_app_names_them() {
        assert_eq!(role_label("supporting"), Some("Supporting"));
        assert_eq!(role_label("counterexample"), Some("Counterexample"));
        assert_eq!(role_label("unknown"), None);
    }
}
