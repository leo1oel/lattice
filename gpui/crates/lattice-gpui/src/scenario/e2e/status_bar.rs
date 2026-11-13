//! The e2e checks of what the editor shows around the text: the status
//! bar's TODO counter, which follows a marker as it is typed, and the
//! overlay scrollbar, which shows while the text scrolls and goes once it
//! rests. Both run on scratch files of their own, so the chapter the build
//! checks read keeps its lines.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{App, AsyncApp, Entity, point};
use serde_json::json;

use super::Steps;
use lattice_editor::LatticeEditor;

use crate::{editor_panel::EditorPanel, native, scenario::Run, status_counters};

impl Run {
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
        // out once the scroll has rested past the editor feel's linger.
        let scrolling = self
            .wait_for(cx, Duration::from_secs(1), |_, cx| {
                opacity(&lattice, cx) > 0.
            })
            .await;
        let rested = !self
            .wait_for(cx, Duration::from_secs(2), |_, cx| {
                opacity(&lattice, cx) == 0.
            })
            .await;
        steps.check(
            "the editor's overlay scrollbar shows while the text scrolls and hides once it rests",
            !at_rest && scrolling && !rested,
            json!({ "at_rest": at_rest, "scrolling": scrolling, "rested": rested }),
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
