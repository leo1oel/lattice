//! Parsing and resolving the conflict markers a three-way merge leaves
//! behind, ported from the Tauri app's `src/history/conflict-markers.ts`.
//!
//! The markers are the standard `<<<<<<< / ======= / >>>>>>>` form,
//! optionally with a diff3 `|||||||` section carrying the last common version
//! between the two sides; that base is never part of either side, so keeping
//! one's own text never puts the previous text back.
//!
//! Everything works on lines, so an empty side (one side deleted the whole
//! region) resolves to no lines at all instead of leaving a stray blank line.

use std::collections::HashMap;

/// One spot to decide.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictHunk {
    /// Index in the file's block list, so a choice can be applied in place.
    pub index: usize,
    pub ours: Vec<String>,
    pub theirs: Vec<String>,
    /// 1-based line where the conflict starts.
    pub line: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ConflictChoice {
    Ours,
    Theirs,
    Both,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Block {
    Text(Vec<String>),
    Conflict {
        ours: Vec<String>,
        theirs: Vec<String>,
        /// The marker lines and body exactly as found, kept for undecided spots.
        raw: Vec<String>,
        line: usize,
    },
}

const START: &str = "<<<<<<<";
const BASE: &str = "|||||||";
const MIDDLE: &str = "=======";
const END: &str = ">>>>>>>";

fn is_marker(line: &str, marker: &str) -> bool {
    line == marker
        || line
            .strip_prefix(marker)
            .is_some_and(|rest| rest.starts_with(' '))
}

/// A file split into plain stretches and conflict blocks. Unterminated or
/// malformed markers are ordinary text, so a half-written file is never
/// mangled.
fn parse_blocks(content: &str) -> Vec<Block> {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut blocks = Vec::new();
    let mut text: Vec<String> = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if !is_marker(line, START) {
            text.push(line.to_string());
            index += 1;
            continue;
        }
        #[derive(PartialEq)]
        enum Section {
            Ours,
            Base,
            Theirs,
        }
        let (mut ours, mut theirs) = (Vec::new(), Vec::new());
        let mut section = Section::Ours;
        let mut cursor = index + 1;
        let mut closed = false;
        while cursor < lines.len() {
            let current = lines[cursor];
            if section == Section::Ours && is_marker(current, BASE) {
                section = Section::Base;
            } else if section != Section::Theirs && is_marker(current, MIDDLE) {
                section = Section::Theirs;
            } else if section == Section::Theirs && is_marker(current, END) {
                closed = true;
                cursor += 1;
                break;
            } else if is_marker(current, START) {
                // A nested start means this one was never closed.
                break;
            } else {
                match section {
                    Section::Ours => ours.push(current.to_string()),
                    Section::Base => {}
                    Section::Theirs => theirs.push(current.to_string()),
                }
            }
            cursor += 1;
        }
        if !closed {
            text.push(line.to_string());
            index += 1;
            continue;
        }
        if !text.is_empty() {
            blocks.push(Block::Text(std::mem::take(&mut text)));
        }
        blocks.push(Block::Conflict {
            ours,
            theirs,
            raw: lines[index..cursor]
                .iter()
                .map(|line| line.to_string())
                .collect(),
            line: index + 1,
        });
        index = cursor;
    }
    if !text.is_empty() {
        blocks.push(Block::Text(text));
    }
    blocks
}

/// The spots `content` leaves to decide, in order.
pub fn conflict_hunks(content: &str) -> Vec<ConflictHunk> {
    parse_blocks(content)
        .into_iter()
        .enumerate()
        .filter_map(|(index, block)| match block {
            Block::Conflict {
                ours, theirs, line, ..
            } => Some(ConflictHunk {
                index,
                ours,
                theirs,
                line,
            }),
            Block::Text(_) => None,
        })
        .collect()
}

pub fn has_conflict_markers(content: &str) -> bool {
    !conflict_hunks(content).is_empty()
}

/// The file with a choice applied to each decided spot. Spots left undecided
/// keep their markers (base section included), so a partial pass is safe to
/// save and can be finished later.
pub fn resolve_conflicts(content: &str, choices: &HashMap<usize, ConflictChoice>) -> String {
    parse_blocks(content)
        .into_iter()
        .enumerate()
        .flat_map(|(index, block)| match block {
            Block::Text(lines) => lines,
            Block::Conflict {
                ours, theirs, raw, ..
            } => match choices.get(&index) {
                Some(ConflictChoice::Ours) => ours,
                Some(ConflictChoice::Theirs) => theirs,
                Some(ConflictChoice::Both) => ours.into_iter().chain(theirs).collect(),
                None => raw,
            },
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIFF3: &str =
        "intro\n<<<<<<< local\nmine\n||||||| base\nold\n=======\ntheirs\n>>>>>>> remote\noutro";

    #[test]
    fn reads_each_spot_and_leaves_the_base_out_of_both_sides() {
        let hunks = conflict_hunks(DIFF3);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].ours, vec!["mine"]);
        assert_eq!(hunks[0].theirs, vec!["theirs"]);
        assert_eq!(hunks[0].line, 2);
    }

    #[test]
    fn resolves_each_choice_and_keeps_undecided_markers() {
        let index = conflict_hunks(DIFF3)[0].index;
        let choose = |choice| resolve_conflicts(DIFF3, &HashMap::from([(index, choice)]));
        assert_eq!(choose(ConflictChoice::Ours), "intro\nmine\noutro");
        assert_eq!(choose(ConflictChoice::Theirs), "intro\ntheirs\noutro");
        assert_eq!(choose(ConflictChoice::Both), "intro\nmine\ntheirs\noutro");
        assert_eq!(resolve_conflicts(DIFF3, &HashMap::new()), DIFF3);
    }

    #[test]
    fn an_empty_side_resolves_to_no_lines() {
        let content = "a\n<<<<<<< ours\n=======\ngone\n>>>>>>> theirs\nb";
        let index = conflict_hunks(content)[0].index;
        assert_eq!(
            resolve_conflicts(content, &HashMap::from([(index, ConflictChoice::Ours)])),
            "a\nb"
        );
    }

    #[test]
    fn unterminated_markers_are_text() {
        let content = "a\n<<<<<<< ours\nmine\n=======\ntheirs\nb";
        assert!(!has_conflict_markers(content));
        assert_eq!(resolve_conflicts(content, &HashMap::new()), content);
    }
}
