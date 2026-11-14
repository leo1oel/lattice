//! Help's and the log's screens of the parity harness
//! (`LATTICE_PARITY_SCREEN` `whatsNew` and `logs`), staged as
//! `design-system/screens/scenes.mjs` stages them:
//!
//! - `whatsNew`: What's new over the window, from the palette's command, at
//!   the running version's notes.
//! - `logs`: Settings › Logs, with nothing focused, as the scene clicks its
//!   way there, holding the build the mock backend's page logs (a clean
//!   1.2 s build, as the parity scene's build chip is staged). Its times
//!   differ, so the regions are the dialog's frame, the page's title and its
//!   action row.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;

use super::{Run, sleep};

impl Run {
    pub(super) async fn parity_help(&self, cx: &mut AsyncApp, screen: &str) -> Result<()> {
        match screen {
            "whatsNew" => {
                self.with_window(cx, |shell, window, cx| {
                    shell.update(cx, |shell, cx| shell.open_whats_new(window, cx))
                })?;
            }
            "logs" => {
                cx.update(|cx| {
                    let mut trace = crate::app_log::trace::Trace::start(
                        lattice_i18n::t!("Build"),
                        lattice_i18n::t!("Build"),
                        None,
                        "Build",
                        cx,
                    );
                    trace.finish(
                        "success",
                        Some(lattice_i18n::t!(
                            "Build succeeded in {seconds} s",
                            seconds = "1.2"
                        )),
                        cx,
                    );
                });
                self.with_window(cx, |shell, window, cx| {
                    shell.update(cx, |shell, cx| {
                        shell.open_settings(Some(lattice_settings::SettingsTab::Logs), window, cx)
                    })
                })?;
                sleep(cx, Duration::from_millis(400)).await;
                self.with_window(cx, |_, window, cx| window.blur(cx))?;
            }
            _ => {}
        }
        sleep(cx, Duration::from_millis(600)).await;
        Ok(())
    }
}
