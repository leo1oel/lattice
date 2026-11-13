//! The window's layout in action, on the Trellis workspace: laying a
//! document out, answering the workspace's events, showing, hiding and
//! closing views where the Tauri app puts them (`trellis-controller.ts`'s
//! `showPanel`, `togglePanel` and `homeOf`), and keeping documents in
//! panels as they open (`use-tab-sync.ts`) and close
//! (`close-document-tab.ts`, `keepDocumentSlot`).

use gpui::{App, Context, Entity, Focusable as _, Window};
use trellis::model::{Edge, LayoutDocument, Placement, close_view};
use trellis::runtime::engine::{OpenOptions, ViewPlacement};
use trellis::{TrellisWorkspace, WorkspaceEvent};

use super::{
    Shell,
    trellis_layout::{
        self, Preset, file_key, filled_slots, keep_document_slot, with_document_panel,
    },
    views::documents_of,
};
use crate::editor_panel::EditorPanel;

impl Shell {
    /// Lay the workspace out as `doc` (tidied: views of unknown types go,
    /// splits close up), with a panel for each of its views.
    pub(crate) fn install(
        &mut self,
        doc: LayoutDocument,
        animate: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let doc = trellis_layout::tidy(&doc);
        self.workspace.update(cx, |workspace, cx| {
            workspace.update_engine(cx, |engine| engine.set_document(doc, animate))
        });
        self.sync_views(window, cx);
        self.last_document = self.document(cx);
        let focus_left = self
            .workspace
            .read(cx)
            .engine()
            .focused_view()
            .is_none_or(|view| self.panel_of_view(view).is_none());
        if focus_left || window.focused(cx).is_none() {
            self.focus_front(window, cx);
        }
        self.refresh_dirty(cx);
        self.schedule_save(window, cx);
        cx.notify();
    }

    /// Change the engine, then answer what it reports.
    pub(crate) fn engine_do<R>(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut trellis::Engine) -> R,
    ) -> R {
        self.workspace
            .update(cx, |workspace, cx| workspace.update_engine(cx, f))
    }

    pub(super) fn on_workspace_event(
        &mut self,
        _: &Entity<TrellisWorkspace>,
        event: &WorkspaceEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            WorkspaceEvent::Changed => self.layout_changed(window, cx),
            WorkspaceEvent::Opened(_) => self.sync_views(window, cx),
            WorkspaceEvent::Closed(view) => self.view_closed(view, window, cx),
            WorkspaceEvent::Focused(Some(view)) => self.view_focused(view, cx),
            WorkspaceEvent::Focused(None) | WorkspaceEvent::Announce(_) => {}
            WorkspaceEvent::FocusContent(view) => self.focus_view_content(view, window, cx),
            WorkspaceEvent::Navigated(_) => cx.notify(),
            WorkspaceEvent::CloseRequested(views) => {
                let views = views.clone();
                self.workspace
                    .update(cx, |workspace, cx| workspace.close(&views, cx));
            }
        }
    }

    /// A committed change (a drag, a resize, a tab chosen): a slot a
    /// document filled leaves, and the project's layout is saved soon.
    fn layout_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // A panel maximized, a group zoomed or a workspace switched can take
        // an island off screen without telling it.
        lattice_webview::check_drawn_after_frame(window, cx);
        let doc = self.document(cx);
        let filled = filled_slots(&doc);
        if !filled.is_empty() {
            self.engine_do(cx, |engine| {
                for slot in &filled {
                    engine.close(slot);
                }
            });
            return;
        }
        // Any arrangement but the one a reset left supersedes undoing it.
        if self
            .reset_undo
            .as_ref()
            .is_some_and(|undo| trellis_layout::layout_shape(&doc) != undo.left)
        {
            self.reset_undo = None;
        }
        self.last_document = doc;
        self.sync_views(window, cx);
        self.forget_closed_pdfs(cx);
        self.refresh_dirty(cx);
        self.follow_active_document(cx);
        self.schedule_save(window, cx);
        cx.notify();
    }

    /// A view closed (its X, its menu, ⌘W): a document's panel keeps an
    /// empty slot when it was the last document there, outside a preset or
    /// focus mode, and the document can be opened again with ⌘⇧T.
    fn view_closed(&mut self, view: &str, window: &mut Window, cx: &mut Context<Self>) {
        // The keyboard in the view that closed goes to the document in
        // front, so the window's commands still reach the shell.
        let had_focus = self
            .panel_of_view(view)
            .is_some_and(|panel| panel.focus_handle(cx).contains_focused(window, cx));
        let record = self.last_document.views.get(view).cloned();
        let key = file_key(record.as_ref());
        if !key.is_empty() {
            if let Some(root) = self.root(cx) {
                self.closed_tabs.push(root.join(&key));
            }
            if self.layout.preset.is_none() && self.layout.focus.is_none() {
                let current = self.document(cx);
                if let Some(kept) = keep_document_slot(&self.last_document, &current, view) {
                    self.engine_do(cx, |engine| engine.set_document(kept, false));
                }
            }
        }
        self.last_document = close_view(&self.last_document, view);
        self.sync_views(window, cx);
        self.forget_closed_pdfs(cx);
        if had_focus || window.focused(cx).is_none() {
            self.focus_front(window, cx);
        }
        cx.notify();
    }

    /// The workspace's focus moved to `view`: a document's editor is the
    /// active one, and the tree marks it; a paper's reader is the one in
    /// front, and Papers marks it.
    fn view_focused(&mut self, view: &str, cx: &mut Context<Self>) {
        let Some(panel) = self.panel_of_view(view) else {
            return;
        };
        self.reader_focused(panel.view().entity_id(), cx);
        if let Ok(editor) = panel.view().downcast::<EditorPanel>() {
            self.active_editor = Some(editor.downgrade());
            let path = editor.read(cx).path().to_path_buf();
            self.file_tree
                .update(cx, |tree, cx| tree.set_current(Some(path), cx));
            self.show_outline(cx);
        }
    }

    /// The keyboard into a view's content (a tab clicked, a key).
    fn focus_view_content(&mut self, view: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.panel_of_view(view) else {
            return;
        };
        match panel.view().downcast::<EditorPanel>() {
            Ok(editor) => window.focus(&editor.read(cx).editor().focus_handle(cx), cx),
            Err(_) => window.focus(&panel.focus_handle(cx), cx),
        }
    }

    /// The keyboard to the document in front, else to the window.
    pub(crate) fn focus_front(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let editor = self
            .active_document(cx)
            .zip(self.root(cx))
            .and_then(|(active, root)| self.open_editor(&root.join(active), cx));
        match self.front_focus(editor.as_ref(), cx) {
            Some(focus) => window.focus(&focus, cx),
            None => window.focus(&self.focus_handle, cx),
        }
    }

    /// Where `view` is now.
    fn placement(&self, view: &str, cx: &App) -> Option<(ViewPlacement, String, bool)> {
        let engine = self.workspace.read(cx).engine();
        let state = engine.view_state(view)?;
        Some((state.placement, state.panel_id.clone(), state.visible))
    }

    /// The panel of the active document, else of any document on screen.
    fn documents_panel(&self, cx: &App) -> Option<String> {
        let doc = self.document(cx);
        let active = self.active_document(cx);
        let mut first = None;
        for (id, view) in &doc.views {
            let key = file_key(Some(view));
            if key.is_empty() {
                continue;
            }
            let Some((placement, panel, _)) = self.placement(id, cx) else {
                continue;
            };
            if placement == ViewPlacement::Hidden {
                continue;
            }
            if active.as_deref() == Some(key.as_str()) {
                return Some(panel);
            }
            first.get_or_insert(panel);
        }
        first
    }

    /// Where a closed panel comes back (`homeOf`): Project and the Agent
    /// share a panel, Papers sits below them, the PDF with the other PDFs'
    /// tabs (else right of the documents), the build log under the
    /// documents, and other tools join the Project or Agent panel; with
    /// those gone, beside the documents.
    pub(crate) fn home_of(&self, kind: &str, cx: &App) -> Placement {
        let docked = |id: &str| {
            self.placement(id, cx)
                .filter(|(placement, ..)| *placement == ViewPlacement::Docked)
                .map(|(_, panel, _)| panel)
        };
        let into = |id: &str| docked(id).map(|into| Placement::Into { into, index: None });
        let near = |id: &str, edge: Edge, share: f64| {
            docked(id).map(|beside| Placement::Beside {
                beside,
                edge,
                share: Some(share),
            })
        };
        let documents = self.documents_panel(cx);
        let beside_documents = |edge: Edge, share: f64| match &documents {
            Some(beside) => Placement::Beside {
                beside: beside.clone(),
                edge,
                share: Some(share),
            },
            None => Placement::Side,
        };
        let any_root_pdf = || {
            self.root_pdfs
                .iter()
                .find_map(|(document, _)| into(&super::views::root_pdf_id(document)))
        };
        match kind {
            "project" => into("agent")
                .or_else(|| near("papers", Edge::Top, 0.62))
                .unwrap_or_else(|| beside_documents(Edge::Left, 0.3)),
            "agent" => into("project")
                .or_else(|| near("papers", Edge::Top, 0.62))
                .unwrap_or_else(|| beside_documents(Edge::Left, 0.3)),
            "papers" => near("project", Edge::Bottom, 0.38)
                .or_else(|| near("agent", Edge::Bottom, 0.38))
                .unwrap_or_else(|| beside_documents(Edge::Left, 0.25)),
            "pdf" => any_root_pdf().unwrap_or_else(|| beside_documents(Edge::Right, 0.42)),
            "build" => beside_documents(Edge::Bottom, 0.25),
            _ => into("agent")
                .or_else(|| into("project"))
                .unwrap_or_else(|| beside_documents(Edge::Right, 0.32)),
        }
    }

    /// Bring a panel on screen (`showPanel`): restore it if hidden, reopen
    /// it where it belongs if it was closed, and focus it (which widens a
    /// framing that hid it). In focus mode the PDF joins the documents; any
    /// other panel asked for ends focus mode first.
    pub(crate) fn show_view(
        &mut self,
        kind: &str,
        focus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.layout.focus.is_some() {
            if kind == "pdf" {
                self.set_focus_pdf(true, window, cx);
                return;
            }
            self.set_focus_mode(false, window, cx);
        }
        // A panel the writer asks for is theirs to keep, even one a preset
        // brought in.
        if let Some(active) = &mut self.layout.preset {
            active.supplied.retain(|id| id != kind);
        }
        match self.placement(kind, cx) {
            Some((ViewPlacement::Hidden, panel, _)) => self.restore_hidden(kind, &panel, cx),
            Some((_, _, visible)) => {
                if focus || !visible {
                    self.engine_do(cx, |engine| engine.focus(kind));
                }
            }
            None => {
                let placement = self.home_of(kind, cx);
                self.engine_do(cx, |engine| {
                    engine.open(
                        kind,
                        OpenOptions {
                            id: Some(kind.into()),
                            placement: Some(placement),
                            focus: Some(focus),
                            ..OpenOptions::default()
                        },
                    )
                });
            }
        }
        cx.notify();
    }

    /// A hidden panel comes back where it was, or where the hidden panels it
    /// sat in or beside will be; one whose place is gone altogether comes
    /// back floating, and then docks where a closed panel would reopen
    /// unless it was hidden from a floating window.
    fn restore_hidden(&mut self, kind: &str, panel: &str, cx: &mut Context<Self>) {
        let floated = self.document(cx).hidden.iter().any(|entry| {
            entry.panel.id == panel
                && matches!(
                    entry.restore,
                    trellis::model::RestoreTarget::Floating { .. }
                )
        });
        self.engine_do(cx, |engine| engine.focus(kind));
        if floated || self.placement(kind, cx).map(|(p, ..)| p) != Some(ViewPlacement::Floating) {
            return;
        }
        let target = match self.home_of(kind, cx) {
            Placement::Into { into, index } => trellis::model::DockTarget::Into { into, index },
            Placement::Beside {
                beside,
                edge,
                share,
            } => trellis::model::DockTarget::Beside {
                beside,
                edge,
                share,
            },
            _ => return,
        };
        self.engine_do(cx, |engine| {
            engine.dock(kind, Some(target));
            engine.focus(kind);
        });
    }

    /// The hidden panels the titlebar offers to bring back, with their
    /// views' titles: in a preset or focus mode, only those holding a
    /// document (the rest come back with the writer's own layout).
    pub(crate) fn hidden_panels(&self, cx: &App) -> Vec<(String, String)> {
        let doc = self.document(cx);
        let engine = self.workspace.read(cx).engine();
        let laid_over = self.layout.preset.is_some() || self.layout.focus.is_some();
        doc.hidden
            .iter()
            .filter(|entry| {
                !laid_over
                    || entry.panel.views.iter().any(|view| {
                        doc.views
                            .get(view)
                            .is_some_and(|record| record.kind == "file")
                    })
            })
            .map(|entry| {
                let titles: Vec<String> = entry
                    .panel
                    .views
                    .iter()
                    .map(|view| engine.title_of(view))
                    .collect();
                (entry.panel.id.clone(), titles.join(", "))
            })
            .collect()
    }

    /// Bring a hidden panel back where it was.
    pub(crate) fn restore_panel(&mut self, panel: &str, cx: &mut Context<Self>) {
        self.engine_do(cx, |engine| engine.restore(panel, None));
    }

    /// Take a view off screen; it keeps its state, hidden.
    pub(crate) fn hide_view(&mut self, id: &str, cx: &mut Context<Self>) {
        self.engine_do(cx, |engine| engine.hide(id, None));
    }

    /// On screen: in the layout, not hidden, and neither behind another tab
    /// nor outside a zoomed-in view.
    pub(crate) fn view_on_screen(&self, kind: &str, cx: &App) -> bool {
        self.placement(kind, cx)
            .is_some_and(|(placement, _, visible)| placement != ViewPlacement::Hidden && visible)
    }

    /// The Panels menu's toggles (`togglePanel`): hide a panel on screen;
    /// one closed, hidden, behind another tab or outside a zoomed-in view
    /// comes forward instead. In focus mode the PDF beside the documents
    /// goes through focus mode's own switch.
    pub(crate) fn toggle_view(&mut self, kind: &str, window: &mut Window, cx: &mut Context<Self>) {
        let on_screen = self.view_on_screen(kind, cx);
        if kind == "pdf" && on_screen && self.layout.focus.is_some() {
            self.set_focus_pdf(false, window, cx);
        } else if on_screen {
            self.hide_view(kind, cx);
        } else {
            self.show_view(kind, true, window, cx);
        }
    }

    /// The panel a new document joins (`use-tab-sync.ts`): in the Reading
    /// layout, its side (papers with the library, the rest with the notes);
    /// otherwise the active document's panel, else an empty document slot
    /// on screen, else any document panel.
    fn document_anchor(&self, key: &str, cx: &App) -> Option<String> {
        let doc = self.document(cx);
        let shown = |id: &str| {
            self.placement(id, cx)
                .filter(|(placement, ..)| *placement != ViewPlacement::Hidden)
                .map(|(_, panel, _)| panel)
        };
        let files = || doc.views.iter().filter(|(_, view)| view.kind == "file");
        if self.layout.preset.as_ref().map(|active| active.preset) == Some(Preset::Reading) {
            let reading = is_reading(key);
            if reading && let Some(library) = shown("papers") {
                return Some(library);
            }
            let side = files()
                .filter(|(_, view)| is_reading(&file_key(Some(view))) == reading)
                .find_map(|(id, _)| shown(id));
            if side.is_some() || !reading {
                return side;
            }
        }
        if let Some(active) = self.active_document(cx)
            && let Some(view) = self.view_of_document(&active, cx)
            && let Some(panel) = shown(&view)
        {
            return Some(panel);
        }
        doc.views
            .iter()
            .filter(|(_, view)| view.kind == "slot")
            .find_map(|(id, _)| shown(id))
            .or_else(|| files().find_map(|(id, _)| shown(id)))
    }

    /// Put document `key` in the layout, or bring its tab forward, and
    /// select it: in the panel documents join, else a panel of its own
    /// between the navigators and the rest of the layout.
    pub(crate) fn place_document(
        &mut self,
        key: &str,
        focus: bool,
        cx: &mut Context<Self>,
    ) -> String {
        if let Some(view) = self.view_of_document(key, cx) {
            self.engine_do(cx, |engine| {
                if focus {
                    engine.focus(&view);
                } else {
                    engine.select(&view);
                }
            });
            return view;
        }
        let Some(panel) = self.document_anchor(key, cx) else {
            let id = trellis::model::uid("file");
            let navigators: Vec<String> = trellis_layout::NAVIGATORS
                .iter()
                .filter_map(|kind| self.placement(kind, cx).map(|(_, panel, _)| panel))
                .collect();
            let doc = with_document_panel(&self.document(cx), &id, key, &navigators, None);
            // Not animated: this is how the first document appears.
            self.engine_do(cx, |engine| {
                engine.set_document(doc, false);
                if focus {
                    engine.focus(&id);
                }
            });
            return id;
        };
        let mut params = trellis::model::Params::new();
        params.insert("key".into(), key.into());
        self.engine_do(cx, |engine| {
            engine.open(
                "file",
                OpenOptions {
                    params: Some(params),
                    placement: Some(Placement::Into {
                        into: panel,
                        index: None,
                    }),
                    focus: Some(focus),
                    ..OpenOptions::default()
                },
            )
        })
    }

    /// The document in front: the editor the writer was last in while its
    /// view is on screen, else the focused view's document, else the first
    /// docked panel's selected document.
    pub(crate) fn active_document(&self, cx: &App) -> Option<String> {
        let doc = self.document(cx);
        let key_of = |view: &str| Some(file_key(doc.views.get(view))).filter(|key| !key.is_empty());
        let engine = self.workspace.read(cx).engine();
        if let Some(editor) = self.active_editor()
            && let Some(view) = self.view_of_editor(&editor)
            && engine.placement_of(&view) != ViewPlacement::Hidden
            && let Some(key) = key_of(&view)
        {
            return Some(key);
        }
        if let Some(key) = engine.focused_view().and_then(key_of) {
            return Some(key);
        }
        trellis::model::panels_of(doc.root.as_ref())
            .into_iter()
            .find_map(|panel| key_of(&panel.selected))
    }

    /// The open documents, in tab order, with the active one.
    pub(crate) fn open_documents(&self, cx: &App) -> (String, Vec<String>) {
        let active = self.active_document(cx).unwrap_or_default();
        (active, documents_of(&self.document(cx)))
    }
}

/// A paper or PDF the Reading layout puts with the Papers library; every
/// other document is written (`isReading`).
pub(crate) fn is_reading(key: &str) -> bool {
    super::papers::is_reader_key(key) || key.to_ascii_lowercase().ends_with(".pdf")
}
