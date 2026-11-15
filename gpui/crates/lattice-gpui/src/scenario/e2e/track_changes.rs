//! The e2e checks of Track changes (`history/review_mode/`,
//! `editor_panel/review_marks.rs`, `editor_panel/review_bar.rs`,
//! `shell/review_mode_flow.rs`):
//!
//! - the titlebar's Track changes copies the project's bases into
//!   `.research/review/` and puts the review bar over the editor;
//! - a word typed over another reads as one change (the old word struck,
//!   the new one marked), and a sentence added later as a second;
//! - Accept at the caret moves that change into the base, which reaches
//!   disk a moment later, and ⌘Z takes the accept back, the text untouched;
//! - a co-author's edit through Overleaf's live editing moves the base with
//!   it, and one inside the writer's change brings the co-author notice;
//! - Reject all puts the text back as the base has it, the co-author's
//!   words kept;
//! - Show changes in the PDF builds the PDF with the change marked (or says
//!   why it could not, where latexdiff is missing), with the "Marking
//!   changes…" pill meanwhile;
//! - Stop tracking with nothing waiting deletes the bases and leaves the
//!   file as it is.

use std::{path::Path, time::Duration};

use anyhow::Result;
use editor::SelectionEffects;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, history::review_mode::store, scenario::Run};

impl Run {
    pub(super) async fn track_changes(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let original = std::fs::read_to_string(&chapter)?;
        let base_file = root.join(".research/review/base/chapters/intro.tex");
        let editor = self.open(cx, &chapter, Some(2))?;

        // Track changes, from the titlebar's toggle.
        self.with_window(cx, |shell, _, cx| shell.update(cx, |shell, cx| shell.toggle_review_mode(cx)))?;
        let on = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                editor.read(cx).review_bar_state(cx).is_some()
            })
            .await;
        let copied = std::fs::read_to_string(&base_file).ok().as_deref() == Some(original.as_str());
        let bar = self.review_state(cx, &editor);
        steps.check(
            "Track changes copies the project's bases into .research/review and puts the review bar, with no changes, over the editor",
            on && copied && bar == Some((0, None)),
            json!({ "on": on, "copied": copied, "bar": format!("{bar:?}") }),
        );

        // A word typed over another, then a sentence added.
        self.review_select(cx, &editor, "introduces")?;
        {
            let _front = self.focused(cx, "editor").await?;
            self.type_text(cx, "presents").await?;
        }
        let one = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                editor.read(cx).review_bar_state(cx).map(|state| state.count) == Some(1)
            })
            .await;
        let at_caret = self.review_state(cx, &editor);
        self.review_shots(cx, "track-changes").await;
        self.review_select(cx, &editor, "The last line.")?;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.editor().update(cx, |editor, cx| {
                    editor.move_to_end_of_line(&Default::default(), window, cx);
                    editor.insert(" One more.", window, cx);
                })
            })
        })?;
        let two = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                editor.read(cx).review_bar_state(cx).map(|state| state.count) == Some(2)
            })
            .await;
        steps.check(
            "a word typed over another is one tracked change, at the caret (1 of 1), and a sentence added later a second",
            one && two && at_caret == Some((1, Some(0))),
            json!({ "one": one, "two": two, "at_caret": format!("{at_caret:?}") }),
        );

        // Accept at the caret, then ⌘Z.
        self.review_select(cx, &editor, "presents")?;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| editor.review_decide_at_caret(true, window, cx))
        })?;
        let accepted = self.review_state(cx, &editor).map(|state| state.0) == Some(1);
        let saved = self
            .wait_for(cx, Duration::from_secs(3), |_, _| {
                std::fs::read_to_string(&base_file).is_ok_and(|base| base.contains("presents"))
            })
            .await;
        let text = self.editor_text(cx, &editor);
        let undone = {
            let _front = self.focused(cx, "editor").await?;
            self.press(cx, 'z', true).await?;
            self.wait_for(cx, Duration::from_secs(2), |_, cx| {
                editor.read(cx).review_bar_state(cx).map(|state| state.count) == Some(2)
            })
            .await
        };
        let kept = self.editor_text(cx, &editor) == text;
        steps.check(
            "Accept at the caret moves the change into the base, written to disk a moment later; ⌘Z takes the accept back and leaves the text",
            accepted && saved && undone && kept,
            json!({ "accepted": accepted, "saved": saved, "undone": undone, "kept": kept }),
        );

        // Show changes in the PDF: the marked PDF, or why it could not be.
        let marked_on = cx.update(|cx| store::store(cx).read(cx).marked(root));
        let marked = self
            .wait_for(cx, Duration::from_secs(150), |shell, cx| {
                shell.read(cx).shows_marked_pdf() || shell.read(cx).marked_pdf_failed(cx)
            })
            .await;
        let shown = cx.update(|cx| self.shell.read(cx).shows_marked_pdf());
        self.review_shots(cx, "track-changes-pdf").await;
        steps.check(
            "review mode shows the PDF with the changes marked in the PDF panel (or, without latexdiff, the paper's own and why)",
            marked_on && marked,
            json!({ "marked_on": marked_on, "settled": marked, "marked_pdf": shown }),
        );

        // A co-author's live edits: one away from the writer's changes, then
        // one inside the sentence the writer added.
        let notice = |cx: &mut AsyncApp| cx.update(|cx| store::store(cx).read(cx).notice(root));
        let base_now =
            |cx: &mut AsyncApp| cx.update(|cx| store::store(cx).read(cx).base_for(root, "chapters/intro.tex"));
        let away = self.editor_text(cx, &editor).replacen("The last line.", "The very last line.", 1);
        self.with_window(cx, |_, _, cx| editor.update(cx, |editor, cx| editor.take_overleaf_text(&away, true, cx)))?;
        let moved = base_now(cx).is_some_and(|base| base.contains("The very last line."))
            && self.review_state(cx, &editor).map(|state| state.0) == Some(2)
            && notice(cx).is_none();
        let inside = self.editor_text(cx, &editor).replacen(" One more.", " One or two more.", 1);
        self.with_window(cx, |_, _, cx| editor.update(cx, |editor, cx| editor.take_overleaf_text(&inside, true, cx)))?;
        let noticed = notice(cx).is_some() && base_now(cx).is_some_and(|base| base.contains("or two"));
        steps.check(
            "a co-author's live edit moves the base with it, and one inside the writer's change says both versions are kept",
            moved && noticed,
            json!({ "moved": moved, "noticed": noticed, "base": base_now(cx) }),
        );

        // Reject all, then Stop tracking.
        self.with_window(cx, |_, _, cx| editor.update(cx, |editor, cx| editor.review_reject_all(cx)))?;
        let text = self.editor_text(cx, &editor);
        let rejected = Some(&text) == base_now(cx).as_ref()
            && text.contains("The very last line.")
            && text.contains("or two")
            && !text.contains("presents")
            && self.review_state(cx, &editor).map(|state| state.0) == Some(0);
        self.with_window(cx, |_, _, cx| {
            let root = root.to_path_buf();
            store::store(cx).update(cx, |store, cx| store.stop(&root, cx))
        })?;
        let off = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                editor.read(cx).review_bar_state(cx).is_none()
                    && !shell.read(cx).shows_marked_pdf()
                    && !root.join(".research/review").exists()
            })
            .await;
        steps.check(
            "Reject all puts the base's text back, the co-author's words kept; Stop tracking with nothing waiting deletes the bases and the bar",
            rejected && off,
            json!({ "rejected": rejected, "off": off }),
        );
        // The chapter as the next modules expect it, saved.
        std::fs::write(&chapter, &original)?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }

    /// Save the window as `<name>-light.png` and `<name>-dark.png` into
    /// `LATTICE_E2E_SHOTS`, when set.
    async fn review_shots(&self, cx: &mut AsyncApp, name: &str) {
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return;
        }
        use lattice_ui::{Appearance, LatticeTheme};
        for (appearance, suffix) in [(Appearance::Dark, "dark"), (Appearance::Light, "light")] {
            cx.update(|cx| LatticeTheme::set_appearance(appearance, cx));
            self.adapter_shot(cx, &format!("{name}-{suffix}")).await;
        }
    }

    fn review_state(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> Option<(usize, Option<usize>)> {
        cx.update(|cx| editor.read(cx).review_bar_state(cx).map(|state| (state.count, state.index)))
    }

    /// Select the first `needle` in the editor.
    fn review_select(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>, needle: &str) -> Result<()> {
        let text = self.editor_text(cx, editor);
        let from = text.find(needle).ok_or_else(|| anyhow::anyhow!("{needle} is not in the chapter"))?;
        let to = from + needle.len();
        let point = |at: usize| {
            let row = text[..at].matches('\n').count() as u32;
            let column = (at - text[..at].rfind('\n').map_or(0, |line| line + 1)) as u32;
            language::Point::new(row, column)
        };
        let (start, end) = (point(from), point(to));
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.editor().update(cx, |editor, cx| {
                    editor.change_selections(SelectionEffects::no_scroll(), window, cx, |selections| {
                        selections.select_ranges([start..end])
                    })
                })
            })
        })
    }
}

/// This file's registration as the e2e module `track_changes`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 44,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/history/review_mode",
        "gpui/crates/lattice-gpui/src/history/review_mode.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/review_marks.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/review_bar.rs",
        "gpui/crates/lattice-gpui/src/shell/review_mode_flow.rs",
        "gpui/crates/lattice-gpui/src/pdf/review_marking.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.track_changes(cx, steps, &fixture.root)),
};
