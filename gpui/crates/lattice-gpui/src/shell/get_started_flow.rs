//! Get started in the window (`crate::get_started`): the checklist as a
//! tool panel, what it asks of the window, the "Show me" ring over the
//! workspace, and the places in the window where its steps happen.
//!
//! It comes with the sample: opening the tutorial shows it, beside Project
//! (`revealTool`'s rule for it: it stands beside the document, not as a
//! tab of its panel), and another project's layout does not keep it.

use std::path::Path;
use std::time::Instant;

use gpui::{AppContext as _, Context, Entity, IntoElement as _, Task, Window, actions, deferred};
use trellis::runtime::engine::{OpenOptions, ViewPlacement};

use super::Shell;
use crate::get_started::{
    Host, Keys, SAMPLE_MANUSCRIPT, Step, TUTORIAL_VENUE, fill, has_own_title,
    panel::{GetStartedEvent, GetStartedPanel},
    progress, show_me, steps, title_line,
};

actions!(lattice, [ShowGetStarted]);

/// The ring's draw priority: above the floating panels, below the
/// window's dialogs (`layers`).
const RING_PRIORITY: usize = super::layers::FLOATING_PRIORITY + 1;

pub(crate) struct GetStarted {
    pub(crate) panel: Entity<GetStartedPanel>,
    /// The step whose place the ring is on, and since when.
    showing: Option<(Step, Instant)>,
    /// The tutorial is opening: the checklist comes with it.
    pending: bool,
    _ring_timer: Option<Task<()>>,
    /// Escape, heard wherever the keyboard is while the ring is up.
    _escape: Option<gpui::Subscription>,
}

impl GetStarted {
    /// The step whose place the ring is on, while it is up.
    pub(crate) fn showing(&self) -> Option<Step> {
        self.showing.map(|(step, _)| step)
    }
}

impl Shell {
    pub(super) fn get_started_panel(window: &mut Window, cx: &mut Context<Self>) -> GetStarted {
        let panel = cx.new(GetStartedPanel::new);
        cx.subscribe_in(&panel, window, |this, _, event, window, cx| {
            this.on_get_started_event(event, window, cx)
        })
        .detach();
        GetStarted {
            panel,
            showing: None,
            pending: false,
            _ring_timer: None,
            _escape: None,
        }
    }

    /// The tutorial is about to open: show the checklist once it has.
    pub(super) fn get_started_with_tutorial(&mut self) {
        self.get_started.pending = true;
    }

    /// Bring the checklist on screen: beside Project the first time, where
    /// the writer put it after.
    pub(crate) fn open_get_started(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.project.is_none() {
            return;
        }
        if self.layout.focus.is_some() {
            self.set_focus_mode(false, window, cx);
        }
        match self.placement("start", cx) {
            Some((ViewPlacement::Hidden, ..)) => self.show_view("start", true, window, cx),
            Some(_) => self.engine_do(cx, |engine| engine.focus("start")),
            None => {
                let placement = self.home_of("start", cx);
                self.engine_do(cx, |engine| {
                    engine.open(
                        "start",
                        OpenOptions {
                            id: Some("start".into()),
                            placement: Some(placement),
                            focus: Some(true),
                            ..OpenOptions::default()
                        },
                    )
                });
            }
        }
        self.get_started
            .panel
            .update(cx, |panel, cx| panel.shown(cx));
        cx.notify();
    }

    /// A project opened and laid out: the writer's own marks the last step
    /// and leaves the sample's checklist out of its layout; the sample
    /// opened as the tutorial shows it.
    pub(super) fn get_started_project_opened(
        &mut self,
        venue: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let pending = std::mem::take(&mut self.get_started.pending);
        if venue != TUTORIAL_VENUE {
            progress::mark(Step::Own, cx);
            if self.placement("start", cx).is_some() {
                self.engine_do(cx, |engine| engine.close("start"));
            }
            return;
        }
        if pending {
            self.open_get_started(window, cx);
        }
    }

    /// A build succeeded: in the sample, under a title of the writer's own,
    /// the build step is done.
    pub(super) fn get_started_built(&mut self, cx: &mut Context<Self>) {
        let Some(project) = &self.project else { return };
        let project = project.read(cx);
        if project.manifest().venue != TUTORIAL_VENUE {
            return;
        }
        let file = project.root().join(SAMPLE_MANUSCRIPT);
        if std::fs::read_to_string(file).is_ok_and(|text| has_own_title(&text)) {
            progress::mark(Step::Build, cx);
        }
    }

    /// A build found no TeX: with the checklist on screen its first step
    /// reports it, from a fresh check, instead of setup landing on it.
    pub(super) fn missing_tex(&mut self, cx: &mut Context<Self>) {
        let shown = self.view_on_screen("start", cx);
        self.tex_setup.update(cx, |center, cx| {
            if shown {
                center.recheck_for_missing_tex(cx);
            } else {
                center.open_for_missing_tex(cx);
            }
        });
    }

    fn on_get_started_event(
        &mut self,
        event: &GetStartedEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            GetStartedEvent::ShowMe(step) => self.show_me(*step, window, cx),
            GetStartedEvent::InstallLatex => {
                self.tex_setup
                    .update(cx, |center, cx| center.open_wizard(cx));
            }
            GetStartedEvent::NewProject => self.open_new_project(window, cx),
            GetStartedEvent::OpenFolder => self.open_folder(false, window, cx),
            GetStartedEvent::FromOverleaf => self.open_overleaf_picker(window, cx),
            GetStartedEvent::OpenSettings(tab) => self.open_settings(Some(*tab), window, cx),
        }
    }

    /// Bring up the place `step` is about, without taking the keyboard
    /// from where the writer is unless a file opens, and ring it.
    fn show_me(&mut self, step: Step, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else { return };
        let manuscript = root.join(SAMPLE_MANUSCRIPT);
        match step {
            Step::Build => {
                let line = std::fs::read_to_string(&manuscript)
                    .ok()
                    .and_then(|text| title_line(&text));
                self.open_path(manuscript, line, window, cx);
            }
            Step::Cite => {
                if self.manuscript_panel(&root, cx).is_none() {
                    self.open_path(manuscript, None, window, cx);
                }
            }
            Step::Jump => self.show_view("pdf", false, window, cx),
            Step::Agent => self.show_view("agent", false, window, cx),
            Step::Latex | Step::Own => return,
        }
        let started = Instant::now();
        self.get_started.showing = Some((step, started));
        self.get_started._ring_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(show_me::SHOW_ME).await;
            this.update(cx, |this, cx| {
                if this
                    .get_started
                    .showing
                    .is_some_and(|(_, at)| at == started)
                {
                    this.get_started.showing = None;
                    cx.notify();
                }
            })
            .ok();
        }));
        self.get_started._escape = Some(cx.observe_keystrokes(|this, event, _, cx| {
            if event.keystroke.key == "escape" && this.get_started.showing.take().is_some() {
                cx.notify();
            }
        }));
        cx.notify();
    }

    /// The panel the sample's manuscript is shown in, when it is the view
    /// in front there.
    pub(crate) fn manuscript_panel(&self, root: &Path, cx: &gpui::App) -> Option<String> {
        // As `open_path` keys it: by the file's canonical path.
        let path = root.join(SAMPLE_MANUSCRIPT);
        let path = path.canonicalize().unwrap_or(path);
        let key = super::views::document_key(root, &path);
        let view = self.view_of_document(&key, cx)?;
        self.shown_panel(&view, cx)
    }

    /// The panel holding `view`, when `view` is the one it shows.
    fn shown_panel(&self, view: &str, cx: &gpui::App) -> Option<String> {
        match self.placement(view, cx)? {
            (ViewPlacement::Hidden, ..) | (_, _, false) => None,
            (_, panel, true) => Some(panel),
        }
    }

    /// The ring over the place being shown, while it is on screen, its
    /// step not yet done, and no dialog is up.
    pub(super) fn show_me_ring(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        let (step, _) = self.get_started.showing?;
        if progress::global_read(cx).is_some_and(|progress| progress.is_done(step)) {
            return None;
        }
        if self.dialog_open(cx) {
            return None;
        }
        let panel = match step {
            Step::Build | Step::Cite => self.manuscript_panel(&self.root(cx)?, cx),
            Step::Jump => self.shown_panel("pdf", cx),
            Step::Agent => self.shown_panel("agent", cx),
            Step::Latex | Step::Own => None,
        }?;
        let bounds = self.workspace.read(cx).panel_bounds(&panel)?;
        let bounds = show_me::visible(
            bounds,
            gpui::Bounds::new(gpui::Point::default(), window.viewport_size()),
        )?;
        let host = Host::current();
        let hint = steps(host)
            .into_iter()
            .find(|text| text.step == step)
            .and_then(|text| text.hint)?;
        let hint = fill(hint, &Keys::of(host));
        let this = cx.entity().downgrade();
        let ring = show_me::ring(
            bounds,
            hint,
            move |_, cx| {
                this.update(cx, |this, cx| {
                    this.get_started.showing = None;
                    cx.notify();
                })
                .ok();
            },
            cx,
        );
        Some(
            deferred(ring)
                .with_priority(RING_PRIORITY)
                .into_any_element(),
        )
    }
}
