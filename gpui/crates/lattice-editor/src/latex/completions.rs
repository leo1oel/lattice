//! LaTeX completion sources: built-in commands and environments, the
//! project's citation keys and its labels (the Tauri app's
//! `latexCommandCompletions`, `citationCompletions` and
//! `referenceCompletions`).

use std::sync::LazyLock;

use gpui::{App, WeakEntity};
use regex::Regex;

use crate::{
    ProjectIndex,
    completion::{
        CompletionItem, CompletionKind, CompletionList, CompletionQuery, CompletionSource,
    },
    latex::{
        syntax,
        vocabulary::{self, Entry},
    },
};

static ARGUMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(begin|end|usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\])?\{[^{}]*$")
        .expect("the argument slot pattern compiles")
});
static COMMAND_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\[A-Za-z@]*$").expect("the command word pattern compiles"));
static ARGUMENT_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^{},\s]*$").expect("the argument word pattern compiles"));
/// Commands whose argument has a completion source of its own: picked from
/// the command list, they open it next.
static SLOT_COMMANDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\\(?:cite|citep|citet|citealp|citealt|citeauthor|parencite|textcite|autocite|footcite|ref|eqref|pageref|autoref|cref|Cref)$")
        .expect("the slot command pattern compiles")
});

/// How well `label` matches what was typed: an exact-case prefix first,
/// then any-case prefix, then anywhere, then its letters in order, as
/// CodeMirror's fuzzy matcher ranks them; `None` when it does not match.
pub(crate) fn match_rank(label: &str, query: &str) -> Option<u8> {
    if query.is_empty() || label.starts_with(query) {
        return Some(0);
    }
    let lower_label = label.to_lowercase();
    let lower_query = query.to_lowercase();
    if lower_label.starts_with(&lower_query) {
        return Some(1);
    }
    if lower_label.contains(&lower_query) {
        return Some(2);
    }
    let mut letters = lower_label.chars();
    lower_query
        .chars()
        .all(|wanted| letters.any(|letter| letter == wanted))
        .then_some(3)
}

/// The entries matching `typed`, best first; equally good matches in label
/// order, as CodeMirror's `compareCompletions` (`localeCompare`) puts them,
/// a lower-case letter before its capital.
/// `localeCompare`'s order for ASCII names: case-insensitive, and between
/// names that differ only in case, lowercase first.
fn locale_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}

fn ranked<'a>(entries: impl Iterator<Item = &'a Entry>, typed: &str) -> Vec<&'a Entry> {
    let mut ranked: Vec<_> = entries
        .filter_map(|entry| Some((match_rank(entry.name, typed)?, entry)))
        .collect();
    ranked.sort_by(|(rank, entry), (other_rank, other)| {
        rank.cmp(other_rank)
            .then_with(|| locale_order(entry.name, other.name))
    });
    ranked.into_iter().map(|(_, entry)| entry).collect()
}

/// Built-in commands after a backslash, maths ones only in maths, and
/// environment names, packages and classes in their commands' braces.
pub struct CommandSource;

impl CommandSource {
    fn command(entry: &Entry) -> CompletionItem {
        let (insert, caret) = match entry.template {
            Some(template) => {
                let caret = template.find("{}").map(|group| group + 1);
                (template.to_string(), caret)
            }
            None => (entry.name.to_string(), None),
        };
        CompletionItem {
            label: entry.name.into(),
            reopen: caret.is_some() && SLOT_COMMANDS.is_match(entry.name),
            insert,
            caret,
            detail: Some(entry.detail_text().into()),
            kind: CompletionKind::Command,
        }
    }
}

impl CompletionSource for CommandSource {
    fn complete(&self, query: &CompletionQuery, _: &App) -> Option<CompletionList> {
        let before = query.before;
        if let Some(argument) = ARGUMENT.captures(before) {
            let kind = argument.get(1)?.as_str();
            let word = ARGUMENT_WORD.find(before)?;
            let typed = word.as_str();
            let from = query.before_start() + word.start();
            // A closing brace already there is taken over, not doubled.
            let next = query.text.chars_at(query.offset).next();
            let to = query.offset + usize::from(next == Some('}'));
            let items: Vec<CompletionItem> = match kind {
                "begin" | "end" => ranked(vocabulary::ENVIRONMENTS.iter(), typed)
                    .into_iter()
                    .map(|entry| CompletionItem {
                        label: entry.name.into(),
                        insert: format!("{}}}", entry.name),
                        caret: None,
                        detail: Some(entry.detail_text().into()),
                        kind: CompletionKind::Environment,
                        reopen: false,
                    })
                    .collect(),
                _ => {
                    let names = if kind == "documentclass" {
                        vocabulary::DOCUMENT_CLASSES
                    } else {
                        vocabulary::PACKAGES
                    };
                    names
                        .iter()
                        .filter(|name| match_rank(name, typed).is_some())
                        .map(|name| CompletionItem {
                            label: (*name).into(),
                            insert: format!("{name}}}"),
                            caret: None,
                            detail: None,
                            kind: CompletionKind::Package,
                            reopen: false,
                        })
                        .collect()
                }
            };
            return Some(CompletionList {
                range: from..to,
                items,
            });
        }
        let word = COMMAND_WORD.find(before)?;
        let typed = word.as_str();
        let from = query.before_start() + word.start();
        // Maths is decided in the caret's paragraph; 2,000 bytes each way
        // hold any paragraph a writer types maths in.
        let start = query
            .text
            .clip_offset(query.offset.saturating_sub(2000), language::Bias::Right);
        let end = query.text.clip_offset(
            (query.offset + 2000).min(query.text.len()),
            language::Bias::Left,
        );
        let text: String = query.text.text_for_range(start..end).collect();
        let in_math = syntax::math_region_at(&text, query.offset - start).is_some();
        let commands = vocabulary::COMMANDS
            .iter()
            .filter(|entry| in_math || !entry.math);
        Some(CompletionList {
            range: from..query.offset,
            items: ranked(commands, typed)
                .into_iter()
                .map(Self::command)
                .collect(),
        })
    }
}

/// The project's citation keys in a `\cite`-like command's braces, matched
/// on the key or the title and listed by key; each shows its title, its
/// key and byline in the detail, and inserts the key.
pub struct CitationSource {
    pub index: WeakEntity<ProjectIndex>,
}

impl CompletionSource for CitationSource {
    fn complete(&self, query: &CompletionQuery, cx: &App) -> Option<CompletionList> {
        let slot = syntax::citation_slot(query.before, query.offset)?;
        let index = self.index.upgrade()?;
        let index = index.read(cx);
        let typed = slot.query.to_lowercase();
        let after: String = query
            .text
            .text_for_range(query.offset..(query.offset + 400).min(query.text.len()))
            .collect();
        let to = query.offset + syntax::key_end(&after);
        let mut citations: Vec<_> = index
            .citations()
            .iter()
            .filter(|citation| {
                typed.is_empty()
                    || citation.key.to_lowercase().contains(&typed)
                    || citation.title.to_lowercase().contains(&typed)
            })
            .collect();
        citations.sort_by(|a, b| locale_order(&a.key, &b.key));
        let items = citations
            .into_iter()
            .map(|citation| {
                let byline = super::cards::byline_authors(&citation.authors);
                let detail = [
                    if citation.title.is_empty() {
                        ""
                    } else {
                        citation.key.as_str()
                    },
                    byline.as_deref().unwrap_or(""),
                    citation.year.as_str(),
                    citation.venue.as_str(),
                ]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
                CompletionItem {
                    label: if citation.title.is_empty() {
                        citation.key.clone().into()
                    } else {
                        citation.title.clone().into()
                    },
                    insert: citation.key.clone(),
                    caret: None,
                    detail: (!detail.is_empty()).then(|| detail.into()),
                    kind: CompletionKind::Citation,
                    reopen: false,
                }
            })
            .collect();
        Some(CompletionList {
            range: slot.from..to,
            items,
        })
    }
}

/// The project's labels in a `\ref`-like command's braces, matched on the
/// label or what it names.
pub struct ReferenceSource {
    pub index: WeakEntity<ProjectIndex>,
}

impl CompletionSource for ReferenceSource {
    fn complete(&self, query: &CompletionQuery, cx: &App) -> Option<CompletionList> {
        let slot = syntax::reference_slot(query.before, query.offset)?;
        let index = self.index.upgrade()?;
        let index = index.read(cx);
        let typed = slot.query.to_lowercase();
        let mut seen = std::collections::HashSet::new();
        let items = index
            .references()
            .iter()
            .filter(|reference| {
                typed.is_empty()
                    || reference.label.to_lowercase().contains(&typed)
                    || reference.title.to_lowercase().contains(&typed)
            })
            .filter(|reference| seen.insert(reference.label.clone()))
            .map(|reference| CompletionItem {
                label: reference.label.clone().into(),
                insert: reference.label.clone(),
                caret: None,
                detail: Some(super::cards::reference_kind_label(&reference.kind).into()),
                kind: CompletionKind::Label,
                reopen: false,
            })
            .collect();
        Some(CompletionList {
            range: slot.from..query.offset,
            items,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_rank_prefixes_first() {
        assert_eq!(match_rank("\\section", "\\sec"), Some(0));
        assert_eq!(match_rank("\\Section", "\\sec"), Some(1));
        assert_eq!(match_rank("\\subsection", "section"), Some(2));
        assert_eq!(match_rank("\\textbf", "\\tbf"), Some(3));
        assert_eq!(match_rank("\\emph", "\\x"), None);
    }

    #[test]
    fn keys_sort_as_locale_compare_does() {
        // ["Vaswani2017", "Devlin2019", "devlin2019"].sort((a, b) =>
        // a.localeCompare(b)) in the Tauri app's webview.
        let mut keys = ["Vaswani2017", "Devlin2019", "devlin2019"];
        keys.sort_by(|a, b| locale_order(a, b));
        assert_eq!(keys, ["devlin2019", "Devlin2019", "Vaswani2017"]);
    }

    #[test]
    fn a_template_puts_the_caret_in_its_first_group() {
        let entry = vocabulary::COMMANDS
            .iter()
            .find(|entry| entry.name == "\\textcolor")
            .expect("textcolor is in the vocabulary");
        let item = CommandSource::command(entry);
        assert_eq!(item.insert, "\\textcolor{}{}");
        assert_eq!(item.caret, Some("\\textcolor{".len()));
        assert!(!item.reopen);
        let cite = vocabulary::COMMANDS
            .iter()
            .find(|entry| entry.name == "\\citep")
            .expect("citep is in the vocabulary");
        let item = CommandSource::command(cite);
        assert!(item.reopen, "a picked \\citep lists the keys next");
        assert_eq!(
            item.detail.as_deref(),
            Some("Bibliographic citation (requires natbib or compatible package)")
        );
    }
}
