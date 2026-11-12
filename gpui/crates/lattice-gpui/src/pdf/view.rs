//! The PDF viewer: one document, its pages drawn by PDFium near the
//! viewport, and everything the Tauri app's viewer does with them
//! (`src/pdf/pdf-viewer.tsx` and its hooks): page navigation, zoom and the
//! two fit modes, find, text selection and copy, links with back and
//! forward, dark pages, the SyncTeX mark, and a rebuild that redraws only
//! the pages it changed.
//!
//! The same viewer is the live PDF in its panel, a root document's PDF in
//! its own tab, and the live PDF in its separate window (`panel.rs`,
//! `window.rs`); each asks for the toolbar action it offers.
//!
//! Pages are laid out from their sizes at once (`layout.rs`) and scroll in
//! one container, so a page never moves while it draws. Only the pages on
//! screen and two on each side keep their images; the rest are released
//! from memory and from the GPU atlas, so a long PDF holds a handful of
//! pages however far it is scrolled. A page larger than `MAX_PAGE_PIXELS`
//! at its zoom is drawn smaller, with the part on screen drawn again at full
//! size on top, as PDF.js caps a canvas and adds a detail one.

use std::{
    collections::HashSet,
    ops::Range,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use gpui::{
    App, AppContext as _, Bounds, ClipboardItem, Context, Entity, EventEmitter, FocusHandle,
    Focusable, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PinchEvent,
    Pixels, Point, RenderImage, ScrollDelta, ScrollEvent, ScrollHandle, SharedString, Task, Window,
    point, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::{latex::PdfSyncTarget, pdf_pages::PageSignatures};

mod drafts;
mod links;
mod pages;
mod pointer;
mod search;
mod sync_mark;

use links::Location;
pub(super) use pages::PageSlot;
pub(super) use sync_mark::{SYNC_MARK_HOLD, SyncMark};
pub(super) use {drafts::DraftField, search::FindState};

use super::{
    engine::{DocId, DocumentInfo, PdfEngine, PixelRect, RenderRequest},
    find::{FindOptions, Match, first_match_from, normalize_query},
    layout::{self, FitMode, Layout},
    preferences,
    text::{LinkTarget, PageText, Selection, copied},
};

/// A zoom (buttons, ⌘-wheel, pinch) draws the pages again this long after
/// its last step, stretching the old images meanwhile (`PDF_ZOOM_COMMIT_MS`).
const ZOOM_SETTLE: Duration = Duration::from_millis(80);
/// A fitted page follows the panel's size, drawn again once a resize rests
/// (`PDF_REFIT_SETTLE_MS`).
const REFIT_SETTLE: Duration = Duration::from_millis(120);

/// What the viewer tells whoever shows it.
pub enum PdfViewEvent {
    /// A double-click at (`x`, `y`) PDF points from the top-left corner of
    /// page `page` (1-based): show its source.
    SourceAt { page: u32, x: f64, y: f64 },
    /// The toolbar's Reveal cursor in PDF.
    RevealCursor,
    /// The toolbar action the host offered (`ToolbarAction`).
    Action,
    /// The empty state's Build project.
    Build,
    /// An Outline row: open `path` (project-relative) at `line` and show the
    /// place in the PDF.
    Outline { path: String, line: u32 },
}

/// A context-specific action before Save, such as moving the PDF into a
/// window of its own; a narrow toolbar moves it into the overflow menu.
#[derive(Clone)]
pub struct ToolbarAction {
    pub label: SharedString,
    pub icon: lattice_ui::Icon,
}

/// A document shown: its pages, and what a rebuild is compared against.
pub(super) struct Document {
    pub info: DocumentInfo,
    pub signatures: Option<PageSignatures>,
}

/// Where a viewer is in its document, carried from the panel to the
/// separate window and back.
#[derive(Clone, Copy, Debug)]
pub struct ViewPlace {
    page: usize,
    scale: f32,
    fit: Option<FitMode>,
    scroll: (f32, f32),
}

/// Where the view should be once the document is laid out.
#[derive(Clone, Copy, Debug)]
enum PendingScroll {
    /// A point of a page (PDF points from its top-left corner) at a point of
    /// the viewport.
    PagePoint {
        page: usize,
        x: Option<f32>,
        y: f32,
        at_y: f32,
    },
    /// An absolute offset.
    Offset(f32, f32),
}

/// What a scenario reads of the drawing.
#[derive(Clone, Debug, Default)]
pub struct RenderStats {
    /// Page images asked of PDFium, ever.
    pub renders: u64,
    /// The pages (0-based) the last reload of the same file drew again, or
    /// `None` when it showed the document anew.
    pub last_swap: Option<Vec<usize>>,
    /// The pages the last reload kept as they were.
    pub kept: usize,
    /// Every reload's redrawn pages, oldest first.
    pub swaps: Vec<Vec<usize>>,
}

pub struct PdfView {
    pub(super) focus_handle: FocusHandle,
    pub(super) engine: Result<Arc<PdfEngine>, SharedString>,
    doc: Option<DocId>,
    pub(super) source: Option<PathBuf>,
    pub(super) document: Option<Document>,
    pub(super) pages: Vec<PageSlot>,
    pub(super) layout: Layout,
    pub(super) scale: f32,
    pub(super) fit: Option<FitMode>,
    /// The scale page images are drawn at, which follows `scale` once a
    /// zoom or resize settles.
    render_scale: f32,
    pub(super) scroll: ScrollHandle,
    /// The scroll container's size and window position as of the last frame.
    pub(super) viewport: Bounds<Pixels>,
    /// The whole view's width as of the last frame, which decides whether
    /// the toolbar is narrow.
    pub(super) width: Pixels,
    pub(super) current_page: usize,
    pending_scroll: Option<PendingScroll>,
    pub(super) find: FindState,
    pub(super) page_field: DraftField,
    pub(super) zoom_field: DraftField,
    pub(super) selection: Option<Selection>,
    selecting: bool,
    /// A link pressed on, followed if the press ends on it.
    pressed_link: Option<(usize, LinkTarget)>,
    back: Vec<Location>,
    forward: Vec<Location>,
    pub(super) sync_mark: Option<SyncMark>,
    next_mark: usize,
    pub(super) message: Option<SharedString>,
    pub(super) loading: bool,
    pub(super) dark: bool,
    pub(super) action: Option<ToolbarAction>,
    pub(super) outline: Option<super::OutlineState>,
    pub(super) can_reveal: bool,
    pub(super) offers_build: bool,
    pub(super) building: bool,
    pub(super) zoom_entry: bool,
    stats: RenderStats,
    _open_task: Option<Task<()>>,
    _mark_task: Option<Task<()>>,
    settle_task: Option<Task<()>>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl EventEmitter<PdfViewEvent> for PdfView {}

impl PdfView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        preferences::load();
        let preference = preferences::get();
        let engine = PdfEngine::global(cx);
        let find_input = cx.new(|cx| InputState::new(window, cx).placeholder("Find in PDF"));
        let page_input = cx.new(|cx| InputState::new(window, cx));
        let zoom_input = cx.new(|cx| InputState::new(window, cx));
        let subscriptions = vec![
            // Dark pages are one choice for every viewer in every window.
            cx.observe_global::<super::dark::DarkPages>(|this, cx| {
                this.dark = super::dark::enabled();
                cx.notify();
            }),
            cx.subscribe_in(&find_input, window, Self::on_find_input),
            cx.subscribe_in(&page_input, window, |this, _, event, window, cx| {
                this.on_draft_event(false, event, window, cx)
            }),
            cx.subscribe_in(&zoom_input, window, |this, _, event, window, cx| {
                this.on_draft_event(true, event, window, cx)
            }),
        ];
        Self {
            focus_handle: cx.focus_handle(),
            engine,
            doc: None,
            source: None,
            document: None,
            pages: Vec::new(),
            layout: Layout::default(),
            scale: preference.scale,
            fit: preference.fit_mode,
            render_scale: preference.scale,
            scroll: ScrollHandle::new(),
            viewport: Bounds::default(),
            width: px(0.),
            current_page: 0,
            pending_scroll: None,
            find: FindState {
                input: find_input,
                query: String::new(),
                options: FindOptions::default(),
                matches: Vec::new(),
                current: None,
                pending: false,
                searched: None,
                scroll_on_answer: false,
                task: None,
            },
            page_field: DraftField {
                input: page_input,
                editing: false,
            },
            zoom_field: DraftField {
                input: zoom_input,
                editing: false,
            },
            selection: None,
            selecting: false,
            pressed_link: None,
            back: Vec::new(),
            forward: Vec::new(),
            sync_mark: None,
            next_mark: 0,
            message: None,
            loading: false,
            dark: super::dark::enabled(),
            action: None,
            outline: None,
            can_reveal: false,
            offers_build: false,
            building: false,
            zoom_entry: false,
            stats: RenderStats::default(),
            _open_task: None,
            _mark_task: None,
            settle_task: None,
            _subscriptions: subscriptions,
        }
    }

    // ---- What the host sets -------------------------------------------------

    pub fn set_action(&mut self, action: Option<ToolbarAction>, cx: &mut Context<Self>) {
        self.action = action;
        cx.notify();
    }

    /// Offer Reveal cursor in PDF (the live PDF and a root document's tab).
    pub fn set_can_reveal(&mut self, can: bool, cx: &mut Context<Self>) {
        self.can_reveal = can;
        cx.notify();
    }

    /// Offer Build project while there is no PDF, and show a build running.
    pub fn set_build(&mut self, offers: bool, building: bool, cx: &mut Context<Self>) {
        if (self.offers_build, self.building) != (offers, building) {
            self.offers_build = offers;
            self.building = building;
            cx.notify();
        }
    }

    /// The pages' scroll area on screen, as of the last frame.
    pub fn viewport_bounds(&self) -> Bounds<Pixels> {
        self.viewport
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    /// The page in view, 0-based.
    pub fn current_page(&self) -> usize {
        self.current_page
    }

    pub fn scale(&self) -> f32 {
        self.scale
    }

    pub fn fit(&self) -> Option<FitMode> {
        self.fit
    }

    pub fn stats(&self) -> &RenderStats {
        &self.stats
    }

    // ---- Opening ------------------------------------------------------------

    /// Show `path`, or show it again after a build: the pages a rebuild did
    /// not change keep their images, the changed ones show their old image
    /// until the new one is drawn, and the scroll position and zoom stay.
    pub fn open(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let Ok(engine) = self.engine.clone() else {
            return;
        };
        let reload = self.source.as_ref() == Some(&path) && self.document.is_some();
        if !reload {
            // Another file: what was shown goes at once.
            self.reset(window);
        }
        self.source = Some(path.clone());
        let doc = *self.doc.get_or_insert_with(|| engine.new_document());
        self.loading = true;
        cx.notify();
        self._open_task = Some(cx.spawn_in(window, async move |this, cx| {
            let read = cx
                .background_spawn({
                    let path = path.clone();
                    async move { std::fs::read(&path) }
                })
                .await;
            let bytes = match read {
                Ok(bytes) if bytes.starts_with(b"%PDF-") => bytes,
                Ok(_) => {
                    this.update(cx, |this, cx| {
                        this.failed("The PDF could not be read: it is not a PDF.".into(), cx)
                    })
                    .ok();
                    return;
                }
                Err(error) => {
                    this.update(cx, |this, cx| {
                        this.failed(format!("The PDF could not be read: {error}").into(), cx)
                    })
                    .ok();
                    return;
                }
            };
            // Each page's signature (lattice-core's `pdf_pages`), read beside
            // PDFium's load, tells a rebuild's changed pages from the rest.
            let signing = cx.background_spawn({
                let bytes = bytes.clone();
                async move { lattice_core::pdf_pages::signatures(&bytes).ok() }
            });
            let opened = engine.open(doc, bytes).await;
            let signatures = signing.await;
            this.update_in(cx, |this, window, cx| {
                if this.source.as_ref() != Some(&path) {
                    return;
                }
                match opened {
                    Ok(Ok(info)) => this.set_document(info, signatures, reload, window, cx),
                    Ok(Err(error)) => this.failed(format!("{error:#}").into(), cx),
                    Err(_) => this.failed("The PDFium worker stopped.".into(), cx),
                }
            })
            .ok();
        }));
    }

    /// Show nothing, for a project without a built PDF.
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self._open_task = None;
        self.reset(window);
        self.current_page = 0;
        self.pending_scroll = None;
        self.source = None;
        self.message = None;
        self.loading = false;
        cx.notify();
    }

    /// Where the viewer is, to carry to another viewer of the same PDF.
    pub fn view_place(&self) -> ViewPlace {
        ViewPlace {
            page: self.current_page,
            scale: self.scale,
            fit: self.fit,
            scroll: self.scroll_offset(),
        }
    }

    /// Open the next document at `place` rather than at its start.
    pub fn restore_place(&mut self, place: ViewPlace) {
        self.scale = place.scale;
        self.render_scale = place.scale;
        self.fit = place.fit;
        self.current_page = place.page;
        self.pending_scroll = Some(PendingScroll::Offset(place.scroll.0, place.scroll.1));
    }

    fn reset(&mut self, window: &mut Window) {
        for mut slot in self.pages.drain(..) {
            slot.base.release(window);
            slot.detail.release(window);
        }
        self.document = None;
        self.layout = Layout::default();
        self.selection = None;
        self.back.clear();
        self.forward.clear();
        self.find.matches.clear();
        self.find.current = None;
        self.find.searched = None;
        self.scroll.set_offset(point(px(0.), px(0.)));
    }

    fn failed(&mut self, message: SharedString, cx: &mut Context<Self>) {
        self.loading = false;
        // A reload that fails keeps the pages it showed, as a rebuild's
        // half-written PDF must not blank the preview.
        if self.document.is_none() {
            self.message = Some(message);
        } else {
            log::warn!("{message}");
        }
        cx.notify();
    }

    fn set_document(
        &mut self,
        info: DocumentInfo,
        signatures: Option<PageSignatures>,
        reload: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.loading = false;
        self.message = None;
        let generation = info.generation;
        let count = info.page_sizes.len();
        let previous = self.document.take();
        let same_shape = reload
            && previous
                .as_ref()
                .is_some_and(|old| old.info.page_sizes == info.page_sizes)
            && self.pages.len() == count;
        if same_shape {
            let changed = match (
                previous.as_ref().and_then(|old| old.signatures.as_ref()),
                signatures.as_ref(),
            ) {
                (Some(before), Some(after)) => changed_pages(before, after),
                _ => None,
            };
            let mut redrawn = Vec::new();
            for (ix, slot) in self.pages.iter_mut().enumerate() {
                let unchanged = changed.as_ref().is_some_and(|set| !set.contains(&ix));
                slot.base.cancel();
                slot.detail.cancel();
                slot.text_pending = None;
                if unchanged {
                    // The same drawing: its image and text are the new copy's.
                    for drawn in [&mut slot.base, &mut slot.detail] {
                        if let Some(key) = &mut drawn.key {
                            key.generation = generation;
                        }
                    }
                    if slot.text.is_some() {
                        slot.text_generation = generation;
                    }
                } else {
                    // Its old image stays until the new one is drawn.
                    slot.text = None;
                    redrawn.push(ix);
                }
            }
            self.stats.kept = count - redrawn.len();
            self.stats.swaps.push(redrawn.clone());
            self.stats.last_swap = Some(redrawn);
            // A selection on a page that changed may no longer be on its text.
            if self.selection.is_some_and(|selection| {
                let ((from, _), (to, _)) = selection.ordered();
                self.stats
                    .last_swap
                    .as_ref()
                    .is_some_and(|redrawn| redrawn.iter().any(|ix| (from..=to).contains(ix)))
            }) {
                self.selection = None;
            }
        } else {
            for mut slot in self.pages.drain(..) {
                slot.base.release(window);
                slot.detail.release(window);
            }
            self.pages = (0..count).map(|_| PageSlot::default()).collect();
            self.selection = None;
            self.stats.last_swap = None;
            self.stats.kept = 0;
            if !reload {
                self.back.clear();
                self.forward.clear();
            }
        }
        let keep_scroll = reload && self.current_page < count;
        self.document = Some(Document { info, signatures });
        if !keep_scroll && self.pending_scroll.is_none() {
            self.current_page = 0;
            self.pending_scroll = Some(PendingScroll::Offset(0., 0.));
        }
        self.current_page = self.current_page.min(count.saturating_sub(1));
        self.relayout();
        // The search on screen is run again on the new copy, without moving
        // the reader to a match (`rerunSearch`).
        if self.find.query.trim().is_empty() {
            self.find.matches.clear();
            self.find.current = None;
        } else {
            self.run_find(false, cx);
        }
        self.scroll_to_mark();
        cx.notify();
    }

    // ---- Layout and scrolling ----------------------------------------------

    pub(super) fn page_sizes(&self) -> &[(f32, f32)] {
        self.document
            .as_ref()
            .map(|document| document.info.page_sizes.as_slice())
            .unwrap_or(&[])
    }

    fn viewport_size(&self) -> (f32, f32) {
        (
            f32::from(self.viewport.size.width),
            f32::from(self.viewport.size.height),
        )
    }

    /// The scroll offset, positive down and right.
    pub(super) fn scroll_offset(&self) -> (f32, f32) {
        let offset = self.scroll.offset();
        (-f32::from(offset.x), -f32::from(offset.y))
    }

    fn set_scroll(&mut self, (x, y): (f32, f32)) {
        let (max_x, max_y) = self.layout.max_scroll(self.viewport_size());
        self.scroll.set_offset(point(
            px(-x.clamp(0., max_x.max(0.))),
            px(-y.clamp(0., max_y.max(0.))),
        ));
    }

    /// Lay the pages out at the current scale and width; a fit takes its
    /// scale from the page in view.
    fn relayout(&mut self) {
        let (width, height) = self.viewport_size();
        if let Some(mode) = self.fit
            && let Some(page) = self.page_sizes().get(self.current_page).copied()
            && width > 0.
        {
            self.scale = layout::fit_scale(mode, page, (width, height));
        }
        self.layout = Layout::new(self.page_sizes(), self.scale, width);
    }

    /// Change the scale, keeping the point at `anchor` (in the viewport;
    /// its middle by default) where it is.
    pub(super) fn zoom_to(
        &mut self,
        scale: f32,
        anchor: Option<(f32, f32)>,
        fit: Option<FitMode>,
        cx: &mut Context<Self>,
    ) {
        let scale = layout::clamp_scale(scale);
        let viewport = self.viewport_size();
        let anchor = anchor.unwrap_or((viewport.0 / 2., viewport.1 / 2.));
        let before = self.layout.clone();
        let scroll = self.scroll_offset();
        self.fit = fit;
        self.scale = scale;
        self.relayout();
        if before.len() > 0 && viewport.0 > 0. {
            let next = layout::anchored_scroll(&before, &self.layout, scroll, anchor, viewport);
            self.set_scroll(next);
        }
        self.remember_view();
        self.settle(ZOOM_SETTLE, cx);
        cx.notify();
    }

    /// Draw the pages at the new scale once the zoom or resize rests.
    fn settle(&mut self, after: Duration, cx: &mut Context<Self>) {
        self.settle_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(after).await;
            this.update(cx, |this, cx| {
                if this.render_scale != this.scale {
                    this.render_scale = this.scale;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    fn remember_view(&self) {
        let (fit, scale) = (self.fit, self.scale);
        preferences::update(|preferences| {
            preferences.fit_mode = fit;
            preferences.scale = scale;
        });
    }

    /// The zoom buttons and the menu's steps.
    pub fn step_zoom(&mut self, direction: f32, cx: &mut Context<Self>) {
        let next = layout::step_scale(self.scale, direction);
        self.zoom_to(next, None, None, cx);
    }

    /// A fit button: on, or off again (keeping the scale it gave).
    pub fn toggle_fit(&mut self, mode: FitMode, cx: &mut Context<Self>) {
        if self.fit == Some(mode) {
            self.fit = None;
            self.remember_view();
            cx.notify();
            return;
        }
        let Some(page) = self.page_sizes().get(self.current_page).copied() else {
            self.fit = Some(mode);
            self.remember_view();
            cx.notify();
            return;
        };
        let scale = layout::fit_scale(mode, page, self.viewport_size());
        // PDF.js keeps the point at the top left of the view through a fit.
        self.zoom_to(scale, Some((0., 0.)), Some(mode), cx);
    }

    /// Scroll so page `page` (0-based) starts at the top of the view.
    pub fn go_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if page >= self.pages.len() {
            return;
        }
        self.pending_scroll = Some(PendingScroll::PagePoint {
            page,
            x: None,
            y: 0.,
            at_y: 0.,
        });
        self.current_page = page;
        self.apply_pending_scroll();
        cx.notify();
    }

    pub fn step_page(&mut self, delta: isize, cx: &mut Context<Self>) {
        let page = (self.current_page as isize + delta).clamp(0, self.pages.len() as isize - 1);
        self.go_to_page(page as usize, cx);
    }

    fn apply_pending_scroll(&mut self) {
        if self.viewport.size.width <= px(0.) || self.layout.len() == 0 {
            return;
        }
        let Some(pending) = self.pending_scroll.take() else {
            return;
        };
        match pending {
            PendingScroll::Offset(x, y) => self.set_scroll((x, y)),
            PendingScroll::PagePoint { page, x, y, at_y } => {
                let Some((sheet_x, sheet_y)) = self.layout.to_sheet(page, x.unwrap_or(0.), y)
                else {
                    return;
                };
                let scroll_x = match x {
                    Some(_) => sheet_x,
                    None => self.scroll_offset().0,
                };
                self.set_scroll((scroll_x, sheet_y - at_y));
            }
        }
    }

    // ---- Dark pages ----------------------------------------------------------

    /// Dark pages on or off, in every viewer and window.
    pub fn toggle_dark_pages(&mut self, cx: &mut Context<Self>) {
        let dark = !super::dark::enabled();
        preferences::update(|preferences| preferences.dark_pages = dark);
        // Every viewer follows (`observe_global` in `new`).
        cx.set_global(super::dark::DarkPages);
    }
}

/// The pages whose signatures differ, or `None` when the document as a
/// whole changed (`changedPages` in `src/pdf/pdf-page-swap.ts`).
pub(super) fn changed_pages(
    before: &PageSignatures,
    after: &PageSignatures,
) -> Option<HashSet<usize>> {
    if before.document != after.document || before.pages.len() != after.pages.len() {
        return None;
    }
    Some(
        after
            .pages
            .iter()
            .zip(&before.pages)
            .enumerate()
            .filter(|(_, (new, old))| new != old)
            .map(|(ix, _)| ix)
            .collect(),
    )
}

impl Drop for PdfView {
    /// The worker lets go of the document with its viewer.
    fn drop(&mut self) {
        if let (Ok(engine), Some(doc)) = (&self.engine, self.doc) {
            engine.close(doc);
        }
    }
}

impl Focusable for PdfView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rebuild_redraws_only_the_pages_whose_signatures_changed() {
        let before = PageSignatures {
            document: "d".into(),
            pages: vec!["a".into(), "b".into(), "c".into()],
        };
        let after = PageSignatures {
            document: "d".into(),
            pages: vec!["a".into(), "B".into(), "c".into()],
        };
        assert_eq!(changed_pages(&before, &after), Some([1].into()));
        let renumbered = PageSignatures {
            document: "e".into(),
            ..after
        };
        assert_eq!(changed_pages(&before, &renumbered), None);
    }
}
