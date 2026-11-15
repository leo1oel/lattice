//! An edit of a document as the selection toolbars make it: replacements in
//! byte offsets of the text before the edit, none overlapping, and the
//! selection after it, as CodeMirror's `ChangeSet` and `mapPos` carry them.

use std::ops::Range;

/// One replacement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replace {
    pub range: Range<usize>,
    pub insert: String,
}

impl Replace {
    pub fn new(range: Range<usize>, insert: impl Into<String>) -> Self {
        Self {
            range,
            insert: insert.into(),
        }
    }
}

/// An edit and the selection after it (`anchor`, `head`, in the edited text).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextEdit {
    pub changes: Vec<Replace>,
    pub anchor: usize,
    pub head: usize,
}

impl TextEdit {
    /// `text` with the edit applied.
    pub fn apply(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut at = 0;
        for change in &self.changes {
            out.push_str(&text[at..change.range.start]);
            out.push_str(&change.insert);
            at = change.range.end;
        }
        out.push_str(&text[at..]);
        out
    }
}

/// `changes` sorted, the no-ops dropped: the shape every edit here takes.
pub fn normalize(mut changes: Vec<Replace>) -> Vec<Replace> {
    changes.retain(|change| change.range.start != change.range.end || !change.insert.is_empty());
    changes.sort_by_key(|change| (change.range.start, change.range.end));
    changes
}

/// Where `pos` lands after `changes` (sorted, not overlapping), as
/// `ChangeSet.mapPos`: inside a replaced range, or at an insertion's point,
/// before the replacement for `assoc < 0` and after it otherwise; at the end
/// of a replaced range, after it.
pub fn map_pos(changes: &[Replace], pos: usize, assoc: i32) -> usize {
    let mut delta: isize = 0;
    for change in changes {
        let (from, to) = (change.range.start, change.range.end);
        let inserted = change.insert.len() as isize;
        if pos < from || (pos == from && assoc < 0 && from != to) {
            break;
        }
        if pos == from && from == to {
            // A pure insertion at the point.
            return if assoc < 0 {
                (pos as isize + delta) as usize
            } else {
                (pos as isize + delta + inserted) as usize
            };
        }
        if pos < to || (pos == from && from != to) {
            let start = from as isize + delta;
            return if assoc < 0 {
                start as usize
            } else {
                (start + inserted) as usize
            };
        }
        if pos == to {
            return (from as isize + delta + inserted) as usize;
        }
        delta += inserted - (to - from) as isize;
    }
    (pos as isize + delta) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_map_across_replacements() {
        let changes = vec![Replace::new(2..2, "ab"), Replace::new(5..7, "")];
        assert_eq!(map_pos(&changes, 1, 1), 1);
        assert_eq!(map_pos(&changes, 2, -1), 2);
        assert_eq!(map_pos(&changes, 2, 1), 4);
        assert_eq!(map_pos(&changes, 6, 1), 7);
        assert_eq!(map_pos(&changes, 7, -1), 7);
        assert_eq!(map_pos(&changes, 9, 1), 9);
        let edit = TextEdit {
            changes,
            anchor: 0,
            head: 0,
        };
        assert_eq!(edit.apply("0123456789"), "01ab234789");
    }
}
