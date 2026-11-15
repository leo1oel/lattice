//! The project's labels as the open LaTeX buffer has them before it is
//! saved (`parseLocalLabels` and `mergeReferences` in
//! `src/editor/latex/latex-text.ts`, read by `liveReferences`): the saved
//! index's entries for the buffer's file give way to the `\label`s in its
//! text, keeping a saved entry's kind and title where the label is still
//! there, and every other file's entries stay as saved.

use std::{collections::HashMap, sync::LazyLock};

use lattice_editor::index::Reference;
use regex::Regex;

static LABEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\label\{([^}]*)\}").unwrap());

/// Each label `source` defines, first definition only, with its 1-based
/// line and that line's text.
pub fn local_labels(path: &str, source: &str) -> Vec<Reference> {
    let mut labels = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut line = 1u32;
    let mut counted = 0;
    for found in LABEL.captures_iter(source) {
        let whole = found.get(0).expect("a match has its whole");
        let label = found[1].trim();
        if label.is_empty() || !seen.insert(label.to_string()) {
            continue;
        }
        let start = whole.start();
        line += source[counted..start].matches('\n').count() as u32;
        counted = start;
        let line_start = source[..start].rfind('\n').map_or(0, |at| at + 1);
        let line_end = source[start..]
            .find('\n')
            .map_or(source.len(), |at| start + at);
        labels.push(Reference {
            label: label.to_string(),
            kind: "reference".to_string(),
            title: label.to_string(),
            snippet: source[line_start..line_end].trim().to_string(),
            path: path.to_string(),
            line,
        });
    }
    labels
}

/// `saved` with `active_path`'s entries replaced by `local`.
pub fn merge_references(
    saved: &[Reference],
    active_path: &str,
    local: Vec<Reference>,
) -> Vec<Reference> {
    let mut merged: Vec<Reference> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut active: HashMap<&str, &Reference> = HashMap::new();
    let mut put = |merged: &mut Vec<Reference>, reference: Reference| match at.get(&reference.label)
    {
        Some(&index) => merged[index] = reference,
        None => {
            at.insert(reference.label.clone(), merged.len());
            merged.push(reference);
        }
    };
    for reference in saved {
        if reference.path == active_path {
            active.insert(&reference.label, reference);
        } else {
            put(&mut merged, reference.clone());
        }
    }
    for reference in local {
        let reference = match active.get(reference.label.as_str()) {
            Some(existing) => Reference {
                line: reference.line,
                snippet: if reference.snippet.is_empty() {
                    existing.snippet.clone()
                } else {
                    reference.snippet
                },
                path: reference.path,
                ..(*existing).clone()
            },
            None => reference,
        };
        put(&mut merged, reference);
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(
        label: &str,
        kind: &str,
        title: &str,
        snippet: &str,
        path: &str,
        line: u32,
    ) -> Reference {
        Reference {
            label: label.into(),
            kind: kind.into(),
            title: title.into(),
            snippet: snippet.into(),
            path: path.into(),
            line,
        }
    }

    // latex-text.test.ts: "preserves lines and snippets across duplicate,
    // empty, and multiline labels".
    #[test]
    fn labels_keep_lines_and_snippets_across_duplicate_empty_and_multiline_labels() {
        let source = "  \\label{first} \\label{second}  \r\n\n😀 \\label{first}\n\\label{ }\n  \\label{\n last\n} tail";
        assert_eq!(
            local_labels("body.tex", source),
            vec![
                reference(
                    "first",
                    "reference",
                    "first",
                    "\\label{first} \\label{second}",
                    "body.tex",
                    1
                ),
                reference(
                    "second",
                    "reference",
                    "second",
                    "\\label{first} \\label{second}",
                    "body.tex",
                    1
                ),
                reference("last", "reference", "last", "\\label{", "body.tex", 5),
            ]
        );
    }

    #[test]
    fn the_hundredth_label_of_a_long_buffer_is_on_its_own_line() {
        let source: String = (0..100)
            .map(|i| format!("prose\n\\label{{eq:{i}}}\n"))
            .collect();
        let labels = local_labels("main.tex", &source);
        assert_eq!(labels.len(), 100);
        assert_eq!(
            (
                labels[99].label.as_str(),
                labels[99].line,
                labels[99].snippet.as_str()
            ),
            ("eq:99", 200, "\\label{eq:99}")
        );
    }

    // latex-text.test.ts: "merges live labels from the dirty buffer,
    // keeping figure preview metadata".
    #[test]
    fn a_buffer_label_joins_the_other_files_and_keeps_a_saved_figures_kind_and_title() {
        let other = reference("fig:old", "figure", "", "", "other.tex", 1);
        let mut labels: Vec<_> = merge_references(
            &[other],
            "main.tex",
            local_labels("main.tex", "\\label{fig:new}"),
        )
        .into_iter()
        .map(|item| item.label)
        .collect();
        labels.sort();
        assert_eq!(labels, ["fig:new", "fig:old"]);

        let figure = reference(
            "fig:native-umm",
            "figure",
            "Native UMM",
            "\\includegraphics{figures/native-umm.pdf}",
            "main.tex",
            12,
        );
        let merged = merge_references(
            &[figure],
            "main.tex",
            local_labels("main.tex", "\n\\label{fig:native-umm}"),
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(
            (
                merged[0].kind.as_str(),
                merged[0].title.as_str(),
                merged[0].line
            ),
            ("figure", "Native UMM", 2)
        );
    }

    #[test]
    fn a_label_deleted_from_the_buffer_leaves_the_list() {
        let saved = [
            reference("sec:gone", "section", "Gone", "", "main.tex", 3),
            reference("sec:kept", "section", "Kept", "", "other.tex", 1),
        ];
        let merged = merge_references(
            &saved,
            "main.tex",
            local_labels("main.tex", "no labels now"),
        );
        let labels: Vec<_> = merged.iter().map(|item| item.label.as_str()).collect();
        assert_eq!(labels, ["sec:kept"]);
    }
}
