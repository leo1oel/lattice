//! A jump's target line, flashed as the Tauri app flashes it
//! (`editor-reveal.ts`, `.cm-reveal-flash` in `editor-workspace.css`): the
//! whole line comes up on the find-match colour, holds it for 55% of the
//! linger tier and fades out (`lattice_ui::attention::reveal_flash`). Under
//! reduced motion the mark stays put for its moment instead of fading.
//!
//! Zed's row highlights take their colour from a function of the app, so
//! the flash's moment lives in a global the colour reads, and a task asks
//! the editor for a frame until it is over, then takes the row away.

use std::time::{Duration, Instant};

use editor::{Editor, RowHighlightOptions};
use gpui::{App, Entity, Global, Hsla};
use lattice_ui::{ActiveLattice as _, attention};
use language::{Bias, Point};

/// The flash showing now: when it began, and which flash it is, so an
/// earlier one ending does not take a later one's row away.
struct RevealFlash {
    started: Instant,
    reduce_motion: bool,
    generation: u64,
}

impl Global for RevealFlash {}

/// The marker type Zed keys the flash's row highlight by.
struct RevealFlashRows;

/// One frame at 60 Hz.
const FRAME: Duration = Duration::from_millis(16);

fn flash_color(cx: &App) -> Hsla {
    let mark = cx.palette().search_match;
    let share = cx.try_global::<RevealFlash>().map_or(0., |flash| {
        attention::reveal_flash(flash.started.elapsed(), flash.reduce_motion)
    });
    mark.opacity(mark.a * share)
}

/// Flash the 0-based `row` of `editor`.
pub(super) fn flash(editor: &Entity<Editor>, row: u32, cx: &mut App) {
    let generation = cx
        .try_global::<RevealFlash>()
        .map_or(0, |flash| flash.generation + 1);
    cx.set_global(RevealFlash {
        started: Instant::now(),
        reduce_motion: cx.reduce_motion(),
        generation,
    });
    editor.update(cx, |editor, cx| {
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        let start = snapshot.anchor_before(Point::new(row, 0));
        // To the next line's start, which Zed leaves unpainted, so an empty
        // line flashes too; the last line ends at its own end.
        let end = snapshot.anchor_after(snapshot.clip_point(Point::new(row + 1, 0), Bias::Left));
        editor.clear_row_highlights::<RevealFlashRows>();
        editor.highlight_rows::<RevealFlashRows>(
            start..end,
            flash_color,
            RowHighlightOptions {
                autoscroll: false,
                include_gutter: false,
            },
            cx,
        );
    });
    let editor = editor.downgrade();
    cx.spawn(async move |cx| {
        let ends = Instant::now() + attention::LINGER;
        while Instant::now() < ends {
            cx.background_executor().timer(FRAME).await;
            if editor.update(cx, |_, cx| cx.notify()).is_err() {
                return;
            }
        }
        cx.update(|cx| {
            let current = cx
                .try_global::<RevealFlash>()
                .is_some_and(|flash| flash.generation == generation);
            if current {
                editor
                    .update(cx, |editor, cx| {
                        editor.clear_row_highlights::<RevealFlashRows>();
                        cx.notify();
                    })
                    .ok();
            }
        });
    })
    .detach();
}

/// The rows the flash paints now (0-based), for a scenario.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn flashing_rows(editor: &Editor, cx: &App) -> Vec<u32> {
    let snapshot = editor.buffer().read(cx).snapshot(cx);
    editor
        .highlighted_rows::<RevealFlashRows>(cx)
        .map(|(range, _)| {
            use editor::ToPoint as _;
            range.start.to_point(&snapshot).row
        })
        .collect()
}
