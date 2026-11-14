//! The e2e checks of what the editor shows around the text: the status
//! bar's TODO counter, which follows a marker as it is typed, and the
//! overlay scrollbar, which shows while the text scrolls and goes once it
//! rests. Both run on scratch files of their own, so the chapter the build
//! checks read keeps its lines.

use std::{
    path::Path,
    time::{Duration, Instant},
};

use anyhow::Result;
use gpui::{App, AsyncApp, Entity, point};
use lattice_ui::scrollbar::{DrawnThumb, THUMB};
use serde_json::{Value, json};

use super::Steps;
use lattice_editor::LatticeEditor;

use crate::{editor_panel::EditorPanel, native, scenario::Run, status_counters};

/// What a scrollbar drew after a scroll: whether it showed, its widest
/// thumb while it did, and how long after the scroll it was fully hidden.
pub(super) struct BarTrace {
    pub shown: bool,
    pub thumb: Option<DrawnThumb>,
    pub hidden_after: Option<Duration>,
}

impl BarTrace {
    /// The thumb's width, its gap to the track's outer edge, and the
    /// track's width, as painted.
    pub fn geometry(&self) -> Option<(f32, f32, f32)> {
        self.thumb.map(|drawn| {
            (
                f32::from(drawn.thumb.size.width),
                f32::from(drawn.track.right() - drawn.thumb.right()),
                f32::from(drawn.track.size.width),
            )
        })
    }

    /// The app's one bar at rest: a 4px thumb, 5px off the edge of a 10px
    /// track (centred, then nudged 2px in).
    pub fn is_the_app_bar(&self) -> bool {
        self.geometry().is_some_and(|(width, gap, track)| {
            width == f32::from(THUMB) && (gap - 5.).abs() < 0.01 && track == 10.
        })
    }

    pub fn json(&self) -> Value {
        json!({
            "shown": self.shown,
            "thumb": self.thumb.map(|drawn| json!({
                "x": f32::from(drawn.thumb.origin.x),
                "y": f32::from(drawn.thumb.origin.y),
                "width": f32::from(drawn.thumb.size.width),
                "height": f32::from(drawn.thumb.size.height),
            })),
            "track_width": self.geometry().map(|(_, _, track)| track),
            "gap_to_edge": self.geometry().map(|(_, gap, _)| gap),
            "hidden_after_ms": self.hidden_after.map(|after| after.as_millis() as u64),
        })
    }
}

/// The longest a bar may take to hide after a scroll: the document feel's
/// 180 ms linger, the 160 ms hold and the 120 ms fade, with room for frames.
pub(super) const BAR_HIDES_WITHIN: Duration = Duration::from_millis(800);

impl Run {
    /// Follow a scrollbar from a scroll made at `scrolled` until it hides:
    /// `opacity` and `thumb` read what it last drew.
    pub(super) async fn bar_trace(
        &self,
        cx: &mut AsyncApp,
        scrolled: Instant,
        opacity: impl Fn(&App) -> f32,
        thumb: impl Fn(&App) -> Option<DrawnThumb>,
    ) -> BarTrace {
        let mut trace = BarTrace {
            shown: false,
            thumb: None,
            hidden_after: None,
        };
        while scrolled.elapsed() < Duration::from_secs(3) {
            self.pause(cx, Duration::from_millis(4)).await;
            let (drawn, at) = cx.update(|cx| (opacity(cx), thumb(cx)));
            if drawn > 0. {
                trace.shown = true;
                if trace.thumb.is_none() {
                    trace.thumb = at;
                }
            } else if trace.shown {
                trace.hidden_after = Some(scrolled.elapsed());
                break;
            }
        }
        trace
    }

    pub(super) async fn status_bar_and_scrollbar(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        // A Markdown note: there a TODO is a line that starts with `%`.
        let note = root.join("todo-check.md");
        std::fs::write(&note, "Notes\n\n")?;
        let editor = self.open(cx, &note, Some(2))?;
        self.pause(cx, Duration::from_millis(700)).await;
        let todos = |editor: &Entity<EditorPanel>, cx: &App| {
            let panel = editor.read(cx);
            status_counters::counts(
                &panel.project_root(cx),
                panel.relative(),
                panel.buffer_todos(),
                cx,
            )
            .todos
        };
        let before = cx.update(|cx| todos(&editor, cx));
        self.type_text(cx, "% TODO e2e").await?;
        let counted = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                todos(&editor, cx) == before + 1
            })
            .await;
        let after = cx.update(|cx| todos(&editor, cx));
        steps.check(
            "a TODO typed in the editor counts in the status bar once typing pauses",
            counted,
            json!({ "before": before, "after": after }),
        );
        self.wait_for(cx, Duration::from_secs(6), |_, cx| {
            !editor.read(cx).is_dirty(cx)
        })
        .await;
        std::fs::remove_file(&note).ok();

        // A file longer than the editor, scrolled as a wheel would.
        let long = root.join("scroll-check.md");
        let text: String = (1..=400).map(|line| format!("Line {line}\n")).collect();
        std::fs::write(&long, text)?;
        let editor = self.open(cx, &long, Some(1))?;
        self.pause(cx, Duration::from_millis(500)).await;
        let lattice = cx.update(|cx| editor.read(cx).lattice_editor().clone());
        let opacity =
            |lattice: &Entity<LatticeEditor>, cx: &App| lattice.read(cx).scrollbar_opacity();
        let at_rest = cx.update(|cx| opacity(&lattice, cx)) > 0.;
        self.with_window(cx, |_, window, cx| {
            let zed = editor.read(cx).editor().clone();
            zed.update(cx, |zed, cx| {
                zed.set_scroll_position(point(0., 120.), window, cx)
            });
        })?;
        // What the bar drew: it reveals while the text scrolls, then fades
        // out shortly after the scroll rests, past the editor feel's
        // linger, the hold and the fade.
        let scrolled = Instant::now();
        let trace = self
            .bar_trace(
                cx,
                scrolled,
                |cx| lattice.read(cx).scrollbar_opacity(),
                |cx| lattice.read(cx).scrollbar_thumb(),
            )
            .await;
        steps.check(
            "the editor's overlay scrollbar shows while the text scrolls, a 4px thumb 5px off \
             the edge, and hides within 0.8 s once it rests",
            !at_rest
                && trace.shown
                && trace.is_the_app_bar()
                && trace
                    .hidden_after
                    .is_some_and(|after| after < BAR_HIDES_WITHIN),
            json!({ "at_rest": at_rest, "bar": trace.json() }),
        );

        // Over the line numbers, outside Zed's own element, the wheel still
        // scrolls the text, as it does over CodeMirror's gutter.
        let number = cx.update(|cx| {
            lattice
                .read(cx)
                .painted_gutter()
                .lines
                .first()
                .map(|line| line.number.center())
        });
        let top = |editor: &Entity<EditorPanel>, cx: &mut App| {
            let zed = editor.read(cx).editor().clone();
            zed.update(cx, |zed, cx| zed.scroll_position(cx).y)
        };
        let before = cx.update(|cx| top(&editor, cx));
        if let Some(at) = number {
            native::send_wheel(self.native(cx)?, at, -200)?;
        }
        let scrolled = self
            .wait_for(cx, Duration::from_secs(2), |_, cx| {
                top(&editor, cx) > before
            })
            .await;
        let after = cx.update(|cx| top(&editor, cx));
        steps.check(
            "the wheel over the line numbers scrolls the text",
            number.is_some() && scrolled,
            json!({ "number": number.map(|at| [f32::from(at.x), f32::from(at.y)]), "before": before, "after": after }),
        );
        std::fs::remove_file(&long).ok();
        Ok(())
    }
}

/// This file's registration as the e2e module `status_bar` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Vim,
    rank: 10,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_status.rs",
        "gpui/crates/lattice-gpui/src/status_counters.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.status_bar_and_scrollbar(cx, steps, &fixture.root)),
};
