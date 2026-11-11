//! The project folder as a tree, on GPUI Kit's tree component.

use std::{
    fs,
    path::{Path, PathBuf},
};

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Window, div,
};
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Sizable as _,
    button::{Button, ButtonVariants as _},
    dock::{BasePanel, Panel, PanelEvent},
    h_flex,
    list::ListItem,
    tree::{TreeItem, TreeState, tree},
};

/// Build output and editor droppings that only clutter a writing project.
const HIDDEN_EXTENSIONS: [&str; 14] = [
    "aux",
    "log",
    "fls",
    "fdb_latexmk",
    "synctex",
    "gz",
    "out",
    "toc",
    "bbl",
    "blg",
    "xdv",
    "lof",
    "lot",
    "nav",
];
const SKIPPED_DIRS: [&str; 4] = ["node_modules", "target", "__pycache__", "_minted"];
/// A deep or huge folder must not stall opening a project.
const MAX_ENTRIES: usize = 5_000;

pub struct OpenFile(pub PathBuf);

pub struct FileTreePanel {
    root: Option<PathBuf>,
    state: Entity<TreeState>,
    focus_handle: FocusHandle,
}

impl EventEmitter<PanelEvent> for FileTreePanel {}
impl EventEmitter<OpenFile> for FileTreePanel {}

impl FileTreePanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            root: None,
            state: cx.new(|cx| TreeState::new(cx)),
            focus_handle: cx.focus_handle(),
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
                || (!is_dir
                    && path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| HIDDEN_EXTENSIONS.contains(&extension)));
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
    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.root
            .as_ref()
            .and_then(|root| root.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Files".into())
    }

    fn toolbar_buttons(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Option<Vec<Button>> {
        Some(vec![
            Button::new("file-tree-refresh")
                .icon(IconName::RefreshCw)
                .ghost()
                .xsmall()
                .tooltip("Refresh")
                .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
        ])
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
                .p_4()
                .text_sm()
                .text_color(cx.theme().muted_foreground)
                .child("Open a LaTeX project folder to start.")
                .into_any_element();
        }
        let view = cx.entity().downgrade();
        div()
            .id("file-tree")
            .track_focus(&self.focus_handle)
            .size_full()
            .py_1()
            .child(tree(&self.state, move |ix, entry, _selected, _, cx| {
                let item = entry.item();
                let path = PathBuf::from(item.id.as_ref());
                let icon = if entry.is_folder() {
                    if entry.is_expanded() {
                        IconName::FolderOpen
                    } else {
                        IconName::Folder
                    }
                } else if path.extension().is_some_and(|extension| extension == "tex") {
                    IconName::FileText
                } else {
                    IconName::File
                };
                let muted = cx.theme().muted_foreground;
                let view = view.clone();
                let is_folder = entry.is_folder();
                ListItem::new(ix)
                    .pl(gpui::px(12. + entry.depth() as f32 * 14.))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(div().text_color(muted).child(icon))
                            .child(item.label.clone()),
                    )
                    .on_click(move |_, _, cx| {
                        if !is_folder {
                            view.update(cx, |_, cx| cx.emit(OpenFile(path.clone())))
                                .ok();
                        }
                    })
            }))
            .into_any_element()
    }
}
