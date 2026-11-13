//! The reference index behind hover previews: every `\label` with the
//! figure, table, equation, or section it names.

use super::index_sources::SkippedSource;
use super::symbols::read_tex_sources;
use super::{line_number_at, skip_bytes};
use serde::Serialize;
use std::path::Path;

/// Every label the project's readable `.tex` files define, and the files that
/// could not be read: one unreadable draft leaves out its own labels, not the
/// whole index.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceIndex {
    pub references: Vec<ReferenceInfo>,
    pub skipped: Vec<SkippedSource>,
}

pub fn references(root: &Path) -> Result<ReferenceIndex, String> {
    let sources = read_tex_sources(root)?;
    let mut references = Vec::new();
    for (path, source) in &sources.sources {
        references.extend(parse_latex_references(root, Path::new(path), path, source));
    }
    // Keep duplicate labels so the editor can warn across files; go-to uses the first match.
    references.sort_by(|left, right| {
        left.label
            .to_lowercase()
            .cmp(&right.label.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.line.cmp(&right.line))
    });
    Ok(ReferenceIndex { references, skipped: sources.skipped })
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
            // A label in its own minipage or subfigure names that panel: its
            // caption, graphic and lines, when the panel has a caption.
            let (start, finish) = subfloat_around(source, position, start)
                .filter(|(from, to)| !captions(&source[*from..*to]).is_empty())
                .unwrap_or((start, finish));
            let body = &source[start..finish];
            let caption = caption_for_label(body, position - start)
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

/// Environments that hold one panel of a float, each with its own caption and label.
const SUBFLOAT_ENVIRONMENTS: &[&str] = &["minipage", "subfigure", "subtable"];

/// The innermost panel environment around `position` that opens inside the float starting at `float_start`.
fn subfloat_around(source: &str, position: usize, float_start: usize) -> Option<(usize, usize)> {
    SUBFLOAT_ENVIRONMENTS
        .iter()
        .filter_map(|name| enclosing_environment(source, position, name))
        .filter(|(start, _)| *start > float_start)
        .max_by_key(|(start, _)| *start)
}

/// Every caption in `body` with its offset: `\caption`, `\subcaption` and
/// `\captionof{type}`, starred or with a `[short]` form, but not
/// `\captionsetup` and its relatives.
fn captions(body: &str) -> Vec<(usize, String)> {
    let bytes = body.as_bytes();
    let mut found = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = body[cursor..].find("caption") {
        let at = cursor + offset;
        cursor = at + "caption".len();
        let start = if body[..at].ends_with("\\sub") {
            at - 4
        } else if body[..at].ends_with('\\') {
            at - 1
        } else {
            continue;
        };
        let mut position = cursor;
        if body[position..].starts_with("of") {
            position += 2;
            if bytes.get(position).is_some_and(u8::is_ascii_alphabetic) {
                continue;
            }
            // `\captionof{figure}`: the float type comes before the caption.
            position = skip_bytes(bytes, position, |byte| *byte == b'*');
            let Some((_, end)) = command_argument_at(body, position) else { continue };
            position = end;
        } else if bytes.get(position).is_some_and(u8::is_ascii_alphabetic) {
            continue;
        }
        position = skip_bytes(bytes, position, |byte| *byte == b'*' || byte.is_ascii_whitespace());
        if bytes.get(position) == Some(&b'[') {
            position = optional_argument_end(bytes, position);
        }
        if let Some((caption, end)) = command_argument_at(body, position) {
            found.push((start, caption));
            cursor = end;
        }
    }
    found
}

/// Just past the `[…]` opening at `position`, nested brackets and braces included.
fn optional_argument_end(bytes: &[u8], mut position: usize) -> usize {
    let mut depth = 0usize;
    while position < bytes.len() {
        match bytes[position] {
            b'\\' => position += 1,
            b'[' | b'{' => depth += 1,
            b']' | b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return position + 1;
                }
            }
            _ => {}
        }
        position += 1;
    }
    position
}

/// The caption a label at `label_at` in `body` numbers, as LaTeX does: the
/// last one before it, or the first after it for a label written above its caption.
fn caption_for_label(body: &str, label_at: usize) -> Option<String> {
    let all = captions(body);
    all.iter()
        .rev()
        .find(|(at, _)| *at < label_at)
        .or_else(|| all.first())
        .map(|(_, caption)| caption.clone())
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
    // An equation's hover card sets its snippet as math, so only the
    // equation's own `\begin`/`\end` go: a nested `cases` or `split` is
    // part of the formula.
    let (source, dropped): (&str, &[&str]) = if kind == "equation" {
        (equation_body(source), &["\\label"])
    } else {
        (source, &["\\begin", "\\end", "\\caption", "\\label"])
    };
    let lines = source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('%'))
        .filter(|line| {
            !dropped.iter().any(|prefix| line.starts_with(prefix))
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

/// Between an environment's `\begin{…}` and its last `\end{`.
fn equation_body(source: &str) -> &str {
    let start = source.find('}').map_or(0, |brace| brace + 1);
    let end = source.rfind("\\end{").filter(|end| *end >= start).unwrap_or(source.len());
    &source[start..end]
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
\begin{equation} f(x) = \begin{cases}
  1 & x > 0 \\
  0 & \text{otherwise}
\end{cases} \label{eq:step} \end{equation}
"#,
        );

        let indexed = references(&fixture.root).unwrap().references;
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
        let loss = find("eq:loss");
        assert_eq!(
            (loss.kind.as_str(), loss.snippet.as_str()),
            ("equation", "\\mathcal{L} = \\lVert x - y \\rVert_2")
        );
        assert_eq!(
            find("eq:step").snippet,
            "f(x) = \\begin{cases}\n1 & x > 0 \\\\\n0 & \\text{otherwise}\n\\end{cases} \\label{eq:step}"
        );
        let section = find("sec:intro");
        assert_eq!((section.kind.as_str(), section.title.as_str()), ("section", "Introduction"));
        assert_eq!((section.line, figure.line, table.line), (1, 5, 13));
    }

    /// The bench's cross-reference project (tools/perf-bench/crossrefs)
    /// answers `list_references` with `index.json`; this keeps that answer
    /// what the backend reports for the same files.
    #[test]
    fn bench_crossrefs_index_is_what_the_backend_reports() {
        const BENCH: &str =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/perf-bench/crossrefs");
        let read = |path: &str| std::fs::read_to_string(format!("{BENCH}/{path}")).unwrap();
        let fixture = Fixture::project("bench-crossrefs");
        fixture.write("main.tex", read("main.tex"));
        fixture.write("sections/results.tex", read("sections/results.tex"));
        fixture.write("figures/scaled-dot-product-attention.png", b"png");
        fixture.write("figures/multi-head-attention.png", b"png");

        let indexed = references(&fixture.root).unwrap().references;
        let ours = indexed
            .iter()
            .filter(|item| item.path == "main.tex" || item.path == "sections/results.tex")
            .collect::<Vec<_>>();
        let find = |label: &str| *ours.iter().find(|item| item.label == label).unwrap();
        // Each minipage's label names its own panel: its caption and its graphic.
        let failure = find("fig:case-failure");
        assert_eq!(
            (failure.kind.as_str(), failure.title.as_str(), failure.image_path.as_deref()),
            (
                "figure",
                "A failure case: the retrieved context misleads the model into an answer it would not otherwise give",
                Some("figures/scaled-dot-product-attention.png"),
            )
        );
        let cost = find("fig:cost");
        assert_eq!(
            (cost.title.as_str(), cost.image_path.as_deref()),
            ("Inference cost against sequence length", Some("figures/multi-head-attention.png"))
        );
        let table = find("tab:main");
        assert_eq!(
            (table.kind.as_str(), table.path.as_str(), table.line),
            ("table", "sections/results.tex", 5)
        );
        assert_eq!(find("sec:results").title, "Results");

        let actual = serde_json::to_value(&ours).unwrap();
        let staged: serde_json::Value = serde_json::from_str(&read("index.json")).unwrap();
        assert_eq!(
            actual,
            staged,
            "tools/perf-bench/crossrefs/index.json is stale:\n{}",
            serde_json::to_string_pretty(&actual).unwrap()
        );
    }

    #[test]
    fn a_label_names_the_caption_before_it_in_its_own_panel() {
        let body = r"\begin{figure}
  \begin{subfigure}{.5\linewidth}\caption[Short]{Left {panel}}\label{fig:left}\end{subfigure}
  \begin{subfigure}{.5\linewidth}\label{fig:right}\subcaption{Right panel}\end{subfigure}
  \captionsetup{font=small}
  \caption*{Both panels}\label{fig:both}
\end{figure}";
        let indexed =
            parse_latex_references(Path::new("/nowhere"), Path::new("main.tex"), "main.tex", body);
        let title =
            |label: &str| indexed.iter().find(|item| item.label == label).unwrap().title.clone();
        assert_eq!(title("fig:left"), "Left {panel}");
        assert_eq!(title("fig:right"), "Right panel");
        assert_eq!(title("fig:both"), "Both panels");
    }
}
