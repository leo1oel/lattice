//! What the writer does around a build, as the Tauri app offers it: stop
//! it, delete the auxiliary files or rebuild clean (the palette, the editor's
//! ⋯ menu and ⇧-click on Build), step through the problems (F8, ⇧F8), and
//! the diagnostics card's actions: install a missing package, apply an
//! explained error's fix, switch the engine back or to pdfLaTeX. Also the
//! TeX doctor and setup, until Settings holds them.

use std::path::PathBuf;

use editor::MultiBufferOffset;
use gpui::{AppContext as _, Context, Focusable as _, Window};
use gpui_kit::component::dock::DockPlacement;
use lattice_core::{
    latex,
    project::{self, ManifestSettings},
};
use lattice_ui::components::ToastLevel;

use super::{
    CleanBuildFiles, CleanRebuild, InstallLatexTools, NextProblem, OpenTexDoctor, PreviousProblem,
    Shell, StopBuild, build::BuildRequest,
};
use crate::{
    build::diagnostics,
    build_panel::BuildAction,
    notices::{self, Notice},
};

impl Shell {
    /// Stop ends the stuck pass and everything waiting behind it: a queued
    /// pass started the moment the stopped one came back and, from the same
    /// inputs, usually hung again.
    pub(super) fn stop_build(&mut self, _: &StopBuild, _: &mut Window, cx: &mut Context<Self>) {
        if self.build_task.is_none() {
            return;
        }
        self.queued_build = None;
        let Some(project) = &self.project else {
            return;
        };
        if let Err(error) = latex::abort(project.read(cx).active_build()) {
            notices::error("Couldn’t stop the build", error, cx);
        }
    }

    /// Delete the build's auxiliary files; never while one runs, which owns
    /// them. No confirmation: every file it removes is one the next build
    /// writes again.
    pub(super) fn clean_build_files(
        &mut self,
        _: &CleanBuildFiles,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        if self.build_task.is_some() || self.cleaning {
            return;
        }
        self.cleaning = true;
        cx.spawn(async move |this, cx| {
            let cleaned = cx
                .background_spawn(async move { latex::clean(&root) })
                .await;
            this.update(cx, |this, cx| {
                this.cleaning = false;
                match cleaned {
                    Ok(_) => {
                        notices::show(Notice::new(ToastLevel::Success, "Build files cleaned"), cx)
                    }
                    Err(error) => notices::error("Couldn’t clean the build files", error, cx),
                }
            })
            .ok();
        })
        .detach();
    }

    /// Delete the auxiliary files, then typeset from scratch. A build under
    /// way owns the files until it settles, so the clean waits in its queue.
    pub(super) fn clean_rebuild(
        &mut self,
        _: &CleanRebuild,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.cleaning {
            return;
        }
        self.run_build(BuildRequest::clean_rebuild(), window, cx);
    }

    /// A build Lattice starts on its own, as after a save, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn build_unattended(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.run_build(BuildRequest::automatic(), window, cx);
    }

    pub(super) fn next_problem(&mut self, _: &NextProblem, _: &mut Window, cx: &mut Context<Self>) {
        self.build_panel
            .update(cx, |panel, cx| panel.cycle(true, cx));
    }

    pub(super) fn previous_problem(
        &mut self,
        _: &PreviousProblem,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.build_panel
            .update(cx, |panel, cx| panel.cycle(false, cx));
    }

    pub(super) fn open_tex_doctor(
        &mut self,
        _: &OpenTexDoctor,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.tex_setup
            .update(cx, |center, cx| center.open_doctor(cx));
    }

    pub(super) fn install_latex_tools(
        &mut self,
        _: &InstallLatexTools,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.tex_setup
            .update(cx, |center, cx| center.open_wizard(cx));
    }

    /// A setup dialog went away, closed by its own outcome as often as by
    /// the writer: focus goes back to the editor, as the Tauri app's modals
    /// hand it back. Left on the dialog that is gone, it would leave the
    /// window's shortcuts reaching nothing.
    pub(super) fn setup_dialog_closed(
        &mut self,
        open: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let closed = self.setup_dialog_open && !open;
        self.setup_dialog_open = open;
        if !closed {
            return;
        }
        match self.active_editor() {
            Some(editor) => {
                let focus = editor.read(cx).editor().focus_handle(cx);
                window.focus(&focus, cx);
            }
            None => window.focus(&self.focus_handle, cx),
        }
    }

    /// The card lives in the PDF panel: a build the writer asked for that
    /// failed opens that panel's dock when it was closed, and the card.
    pub(super) fn bring_build_card_forward(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.build_panel.update(cx, |panel, cx| panel.reveal(cx));
        let pdf = gpui_kit::component::dock::PanelId::from(self.pdf.entity_id());
        let placement = self
            .dock_area
            .read(cx)
            .panel(pdf)
            .map(|_| DockPlacement::Right);
        if let Some(placement) = placement
            && !self.dock_area.read(cx).is_dock_open(placement)
        {
            self.dock_area
                .update(cx, |area, cx| area.toggle_dock(placement, window, cx));
        }
    }

    pub(super) fn on_build_action(
        &mut self,
        action: &BuildAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            BuildAction::Install(file) => {
                let file = file.clone();
                self.tex_setup
                    .update(cx, |center, cx| center.install_dependency(file, None, cx));
            }
            BuildAction::ReplaceToken {
                path,
                line,
                token,
                replacement,
            } => self.replace_token(path.clone(), *line, token, replacement, window, cx),
            BuildAction::SwitchEngine { engine, keep } => {
                self.switch_engine(engine.clone(), *keep, window, cx)
            }
        }
    }

    /// An explained error's fix: open its file at its line and replace the
    /// token there in the editor, so ⌘Z takes it back like typing; then
    /// save and build. A token no longer on its line changes nothing, and
    /// the build reports what is.
    fn replace_token(
        &mut self,
        path: PathBuf,
        line: u32,
        token: &str,
        replacement: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(editor) = self.open_path(path, Some(line), window, cx) else {
            return;
        };
        let zed = editor.read(cx).editor().clone();
        let text = zed.read(cx).text(cx);
        if let Some(range) = diagnostics::replace_token_on_line(&text, line, token) {
            let replacement = replacement.to_string();
            zed.update(cx, |zed, cx| {
                zed.buffer().update(cx, |buffer, cx| {
                    let range = MultiBufferOffset(range.start)..MultiBufferOffset(range.end);
                    buffer.edit([(range, replacement.as_str())], None, cx);
                });
            });
        }
        // Built either way: the card says it is building again to confirm.
        self.run_build(BuildRequest::requested(), window, cx);
    }

    /// Build with `engine` from now on, then build: the card's Switch to
    /// pdfLaTeX, and the undo of a switch the build made on its own.
    fn switch_engine(
        &mut self,
        engine: String,
        keep: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let settings = ManifestSettings {
            engine: Some(engine),
            keep_engine: keep.then_some(true),
            ..ManifestSettings::default()
        };
        match project::update_manifest_settings(&root, settings) {
            Ok(_) => {
                project.update(cx, |project, cx| project.reload_manifest(cx));
                self.run_build(BuildRequest::requested(), window, cx);
            }
            Err(error) => notices::error("Couldn’t change the engine", error, cx),
        }
    }
}
