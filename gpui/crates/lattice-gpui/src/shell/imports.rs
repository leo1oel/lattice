//! Bringing files into the project from the tree, as the Tauri app's
//! (`src/app/use-project-tree.ts`): Import files… opens the Mac's panel on
//! files and folders together, and the tree's ⌘V duplicates the rows its ⌘C
//! copied. Both go through lattice-core's `import_files`, which routes each
//! file on content (UTF-8 text through the transaction log, the rest
//! copied). Nothing opens; what landed is summarized.
//!
//! Names the target already has are asked about once for the whole batch.
//! The app offers Keep both, Replace and Skip as a radio group; this asks
//! Keep both or Cancel, the app's default choice, until the radio group is
//! ported.

use gpui::{AppContext as _, Context, PathPromptOptions, Window};
use lattice_core::project::{self as core_project, ImportRequest, NameConflict, ProjectImport};
use lattice_ui::components::ToastLevel;

use super::Shell;
use crate::{
    confirm::{self, Confirm},
    notices::{self, Notice},
};

/// How many taken names the question lists before "and N more".
const LISTED_NAMES: usize = 5;

impl Shell {
    /// Import files…: the Mac's open panel, files and folders together, into
    /// `target` ("" is the project root).
    pub(super) fn choose_imports(
        &mut self,
        target: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: true,
            prompt: Some("Import".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else {
                return;
            };
            let sources: Vec<String> = paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            this.update_in(cx, |this, window, cx| {
                this.import_sources(sources, target, false, None, window, cx)
            })
            .ok();
        })
        .detach();
    }

    /// The tree's ⌘V: duplicate `paths` (project-relative) into `target`; a
    /// taken name keeps both.
    pub(super) fn paste_entries(
        &mut self,
        paths: Vec<String>,
        target: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let sources = paths
            .iter()
            .map(|path| root.join(path).to_string_lossy().into_owned())
            .collect();
        self.import_sources(
            sources,
            target,
            true,
            Some(NameConflict::KeepBoth),
            window,
            cx,
        );
    }

    /// Import `sources` (absolute) into `target`. Without a `conflict`
    /// policy, a name the target already has asks first.
    fn import_sources(
        &mut self,
        sources: Vec<String>,
        target: String,
        copy_existing: bool,
        conflict: Option<NameConflict>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let imported = cx.background_spawn({
            let (sources, target) = (sources.clone(), target.clone());
            async move {
                core_project::import_files(
                    &root,
                    ImportRequest {
                        sources: &sources,
                        target_directory: &target,
                        copy_existing,
                        conflict,
                    },
                    &mut |_, _| {},
                )
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let imported = imported.await;
            this.update_in(cx, |this, _, cx| match imported {
                Ok(result) if !result.conflicts.is_empty() => {
                    this.ask_import_conflict(sources, target, copy_existing, result.conflicts, cx)
                }
                Ok(result) => {
                    project.update(cx, |project, cx| project.entries_changed(cx));
                    notices::show(
                        Notice::new(ToastLevel::Info, imported_title(&result, &target))
                            .key("project-import"),
                        cx,
                    );
                }
                Err(error) => notices::error("Could not import", error, cx),
            })
            .ok();
        })
        .detach();
    }

    fn ask_import_conflict(
        &mut self,
        sources: Vec<String>,
        target: String,
        copy_existing: bool,
        names: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        let view = cx.entity().downgrade();
        let count = names.len();
        let title = match (count, target.is_empty()) {
            (1, true) => "An item with this name is already in the project root".to_string(),
            (1, false) => format!("An item with this name is already in {target}"),
            (_, true) => format!("{count} items with these names are already in the project root"),
            (_, false) => format!("{count} items with these names are already in {target}"),
        };
        let mut listed = names
            .iter()
            .take(LISTED_NAMES)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(", ");
        if count > LISTED_NAMES {
            listed.push_str(&format!(" and {} more", count - LISTED_NAMES));
        }
        confirm::ask(
            Confirm::new(title)
                .body(format!(
                    "{listed}. Keep both lands each under the next free name."
                ))
                .confirm_label("Keep both")
                .on_confirm(move |window, cx| {
                    let (sources, target) = (sources.clone(), target.clone());
                    view.update(cx, |this, cx| {
                        this.import_sources(
                            sources,
                            target,
                            copy_existing,
                            Some(NameConflict::KeepBoth),
                            window,
                            cx,
                        )
                    })
                    .ok();
                }),
            cx,
        );
    }
}

/// What landed, as the app's toast titles it.
fn imported_title(result: &ProjectImport, target: &str) -> String {
    let count = result.entries.len();
    let name = result
        .entries
        .first()
        .and_then(|entry| entry.rsplit('/').next())
        .unwrap_or_default();
    match (count, target.is_empty()) {
        (0, _) => "Nothing imported".to_string(),
        (1, true) => format!("Imported “{name}” into the project root"),
        (1, false) => format!("Imported “{name}” into {target}"),
        (_, true) => format!("Imported {count} items into the project root"),
        (_, false) => format!("Imported {count} items into {target}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summary_names_one_item_and_counts_several() {
        let one = ProjectImport {
            entries: vec!["figures/plot.pdf".into()],
            ..Default::default()
        };
        assert_eq!(
            imported_title(&one, "figures"),
            "Imported “plot.pdf” into figures"
        );
        let two = ProjectImport {
            entries: vec!["a.tex".into(), "b.tex".into()],
            ..Default::default()
        };
        assert_eq!(
            imported_title(&two, ""),
            "Imported 2 items into the project root"
        );
        assert_eq!(
            imported_title(&ProjectImport::default(), ""),
            "Nothing imported"
        );
    }
}
