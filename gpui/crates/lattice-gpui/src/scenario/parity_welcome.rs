//! `parity` with `LATTICE_PARITY_SCREEN=welcome`: the welcome screen staged
//! as the parity harness stages it in the Tauri app (`?welcome=1&recents=1`,
//! `tools/perf-bench/bench-page.ts`): four recent projects, the newest one's
//! folder gone so the screen says it could not be reopened, the desk laying
//! out the next three. Motion is reduced, as the reference page's is, so
//! the field, the mark and the column are at rest when captured.
//!
//! `LATTICE_PARITY_SCREEN=recents` stages 64 made-up recent projects
//! instead (every fifth linked to Overleaf, every ninth missing): the
//! welcome screen with its "More projects" list; `recents-finder` the
//! recent project finder over it with "pap" typed; `recents-switcher` the
//! project in its window with the titlebar switcher's menu open, ending in
//! "All recent projects…".

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use lattice_ui::{ActiveLattice as _, Appearance};
use serde_json::{Value, json};

use super::{Run, parity::regions_json, sleep};
use crate::{
    first_pages::FirstPages,
    recents::{RecentProject, RecentProjects, now_ms},
    welcome::Unopened,
};

const DAY: u64 = 86_400_000;

/// The made-up projects `recents` stages, newest first.
fn many_recents(now: u64) -> Vec<RecentProject> {
    const TOPICS: [&str; 16] = [
        "Sparse attention",
        "NeurIPS rebuttal",
        "Reading notes",
        "Thesis draft",
        "Diffusion survey",
        "Grant proposal",
        "ICML camera ready",
        "Lecture notes",
        "Paper reviews",
        "Kernel methods",
        "Graph transformers",
        "Workshop poster",
        "Optimal transport",
        "Lab handbook",
        "Causal inference",
        "Robust training",
    ];
    const FOLDERS: [&str; 4] = ["Papers", "Papers/2026", "Documents", "Overleaf"];
    (0..64)
        .map(|n| {
            let topic = TOPICS[n % TOPICS.len()];
            let name = match n / TOPICS.len() {
                0 => topic.to_string(),
                round => format!("{topic} {}", round + 1),
            };
            let slug = name.to_lowercase().replace(' ', "-");
            RecentProject {
                path: format!("/Users/writer/{}/{slug}", FOLDERS[n % FOLDERS.len()]).into(),
                name,
                opened_at: Some(now - (n as u64 + 1) * DAY * 2 / 3),
                overleaf: n % 5 == 1,
                missing: n % 9 == 4,
            }
        })
        .collect()
}

impl Run {
    /// `recents`, `recents-finder` and `recents-switcher`: 64 recent
    /// projects staged, the screen captured.
    pub(super) async fn parity_recents(&self, cx: &mut AsyncApp, screen: &str) -> Result<Value> {
        self.root(cx).await?;
        let recents = many_recents(now_ms());
        let switcher = screen == "recents-switcher";
        self.with_window(cx, |shell, window, cx| {
            cx.set_reduce_motion(true);
            RecentProjects::stage(recents, cx);
            if !switcher {
                shell.update(cx, |shell, cx| shell.show_welcome(None, window, cx));
            }
        })?;
        self.park_pointer(cx)?;
        sleep(cx, Duration::from_millis(1200)).await;
        if screen == "recents-finder" {
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| shell.open_recent_finder(window, cx));
                if let Some(finder) = shell.read(cx).quick_open().cloned() {
                    finder.update(cx, |finder, cx| finder.set_query("pap", window, cx));
                }
            })?;
            sleep(cx, Duration::from_millis(600)).await;
        }
        if switcher {
            let start = self
                .with_window(cx, |shell, _, cx| {
                    shell.read(cx).titlebar_drag().left_start()
                })?
                .unwrap_or(80.);
            crate::native::send_titlebar_click(
                self.native(cx)?,
                gpui::point(gpui::px(start + 16.), gpui::px(18.)),
            )?;
            sleep(cx, Duration::from_millis(800)).await;
        }
        let out = std::env::var("LATTICE_SHOT_OUT").unwrap_or_else(|_| "parity.png".into());
        self.capture(cx, &out).await?;
        let rows = self.with_window(cx, |shell, _, cx| {
            shell
                .read(cx)
                .quick_open()
                .map(|finder| finder.read(cx).row_texts())
                .unwrap_or_default()
        })?;
        Ok(json!({ "png": out, "screen": screen, "finderRows": rows, "regions": regions_json() }))
    }

    pub(super) async fn parity_welcome(&self, cx: &mut AsyncApp) -> Result<Value> {
        // The project the harness passed opens first; the welcome screen is
        // then laid over the window, as a window without one shows it.
        let root = self.root(cx).await?;
        let now = now_ms();
        let moved = RecentProject {
            name: "Thesis draft".into(),
            path: "/Users/writer/Moved/thesis-draft".into(),
            opened_at: Some(now - DAY / 2),
            ..Default::default()
        };
        let recents = vec![
            moved.clone(),
            RecentProject {
                name: "Sparse attention".into(),
                path: "/Users/writer/Papers/sparse-attention".into(),
                opened_at: Some(now - DAY),
                ..Default::default()
            },
            RecentProject {
                name: "NeurIPS rebuttal".into(),
                path: "/Users/writer/Papers/2026/neurips-rebuttal".into(),
                opened_at: Some(now - 3 * DAY),
                ..Default::default()
            },
            RecentProject {
                name: "Reading notes".into(),
                path: "/Users/writer/Documents/reading-notes".into(),
                opened_at: None,
                ..Default::default()
            },
        ];
        self.with_window(cx, |shell, window, cx| {
            cx.set_reduce_motion(true);
            RecentProjects::stage(recents, cx);
            // The next project has built the tutorial's PDF, typeset in
            // ICML's template.
            FirstPages::stage(
                "/Users/writer/Papers/sparse-attention".into(),
                root.join("main.pdf"),
                "ICML",
                cx,
            );
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
        // The page is drawn by the PDF worker, then fades in.
        sleep(cx, Duration::from_millis(2500)).await;
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
