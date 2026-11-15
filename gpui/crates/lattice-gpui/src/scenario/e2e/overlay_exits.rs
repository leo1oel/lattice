//! Overlay exits closed by the overlay's owner (`ModalLayer::closing`,
//! `gpui-base-popover-exit.diff`): Enter on the import conflict dialog plays
//! the dialog's exit before its answer arrives, and the answer then does;
//! the status bar's word count popover, closed with Escape, plays its way
//! out after it has closed.

use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result};
use gpui::{
    AsyncApp, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, PlatformInput,
};
use lattice_core::project::NameConflict;
use lattice_ui::components::exit_frames;
use serde_json::json;

use super::{Fixture, Steps};
use crate::{scenario::Run, shell::import_conflict};

/// The dialog's answer, and when it arrived.
type Answered = Rc<RefCell<Option<(Option<NameConflict>, Instant)>>>;

impl Run {
    async fn dispatch_key(&self, cx: &mut AsyncApp, keys: &'static str) -> Result<()> {
        let keystroke = Keystroke::parse(keys).map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_keystroke(keystroke, cx);
        })
    }

    async fn overlay_exits(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        fixture: &Fixture,
    ) -> Result<()> {
        // The dialog: Enter answers Keep both once the exit has run.
        let answered: Answered = Rc::default();
        let record = answered.clone();
        cx.update(|cx| {
            import_conflict::ask(
                vec!["main.tex".into()],
                String::new(),
                move |choice, _, _| *record.borrow_mut() = Some((choice, Instant::now())),
                cx,
            )
        });
        self.pause(cx, Duration::from_millis(500)).await;
        let (_, dialog_before) = exit_frames();
        let pressed = Instant::now();
        self.dispatch_key(cx, "enter").await?;
        self.pause(cx, Duration::from_millis(60)).await;
        let early = answered.borrow().is_some();
        let asking_mid = cx.update(|cx| import_conflict::install(cx).read(cx).asking().is_some());
        self.pause(cx, Duration::from_millis(400)).await;
        let (_, dialog_after) = exit_frames();
        let answer = *answered.borrow();
        let asking_end = cx.update(|cx| import_conflict::install(cx).read(cx).asking().is_some());
        let waited = answer.map(|(_, at)| at.duration_since(pressed).as_millis());
        steps.check(
            "Enter on the import conflict dialog plays its exit, then answers Keep both",
            !early
                && asking_mid
                && dialog_after > dialog_before
                && answer.map(|(choice, _)| choice) == Some(Some(NameConflict::KeepBoth))
                && !asking_end,
            json!({
                "answered_before_exit": early,
                "drawn_mid_exit": asking_mid,
                "exit_frames": dialog_after - dialog_before,
                "answer_after_ms": waited,
                "gone": !asking_end,
            }),
        );

        // A second question put up during the first's exit takes the
        // dialog's place: the first's answer reaches neither, and the
        // second stays up, unanswered.
        let first: Answered = Rc::default();
        let second: Answered = Rc::default();
        let record = first.clone();
        cx.update(|cx| {
            import_conflict::ask(
                vec!["main.tex".into()],
                String::new(),
                move |choice, _, _| *record.borrow_mut() = Some((choice, Instant::now())),
                cx,
            )
        });
        self.pause(cx, Duration::from_millis(500)).await;
        self.dispatch_key(cx, "enter").await?;
        self.pause(cx, Duration::from_millis(40)).await;
        let record = second.clone();
        cx.update(|cx| {
            import_conflict::ask(
                vec!["refs.bib".into()],
                String::new(),
                move |choice, _, _| *record.borrow_mut() = Some((choice, Instant::now())),
                cx,
            )
        });
        self.pause(cx, Duration::from_millis(400)).await;
        let first_answered = first.borrow().is_some();
        let second_answered = second.borrow().is_some();
        let still_asking = cx.update(|cx| import_conflict::install(cx).read(cx).asking().is_some());
        steps.check(
            "a question put up during the import conflict dialog's exit stays up, unanswered",
            !first_answered && !second_answered && still_asking,
            json!({
                "first_answered": first_answered,
                "second_answered": second_answered,
                "second_up": still_asking,
            }),
        );
        self.dispatch_key(cx, "escape").await?;
        self.pause(cx, Duration::from_millis(400)).await;

        // The popover: the word count's details, opened with a press on
        // the item and closed with Escape, draw their exit after closing.
        let editor = self.open(cx, &fixture.root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(400)).await;
        lattice_ui::parity::enable();
        self.pause(cx, Duration::from_millis(200)).await;
        let words = lattice_ui::parity::regions()
            .get("status/words")
            .and_then(|region| region.bounds)
            .context("the word count was not drawn")?;
        self.with_window(cx, move |_, window, cx| {
            let position = words.center();
            window.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    button: MouseButton::Left,
                    position,
                    modifiers: Modifiers::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
            window.dispatch_event(
                PlatformInput::MouseUp(MouseUpEvent {
                    button: MouseButton::Left,
                    position,
                    modifiers: Modifiers::default(),
                    click_count: 1,
                }),
                cx,
            );
        })?;
        self.pause(cx, Duration::from_millis(400)).await;
        let (popup_before, _) = exit_frames();
        self.dispatch_key(cx, "escape").await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (popup_after, _) = exit_frames();
        steps.check(
            "the word count popover, closed with Escape, plays its way out",
            popup_after > popup_before,
            json!({ "exit_frames": popup_after - popup_before }),
        );
        let _ = editor;
        Ok(())
    }
}

/// This file's registration as the e2e module `overlay_exits`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 95,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-ui/src/components/sheet.rs",
        "gpui/crates/lattice-ui/src/components/popover.rs",
        "gpui/crates/lattice-ui/src/components/overlays.rs",
        "gpui/patches/gpui-base/",
        "gpui/crates/lattice-gpui/src/confirm.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.overlay_exits(cx, steps, fixture)),
};
