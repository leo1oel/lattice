//! Opening a project in the window: the project shown is left (its layout
//! recorded, its edits saved), then the opened one is shown in the tree, the
//! window's tabs, its layout and its PDF.

use std::path::PathBuf;

use gpui::{Context, Entity, Window};

use super::{OpenProject, Shell, views, windows};
use crate::project::Project;

impl Shell {
    /// Open a project folder with lattice-core, as the Tauri app opens it,
    /// laid out as the project was left (its documents, its workspace). The
    /// project open before keeps its tab in the window: its layout is
    /// recorded and its edited files saved first.
    pub fn open_project(&mut self, root: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.leave_for(root, None, window, cx);
    }

    /// Show the opened project: in the tree, in the window's tabs, laid out
    /// as it was left (else with its main document open), and its PDF when
    /// one was already built.
    pub(super) fn set_project(
        &mut self,
        project: Entity<Project>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (root, main, pdf) = {
            let project = project.read(cx);
            (
                project.root().to_path_buf(),
                project
                    .main_document()
                    .map(|main| project.root().join(main)),
                project.main_pdf().filter(|pdf| pdf.is_file()),
            )
        };
        if !self.projects.iter().any(|p| p.root == root) {
            let open = OpenProject {
                name: windows::project_display_name(&root),
                root: root.clone(),
            };
            match self
                .root(cx)
                .and_then(|current| self.projects.iter().position(|p| p.root == current))
            {
                Some(ix) => self.projects.insert(ix + 1, open),
                None => self.projects.push(open),
            }
        }
        self.drop_conflict_notice(cx);
        self.references = Default::default();
        self.sheets = Default::default();
        self.conflict = None;
        self.project = Some(project.clone());
        // Sheets over the window hold the project they were opened in.
        self.take_document_overlays(cx);
        // The editors of the project open before go with its arrangement.
        self.editors.clear();
        self.active_editor = None;
        self.queued_build = None;
        self.quiet_builds.cancel();
        self.build_sound = false;
        self.closed_tabs.clear();
        self.forget_visits();
        self.entered_project(&windows::project_display_name(&root), cx);
        self.tex_setup
            .update(cx, |center, _| center.set_root(Some(root.clone())));
        self.refresh_words(cx);
        self.build_target = None;
        self.close_root_pdfs(window, cx);
        self.asset_panels.clear();
        // The documents' panels go with the project they were of.
        let gone: Vec<_> = self
            .views
            .borrow()
            .iter()
            .filter(|(id, _)| !views::SINGLETONS.contains(&id.as_str()))
            .map(|(_, panel)| panel.clone())
            .collect();
        self.views
            .borrow_mut()
            .retain(|id, _| views::SINGLETONS.contains(&id.as_str()));
        self.view_focus
            .retain(|id, _| views::SINGLETONS.contains(&id.as_str()));
        for panel in gone {
            panel.on_removed(window, cx);
        }
        self.reset_undo = None;
        self.live_document = project.read(cx).main_document().map(str::to_string);
        self.refresh_outline(window, cx);
        self.papers
            .update(cx, |papers, cx| papers.set_project(project.clone(), cx));
        self.history
            .update(cx, |history, cx| history.set_project(project.clone(), cx));
        self.tools_project_opened(&project, &root, window, cx);
        self._project_git = Some(cx.subscribe(&project, |this, _, event, cx| match event {
            crate::project::ProjectEvent::GitChanged => this.notice_conflicts(cx),
            // A change on disk is one to push, in live mode (the bridge tells
            // a sync's own writes apart).
            crate::project::ProjectEvent::FilesChanged(paths) => {
                let paths = paths.clone();
                this.overleaf
                    .update(cx, |bridge, cx| bridge.files_changed(paths.as_deref(), cx));
            }
            _ => {}
        }));
        self.overleaf
            .update(cx, |bridge, cx| bridge.set_project(Some(root.clone()), cx));
        self.notice_conflicts(cx);
        self.live_preview
            .update(cx, |live, cx| live.set_project(Some(project.clone()), cx));
        self.file_tree
            .update(cx, |tree, cx| tree.set_project(project, cx));
        self.set_window_title(window, cx);
        let restored = self.restore_layout(&root, main.as_deref(), window, cx);
        if let Some(main) = main.filter(|_| !restored) {
            self.open_path(main, None, window, cx);
        }
        self.label_pdfs(cx);
        self.pdf
            .update(cx, |panel, cx| panel.show_project(root, pdf, window, cx));
        cx.notify();
    }
}
