//! The buffer as live editing with Overleaf sees it (`overleaf::bridge::documents`):
//! its text, a co-author's operations taken in, and Overleaf's stored form
//! of what was typed here.
//!
//! What Overleaf sends lands as an edit the writer did not make, so it is
//! kept out of the writer's undo history (⌘Z never takes back a co-author's
//! typing), and it does not count as typing to send back.

use gpui::Context;
use lattice_core::overleaf_rt::OtOp;

use super::{EditorPanel, EditorPanelEvent};

/// The byte offset `units` UTF-16 units into `text`, when it falls on a
/// character boundary inside it.
fn byte_offset(text: &str, units: usize) -> Option<usize> {
    let mut counted = 0;
    for (byte, character) in text.char_indices() {
        if counted == units {
            return Some(byte);
        }
        if counted > units {
            return None;
        }
        counted += character.len_utf16();
    }
    (counted == units).then_some(text.len())
}

/// `ops` as byte-range edits, each against the text the ones before it
/// left; None when one does not fit.
pub(super) fn byte_edits(
    text: &str,
    ops: &[OtOp],
) -> Option<Vec<(std::ops::Range<usize>, String)>> {
    let mut current = text.to_string();
    let mut edits = Vec::new();
    for op in ops {
        let start = byte_offset(&current, op.p)?;
        if let Some(deleted) = &op.d {
            let end = start + deleted.len();
            if current.get(start..end) != Some(deleted.as_str()) {
                return None;
            }
            current.replace_range(start..end, "");
            edits.push((start..end, String::new()));
        }
        if let Some(inserted) = &op.i {
            current.insert_str(start, inserted);
            edits.push((start..start, inserted.clone()));
        }
    }
    Some(edits)
}

impl EditorPanel {
    /// The buffer's text.
    pub fn overleaf_text(&self, cx: &gpui::App) -> String {
        self.buffer.read(cx).text()
    }

    /// Take in operations a co-author made on Overleaf, out of the undo
    /// history and not as typing; false (nothing changed) when they do not
    /// fit the text.
    pub fn take_overleaf_ops(&mut self, ops: &[OtOp], cx: &mut Context<Self>) -> bool {
        let text = self.buffer.read(cx).text();
        let Some(edits) = byte_edits(&text, ops) else {
            return false;
        };
        self.overleaf_applying = true;
        self.buffer.update(cx, |buffer, cx| {
            buffer.finalize_last_transaction();
            for (range, text) in edits {
                buffer.edit([(range, text)], None, cx);
            }
            if let Some(id) = buffer
                .finalize_last_transaction()
                .map(|transaction| transaction.id)
            {
                buffer.forget_transaction(id);
            }
        });
        self.overleaf_applying = false;
        true
    }

    /// Show `text` in place of the buffer's, as live editing has it (what
    /// Overleaf stores for an emoji, or Overleaf's copy taken whole), out of
    /// the undo history and not as typing.
    pub fn take_overleaf_text(&mut self, text: &str, cx: &mut Context<Self>) {
        if self.buffer.read(cx).text() == text {
            return;
        }
        self.overleaf_applying = true;
        self.buffer.update(cx, |buffer, cx| {
            buffer.finalize_last_transaction();
            buffer.set_text(text, cx);
            if let Some(id) = buffer
                .finalize_last_transaction()
                .map(|transaction| transaction.id)
            {
                buffer.forget_transaction(id);
            }
        });
        self.overleaf_applying = false;
    }

    /// The buffer changed: typing, unless live editing put it there.
    pub(super) fn note_overleaf_edit(&self, cx: &mut Context<Self>) {
        if !self.overleaf_applying {
            cx.emit(EditorPanelEvent::Typed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(p: usize, i: Option<&str>, d: Option<&str>) -> OtOp {
        OtOp {
            p,
            i: i.map(Into::into),
            d: d.map(Into::into),
            u: None,
        }
    }

    #[test]
    fn utf16_ops_become_byte_edits_against_the_text_before_them() {
        // "é" is one UTF-16 unit and two bytes.
        let edits = byte_edits("é ab", &[op(2, None, Some("a")), op(2, Some("XY"), None)]).unwrap();
        assert_eq!(edits, vec![(3..4, String::new()), (3..3, "XY".to_string())]);
        // A delete that does not match, or a position inside an emoji, does not fit.
        assert!(byte_edits("abc", &[op(0, None, Some("x"))]).is_none());
        assert!(byte_edits("🔵", &[op(1, Some("x"), None)]).is_none());
    }
}
