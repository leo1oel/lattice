//! The e2e checks of the app updater (`crate::updater`), which ships off:
//! with no channel, Lattice ▸ Check for Updates… is not in the menu and
//! Report a problem files at once. Pointed at a local channel (a manifest
//! and an archive on disk, signed with the unit tests' key), a check offers
//! the newer release ("New version …", Update now) and adds Check for
//! Updates…; Report a problem then offers the update first ("You’re on vX;
//! vY is available", Update now, Report anyway); and Update now downloads
//! and checks the archive's signature, then fails to install it with its
//! reason, since the scenario's binary is not in an app bundle (the Tauri
//! app's "Lattice update failed").

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, OwnedMenuItem};
use serde_json::json;

use super::Steps;
use crate::{
    notices,
    scenario::Run,
    updater::{self, Channel, Phase},
};

const PUBLIC_KEY: &str = include_str!("../../updater/fixtures/test.pub");
const SIGNATURE: &str = include_str!("../../updater/fixtures/signed.txt.sig");
const ARCHIVE: &[u8] = include_bytes!("../../updater/fixtures/signed.txt");

fn lattice_menu_items(cx: &mut AsyncApp) -> Vec<String> {
    cx.update(crate::shell::menus::install_menus);
    cx.update(|cx| cx.get_menus())
        .unwrap_or_default()
        .into_iter()
        .find(|menu| menu.name == "Lattice")
        .map(|menu| {
            menu.items
                .into_iter()
                .filter_map(|item| match item {
                    OwnedMenuItem::Action { name, .. } => Some(name),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn titles(cx: &mut AsyncApp) -> Vec<String> {
    let stack = cx.update(notices::install);
    cx.update(|cx| stack.read(cx).titles())
        .into_iter()
        .map(|title| title.to_string())
        .collect()
}

impl Run {
    /// With `LATTICE_E2E_SHOTS=DIR` (and the `offscreen-shots` feature)
    /// the window is saved as `DIR/<name>.png`, for a review of the look.
    async fn updater_shot(&self, cx: &mut AsyncApp, name: &str) {
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return;
        }
        self.pause(cx, Duration::from_millis(300)).await;
        self.snapshot(cx, name).await;
    }

    async fn updater_checks(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let off = lattice_menu_items(cx);
        let known = cx.update(|cx| updater::known_update(cx));
        steps.check(
            "the updater ships off: no Check for Updates… and no known update",
            !off.iter().any(|item| item.starts_with("Check for Updates")) && known.is_none(),
            json!({ "lattice": off, "known": known }),
        );

        let scratch = tempfile::tempdir()?;
        let archive = scratch.path().join("Lattice.app.tar.gz");
        std::fs::write(&archive, ARCHIVE)?;
        let platforms: serde_json::Map<String, serde_json::Value> =
            updater::manifest::platform_keys()
                .into_iter()
                .take(1)
                .map(|key| {
                    (
                        key,
                        json!({ "url": format!("file://{}", archive.display()), "signature": SIGNATURE }),
                    )
                })
                .collect();
        let manifest = scratch.path().join("latest.json");
        std::fs::write(
            &manifest,
            serde_json::to_string(&json!({ "version": "99.0.0", "platforms": platforms }))?,
        )?;
        cx.update(|cx| {
            updater::use_channel(
                Channel {
                    endpoint: format!("file://{}", manifest.display()),
                    public_key: PUBLIC_KEY.to_string(),
                },
                cx,
            );
            if let Some(updater) = updater::global(cx) {
                updater.update(cx, |updater, cx| updater.check(true, cx));
            }
        });
        let offered = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                updater::known_update(cx).is_some()
            })
            .await;
        self.updater_shot(cx, "updater-offer").await;
        let shown = titles(cx);
        let menu = lattice_menu_items(cx);
        steps.check(
            "a check offers the newer release and adds Check for Updates…",
            offered
                && shown.iter().any(|title| title == "New version 99.0.0")
                && menu.iter().any(|item| item == "Check for Updates…"),
            json!({ "titles": shown, "lattice": menu }),
        );

        cx.update(crate::help::report::report_problem);
        self.updater_shot(cx, "updater-report-gate").await;
        let shown = titles(cx);
        let gate = format!("You’re on v{}; v99.0.0 is available", lattice_core::VERSION);
        steps.check(
            "Report a problem offers the known update first",
            shown.contains(&gate),
            json!({ "titles": shown, "expected": gate }),
        );
        cx.update(|cx| notices::dismiss("report-problem-outdated", cx));

        cx.update(updater::update_now);
        let failed = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                updater::global(cx)
                    .is_some_and(|updater| matches!(updater.read(cx).phase, Phase::Error(_)))
            })
            .await;
        let phase = cx.update(|cx| {
            updater::global(cx).map(|updater| format!("{:?}", updater.read(cx).phase))
        });
        let shown = titles(cx);
        steps.check(
            "Update now checks the archive's signature, then says why it could not install",
            failed
                && shown.iter().any(|title| title == "Lattice update failed")
                && phase
                    .as_deref()
                    .is_some_and(|phase| phase.contains("app bundle")),
            json!({ "phase": phase, "titles": shown }),
        );
        cx.update(|cx| notices::dismiss("app-update", cx));
        Ok(())
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 96,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/updater",
        "gpui/crates/lattice-gpui/src/updater.rs",
        "gpui/crates/lattice-gpui/src/help/report.rs",
    ],
    run: |run, cx, steps, _| Box::pin(run.updater_checks(cx, steps)),
};
