//! The shell's side of the PDFs: the live PDF and its separate window, a tab
//! for each other root document built (`src/trellis/compiled-pdf-tabs.ts`),
//! a PDF of the project opened from the tree, and SyncTeX into and out of
//! each.
//!
//! The live PDF panel shows the build's PDF. When a build makes another
//! root document the live one, the two trade places: the document leaving
//! gets a tab of its own where the live tab stood, showing the copy this
//! machine last built of it (lattice-core's kept PDF, never the file beside
//! the document, which a sync may have replaced), and the arriving
//! document's own tab, if it had one, closes. Only a build the writer asked
//! for brings the live tab to the front; any other build leaves the reader
//! on the document they were reading.

use std::path::PathBuf;

use gpui::{AppContext as _, Context, Entity, Window};
use lattice_core::latex;
use lattice_i18n::t;
use trellis::model::{Placement, panel_of_view};
use trellis::runtime::engine::OpenOptions;

use super::{Shell, build::BuildRequest, trellis_layout::ROOT_PDF, views::root_pdf_id};
use crate::{
    notices,
    pdf::{OutlineState, PdfEvent, PdfPanel, PdfPanelKind, pdf_tab_label},
};

impl Shell {
    pub(super) fn on_pdf_event(
        &mut self,
        _: &Entity<PdfPanel>,
        event: &PdfEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            PdfEvent::SourceAt {
                document,
                page,
                x,
                y,
            } => self.inverse_sync(document.clone(), *page, *x, *y, window, cx),
            PdfEvent::RevealCursor { document: None } => {
                self.forward_sync(&super::ForwardSync, window, cx)
            }
            PdfEvent::RevealCursor {
                document: Some(document),
            } => self.forward_sync_in(document.clone(), window, cx),
            PdfEvent::Build { document } => {
                self.build_target = document.clone();
                self.run_build(BuildRequest::requested(), window, cx);
            }
            // An Outline row: the line in the editor, then the same place in
            // the PDF, as a jump from the caret makes it.
            PdfEvent::Outline { path, line } => self.jump_to_heading(path, *line, window, cx),
            // In its own window, the PDF's panel stays where it is and shows
            // its placeholder, with the way back, as the Tauri app's does.
            PdfEvent::Detached | PdfEvent::Docked => cx.notify(),
        }
    }

    /// A build left `document`'s PDF: it is the live one now. `requested`
    /// when the writer asked for the build, which brings the live tab to the
    /// front.
    pub(super) fn show_built_pdf(
        &mut self,
        document: String,
        requested: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let previous = self.live_document.replace(document.clone());
        let live_in_front = self.in_front("pdf", cx);
        // The PDF in its own window shows the build there: the panel's tabs
        // stay as they are.
        let in_window = self.pdf.read(cx).in_window();
        let mut left = None;
        if let Some(previous) = previous.filter(|previous| *previous != document)
            && !in_window
            && !self.root_pdfs.iter().any(|(open, _)| *open == previous)
        {
            left = self.add_root_pdf(previous, window, cx);
        }
        // The arriving document's own tab goes: the live tab shows it now.
        let own_in_front = self
            .root_pdfs
            .iter()
            .position(|(open, _)| *open == document)
            .map(|ix| {
                self.root_pdfs.remove(ix);
                let id = root_pdf_id(&document);
                let front = self.in_front(&id, cx);
                self.engine_do(cx, |engine| engine.close(&id));
                front
            })
            .unwrap_or(false);
        let pdf = root.join(&document).with_extension("pdf");
        self.label_pdfs(cx);
        self.pdf.update(cx, |panel, cx| panel.open(pdf, window, cx));
        self.refresh_outline(window, cx);
        match left {
            // A build not asked for leaves the reader on the document they
            // were reading, unless the arriving one's own tab was in front.
            Some(left) if !requested && live_in_front && !own_in_front => {
                self.engine_do(cx, |engine| engine.select(&left));
            }
            _ if requested || own_in_front => {
                self.engine_do(cx, |engine| engine.select("pdf"));
            }
            _ => {}
        }
        cx.notify();
    }

    /// An outline row (the PDF toolbar's Outline, the editor's outline
    /// rail): the heading's line in the editor, then the same place in the
    /// PDF, as a jump from the caret makes it.
    pub(super) fn jump_to_heading(
        &mut self,
        path: &str,
        line: u32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        if self
            .open_path(root.join(path), Some(line), window, cx)
            .is_some()
        {
            // Once the editor has reported its caret on that line.
            cx.defer_in(window, |this, window, cx| {
                this.forward_sync(&super::ForwardSync, window, cx)
            });
        }
    }

    /// Read the live document's outline again, then offer it.
    pub(super) fn refresh_outline(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(root), Some(document)) = (self.root(cx), self.live_document.clone()) else {
            self.outline = std::rc::Rc::from([]);
            self._outline_task = None;
            self.pdf.update(cx, |pdf, cx| pdf.set_outline(None, cx));
            return;
        };
        let reading =
            cx.background_spawn(async move { crate::outline::read_outline(&root, &document) });
        self._outline_task = Some(cx.spawn_in(window, async move |this, cx| {
            let headings = reading.await.into();
            this.update(cx, |this, cx| {
                this.outline = headings;
                this.show_outline(cx);
            })
            .ok();
        }));
    }

    /// Offer the read outline in the live PDF's Outline while the document
    /// in front is a LaTeX source, marking the section the caret is in.
    pub(super) fn show_outline(&mut self, cx: &mut Context<Self>) {
        if self.live_document.is_none() {
            return;
        }
        let caret = self.active_editor().map(|editor| {
            let editor = editor.read(cx);
            (editor.relative().to_string(), editor.cursor().0)
        });
        let available = caret
            .as_ref()
            .is_none_or(|(path, _)| path.to_ascii_lowercase().ends_with(".tex"));
        // The section the caret is in: the last heading of its file at or
        // above its line.
        let active = caret.as_ref().and_then(|(path, line)| {
            self.outline
                .iter()
                .rposition(|heading| heading.path == *path && heading.line <= *line)
        });
        let state = available.then(|| OutlineState {
            headings: self.outline.clone(),
            active,
        });
        self.pdf.update(cx, |pdf, cx| pdf.set_outline(state, cx));
        // The editors' outline rails mark the same outline.
        let root = self.live_document.clone().unwrap_or_default();
        for editor in self.open_editors() {
            let headings = self.outline.clone();
            let root = root.clone();
            editor.update(cx, |editor, cx| {
                editor.set_manuscript_outline(headings, root, cx)
            });
        }
    }

    /// The live document's outline.
    pub fn outline(&self) -> &[crate::outline::Heading] {
        &self.outline
    }

    /// Name each root document's tab, and the live PDF's window, among the
    /// root documents open now (the live one and those with tabs): a name
    /// another of them shares gains its folder.
    pub(super) fn label_pdfs(&mut self, cx: &mut Context<Self>) {
        let documents: Vec<String> = self
            .live_document
            .iter()
            .cloned()
            .chain(self.root_pdfs.iter().map(|(document, _)| document.clone()))
            .collect();
        for (document, panel) in &self.root_pdfs {
            let label = pdf_tab_label(document, &documents);
            panel.update(cx, |panel, cx| panel.set_label(label.into(), cx));
        }
        let live = self.live_document.as_deref().unwrap_or("main.tex");
        let title = format!(
            "{} — {}",
            pdf_tab_label(live, &documents),
            self.project_name(cx)
        );
        self.pdf
            .update(cx, |panel, cx| panel.set_window_title(title.into(), cx));
    }

    /// A root document's tab or a PDF file the reader closed is let go of:
    /// it opens anew when asked for again, and its viewer lets go of its
    /// document.
    pub(super) fn forget_closed_pdfs(&mut self, cx: &mut Context<Self>) {
        let roots = self.root_pdfs.len();
        let views = self.views.clone();
        self.root_pdfs
            .retain(|(document, _)| views.borrow().contains_key(&root_pdf_id(document)));
        self.file_pdfs.retain(|panel| {
            views
                .borrow()
                .values()
                .any(|view| view.view().entity_id() == panel.entity_id())
        });
        if self.root_pdfs.len() != roots {
            self.label_pdfs(cx);
        }
    }

    /// A tab for `document`'s last PDF, where the live tab stands (else
    /// where the PDF comes back), the live tab kept in front.
    fn add_root_pdf(
        &mut self,
        document: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<String> {
        self.root_pdf_panel(&document, window, cx)?;
        let doc = self.document(cx);
        let placement = match panel_of_view(&doc, "pdf") {
            Some(panel) => Placement::Into {
                into: panel.id.clone(),
                index: panel.views.iter().position(|view| view == "pdf"),
            },
            None => self.home_of("pdf", cx),
        };
        let mut params = trellis::model::Params::new();
        params.insert("document".into(), document.clone().into());
        let id = root_pdf_id(&document);
        self.engine_do(cx, |engine| {
            engine.open(
                ROOT_PDF,
                OpenOptions {
                    id: Some(id.clone()),
                    params: Some(params),
                    placement: Some(placement),
                    focus: Some(false),
                    ..OpenOptions::default()
                },
            );
            engine.select("pdf");
        });
        self.sync_views(window, cx);
        Some(id)
    }

    /// The viewer of `document`'s last PDF, made from lattice-core's kept
    /// copy if it is not open yet.
    pub(super) fn root_pdf_panel(
        &mut self,
        document: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<PdfPanel>> {
        if let Some((_, panel)) = self.root_pdfs.iter().find(|(open, _)| open == document) {
            return Some(panel.clone());
        }
        let root = self.root(cx)?;
        let path = latex::kept_pdf_path(&root, document)?;
        let kind = PdfPanelKind::Root(document.to_string());
        let panel = cx.new(|cx| PdfPanel::new(kind, window, cx));
        cx.subscribe_in(&panel, window, Self::on_pdf_event).detach();
        panel.update(cx, |panel, cx| panel.open(path, window, cx));
        self.root_pdfs.push((document.to_string(), panel.clone()));
        self.label_pdfs(cx);
        Some(panel)
    }

    /// Whether a view is the one shown in its panel.
    fn in_front(&self, view: &str, cx: &gpui::App) -> bool {
        self.workspace
            .read(cx)
            .engine()
            .view_state(view)
            .is_some_and(|state| state.selected)
    }

    /// The other root documents' tabs go with the project they were of.
    pub(super) fn close_root_pdfs(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.root_pdfs.clear();
        self.file_pdfs.clear();
    }

    /// A PDF of the project, opened from the tree: a tab of its own among
    /// the documents, or its tab brought forward.
    pub(super) fn open_file_pdf(
        &mut self,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        self.file_pdf_for(path.clone(), window, cx);
        self.place_document(&super::views::document_key(&root, &path), true, cx);
        self.sync_views(window, cx);
    }

    /// The tab of a PDF of the project, opened if it is not yet; it is not
    /// placed in the dock.
    pub(super) fn file_pdf_for(
        &mut self,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<PdfPanel> {
        if let Some(panel) = self.file_pdfs.iter().find(
            |panel| matches!(panel.read(cx).kind(), PdfPanelKind::File(open) if *open == path),
        ) {
            return panel.clone();
        }
        let panel = cx.new(|cx| PdfPanel::new(PdfPanelKind::File(path.clone()), window, cx));
        cx.subscribe_in(&panel, window, Self::on_pdf_event).detach();
        panel.update(cx, |panel, cx| panel.open(path, window, cx));
        self.file_pdfs.push(panel.clone());
        panel
    }

    /// Reveal cursor in PDF in a root document's own tab: the caret's line
    /// in that document's PDF, through its own SyncTeX map.
    fn forward_sync_in(&mut self, document: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.active_editor() else {
            return;
        };
        let Some(root) = self.root(cx) else {
            return;
        };
        let (relative, (line, column)) = {
            let editor = editor.read(cx);
            (editor.relative().to_string(), editor.cursor())
        };
        let lookup = cx.background_spawn({
            let document = document.clone();
            async move { latex::forward_search_in(&root, &relative, line, column, Some(&document)) }
        });
        cx.spawn_in(window, async move |this, cx| {
            let target = lookup.await;
            this.update(cx, |this, cx| {
                let panel = this
                    .root_pdfs
                    .iter()
                    .find(|(open, _)| *open == document)
                    .map(|(_, panel)| panel.clone());
                match (target, panel) {
                    (Ok(Some(target)), Some(panel)) => {
                        panel.update(cx, |panel, cx| panel.show_sync_target(&target, cx))
                    }
                    (Ok(None), _) => notices::warning(
                        t!("This source line has no matching position in the PDF."),
                        cx,
                    ),
                    (Err(error), _) => notices::error("SyncTeX", error, cx),
                    _ => {}
                }
            })
            .ok();
        })
        .detach();
    }

    /// The root documents' tabs, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn root_pdf_tabs(&self) -> Vec<(String, Entity<PdfPanel>)> {
        self.root_pdfs.clone()
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn live_document(&self) -> Option<&str> {
        self.live_document.as_deref()
    }
}
