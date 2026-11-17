//! Two open documents with one file name (`shell/tab_names.rs`), driven by
//! the platform's own pointer events:
//!
//! - each tab names the folder that tells it from the other, and a tab with
//!   no namesake names none;
//! - the pointer resting on a tab brings up its path in Lattice's tooltip;
//! - a right click on the tab opens its menu with Copy path and Copy
//!   relative path.
//!
//! With `LATTICE_E2E_SHOTS` set it saves the window with the tooltip up
//! (`same-name-tabs-hover`) and with the menu open (`same-name-tabs-menu`).

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::{native, scenario::Run, shell::tab_names::tab_text};

impl Run {
    async fn same_name_tabs(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        std::fs::create_dir_all(root.join("appendix"))?;
        std::fs::write(root.join("appendix/intro.tex"), "\\section{Appendix}\n")?;
        let result = self.same_name_tabs_steps(cx, steps, root).await;
        if let Ok(path) = root.join("appendix/intro.tex").canonicalize() {
            cx.update(|cx| {
                self.shell.update(cx, |shell, cx| {
                    let views: Vec<String> = shell.view_of_document("appendix/intro.tex", cx).into_iter().collect();
                    shell.workspace().clone().update(cx, |workspace, cx| workspace.close(&views, cx));
                })
            });
            self.pause(cx, Duration::from_millis(300)).await;
            std::fs::remove_file(path).ok();
        }
        std::fs::remove_dir(root.join("appendix")).ok();
        result
    }

    async fn same_name_tabs_steps(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        self.open(cx, &root.join("chapters/intro.tex"), None)?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.open(cx, &root.join("appendix/intro.tex"), None)?;
        self.pause(cx, Duration::from_millis(500)).await;

        let texts = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let doc = shell.workspace().read(cx).engine().doc().clone();
            ["chapters/intro.tex", "appendix/intro.tex", "main.tex"]
                .into_iter()
                .map(|key| {
                    let text = shell
                        .view_of_document(key, cx)
                        .map(|view| tab_text(&doc, &view, "intro.tex"));
                    (key, text)
                })
                .collect::<Vec<_>>()
        });
        let detail = |key: &str| {
            texts
                .iter()
                .find(|(k, _)| *k == key)
                .and_then(|(_, text)| text.as_ref())
                .and_then(|(detail, _)| detail.clone())
        };
        let tooltip = |key: &str| {
            texts
                .iter()
                .find(|(k, _)| *k == key)
                .and_then(|(_, text)| text.as_ref())
                .and_then(|(_, tooltip)| tooltip.clone())
        };
        steps.check(
            "two open intro.tex tabs name the folders that tell them apart, and their tooltips their paths",
            detail("chapters/intro.tex").as_deref() == Some("chapters")
                && detail("appendix/intro.tex").as_deref() == Some("appendix")
                && tooltip("appendix/intro.tex").as_deref() == Some("appendix/intro.tex")
                && detail("main.tex").is_none(),
            json!({ "texts": format!("{texts:?}") }),
        );

        // The tabs as the strip last drew them.
        let (appendix, chapters) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let state = |key: &str| shell.tab_state(key, cx);
            let panel = state("appendix/intro.tex").map(|(panel, ..)| panel).unwrap_or_default();
            let bounds = shell.workspace().read(cx).tab_bounds(&panel);
            let of = |key: &str| {
                let view = shell.view_of_document(key, cx)?;
                bounds.iter().find(|(id, _)| *id == view).map(|(_, b)| *b)
            };
            (of("appendix/intro.tex"), of("chapters/intro.tex"))
        });
        let appendix = appendix.context("appendix/intro.tex's tab is drawn")?;
        let chapters = chapters.context("chapters/intro.tex's tab is drawn")?;

        self.hover_at(cx, appendix.center()).await?;
        self.pause(cx, Duration::from_millis(1200)).await;
        self.same_name_shot(cx, "same-name-tabs-hover").await;

        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Moved, chapters.center())?;
        native::send_right_click(native, chapters.center())?;
        self.pause(cx, Duration::from_millis(600)).await;
        self.same_name_shot(cx, "same-name-tabs-menu").await;
        // A press below the strip, in the editor, closes the menu.
        let away = gpui::point(chapters.left() + gpui::px(4.), chapters.bottom() + gpui::px(400.));
        native::send_click(native, away)?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }

    async fn same_name_shot(&self, cx: &mut AsyncApp, name: &str) {
        #[cfg(target_os = "macos")]
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            let path = Path::new(&dir).join(format!("{name}.png"));
            if let Err(error) = self.capture(cx, &path.to_string_lossy()).await {
                log::warn!("could not save {}: {error:#}", path.display());
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (cx, name);
    }
}

/// This file's registration as the e2e module `same_name_tabs` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 35,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/tab_names.rs",
        "gpui/crates/lattice-gpui/src/shell/skin.rs",
        "gpui/crates/lattice-ui/src/components/tab.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.same_name_tabs(cx, steps, &fixture.root)),
};
