//! The e2e checks of Export ZIP, as the Tauri app has it (`exportProjectZip`,
//! `native_locale.rs`'s File menu): File › Export ZIP… sits before Export for
//! arXiv… and is dimmed with it when no window shows a project (as a scenario's
//! offscreen window is never the front one), the palette lists Export project
//! ZIP, and the export saves what an editor holds before it writes the
//! project's sources to the archive, the build's output left out.

use std::{io::Read as _, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, OwnedMenuItem};
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

impl Run {
    async fn export_zip_checks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &std::path::Path,
    ) -> Result<()> {
        cx.update(crate::shell::menus::install_menus);
        let file_menu: Vec<(String, bool)> = cx
            .update(|cx| cx.get_menus())
            .unwrap_or_default()
            .into_iter()
            .find(|menu| menu.name == "File")
            .map(|menu| {
                menu.items
                    .into_iter()
                    .filter_map(|item| match item {
                        OwnedMenuItem::Action { name, disabled, .. } => Some((name, !disabled)),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let at = |name: &str| file_menu.iter().position(|(item, _)| item == name);
        let palette = cx.update(|cx| {
            let context = self.shell.read(cx).command_context(cx);
            crate::shell::commands::commands(&context)
                .into_iter()
                .any(|command| command.id == "export-zip" && command.palette)
        });
        steps.check(
            "File › Export ZIP… comes before Export for arXiv… and is dimmed with it, and the palette lists Export project ZIP",
            at("Export ZIP…").is_some_and(|zip| {
                at("Export for arXiv…") == Some(zip + 1) && file_menu[zip].1 == file_menu[zip + 1].1
            }) && palette,
            json!({ "file": file_menu, "palette": palette }),
        );

        // An edit not yet saved goes into the archive.
        let file = root.join("export-zip-check.tex");
        std::fs::write(&file, "draft\n")?;
        let editor = self.open(cx, &file, Some(1))?;
        self.pause(cx, Duration::from_millis(200)).await;
        let typed = "Exported unsaved. ";
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor
                    .editor()
                    .update(cx, |editor, cx| editor.insert(typed, window, cx))
            })
        })?;
        let scratch = tempfile::tempdir()?;
        let zip = scratch.path().join("project.zip");
        {
            let zip = zip.clone();
            self.with_window(cx, move |shell, _, cx| {
                shell.update(cx, |shell, cx| shell.export_project_zip_to(zip, cx))
            })?;
        }
        let written = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                zip.is_file() && !shell.read(cx).exporting_zip()
            })
            .await;
        let (names, held) = read_archive(&zip);
        steps.check(
            "Export ZIP saves the editor's edits, then writes the project's sources without the build's output",
            written
                && names.iter().any(|name| name == "main.tex")
                && held.contains(typed)
                && !names.iter().any(|name| name.ends_with(".aux") || name.ends_with(".log")),
            json!({ "written": written, "entries": names, "check_file": held }),
        );
        self.close_tab(cx, editor)?;
        std::fs::remove_file(&file).ok();
        Ok(())
    }
}

/// The archive's entries, and the text it holds for the check file.
fn read_archive(path: &std::path::Path) -> (Vec<String>, String) {
    let Ok(file) = std::fs::File::open(path) else {
        return (Vec::new(), String::new());
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return (Vec::new(), String::new());
    };
    let names: Vec<String> = archive
        .file_names()
        .filter_map(|name| name.ok().map(|name| name.to_string()))
        .collect();
    let mut held = String::new();
    if let Ok(mut entry) = archive.by_name("export-zip-check.tex") {
        entry.read_to_string(&mut held).ok();
    }
    (names, held)
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 99,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/export_zip.rs",
        "gpui/crates/lattice-gpui/src/titlebar/project_menu.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.export_zip_checks(cx, steps, &fixture.root)),
};
