//! The outline rail's outline (`latex-outline-rail.tsx`: `railOutline`,
//! `headingRail`, `sectionAt`): which headings the rail marks, what each
//! entry is numbered, and which entry a line of the file reads in.
//!
//! - The rail shows the manuscript's outline from any of its files, and for a
//!   `.tex` outside it with headings of its own, those instead.
//! - More than 32 headings and the rail keeps the upper levels (the outline
//!   lists every one); a subsection it leaves out lights the mark of the
//!   section holding it.

use crate::outline::{self, Heading};

/// More marks than this and the rail keeps the upper levels.
const MAX_MARKS: usize = 32;

/// A heading on the rail: its number and how deep it sits under the
/// shallowest heading (0 to 2).
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub heading: Heading,
    pub number: Option<String>,
    pub depth: usize,
}

/// The rail's outline: every entry, the marks (indices into the entries)
/// and, for each entry, the mark it lights.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RailOutline {
    pub entries: Vec<Entry>,
    pub marks: Vec<usize>,
    pub mark_of: Vec<Option<usize>>,
    /// The document the outline is of, named in the outline's header.
    pub name: String,
}

/// The rail's outline for the file at `path` (`railOutline`): the
/// manuscript's, unless the file is outside it and has headings of its own.
pub fn rail_outline(path: &str, manuscript: &[Heading], root: &str, source: &str) -> RailOutline {
    let in_manuscript = path == root || manuscript.iter().any(|heading| heading.path == path);
    let own = if in_manuscript {
        Vec::new()
    } else {
        outline::file_outline(source, path)
    };
    let (headings, name_of) = if own.is_empty() {
        (
            manuscript.to_vec(),
            if root.is_empty() { path } else { root },
        )
    } else {
        (own, path)
    };
    let name = name_of.rsplit('/').next().unwrap_or(name_of).to_string();
    RailOutline {
        name,
        ..heading_rail(headings)
    }
}

fn heading_rail(headings: Vec<Heading>) -> RailOutline {
    if headings.is_empty() {
        return RailOutline::default();
    }
    let numbers = outline::numbers(&headings);
    let base = headings
        .iter()
        .map(|heading| heading.level)
        .min()
        .unwrap_or(0);
    let entries: Vec<Entry> = headings
        .into_iter()
        .zip(numbers)
        .map(|(heading, number)| Entry {
            depth: ((heading.level - base) as usize).min(2),
            heading,
            number,
        })
        .collect();
    let deepest = if entries.len() <= MAX_MARKS {
        2
    } else if entries.iter().filter(|entry| entry.depth <= 1).count() <= MAX_MARKS {
        1
    } else {
        0
    };
    let marks: Vec<usize> = (0..entries.len())
        .filter(|ix| entries[*ix].depth <= deepest)
        .collect();
    // A subsection the rail leaves out lights the mark of the section
    // holding it.
    let mut mark: Option<usize> = None;
    let mark_of = entries
        .iter()
        .map(|entry| {
            if entry.depth <= deepest {
                mark = Some(mark.map_or(0, |mark| mark + 1));
            }
            mark
        })
        .collect();
    RailOutline {
        entries,
        marks,
        mark_of,
        name: String::new(),
    }
}

/// The entry `line` (1-based) of `path` reads in (`sectionAt`): the last of
/// the file's own headings at or above it; above the file's first heading,
/// the one that precedes the file in reading order, or for the preamble of
/// the first file, its first heading. `None` for a file with no headings of
/// its own.
pub fn section_at(entries: &[Entry], path: &str, line: u32) -> Option<usize> {
    let mut previous = None;
    let mut current = None;
    for (index, entry) in entries.iter().enumerate() {
        if entry.heading.path != path {
            if current.is_none() {
                previous = Some(index);
            }
            continue;
        }
        if entry.heading.line > line {
            return current.or(previous).or(Some(index));
        }
        current = Some(index);
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heading(level: u8, title: &str, path: &str, line: u32) -> Heading {
        Heading {
            level,
            title: title.into(),
            path: path.into(),
            line,
            depth: 0,
            starred: false,
            appendix: false,
        }
    }

    #[test]
    fn the_rail_marks_every_heading_up_to_thirty_two() {
        let headings = vec![
            heading(3, "Intro", "main.tex", 10),
            heading(4, "Aim", "main.tex", 14),
            heading(3, "Method", "chapters/m.tex", 1),
        ];
        let rail = rail_outline("main.tex", &headings, "main.tex", "");
        assert_eq!(rail.marks, vec![0, 1, 2]);
        assert_eq!(rail.entries[1].depth, 1);
        assert_eq!(rail.entries[0].number.as_deref(), Some("1"));
        assert_eq!(rail.entries[1].number.as_deref(), Some("1.1"));
        assert_eq!(rail.name, "main.tex");
    }

    #[test]
    fn past_thirty_two_the_rail_keeps_the_upper_levels() {
        let mut headings = Vec::new();
        for section in 0..12 {
            headings.push(heading(3, "S", "main.tex", section * 10 + 1));
            for sub in 0..3 {
                headings.push(heading(4, "s", "main.tex", section * 10 + 2 + sub));
            }
        }
        let rail = rail_outline("main.tex", &headings, "main.tex", "");
        assert_eq!(rail.entries.len(), 48);
        assert_eq!(rail.marks.len(), 12);
        // A subsection left out lights its section's mark.
        assert_eq!(rail.mark_of[1], Some(0));
        assert_eq!(rail.mark_of[4], Some(1));
    }

    #[test]
    fn a_file_outside_the_manuscript_shows_its_own_headings() {
        let manuscript = vec![heading(3, "Intro", "main.tex", 10)];
        let source = "\\section{Notes}\n\\section{More}\n";
        let rail = rail_outline("notes/a.tex", &manuscript, "main.tex", source);
        assert_eq!(rail.entries.len(), 2);
        assert_eq!(rail.name, "a.tex");
        // A file of the manuscript shows the manuscript's.
        let rail = rail_outline("main.tex", &manuscript, "main.tex", source);
        assert_eq!(rail.entries.len(), 1);
    }

    #[test]
    fn the_current_section_is_the_last_heading_at_or_above_the_line() {
        let headings = vec![
            heading(3, "Intro", "main.tex", 10),
            heading(3, "Method", "chapters/m.tex", 3),
            heading(3, "Results", "main.tex", 40),
        ];
        let entries = rail_outline("main.tex", &headings, "main.tex", "").entries;
        // The preamble of the first file reads in its first heading.
        assert_eq!(section_at(&entries, "main.tex", 2), Some(0));
        assert_eq!(section_at(&entries, "main.tex", 20), Some(0));
        assert_eq!(section_at(&entries, "main.tex", 45), Some(2));
        // Above an included file's first heading: the one before the file.
        assert_eq!(section_at(&entries, "chapters/m.tex", 1), Some(0));
        assert_eq!(section_at(&entries, "chapters/m.tex", 9), Some(1));
        assert_eq!(section_at(&entries, "other.tex", 9), None);
    }
}
