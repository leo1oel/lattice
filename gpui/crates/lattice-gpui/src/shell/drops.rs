//! Files dragged in from Finder, and Project tree rows dragged out of the
//! Project panel, as the Tauri app takes them (`src/app/use-project-tree.ts`'s
//! drag-drop listener, `src/app/project-item-drag.ts` and
//! `src/trellis/trellis-file-drag.ts`).
//!
//! A Finder drop is routed on where it lands and on what it carries
//! (`classifyExternalProjectDrop`): sources (a document or code file), assets
//! (a figure: an image or a PDF), a mix of both, or something else.
//!
//! - The Project tree takes any mix, Finder-style, into the folder under the
//!   pointer (the project root off the rows), as Import files… does; nothing
//!   opens.
//! - An editor, or any other document's surface (a PDF, an image, a board),
//!   imports sources into the project root and opens them; figures over a
//!   LaTeX or Markdown editor go into `figures/` and in as figures at the
//!   line under the pointer; figures elsewhere go into `figures/` and open.
//! - The Agent panel attaches whatever it can read to its composer: its
//!   page's webview takes the drag before the window does
//!   (`agent/surface/drops.rs`), so no drop on it comes here.
//! - Anything else says where it can go instead.
//!
//! A tree row that leaves the Project panel (a file, not a figure, which
//! drags on into an editor as a figure) becomes the file's own tab, carried
//! by Trellis's drag ([`TrellisWorkspace::carry_view`]), so it lands where
//! Trellis's drop targets say: beside a panel's edge, in a seam, on a strip
//! or in a panel. Let go nowhere, or back over the Project panel, it falls
//! back and closes again.

use std::path::{Path, PathBuf};

use gpui::{App, AppContext as _, Context, Pixels, Point, Window};
use lattice_core::project as core_project;
use lattice_i18n::t;
use trellis::runtime::engine::ViewPlacement;

use super::{
    Shell,
    parts::{Part, no_commands},
};
use crate::notices;

/// What a Finder drop carries (`classifyExternalProjectDrop`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DropKind {
    /// Documents and code: every file opens in an editor.
    Source,
    /// Figures: images and PDFs.
    Asset,
    /// Sources and figures together.
    Mixed,
    /// Anything else, or nothing.
    Unsupported,
}

/// The documents an editor opens (`DOCUMENT_EXTENSIONS`), and the code and
/// config files it opens besides (`isProjectSourceFilePath`).
const SOURCE_EXTENSIONS: &[&str] = &[
    "tex",
    "bib",
    "md",
    "txt",
    "html",
    "sty",
    "cls",
    "bst",
    "tldr",
    "lattice-sheet",
    "tsx",
    "ts",
    "jsx",
    "js",
    "py",
    "mjs",
    "cjs",
    "rs",
    "go",
    "c",
    "cc",
    "cpp",
    "h",
    "hpp",
    "java",
    "rb",
    "pl",
    "r",
    "sh",
    "bash",
    "zsh",
    "json",
    "yaml",
    "yml",
    "toml",
    "xml",
    "css",
    "scss",
    "sql",
];

/// The figures a project takes (`isProjectAssetFilePath`).
const ASSET_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "pdf", "svg", "eps", "webp"];

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|known| known.eq_ignore_ascii_case(extension))
        })
}

/// Whether an editor opens `path` (a document, code or config file).
pub(crate) fn is_source(path: &Path) -> bool {
    has_extension(path, SOURCE_EXTENSIONS)
}

/// Whether `path` is a figure the project takes (an image or a PDF).
pub(crate) fn is_asset(path: &Path) -> bool {
    has_extension(path, ASSET_EXTENSIONS)
}

/// What the dropped `paths` are, all together.
pub(crate) fn classify(paths: &[PathBuf]) -> DropKind {
    if paths.is_empty() {
        return DropKind::Unsupported;
    }
    let sources = paths.iter().filter(|path| is_source(path)).count();
    let assets = paths.iter().filter(|path| is_asset(path)).count();
    if sources == paths.len() {
        DropKind::Source
    } else if assets == paths.len() {
        DropKind::Asset
    } else if sources + assets == paths.len() {
        DropKind::Mixed
    } else {
        DropKind::Unsupported
    }
}

/// Where a Finder drop landed.
pub(crate) enum DropSurface {
    /// A folder of the Project tree ("" is the project root).
    Tree(String),
    /// A source editor: whether it takes figures into its text (a LaTeX or
    /// Markdown file), and the start of the line under the pointer, where
    /// they go.
    Editor {
        editor: gpui::WeakEntity<crate::editor_panel::EditorPanel>,
        inserts: bool,
        at: Option<usize>,
    },
    /// Any other document's surface: a PDF, an image, a board, an empty slot.
    Canvas,
}

/// How a Finder drop over `surface` would be taken, as the drop target's
/// highlight shows it before the release: what an editor does with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EditorTake {
    /// Figures that go into its text (`figure-drop-active`).
    Insert,
    /// Files it imports and opens (`file-drop-active`).
    Open,
    /// Nothing: the drop would say where to go instead.
    Refuse,
}

/// What an editor does with a drop of `kind` (`insertsIntoEditor`,
/// `opensInEditor`).
pub(crate) fn editor_take(kind: DropKind, inserts: bool) -> EditorTake {
    match kind {
        DropKind::Asset if inserts => EditorTake::Insert,
        DropKind::Source | DropKind::Asset => EditorTake::Open,
        DropKind::Mixed | DropKind::Unsupported => EditorTake::Refuse,
    }
}

/// The window's tree drag carried on by Trellis: the file's view, whether
/// the drag opened it, and the view the Project panel showed before.
pub(crate) struct Carried {
    view: String,
    opened: bool,
    shown: Option<String>,
}

/// The part's state: the tree row being carried, if any.
#[derive(Default)]
pub(crate) struct Drops {
    carried: Option<Carried>,
}

impl Shell {
    /// Take a Finder drop of `paths` over `surface`.
    pub(crate) fn drop_files(
        &mut self,
        paths: Vec<PathBuf>,
        surface: DropSurface,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if paths.is_empty() || self.project.is_none() {
            return;
        }
        let kind = classify(&paths);
        let sources: Vec<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        match surface {
            DropSurface::Tree(target) => {
                self.import_sources(sources, target, false, None, window, cx);
            }
            DropSurface::Editor { .. } | DropSurface::Canvas if kind == DropKind::Source => {
                if let DropSurface::Editor { editor, .. } = &surface {
                    // Sources open where they were dropped.
                    self.active_editor = Some(editor.clone());
                }
                self.import_and_open_sources(sources, window, cx);
            }
            DropSurface::Editor { .. } | DropSurface::Canvas
                if kind == DropKind::Mixed || kind == DropKind::Unsupported =>
            {
                let message = if kind == DropKind::Mixed {
                    t!("Drop source files and figures separately")
                } else {
                    t!("This file type can’t be opened in an editor")
                };
                notices::error(message, "", cx);
            }
            DropSurface::Editor {
                editor,
                inserts: true,
                at,
            } => {
                self.active_editor = Some(editor);
                self.import_figures(sources, window, cx, move |this, paths, window, cx| {
                    this.insert_figures_at(paths, at, window, cx)
                });
            }
            DropSurface::Editor { .. } | DropSurface::Canvas => {
                self.import_figures(sources, window, cx, |this, paths, window, cx| {
                    let Some(root) = this.root(cx) else { return };
                    for path in paths {
                        this.open_path(root.join(path), None, window, cx);
                    }
                });
            }
        }
    }

    /// What a Finder drop over a part of the window that takes none says
    /// (the titlebar, a tool panel), by what it carries.
    pub(crate) fn refuse_drop(&self, paths: &[PathBuf], cx: &mut App) {
        let message = match classify(paths) {
            DropKind::Source => t!("Drop source files onto an editor or the Project pane"),
            DropKind::Mixed => t!("Drop source files and figures separately"),
            DropKind::Unsupported => t!("This file type can’t be opened in an editor"),
            DropKind::Asset => {
                t!("Drop figures onto a TeX or Markdown editor, or the Project pane")
            }
        };
        notices::error(message, "", cx);
    }

    /// `importSources`: copy source files into the project root (one
    /// already in the project is opened where it is), then open each.
    fn import_and_open_sources(
        &mut self,
        sources: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let imported = cx.background_spawn({
            let root = root.clone();
            async move { core_project::import_sources(&root, &sources, "") }
        });
        cx.spawn_in(window, async move |this, cx| {
            let imported = imported.await;
            this.update_in(cx, |this, window, cx| {
                project.update(cx, |project, cx| project.entries_changed(cx));
                match imported {
                    Ok(paths) => {
                        for path in paths {
                            this.open_path(root.join(path), None, window, cx);
                        }
                    }
                    Err(error) => notices::error(error, "", cx),
                }
            })
            .ok();
        })
        .detach();
    }

    /// `importAssets`: copy figures into `figures/`, then hand `landed`
    /// their project paths; nothing landed, nothing is handed on.
    fn import_figures(
        &mut self,
        sources: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
        landed: impl FnOnce(&mut Self, Vec<String>, &mut Window, &mut Context<Self>) + 'static,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let imported =
            cx.background_spawn(
                async move { core_project::import_assets(&root, &sources, "figures") },
            );
        cx.spawn_in(window, async move |this, cx| {
            let imported = imported.await;
            this.update_in(cx, |this, window, cx| {
                project.update(cx, |project, cx| project.entries_changed(cx));
                match imported {
                    Ok(paths) if !paths.is_empty() => landed(this, paths, window, cx),
                    Ok(_) => {}
                    Err(error) => notices::error(t!("Import figures"), error, cx),
                }
            })
            .ok();
        })
        .detach();
    }

    /// A tree row dragged out of the Project panel, under the pointer at
    /// `pointer`: once it is past the panel, Trellis carries the file's tab
    /// from there (`trellisTakesProjectDrag`). Returns whether it did, and
    /// the tree's own drag is over.
    pub(crate) fn carry_tree_row(
        &mut self,
        path: &str,
        pointer: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(project_panel) = self
            .placement("project", cx)
            .filter(|(placement, ..)| *placement != ViewPlacement::Hidden)
            .map(|(_, panel, _)| panel)
        else {
            return false;
        };
        if self
            .workspace
            .read(cx)
            .panel_bounds(&project_panel)
            .is_none_or(|bounds| bounds.contains(&pointer))
        {
            return false;
        }
        let existing = self.view_of_document(path, cx);
        if let Some(view) = &existing
            && self
                .placement(view, cx)
                .is_some_and(|(placement, ..)| placement == ViewPlacement::Hidden)
        {
            return false;
        }
        // The tab the Project panel shows now stays selected: the file only
        // passes through it.
        let shown = {
            let engine = self.workspace.read(cx).engine();
            self.document(cx)
                .views
                .keys()
                .find(|id| {
                    engine
                        .view_state(id)
                        .is_some_and(|state| state.panel_id == project_panel && state.selected)
                })
                .cloned()
        };
        let opened = existing.is_none();
        let view = match existing {
            Some(view) => view,
            None => {
                let mut params = trellis::model::Params::new();
                params.insert("key".into(), path.into());
                let view = self.engine_do(cx, |engine| {
                    let view = engine.open(
                        "file",
                        trellis::runtime::engine::OpenOptions {
                            params: Some(params),
                            placement: Some(trellis::model::Placement::Into {
                                into: project_panel.clone(),
                                index: None,
                            }),
                            focus: Some(false),
                            ..Default::default()
                        },
                    );
                    if let Some(shown) = &shown {
                        engine.select(shown);
                    }
                    view
                });
                self.sync_views(window, cx);
                view
            }
        };
        self.parts.get_mut::<Drops>().carried = Some(Carried {
            view: view.clone(),
            opened,
            shown,
        });
        // The tab is laid out on the next frame; the pointer is already
        // away, so it lifts out at once there.
        let workspace = self.workspace.downgrade();
        let this = cx.entity().downgrade();
        window.on_next_frame(move |window, cx| {
            let carried = workspace
                .update(cx, |workspace, cx| {
                    workspace.carry_view(&view, window.mouse_position(), cx)
                })
                .unwrap_or(false);
            if !carried {
                this.update(cx, |this, cx| this.carry_ended(&view, false, window, cx))
                    .ok();
            }
        });
        true
    }

    /// Trellis let go of the carried tree row (`beginFileDrag`'s finish):
    /// dropped on a target away from the Project panel, the file opens
    /// there; otherwise a tab the drag opened closes again.
    pub(crate) fn carry_ended(
        &mut self,
        view: &str,
        dropped: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let drops = self.parts.get_mut::<Drops>();
        if drops
            .carried
            .as_ref()
            .is_none_or(|carried| carried.view != view)
        {
            return;
        }
        let Some(carried) = drops.carried.take() else {
            return;
        };
        let project_panel = self.placement("project", cx).map(|(_, panel, _)| panel);
        let panel = self.placement(view, cx).map(|(_, panel, _)| panel);
        let cancelled = !dropped || panel.is_none() || panel == project_panel;
        if cancelled && carried.opened {
            self.workspace
                .update(cx, |workspace, cx| workspace.close(&[view.to_string()], cx));
        }
        if let Some(shown) = carried.shown {
            self.engine_do(cx, |engine| engine.select(&shown));
        }
        if !cancelled {
            self.engine_do(cx, |engine| engine.focus(view));
            self.focus_view_content(view, window, cx);
        }
        self.sync_views(window, cx);
    }
}

/// This file's registration as a window part (`parts.rs`).
pub(super) const PART: Part = Part {
    install: |_, _| Box::new(Drops::default()),
    views: &[],
    actions: |element, _| element,
    commands: no_commands,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|name| PathBuf::from(format!("/tmp/{name}")))
            .collect()
    }

    #[test]
    fn a_drop_is_sources_figures_a_mix_or_unsupported() {
        assert_eq!(
            classify(&paths(&["a.tex", "notes.md", "run.py"])),
            DropKind::Source
        );
        assert_eq!(
            classify(&paths(&["plot.PDF", "photo.jpeg"])),
            DropKind::Asset
        );
        assert_eq!(classify(&paths(&["a.tex", "plot.png"])), DropKind::Mixed);
        assert_eq!(
            classify(&paths(&["a.tex", "movie.mov"])),
            DropKind::Unsupported
        );
        assert_eq!(classify(&paths(&["folder"])), DropKind::Unsupported);
        assert_eq!(classify(&[]), DropKind::Unsupported);
    }

    #[test]
    fn an_editor_inserts_figures_only_when_it_takes_them() {
        assert_eq!(editor_take(DropKind::Asset, true), EditorTake::Insert);
        assert_eq!(editor_take(DropKind::Asset, false), EditorTake::Open);
        assert_eq!(editor_take(DropKind::Source, true), EditorTake::Open);
        assert_eq!(editor_take(DropKind::Mixed, true), EditorTake::Refuse);
        assert_eq!(
            editor_take(DropKind::Unsupported, false),
            EditorTake::Refuse
        );
    }
}
