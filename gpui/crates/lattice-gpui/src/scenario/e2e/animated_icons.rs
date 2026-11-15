//! The animated product icons (`lattice_ui::animated_icon`): the pointer
//! coming onto the titlebar's History button plays the clock's gesture,
//! drawing frames until it has run its 1.44 s and no more after it; and a
//! Settings section's row plays its icon under the pointer the same way.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Modifiers, MouseMoveEvent, PlatformInput};
use lattice_settings::SettingsTab;
use lattice_ui::animated_icon::{ProductIcon, frames_drawn};
use serde_json::json;

use super::{Fixture, Steps};
use crate::scenario::Run;

impl Run {
    /// Move the pointer onto the icon named `animated-icon/<kind>`.
    async fn point_at_icon(&self, cx: &mut AsyncApp, kind: &str) -> Result<()> {
        let name = format!("animated-icon/{kind}");
        let ready = self
            .wait_for(cx, Duration::from_secs(5), |_, _| {
                lattice_ui::parity::regions()
                    .get(name.as_str())
                    .is_some_and(|region| region.bounds.is_some())
            })
            .await;
        let bounds = lattice_ui::parity::regions()
            .get(name.as_str())
            .and_then(|region| region.bounds)
            .filter(|_| ready)
            .with_context(|| format!("{name} was not drawn"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: bounds.center(),
                    pressed_button: None,
                    modifiers: Modifiers::default(),
                }),
                cx,
            );
        })
    }

    /// Hover `icon` (named `kind`) and see its gesture play and stop.
    async fn play_once(
        &self,
        cx: &mut AsyncApp,
        icon: ProductIcon,
        kind: &str,
    ) -> Result<serde_json::Value> {
        let before = frames_drawn(icon);
        self.point_at_icon(cx, kind).await?;
        self.pause(cx, Duration::from_millis(250)).await;
        let playing = frames_drawn(icon);
        if std::env::var_os("LATTICE_E2E_SHOTS").is_some() {
            self.snapshot(cx, &format!("animated-icon-{kind}")).await;
        }
        self.pause(cx, icon.duration() + Duration::from_millis(400))
            .await;
        let ended = frames_drawn(icon);
        self.pause(cx, Duration::from_millis(400)).await;
        let after = frames_drawn(icon);
        Ok(json!({
            "before": before,
            "playing": playing,
            "ended": ended,
            "after": after,
        }))
    }

    async fn animated_icons(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        _: &Fixture,
    ) -> Result<()> {
        lattice_ui::parity::enable();
        self.pause(cx, Duration::from_millis(500)).await;
        let clock = self
            .play_once(cx, ProductIcon::ClockBackTitlebar, "clock-back-titlebar")
            .await?;
        let played = |seen: &serde_json::Value| {
            let n = |key: &str| seen[key].as_u64().unwrap_or(0);
            n("playing") > n("before") && n("ended") > n("playing") && n("after") == n("ended")
        };
        steps.check(
            "the pointer on the titlebar's History plays the clock's gesture, which stops once run",
            played(&clock),
            clock.clone(),
        );

        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_settings(Some(SettingsTab::Appearance), window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(600)).await;
        let faders = self.play_once(cx, ProductIcon::Faders, "faders").await?;
        steps.check(
            "the pointer on Settings' Appearance row plays the faders, which stop once run",
            played(&faders),
            faders,
        );
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| shell.close_settings(cx))
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }
}

/// This file's registration as the e2e module `animated_icons`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 94,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-ui/src/animated_icon.rs",
        "gpui/crates/lattice-ui/src/animated_icon/",
        "gpui/crates/lattice-ui/src/components/icon_button.rs",
        "gpui/crates/lattice-gpui/src/settings/nav.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.animated_icons(cx, steps, fixture)),
};
