//! The manuscript's outline: its headings, read from the root document
//! through each `\input` and `\include` as TeX reads them, in reading order
//! (`src/editor/latex/latex-outline.ts`), and the PDF page each heading
//! landed on (lattice-core's `heading_pages`, one read of the SyncTeX map).
//!
//! The PDF toolbar's Outline lists it; the source editor's outline rail
//! shows each heading's page beside it.

use std::path::Path;

use lattice_core::latex::{self, SourceLine};

/// One heading, flattened from the outline's tree in reading order.
#[derive(Clone, Debug, PartialEq)]
pub struct Heading {
    /// 1 `\part` … 5 `\subsubsection`.
    pub level: u8,
    pub title: String,
    /// Project-relative, with forward slashes.
    pub path: String,
    /// 1-based.
    pub line: u32,
    /// How many headings it is nested under.
    pub depth: usize,
    /// `\section*` and its kin.
    pub starred: bool,
    /// After `\appendix` (or in an `appendices` environment).
    pub appendix: bool,
    /// The PDF page it is typeset on, once a build's SyncTeX map says.
    pub page: Option<u32>,
}

const SECTIONS: [(&str, u8); 5] = [
    ("part", 1),
    ("chapter", 2),
    ("section", 3),
    ("subsection", 4),
    ("subsubsection", 5),
];

/// Environments whose text TeX does not read as the document's.
const QUOTED: [&str; 6] = [
    "verbatim",
    "verbatim*",
    "lstlisting",
    "minted",
    "comment",
    "Verbatim",
];

/// `source` with comments and quoted environments blanked to spaces, so
/// offsets and lines stay where they were.
pub fn visible_source(source: &str) -> String {
    let mut out: Vec<u8> = source.as_bytes().to_vec();
    let bytes = source.as_bytes();
    let mut ix = 0;
    while ix < bytes.len() {
        match bytes[ix] {
            b'\\' => ix += 2,
            b'%' => {
                while ix < bytes.len() && bytes[ix] != b'\n' {
                    out[ix] = b' ';
                    ix += 1;
                }
            }
            _ => ix += 1,
        }
    }
    let mut visible = String::from_utf8(out).unwrap_or_else(|_| source.to_string());
    for name in QUOTED {
        let begin = format!("\\begin{{{name}}}");
        let end = format!("\\end{{{name}}}");
        let mut from = 0;
        while let Some(start) = visible[from..].find(&begin).map(|at| from + at) {
            let stop = visible[start..]
                .find(&end)
                .map(|at| start + at + end.len())
                .unwrap_or(visible.len());
            let blank: String = visible[start..stop]
                .chars()
                .map(|ch| if ch == '\n' { '\n' } else { ' ' })
                .collect();
            visible.replace_range(start..stop, &blank);
            from = start + blank.len();
        }
    }
    visible
}

/// The end of the group opening at `at` with `open` (past its `close`),
/// braces balanced and escapes skipped.
fn group_end(text: &str, at: usize, open: u8, close: u8) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.get(at) != Some(&open) {
        return None;
    }
    let mut depth = 0;
    let mut ix = at;
    while ix < bytes.len() {
        match bytes[ix] {
            b'\\' => ix += 1,
            byte if byte == open => depth += 1,
            byte if byte == close => {
                depth -= 1;
                if depth == 0 {
                    return Some(ix + 1);
                }
            }
            _ => {}
        }
        ix += 1;
    }
    None
}

fn skip_space(text: &str, mut at: usize) -> usize {
    let bytes = text.as_bytes();
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    at
}

/// A heading's argument as a reader sees it (`headingTitle`): font switches
/// and labels dropped, wrappers unwrapped, escapes resolved; math and any
/// command it does not know stay as written.
pub fn heading_title(text: &str) -> String {
    const WRAPPERS: [&str; 19] = [
        "textbf",
        "textit",
        "textsl",
        "textsc",
        "textup",
        "textmd",
        "textrm",
        "textsf",
        "texttt",
        "textnormal",
        "emph",
        "underline",
        "mbox",
        "hbox",
        "text",
        "uppercase",
        "lowercase",
        "MakeUppercase",
        "MakeLowercase",
    ];
    const SILENT: [&str; 22] = [
        "protect",
        "relax",
        "noindent",
        "nobreak",
        "boldmath",
        "unboldmath",
        "bfseries",
        "itshape",
        "scshape",
        "slshape",
        "upshape",
        "mdseries",
        "rmfamily",
        "sffamily",
        "ttfamily",
        "normalfont",
        "bf",
        "it",
        "sc",
        "sl",
        "rm",
        "em",
    ];
    const DROPPED: [&str; 8] = [
        "label",
        "footnote",
        "thanks",
        "index",
        "footnotemark",
        "hspace",
        "vspace",
        "phantom",
    ];
    let literal = |name: &str| -> Option<&'static str> {
        Some(match name {
            "&" => "&",
            "%" => "%",
            "$" => "$",
            "#" => "#",
            "_" => "_",
            "{" => "{",
            "}" => "}",
            " " | "\\" | "," | ";" | "quad" | "qquad" | "newline" | "linebreak" => " ",
            "ldots" | "dots" => "…",
            "textendash" => "–",
            "textemdash" => "—",
            "S" => "§",
            "LaTeX" => "LaTeX",
            "TeX" => "TeX",
            _ => return None,
        })
    };
    let mut out = String::new();
    let mut ix = 0;
    while ix < text.len() {
        let rest = &text[ix..];
        if rest.starts_with('$') {
            // Math stays as written.
            let delimiter = if rest.starts_with("$$") { "$$" } else { "$" };
            match rest[delimiter.len()..].find(delimiter) {
                Some(end) => {
                    let stop = delimiter.len() * 2 + end;
                    out.push_str(&rest[..stop]);
                    ix += stop;
                }
                None => {
                    out.push_str(rest);
                    break;
                }
            }
            continue;
        }
        if let Some(command) = rest.strip_prefix('\\') {
            let name_len = command
                .chars()
                .take_while(|ch| ch.is_ascii_alphabetic())
                .count()
                .max(usize::from(!command.is_empty()));
            let name = &command[..name_len.min(command.len())];
            let after = ix + 1 + name.len();
            if WRAPPERS.contains(&name) {
                let start = skip_space(text, after);
                if let Some(end) = group_end(text, start, b'{', b'}') {
                    out.push_str(&heading_title(&text[start + 1..end - 1]));
                    ix = end;
                    continue;
                }
            }
            if DROPPED.contains(&name) {
                let mut end = after;
                while let Some(next) = group_end(text, skip_space(text, end), b'[', b']')
                    .or_else(|| group_end(text, skip_space(text, end), b'{', b'}'))
                {
                    end = next;
                }
                ix = end;
                continue;
            }
            if SILENT.contains(&name) {
                ix = after;
                continue;
            }
            if let Some(glyph) = literal(name) {
                out.push_str(glyph);
                ix = after;
                continue;
            }
            out.push('\\');
            out.push_str(name);
            ix = after;
            continue;
        }
        let ch = rest.chars().next().unwrap_or(' ');
        match ch {
            '{' | '}' => {}
            '~' => out.push(' '),
            ch => out.push(ch),
        }
        ix += ch.len_utf8();
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

enum Event {
    Section {
        offset: usize,
        level: u8,
        title: String,
        starred: bool,
    },
    Include {
        raw: String,
    },
    Appendix,
}

fn events(source: &str) -> Vec<Event> {
    let visible = visible_source(source);
    let text = visible.as_str();
    let bytes = text.as_bytes();
    let mut events = Vec::new();
    let mut ix = 0;
    while let Some(at) = text[ix..].find('\\').map(|at| ix + at) {
        let name_end = at
            + 1
            + text[at + 1..]
                .bytes()
                .take_while(|byte| byte.is_ascii_alphabetic() || *byte == b'@')
                .count();
        let name = &text[at + 1..name_end];
        ix = name_end.max(at + 1);
        if let Some((_, level)) = SECTIONS.iter().find(|(section, _)| *section == name) {
            let mut cursor = name_end;
            let starred = bytes.get(cursor) == Some(&b'*');
            if starred {
                cursor += 1;
            }
            cursor = skip_space(text, cursor);
            let short_end = group_end(text, cursor, b'[', b']');
            let title_start = short_end.map_or(cursor, |end| skip_space(text, end));
            let Some(title_end) = group_end(text, title_start, b'{', b'}') else {
                continue;
            };
            let short = short_end
                .map(|end| heading_title(&text[cursor + 1..end - 1]))
                .unwrap_or_default();
            let title = if short.is_empty() {
                heading_title(&text[title_start + 1..title_end - 1])
            } else {
                short
            };
            events.push(Event::Section {
                offset: at,
                level: *level,
                title: if title.is_empty() {
                    format!("({name})")
                } else {
                    title
                },
                starred,
            });
            ix = title_end;
        } else if name == "input" || name == "include" {
            if let Some(end) = group_end(text, name_end, b'{', b'}') {
                events.push(Event::Include {
                    raw: text[name_end + 1..end - 1].trim().to_string(),
                });
                ix = end;
            }
        } else if name == "appendix"
            || (name == "begin" && text[name_end..].starts_with("{appendices}"))
        {
            events.push(Event::Appendix);
        }
    }
    events
}

/// The project file an `\input` or `\include` names, read from the root
/// document's folder as TeX reads it there (`latexmk -cd`), else from the
/// project's root.
fn resolve(root: &Path, document: &str, raw: &str) -> Option<String> {
    let folder = Path::new(document).parent().unwrap_or(Path::new(""));
    let names = if raw.to_ascii_lowercase().ends_with(".tex") {
        vec![raw.to_string()]
    } else {
        vec![raw.to_string(), format!("{raw}.tex")]
    };
    for base in [folder, Path::new("")] {
        for name in &names {
            let candidate = base.join(name);
            if root.join(&candidate).is_file() {
                return Some(candidate.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    None
}

/// The outline of `document` (project-relative) as it is on disk.
pub fn read_outline(root: &Path, document: &str) -> Vec<Heading> {
    let mut headings = Vec::new();
    let mut levels: Vec<u8> = Vec::new();
    let mut appendix = false;
    let mut visiting = Vec::new();
    walk(
        root,
        document,
        document,
        0,
        &mut visiting,
        &mut levels,
        &mut appendix,
        &mut headings,
    );
    headings
}

#[allow(clippy::too_many_arguments)]
fn walk(
    root: &Path,
    document: &str,
    path: &str,
    depth: usize,
    visiting: &mut Vec<String>,
    levels: &mut Vec<u8>,
    appendix: &mut bool,
    headings: &mut Vec<Heading>,
) {
    if depth > 8 || visiting.iter().any(|open| open == path) {
        return;
    }
    let Ok(source) = std::fs::read_to_string(root.join(path)) else {
        return;
    };
    visiting.push(path.to_string());
    let line_at =
        |offset: usize| source[..offset.min(source.len())].matches('\n').count() as u32 + 1;
    for event in events(&source) {
        match event {
            Event::Appendix => *appendix = true,
            Event::Section {
                offset,
                level,
                title,
                starred,
            } => {
                // Included headings stay under the heading that included
                // them: the frame (level 0) is never popped by them.
                while levels
                    .last()
                    .is_some_and(|open| *open != 0 && *open >= level)
                {
                    levels.pop();
                }
                headings.push(Heading {
                    level,
                    title,
                    path: path.to_string(),
                    line: line_at(offset),
                    depth: levels.iter().filter(|open| **open != 0).count(),
                    starred,
                    appendix: *appendix,
                    page: None,
                });
                levels.push(level);
            }
            Event::Include { raw, .. } => {
                let Some(included) = resolve(root, document, &raw) else {
                    continue;
                };
                let frame = levels.clone();
                levels.push(0);
                walk(
                    root,
                    document,
                    &included,
                    depth + 1,
                    visiting,
                    levels,
                    appendix,
                    headings,
                );
                *levels = frame;
            }
        }
    }
    visiting.pop();
}

/// Each heading's page in the compiled PDF, by its SyncTeX map: `None` for
/// one it did not record, or every one when the PDF has no map.
pub fn heading_pages(root: &Path, headings: &mut [Heading]) {
    let lines: Vec<SourceLine> = headings
        .iter()
        .map(|heading| SourceLine {
            path: heading.path.clone(),
            line: heading.line,
        })
        .collect();
    let pages = latex::heading_pages(root, &lines).unwrap_or_default();
    for (heading, page) in headings.iter_mut().zip(pages) {
        heading.page = page;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_read_as_the_reader_sees_them() {
        assert_eq!(
            heading_title(r"The \emph{Transformer}\label{sec:t}~block"),
            "The Transformer block"
        );
        assert_eq!(heading_title(r"Costs \& $O(n^2)$"), "Costs & $O(n^2)$");
        assert_eq!(heading_title(r"\protect\textbf{Bold} title"), "Bold title");
    }

    #[test]
    fn comments_and_verbatim_hide_headings() {
        let source = "% \\section{Hidden}\n\\begin{verbatim}\n\\section{Quoted}\n\\end{verbatim}\n\\section{Shown}\n";
        let found = events(source);
        assert_eq!(found.len(), 1);
        assert!(matches!(&found[0], Event::Section { title, .. } if title == "Shown"));
    }

    #[test]
    fn the_outline_follows_inputs_in_reading_order() {
        let root = std::env::temp_dir().join(format!("lattice-outline-{}", std::process::id()));
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(
            root.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\section{One}\n\\input{chapters/two}\n\\section*{Three}\n\\appendix\n\\section[Short]{A long appendix}\n\\end{document}\n",
        )
        .unwrap();
        std::fs::write(
            root.join("chapters/two.tex"),
            "\\subsection{One point one}\n\\section{Two}\n",
        )
        .unwrap();
        let outline = read_outline(&root, "main.tex");
        let titles: Vec<_> = outline
            .iter()
            .map(|heading| {
                (
                    heading.title.as_str(),
                    heading.depth,
                    heading.path.as_str(),
                    heading.line,
                )
            })
            .collect();
        assert_eq!(
            titles,
            [
                ("One", 0, "main.tex", 3),
                ("One point one", 1, "chapters/two.tex", 1),
                ("Two", 1, "chapters/two.tex", 2),
                ("Three", 0, "main.tex", 5),
                ("Short", 0, "main.tex", 7),
            ]
        );
        assert!(outline[3].starred && outline[4].appendix);
        std::fs::remove_dir_all(&root).ok();
    }
}
