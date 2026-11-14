//! What the window keeps of SyncTeX between a jump's ask and its answer, as
//! the Tauri app's `use-synctex-navigation.ts` keeps it: which double-click
//! in the PDF is the newest (only its answer lands), and whether a jump to
//! the PDF is being located (the toolbar's locate button spins and waits).

use gpui::{Context, InteractiveElement as _, actions};
use lattice_i18n::t;

use super::{
    Shell,
    commands::{Command, CommandContext, Section},
    parts::Part,
};

actions!(lattice, [TogglePdfWindow, TogglePdfDarkPages]);

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(PdfSync::default()),
    views: &[],
    actions: |element, cx| {
        element
            .on_action(cx.listener(|this, _: &TogglePdfWindow, window, cx| {
                let pdf = this.pdf.clone();
                pdf.update(cx, |pdf, cx| {
                    if pdf.in_window() {
                        pdf.dock(true, window, cx);
                    } else {
                        pdf.detach(window, cx);
                    }
                });
            }))
            .on_action(cx.listener(|_, _: &TogglePdfDarkPages, _, cx| {
                crate::pdf::toggle_dark_pages(cx)
            }))
    },
    commands,
};

/// The PDF's rows in the palette, as the Tauri command table words them.
fn commands(context: &CommandContext, out: &mut Vec<Command>) {
    // The PDF in a window of its own, for a second screen, and back.
    if context.pdf_in_window {
        out.push(Command::new(
            "pdf-window",
            t!("Return the PDF to the workspace"),
            Section::Layout,
            TogglePdfWindow,
        ));
    } else if context.in_project {
        out.push(Command::new(
            "pdf-window",
            t!("Open the PDF in a separate window"),
            Section::Layout,
            TogglePdfWindow,
        ));
    }
    out.push(Command::new(
        "pdf-dark-pages",
        if crate::pdf::dark_pages() {
            t!("Light PDF pages")
        } else {
            t!("Dark PDF pages")
        },
        Section::Layout,
        TogglePdfDarkPages,
    ));
}

#[derive(Default)]
pub(crate) struct PdfSync {
    /// The newest reverse jump's number.
    pub(super) inverse: u64,
    /// The newest forward jump's number, and whether it is under way.
    pub(super) forward: u64,
    pub(super) locating: bool,
}

impl Shell {
    /// Tell every compiled PDF whether Reveal cursor in PDF can jump now
    /// (the caret is in a .tex file) and whether a jump is being located.
    pub(super) fn refresh_reveal(&mut self, cx: &mut Context<Self>) {
        let enabled = self.active_editor().is_some_and(|editor| {
            editor
                .read(cx)
                .relative()
                .to_ascii_lowercase()
                .ends_with(".tex")
        });
        let locating = self.parts.get::<PdfSync>().locating;
        let panels = std::iter::once(self.pdf.clone())
            .chain(self.root_pdfs.iter().map(|(_, panel)| panel.clone()));
        for panel in panels.collect::<Vec<_>>() {
            panel.update(cx, |panel, cx| panel.set_reveal(enabled, locating, cx));
        }
    }

    /// A jump to the PDF starts (`Some`, its number) or the one numbered
    /// `ended` ends.
    pub(super) fn set_locating(&mut self, ended: Option<u64>, cx: &mut Context<Self>) -> u64 {
        let sync = self.parts.get_mut::<PdfSync>();
        match ended {
            None => {
                sync.forward += 1;
                sync.locating = true;
            }
            Some(generation) if generation == sync.forward => sync.locating = false,
            Some(_) => {}
        }
        let generation = sync.forward;
        self.refresh_reveal(cx);
        generation
    }
}

impl Shell {
    /// A double-click in the live PDF at (`x`, `y`) on `page`, with `word`
    /// under it, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn double_click_pdf(
        &mut self,
        page: u32,
        (x, y): (f64, f64),
        word: Option<lattice_editor::latex::synctex_word::SyncTexWord>,
        window: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) {
        self.inverse_sync(None, page, x, y, word, window, cx);
    }

    /// The project's PDFs open in tabs of their own, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn file_pdf_tabs(&self) -> Vec<gpui::Entity<crate::pdf::PdfPanel>> {
        self.file_pdfs.clone()
    }
}
