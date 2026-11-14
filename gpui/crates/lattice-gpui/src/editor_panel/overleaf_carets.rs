//! Carets as Overleaf counts them. Overleaf places a caret by a zero-based
//! line and a column in UTF-16 units (its editor's own); the buffer counts
//! columns in UTF-8 bytes, so a line holding an accent or an emoji puts the
//! two apart. The caret going out is measured in Overleaf's units here, and
//! a collaborator's coming in is turned back into the buffer's.

use gpui::{Context, Hsla, SharedString};
use language::Point;
use lattice_editor::remote_cursors::RemoteCursor;

use super::EditorPanel;

/// A collaborator's caret in Overleaf's units.
pub struct OverleafCaret {
    pub id: SharedString,
    pub name: SharedString,
    pub color: Hsla,
    pub row: u32,
    /// UTF-16 units into the line.
    pub column: u32,
}

/// The byte column `units` UTF-16 units into `line`, never inside a
/// character, and at most the line's end.
pub(super) fn byte_column(line: &str, units: u32) -> u32 {
    let mut counted = 0u32;
    for (byte, character) in line.char_indices() {
        if counted >= units {
            return byte as u32;
        }
        counted += character.len_utf16() as u32;
    }
    line.len() as u32
}

/// `text`'s length in UTF-16 units.
pub(super) fn utf16_units<'a>(text: impl IntoIterator<Item = &'a str>) -> u32 {
    text.into_iter()
        .map(|chunk| chunk.encode_utf16().count() as u32)
        .sum()
}

impl EditorPanel {
    /// The caret as Overleaf counts it: zero-based line, UTF-16 column.
    pub fn overleaf_caret(&self) -> (u32, u32) {
        self.overleaf_caret
    }

    /// Draw these collaborators' carets in the editor.
    pub fn set_overleaf_carets(&self, carets: Vec<OverleafCaret>, cx: &mut Context<Self>) {
        let snapshot = self.buffer.read(cx).snapshot();
        let max_row = snapshot.max_point().row;
        let cursors = carets
            .into_iter()
            .map(|caret| {
                let row = caret.row.min(max_row);
                let line: String = snapshot
                    .text_for_range(Point::new(row, 0)..Point::new(row, snapshot.line_len(row)))
                    .collect();
                RemoteCursor {
                    id: caret.id,
                    name: caret.name,
                    color: caret.color,
                    row,
                    column: byte_column(&line, caret.column),
                }
            })
            .collect();
        self.lattice
            .update(cx, |lattice, cx| lattice.set_remote_cursors(cursors, cx));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_convert_between_overleafs_units_and_the_buffers() {
        // "é" is one UTF-16 unit and two bytes; "🔵" two units and four bytes.
        let line = "é🔵x";
        assert_eq!(byte_column(line, 0), 0);
        assert_eq!(byte_column(line, 1), 2);
        assert_eq!(byte_column(line, 3), 6);
        assert_eq!(byte_column(line, 4), 7);
        assert_eq!(byte_column(line, 99), 7);
        assert_eq!(utf16_units(["é", "🔵x"]), 4);
    }
}
