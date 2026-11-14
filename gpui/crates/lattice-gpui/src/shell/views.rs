//! The workspace's views and the window's panels behind them.
//!
//! The Trellis document names views by id: the singletons by their kind
//! (`project`, `papers`, `agent`, `pdf`, `build`), a document as a `file`
//! view whose `params.key` is its path in the project (an editor, or a PDF
//! viewer for a `.pdf`) or a paper's reader's `paper:<arXiv id>`, another root document's compiled PDF as a
//! `root-pdf` view (`root-pdf:<document>`), and a document panel's empty
//! place as a `slot`. The shell keeps a panel for every view in the
//! document ([`Shell::sync_views`]), in a registry the skin draws from, so
//! a view's content keeps its state wherever the layout moves it.
//!
//! The view types' rules are the Tauri workspace's
//! (`src/trellis/trellis-workspace.tsx`): the navigators, the PDF and the
//! tools are singletons, nothing scales below its minimum size, and each
//! kind has the minimum the Tauri app gives it.

use std::{cell::RefCell, collections::HashMap, rc::Rc, sync::Arc};

use gpui::{App, AppContext as _, Context, Entity, Window};
use gpui_kit::component::dock::{BasePanelView, panel_handle};
use trellis::model::{LayoutDocument, LayoutNode, Scaling, Size, ViewRules};
use trellis::runtime::engine::{NavigationMode, ViewType};
use trellis::runtime::keymap::{Command, keymap_with};

use super::{
    Shell,
    trellis_layout::{self, ROOT_PDF, file_key, param},
};
use crate::{editor_panel::EditorPanel, empty_slot::EmptySlotPanel};

/// The kinds that live once, under their own id.
pub const SINGLETONS: &[&str] = &[
    "project", "papers", "agent", "pdf", "build", "history", "todos",
];

/// The window's panel for each view id.
pub type Registry = Rc<RefCell<HashMap<String, Arc<dyn BasePanelView>>>>;

fn min(width: f64, height: f64) -> Option<Size> {
    Some(Size { width, height })
}

/// The workspace's options: Lattice's view types, free navigation, floats
/// over the whole workspace, and its keymap (`trellis-keymap.ts`: no
/// overview, previous and next tab on ⌘⇧[ and ⌘⇧]).
pub fn engine_options() -> trellis::Options {
    let kind = |singleton: bool, size: Option<Size>| ViewType {
        title: None,
        rules: ViewRules {
            singleton,
            min_size: size,
            scaling: Scaling::Off,
            ..ViewRules::default()
        },
    };
    let mut types = HashMap::new();
    types.insert("project".into(), kind(true, min(140., 120.)));
    types.insert("papers".into(), kind(true, min(180., 120.)));
    types.insert("agent".into(), kind(true, min(220., 240.)));
    types.insert("pdf".into(), kind(true, min(220., 160.)));
    types.insert(ROOT_PDF.into(), kind(false, min(220., 160.)));
    types.insert("file".into(), kind(false, min(180., 140.)));
    types.insert("slot".into(), kind(false, min(180., 140.)));
    types.insert("build".into(), kind(true, min(200., 160.)));
    for tool in [
        "terminal",
        "history",
        "git",
        "comments",
        "overleaf",
        "literature",
        "todos",
        "checklist",
        "start",
    ] {
        types.insert(tool.into(), kind(true, min(200., 160.)));
    }
    trellis::Options {
        types,
        navigation: NavigationMode::Free,
        keymap: keymap_with(&[
            (Command::NavigationOverview, None),
            (Command::TabPrevious, Some("Mod+Shift+[")),
            (Command::TabNext, Some("Mod+Shift+]")),
        ]),
        gap: 6.,
        tabbar_height: 40.,
        ..trellis::Options::default()
    }
}

/// A root document's own PDF tab's view id.
pub fn root_pdf_id(document: &str) -> String {
    format!("{ROOT_PDF}:{document}")
}

impl Shell {
    /// The document on the workspace now.
    pub(crate) fn document(&self, cx: &App) -> LayoutDocument {
        self.workspace.read(cx).engine().document()
    }

    /// The view a panel stands for.
    pub(crate) fn view_of_panel(&self, panel: gpui::EntityId) -> Option<String> {
        self.views
            .borrow()
            .iter()
            .find(|(_, view)| view.view().entity_id() == panel)
            .map(|(id, _)| id.clone())
    }

    /// The view of the document `key`, if one is in the layout.
    pub(crate) fn view_of_document(&self, key: &str, cx: &App) -> Option<String> {
        let doc = self.document(cx);
        doc.views
            .iter()
            .find(|(_, view)| file_key(Some(view)) == key)
            .map(|(id, _)| id.clone())
    }

    /// The document `key`'s tab title, else its file name.
    pub(crate) fn document_title(&self, key: String, cx: &App) -> String {
        let panel = self
            .view_of_document(&key, cx)
            .and_then(|view| self.panel_of_view(&view));
        match panel {
            Some(panel) => lattice_ui::dock::tab_name(&panel, cx).to_string(),
            None => std::path::Path::new(&key)
                .file_name()
                .map_or(key.clone(), |name| name.to_string_lossy().into_owned()),
        }
    }

    /// The view an editor stands for.
    pub(crate) fn view_of_editor(&self, editor: &Entity<EditorPanel>) -> Option<String> {
        self.view_of_panel(editor.entity_id())
    }

    /// The panel behind a singleton's view.
    fn singleton(&self, kind: &str) -> Option<Arc<dyn BasePanelView>> {
        Some(match kind {
            "project" => panel_handle(self.file_tree.clone()),
            "papers" => panel_handle(self.papers.clone()),
            "agent" => panel_handle(self.agent.clone()),
            "pdf" => panel_handle(self.pdf.clone()),
            "build" => panel_handle(self.build_panel.clone()),
            "history" => panel_handle(self.history.clone()),
            "todos" => panel_handle(self.todos.clone()),
            _ => return None,
        })
    }

    /// A panel for every view in the workspace's document, made as needed
    /// (an editor for a document, a viewer for a PDF), and none kept for a
    /// view gone. A document that cannot be opened (its file is gone), or a
    /// root document's PDF with no kept copy, loses its view.
    pub(crate) fn sync_views(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let doc = self.document(cx);
        let mut gone = Vec::new();
        for (id, view) in &doc.views {
            if self.views.borrow().contains_key(id) {
                continue;
            }
            let panel = match view.kind.as_str() {
                kind if SINGLETONS.contains(&kind) => self.singleton(kind),
                "file" => {
                    let key = file_key(Some(view));
                    self.document_panel(&key, window, cx)
                }
                ROOT_PDF => self
                    .root_pdf_panel(&param(view, "document"), window, cx)
                    .map(panel_handle),
                "slot" => Some(panel_handle(cx.new(EmptySlotPanel::new))),
                _ => None,
            };
            match panel {
                Some(panel) => {
                    // The keyboard landing in a view's content (a click, a
                    // jump) focuses its view, as a press on its panel does.
                    let view = id.clone();
                    let watch =
                        cx.on_focus_in(&panel.focus_handle(cx), window, move |this, _, cx| {
                            let focused = this.workspace.read(cx).engine().focused_view()
                                == Some(view.as_str());
                            if !focused {
                                this.engine_do(cx, |engine| engine.focus_view(&view));
                            }
                        });
                    self.view_focus.insert(id.clone(), watch);
                    self.views.borrow_mut().insert(id.clone(), panel);
                }
                None if view.kind == "file" || view.kind == ROOT_PDF => gone.push(id.clone()),
                None => {}
            }
        }
        // A view gone lets go of its panel, which hears of it as it did
        // leaving the dock (an editor writes its edits).
        let gone_panels: Vec<_> = self
            .views
            .borrow()
            .iter()
            .filter(|(id, _)| !doc.views.contains_key(*id))
            .map(|(_, panel)| panel.clone())
            .collect();
        self.views
            .borrow_mut()
            .retain(|id, _| doc.views.contains_key(id));
        self.view_focus.retain(|id, _| doc.views.contains_key(id));
        for panel in gone_panels {
            panel.on_removed(window, cx);
        }
        self.sync_shown(&doc, window, cx);
        self.titles_changed(cx);
        if !gone.is_empty() {
            self.workspace.update(cx, |workspace, cx| {
                workspace.update_engine(cx, |engine| {
                    for id in &gone {
                        engine.close(id);
                    }
                })
            });
        }
    }

    /// Tell each panel when it becomes, or stops being, the selected tab of
    /// a docked or floating panel, as GPUI Kit's tab groups did (an HTML
    /// file's preview island runs only while its tab is shown). A hidden
    /// panel's views are not shown; a panel gone heard `on_removed` instead.
    fn sync_shown(&mut self, doc: &LayoutDocument, window: &mut Window, cx: &mut Context<Self>) {
        let registry = self.views.borrow().clone();
        let now: std::collections::HashMap<gpui::EntityId, Arc<dyn BasePanelView>> =
            trellis_layout::panels_of(doc, false)
                .into_iter()
                .filter_map(|panel| registry.get(&panel.selected))
                .map(|panel| (panel.view().entity_id(), panel.clone()))
                .collect();
        let left: Vec<_> = registry
            .values()
            .filter(|panel| {
                let id = panel.view().entity_id();
                self.shown_panels.contains(&id) && !now.contains_key(&id)
            })
            .cloned()
            .collect();
        let came: Vec<_> = now
            .iter()
            .filter(|(id, _)| !self.shown_panels.contains(id))
            .map(|(_, panel)| panel.clone())
            .collect();
        self.shown_panels = now.keys().copied().collect();
        for panel in left {
            panel.set_active(false, window, cx);
        }
        for panel in came {
            panel.set_active(true, window, cx);
        }
    }

    /// The panel for document `key`: its editor, its PDF viewer, or a
    /// paper's open reader.
    fn document_panel(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Arc<dyn BasePanelView>> {
        if super::papers::is_reader_key(key) {
            return self.reader_of(key, cx).map(panel_handle);
        }
        let path = self.root(cx)?.join(key);
        if !path.is_file() {
            return None;
        }
        if trellis_layout_is_pdf(key) {
            return Some(panel_handle(self.file_pdf_for(path, window, cx)));
        }
        Some(panel_handle(self.editor_for(&path, window, cx)?))
    }

    /// Each view's tab title, as the engine plans the strips and names the
    /// menus with them.
    pub(crate) fn titles_changed(&mut self, cx: &mut Context<Self>) {
        let titles: Vec<(String, String)> = self
            .views
            .borrow()
            .iter()
            .map(|(id, panel)| {
                (
                    id.clone(),
                    lattice_ui::dock::tab_name(panel, cx).to_string(),
                )
            })
            .collect();
        self.workspace.update(cx, |workspace, _| {
            let engine = workspace.engine_mut();
            for (id, title) in titles {
                if engine.title_of(&id) != title {
                    engine.set_live_title(&id, title);
                }
            }
        });
    }

    /// The width the panel holding `view` is drawn at.
    pub fn view_width(&self, view: &str, cx: &App) -> Option<gpui::Pixels> {
        let workspace = self.workspace.read(cx);
        let panel = workspace.engine().view_state(view)?.panel_id.clone();
        workspace
            .panel_bounds(&panel)
            .map(|bounds| bounds.size.width)
    }

    /// Give the top-level column holding `view` `width` px as a drag of its
    /// trailing divider would (the last column's leading one): only its
    /// neighbour gives or takes the room. For the scenarios' sized shots.
    pub fn set_view_width(&mut self, view: &str, width: f32, cx: &mut Context<Self>) {
        let Some(current) = self.view_width(view, cx).map(f32::from) else {
            return;
        };
        let mut doc = self.document(cx);
        let Some(panel) = trellis::model::panel_of_view(&doc, view).map(|p| p.id.clone()) else {
            return;
        };
        let Some(LayoutNode::Split(root)) = &mut doc.root else {
            return;
        };
        let Some(at) = root.children.iter().position(|child| {
            trellis::model::panels_of(Some(child))
                .iter()
                .any(|p| p.id == panel)
        }) else {
            return;
        };
        if root.children.len() < 2 || current <= 0. {
            return;
        }
        let neighbour = if at + 1 < root.children.len() {
            at + 1
        } else {
            at - 1
        };
        // Weights scale with the columns' widths, the gaps aside.
        let per_px = root.weights[at] / f64::from(current);
        let delta = (f64::from(width - current) * per_px).min(root.weights[neighbour] * 0.9);
        root.weights[at] += delta;
        root.weights[neighbour] -= delta;
        self.engine_do(cx, |engine| engine.set_document(doc, false));
    }

    /// The view's panel, if the layout holds it.
    pub(crate) fn panel_of_view(&self, id: &str) -> Option<Arc<dyn BasePanelView>> {
        self.views.borrow().get(id).cloned()
    }
}

/// `path` relative to the project, as a layout names a document.
pub fn document_key(root: &std::path::Path, path: &std::path::Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Whether a document key is a PDF, which opens in a viewer.
pub fn trellis_layout_is_pdf(key: &str) -> bool {
    key.to_ascii_lowercase().ends_with(".pdf")
}

/// The open documents of `doc`, in tab order: docked, floating, then
/// hidden panels, each panel's tabs left to right (the Tauri app's
/// `openTabs`).
pub fn documents_of(doc: &LayoutDocument) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for panel in trellis_layout::panels_of(doc, true) {
        for id in &panel.views {
            let key = file_key(doc.views.get(id));
            if !key.is_empty() && !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    keys
}
