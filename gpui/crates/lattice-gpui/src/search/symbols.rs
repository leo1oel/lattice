//! Go to symbol's items, which quick open lists after `@`: the manuscript's
//! sections, read from the main document through each `\input` and
//! `\include` as TeX reads it (`src/editor/latex/latex-outline.ts`), then
//! every `\label` in the project with what it labels (lattice-core's
//! reference index, the Tauri app's `list_references`).

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

/// One item: what it is called, where it is, and its group's heading.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Symbol {
    pub label: String,
    /// `path:line`, and for a label what it labels.
    pub detail: String,
    pub group: SymbolGroup,
    /// Project-relative.
    pub path: String,
    pub line: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SymbolGroup {
    Section,
    Label,
}

impl SymbolGroup {
    pub fn label(self) -> &'static str {
        match self {
            SymbolGroup::Section => "Section",
            SymbolGroup::Label => "Label",
        }
    }
}

const SECTION_COMMANDS: [&str; 5] = ["part", "chapter", "section", "subsection", "subsubsection"];
/// Deep enough for any real manuscript; a cycle of includes stops at once.
const MAX_DEPTH: usize = 16;

/// The project's sections, then its labels. `main` is the main document,
/// project-relative.
pub fn project_symbols(root: &Path, main: Option<&str>) -> Vec<Symbol> {
    let mut out = Vec::new();
    if let Some(main) = main {
        let mut seen = HashSet::new();
        sections_in(root, main, 0, &mut seen, &mut out);
    }
    match lattice_core::project::references(root) {
        Ok(index) => out.extend(index.references.into_iter().map(|reference| {
            let title = if reference.title.is_empty() {
                reference.kind.clone()
            } else {
                reference.title.clone()
            };
            let detail = if title != reference.label {
                format!("{}:{}, {title}", reference.path, reference.line)
            } else {
                format!("{}:{}", reference.path, reference.line)
            };
            Symbol {
                label: reference.label,
                detail,
                group: SymbolGroup::Label,
                path: reference.path,
                line: reference.line,
            }
        })),
        Err(error) => log::warn!("could not read the project's labels: {error}"),
    }
    out
}

fn sections_in(
    root: &Path,
    path: &str,
    depth: usize,
    seen: &mut HashSet<String>,
    out: &mut Vec<Symbol>,
) {
    if depth > MAX_DEPTH || !seen.insert(path.to_string()) {
        return;
    }
    let Ok(source) = std::fs::read_to_string(root.join(path)) else {
        return;
    };
    for event in outline_events(&strip_comments(&source)) {
        match event {
            Event::Section { title, line } => out.push(Symbol {
                detail: format!("{path}:{line}"),
                label: title,
                group: SymbolGroup::Section,
                path: path.to_string(),
                line,
            }),
            Event::Input(target) => {
                if let Some(included) = resolve_input(root, path, &target) {
                    sections_in(root, &included, depth + 1, seen, out);
                }
            }
        }
    }
}

/// An `\input{x}` target as a project-relative path: relative to the root
/// as TeX resolves it, `.tex` added when it has no extension.
fn resolve_input(root: &Path, _from: &str, target: &str) -> Option<String> {
    let target = target.trim();
    if target.is_empty() {
        return None;
    }
    let mut path = PathBuf::from(target);
    if path.extension().is_none() {
        path.set_extension("tex");
    }
    root.join(&path)
        .is_file()
        .then(|| path.to_string_lossy().replace('\\', "/"))
}

#[derive(Debug, PartialEq, Eq)]
enum Event {
    Section { title: String, line: u32 },
    Input(String),
}

/// The source with each line's `%` comment blanked (an escaped `\%` stays),
/// keeping every offset and line where it was.
fn strip_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    for line in source.split_inclusive('\n') {
        let mut escaped = false;
        let mut cut = None;
        for (at, c) in line.char_indices() {
            if c == '%' && !escaped {
                cut = Some(at);
                break;
            }
            escaped = c == '\\' && !escaped;
        }
        match cut {
            Some(at) => {
                out.push_str(&line[..at]);
                out.extend(
                    line[at..]
                        .chars()
                        .map(|c| if c == '\n' { '\n' } else { ' ' }),
                );
            }
            None => out.push_str(line),
        }
    }
    out
}

/// The headings and includes of `source`, in order.
fn outline_events(source: &str) -> Vec<Event> {
    let bytes = source.as_bytes();
    let mut events = Vec::new();
    let mut at = 0;
    let mut line = 1u32;
    let mut counted = 0;
    while let Some(found) = source[at..].find('\\') {
        let start = at + found;
        let name_start = start + 1;
        let name_end = source[name_start..]
            .find(|c: char| !c.is_ascii_alphabetic() && c != '@')
            .map_or(source.len(), |end| name_start + end);
        let name = &source[name_start..name_end];
        if name.is_empty() {
            at = name_start
                + source[name_start..]
                    .chars()
                    .next()
                    .map_or(0, char::len_utf8);
            continue;
        }
        at = name_end;
        line += source[counted..start].matches('\n').count() as u32;
        counted = start;
        if SECTION_COMMANDS.contains(&name) {
            let mut cursor = name_end;
            if bytes.get(cursor) == Some(&b'*') {
                cursor += 1;
            }
            cursor = skip_space(source, cursor);
            if bytes.get(cursor) == Some(&b'[') {
                match balanced(source, cursor, b'[', b']') {
                    Some((_, end)) => cursor = skip_space(source, end),
                    None => continue,
                }
            }
            if bytes.get(cursor) == Some(&b'{')
                && let Some((title, end)) = balanced(source, cursor, b'{', b'}')
            {
                let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
                if !title.is_empty() {
                    events.push(Event::Section { title, line });
                }
                at = end;
            }
        } else if name == "input" || name == "include" {
            let cursor = skip_space(source, name_end);
            if bytes.get(cursor) == Some(&b'{')
                && let Some((target, end)) = balanced(source, cursor, b'{', b'}')
            {
                events.push(Event::Input(target.to_string()));
                at = end;
            }
        }
    }
    events
}

fn skip_space(source: &str, from: usize) -> usize {
    source[from..]
        .find(|c: char| !c.is_whitespace())
        .map_or(source.len(), |at| from + at)
}

/// The text between the bracket at `open` and its match, and the offset past
/// the match; nested brackets count, escaped ones do not.
fn balanced(source: &str, open: usize, left: u8, right: u8) -> Option<(&str, usize)> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut at = open;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => {
                at += 2;
                continue;
            }
            c if c == left => depth += 1,
            c if c == right => {
                depth -= 1;
                if depth == 0 {
                    return Some((&source[open + 1..at], at + 1));
                }
            }
            _ => {}
        }
        at += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_read_their_title_past_a_star_and_a_short_title() {
        let events = outline_events(
            "\\section{Intro}\n\\subsection*[Short]{A {nested} title}\n\\sectionmark{x}\n",
        );
        assert_eq!(
            events,
            vec![
                Event::Section {
                    title: "Intro".into(),
                    line: 1
                },
                Event::Section {
                    title: "A {nested} title".into(),
                    line: 2
                },
            ]
        );
    }

    #[test]
    fn a_backslash_before_a_multibyte_character_is_stepped_over() {
        let events = outline_events("\\é \\标题\n\\\\\n\\section{Résumé}\n\\");
        assert_eq!(
            events,
            vec![Event::Section {
                title: "Résumé".into(),
                line: 3
            }]
        );
    }

    #[test]
    fn a_commented_heading_is_not_one() {
        let source = strip_comments("% \\section{Hidden}\n50\\% \\section{Shown}\n");
        let titles: Vec<_> = outline_events(&source)
            .into_iter()
            .filter_map(|event| match event {
                Event::Section { title, .. } => Some(title),
                Event::Input(_) => None,
            })
            .collect();
        assert_eq!(titles, ["Shown"]);
    }

    #[test]
    fn sections_follow_the_includes_in_order() {
        let root =
            std::env::temp_dir().join(format!("lattice-gpui-symbols-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(
            root.join("main.tex"),
            "\\section{One}\n\\input{chapters/two}\n\\section{Three}\n\\input{main}\n",
        )
        .unwrap();
        std::fs::write(
            root.join("chapters/two.tex"),
            "\n\\section{Two}\\label{sec:two}\n",
        )
        .unwrap();
        let symbols = project_symbols(&root, Some("main.tex"));
        std::fs::remove_dir_all(&root).ok();
        let sections: Vec<_> = symbols
            .iter()
            .filter(|symbol| symbol.group == SymbolGroup::Section)
            .map(|symbol| (symbol.label.as_str(), symbol.detail.as_str()))
            .collect();
        assert_eq!(
            sections,
            [
                ("One", "main.tex:1"),
                ("Two", "chapters/two.tex:2"),
                ("Three", "main.tex:3"),
            ]
        );
        let label = symbols
            .iter()
            .find(|symbol| symbol.group == SymbolGroup::Label)
            .expect("the label is listed");
        assert_eq!(label.label, "sec:two");
        assert_eq!((label.path.as_str(), label.line), ("chapters/two.tex", 2));
    }
}
