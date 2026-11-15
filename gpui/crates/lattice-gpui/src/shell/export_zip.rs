//! Export ZIP (`exportProjectZip` in `use-project-lifecycle.ts`): File ›
//! Export ZIP…, the project menu's Export ZIP and the palette's Export
//! project ZIP. It asks where to save `<project>.zip`, saves what the
//! editors hold, then writes the project's sources there with lattice-core's
//! `export_project_zip`, the Tauri app's own pack (the build's output left
//! out). While it runs the project menu says "Exporting ZIP…"; a failure
//! shows its message.

use std::path::{Path, PathBuf};

use gpui::{AppContext as _, Context, InteractiveElement as _, Window, actions};
use lattice_i18n::t;

use super::{
    Shell,
    commands::{Command, CommandContext, Section},
    parts::Part,
};

actions!(lattice, [ExportProjectZip]);

/// The part's state: whether an export is under way.
#[derive(Default)]
struct ExportZip {
    busy: bool,
}

/// The archive's name for project `name`: the characters a file name cannot
/// hold become dashes, as the Tauri app's save dialog suggests it.
fn archive_name(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for character in name.chars() {
        if matches!(
            character,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        ) {
            if !dash {
                out.push('-');
            }
            dash = true;
        } else {
            out.push(character);
            dash = false;
        }
    }
    if out.is_empty() {
        out = t!("project").to_string();
    }
    format!("{out}.zip")
}

/// Write the project at `root` to `zip`, the sources only.
fn write_archive(root: &Path, zip: &Path) -> Result<(), String> {
    lattice_core::project::export_project_zip(root, zip)
}

impl Shell {
    /// Whether an export is under way, for the project menu's busy line.
    pub(crate) fn exporting_zip(&self) -> bool {
        self.parts.get::<ExportZip>().busy
    }

    pub(crate) fn export_project_zip(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        if self.exporting_zip() {
            return;
        }
        let directory = root
            .parent()
            .map(Path::to_path_buf)
            .or_else(dirs::home_dir)
            .unwrap_or_else(std::env::temp_dir);
        let name = archive_name(&self.project_name(cx));
        let chosen = cx.prompt_for_new_path(&directory, Some(&name));
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(zip))) = chosen.await else {
                return;
            };
            Self::export_to(this, root, zip, cx).await;
        })
        .detach();
    }

    /// Save, then write the archive to `zip`, with the menu's busy line
    /// while it runs.
    async fn export_to(
        this: gpui::WeakEntity<Self>,
        root: PathBuf,
        zip: PathBuf,
        cx: &mut gpui::AsyncApp,
    ) {
        let set_busy = |busy: bool, cx: &mut gpui::AsyncApp| {
            this.update(cx, |this, cx| {
                this.parts.get_mut::<ExportZip>().busy = busy;
                cx.notify();
            })
            .ok();
        };
        set_busy(true, cx);
        // A save that fails says why itself, and nothing is written.
        let saved = match this.update(cx, |this, cx| this.save_editors(cx)) {
            Ok(task) => task.await,
            Err(_) => false,
        };
        if saved {
            let written = cx
                .background_spawn(async move { write_archive(&root, &zip) })
                .await;
            if let Err(message) = written {
                cx.update(|cx| crate::notices::error(t!("App"), message, cx));
            }
        }
        set_busy(false, cx);
    }

    /// Export to `zip` without asking where, for scenarios.
    pub(crate) fn export_project_zip_to(&mut self, zip: PathBuf, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        cx.spawn(async move |this, cx| Self::export_to(this, root, zip, cx).await)
            .detach();
    }
}

fn commands(context: &CommandContext, out: &mut Vec<Command>) {
    if context.in_project {
        out.push(
            Command::new(
                "export-zip",
                t!("Export project ZIP"),
                Section::Project,
                ExportProjectZip,
            )
            .keywords(t!("Overleaf source pack")),
        );
    }
}

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(ExportZip::default()),
    views: &[],
    actions: |element, cx| {
        element.on_action(
            cx.listener(|this: &mut Shell, _: &ExportProjectZip, window, cx| {
                this.export_project_zip(window, cx)
            }),
        )
    },
    commands,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_archive_is_named_for_the_project_without_path_characters() {
        // use-project-lifecycle.ts: name.replace(/[\\/:*?"<>|]+/g, "-").
        assert_eq!(archive_name("Thesis"), "Thesis.zip");
        assert_eq!(archive_name("a/b:c"), "a-b-c.zip");
        assert_eq!(archive_name("draft??<v2>"), "draft-v2-.zip");
    }
}
