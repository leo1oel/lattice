//! The named workspaces and the presets in action: entering, saving,
//! reverting and adding workspaces, the Writing and Reading presets and
//! focus mode laid over the project's own layout, and that layout saved as
//! it changes and restored when the project opens again
//! (`src/trellis/trellis-workspace.tsx`).

use std::{path::Path, time::Duration};

use gpui::{App, BorrowAppContext as _, Context, Focusable as _, Window};

use super::{
    Shell,
    layout::{self, Arrangement, Preset},
    workspaces::{ActivePreset, ProjectLayout, Workspaces},
};

/// A layout change is saved this long after the last one.
const SAVE_DELAY: Duration = Duration::from_millis(400);

impl Shell {
    /// The project's own layout: the one on screen, or under a preset or
    /// focus mode the one they keep to return to.
    fn own_arrangement(&self, cx: &App) -> Arrangement {
        if let Some(previous) = &self.layout.focus {
            return previous.clone();
        }
        match &self.layout.preset {
            Some(preset) => preset.previous.clone(),
            None => self.current_arrangement(cx),
        }
    }

    /// The workspace's saved arrangement, or the default for a workspace
    /// never used.
    fn workspace_arrangement(&self, id: &str, window: &Window, cx: &App) -> Arrangement {
        Workspaces::global(cx)
            .get(id)
            .and_then(|entry| entry.arrangement.clone())
            .unwrap_or_else(|| Arrangement::default_for(self.room(window)).as_workspace())
    }

    pub(crate) fn refresh_dirty(&mut self, cx: &App) {
        let Some(id) = self.layout.workspace.clone() else {
            self.layout.dirty = false;
            return;
        };
        let saved = Workspaces::global(cx)
            .get(&id)
            .and_then(|entry| entry.arrangement.clone());
        self.layout.dirty = match saved {
            Some(saved) => self.own_arrangement(cx).shape() != saved.shape(),
            None => false,
        };
    }

    pub(super) fn schedule_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.root.is_none() {
            return;
        }
        self.save_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(SAVE_DELAY).await;
            this.update(cx, |this, cx| this.save_layout(cx)).ok();
        }));
    }

    /// Remember the project's layout, its workspace and preset, and where
    /// its documents stand in the workspace.
    pub(crate) fn save_layout(&mut self, cx: &mut Context<Self>) {
        self.save_task = None;
        let Some(root) = self.root.clone() else {
            return;
        };
        let own = self.own_arrangement(cx);
        if let Some(workspace) = &self.layout.workspace {
            self.layout.places.insert(workspace.clone(), own.places());
        }
        let layout = ProjectLayout {
            workspace: self.layout.workspace.clone(),
            arrangement: Some(
                if self.layout.preset.is_some() || self.layout.focus.is_some() {
                    own.clone()
                } else {
                    self.current_arrangement(cx)
                },
            ),
            preset: self.layout.preset.clone(),
            places: self.layout.places.clone(),
            ..ProjectLayout::default()
        };
        cx.update_global::<Workspaces, _>(|library, _| library.save_project(&root, layout));
    }

    /// Lay the window out as the project was left: its saved layout, else
    /// its workspace's arrangement around its main document. False when no
    /// document came back, so the caller opens the main one.
    pub(super) fn restore_layout(
        &mut self,
        root: &Path,
        main: Option<&Path>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let saved = cx.update_global::<Workspaces, _>(|library, _| library.project(root));
        let workspace = saved
            .workspace
            .clone()
            .filter(|id| Workspaces::global(cx).get(id).is_some())
            .unwrap_or_else(|| Workspaces::global(cx).recent());
        self.ensure_workspace_saved(&workspace, window, cx);
        self.layout.workspace = Some(workspace.clone());
        self.layout.places = saved.places.clone();
        self.layout.preset = None;
        self.layout.focus = None;
        Workspaces::update(cx, |library| library.note_used(&workspace));
        let arrangement = match (saved.preset.clone(), saved.arrangement.clone()) {
            (Some(preset), _) => {
                let active = self.active_document(cx);
                let laid =
                    preset
                        .preset
                        .arrange(&preset.previous, active.as_deref(), self.room(window));
                self.layout.preset = Some(preset);
                laid
            }
            (None, Some(arrangement)) => arrangement,
            (None, None) => {
                let documents: Vec<String> = main
                    .map(|main| vec![layout::document_key(root, main)])
                    .unwrap_or_default();
                self.workspace_arrangement(&workspace, window, cx)
                    .with_documents(
                        &documents,
                        documents.first().map(String::as_str),
                        self.layout
                            .places
                            .get(&workspace)
                            .unwrap_or(&Default::default()),
                    )
            }
        };
        self.install(&arrangement, window, cx);
        let documents = self.current_arrangement(cx).documents();
        if let Some(active) = self.active_document(cx) {
            let path = root.join(active);
            if let Some(editor) = self.open_editor(&path, cx) {
                window.focus(&editor.read(cx).editor().focus_handle(cx), cx);
            }
        }
        self.follow_active_document(cx);
        !documents.is_empty()
    }

    /// A workspace never used takes the default arrangement at this
    /// window's size, so the project's layout has something to differ from.
    fn ensure_workspace_saved(&mut self, id: &str, window: &Window, cx: &mut Context<Self>) {
        if Workspaces::global(cx)
            .get(id)
            .is_some_and(|entry| entry.arrangement.is_none())
        {
            let arrangement = Arrangement::default_for(self.room(window)).as_workspace();
            Workspaces::update(cx, |library| library.set_arrangement(id, arrangement));
        }
    }

    /// Enter workspace `id`: the project's documents laid into its
    /// arrangement where they stood there before. Entering the workspace the
    /// project is in returns from a preset or focus mode over it.
    pub(crate) fn switch_workspace(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if Workspaces::global(cx).get(id).is_none() || self.root.is_none() {
            return;
        }
        if self.layout.workspace.as_deref() == Some(id) {
            if self.layout.focus.is_some() {
                self.set_focus_mode(false, window, cx);
            }
            if self.layout.preset.is_some() {
                self.leave_preset(window, cx);
            }
            return;
        }
        let own = self.own_arrangement(cx);
        if let Some(current) = self.layout.workspace.clone() {
            self.layout.places.insert(current, own.places());
        }
        self.layout.preset = None;
        self.layout.focus = None;
        self.ensure_workspace_saved(id, window, cx);
        let documents = own.documents();
        let active = self.active_document(cx);
        let places = self.layout.places.get(id).cloned().unwrap_or_default();
        let arrangement = self.workspace_arrangement(id, window, cx).with_documents(
            &documents,
            active.as_deref(),
            &places,
        );
        self.layout.workspace = Some(id.to_string());
        Workspaces::update(cx, |library| library.note_used(id));
        self.install(&arrangement, window, cx);
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

    /// A new workspace holding the arrangement on screen, right after the
    /// current one, with the project in it and its name in editing.
    pub(crate) fn new_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) -> String {
        let arrangement = self.own_arrangement(cx).as_workspace();
        let after = self.layout.workspace.clone();
        let id = Workspaces::update(cx, |library| {
            library.add("Workspace", Some(arrangement), after.as_deref())
        });
        if let Some(current) = self.layout.workspace.clone() {
            let places = self.own_arrangement(cx).places();
            self.layout.places.insert(current, places);
        }
        self.layout.workspace = Some(id.clone());
        Workspaces::update(cx, |library| library.note_used(&id));
        self.refresh_dirty(cx);
        self.schedule_save(window, cx);
        self.start_rename(&id, window, cx);
        id
    }

    /// Save the project's arrangement (under any preset) to its workspace.
    pub(crate) fn save_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.layout.workspace.clone() else {
            return;
        };
        let arrangement = self.own_arrangement(cx).as_workspace();
        Workspaces::update(cx, |library| library.set_arrangement(&id, arrangement));
        self.refresh_dirty(cx);
        self.schedule_save(window, cx);
        cx.notify();
    }

    /// Load the workspace as it was saved, the open documents placed in it.
    pub(crate) fn revert_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.layout.workspace.clone() else {
            return;
        };
        let own = self.own_arrangement(cx);
        let active = self.active_document(cx);
        let places = self.layout.places.get(&id).cloned().unwrap_or_default();
        self.layout.preset = None;
        self.layout.focus = None;
        let arrangement = self.workspace_arrangement(&id, window, cx).with_documents(
            &own.documents(),
            active.as_deref(),
            &places,
        );
        self.install(&arrangement, window, cx);
    }

    /// Back to the default layout, the documents kept; the workspace itself
    /// is not touched, so the project then differs from it if it was saved
    /// otherwise.
    pub(crate) fn reset_layout(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let own = self.own_arrangement(cx);
        let active = self.active_document(cx);
        self.layout.preset = None;
        self.layout.focus = None;
        let arrangement = Arrangement::default_for(self.room(window)).with_documents(
            &own.documents(),
            active.as_deref(),
            &Default::default(),
        );
        self.install(&arrangement, window, cx);
    }

    /// Lay `preset` over the project's own layout, which is kept to return
    /// to; choosing the preset on screen returns.
    pub(crate) fn set_preset(
        &mut self,
        preset: Preset,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.root.is_none() {
            return;
        }
        if self.layout.preset.as_ref().map(|active| active.preset) == Some(preset) {
            self.leave_preset(window, cx);
            return;
        }
        if self.layout.focus.is_some() {
            self.set_focus_mode(false, window, cx);
        }
        let current = self.current_arrangement(cx);
        let previous = match self.layout.preset.take() {
            Some(active) => layout::return_layout(&active.previous, &current),
            None => current,
        };
        let active = self.active_document(cx);
        let laid = preset.arrange(&previous, active.as_deref(), self.room(window));
        self.layout.preset = Some(ActivePreset { preset, previous });
        self.install(&laid, window, cx);
    }

    pub(crate) fn leave_preset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(active) = self.layout.preset.take() else {
            return;
        };
        let back = layout::return_layout(&active.previous, &self.current_arrangement(cx));
        self.install(&back, window, cx);
    }

    /// Focus mode: the open documents fill the window with the PDF beside
    /// them, the chrome down to the window's controls and a way out; off,
    /// the layout comes back as it was, a preset's included.
    pub(crate) fn set_focus_mode(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        if on == self.layout.focus.is_some() || self.root.is_none() {
            return;
        }
        if on {
            let current = self.current_arrangement(cx);
            let active = self.active_document(cx);
            let laid = Preset::Writing.arrange(&current, active.as_deref(), self.room(window));
            self.layout.focus = Some(current);
            self.install(&laid, window, cx);
        } else if let Some(previous) = self.layout.focus.take() {
            let back = layout::return_layout(&previous, &self.current_arrangement(cx));
            self.install(&back, window, cx);
        }
    }
}
