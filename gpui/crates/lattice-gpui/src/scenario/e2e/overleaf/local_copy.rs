//! The e2e check that "Open from Overleaf" finds the folder the Tauri app
//! linked to a project, as the Tauri app's picker does
//! (`overleaf-project-picker.tsx`, `overleaf_local_copies`): the download is
//! moved out of Overleaf Projects into a folder only the Tauri app's list of
//! linked folders names (the stand-in's, under the run's scratch), which this
//! app has never opened there. The picker names that folder on the row, Open
//! opens it in a window of its own without downloading a second copy, and
//! the first sync there brings in what a co-author changed meanwhile.

use std::{path::Path, time::Duration};

use anyhow::{Result, anyhow};
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::scenario::{
    Run,
    overleaf_mock::{MockOverleaf, PROJECT_NAME},
};

impl Run {
    pub(super) async fn overleaf_local_copy(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
        clone_root: &Path,
    ) -> Result<()> {
        // The download's window was just closed; give its last writes a beat.
        self.wait_for(cx, Duration::from_secs(10), |_, cx| {
            crate::shell::windows::shell_showing(clone_root, cx).is_none()
        })
        .await;
        self.pause(cx, Duration::from_millis(500)).await;
        let scratch = clone_root
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| anyhow!("the scratch folder"))?;
        let papers = scratch.join("Papers");
        std::fs::create_dir_all(&papers)?;
        let elsewhere = papers.join(PROJECT_NAME);
        std::fs::rename(clone_root, &elsewhere)?;
        let elsewhere = elsewhere.canonicalize()?;
        let tauri = crate::overleaf::tauri_config_dir()
            .ok_or_else(|| anyhow!("the Tauri app's config folder"))?;
        // As the Tauri app records every folder it links or opens linked.
        lattice_core::overleaf::remember_local_copy(&tauri, &elsewhere);
        let tauri_list = std::fs::read(tauri.join("overleaf-local-copies.json"))?;
        // What a co-author did while the project sat closed: the first sync
        // in the folder that opens must bring it in.
        let meanwhile = "@misc{a, title={A}}\n@misc{b, title={B, added on Overleaf}}\n";
        mock.edit("refs.bib", meanwhile);

        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_overleaf_picker(window, cx))
        })?;
        let picker = cx
            .update(|cx| self.shell.read(cx).overleaf_picker())
            .ok_or_else(|| anyhow!("the picker did not open"))?;
        let named = self
            .wait_for(cx, Duration::from_secs(30), |_, cx| {
                picker
                    .read(cx)
                    .scenario_local_copy(PROJECT_NAME, cx)
                    .is_some()
            })
            .await;
        let copy = cx.update(|cx| picker.read(cx).scenario_local_copy(PROJECT_NAME, cx));
        let opened = cx.update(|cx| {
            picker.update(cx, |picker, cx| {
                picker.scenario_open(PROJECT_NAME, false, cx)
            })
        });
        let shown = self
            .wait_for(cx, Duration::from_secs(30), |_, cx| {
                crate::shell::windows::shell_showing(&elsewhere, cx).is_some()
            })
            .await;
        let found = cx.update(|cx| crate::shell::windows::shell_showing(&elsewhere, cx));
        let downloaded_again = clone_root.exists();
        steps.check(
            "Open from Overleaf opens the folder the Tauri app linked, named on its row, in a window of its own, and downloads no second copy",
            named
                && copy.as_deref().is_some_and(|copy| copy.ends_with(&format!("Papers/{PROJECT_NAME}")))
                && opened
                && shown
                && !downloaded_again,
            json!({
                "copy": copy,
                "root": elsewhere,
                "shown": shown,
                "downloaded_again": downloaded_again,
            }),
        );
        let Some((window, shell)) = found else {
            return Ok(());
        };
        let linked = self.for_window(shell, window);
        let synced = linked
            .wait_for(cx, Duration::from_secs(45), |shell, cx| {
                shell.read(cx).overleaf.read(cx).link().is_some()
                    && std::fs::read_to_string(elsewhere.join("refs.bib"))
                        .is_ok_and(|text| text == meanwhile)
            })
            .await;
        let untouched = std::fs::read(tauri.join("overleaf-local-copies.json"))
            .is_ok_and(|now| now == tauri_list);
        steps.check(
            "the folder opens linked and its first sync brings in a co-author's edit made meanwhile, the Tauri app's list left as it was",
            synced && untouched,
            json!({ "synced": synced, "untouched": untouched }),
        );
        window
            .update(cx, |_, window, _| window.remove_window())
            .ok();
        Ok(())
    }
}
