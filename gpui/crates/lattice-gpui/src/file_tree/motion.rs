//! A folder opening or closing moves as the Tauri app's tree moves it
//! (`project-tree-motion.ts`), all of it in the moderate tier (160 ms):
//!
//! - its chevron sweeps a quarter turn into place;
//! - the rows below it slide from where they were to where they now are;
//! - opening, the rows it shows are uncovered top-down, by an edge that
//!   keeps pace with the row sliding below them;
//! - closing, the rows it hid stay drawn in place, wiped bottom-up as the
//!   rows below slide up over where they were.
//!
//! A scroll, a key or a press in the tree ends a motion where it is, as
//! there, and with reduced motion nothing moves.

use std::time::Instant;

use gpui::{App, SharedString};
use gpui_kit::component::tree::TreeItem;
use lattice_ui::motion::Motion;

use super::FileTreePanel;

/// A row a closing folder hid, drawn while it is wiped away.
#[derive(Clone)]
pub(super) struct Gone {
    pub(super) label: SharedString,
    pub(super) depth: usize,
    /// `Some(expanded)` for a folder.
    pub(super) folder: Option<bool>,
}

#[derive(Clone)]
pub(super) struct TreeMotion {
    /// The row of the folder that opened or closed.
    pub(super) folder: usize,
    pub(super) opened: bool,
    /// How many rows it showed or hid.
    pub(super) rows: usize,
    /// The rows it hid, top to bottom (closing only).
    pub(super) gone: Vec<Gone>,
    started: Instant,
    /// Where the rows were scrolled to when it began.
    scrolled: f32,
}

/// One frame of a motion, for drawing the rows.
#[derive(Clone, Copy)]
pub(super) struct Frame {
    pub(super) folder: usize,
    pub(super) opened: bool,
    pub(super) rows: usize,
    /// How far along, on the tier's curve, 0 to 1.
    pub(super) progress: f32,
}

/// The rows a folder's item shows when open, depth-first under `depth`.
fn shown_under(item: &TreeItem, depth: usize, out: &mut Vec<Gone>) {
    for child in &item.children {
        let folder = child.is_folder().then(|| child.is_expanded());
        out.push(Gone {
            label: child.label.clone(),
            depth,
            folder,
        });
        if folder == Some(true) {
            shown_under(child, depth + 1, out);
        }
    }
}

impl Frame {
    /// The vertical offset of the row at `ix` from where it now lies: the
    /// rows below the folder start where they were.
    pub(super) fn slide(&self, ix: usize, row: f32) -> f32 {
        let block = self.rows as f32 * row;
        let rest = 1. - self.progress;
        match self.opened {
            true if ix > self.folder + self.rows => -block * rest,
            false if ix > self.folder => block * rest,
            _ => 0.,
        }
    }

    /// For a row the folder now shows, how much of its bottom is still
    /// covered: the edge that uncovers them keeps pace with the row below.
    pub(super) fn covered(&self, ix: usize, row: f32) -> Option<f32> {
        if !self.opened || ix <= self.folder || ix > self.folder + self.rows {
            return None;
        }
        let edge = self.rows as f32 * row * self.progress;
        let top = (ix - self.folder - 1) as f32 * row;
        Some((row - (edge - top).clamp(0., row)).max(0.))
    }

    /// The folder's chevron's turn past its rest: from a quarter turn back
    /// when opening, a quarter turn on when closing.
    pub(super) fn turn(&self, ix: usize) -> f32 {
        if ix != self.folder {
            return 0.;
        }
        let quarter = std::f32::consts::FRAC_PI_2 * (1. - self.progress);
        if self.opened { -quarter } else { quarter }
    }

    /// How tall the rows the folder hid still stand (closing only).
    pub(super) fn gone_height(&self, row: f32) -> f32 {
        self.rows as f32 * row * (1. - self.progress)
    }
}

impl FileTreePanel {
    /// The folder `id` was just opened or closed: start its motion.
    pub(super) fn begin_motion(&mut self, id: &SharedString, opened: bool, cx: &App) {
        self.motion = None;
        if cx.reduce_motion() {
            return;
        }
        let state = self.state.read(cx);
        let Some(folder) = state.index_of(id) else {
            return;
        };
        let Some(entry) = state.entry(folder) else {
            return;
        };
        let mut gone = Vec::new();
        shown_under(entry.item(), entry.depth() + 1, &mut gone);
        let rows = if opened {
            // The rows now shown under it, as the tree lays them out.
            (folder + 1..)
                .map_while(|ix| state.entry(ix))
                .take_while(|row| row.depth() > entry.depth())
                .count()
        } else {
            gone.len()
        };
        if rows == 0 {
            return;
        }
        self.motion = Some(TreeMotion {
            folder,
            opened,
            rows,
            gone: if opened { Vec::new() } else { gone },
            started: Instant::now(),
            scrolled: self.scrolled(cx),
        });
    }

    fn scrolled(&self, cx: &App) -> f32 {
        let scroll = self.state.read(cx).scroll_handle().clone();
        let offset = scroll.0.borrow().base_handle.offset();
        -f32::from(offset.y)
    }

    /// The motion's frame now, or none once it is done or a scroll ended it.
    pub(super) fn motion_frame(&mut self, cx: &App) -> Option<(Frame, Vec<Gone>)> {
        let motion = self.motion.as_ref()?;
        let elapsed = motion.started.elapsed();
        let duration = Motion::Moderate.duration();
        if elapsed >= duration || (self.scrolled(cx) - motion.scrolled).abs() > 0.5 {
            self.motion = None;
            return None;
        }
        let t = elapsed.as_secs_f32() / duration.as_secs_f32();
        Some((
            Frame {
                folder: motion.folder,
                opened: motion.opened,
                rows: motion.rows,
                progress: Motion::Moderate.sample(t).clamp(0., 1.),
            },
            motion.gone.clone(),
        ))
    }

    /// A key or a press in the tree ends the motion where it is.
    pub(super) fn end_motion(&mut self) {
        self.motion = None;
    }
}

/// The row height the motion moves by: the tree's 28px rows.
pub(super) const ROW: f32 = 28.;

#[cfg(test)]
mod tests {
    use super::*;

    // Opening a folder at row 2 that shows 3 rows: row 6 on starts 84px up
    // (3 rows of 28) and the shown rows are uncovered by one edge.
    #[test]
    fn opening_slides_the_rows_below_and_uncovers_the_new_ones() {
        let start = Frame {
            folder: 2,
            opened: true,
            rows: 3,
            progress: 0.,
        };
        assert_eq!(start.slide(6, 28.), -84.);
        assert_eq!(start.slide(3, 28.), 0.);
        assert_eq!(start.covered(3, 28.), Some(28.));
        assert_eq!(start.turn(2), -std::f32::consts::FRAC_PI_2);

        let half = Frame {
            progress: 0.5,
            ..start
        };
        assert_eq!(half.slide(6, 28.), -42.);
        // The edge is 42px into the 84px block: row 3 is uncovered, row 4
        // half, row 5 not at all.
        assert_eq!(half.covered(3, 28.), Some(0.));
        assert_eq!(half.covered(4, 28.), Some(14.));
        assert_eq!(half.covered(5, 28.), Some(28.));
        assert_eq!(half.covered(6, 28.), None);

        let done = Frame {
            progress: 1.,
            ..start
        };
        assert_eq!(done.slide(6, 28.), 0.);
        assert_eq!(done.covered(5, 28.), Some(0.));
        assert_eq!(done.turn(2), 0.);
    }

    #[test]
    fn closing_slides_the_rows_below_up_as_the_hidden_ones_are_wiped() {
        let start = Frame {
            folder: 1,
            opened: false,
            rows: 2,
            progress: 0.,
        };
        assert_eq!(start.slide(2, 28.), 56.);
        assert_eq!(start.slide(1, 28.), 0.);
        assert_eq!(start.gone_height(28.), 56.);
        assert_eq!(start.covered(2, 28.), None);
        assert_eq!(start.turn(1), std::f32::consts::FRAC_PI_2);
        let done = Frame {
            progress: 1.,
            ..start
        };
        assert_eq!(done.slide(2, 28.), 0.);
        assert_eq!(done.gone_height(28.), 0.);
    }
}
