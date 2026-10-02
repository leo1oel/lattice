//! The reference index behind hover previews: every `\label` with the
//! figure, table, equation, or section it names.

use super::symbols::iter_tex_sources;
use super::{line_number_at, skip_bytes};
use serde::Serialize;
use std::path::Path;

pub fn references(root: &Path) -> Result<Vec<ReferenceInfo>, String> {
    let mut references = Vec::new();
    for (path, source) in iter_tex_sources(root)? {
        references.extend(parse_latex_references(root, Path::new(&path), &path, &source));
    }
    // Keep duplicate labels so the editor can warn across files; go-to uses the first match.
    references.sort_by(|left, right| {
        left.label
            .to_lowercase()
            .cmp(&right.label.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.line.cmp(&right.line))
    });
    Ok(references)
}

/// Environments a label can name, with the preview kind each produces.
const LABELLED_ENVIRONMENTS: &[(&str, &str)] = &[
    ("figure", "figure"),
    ("figure*", "figure"),
    ("table", "table"),
    ("table*", "table"),
    ("equation", "equation"),
    ("equation*", "equation"),
    ("align", "equation"),
    ("align*", "equation"),
    ("gather", "equation"),
    ("gather*", "equation"),
    ("multline", "equation"),
    ("multline*", "equation"),
];

fn parse_latex_references(
    root: &Path, source_path: &Path, display_path: &str, source: &str,
) -> Vec<ReferenceInfo> {
    let mut references = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = source[cursor..].find("\\label") {
        let position = cursor + offset;
        let Some((label, end)) = command_argument_at(source, position + "\\label".len()) else {
            cursor = position + "\\label".len();
            continue;
        };
        cursor = end;
        let label = label.trim();
        if label.is_empty() {
            continue;
        }

        let environment = LABELLED_ENVIRONMENTS
            .iter()
            .filter_map(|(name, kind)| {
                enclosing_environment(source, position, name)
                    .map(|(start, finish)| (*kind, start, finish))
            })
            .max_by_key(|(_, start, _)| *start);
        let (kind, title, snippet, image_path) = if let Some((kind, start, finish)) = environment {
            let body = &source[start..finish];
            let caption = command_argument(body, "\\caption")
                .map(|value| crate::util::collapse_whitespace(&value))
                .filter(|value| !value.is_empty());
            let image_path = (kind == "figure")
                .then(|| includegraphics_argument(body))
                .flatten()
                .and_then(|value| resolve_graphics_path(root, source_path, &value));
            // Uncaptioned: the interface names the kind in its own language.
            let title = caption.unwrap_or_default();
            (kind.to_string(), title, environment_snippet(body, kind), image_path)
        } else if let Some(title) = nearest_section_title(source, position) {
            ("section".to_string(), title, String::new(), None)
        } else {
            ("reference".to_string(), label.to_string(), String::new(), None)
        };
        references.push(ReferenceInfo {
            label: label.to_string(),
            kind,
            title,
            snippet,
            path: display_path.to_string(),
            line: line_number_at(source, position),
            image_path,
        });
    }
    references
}

fn enclosing_environment(source: &str, position: usize, name: &str) -> Option<(usize, usize)> {
    let opening = format!("\\begin{{{name}}}");
    let closing = format!("\\end{{{name}}}");
    let start = source.get(..position)?.rfind(&opening)?;
    if source.get(..position)?.rfind(&closing).is_some_and(|end| end > start) {
        return None;
    }
    let finish = position + source.get(position..)?.find(&closing)? + closing.len();
    Some((start, finish))
}

fn command_argument(source: &str, command: &str) -> Option<String> {
    let position = source.find(command)? + command.len();
    command_argument_at(source, position).map(|(value, _)| value)
}

/// The brace-balanced `{…}` argument starting at `position` (after optional
/// whitespace), and the offset just past its closing brace.
pub(super) fn command_argument_at(source: &str, position: usize) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    let mut position = skip_bytes(bytes, position, u8::is_ascii_whitespace);
    if bytes.get(position) != Some(&b'{') {
        return None;
    }
    let start = position + 1;
    let mut depth = 1usize;
    position += 1;
    while position < bytes.len() {
        match bytes[position] {
            b'\\' => position += 1,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((source[start..position].to_string(), position + 1));
                }
            }
            _ => {}
        }
        position += 1;
    }
    None
}

fn includegraphics_argument(source: &str) -> Option<String> {
    let command = "\\includegraphics";
    let mut position = source.find(command)? + command.len();
    let bytes = source.as_bytes();
    if bytes.get(position) == Some(&b'*') {
        position += 1;
    }
    position = skip_bytes(bytes, position, u8::is_ascii_whitespace);
    if bytes.get(position) == Some(&b'[') {
        position += 1;
        let mut depth = 1usize;
        while position < bytes.len() && depth > 0 {
            match bytes[position] {
                b'[' => depth += 1,
                b']' => depth -= 1,
                _ => {}
            }
            position += 1;
        }
    }
    command_argument_at(source, position).map(|(value, _)| value.trim().to_string())
}

fn resolve_graphics_path(root: &Path, source_path: &Path, value: &str) -> Option<String> {
    let value = normalized_graphics_path(value)?;
    let requested = Path::new(&value);
    if requested.is_absolute() {
        return None;
    }
    let source_parent = source_path.parent().unwrap_or_else(|| Path::new(""));
    let bases = [root.join(source_parent).join(requested), root.join(requested)];
    for base in bases {
        let candidates = if base.extension().is_some() {
            vec![base]
        } else {
            ["png", "jpg", "jpeg", "svg", "webp", "pdf"]
                .iter()
                .map(|extension| base.with_extension(extension))
                .collect()
        };
        for candidate in candidates {
            let (Ok(canonical), Ok(canonical_root)) =
                (candidate.canonicalize(), root.canonicalize())
            else {
                continue;
            };
            if canonical.is_file() && canonical.starts_with(&canonical_root) {
                return canonical
                    .strip_prefix(&canonical_root)
                    .ok()
                    .map(|path| path.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    None
}

fn normalized_graphics_path(value: &str) -> Option<String> {
    let value = value.trim();
    if !value.starts_with("\\detokenize") {
        return (!value.is_empty()).then(|| value.to_string());
    }
    let (path, end) = command_argument_at(value, "\\detokenize".len())?;
    (end == value.len() && !path.trim().is_empty()).then(|| path.trim().to_string())
}

fn nearest_section_title(source: &str, position: usize) -> Option<String> {
    let before = source.get(..position)?;
    ["\\part", "\\chapter", "\\section", "\\subsection", "\\subsubsection", "\\paragraph"]
        .into_iter()
        .filter_map(|command| {
            let start = before.rfind(command)?;
            let (title, _) = command_argument_at(source, start + command.len())?;
            (position.saturating_sub(start) < 1_200)
                .then_some((start, crate::util::collapse_whitespace(&title)))
        })
        .max_by_key(|(start, _)| *start)
        .map(|(_, title)| title)
}

fn environment_snippet(source: &str, kind: &str) -> String {
    let lines = source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('%'))
        .filter(|line| {
            !["\\begin", "\\end", "\\caption", "\\label"]
                .iter()
                .any(|prefix| line.starts_with(prefix))
                && *line != "\\centering"
                && (kind != "figure" || !line.starts_with("\\includegraphics"))
        })
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    if lines.chars().count() > 480 {
        lines.chars().take(479).collect::<String>() + "…"
    } else {
        lines
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceInfo {
    pub label: String,
    pub kind: String,
    pub title: String,
    pub snippet: String,
    pub path: String,
    pub line: u32,
    pub image_path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    #[test]
    fn latex_labels_are_indexed_for_reference_hover_previews() {
        let fixture = Fixture::project("latex-reference-previews");
        fixture.write("figures/model.png", b"png-bytes");
        fixture.write(
            "main.tex",
            r#"\section{Introduction}\label{sec:intro}
\begin{figure}
  \includegraphics[width=\linewidth]{\detokenize{figures/model.png}}
  \caption{Our model architecture}
  \label{fig:model}
\end{figure}
\begin{table}
  \caption{Main benchmark results}
  \begin{tabular}{lc}
  Method & Score \\
  Ours & 90
  \end{tabular}
  \label{tab:results}
\end{table}
\begin{equation}
  \mathcal{L} = \lVert x - y \rVert_2
  \label{eq:loss}
\end{equation}
"#,
        );

        let indexed = references(&fixture.root).unwrap();
        let find = |label: &str| indexed.iter().find(|item| item.label == label).unwrap();
        let figure = find("fig:model");
        assert_eq!(
            (figure.kind.as_str(), figure.title.as_str()),
            ("figure", "Our model architecture")
        );
        assert_eq!(figure.image_path.as_deref(), Some("figures/model.png"));
        let table = find("tab:results");
        assert_eq!(table.kind, "table");
        assert!(table.snippet.contains("Method & Score"));
        assert_eq!(find("eq:loss").kind, "equation");
        let section = find("sec:intro");
        assert_eq!((section.kind.as_str(), section.title.as_str()), ("section", "Introduction"));
        assert_eq!((section.line, figure.line, table.line), (1, 5, 13));
    }
}
