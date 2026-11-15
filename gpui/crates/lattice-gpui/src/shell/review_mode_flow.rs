//! The window's side of Track changes (`crate::history::review_mode`): the
//! titlebar's toggle (`src/canvas/canvas-toolbar.tsx`, `use-canvas-toolbar.tsx`),
//! which turns review mode on with the open file's text as it is on screen
//! and asks before turning it off; and the PDF panel, which shows the PDF
//! with the changes marked while review mode wants it (`project-pdf-panel.tsx`):
//! the marked PDF in place of the paper's own once it is made, the "Marking
//! changes…" pill while it builds, and the reason when it could not be made.
//!
//! The PDF in its own window shows the paper's own PDF, as the Tauri app's
//! does, and a double-click on the marked PDF jumps nowhere: its SyncTeX is
//! the marked build's, not the paper's.

use std::path::PathBuf;

use gpui::{App, AppContext as _, Context, Entity, Window};
use lattice_i18n::t;
use lattice_ui::{
    Icon,
    components::{IconButton, Surface},
};

use super::{
    Shell,
    parts::{Part, no_commands},
};
use crate::history::review_mode::{
    marked_pdf::MarkedPdf,
    store::{self, ReviewModes},
};

pub(super) const PART: Part = Part {
    install: |window, cx| Box::new(Shell::install_review_mode(window, cx)),
    views: &[],
    actions: |element, _| element,
    commands: no_commands,
};

pub(crate) struct ReviewFlow {
    marked: Entity<MarkedPdf>,
    /// The marked PDF the panel shows now, if it shows one.
    opened: Option<PathBuf>,
    /// Builds of the paper seen, so the marked PDF follows each.
    builds: usize,
    /// The project the titlebar last drew the toggle for, to look again on
    /// a switch.
    root: std::cell::RefCell<Option<PathBuf>>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl Shell {
    fn install_review_mode(window: &mut Window, cx: &mut Context<Self>) -> ReviewFlow {
        let modes = store::store(cx);
        let marked = cx.new(|_| MarkedPdf::default());
        let subscriptions = vec![
            cx.observe_in(&modes, window, |this, _, window, cx| this.sync_marked_pdf(window, cx)),
            cx.observe_in(&marked, window, |this, _, window, cx| this.show_marked_pdf(window, cx)),
        ];
        ReviewFlow {
            marked,
            opened: None,
            builds: 0,
            root: Default::default(),
            _subscriptions: subscriptions,
        }
    }

    fn review_modes(&self, cx: &mut App) -> Entity<ReviewModes> {
        let _ = self;
        store::store(cx)
    }

    /// Whether review mode is on in the open project.
    pub(crate) fn reviewing(&self, cx: &App) -> bool {
        let Some(root) = self.root(cx) else {
            return false;
        };
        store::try_store(cx).is_some_and(|store| store.read(cx).active(&root))
    }

    /// The titlebar's Track changes, or Stop tracking changes while it is on.
    pub(crate) fn review_button(&self, window: &mut Window, cx: &mut Context<Self>) -> IconButton {
        let root = self.root(cx);
        if let Some(root) = &root {
            let modes = self.review_modes(cx);
            modes.update(cx, |modes, cx| modes.ensure(root, cx));
        }
        // A project switched to whose review mode was read before tells no
        // one: look at it again once this frame is drawn.
        let seen = self.parts.get::<ReviewFlow>().root.replace(root.clone());
        if seen != root {
            cx.defer_in(window, |this, window, cx| this.sync_marked_pdf(window, cx));
        }
        let reviewing = self.reviewing(cx);
        IconButton::new("track-changes", Icon::FILE_PEN)
            .surface(Surface::Titlebar)
            .on(reviewing)
            .tooltip(if reviewing {
                t!("Stop tracking changes")
            } else {
                t!("Track changes")
            })
            .disabled(root.is_none())
            .on_click(cx.listener(|shell, _, _, cx| shell.toggle_review_mode(cx)))
    }

    /// Turn review mode on, with the open file's unsaved text as its base,
    /// or ask before turning it off.
    pub(crate) fn toggle_review_mode(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        if self.reviewing(cx) {
            store::confirm_stop(root, cx);
            return;
        }
        let open = self.active_editor().map(|editor| {
            let editor = editor.read(cx);
            (editor.relative().to_string(), editor.review_text(cx))
        });
        let modes = self.review_modes(cx);
        modes.update(cx, |modes, cx| modes.start(&root, open, cx));
    }

    /// A build of the paper finished: the marked PDF follows it.
    pub(super) fn review_pdf_built(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.parts.get_mut::<ReviewFlow>().builds += 1;
        self.sync_marked_pdf(window, cx);
    }

    /// Whether the PDF panel shows the marked PDF rather than the paper's.
    pub(crate) fn shows_marked_pdf(&self) -> bool {
        self.parts.get::<ReviewFlow>().opened.is_some()
    }

    /// The marked PDF could not be made: the panel says why.
    pub(crate) fn marked_pdf_failed(&self, cx: &App) -> bool {
        self.pdf.read(cx).marking_failed()
    }

    /// Ask for the marked PDF while review mode wants it in this project's
    /// docked PDF panel, or stop asking.
    fn sync_marked_pdf(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let wanted = self.root(cx).filter(|_| !self.pdf.read(cx).in_window()).and_then(|root| {
            let store = store::try_store(cx)?;
            let store = store.read(cx);
            store.marked(&root).then(|| {
                let revision = store.revision(&root);
                (root, revision, self.parts.get::<ReviewFlow>().builds)
            })
        });
        let marked = self.parts.get::<ReviewFlow>().marked.clone();
        marked.update(cx, |marked, cx| marked.want(wanted, cx));
        self.show_marked_pdf(window, cx);
    }

    /// Put the marked PDF in the panel once made, and the paper's own back
    /// when it is not wanted or could not be made.
    fn show_marked_pdf(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let marked = self.parts.get::<ReviewFlow>().marked.clone();
        let (shown, building, error) = {
            let marked = marked.read(cx);
            (marked.shown().map(PathBuf::from), marked.building(), marked.error())
        };
        self.pdf
            .update(cx, |panel, cx| panel.set_marking(building, error, cx));
        let opened = self.parts.get::<ReviewFlow>().opened.clone();
        if shown == opened {
            return;
        }
        self.parts.get_mut::<ReviewFlow>().opened = shown.clone();
        match shown {
            Some(path) => self.pdf.update(cx, |panel, cx| panel.open(path, window, cx)),
            None => {
                let paper = self
                    .root(cx)
                    .zip(self.live_document.clone())
                    .map(|(root, document)| root.join(document).with_extension("pdf"))
                    .filter(|pdf| pdf.is_file());
                self.pdf.update(cx, |panel, cx| match paper {
                    Some(pdf) => panel.open(pdf, window, cx),
                    None => panel.close(window, cx),
                });
            }
        }
    }
}
