//! Where an `\includegraphics` path is and the project file it names, as the
//! Tauri app finds them for its figure card: `graphicsHoverTarget`,
//! `unwrapLatexPath` and `resolveProjectPath` (`latex-symbols.ts`), with
//! `parseGraphicsPaths` and `findPathCandidate` (`latex-text.ts`), whose
//! tests the ones below repeat.
//!
//! A path resolves the way the build reads it: from the root document's
//! folder first (latexmk `-cd` typesets there), then the project's, each
//! with the extensions graphicx tries and under each `\graphicspath` root;
//! only when TeX would find none, the one project file that ends with the
//! path stands in.

use std::{ops::Range, sync::LazyLock};

use regex::Regex;

static GRAPHICS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\includegraphics(?:\[[^\]]*\])?\{((?:\\detokenize\{[^}]*\}|[^}]+))\}")
        .expect("the \\includegraphics pattern compiles")
});
static GRAPHICSPATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\graphicspath\s*\{((?:\{[^}]*\})+)\}")
        .expect("the \\graphicspath pattern compiles")
});
static GRAPHICSPATH_PART: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{([^}]*)\}").expect("the root pattern compiles"));
static DETOKENIZE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\\detokenize\{([^}]*)\}?$").expect("the \\detokenize pattern compiles")
});

/// graphicx tries the extensions it knows; the bare name, last, finds a file
/// saved without one.
const GRAPHICS_EXTENSIONS: &[&str] =
    &[".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps", ".webp", ""];

/// An `\includegraphics` path under the pointer: its span in the text it
/// was found in, and the path as written, unwrapped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphicsTarget {
    pub range: Range<usize>,
    pub path: String,
}

/// The path written, `\detokenize` taken off and backslashes made slashes.
pub fn unwrap_latex_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let inner = DETOKENIZE
        .captures(trimmed)
        .and_then(|found| found.get(1))
        .map_or(trimmed, |inner| inner.as_str());
    inner.trim().replace('\\', "/")
}

/// The `\includegraphics` path under `position` (`graphicsHoverTarget`):
/// the pointer anywhere on the argument, ends included.
pub fn graphics_target(text: &str, position: usize) -> Option<GraphicsTarget> {
    GRAPHICS.captures_iter(text).find_map(|found| {
        let content = found.get(1)?;
        let path = unwrap_latex_path(content.as_str());
        (!path.is_empty() && position >= content.start() && position <= content.end()).then(|| {
            GraphicsTarget {
                range: content.range(),
                path,
            }
        })
    })
}

/// Every `\graphicspath` root the sources name, without trailing slashes,
/// each once, in the order written (`parseGraphicsPaths`).
pub fn graphics_roots<'a>(sources: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for source in sources {
        for found in GRAPHICSPATH.captures_iter(source) {
            let Some(list) = found.get(1) else { continue };
            for part in GRAPHICSPATH_PART.captures_iter(list.as_str()) {
                let root = part[1].trim().replace('\\', "/");
                let root = root.trim_end_matches('/');
                if !root.is_empty() && !roots.iter().any(|known| known == root) {
                    roots.push(root.to_string());
                }
            }
        }
    }
    roots
}

/// `path` with `.` and `..` collapsed; `None` when `..` climbs out of the
/// project folder (`normalizeProjectPath`).
fn normalize(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

/// The file names a figure argument may stand for, in the order graphicx
/// tries them: each extension (none when the file name has one), then each
/// root under it (`pathCandidates`).
fn candidates(path: &str, roots: &[String]) -> Vec<String> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let extensions: &[&str] = if name.contains('.') {
        &[""]
    } else {
        GRAPHICS_EXTENSIONS
    };
    let prefixes: Vec<String> = std::iter::once(String::new())
        .chain(roots.iter().map(|root| format!("{root}/")))
        .collect();
    let mut out = Vec::new();
    for extension in extensions {
        for prefix in &prefixes {
            let mut candidate = format!("{prefix}{path}{extension}");
            while candidate.contains("//") {
                candidate = candidate.replace("//", "/");
            }
            out.push(candidate);
        }
    }
    out
}

/// The project file a `\includegraphics` argument names, project-relative,
/// or `None` (`resolveProjectPath` for a figure; a URL is never a file).
/// `paths` is every project file; `root_document` the manuscript's root.
pub fn resolve_graphics(
    raw: &str,
    paths: &[String],
    roots: &[String],
    root_document: &str,
) -> Option<String> {
    let path = unwrap_latex_path(raw);
    if path.is_empty() || path.starts_with("http:") || path.starts_with("https:") {
        return None;
    }
    let candidates: Vec<String> = candidates(&path, roots)
        .into_iter()
        // An absolute path names a file on disk, never one in the project.
        .filter(|candidate| !candidate.starts_with('/'))
        .collect();
    let has = |wanted: &str| paths.iter().find(|path| path.as_str() == wanted).cloned();
    let folder = root_document
        .rfind('/')
        .map_or("", |at| &root_document[..=at]);
    // On TeX's search path: beside the root document, then (for a root in a
    // subfolder, and a path not pinned to the working folder) the project's.
    for candidate in &candidates {
        let beside = normalize(&format!("{folder}{candidate}")).and_then(|path| has(&path));
        if beside.is_some() {
            return beside;
        }
        if folder.is_empty() || candidate.starts_with("./") || candidate.starts_with("../") {
            continue;
        }
        if let Some(found) = normalize(candidate).and_then(|path| has(&path)) {
            return Some(found);
        }
    }
    // Elsewhere: the one project file ending with the path.
    for candidate in &candidates {
        let Some(wanted) = normalize(candidate) else {
            continue;
        };
        if candidate.split('/').any(|part| part == "." || part == "..") {
            continue;
        }
        let suffix = format!("/{wanted}");
        let mut matching = paths.iter().filter(|path| path.ends_with(&suffix));
        if let (Some(only), None) = (matching.next(), matching.next()) {
            return Some(only.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| path.to_string()).collect()
    }

    #[test]
    fn finds_the_path_hovered_inside_includegraphics_options_and_detokenize_included() {
        let source = "\\includegraphics[width=0.8\\linewidth]{figures/plot} and \\includegraphics{\\detokenize{figs/a b.png}}";
        let from = source.find("figures/plot").unwrap();
        assert_eq!(
            graphics_target(source, source.find("plot").unwrap()),
            Some(GraphicsTarget {
                range: from..from + "figures/plot".len(),
                path: "figures/plot".into(),
            })
        );
        assert_eq!(
            graphics_target(source, source.find("a b").unwrap()).map(|target| target.path),
            Some("figs/a b.png".into())
        );
        assert_eq!(graphics_target(source, source.find("width").unwrap()), None);
        assert_eq!(graphics_target("Plain text", 3), None);
    }

    #[test]
    fn resolves_figures_wrapped_in_detokenize_or_found_through_graphicspath() {
        assert_eq!(
            resolve_graphics(
                "\\detokenize{figures/native-umm-converted.pdf}",
                &paths(&["figures/native-umm-converted.pdf"]),
                &[],
                ""
            )
            .as_deref(),
            Some("figures/native-umm-converted.pdf")
        );
        let roots = graphics_roots(["\\graphicspath{{figs/}{images/}}\n"]);
        assert_eq!(roots, vec!["figs".to_string(), "images".to_string()]);
        let project = paths(&["figs/plot.pdf", "images/other.png"]);
        assert_eq!(
            resolve_graphics("plot", &project, &roots, "").as_deref(),
            Some("figs/plot.pdf")
        );
        assert_eq!(resolve_graphics("missing", &project, &roots, ""), None);
    }

    #[test]
    fn reads_paths_from_the_root_document_s_folder_first() {
        let project = paths(&["paper/figures/plot.png", "figures/plot.png"]);
        assert_eq!(
            resolve_graphics("figures/plot", &project, &[], "paper/main.tex").as_deref(),
            Some("paper/figures/plot.png")
        );
        assert_eq!(
            resolve_graphics("figures/plot.png", &project, &[], "main.tex").as_deref(),
            Some("figures/plot.png")
        );
        // Not on TeX's path, but the only file ending with it.
        assert_eq!(
            resolve_graphics("diagram", &paths(&["assets/diagram.svg"]), &[], "").as_deref(),
            Some("assets/diagram.svg")
        );
        // A URL and an absolute path name no project file.
        assert_eq!(
            resolve_graphics("https://x.org/a.png", &project, &[], ""),
            None
        );
        assert_eq!(resolve_graphics("/tmp/plot.png", &project, &[], ""), None);
    }
}
