//! A conservative inventory of the project's literal `\includegraphics`,
//! ported from the Tauri app's `src/project/figure-inventory.ts`. Offsets
//! always refer to the original source: comments, verbatim and `\verb` are
//! blanked rather than deleted, so lines and offsets stay as they were. A
//! file whose figures the scan cannot follow (macros, `\graphicspath`,
//! conditionals, an ambiguous or computed name) is reported as limited.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::LazyLock,
};

use regex::Regex;

/// One `\includegraphics` and what surrounds it.
#[derive(Clone, Debug, PartialEq)]
pub struct FigureUse {
    pub source: String,
    pub line: u32,
    /// The argument's span in the original source.
    pub from: usize,
    pub to: usize,
    pub raw: String,
    pub asset: Option<String>,
    pub dynamic: bool,
    pub caption: String,
    pub labels: Vec<String>,
    pub duplicate_labels: Vec<String>,
    pub references: Vec<(String, u32)>,
    pub width_inches: Option<f64>,
}

#[derive(Default)]
pub struct Inventory {
    pub uses: Vec<FigureUse>,
    pub limited: Vec<String>,
}

/// A replacement for one file: its text before and after.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FigureEdit {
    pub path: String,
    pub before: String,
    pub after: String,
}

pub fn is_figure_asset(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    ["pdf", "svg", "png", "jpg", "jpeg", "webp", "eps"]
        .iter()
        .any(|extension| lower.ends_with(&format!(".{extension}")))
}

/// PDF, SVG and EPS figures have no pixels, so no raster size or DPI applies.
pub fn is_vector_figure(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".pdf") || lower.ends_with(".svg") || lower.ends_with(".eps")
}

static IGNORED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)\\begin\{(?:verbatim\*?|lstlisting|minted|comment)\}.*?\\end\{(?:verbatim\*?|lstlisting|minted|comment)\}")
        .expect("the verbatim pattern compiles")
});
static LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\label\{([^}]*)\}").expect("the label pattern compiles"));
static REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:ref|eqref|pageref|autoref|cref|Cref)\*?\{([^}]*)\}")
        .expect("the reference pattern compiles")
});
static BRACED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{([^}]*)\}").expect("the braced part pattern compiles"));
static SLASHES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("/+").expect("the slashes pattern compiles"));
static GRAPHICSPATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\graphicspath\s*\{((?:\{[^}]*\})+)\}").expect("the graphicspath pattern compiles")
});
static LIMITING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:def|[egx]def|newcommand|renewcommand|providecommand|if\w*|DeclareGraphicsExtensions|graphicspath)\b")
        .expect("the limiting pattern compiles")
});
static FIGURE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)\\begin\{figure\*?\}.*?\\end\{figure\*?\}")
        .expect("the figure pattern compiles")
});
static INCLUDEGRAPHICS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\includegraphics(?:[^A-Za-z0-9_]|$)").expect("the graphics pattern compiles")
});
static CAPTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\caption(?:[^A-Za-z0-9_]|$)").expect("the caption pattern compiles")
});
static WIDTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|,)\s*width\s*=\s*(\d+(?:\.\d+)?)\s*(in|cm|mm|pt|bp)\s*(?:,|$)")
        .expect("the width pattern compiles")
});
static UNSIZED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|,)\s*(?:scale|angle|trim|viewport|height|totalheight)\s*=")
        .expect("the size option pattern compiles")
});

/// Blank what TeX ignores, keeping offsets and line numbers: verbatim
/// environments, `\verb`, and `%` comments (not `\%`).
fn visible_tex(text: &str) -> String {
    let mut out = text.as_bytes().to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for byte in &mut out[from..to] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    };
    for found in IGNORED.find_iter(text) {
        blank(&mut out, found.start(), found.end());
    }
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if out[at] == b'\\' && text[at..].starts_with("\\verb") {
            let mut open = at + 5;
            if bytes.get(open) == Some(&b'*') {
                open += 1;
            }
            if let Some(delimiter) = text[open..]
                .chars()
                .next()
                .filter(|c| !c.is_alphanumeric() && !c.is_whitespace() && *c != '_')
                && let Some(close) = text[open + delimiter.len_utf8()..]
                    .find(delimiter)
                    .map(|end| open + 2 * delimiter.len_utf8() + end)
            {
                blank(&mut out, at, close);
                at = close;
                continue;
            }
        }
        if out[at] == b'\\' {
            at += 2;
            continue;
        }
        if out[at] == b'%' {
            let end = text[at..].find('\n').map_or(text.len(), |end| at + end);
            blank(&mut out, at, end);
            at = end;
            continue;
        }
        at += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

/// The braced group starting at `start` (after spaces), `open`/`close` its
/// delimiters: the span inside.
fn group(text: &str, mut start: usize, open: u8, close: u8) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    if bytes.get(start) != Some(&open) {
        return None;
    }
    let mut depth = 1;
    let mut end = start + 1;
    while end < bytes.len() {
        match bytes[end] {
            b'\\' => end += 1,
            byte if byte == open => depth += 1,
            byte if byte == close => {
                depth -= 1;
                if depth == 0 {
                    return Some((start + 1, end));
                }
            }
            _ => {}
        }
        end += 1;
    }
    None
}

/// A command's argument after its optional `*` and `[options]`.
fn argument(text: &str, after: usize) -> Option<(usize, usize, String)> {
    let bytes = text.as_bytes();
    let mut at = after;
    if bytes.get(at) == Some(&b'*') {
        at += 1;
    }
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    let option = group(text, at, b'[', b']');
    if let Some((_, end)) = option {
        at = end + 1;
    }
    let (from, to) = group(text, at, b'{', b'}')?;
    Some((
        from,
        to,
        option
            .map(|(from, to)| text[from..to].to_string())
            .unwrap_or_default(),
    ))
}

/// A physical width only: `\textwidth`, macros, a scale or a transform cannot
/// establish a raster's DPI.
pub fn figure_width_inches(options: &str) -> Option<f64> {
    if UNSIZED.is_match(options) {
        return None;
    }
    let width = WIDTH.captures(options)?;
    let value: f64 = width[1].parse().ok()?;
    let per_inch = match &width[2] {
        "cm" => 2.54,
        "mm" => 25.4,
        "pt" => 72.27,
        "bp" => 72.,
        _ => 1.,
    };
    let inches = value / per_inch;
    (inches > 0.).then_some(inches)
}

fn line_at(text: &str, at: usize) -> u32 {
    text[..at].matches('\n').count() as u32 + 1
}

fn graphics_roots(texts: &[&String]) -> Vec<String> {
    let mut roots = Vec::new();
    for text in texts {
        for found in GRAPHICSPATH.captures_iter(text) {
            for part in BRACED.captures_iter(&found[1]) {
                let path = part[1]
                    .trim()
                    .replace('\\', "/")
                    .trim_end_matches('/')
                    .to_string();
                if !path.is_empty() && !roots.contains(&path) {
                    roots.push(path);
                }
            }
        }
    }
    roots
}

/// The literal `\includegraphics` of `sources` (path → text), with each
/// one's file among `paths` when exactly one matches.
pub fn scan(sources: &BTreeMap<String, String>, paths: &[String]) -> Inventory {
    let texts: BTreeMap<&String, String> = sources
        .iter()
        .map(|(path, text)| (path, visible_tex(text)))
        .collect();
    let roots = graphics_roots(&texts.values().collect::<Vec<_>>());
    let mut label_counts: HashMap<String, usize> = HashMap::new();
    let mut references: HashMap<String, Vec<(String, u32)>> = HashMap::new();
    let mut limited: BTreeSet<String> = BTreeSet::new();
    for (source, text) in &texts {
        if LIMITING.is_match(text) {
            limited.insert((*source).clone());
        }
        for label in LABEL.captures_iter(text) {
            *label_counts.entry(label[1].to_string()).or_default() += 1;
        }
        for reference in REFERENCE.captures_iter(text) {
            let line = line_at(text, reference.get(0).map_or(0, |found| found.start()));
            for label in reference[1].split(',').map(str::trim) {
                references
                    .entry(label.to_string())
                    .or_default()
                    .push(((*source).clone(), line));
            }
        }
    }
    let mut uses = Vec::new();
    for (source, text) in &texts {
        let figures: Vec<(usize, usize)> = FIGURE
            .find_iter(text)
            .map(|found| (found.start(), found.end()))
            .collect();
        for command in INCLUDEGRAPHICS.find_iter(text) {
            let name_end = command.start() + "\\includegraphics".len();
            let Some((from, to, options)) = argument(text, name_end) else {
                limited.insert((*source).clone());
                continue;
            };
            let raw = sources[*source][from..to].to_string();
            let trimmed = raw.trim();
            let literal = trimmed
                .strip_prefix("\\detokenize{")
                .and_then(|rest| rest.strip_suffix('}'))
                .filter(|inner| !inner.contains(['{', '}']))
                .unwrap_or(trimmed);
            let dynamic = literal.contains(['\\', '#', '{', '}'])
                || literal.starts_with("http:")
                || literal.starts_with("https:");
            let has_extension = literal
                .rsplit('/')
                .next()
                .is_some_and(|name| name.contains('.'));
            let candidates: Vec<&String> = paths
                .iter()
                .filter(|path| {
                    std::iter::once(String::new())
                        .chain(roots.iter().map(|root| format!("{root}/")))
                        .any(|root| {
                            let base = format!("{root}{literal}");
                            let base = base.strip_prefix("./").unwrap_or(&base).to_string();
                            let base = SLASHES.replace_all(&base, "/").to_string();
                            **path == base
                                || (!has_extension
                                    && path.starts_with(&format!("{base}."))
                                    && is_figure_asset(path))
                        })
                })
                .collect();
            let asset = (!dynamic && candidates.len() == 1).then(|| candidates[0].clone());
            if dynamic || candidates.len() > 1 {
                limited.insert((*source).clone());
            }
            let figure = figures
                .iter()
                .find(|(start, end)| *start <= command.start() && *end > command.start())
                .map(|(start, end)| &text[*start..*end])
                .unwrap_or("");
            let caption = CAPTION
                .find(figure)
                .and_then(|found| argument(figure, found.start() + "\\caption".len()))
                .map(|(from, to, _)| figure[from..to].trim().to_string())
                .unwrap_or_default();
            let labels: Vec<String> = LABEL
                .captures_iter(figure)
                .map(|label| label[1].to_string())
                .collect();
            uses.push(FigureUse {
                source: (*source).clone(),
                line: line_at(text, command.start()),
                from,
                to,
                raw,
                asset,
                dynamic: dynamic || candidates.len() > 1,
                caption,
                duplicate_labels: labels
                    .iter()
                    .filter(|label| label_counts.get(*label).copied().unwrap_or(0) > 1)
                    .cloned()
                    .collect(),
                references: labels
                    .iter()
                    .flat_map(|label| references.get(label).cloned().unwrap_or_default())
                    .collect(),
                labels,
                width_inches: figure_width_inches(&options),
            });
        }
    }
    Inventory {
        uses,
        limited: limited.into_iter().collect(),
    }
}

/// The exact graphics argument a replacement writes.
pub fn figure_argument(target: &str) -> String {
    format!("\\detokenize{{{target}}}")
}

/// Replace only the previewed arguments, last first, so comments and
/// captions stay as they are; refused when a source changed under them.
pub fn replacement(
    sources: &BTreeMap<String, String>,
    uses: &[FigureUse],
    target: &str,
) -> Result<Vec<FigureEdit>, String> {
    if !is_figure_asset(target) || target.contains(['\\', '{', '}', '%', '#', '\r', '\n']) {
        return Err(lattice_i18n::t!("This figure path cannot be inserted safely.").into());
    }
    let mut files: Vec<&String> = Vec::new();
    for use_ in uses {
        if !files.contains(&&use_.source) {
            files.push(&use_.source);
        }
    }
    files
        .into_iter()
        .map(|path| {
            let before = sources.get(path).cloned().unwrap_or_default();
            let mut after = before.clone();
            let mut here: Vec<&FigureUse> =
                uses.iter().filter(|use_| use_.source == *path).collect();
            here.sort_by_key(|a| std::cmp::Reverse(a.from));
            for use_ in here {
                if before.get(use_.from..use_.to) != Some(use_.raw.as_str()) {
                    return Err(lattice_i18n::t!(
                        "The figure source changed. Refresh and preview again."
                    )
                    .into());
                }
                after.replace_range(use_.from..use_.to, &figure_argument(target));
            }
            Ok(FigureEdit {
                path: path.clone(),
                before,
                after,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources(files: &[(&str, &str)]) -> BTreeMap<String, String> {
        files
            .iter()
            .map(|(path, text)| (path.to_string(), text.to_string()))
            .collect()
    }

    #[test]
    fn finds_each_literal_figure_with_its_caption_labels_and_references() {
        let main = "\\begin{figure}\n\\includegraphics[width=3in]{figures/plot}\n\\caption{The plot.}\\label{fig:plot}\n\\end{figure}\nSee Figure~\\ref{fig:plot}.\n% \\includegraphics{figures/old}\n";
        let paths: Vec<String> = ["figures/plot.pdf", "figures/plot.png.bak", "main.tex"]
            .map(String::from)
            .to_vec();
        let inventory = scan(&sources(&[("main.tex", main)]), &paths);
        assert_eq!(
            inventory.uses.len(),
            1,
            "the commented-out figure is not one"
        );
        let figure = &inventory.uses[0];
        assert_eq!(figure.line, 2);
        assert_eq!(figure.asset.as_deref(), Some("figures/plot.pdf"));
        assert_eq!(figure.caption, "The plot.");
        assert_eq!(figure.labels, ["fig:plot"]);
        assert_eq!(figure.references, [("main.tex".to_string(), 5)]);
        assert_eq!(figure.width_inches, Some(3.));
        assert_eq!(&main[figure.from..figure.to], "figures/plot");
        assert!(inventory.limited.is_empty());
    }

    #[test]
    fn a_computed_or_ambiguous_name_limits_the_file() {
        let main = "\\includegraphics{\\figdir/a}\n\\includegraphics{b}\n";
        let paths: Vec<String> = ["b.pdf", "b.png"].map(String::from).to_vec();
        let inventory = scan(&sources(&[("main.tex", main)]), &paths);
        assert!(
            inventory
                .uses
                .iter()
                .all(|use_| use_.dynamic && use_.asset.is_none())
        );
        assert_eq!(inventory.limited, ["main.tex"]);
    }

    #[test]
    fn a_verb_with_a_non_ascii_delimiter_hides_its_text() {
        let main = "\\verb§\\includegraphics{a}§ und \\verb*。\\includegraphics{a}。\n\\verb_x_ \\includegraphics{b}\n";
        let paths: Vec<String> = ["a.png", "b.png"].map(String::from).to_vec();
        let inventory = scan(&sources(&[("main.tex", main)]), &paths);
        let assets: Vec<_> = inventory
            .uses
            .iter()
            .map(|use_| use_.asset.as_deref())
            .collect();
        assert_eq!(assets, [Some("b.png")]);
        assert_eq!(inventory.uses[0].line, 2);
    }

    #[test]
    fn a_replacement_writes_only_the_listed_arguments() {
        let main = "\\includegraphics{a}\n% keep {a}\n\\includegraphics[width=2cm]{a}\n";
        let files = sources(&[("main.tex", main)]);
        let inventory = scan(&files, &["a.png".to_string(), "b.pdf".to_string()]);
        let edits = replacement(&files, &inventory.uses, "b.pdf").unwrap();
        assert_eq!(
            edits[0].after,
            "\\includegraphics{\\detokenize{b.pdf}}\n% keep {a}\n\\includegraphics[width=2cm]{\\detokenize{b.pdf}}\n"
        );
        assert!(replacement(&files, &inventory.uses, "b{x}.pdf").is_err());
        assert_eq!(figure_width_inches("width=2.54cm"), Some(1.));
        assert_eq!(figure_width_inches("width=0.5\\textwidth"), None);
        assert_eq!(figure_width_inches("width=3in,scale=2"), None);
    }
}
