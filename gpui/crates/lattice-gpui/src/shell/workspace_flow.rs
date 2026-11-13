//! The named workspaces and the presets in action: entering, saving,
//! reverting and adding workspaces, the Writing and Reading presets and
//! focus mode laid over the project's own layout, a reset, and that layout
//! saved as it changes and restored when the project opens again
//! (`src/trellis/trellis-layout-handlers.ts` and `trellis-workspace.tsx`).

use std::{path::Path, time::Duration};

use gpui::{App, BorrowAppContext as _, Context, Window};
use trellis::model::LayoutDocument;

use super::{
    Shell,
    arrange::is_reading,
    trellis_layout::{
        self, Documents, Preset, arrange_documents, arrangement_of, default_layout, enter_focus,
        enter_preset, layout_shape, places_of, return_layout,
    },
    workspaces::{ProjectLayout, Workspaces},
};

/// A layout change is saved this long after the last one.
const SAVE_DELAY: Duration = Duration::from_millis(400);

/// A reset that can still be undone: the layout, preset, focus mode and
/// focused view from before it, and the arrangement the reset left
/// (`left`, a `layout_shape`), which any change of the writer's own
/// supersedes.
pub(crate) struct ResetUndo {
    pub document: LayoutDocument,
    pub preset: Option<trellis_layout::ActivePreset>,
    pub focus: Option<trellis_layout::ActiveFocus>,
    pub focused: Option<String>,
    pub left: String,
}

impl Shell {
    /// The writer's own layout: the one a preset or focus mode keeps to
    /// return to, else the one on screen (`ownLayout`).
    fn own_layout(&self, cx: &App) -> LayoutDocument {
        if let Some(active) = &self.layout.preset {
            return active.previous.clone();
        }
        if let Some(active) = &self.layout.focus {
            return active.previous.clone();
        }
        self.document(cx)
    }

    /// The workspace's saved arrangement; one never saved is the default
    /// layout's (`workspaceArrangement`).
    fn workspace_arrangement(id: &str, cx: &App) -> LayoutDocument {
        Workspaces::global(cx)
            .get(id)
            .and_then(|entry| entry.arrangement.clone())
            .unwrap_or_else(|| arrangement_of(&default_layout()))
    }

    /// Whether the writer's layout is arranged other than its workspace
    /// saved it (`differsFromWorkspace`): the dot on the workspace's tab.
    pub(crate) fn refresh_dirty(&mut self, cx: &App) {
        let Some(id) = self.layout.workspace.clone() else {
            self.layout.dirty = false;
            return;
        };
        let own = arrangement_of(&self.own_layout(cx));
        self.layout.dirty =
            layout_shape(&own) != layout_shape(&Self::workspace_arrangement(&id, cx));
    }

    pub(super) fn schedule_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.project.is_none() {
            return;
        }
        self.save_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(SAVE_DELAY).await;
            this.update(cx, |this, cx| this.save_layout(cx)).ok();
        }));
    }

    /// The layout saved now: the window closing or the app quitting.
    pub(super) fn flush_layout(&mut self, cx: &mut App) {
        self.save_layout(cx);
    }

    /// Remember the project's layout as it is, its preset or focus mode,
    /// its workspace, and where its documents sit in the workspace.
    pub(crate) fn save_layout(&mut self, cx: &mut App) {
        self.save_task = None;
        let Some(root) = self.root(cx) else {
            return;
        };
        if let Some(workspace) = &self.layout.workspace {
            let places = places_of(&self.own_layout(cx));
            self.layout.places.insert(workspace.clone(), places);
        }
        let layout = ProjectLayout {
            workspace: self.layout.workspace.clone(),
            document: Some(self.document(cx)),
            preset: self.layout.preset.clone(),
            focus: self.layout.focus.clone(),
            places: self.layout.places.clone(),
            ..ProjectLayout::default()
        };
        cx.update_global::<Workspaces, _>(|library, _| library.save_project(&root, layout));
    }

    /// Lay the window out as the project was left (`openProjectLayout`):
    /// its saved layout with its preset or focus mode, in the workspace it
    /// was in (else the one last entered); a project without one starts as
    /// that workspace was saved, its main document in the first slot. False
    /// when no document came back, so the caller opens the main one.
    pub(super) fn restore_layout(
        &mut self,
        root: &Path,
        main: Option<&Path>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let saved = cx.update_global::<Workspaces, _>(|library, _| library.project(root));
        let library = Workspaces::global(cx);
        let workspace = saved
            .workspace
            .clone()
            .filter(|id| library.get(id).is_some())
            .unwrap_or_else(|| library.recent());
        // Places in workspaces deleted since are forgotten.
        let places = saved
            .places
            .iter()
            .filter(|(id, _)| library.get(id).is_some())
            .map(|(id, places)| (id.clone(), places.clone()))
            .collect();
        self.layout.workspace = Some(workspace.clone());
        self.layout.places = places;
        Workspaces::update(cx, |library| library.note_used(&workspace));
        let tidy = |doc: &LayoutDocument| trellis_layout::tidy(doc);
        self.layout.preset = saved.preset.map(|mut active| {
            active.previous = tidy(&active.previous);
            active
        });
        self.layout.focus = saved.focus.map(|mut active| {
            active.previous = tidy(&active.previous);
            active
        });
        let document = match saved.document {
            Some(document) => tidy(&document),
            None => {
                // A workspace never saved is the default layout, whose
                // document slot the main document fills.
                let arrangement = Self::workspace_arrangement(&workspace, cx);
                let key = main.map(|main| super::views::document_key(root, main));
                let open: Vec<String> = key.iter().cloned().collect();
                let documents = Documents {
                    active_key: key.as_deref().unwrap_or(""),
                    open_tabs: &open,
                };
                let places = self
                    .layout
                    .places
                    .get(&workspace)
                    .cloned()
                    .unwrap_or_default();
                arrange_documents(&arrangement, &arrangement, documents, &places)
            }
        };
        self.install(document, false, window, cx);
        self.follow_active_document(cx);
        !super::views::documents_of(&self.document(cx)).is_empty()
    }

    /// Animate the workspace to `next`, as a switch.
    fn show_layout(&mut self, next: LayoutDocument, window: &mut Window, cx: &mut Context<Self>) {
        self.install(next, true, window, cx);
    }

    /// `current` out of focus mode: the layout it was entered from, brought
    /// up to date with the documents opened and closed meanwhile.
    fn unfocused(&self, current: &LayoutDocument, cx: &App) -> LayoutDocument {
        let (active, open) = self.open_documents(cx);
        let documents = Documents {
            active_key: &active,
            open_tabs: &open,
        };
        match &self.layout.focus {
            Some(focus) => return_layout(&focus.previous, current, documents, &focus.supplied),
            None => current.clone(),
        }
    }

    /// The project into workspace `id` as it was saved, out of any preset
    /// and focus mode, its documents placed by `places`.
    fn load_workspace(
        &mut self,
        id: &str,
        places_for: impl FnOnce(&mut Self, &LayoutDocument) -> trellis_layout::DocumentPlaces,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.reset_undo = None;
        self.save_layout(cx);
        let (active, open) = self.open_documents(cx);
        let documents = Documents {
            active_key: &active,
            open_tabs: &open,
        };
        let shown = self.unfocused(&self.document(cx), cx);
        let own = match &self.layout.preset {
            Some(preset) => return_layout(&preset.previous, &shown, documents, &preset.supplied),
            None => shown,
        };
        let places = places_for(self, &own);
        let next = arrange_documents(
            &Self::workspace_arrangement(id, cx),
            &own,
            documents,
            &places,
        );
        self.layout.preset = None;
        self.layout.focus = None;
        self.layout.workspace = Some(id.to_string());
        Workspaces::update(cx, |library| library.note_used(id));
        self.show_layout(next, window, cx);
    }

    /// Enter workspace `id`: its saved arrangement, the open documents
    /// re-placed where each sat when the project was last in it.
    /// Entering the workspace the project is in returns from a preset or
    /// focus mode over it.
    pub(crate) fn switch_workspace(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if Workspaces::global(cx).get(id).is_none() || self.project.is_none() {
            return;
        }
        let from = self.layout.workspace.clone();
        if from.as_deref() == Some(id) {
            if self.layout.focus.is_some() {
                self.set_focus_mode(false, window, cx);
            }
            if self.layout.preset.is_some() {
                self.leave_preset(window, cx);
            }
            return;
        }
        let id = id.to_string();
        self.load_workspace(
            &id.clone(),
            move |this, own| {
                if let Some(from) = from {
                    this.layout.places.insert(from, places_of(own));
                }
                this.layout.places.get(&id).cloned().unwrap_or_default()
            },
            window,
            cx,
        );
    }

    pub(crate) fn switch_workspace_at(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = Workspaces::global(cx)
            .list()
            .get(index)
            .map(|entry| entry.id.clone());
        if let Some(id) = id {
            self.switch_workspace(&id, window, cx);
        }
    }

    /// A new workspace starting as the arrangement on screen, a preset's
    /// included, right after the current one; the project moves into it
    /// without anything moving, and its name is in editing.
    pub(crate) fn new_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) -> String {
        self.reset_undo = None;
        self.save_layout(cx);
        if self.layout.focus.is_some() {
            let back = self.unfocused(&self.document(cx), cx);
            self.layout.focus = None;
            self.show_layout(back, window, cx);
        }
        let arrangement = arrangement_of(&self.document(cx));
        let after = self.layout.workspace.clone();
        let id = Workspaces::update(cx, |library| {
            library.add("Workspace", Some(arrangement), after.as_deref())
        });
        self.layout.preset = None;
        self.layout.workspace = Some(id.clone());
        Workspaces::update(cx, |library| library.note_used(&id));
        self.refresh_dirty(cx);
        self.schedule_save(window, cx);
        self.start_rename(&id, window, cx);
        id
    }

    /// Save: the arrangement under any preset becomes the workspace's.
    pub(crate) fn save_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.layout.workspace.clone() else {
            return;
        };
        let arrangement = arrangement_of(&self.own_layout(cx));
        Workspaces::update(cx, |library| library.set_arrangement(&id, arrangement));
        self.refresh_dirty(cx);
        self.schedule_save(window, cx);
        cx.notify();
    }

    /// Revert: the workspace as saved, the open documents kept where they
    /// are when it has their panels.
    pub(crate) fn revert_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.layout.workspace.clone() else {
            return;
        };
        if Workspaces::global(cx).get(&id).is_some() {
            self.load_workspace(&id, |_, own| places_of(own), window, cx);
        }
    }

    /// Reset: the default layout with its document panel between the
    /// navigators and the PDF, the open documents in it; the workspace
    /// itself is untouched. The layout before it can be brought back
    /// (`undo_reset_layout`) until the writer changes the arrangement.
    pub(crate) fn reset_layout(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let before = ResetUndo {
            document: self.document(cx),
            preset: self.layout.preset.take(),
            focus: self.layout.focus.take(),
            focused: self
                .workspace
                .read(cx)
                .engine()
                .focused_view()
                .map(str::to_string),
            left: String::new(),
        };
        let (active, open) = self.open_documents(cx);
        let documents = Documents {
            active_key: &active,
            open_tabs: &open,
        };
        let arrangement = arrangement_of(&default_layout());
        let next = arrange_documents(
            &arrangement,
            &before.document,
            documents,
            &Default::default(),
        );
        self.show_layout(next, window, cx);
        let left = layout_shape(&self.document(cx));
        self.reset_undo = Some(ResetUndo { left, ..before });
        let shell = cx.entity().downgrade();
        let undo = crate::notices::NoticeAction::new("Undo", move |window, cx| {
            shell
                .update(cx, |shell, cx| shell.undo_reset_layout(window, cx))
                .ok();
        });
        crate::notices::show(
            crate::notices::Notice::new(lattice_ui::components::ToastLevel::Info, "Layout reset")
                .key("trellis-layout-reset")
                .action(undo),
            cx,
        );
    }

    /// Undo the last reset: the layout from before it, brought up to date
    /// with what is open now, in the preset or focus mode it was in, with
    /// the writer's view focused again if it is still on screen.
    pub(crate) fn undo_reset_layout(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(undo) = self.reset_undo.take() else {
            return;
        };
        if layout_shape(&self.document(cx)) != undo.left {
            return;
        }
        let (active, open) = self.open_documents(cx);
        let documents = Documents {
            active_key: &active,
            open_tabs: &open,
        };
        let next =
            trellis_layout::undo_reset(&undo.document, &self.document(cx), documents, &|_| false);
        self.layout.preset = undo.preset;
        self.layout.focus = undo.focus;
        self.show_layout(next, window, cx);
        if let Some(focused) = undo.focused {
            self.engine_do(cx, |engine| engine.focus(&focused));
        }
    }

    /// Lay `preset` over the writer's own layout, which is kept to return
    /// to; choosing the preset on screen returns. The document the preset
    /// is for (the source to write, the paper to read) becomes the active
    /// one.
    pub(crate) fn set_preset(
        &mut self,
        preset: Preset,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.project.is_none() {
            return;
        }
        let current = self.layout.preset.clone();
        if current.as_ref().map(|active| active.preset) == Some(preset)
            && self.layout.focus.is_none()
        {
            self.leave_preset(window, cx);
            return;
        }
        self.reset_undo = None;
        let (active, open) = self.open_documents(cx);
        let documents = Documents {
            active_key: &active,
            open_tabs: &open,
        };
        let document = self.unfocused(&self.document(cx), cx);
        self.layout.focus = None;
        if current.as_ref().map(|active| active.preset) == Some(preset) {
            self.show_layout(document, window, cx);
            return;
        }
        let (next, entered) =
            enter_preset(preset, &document, current.as_ref(), documents, &is_reading);
        self.layout.preset = Some(entered);
        self.show_layout(next, window, cx);
        let lead = match preset {
            Preset::Writing => "panel-writing",
            Preset::Reading => "panel-reading",
        };
        let doc = self.document(cx);
        let selected = trellis::model::panels_of(doc.root.as_ref())
            .into_iter()
            .find(|panel| panel.id == lead)
            .map(|panel| panel.selected.clone());
        if let Some(view) = selected
            && let Some(editor) = self.panel_of_view(&view).and_then(|panel| {
                panel
                    .view()
                    .downcast::<crate::editor_panel::EditorPanel>()
                    .ok()
            })
        {
            self.active_editor = Some(editor.downgrade());
            self.follow_active_document(cx);
        }
    }

    /// Back to the writer's own layout from a preset.
    pub(crate) fn leave_preset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(active) = self.layout.preset.take() else {
            return;
        };
        let (key, open) = self.open_documents(cx);
        let documents = Documents {
            active_key: &key,
            open_tabs: &open,
        };
        let document = self.unfocused(&self.document(cx), cx);
        self.layout.focus = None;
        let back = return_layout(&active.previous, &document, documents, &active.supplied);
        self.show_layout(back, window, cx);
    }

    /// Focus mode: the open documents in one panel, the PDF beside them
    /// when the writer last asked for it, over whatever is on screen;
    /// leaving it brings that back. The keyboard goes to the document
    /// either way.
    pub(crate) fn set_focus_mode(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        if on == self.layout.focus.is_some() || self.project.is_none() {
            return;
        }
        let pdf = on.then(|| Workspaces::global(cx).focus_pdf());
        self.focus(pdf, window, cx);
    }

    /// Show or hide the PDF beside the documents in focus mode, entering it
    /// when it is off; the choice is remembered for every project.
    pub(crate) fn set_focus_pdf(&mut self, pdf: bool, window: &mut Window, cx: &mut Context<Self>) {
        Workspaces::update(cx, |library| library.set_focus_pdf(pdf));
        self.focus(Some(pdf), window, cx);
    }

    /// Focus mode on with or without the PDF (`Some`), or off.
    fn focus(&mut self, pdf: Option<bool>, window: &mut Window, cx: &mut Context<Self>) {
        let current = self.layout.focus.clone();
        if let (Some(pdf), Some(current)) = (pdf, &current)
            && current.pdf == pdf
        {
            return;
        }
        self.reset_undo = None;
        let (active, open) = self.open_documents(cx);
        let documents = Documents {
            active_key: &active,
            open_tabs: &open,
        };
        match pdf {
            Some(pdf) => {
                let (next, entered) = enter_focus(
                    &self.document(cx),
                    current.as_ref(),
                    documents,
                    &is_reading,
                    pdf,
                );
                self.layout.focus = Some(entered);
                self.show_layout(next, window, cx);
            }
            None => {
                let next = self.unfocused(&self.document(cx), cx);
                self.layout.focus = None;
                self.show_layout(next, window, cx);
            }
        }
        self.focus_front(window, cx);
    }
}
