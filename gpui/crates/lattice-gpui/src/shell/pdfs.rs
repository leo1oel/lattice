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
use gpui_kit::component::dock::{DockPlacement, InsertTarget, PaneRef, PanelId, panel_handle};
use lattice_core::latex;

use super::{Shell, build::BuildRequest};
use crate::{
    notices,
    pdf::{OutlineState, PdfEvent, PdfPanel, PdfPanelKind, pdf_tab_label},
};

const PLACEMENTS: [DockPlacement; 4] = [
    DockPlacement::Center,
    DockPlacement::Left,
    DockPlacement::Right,
    DockPlacement::Bottom,
];

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
            PdfEvent::Outline { path, line } => {
                let Some(root) = self.root(cx) else {
                    return;
                };
                if self
                    .open_path(root.join(path), Some(*line), window, cx)
                    .is_some()
                {
                    // Once the editor has reported its caret on that line.
                    cx.defer_in(window, |this, window, cx| {
                        this.forward_sync(&super::ForwardSync, window, cx)
                    });
                }
            }
            // In its own window, the PDF alone in the right dock leaves the
            // dock its room; Return to workspace brings the panel back. Shared
            // with other panels, the dock stays and shows the placeholder.
            PdfEvent::Detached | PdfEvent::Docked => {
                let open = matches!(event, PdfEvent::Docked);
                let live = PanelId::from(self.pdf.entity_id());
                self.dock_area.update(cx, |area, cx| {
                    let alone = area.layout(DockPlacement::Right).is_some_and(|tree| {
                        let mut panels = tree.panels();
                        panels.next() == Some(live) && panels.next().is_none()
                    });
                    if alone && area.is_dock_open(DockPlacement::Right) != open {
                        area.toggle_dock(DockPlacement::Right, window, cx);
                    }
                });
                cx.notify();
            }
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
        let live_in_front = self.panel_in_front(PanelId::from(self.pdf.entity_id()), cx);
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
                let (_, panel) = self.root_pdfs.remove(ix);
                let front = self.panel_in_front(PanelId::from(panel.entity_id()), cx);
                self.dock_area
                    .update(cx, |area, cx| area.remove_panel(panel, window, cx));
                front
            })
            .unwrap_or(false);
        let pdf = root.join(&document).with_extension("pdf");
        self.label_pdfs(cx);
        self.pdf.update(cx, |panel, cx| panel.open(pdf, window, cx));
        self.refresh_outline(window, cx);
        let live = PanelId::from(self.pdf.entity_id());
        match left {
            // A build not asked for leaves the reader on the document they
            // were reading, unless the arriving one's own tab was in front.
            Some(left) if !requested && live_in_front && !own_in_front => {
                self.dock_area
                    .update(cx, |area, cx| area.select_panel(left, window, cx));
            }
            _ if requested || own_in_front => {
                self.dock_area
                    .update(cx, |area, cx| area.select_panel(live, window, cx));
            }
            _ => {}
        }
        cx.notify();
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
        let held: std::collections::HashSet<_> = self
            .root_pdfs
            .iter()
            .map(|(_, panel)| panel)
            .chain(&self.file_pdfs)
            .map(|panel| panel.entity_id())
            .filter(|id| self.panel_shown(PanelId::from(*id), cx))
            .collect();
        let roots = self.root_pdfs.len();
        self.root_pdfs
            .retain(|(_, panel)| held.contains(&panel.entity_id()));
        self.file_pdfs
            .retain(|panel| held.contains(&panel.entity_id()));
        if self.root_pdfs.len() != roots {
            self.label_pdfs(cx);
        }
        self.forget_closed_readers(cx);
    }

    /// A tab for `document`'s last PDF, where the live tab stands.
    fn add_root_pdf(
        &mut self,
        document: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<PanelId> {
        let root = self.root(cx)?;
        let path = latex::kept_pdf_path(&root, &document)?;
        let panel = cx.new(|cx| PdfPanel::new(PdfPanelKind::Root(document.clone()), window, cx));
        cx.subscribe_in(&panel, window, Self::on_pdf_event).detach();
        panel.update(cx, |panel, cx| panel.open(path, window, cx));
        let id = PanelId::from(panel.entity_id());
        let live = PanelId::from(self.pdf.entity_id());
        let slot = self.slot_of(live, cx);
        let placement = slot.map_or(DockPlacement::Right, |(placement, ..)| placement);
        self.dock_area.update(cx, |area, cx| {
            area.add_panel_view(panel_handle(panel.clone()), placement, None, window, cx);
            if let Some((_, node, ix)) = slot {
                area.move_panel(
                    id,
                    InsertTarget::Tabs {
                        node,
                        ix: Some(ix),
                        activate: false,
                    },
                    window,
                    cx,
                );
            }
            area.select_panel(live, window, cx);
        });
        self.root_pdfs.push((document, panel));
        Some(id)
    }

    /// Where a panel is: its region, its tab group and its place there.
    fn slot_of(
        &self,
        panel: PanelId,
        cx: &gpui::App,
    ) -> Option<(DockPlacement, gpui_kit::component::dock::NodeId, usize)> {
        let area = self.dock_area.read(cx);
        PLACEMENTS.into_iter().find_map(|placement| {
            let tree = area.layout(placement)?;
            let node = tree.find_panel_node(panel)?;
            match tree.find_node(node)?.kind() {
                PaneRef::Tabs { panels, .. } => {
                    let ix = panels.iter().position(|open| *open == panel)?;
                    Some((placement, node, ix))
                }
                _ => None,
            }
        })
    }

    /// Whether a panel is the one shown in its tab group.
    fn panel_in_front(&self, panel: PanelId, cx: &gpui::App) -> bool {
        let area = self.dock_area.read(cx);
        PLACEMENTS.into_iter().any(|placement| {
            area.layout(placement)
                .and_then(|tree| {
                    let node = tree.find_panel_node(panel)?;
                    match tree.find_node(node)?.kind() {
                        PaneRef::Tabs { panels, active_ix } => {
                            Some(panels.get(active_ix) == Some(&panel))
                        }
                        _ => None,
                    }
                })
                .unwrap_or(false)
        })
    }

    /// The other root documents' tabs go with the project they were of.
    pub(super) fn close_root_pdfs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for (_, panel) in std::mem::take(&mut self.root_pdfs) {
            self.dock_area
                .update(cx, |area, cx| area.remove_panel(panel, window, cx));
        }
        for panel in std::mem::take(&mut self.file_pdfs) {
            self.dock_area
                .update(cx, |area, cx| area.remove_panel(panel, window, cx));
        }
        self.close_readers(window, cx);
    }

    /// A PDF of the project, opened from the tree: a tab of its own among
    /// the documents, or its tab brought forward.
    pub(super) fn open_file_pdf(
        &mut self,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let panel = self.file_pdf_for(path, window, cx);
        let id = PanelId::from(panel.entity_id());
        if !self.panel_shown(id, cx) {
            self.dock_area.update(cx, |area, cx| {
                area.add_panel_view(panel_handle(panel), DockPlacement::Center, None, window, cx);
            });
        }
        self.dock_area
            .update(cx, |area, cx| area.select_panel(id, window, cx));
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
                        "This source line has no matching position in the PDF.",
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
