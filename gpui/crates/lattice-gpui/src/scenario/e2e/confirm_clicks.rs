//! The confirmation dialog takes the pointer and Return where it is drawn,
//! asked from Settings as Settings › Plugins, Overleaf and Appearance's
//! Remove theme ask theirs (`confirm.rs`, `Shell::window_overlays`): a
//! click on Cancel or on the answer reaches that button, not the Settings
//! page under the dialog, and Return answers as Cancel does.

use std::{cell::Cell, rc::Rc, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use lattice_settings::SettingsTab;
use serde_json::json;

use super::{Fixture, Steps};
use crate::{
    confirm::{self, Confirm},
    scenario::Run,
};

/// What became of one question.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Outcome {
    #[default]
    Open,
    Confirmed,
    Cancelled,
}

impl Run {
    /// Ask a question over Settings and give back what becomes of it.
    async fn ask_over_settings(&self, cx: &mut AsyncApp) -> Rc<Cell<Outcome>> {
        lattice_ui::parity::forget("confirm/");
        let outcome = Rc::new(Cell::new(Outcome::Open));
        let (confirmed, cancelled) = (outcome.clone(), outcome.clone());
        cx.update(|cx| {
            confirm::ask(
                Confirm::new("Remove Fixture?")
                    .body("A question asked from Settings.")
                    .confirm_label("Remove")
                    .destructive()
                    .on_confirm(move |_, _| confirmed.set(Outcome::Confirmed))
                    .on_cancel(move |_| cancelled.set(Outcome::Cancelled)),
                cx,
            )
        });
        self.pause(cx, Duration::from_millis(600)).await;
        outcome
    }

    /// The centre of the dialog's button drawn as `confirm/<name>`.
    fn confirm_button(&self, name: &str) -> Option<gpui::Point<gpui::Pixels>> {
        lattice_ui::parity::regions()
            .get(format!("confirm/{name}").as_str())
            .and_then(|region| region.bounds)
            .map(|bounds| bounds.center())
    }

    /// Whether the question is still up and Settings still open.
    fn confirm_state(&self, cx: &mut AsyncApp) -> (bool, bool) {
        cx.update(|cx| {
            (
                confirm::is_pending(cx),
                self.shell.read(cx).settings_open(),
            )
        })
    }

    async fn confirm_clicks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        _: &Fixture,
    ) -> Result<()> {
        lattice_ui::parity::enable();
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_settings(Some(SettingsTab::Appearance), window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(600)).await;

        for (name, expected) in [
            ("cancel", Outcome::Cancelled),
            ("answer", Outcome::Confirmed),
        ] {
            let outcome = self.ask_over_settings(cx).await;
            let at = self.confirm_button(name);
            if let Some(at) = at {
                self.click_at(cx, at)?;
            }
            self.pause(cx, Duration::from_millis(600)).await;
            let (asking, settings) = self.confirm_state(cx);
            steps.check(
                &format!(
                    "a click on the {name} button of a question asked over Settings answers it, and Settings stays as it was"
                ),
                at.is_some() && outcome.get() == expected && !asking && settings,
                json!({
                    "at": format!("{at:?}"),
                    "outcome": format!("{:?}", outcome.get()),
                    "still_asking": asking,
                    "settings_open": settings,
                }),
            );
            if asking {
                cx.update(|cx| confirm::install(cx).update(cx, |host, cx| host.dismiss(cx)));
            }
        }

        let outcome = self.ask_over_settings(cx).await;
        self.dispatch_keys(cx, "enter")?;
        self.pause(cx, Duration::from_millis(600)).await;
        let (asking, settings) = self.confirm_state(cx);
        steps.check(
            "Return on a question asked over Settings answers as Cancel does, as the dialog starts on Cancel",
            outcome.get() == Outcome::Cancelled && !asking && settings,
            json!({ "outcome": format!("{:?}", outcome.get()), "still_asking": asking, "settings_open": settings }),
        );
        if asking {
            cx.update(|cx| confirm::install(cx).update(cx, |host, cx| host.dismiss(cx)));
        }

        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| shell.close_settings(cx))
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }
}

/// This file's registration as the e2e module `confirm_clicks`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 96,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/confirm.rs",
        "gpui/crates/lattice-gpui/src/shell/layers.rs",
        "gpui/crates/lattice-gpui/src/shell/render.rs",
        "gpui/crates/lattice-ui/src/components/sheet.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.confirm_clicks(cx, steps, fixture)),
};
