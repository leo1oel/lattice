//! New project's My templates and Save a local template
//! (`welcome/local_templates.rs`, `welcome/save_template.rs`):
//!
//! - New project shows My templates with Save a local template… and, with
//!   nothing saved in the run's own store, no list.
//! - Save a local template reads the open project as its source (Current
//!   project): its reusable files listed, hidden ones left out, none ticked,
//!   and Save template held until it has a name and its compile root is
//!   ticked.
//! - Saved, the template joins My templates chosen, and a project created
//!   from it (`local:<id>`) holds the files ticked and only those.
//!
//! With `LATTICE_E2E_SHOTS=DIR` (and the `offscreen-shots` feature) it saves
//! the window at New project with a saved template chosen and at the save
//! dialog.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::{scenario::Run, shell::commands::NewProject};

impl Run {
    async fn local_templates(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let root = cx
            .update(|cx| self.shell.read(cx).root(cx))
            .context("a project is open")?;
        self.with_window(cx, |shell, window, cx| {
            window.focus(&shell.read(cx).focus_handle.clone(), cx);
            window.dispatch_action(Box::new(NewProject), cx)
        })?;
        self.wait_for(cx, Duration::from_secs(2), |shell, cx| {
            shell.read(cx).new_project_dialog().is_some()
        })
        .await;
        let dialog = cx
            .update(|cx| self.shell.read(cx).new_project_dialog().cloned())
            .context("New project is up")?;
        // The run's own store, read: empty, so no list.
        let loaded = self
            .wait_until(cx, Duration::from_secs(5), |cx| dialog.read(cx).templates_loaded())
            .await;
        let (listed, _) = cx.update(|cx| dialog.read(cx).local_templates());
        let store = crate::welcome::local_templates::store();
        // Never the writer's own store (the app's state folder outside a run).
        let writers = dirs::data_dir().map(|dir| dir.join("lattice-gpui").join("templates"));
        let apart = writers.as_ref() != Some(&store);
        steps.check(
            "New project reads My templates from the run's own store, with no list while nothing is saved",
            loaded && listed.is_empty() && apart,
            json!({ "loaded": loaded, "listed": listed, "store": store, "apart": apart }),
        );

        // Save a local template from the open project.
        self.with_window(cx, {
            let dialog = dialog.clone();
            move |_, window, cx| dialog.update(cx, |dialog, cx| dialog.open_save_template(window, cx))
        })?;
        let saving = cx
            .update(|cx| dialog.read(cx).save_template_dialog().cloned())
            .context("Save a local template is up")?;
        self.with_window(cx, {
            let saving = saving.clone();
            let root = root.clone();
            move |_, window, cx| saving.update(cx, |saving, cx| saving.read_source(root, window, cx))
        })?;
        let read = self
            .wait_until(cx, Duration::from_secs(10), |cx| {
                let saving = saving.read(cx);
                !saving.is_busy() && (saving.source_files().is_some() || saving.error().is_some())
            })
            .await;
        let files = cx.update(|cx| saving.read(cx).source_files()).unwrap_or_default();
        let held = cx.update(|cx| saving.read(cx).saveable(cx));
        self.with_window(cx, {
            let saving = saving.clone();
            move |_, window, cx| {
                saving.update(cx, |saving, cx| {
                    saving.set_name("Lab paper", window, cx);
                    saving.tick("main.tex", cx);
                })
            }
        })?;
        let ready = cx.update(|cx| saving.read(cx).saveable(cx));
        self.templates_shot(cx, "save-template").await;
        steps.check(
            "Save a local template reads the open project: its .tex sources listed, hidden files left out, and Save template held until it is named and its compile root ticked",
            read
                && files.iter().any(|file| file == "main.tex")
                && files.iter().all(|file| !file.starts_with('.') && !file.contains("/."))
                && !held
                && ready,
            json!({ "read": read, "files": files, "held_before": held, "ready": ready }),
        );

        cx.update(|cx| saving.update(cx, |saving, cx| saving.press_save(cx)));
        let closed = self
            .wait_until(cx, Duration::from_secs(10), |cx| {
                dialog.read(cx).save_template_dialog().is_none()
            })
            .await;
        let (listed, chosen) = cx.update(|cx| dialog.read(cx).local_templates());
        self.templates_shot(cx, "new-project-my-template").await;
        steps.check(
            "a saved template joins My templates, chosen",
            closed && listed.len() == 1 && chosen.as_ref() == listed.first(),
            json!({ "closed": closed, "listed": listed, "chosen": chosen }),
        );

        // A project made from it holds the files ticked, and only those.
        let parent = tempfile::tempdir()?;
        let made = chosen.as_ref().map(|id| {
            crate::welcome::new_project::create_project(
                parent.path().to_path_buf(),
                "From my template".into(),
                &format!("local:{id}"),
            )
        });
        let project = parent.path().join("From my template");
        let tex: Vec<String> = std::fs::read_dir(&project)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tex"))
            .collect();
        steps.check(
            "a project created from the saved template holds its compile root and no file left unticked",
            matches!(made, Some(Ok(_))) && tex == ["main.tex"],
            json!({ "made": made.map(|made| made.map(|path| path.display().to_string())), "tex": tex }),
        );

        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.dismiss_new_project(window, cx))
        })?;
        Ok(())
    }

    /// Wait up to `limit` for `done`, read from the app.
    async fn wait_until(
        &self,
        cx: &mut AsyncApp,
        limit: Duration,
        done: impl Fn(&gpui::App) -> bool,
    ) -> bool {
        self.wait_for(cx, limit, |_, cx| done(cx)).await
    }

    async fn templates_shot(&self, cx: &mut AsyncApp, name: &str) {
        let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") else {
            return;
        };
        self.pause(cx, Duration::from_millis(400)).await;
        let path = std::path::Path::new(&dir).join(format!("{name}.png"));
        if let Err(error) = self.capture(cx, &path.to_string_lossy()).await {
            log::warn!("no shot {name}: {error:#}");
        }
    }
}

/// This file's registration as the e2e module `local_templates`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 101,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/welcome/local_templates.rs",
        "gpui/crates/lattice-gpui/src/welcome/save_template.rs",
        "gpui/crates/lattice-gpui/src/welcome/new_project.rs",
    ],
    run: |run, cx, steps, _| Box::pin(run.local_templates(cx, steps)),
};
