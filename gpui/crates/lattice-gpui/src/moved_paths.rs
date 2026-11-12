//! Keeping a moved document's figures in place, as the Tauri app's
//! `rewriteMovedDocumentAssetPaths` does (src/editor/insert/figure-insertion.ts)
//! after a move in its Project pane.
//!
//! Markdown destinations are relative to the document, so a document moved
//! to another folder has each image path rebased. LaTeX paths that already
//! resolve from the project root stay byte-identical, because that is where
//! latexmk resolves them from; only paths explicitly relative to the moved
//! `.tex` file are rebased. An extensionless `\includegraphics{figures/plot}`
//! names the one asset whose path without its extension it is.
//!
//! The patterns are the app's own regular expressions, run with lookahead
//! and backtracking as JavaScript runs them (`fancy-regex`).

use std::{collections::HashSet, sync::LazyLock};

use fancy_regex::Regex;

static MARKDOWN_IMAGE_DESTINATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(!\[(?:\\.|[^\]\\\n])*\]\(\s*)(?:<([^>\n]*)>|((?:\\.|[^()\s])+))(?=(?:\s+(?:"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|\((?:\\.|[^)\n])*\)))?\s*\))"#,
    )
    .expect("the Markdown image pattern compiles")
});
static HTML_IMAGE_SOURCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(<img\b[^>]*?\s+src\s*=\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'=<>`]+))"#)
        .expect("the HTML image pattern compiles")
});
static LATEX_IMAGE_DESTINATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(\\includegraphics\*?(?:\s*\[[^\]\n]*\])?\s*\{)(?:\\detokenize\{([^{}]*)\}|([^{}]*))(?=\})",
    )
    .expect("the LaTeX image pattern compiles")
});
static URI_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z\d+.-]*:").expect("the scheme pattern compiles"));

/// Files Lattice treats as assets, as `collectAssetPaths` does: figures by
/// their extension, and anything binary or a link.
pub fn is_asset(path: &str, kind: &str, content_kind: &str) -> bool {
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase());
    matches!(
        extension.as_deref(),
        Some("png" | "jpg" | "jpeg" | "pdf" | "svg" | "eps" | "webp")
    ) || kind == "figure"
        || content_kind == "binary"
        || content_kind == "symlink"
}

/// Whether moving a document can need its figure paths rewritten.
pub fn is_movable_document(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".tex") || lower.ends_with(".md")
}

/// `source`, the text of the document that moved from `previous` to `next`
/// (project-relative), with its references to `assets` pointing at the same
/// files from its new folder.
pub fn rewrite_moved_document(
    source: &str,
    previous: &str,
    next: &str,
    assets: &HashSet<String>,
) -> String {
    if directory_of(previous) == directory_of(next) {
        return source.to_string();
    }
    let lower = previous.to_ascii_lowercase();
    if lower.ends_with(".md") {
        let rewrite =
            |destination: &str| rewritten_destination(previous, next, destination, assets, false);
        let protected = markdown_protection(source);
        let markdown = rewrite_destinations(
            source,
            &MARKDOWN_IMAGE_DESTINATION,
            &[&|path| format!("<{path}>"), &|path| {
                path.replace(' ', "%20")
            }],
            &|offset| protected(offset),
            &rewrite,
        );
        let protected = markdown_protection(&markdown);
        return rewrite_destinations(
            &markdown,
            &HTML_IMAGE_SOURCE,
            &[
                &|path| format!("\"{path}\""),
                &|path| format!("'{path}'"),
                &|path| path.replace(' ', "%20"),
            ],
            &|offset| protected(offset),
            &rewrite,
        );
    }
    if lower.ends_with(".tex") {
        return rewrite_destinations(
            source,
            &LATEX_IMAGE_DESTINATION,
            &[&|path| format!("\\detokenize{{{path}}}"), &|path| {
                path.to_string()
            }],
            &|offset| latex_command_is_commented(source, offset),
            &|destination| rewritten_destination(previous, next, destination.trim(), assets, true),
        );
    }
    source.to_string()
}

/// Rewrite every destination `pattern` captures: group 1 is the prefix, then
/// one group per destination syntax, which `formats` puts a rewritten path
/// back into.
fn rewrite_destinations(
    source: &str,
    pattern: &Regex,
    formats: &[&dyn Fn(&str) -> String],
    skip: &dyn Fn(usize) -> bool,
    rewrite: &dyn Fn(&str) -> Option<String>,
) -> String {
    let mut out = String::with_capacity(source.len());
    let mut copied = 0;
    for captures in pattern.captures_iter(source).flatten() {
        let whole = captures.get(0).expect("a match");
        let Some(prefix) = captures.get(1) else {
            continue;
        };
        let Some((alternative, destination)) = (0..formats.len())
            .find_map(|ix| captures.get(ix + 2).map(|group| (ix, group.as_str())))
        else {
            continue;
        };
        if skip(whole.start()) {
            continue;
        }
        let Some(rewritten) = rewrite(destination) else {
            continue;
        };
        out.push_str(&source[copied..whole.start()]);
        out.push_str(prefix.as_str());
        out.push_str(&formats[alternative](&rewritten));
        copied = whole.end();
    }
    out.push_str(&source[copied..]);
    out
}

/// Whether the command at byte `position` sits after an unescaped `%` on
/// its line.
fn latex_command_is_commented(source: &str, position: usize) -> bool {
    let bytes = source.as_bytes();
    let line_start = source[..position]
        .rfind('\n')
        .map_or(0, |newline| newline + 1);
    (line_start..position).any(|index| {
        bytes[index] == b'%'
            && bytes[line_start..index]
                .iter()
                .rev()
                .take_while(|byte| **byte == b'\\')
                .count()
                % 2
                == 0
    })
}

/// Whether a byte offset sits inside an HTML comment or a fenced code block.
fn markdown_protection(source: &str) -> impl Fn(usize) -> bool {
    static COMMENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"<!--[\s\S]*?(?:-->|$)").expect("the comment pattern compiles")
    });
    static FENCE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})").expect("the fence pattern compiles"));
    let mut ranges: Vec<(usize, usize)> = COMMENT
        .find_iter(source)
        .flatten()
        .map(|found| (found.start(), found.end()))
        .collect();
    let mut fence: Option<(char, usize, usize)> = None;
    let mut line_start = 0;
    while line_start < source.len() {
        let newline = source[line_start..].find('\n').map(|at| line_start + at);
        let line_end = newline.map_or(source.len(), |at| at + 1);
        let line = &source[line_start..newline.unwrap_or(source.len())];
        let marker = FENCE
            .captures(line)
            .ok()
            .flatten()
            .and_then(|captures| captures.get(1).map(|marker| marker.as_str().to_string()));
        match (&fence, marker) {
            (None, Some(marker)) => {
                let character = marker.chars().next().unwrap_or('`');
                fence = Some((character, marker.chars().count(), line_start));
            }
            (Some((character, length, start)), Some(marker))
                if marker.starts_with(*character)
                    && marker.chars().count() >= *length
                    && line[line.find(&marker).unwrap_or(0) + marker.len()..]
                        .trim()
                        .is_empty() =>
            {
                ranges.push((*start, line_end));
                fence = None;
            }
            _ => {}
        }
        line_start = line_end;
    }
    if let Some((_, _, start)) = fence {
        ranges.push((start, source.len()));
    }
    move |offset| {
        ranges
            .iter()
            .any(|(start, end)| offset >= *start && offset < *end)
    }
}

fn directory_of(path: &str) -> &str {
    path.rfind('/').map_or("", |slash| &path[..slash])
}

/// `path` without its last extension.
fn without_extension(path: &str) -> &str {
    let name_start = path.rfind('/').map_or(0, |slash| slash + 1);
    match path[name_start..].rfind('.') {
        Some(dot) if dot + 1 < path.len() - name_start => &path[..name_start + dot],
        _ => path,
    }
}

/// The path from `from_file`'s folder to `target`, both project-relative.
fn project_relative_path(from_file: &str, target: &str) -> String {
    let mut from: Vec<&str> = from_file
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let mut target: Vec<&str> = target.split('/').filter(|part| !part.is_empty()).collect();
    from.pop();
    while !from.is_empty() && !target.is_empty() && from[0] == target[0] {
        from.remove(0);
        target.remove(0);
    }
    let parts: Vec<&str> = from.iter().map(|_| "..").chain(target).collect();
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

/// JavaScript's `decodeURIComponent`: `None` for a malformed escape.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The project path a reference from `from_file` names, or `None` for an
/// absolute path, a URL or one that climbs out of the project.
fn normalize_asset_reference(from_file: &str, raw: &str) -> Option<String> {
    let decoded = decode_uri_component(raw)?.replace('\\', "/");
    if decoded.is_empty()
        || decoded.starts_with('/')
        || URI_SCHEME.is_match(&decoded).unwrap_or(false)
    {
        return None;
    }
    let mut parts: Vec<&str> = from_file.split('/').collect();
    parts.pop();
    parts.retain(|part| !part.is_empty());
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    let joined = parts.join("/");
    (!joined.is_empty()).then_some(joined)
}

struct Reference {
    path: String,
    suffix: String,
    extensionless: bool,
}

fn referenced_asset(
    from_file: &str,
    raw: &str,
    assets: &HashSet<String>,
    extensionless: bool,
) -> Option<Reference> {
    let (raw_path, suffix) = match raw.find(['?', '#']) {
        Some(at) => (&raw[..at], &raw[at..]),
        None => (raw, ""),
    };
    let normalized = normalize_asset_reference(from_file, raw_path)?;
    if assets.contains(&normalized) {
        return Some(Reference {
            path: normalized,
            suffix: suffix.to_string(),
            extensionless: false,
        });
    }
    let name = normalized.rsplit('/').next().unwrap_or(&normalized);
    let has_extension = name.find('.').is_some_and(|dot| dot + 1 < name.len());
    if !extensionless || has_extension {
        return None;
    }
    let mut matches = assets
        .iter()
        .filter(|path| without_extension(path) == normalized);
    let only = matches.next()?;
    matches.next().is_none().then(|| Reference {
        path: only.clone(),
        suffix: suffix.to_string(),
        extensionless: true,
    })
}

fn rewritten_destination(
    previous: &str,
    next: &str,
    raw: &str,
    assets: &HashSet<String>,
    latex: bool,
) -> Option<String> {
    let reference = referenced_asset(previous, raw, assets, latex)?;
    // latexmk runs from the project root: a LaTeX path that already names an
    // asset from there does not depend on the .tex file's own folder.
    if latex && referenced_asset("root.tex", raw, assets, true).is_some() {
        return None;
    }
    let target = if reference.extensionless {
        without_extension(&reference.path)
    } else {
        &reference.path
    };
    let rewritten = format!(
        "{}{}",
        project_relative_path(next, target),
        reference.suffix
    );
    (rewritten != raw).then_some(rewritten)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assets(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|path| path.to_string()).collect()
    }

    #[test]
    fn latex_paths_relative_to_the_moved_file_are_rebased() {
        let assets = assets(&["chapters/figs/plot.pdf", "figures/root.png"]);
        let source = "\\includegraphics[width=\\linewidth]{figs/plot.pdf}\n\
                      \\includegraphics{figures/root.png}\n\
                      % \\includegraphics{figs/plot.pdf}\n";
        let moved = rewrite_moved_document(source, "chapters/intro.tex", "intro.tex", &assets);
        assert_eq!(
            moved,
            "\\includegraphics[width=\\linewidth]{chapters/figs/plot.pdf}\n\
             \\includegraphics{figures/root.png}\n\
             % \\includegraphics{figs/plot.pdf}\n",
            "a root-relative path and a commented one stay as they were"
        );
    }

    #[test]
    fn detokenized_and_extensionless_latex_paths_keep_their_form() {
        let assets = assets(&["chapters/figs/plot.pdf"]);
        let source = "\\includegraphics{\\detokenize{figs/plot.pdf}} \\includegraphics*{figs/plot}";
        let moved = rewrite_moved_document(source, "chapters/a.tex", "drafts/deep/a.tex", &assets);
        assert_eq!(
            moved,
            "\\includegraphics{\\detokenize{../../chapters/figs/plot.pdf}} \
             \\includegraphics*{../../chapters/figs/plot}"
        );
    }

    #[test]
    fn markdown_destinations_follow_the_document() {
        let assets = assets(&["notes/img/a b.png", "notes/img/c.png"]);
        let source = "![one](img/a%20b.png \"title\")\n<img src=\"img/c.png\">\n```\n![kept](img/c.png)\n```\n";
        let moved = rewrite_moved_document(source, "notes/n.md", "n.md", &assets);
        assert_eq!(
            moved,
            "![one](notes/img/a%20b.png \"title\")\n<img src=\"notes/img/c.png\">\n```\n![kept](img/c.png)\n```\n"
        );
    }

    #[test]
    fn a_document_moved_within_its_folder_is_unchanged() {
        let assets = assets(&["figs/plot.pdf"]);
        let source = "\\includegraphics{figs/plot.pdf}";
        assert_eq!(
            rewrite_moved_document(source, "a.tex", "b.tex", &assets),
            source
        );
    }

    #[test]
    fn helpers_match_the_apps() {
        assert_eq!(project_relative_path("a/b/c.tex", "a/x.png"), "../x.png");
        assert_eq!(project_relative_path("c.tex", "x.png"), "x.png");
        assert_eq!(without_extension("figs/plot.pdf"), "figs/plot");
        assert_eq!(without_extension("figs.d/plot"), "figs.d/plot");
        assert_eq!(
            normalize_asset_reference("a/b.tex", "../x.png").as_deref(),
            Some("x.png")
        );
        assert_eq!(normalize_asset_reference("b.tex", "../x.png"), None);
        assert_eq!(normalize_asset_reference("b.tex", "https://x/y.png"), None);
        assert_eq!(decode_uri_component("a%20b").as_deref(), Some("a b"));
        assert_eq!(decode_uri_component("a%zz"), None);
        assert!(is_asset("figs/plot.PDF", "binary", "binary"));
        assert!(!is_asset("main.tex", "tex", "text"));
    }
}
