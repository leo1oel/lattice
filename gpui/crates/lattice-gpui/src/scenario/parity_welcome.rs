//! `parity` with `LATTICE_PARITY_SCREEN=welcome`: the welcome screen staged
//! as the parity harness stages it in the Tauri app (`?welcome=1&recents=1`,
//! `tools/perf-bench/bench-page.ts`): four recent projects, the newest one's
//! folder gone so the screen says it could not be reopened, the desk laying
//! out the next three. Motion is reduced, as the reference page's is, so
//! the field, the mark and the column are at rest when captured.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use lattice_ui::{ActiveLattice as _, Appearance};
use serde_json::{Value, json};

use super::{Run, parity::regions_json, sleep};
use crate::{
    recents::{RecentProject, RecentProjects, now_ms},
    welcome::Unopened,
};

const DAY: u64 = 86_400_000;

impl Run {
    pub(super) async fn parity_welcome(&self, cx: &mut AsyncApp) -> Result<Value> {
        // The project the harness passed opens first; the welcome screen is
        // then laid over the window, as a window without one shows it.
        self.root(cx).await?;
        let now = now_ms();
        let moved = RecentProject {
            name: "Thesis draft".into(),
            path: "/Users/writer/Moved/thesis-draft".into(),
            opened_at: Some(now - DAY / 2),
        };
        let recents = vec![
            moved.clone(),
            RecentProject {
                name: "Sparse attention".into(),
                path: "/Users/writer/Papers/sparse-attention".into(),
                opened_at: Some(now - DAY),
            },
            RecentProject {
                name: "NeurIPS rebuttal".into(),
                path: "/Users/writer/Papers/2026/neurips-rebuttal".into(),
                opened_at: Some(now - 3 * DAY),
            },
            RecentProject {
                name: "Reading notes".into(),
                path: "/Users/writer/Documents/reading-notes".into(),
                opened_at: None,
            },
        ];
        self.with_window(cx, |shell, window, cx| {
            cx.set_reduce_motion(true);
            RecentProjects::stage(recents, cx);
            shell.update(cx, |shell, cx| {
                shell.show_welcome(
                    Some(Unopened {
                        project: moved,
                        reason: "Could not open the project: no such file or directory".into(),
                    }),
                    window,
                    cx,
                )
            });
        })?;
        self.park_pointer(cx)?;
        sleep(cx, Duration::from_millis(1500)).await;
        let out = std::env::var("LATTICE_SHOT_OUT").unwrap_or_else(|_| "parity.png".into());
        self.capture(cx, &out).await?;
        let (viewport, scale, appearance, ui_font) = self.with_window(cx, |_, window, cx| {
            let lattice = cx.lattice();
            (
                window.viewport_size(),
                window.scale_factor(),
                lattice.palette.appearance,
                lattice.fonts.ui.clone(),
            )
        })?;
        Ok(json!({
            "png": out,
            "viewport": { "width": f32::from(viewport.width), "height": f32::from(viewport.height) },
            "scale": scale,
            "theme": match appearance { Appearance::Light => "light", Appearance::Dark => "dark" },
            "uiFont": ui_font.as_ref(),
            "pdfShown": false,
            "regions": regions_json(),
        }))
    }
}
