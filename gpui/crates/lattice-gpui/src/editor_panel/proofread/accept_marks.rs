//! A moment's mark on an accepted suggestion, so the eye finds what moved
//! without reading the passage again (`src/editor/change-marks.ts`,
//! `.cm-accept-*` in `editor-workspace.css`): one edit after another, the
//! old words are struck through where they stood, then fold their width
//! away (a picture: the document already reads the new ones), and the new
//! words settle in on the success wash, hold it, and let it go. The timing
//! is `lattice_ui::attention::accept`'s.
//!
//! Marks only, never the text: they follow edits made meanwhile, and are
//! gone when their moment is. The old words are inline texts, which take
//! the room their text takes, so they fold a character at a time from the
//! end, as `max-width` with `overflow: hidden` clips them, and fade under a
//! veil of the editor's ground. Under reduced motion the old words go at
//! once and the new ones show with the wash.

use std::{ops::Range, time::Duration};

use gpui::{Context, Task};
use language::{Anchor, ToOffset as _};
use lattice_editor::{
    decorations::{Highlight, Mark, MarkStyle},
    inline_texts::{InlineLook, InlineText},
};
use lattice_ui::{
    ActiveLattice as _,
    attention::{self, AcceptFrame, Moment},
};

use super::super::EditorPanel;

/// A longer passage, or one over a line break, leaves at once rather than as
/// a picture.
const MAX_GHOST_LENGTH: usize = 80;
/// Edits after this many arrive together, as the card's own edits do.
const MAX_STAGGER: usize = 8;
/// One frame of the moment.
const FRAME: Duration = Duration::from_millis(16);

const GHOSTS: &str = "proofread-accept-ghosts";
const WASH: &str = "proofread-accept-wash";
const SETTLE: &str = "proofread-accept-settle";

/// One accepted edit in the new text: `[from, to)` reads its new words,
/// which replaced `removed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Accepted {
    pub from: usize,
    pub to: usize,
    pub removed: String,
}

struct Marked {
    range: Range<Anchor>,
    ghost: Option<String>,
    order: usize,
}

#[derive(Default)]
pub(in crate::editor_panel) struct AcceptMarks {
    _moment: Option<Task<()>>,
}

/// What of `ghost` (the old words and the space after them) still stands
/// with `width` of it left: its first characters, none once folded.
fn folded(ghost: &str, width: f32) -> Option<String> {
    let room: Vec<char> = format!("{ghost} ").chars().collect();
    let kept = (room.len() as f32 * width.clamp(0., 1.)).ceil() as usize;
    (kept > 0).then(|| room[..kept.min(room.len())].iter().collect())
}

impl EditorPanel {
    /// Mark `edits`, made in the text as it reads now.
    pub(in crate::editor_panel) fn mark_accepted(
        &mut self,
        edits: Vec<Accepted>,
        cx: &mut Context<Self>,
    ) {
        let snapshot = self.buffer.read(cx).snapshot();
        let length = snapshot.len();
        let mut edits = edits;
        edits.sort_by_key(|edit| edit.from);
        let marked: Vec<Marked> = edits
            .into_iter()
            .enumerate()
            .map(|(index, edit)| {
                let from = edit.from.min(length);
                let to = edit.to.clamp(from, length);
                let removed = edit.removed.trim();
                let ghost = (!removed.is_empty()
                    && removed.chars().count() <= MAX_GHOST_LENGTH
                    && !removed.contains('\n'))
                .then(|| removed.to_string());
                Marked {
                    range: snapshot.anchor_before(from)..snapshot.anchor_after(to),
                    ghost,
                    order: index.min(MAX_STAGGER),
                }
            })
            .collect();
        let palette = cx.palette().clone();
        let (strike, soft, ground) = (palette.danger, palette.success_soft, palette.editor);
        let reduce = cx.reduce_motion();
        let length = marked
            .iter()
            .map(|mark| Moment::new(mark.order, Duration::ZERO).duration())
            .max()
            .unwrap_or_default();
        self.proofread.accepted._moment = Some(cx.spawn(async move |this, cx| {
            let start = std::time::Instant::now();
            loop {
                let elapsed = start.elapsed();
                let done = elapsed >= length;
                let alive = this
                    .update(cx, |this, cx| {
                        let snapshot = this.buffer.read(cx).snapshot();
                        let frames: Vec<AcceptFrame> = marked
                            .iter()
                            .map(|mark| attention::accept(Moment::new(mark.order, elapsed), reduce))
                            .collect();
                        let mut ghosts = Vec::new();
                        let mut washes = Vec::new();
                        let mut settling = Vec::new();
                        for (mark, frame) in marked.iter().zip(&frames).filter(|_| !done) {
                            let range = mark.range.start.to_offset(&snapshot)
                                ..mark.range.end.to_offset(&snapshot);
                            // The old words, struck, folding, fading.
                            if let Some(text) = mark
                                .ghost
                                .as_deref()
                                .and_then(|ghost| folded(ghost, frame.ghost_width))
                            {
                                ghosts.push(InlineText {
                                    offset: range.start,
                                    text: text.into(),
                                    look: InlineLook::Struck {
                                        color: strike.opacity(frame.ghost_opacity),
                                        tint: ground.opacity(1. - frame.ghost_opacity),
                                        drawn: frame.strike,
                                    },
                                });
                            }
                            if range.is_empty() {
                                continue;
                            }
                            // The new words settle in on the wash.
                            if frame.wash > 0. {
                                washes.push(Highlight {
                                    range: range.clone(),
                                    color: soft.opacity(frame.wash),
                                });
                            }
                            if frame.insert_opacity < 1. {
                                settling.push(Mark {
                                    range,
                                    style: MarkStyle {
                                        fade: Some(1. - frame.insert_opacity),
                                        ..MarkStyle::default()
                                    },
                                });
                            }
                        }
                        this.lattice.update(cx, |lattice, cx| {
                            lattice.set_inline_texts(GHOSTS, ghosts, cx);
                            lattice.set_highlights(WASH, washes, cx);
                            lattice.set_marks(SETTLE, settling, cx);
                        });
                    })
                    .is_ok();
                if done || !alive {
                    break;
                }
                cx.background_executor().timer(FRAME).await;
            }
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::folded;

    // `accept-fold` takes `max-width` from the words' width to 0 with
    // `overflow: hidden`: what is left is the words' start, and nothing at
    // the end.
    #[test]
    fn the_old_words_fold_from_their_end() {
        assert_eq!(folded("teh", 1.).as_deref(), Some("teh "));
        assert_eq!(folded("teh", 0.5).as_deref(), Some("te"));
        assert_eq!(folded("teh", 0.01).as_deref(), Some("t"));
        assert_eq!(folded("teh", 0.), None);
        // A character is never split.
        assert_eq!(folded("é ü", 0.7).as_deref(), Some("é ü"));
    }
}
