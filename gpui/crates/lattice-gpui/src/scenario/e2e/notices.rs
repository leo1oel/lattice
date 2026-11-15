//! The notice stack, as the Tauri app's toast stack behaves
//! (`notices.rs`, `notices/stack.rs`): four cards at most, a repeat
//! collapsing into the card that shows it, the pile and its fan-out under
//! the pointer, the clocks holding meanwhile, a swipe off the side, an
//! error's Copy, a running operation's bar, and the TeX package reminder
//! with the update it starts.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, point, px};
use lattice_ui::components::{ToastLevel, ToastProgress};
use serde_json::json;

use super::{Fixture, Steps};
use crate::{
    native,
    notices::{self, Notice},
    scenario::Run,
};

/// Long enough for the slow tier and a fade to land.
const SETTLE: Duration = Duration::from_millis(450);

impl Run {
    async fn notices(&self, cx: &mut AsyncApp, steps: &mut Steps, fixture: &Fixture) -> Result<()> {
        let stack = cx.update(notices::install);
        cx.update(|cx| stack.update(cx, |stack, cx| stack.clear(cx)));
        let show = |notice: Notice, cx: &mut AsyncApp| cx.update(|cx| notices::show(notice, cx));

        for n in 1..=5 {
            show(
                Notice::new(ToastLevel::Info, format!("Stack check {n}"))
                    .source("E2E")
                    .persistent(),
                cx,
            );
            self.pause(cx, Duration::from_millis(60)).await;
        }
        self.pause(cx, SETTLE).await;
        let titles = cx.update(|cx| stack.read(cx).titles());
        steps.check(
            "the stack keeps four notices, the newest in front, and lets the oldest go",
            titles
                == ["Stack check 2", "Stack check 3", "Stack check 4", "Stack check 5"],
            json!({ "titles": titles }),
        );
        show(
            Notice::new(ToastLevel::Info, "Stack check 3")
                .source("E2E")
                .persistent(),
            cx,
        );
        self.pause(cx, Duration::from_millis(100)).await;
        let titles = cx.update(|cx| stack.read(cx).titles());
        steps.check(
            "a repeat of a notice still showing updates its card instead of stacking a copy",
            titles.len() == 4 && titles.iter().filter(|t| &***t == "Stack check 3").count() == 1,
            json!({ "titles": titles }),
        );

        let cards = cx.update(|cx| stack.read(cx).cards());
        let pile = cards.len() == 4
            && cards[0].inward.abs() < 0.5
            && (cards[1].inward - 8.).abs() < 0.5
            && (cards[1].scale - 0.95).abs() < 0.01
            && (cards[1].height - cards[0].natural).abs() < 0.5
            && cards[3].opacity < 0.01;
        steps.check(
            "collapsed, the cards behind show an 8px sliver each, smaller and at the front card's height, and the fourth waits unseen",
            pile,
            json!({ "cards": cards }),
        );

        // Fan out under the pointer: every card at its own height, 8px apart.
        let native = self.native(cx)?;
        let _front = self.focused(cx, "notices").await?;
        let viewport = self.with_window(cx, |_, window, _| window.viewport_size())?;
        let front_height = cards.first().map_or(40., |card| card.natural);
        let x = viewport.width - px(16. + 160.);
        let front = point(x, viewport.height - px(44. + front_height / 2.));
        native::send_mouse(native, native::Mouse::Moved, front)?;
        self.pause(cx, SETTLE).await;
        let (expanded, cards) = cx.update(|cx| (stack.read(cx).expanded(), stack.read(cx).cards()));
        let fanned = expanded
            && cards.len() == 4
            && (cards[1].inward - (cards[0].natural + 8.)).abs() < 0.5
            && (cards[1].scale - 1.).abs() < 0.01
            && (cards[3].opacity - 1.).abs() < 0.01;
        steps.check(
            "hovering the stack fans it out into a list, each card at its own height 8px apart",
            fanned,
            json!({ "expanded": expanded, "cards": cards }),
        );

        // The clocks hold while the pointer is on the stack.
        show(
            Notice::new(ToastLevel::Success, "Stack check held")
                .source("E2E")
                .timeout(Duration::from_secs(1)),
            cx,
        );
        self.pause(cx, Duration::from_millis(1500)).await;
        let held = cx.update(|cx| stack.read(cx).titles().iter().any(|t| &**t == "Stack check held"));
        native::send_mouse(native, native::Mouse::Moved, point(px(40.), px(120.)))?;
        let collapsed = self
            .wait_for(cx, Duration::from_secs(1), |_, cx| !stack.read(cx).expanded())
            .await;
        let expired = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                !stack.read(cx).titles().iter().any(|t| &**t == "Stack check held")
            })
            .await;
        steps.check(
            "a notice's clock holds while the stack is hovered and runs out once the pointer leaves",
            held && collapsed && expired,
            json!({ "held": held, "collapsed": collapsed, "expired": expired }),
        );

        // A swipe to the right past 40px takes the front card off that side.
        self.pause(cx, SETTLE).await;
        let cards = cx.update(|cx| stack.read(cx).cards());
        let front_title = cards.first().map(|card| card.title.clone());
        let height = cards.first().map_or(40., |card| card.natural);
        let start = point(x, viewport.height - px(44. + height / 2.));
        native::send_mouse(native, native::Mouse::Moved, start)?;
        self.pause(cx, Duration::from_millis(100)).await;
        native::send_mouse(native, native::Mouse::Down, start)?;
        for step in 1..=8 {
            self.pause(cx, Duration::from_millis(16)).await;
            native::send_mouse(
                native,
                native::Mouse::Dragged,
                point(start.x + px(step as f32 * 10.), start.y),
            )?;
        }
        native::send_mouse(native, native::Mouse::Up, point(start.x + px(80.), start.y))?;
        let leaving = self
            .wait_for(cx, Duration::from_millis(300), |_, cx| stack.read(cx).leaving() > 0)
            .await;
        self.pause(cx, SETTLE).await;
        let titles = cx.update(|cx| stack.read(cx).titles());
        steps.check(
            "swiping a card to the right past 40px dismisses it with its exit",
            leaving
                && front_title
                    .as_ref()
                    .is_some_and(|front| !titles.iter().any(|t| &**t == front)),
            json!({ "front": front_title, "leaving": leaving, "titles": titles }),
        );
        native::send_mouse(native, native::Mouse::Moved, point(px(40.), px(120.)))?;

        // An error offers Copy with its title and detail; a running
        // operation's bar moves until its outcome replaces it.
        show(
            Notice::new(ToastLevel::Error, "Stack check failed").detail("The reason"),
            cx,
        );
        show(
            Notice::new(ToastLevel::Info, "Stack check running")
                .progress(ToastProgress::Fraction(0.1))
                .key("stack-check-run"),
            cx,
        );
        cx.update(|cx| notices::update_progress("stack-check-run", ToastProgress::Fraction(0.6), cx));
        self.pause(cx, SETTLE).await;
        let cards = cx.update(|cx| stack.read(cx).cards());
        let copy = cards
            .iter()
            .find(|card| card.title == "Stack check failed")
            .and_then(|card| card.copy.clone());
        let progress = cards
            .iter()
            .find(|card| card.title == "Stack check running")
            .and_then(|card| card.progress);
        show(
            Notice::new(ToastLevel::Success, "Stack check done").key("stack-check-run"),
            cx,
        );
        self.pause(cx, Duration::from_millis(100)).await;
        let titles = cx.update(|cx| stack.read(cx).titles());
        steps.check(
            "an error carries Copy with its title and detail, and a running notice's bar moves until its outcome replaces it",
            copy.as_deref() == Some("Stack check failed\nThe reason")
                && progress.is_some_and(|share| (share - 0.6).abs() < 1e-3)
                && titles.iter().any(|t| &**t == "Stack check done")
                && !titles.iter().any(|t| &**t == "Stack check running"),
            json!({ "copy": copy, "progress": progress, "titles": titles }),
        );
        cx.update(|cx| stack.update(cx, |stack, cx| stack.clear(cx)));

        self.tex_reminder(cx, steps, fixture).await
    }

    /// The daily check's reminder, its Update and the notice that follows
    /// the update to its end (on the stand-in installer).
    async fn tex_reminder(&self, cx: &mut AsyncApp, steps: &mut Steps, fixture: &Fixture) -> Result<()> {
        let stack = cx.update(notices::install);
        fixture.stub.set_packages_outdated();
        let center = cx.update(crate::build::tex_setup::center::install);
        cx.update(|cx| center.update(cx, |center, cx| center.check_package_updates(false, cx)));
        self.wait_for(cx, Duration::from_secs(5), |_, cx| {
            !center.read(cx).packages().checking
        })
        .await;
        let reminder = cx.update(|cx| crate::build::tex_setup::reminder::reminder(cx));
        if let Some(reminder) = &reminder {
            cx.update(|cx| reminder.update(cx, |reminder, cx| reminder.remind(cx)));
        }
        self.pause(cx, Duration::from_millis(200)).await;
        let title = "Your TeX packages are out of date";
        let cards = cx.update(|cx| stack.read(cx).cards());
        let shown = cards
            .iter()
            .find(|card| card.title == title)
            .map(|card| card.actions.clone());
        let answered = self.with_window(cx, |_, window, cx| {
            stack.update(cx, |stack, cx| stack.answer(title, "Update TeX packages", window, cx))
        })?;
        let updated = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                stack
                    .read(cx)
                    .titles()
                    .iter()
                    .any(|t| &**t == "TeX packages updated. Build again to use them.")
            })
            .await;
        let titles = cx.update(|cx| stack.read(cx).titles());
        steps.check(
            "the TeX package reminder offers Update and Later, and an update started from it reports its end in a notice (stand-in installer)",
            shown.as_ref().is_some_and(|actions| {
                actions == &["Update TeX packages".to_string(), "Later".to_string()]
            }) && answered
                && updated
                && !titles.iter().any(|t| &**t == title)
                && fixture.stub.calls().iter().any(|call| call == "update_packages"),
            json!({ "actions": shown, "answered": answered, "updated": updated, "titles": titles }),
        );
        cx.update(|cx| stack.update(cx, |stack, cx| stack.clear(cx)));
        Ok(())
    }
}

/// This file's registration as the e2e module `notices` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    // Before build_flow's doctor runs the stand-in's update (`Repair`).
    rank: 90,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/notices.rs",
        "gpui/crates/lattice-gpui/src/notices",
        "gpui/crates/lattice-gpui/src/build/tex_setup/reminder.rs",
        "gpui/crates/lattice-ui/src/components/toast.rs",
        "gpui/crates/lattice-ui/src/motion.rs",
        "gpui/crates/lattice-ui/src/attention.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.notices(cx, steps, fixture)),
};
