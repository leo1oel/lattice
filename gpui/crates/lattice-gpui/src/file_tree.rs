//! The project folder as a tree, on GPUI Kit's tree component, drawn as the
//! Tauri app's Project panel: 28px rows with each file's own glyph, the open
//! file's row selected.

use std::{
    fs,
    path::{Path, PathBuf},
};

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Window, div, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    menu::PopupMenu,
    tree::{TreeItem, TreeState, tree},
};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, components::TreeRow};

/// What a LaTeX run leaves beside its source, which the Tauri app's tree
/// hides (`LATEX_ARTIFACT_EXTENSIONS` in src-tauri/lattice-core/src/project/tree.rs), and
/// a bare `.gz` with them.
const HIDDEN_EXTENSIONS: &[&str] = &[
    "aux",
    "bbl",
    "bcf",
    "blg",
    "brf",
    "dvi",
    "fdb_latexmk",
    "fls",
    "idx",
    "ilg",
    "ind",
    "lof",
    "log",
    "lot",
    "nav",
    "out",
    "run.xml",
    "snm",
    "synctex",
    "synctex.gz",
    "toc",
    "vrb",
    "xdv",
    "gz",
];
const SKIPPED_DIRS: [&str; 4] = ["node_modules", "target", "__pycache__", "_minted"];
/// A deep or huge folder must not stall opening a project.
const MAX_ENTRIES: usize = 5_000;

pub struct OpenFile(pub PathBuf);

pub struct FileTreePanel {
    root: Option<PathBuf>,
    /// The file open in the editor, whose row is drawn selected.
    current: Option<PathBuf>,
    state: Entity<TreeState>,
    focus_handle: FocusHandle,
}

impl EventEmitter<PanelEvent> for FileTreePanel {}
impl EventEmitter<OpenFile> for FileTreePanel {}

impl FileTreePanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            root: None,
            current: None,
            state: cx.new(|cx| TreeState::new(cx)),
            focus_handle: cx.focus_handle(),
        }
    }

    pub fn set_current(&mut self, path: Option<PathBuf>, cx: &mut Context<Self>) {
        if self.current != path {
            self.current = path;
            cx.notify();
        }
    }

    pub fn set_root(&mut self, root: PathBuf, cx: &mut Context<Self>) {
        self.root = Some(root);
        self.refresh(cx);
    }

    /// Re-read the folder, keeping which folders are expanded.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let expanded = expanded_ids(&self.state, cx);
        let mut budget = MAX_ENTRIES;
        let items = read_dir(&root, &expanded, &mut budget);
        self.state
            .update(cx, |state, cx| state.set_items(items, cx));
        cx.notify();
    }
}

fn expanded_ids(state: &Entity<TreeState>, cx: &App) -> Vec<SharedString> {
    let state = state.read(cx);
    (0..)
        .map_while(|ix| state.entry(ix))
        .filter(|entry| entry.is_folder() && entry.is_expanded())
        .map(|entry| entry.item().id.clone())
        .collect()
}

/// A LaTeX run's leftovers, and a PDF built from a `.tex` beside it, which
/// the PDF panel shows instead.
fn is_build_artifact(path: &Path, name: &str) -> bool {
    if path.extension().is_some_and(|extension| extension == "pdf")
        && path.with_extension("tex").exists()
    {
        return true;
    }
    let name = name.to_ascii_lowercase();
    let stem = name.strip_suffix("-save-error").unwrap_or(&name);
    HIDDEN_EXTENSIONS
        .iter()
        .any(|extension| stem.ends_with(&format!(".{extension}")))
}

fn read_dir(dir: &Path, expanded: &[SharedString], budget: &mut usize) -> Vec<TreeItem> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<(bool, String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let is_dir = entry.file_type().ok()?.is_dir();
            let hidden = name.starts_with('.')
                || (is_dir && SKIPPED_DIRS.contains(&name.as_str()))
                || (!is_dir && is_build_artifact(&path, &name));
            (!hidden).then_some((is_dir, name, path))
        })
        .collect();
    entries.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });

    let mut items = Vec::new();
    for (is_dir, name, path) in entries {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let id: SharedString = path.to_string_lossy().into_owned().into();
        let item = if is_dir {
            let is_expanded = expanded.contains(&id);
            TreeItem::new(id, name)
                .children(read_dir(&path, expanded, budget))
                .expanded(is_expanded)
        } else {
            TreeItem::new(id, name)
        };
        items.push(item);
    }
    items
}

impl Focusable for FileTreePanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for FileTreePanel {
    fn panel_name(&self) -> &'static str {
        "FileTreePanel"
    }

    fn closable(&self, _: &App) -> bool {
        false
    }
}

impl Panel for FileTreePanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some("Project".into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        "Project"
    }

    fn dropdown_menu(
        &mut self,
        menu: PopupMenu,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> PopupMenu {
        let view = cx.entity().downgrade();
        menu.item(
            gpui_kit::component::menu::PopupMenuItem::new("Refresh").on_click(move |_, _, cx| {
                view.update(cx, |tree, cx| tree.refresh(cx)).ok();
            }),
        )
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for FileTreePanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.root.is_none() {
            return div()
                .id("file-tree-empty")
                .track_focus(&self.focus_handle)
                .size_full()
                .px(px(20.))
                .py(px(12.))
                .text_role(TextRole::Body, cx)
                .text_color(cx.palette().text_secondary)
                .child("Open a LaTeX project folder to start")
                .into_any_element();
        }
        let view = cx.entity().downgrade();
        let current = self.current.clone();
        let root = self.root.clone().unwrap_or_default();
        // Measured on the Main window: rows 12px in from both sides, the
        // first 7px under the tab strip.
        div()
            .id("file-tree")
            .track_focus(&self.focus_handle)
            .size_full()
            .pt(px(7.))
            .px(px(12.))
            .child(tree(&self.state, move |ix, entry, selected, _, cx| {
                let item = entry.item();
                let path = PathBuf::from(item.id.as_ref());
                let is_folder = entry.is_folder();
                let row = if is_folder {
                    TreeRow::folder(ix, item.label.clone(), entry.depth(), entry.is_expanded())
                } else {
                    TreeRow::file(ix, item.label.clone(), entry.depth())
                        .selected(selected || current.as_deref() == Some(path.as_path()))
                };
                // Parity regions are named by the path from the project
                // root, as the app's tree names its rows (`data-item-path`).
                let row = match path.strip_prefix(&root) {
                    Ok(relative) if lattice_ui::parity::enabled() => {
                        row.parity(format!("row/{}", relative.to_string_lossy()))
                    }
                    _ => row,
                };
                let view = view.clone();
                row.into_list_item(cx).on_click(move |_, _, cx| {
                    if !is_folder {
                        view.update(cx, |_, cx| cx.emit(OpenFile(path.clone())))
                            .ok();
                    }
                })
            }))
            .into_any_element()
    }
}
