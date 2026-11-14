//! The manuscript's outline: its headings, read from the root document
//! through each `\input` and `\include` as TeX reads them, in reading order
//! (`src/editor/latex/latex-outline.ts`).
//!
//! The PDF toolbar's Outline lists it.

use std::path::{Component, Path, PathBuf};

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
                .bytes()
                .map(|byte| if byte == b'\n' { '\n' } else { ' ' })
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
            let letters = command
                .bytes()
                .take_while(|byte| byte.is_ascii_alphabetic())
                .count();
            let name_len = match letters {
                0 => command.chars().next().map_or(0, char::len_utf8),
                letters => letters,
            };
            let name = &command[..name_len];
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
pub(crate) fn resolve(root: &Path, document: &str, raw: &str) -> Option<String> {
    let folder = Path::new(document).parent().unwrap_or(Path::new(""));
    let names = if raw.to_ascii_lowercase().ends_with(".tex") {
        vec![raw.to_string()]
    } else {
        vec![raw.to_string(), format!("{raw}.tex")]
    };
    for base in [folder, Path::new("")] {
        for name in &names {
            let candidate = lexical(&base.join(name));
            if root.join(&candidate).is_file() {
                return Some(candidate.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    None
}

/// `path` with `.` dropped and `..` folded into the folder before it.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir
                if matches!(out.components().next_back(), Some(Component::Normal(_))) =>
            {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
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
    let mut lines = LineCounter::new(&source);
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
                    line: lines.line_at(offset),
                    depth: levels.iter().filter(|open| **open != 0).count(),
                    starred,
                    appendix: *appendix,
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

/// The 1-based line of a byte offset, counted on from the previous query so
/// a scan whose offsets ascend reads the source once rather than once per
/// heading.
struct LineCounter<'a> {
    source: &'a str,
    offset: usize,
    line: u32,
}

impl<'a> LineCounter<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            offset: 0,
            line: 1,
        }
    }

    fn line_at(&mut self, offset: usize) -> u32 {
        let offset = offset.min(self.source.len());
        if offset < self.offset {
            *self = Self::new(self.source);
        }
        self.line += self.source[self.offset..offset].matches('\n').count() as u32;
        self.offset = offset;
        self.line
    }
}

/// One file's own headings, read from `source` without following its
/// `\input`s: the outline a `.tex` outside the manuscript (notes, a
/// standalone figure) shows of itself (`parseLatexOutline(source, path)`).
pub fn file_outline(source: &str, path: &str) -> Vec<Heading> {
    let mut lines = LineCounter::new(source);
    let mut headings = Vec::new();
    let mut levels: Vec<u8> = Vec::new();
    let mut appendix = false;
    for event in events(source) {
        match event {
            Event::Appendix => appendix = true,
            Event::Section {
                offset,
                level,
                title,
                starred,
            } => {
                while levels.last().is_some_and(|open| *open >= level) {
                    levels.pop();
                }
                headings.push(Heading {
                    level,
                    title,
                    path: path.to_string(),
                    line: lines.line_at(offset),
                    depth: levels.len(),
                    starred,
                    appendix,
                });
                levels.push(level);
            }
            Event::Include { .. } => {}
        }
    }
    headings
}

/// Each heading's number as the document typesets it (`outlineNumbers`):
/// chapters (or sections, without chapters) and two levels below them,
/// lettered after `\appendix`, parts in Roman numerals; a starred heading,
/// and one deeper than that, has none.
pub fn numbers(headings: &[Heading]) -> Vec<Option<String>> {
    const PART: u8 = 1;
    const CHAPTER: u8 = 2;
    const SECTION: u8 = 3;
    let top = if headings.iter().any(|heading| heading.level == CHAPTER) {
        CHAPTER
    } else {
        SECTION
    };
    let deepest = top + 2;
    let mut counters = [0u32; 6];
    let mut parts = 0;
    let mut lettered = false;
    headings
        .iter()
        .map(|heading| {
            if heading.starred {
                return None;
            }
            if heading.level == PART {
                parts += 1;
                return Some(roman(parts));
            }
            if heading.level < top || heading.level > deepest {
                return None;
            }
            if heading.appendix && !lettered && heading.level == top {
                lettered = true;
                counters[top as usize] = 0;
            }
            let level = heading.level as usize;
            counters[level] += 1;
            for counter in counters.iter_mut().skip(level + 1) {
                *counter = 0;
            }
            let lead = if lettered {
                letters(counters[top as usize])
            } else {
                counters[top as usize].to_string()
            };
            let rest = counters[top as usize + 1..=level]
                .iter()
                .map(u32::to_string);
            Some(
                std::iter::once(lead)
                    .chain(rest)
                    .collect::<Vec<_>>()
                    .join("."),
            )
        })
        .collect()
}

fn roman(value: u32) -> String {
    const ROMAN: [(u32, &str); 7] = [
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ];
    let mut rest = value;
    let mut out = String::new();
    for (step, glyph) in ROMAN {
        while rest >= step {
            out.push_str(glyph);
            rest -= step;
        }
    }
    out
}

/// A, B, … Z, AA, AB: the appendix counter as `\Alph` sets it, past Z too.
fn letters(value: u32) -> String {
    if value == 0 {
        return String::new();
    }
    let mut out = letters((value - 1) / 26);
    out.push((b'A' + ((value - 1) % 26) as u8) as char);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_number_as_the_document_typesets_them() {
        let source = "\\section{Intro}\n\\subsection{A}\n\\subsubsection{Deep}\n\\paragraph{x}\n\\section*{Thanks}\n\\section{Method}\n\\subsection{B}\n\\appendix\n\\section{Proofs}\n\\subsection{Lemma}\n";
        let headings = file_outline(source, "main.tex");
        let titles: Vec<_> = headings.iter().map(|h| h.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "Intro", "A", "Deep", "Thanks", "Method", "B", "Proofs", "Lemma"
            ]
        );
        assert_eq!(headings[1].line, 2);
        assert_eq!(headings[2].depth, 2);
        let numbers: Vec<_> = numbers(&headings)
            .into_iter()
            .map(|n| n.unwrap_or_default())
            .collect();
        assert_eq!(numbers, ["1", "1.1", "1.1.1", "", "2", "2.1", "A", "A.1"]);
    }

    #[test]
    fn parts_take_roman_numerals_and_chapters_lead() {
        let source = "\\part{One}\n\\chapter{C}\n\\section{S}\n\\part{Two}\n\\chapter{D}\n";
        let numbers: Vec<_> = numbers(&file_outline(source, "book.tex"))
            .into_iter()
            .map(|n| n.unwrap_or_default())
            .collect();
        assert_eq!(numbers, ["I", "1", "1.1", "II", "2"]);
        assert_eq!(letters(27), "AA");
    }

    #[test]
    fn titles_read_as_the_reader_sees_them() {
        assert_eq!(
            heading_title(r"The \emph{Transformer}\label{sec:t}~block"),
            "The Transformer block"
        );
        assert_eq!(heading_title(r"Costs \& $O(n^2)$"), "Costs & $O(n^2)$");
        assert_eq!(heading_title(r"\protect\textbf{Bold} title"), "Bold title");
        assert_eq!(heading_title(r"结果\（附录）"), r"结果\（附录）");
    }

    #[test]
    fn wide_characters_in_a_listing_keep_the_lines_after_it() {
        let root =
            std::env::temp_dir().join(format!("lattice-outline-wide-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let source = "\\begin{lstlisting}# 中文注释中文注释中文注释\\end{lstlisting}\n结论。\\section{X}\n\n\\section{Y}\n";
        std::fs::write(root.join("main.tex"), source).unwrap();
        assert_eq!(visible_source(source).len(), source.len());
        let lines: Vec<_> = read_outline(&root, "main.tex")
            .iter()
            .map(|heading| (heading.title.clone(), heading.line))
            .collect();
        assert_eq!(lines, [("X".to_string(), 2), ("Y".to_string(), 4)]);
        std::fs::remove_dir_all(&root).ok();
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

    #[test]
    fn included_paths_match_the_project_relative_form() {
        let root =
            std::env::temp_dir().join(format!("lattice-outline-dots-{}", std::process::id()));
        std::fs::create_dir_all(root.join("paper/sections")).unwrap();
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::fs::write(
            root.join("paper/main.tex"),
            "\\input{./sections/intro}\n\\input{../shared/methods}\n",
        )
        .unwrap();
        std::fs::write(root.join("paper/sections/intro.tex"), "\\section{Intro}\n").unwrap();
        std::fs::write(root.join("shared/methods.tex"), "\\section{Method}\n").unwrap();
        let paths: Vec<_> = read_outline(&root, "paper/main.tex")
            .into_iter()
            .map(|heading| heading.path)
            .collect();
        assert_eq!(paths, ["paper/sections/intro.tex", "shared/methods.tex"]);
        std::fs::remove_dir_all(&root).ok();
    }
}
