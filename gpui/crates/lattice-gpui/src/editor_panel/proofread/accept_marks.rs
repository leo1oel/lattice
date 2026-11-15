//! A moment's mark on an accepted suggestion, so the eye finds what moved
//! without reading the passage again (`src/editor/change-marks.ts`,
//! `.cm-accept-*` in `editor-workspace.css`): one edit after another, the
//! old words stand struck where they were and then go (a picture: the
//! document already reads the new ones), and the new words come up on the
//! success wash, hold it, and let it go.
//!
//! Marks only, never the text: they follow edits made meanwhile, and are
//! gone when their moment is. The old words are inline texts, which take
//! the room they took, so they leave at once where the Tauri app folds
//! their width away.

use std::{ops::Range, time::Duration};

use gpui::{Context, Hsla, Task};
use lattice_editor::{decorations::Highlight, inline_texts::InlineText};
use lattice_ui::{ActiveLattice as _, Motion};
use language::{Anchor, ToOffset as _};

use super::super::EditorPanel;

/// How long the marks stay: the last edit's wash, after the strikes before
/// it, with room to finish (`CHANGE_MARK_MS`).
const CHANGE_MARK: Duration = Duration::from_millis(2600);
/// A longer passage, or one over a line break, leaves at once rather than as
/// a picture.
const MAX_GHOST_LENGTH: usize = 80;
/// One frame of the moment.
const FRAME: Duration = Duration::from_millis(16);

const GHOSTS: &str = "proofread-accept-ghosts";
const WASH: &str = "proofread-accept-wash";

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
    order: u32,
}

#[derive(Default)]
pub(in crate::editor_panel) struct AcceptMarks {
    _moment: Option<Task<()>>,
}

/// The wash's strength at `t` of its linger (`@keyframes change-wash`): up
/// by 8%, held to 45%, gone by the end.
fn wash(t: f32) -> f32 {
    if t <= 0. || t >= 1. {
        0.
    } else if t < 0.08 {
        t / 0.08
    } else if t <= 0.45 {
        1.
    } else {
        1. - (t - 0.45) / 0.55
    }
}

impl EditorPanel {
    /// Mark `edits`, made in the text as it reads now.
    pub(in crate::editor_panel) fn mark_accepted(&mut self, edits: Vec<Accepted>, cx: &mut Context<Self>) {
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
                    order: index.min(8) as u32,
                }
            })
            .collect();
        let palette = cx.palette().clone();
        let (strike, soft) = (palette.danger, palette.success_soft);
        let moderate = Motion::Moderate.duration();
        let fast = Motion::Fast.duration();
        let linger = Motion::Linger.duration();
        let stagger = lattice_ui::motion::stagger(1);
        self.proofread.accepted._moment = Some(cx.spawn(async move |this, cx| {
            let start = std::time::Instant::now();
            let mut ghosts_shown: Option<Vec<bool>> = None;
            loop {
                let elapsed = start.elapsed();
                let done = elapsed >= CHANGE_MARK;
                let alive = this
                    .update(cx, |this, cx| {
                        let snapshot = this.buffer.read(cx).snapshot();
                        // Each edit's old words stay struck through its strike
                        // and its fold.
                        let shown: Vec<bool> = marked
                            .iter()
                            .map(|mark| {
                                !done
                                    && mark.ghost.is_some()
                                    && elapsed < moderate * 2 + stagger * mark.order
                            })
                            .collect();
                        if ghosts_shown.as_ref() != Some(&shown) {
                            let ghosts = marked
                                .iter()
                                .zip(&shown)
                                .filter(|(_, shown)| **shown)
                                .filter_map(|(mark, _)| {
                                    Some(InlineText {
                                        offset: mark.range.start.to_offset(&snapshot),
                                        text: format!("{} ", mark.ghost.as_ref()?).into(),
                                        color: strike,
                                        tint: Hsla::transparent_black(),
                                    })
                                })
                                .collect();
                            this.lattice.update(cx, |lattice, cx| {
                                lattice.set_inline_texts(GHOSTS, ghosts, cx)
                            });
                            ghosts_shown = Some(shown);
                        }
                        // The new words settle in on the wash.
                        let washes = if done {
                            Vec::new()
                        } else {
                            marked
                                .iter()
                                .filter_map(|mark| {
                                    let delay = moderate + fast + stagger * mark.order;
                                    let t = elapsed.saturating_sub(delay).as_secs_f32()
                                        / linger.as_secs_f32();
                                    let strength = if elapsed < delay { 0. } else { wash(t) };
                                    let range = mark.range.start.to_offset(&snapshot)
                                        ..mark.range.end.to_offset(&snapshot);
                                    (strength > 0. && !range.is_empty()).then(|| Highlight {
                                        range,
                                        color: soft.opacity(soft.a * strength),
                                    })
                                })
                                .collect()
                        };
                        this.lattice
                            .update(cx, |lattice, cx| lattice.set_highlights(WASH, washes, cx));
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
    use super::wash;

    // `@keyframes change-wash`: transparent, the wash from 8% to 45%, then
    // transparent again at the end.
    #[test]
    fn the_wash_comes_up_holds_and_goes() {
        assert_eq!(wash(0.), 0.);
        assert!((wash(0.04) - 0.5).abs() < 1e-6);
        assert_eq!(wash(0.08), 1.);
        assert_eq!(wash(0.45), 1.);
        assert!(wash(0.7) > 0. && wash(0.7) < 1.);
        assert_eq!(wash(1.), 0.);
    }
}
