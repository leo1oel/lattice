//! The e2e checks of the app's own lifecycle, as the Tauri app runs it: a
//! window's minimum follows its layout's, never below 640×680
//! (`use-native-window.ts`); an error logged anywhere in the app reaches its
//! log, with the App source, and a repeat updates its entry
//! (`global-error-capture.ts`); the crash save writes what an editor holds
//! unsaved, from the text its edits handed over, merging as a save does
//! (`crash-save.ts`); the launch after a crash says so, with the error's
//! details in the log; and the menu bar is laid out as the Tauri app's
//! (`native_locale.rs`), with Export for arXiv… dimmed without a project and
//! Help's two project links.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, OwnedMenu, OwnedMenuItem};
use serde_json::json;

use super::Steps;
use crate::{
    app_log::{self, Level},
    crash,
    notices,
    scenario::Run,
};

/// What a menu lists: its items' names, a separator as "—" and a submenu by
/// its name.
fn names(menu: &OwnedMenu) -> Vec<String> {
    menu.items
        .iter()
        .map(|item| match item {
            OwnedMenuItem::Separator => "—".to_string(),
            OwnedMenuItem::Submenu(menu) => menu.name.to_string(),
            OwnedMenuItem::SystemMenu(menu) => menu.name.to_string(),
            OwnedMenuItem::Action { name, .. } => name.clone(),
        })
        .collect()
}

impl Run {
    async fn shell_lifecycle(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        self.minimum_size(cx, steps)?;
        self.errors_reach_the_log(cx, steps).await;
        self.crash_save(cx, steps, root).await?;
        self.crash_notice(cx, steps);
        self.menu_bar(cx, steps).await;
        Ok(())
    }

    fn minimum_size(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let (engine, screen) = self.with_window(cx, |shell, window, cx| {
            (
                shell.read(cx).workspace().read(cx).engine().min_width(),
                window
                    .display(cx)
                    .map(|display| f32::from(display.visible_bounds().size.width)),
            )
        })?;
        #[cfg(target_os = "macos")]
        let (applied, height) = {
            let (width, height) = crate::native::content_min_size(self.native(cx)?);
            (Some(width as f32), Some(height as f32))
        };
        #[cfg(not(target_os = "macos"))]
        let (applied, height) = (
            self.with_window(cx, |_, window, cx| {
                crate::shell::windows::applied_minimum_width(window, cx)
            })?,
            None::<f32>,
        );
        let scale = cx.update(|cx| crate::interface_zoom::scale(cx));
        // window-layout.ts's `minimumWindowWidth`, worked out here from the
        // layout engine's own minimum: `main.workspace`'s 6px either side,
        // the 640pt titlebar floor, scaled up by the interface size, and
        // capped by the screen.
        let content = (engine as f32 + 12.).max(640.);
        let width = (content * scale).ceil();
        let expected = screen.map_or(width, |screen| width.min(screen.floor()));
        steps.check(
            "the window's minimum follows its layout's, never below 640×680 points",
            applied == Some(expected) && height.is_none_or(|height| height == 680.),
            json!({ "applied": applied, "height": height, "engine": engine, "scale": scale, "screen": screen, "expected": expected }),
        );
        Ok(())
    }

    async fn errors_reach_the_log(&self, cx: &mut AsyncApp, steps: &mut Steps) {
        let message = "E2E captured error: the scenario logged this";
        log::error!("{message}");
        log::error!("{message}");
        let logged = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                app_log::global(cx)
                    .read(cx)
                    .entries()
                    .iter()
                    .any(|entry| entry.title == message)
            })
            .await;
        let entries: Vec<_> = cx.update(|cx| {
            app_log::global(cx)
                .read(cx)
                .entries()
                .iter()
                .filter(|entry| entry.title == message)
                .cloned()
                .collect()
        });
        steps.check(
            "an error logged in the app reaches its log, from App, once for a repeat",
            logged
                && entries.len() == 1
                && entries[0].level == Level::Error
                && entries[0].source == "App",
            json!({ "entries": entries.iter().map(|entry| (&entry.source, &entry.title)).collect::<Vec<_>>() }),
        );
    }

    async fn crash_save(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let file = root.join("crash-save-check.txt");
        std::fs::write(&file, "draft\n")?;
        let editor = self.open(cx, &file, Some(1))?;
        self.pause(cx, Duration::from_millis(200)).await;
        let typed = "Saved by the crash. ";
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor
                    .editor()
                    .update(cx, |editor, cx| editor.insert(typed, window, cx))
            })
        })?;
        // The autosave waits for a pause in typing; the crash save writes
        // within it, from the text the edit handed over.
        let held = crash::open_edit_paths().contains(&"crash-save-check.txt".to_string());
        let (saved, failed) = crash::save_open_edits_now();
        let disk = std::fs::read_to_string(&file).unwrap_or_default();
        steps.check(
            "the crash save writes an editor's unsaved text before the autosave would",
            held && saved.contains(&"crash-save-check.txt".to_string())
                && failed.is_empty()
                && disk.contains(typed),
            json!({ "held": held, "saved": saved, "failed": failed, "disk": disk }),
        );
        self.close_tab(cx, editor)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let forgotten = !crash::open_edit_paths().contains(&"crash-save-check.txt".to_string());
        steps.check(
            "a saved or closed editor leaves nothing for a crash to write",
            forgotten,
            json!({ "open": crash::open_edit_paths() }),
        );
        std::fs::remove_file(&file).ok();
        Ok(())
    }

    fn crash_notice(&self, cx: &mut AsyncApp, steps: &mut Steps) {
        let note = crash::CrashNote {
            timestamp: "2026-11-14T01:02:03.004Z".into(),
            detail: "panicked at src/shell.rs:1:1:\nE2E crash".into(),
            saved: vec!["main.tex".into()],
            failed: Vec::new(),
        };
        cx.update(|cx| crash::show_crash_notice(note, cx));
        let stack = cx.update(notices::install);
        let titles = cx.update(|cx| stack.read(cx).titles());
        let logged = cx.update(|cx| {
            app_log::global(cx)
                .read(cx)
                .entries()
                .iter()
                .any(|entry| entry.title == "Lattice UI crashed" && entry.detail.contains("E2E crash"))
        });
        steps.check(
            "the launch after a crash says so, and logs the error's details",
            titles.iter().any(|title| title == "Lattice quit unexpectedly") && logged,
            json!({ "titles": titles, "logged": logged }),
        );
        cx.update(|cx| notices::dismiss("lattice-crash", cx));
    }

    async fn menu_bar(&self, cx: &mut AsyncApp, steps: &mut Steps) {
        cx.update(crate::shell::menus::install_menus);
        let menus = cx.update(|cx| cx.get_menus()).unwrap_or_default();
        let titles: Vec<String> = menus.iter().map(|menu| menu.name.to_string()).collect();
        let menu = |title: &str| menus.iter().find(|menu| menu.name == title).map(names);
        let file = menu("File").unwrap_or_default();
        let help = menu("Help").unwrap_or_default();
        let window = menu("Window").unwrap_or_default();
        let view = menu("View").unwrap_or_default();
        let app = menu("Lattice").unwrap_or_default();
        steps.check(
            "the menu bar is the Tauri app's: Lattice, File, Edit, View, Window, Help",
            titles == ["Lattice", "File", "Edit", "View", "Window", "Help"]
                && app.first().is_some_and(|item| item == "About Lattice")
                && file.contains(&"Open from Overleaf…".to_string())
                && file.contains(&"Export for arXiv…".to_string())
                && view.contains(&"Enter Full Screen".to_string())
                && window.last().is_some_and(|item| item == "Close Window")
                && help.ends_with(&["Lattice Website".to_string(), "Lattice on GitHub".to_string()]),
            json!({ "titles": titles, "lattice": app, "file": file, "view": view, "window": window, "help": help }),
        );
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 95,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/crash.rs",
        "gpui/crates/lattice-gpui/src/app_log/capture.rs",
        "gpui/crates/lattice-gpui/src/shell/windows.rs",
        "gpui/crates/lattice-gpui/src/shell/menus.rs",
        "gpui/crates/lattice-gpui/src/app.rs",
        "gpui/crates/lattice-gpui/src/main.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.shell_lifecycle(cx, steps, &fixture.root)),
};
