//! `\begin{…}` … `\end{…}` pairs (`latex-environments.ts` in the Tauri app):
//! the delimiter under the caret, the innermost pair around it, the partner
//! of a delimiter (Ctrl-M), the pair's range (⌘⌥A selects it) and the edits
//! that rename it (⌘⌥R), all in byte offsets.

use std::{ops::Range, sync::OnceLock};

use regex::Regex;

use super::edits::TextEdit;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delimiter {
    Begin,
    End,
}

/// One `\begin{name}` or `\end{name}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvironmentEvent {
    pub kind: Delimiter,
    pub name: String,
    pub range: Range<usize>,
}

/// A matched pair.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvironmentPair {
    pub name: String,
    pub begin: Range<usize>,
    pub end: Range<usize>,
}

fn pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\\(begin|end)\{([A-Za-z*][A-Za-z0-9*]*)\}").expect("a valid pattern")
    })
}

/// Every delimiter in `text`, in order.
pub fn environment_events(text: &str) -> Vec<EnvironmentEvent> {
    pattern()
        .captures_iter(text)
        .map(|found| {
            let whole = found.get(0).expect("the match");
            EnvironmentEvent {
                kind: if &found[1] == "begin" {
                    Delimiter::Begin
                } else {
                    Delimiter::End
                },
                name: found[2].to_string(),
                range: whole.range(),
            }
        })
        .collect()
}

/// The delimiter under `position`.
pub fn environment_at(text: &str, position: usize) -> Option<EnvironmentEvent> {
    environment_events(text)
        .into_iter()
        .find(|event| event.range.contains(&position))
}

/// The innermost pair that holds `position`, its delimiters included.
pub fn enclosing_environment(text: &str, position: usize) -> Option<EnvironmentPair> {
    let mut stack: Vec<EnvironmentEvent> = Vec::new();
    for event in environment_events(text) {
        if event.kind == Delimiter::Begin {
            stack.push(event);
            continue;
        }
        let open = stack.pop();
        // Innermost pairs close first while scanning left to right.
        if let Some(open) = open
            && open.name == event.name
            && position >= open.range.start
            && position <= event.range.end
        {
            return Some(EnvironmentPair {
                name: open.name,
                begin: open.range,
                end: event.range,
            });
        }
    }
    None
}

/// The innermost pair's whole range, for ⌘⌥A.
pub fn enclosing_environment_range(text: &str, position: usize) -> Option<Range<usize>> {
    enclosing_environment(text, position).map(|pair| pair.begin.start..pair.end.end)
}

/// The pair whose `\begin` or `\end` is under `position`, else the innermost
/// one around it.
fn environment_pair(text: &str, position: usize) -> Option<EnvironmentPair> {
    let Some(current) = environment_at(text, position) else {
        return enclosing_environment(text, position);
    };
    let forward = current.kind == Delimiter::Begin;
    let mut candidates: Vec<EnvironmentEvent> = environment_events(text)
        .into_iter()
        .filter(|event| {
            event.name == current.name
                && if forward {
                    event.range.start >= current.range.start
                } else {
                    event.range.end <= current.range.end
                }
        })
        .collect();
    if !forward {
        candidates.reverse();
    }
    let mut depth = 0i32;
    for event in candidates {
        depth += if event.kind == current.kind { 1 } else { -1 };
        if depth == 0 {
            let (begin, end) = if forward {
                (current.range.clone(), event.range)
            } else {
                (event.range, current.range.clone())
            };
            return Some(EnvironmentPair {
                name: current.name,
                begin,
                end,
            });
        }
    }
    None
}

/// Ctrl-M: the partner of the delimiter under `position`, else the innermost
/// enclosing `\begin`.
pub fn matching_environment_target(text: &str, position: usize) -> Option<Range<usize>> {
    let pair = environment_pair(text, position)?;
    Some(if pair.begin.contains(&position) {
        pair.end
    } else {
        pair.begin
    })
}

/// The name of the environment ⌘⌥R renames: the delimiter's under the caret,
/// else the innermost one's around it.
pub fn environment_name_at(text: &str, position: usize) -> Option<String> {
    environment_at(text, position)
        .map(|event| event.name)
        .or_else(|| enclosing_environment(text, position).map(|pair| pair.name))
}

/// ⌘⌥R's edits: both delimiters of the pair at `position` renamed.
pub fn rename_environment_at(text: &str, position: usize, new_name: &str) -> Option<Vec<TextEdit>> {
    let name = new_name.trim();
    if name.is_empty() {
        return None;
    }
    let pair = environment_pair(text, position)?;
    Some(vec![
        TextEdit {
            range: pair.begin,
            insert: format!("\\begin{{{name}}}"),
        },
        TextEdit {
            range: pair.end,
            insert: format!("\\end{{{name}}}"),
        },
    ])
}

#[cfg(test)]
mod tests {
    //! The Tauri app's `latex-environments.test.ts` cases, in byte offsets.

    use super::*;

    const DOC: &str = "a\n\\begin{figure}\n\\begin{center}\nx\n\\end{center}\n\\end{figure}\n";

    #[test]
    fn finds_the_innermost_pair_around_the_caret() {
        let x = DOC.find("x").unwrap();
        let pair = enclosing_environment(DOC, x).unwrap();
        assert_eq!(pair.name, "center");
        assert_eq!(&DOC[pair.begin.clone()], "\\begin{center}");
        let range = enclosing_environment_range(DOC, x).unwrap();
        assert_eq!(&DOC[range], "\\begin{center}\nx\n\\end{center}");
        assert_eq!(enclosing_environment(DOC, 0), None);
    }

    #[test]
    fn a_delimiter_matches_its_partner_across_nesting() {
        let text = "\\begin{a}\\begin{a}x\\end{a}\\end{a}";
        let outer_end = text.rfind("\\end{a}").unwrap();
        assert_eq!(
            matching_environment_target(text, 1),
            Some(outer_end..text.len())
        );
        assert_eq!(matching_environment_target(text, outer_end + 2), Some(0..9));
        // Inside the body, the innermost enclosing \begin.
        let x = text.find('x').unwrap();
        assert_eq!(matching_environment_target(text, x), Some(9..18));
    }

    #[test]
    fn renames_both_delimiters() {
        let x = DOC.find("x").unwrap();
        let edits = rename_environment_at(DOC, x, " flushleft ").unwrap();
        assert_eq!(edits[0].insert, "\\begin{flushleft}");
        assert_eq!(&DOC[edits[0].range.clone()], "\\begin{center}");
        assert_eq!(edits[1].insert, "\\end{flushleft}");
        assert_eq!(&DOC[edits[1].range.clone()], "\\end{center}");
        assert_eq!(rename_environment_at(DOC, x, "  "), None);
        assert_eq!(environment_name_at(DOC, x).as_deref(), Some("center"));
        assert_eq!(
            environment_name_at(DOC, DOC.find("\\begin{figure}").unwrap() + 3).as_deref(),
            Some("figure")
        );
    }
}
