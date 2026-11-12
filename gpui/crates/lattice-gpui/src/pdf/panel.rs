//! The PDF preview: pages laid out from their sizes at once, drawn by PDFium
//! only when they scroll into view, and redrawn in place after a build.
//!
//! Drawn as the running app's PDF panel (Paper's Main window): a 40px
//! toolbar under the strip, closed by a hairline, with page navigation, the
//! find field and the zoom controls; pages 8px in from the panel's edges and
//! 10px apart on the sheet, each a sheet of paper with its own shadow.
//!
//! SyncTeX, as the Tauri app's viewer does it (`src/pdf/use-pdf-document.ts`,
//! `pdf-source-targets.ts`): a double-click on a page reports the point, in
//! PDF points from the page's top-left corner, for the shell to look up its
//! source line; a jump from the source scrolls its box to the middle of the
//! panel and marks it with an accent box that fades after 1.44 s.

use std::{
    cell::RefCell, collections::HashMap, ops::Range, path::PathBuf, rc::Rc, sync::Arc,
    time::Duration,
};

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, Bounds, Context, Edges, EventEmitter,
    FocusHandle, Focusable, InteractiveElement as _, IntoElement, ListAlignment, ListOffset,
    ListState, MouseButton, MouseDownEvent, ParentElement as _, Pixels, Render, RenderImage,
    SharedString, Styled as _, Task, Window, canvas, div, img, list, prelude::*, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    menu::{PopupMenu, PopupMenuItem},
};
use lattice_core::latex::PdfSyncTarget;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{IconButton, SearchField},
    dock::PANEL_RADIUS,
    elevation,
};

use super::engine::{DocumentInfo, PdfEngine};
use crate::shell::ForwardSync;

/// How long a jump's mark stays before it fades (`.pdf-synctex-highlight`).
const SYNC_MARK_HOLD: Duration = Duration::from_millis(1440);

/// What the panel tells the shell.
pub enum PdfEvent {
    /// A double-click at (`x`, `y`) PDF points from the top-left corner of
    /// page `page` (1-based): show its source.
    SourceAt { page: u32, x: f64, y: f64 },
}

/// The box a jump from the source marks, in PDF points on its page.
#[derive(Clone, Copy)]
struct SyncMark {
    /// 0-based.
    page: usize,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    id: usize,
    /// Still to be scrolled into view, once the document holding it shows.
    scroll: bool,
    /// Drawn at least once, which starts its fade.
    drawn: bool,
}

/// Pages kept drawn on each side of the visible ones.
const KEEP_AROUND: usize = 2;
/// Between pages, and from the panel's edges to the pages.
const PAGE_GAP: f32 = 10.;
const PAGE_INSET: f32 = 8.;
const ZOOM_STEP: f32 = 1.2;

#[derive(Default)]
struct PageSlot {
    image: Option<Arc<RenderImage>>,
    /// Device-pixel width and document copy the image was drawn for.
    drawn: Option<(u32, u64)>,
    pending: Option<(u32, u64)>,
}

pub struct PdfPanel {
    focus_handle: FocusHandle,
    engine: Result<Rc<PdfEngine>, SharedString>,
    path: Option<PathBuf>,
    document: Option<DocumentInfo>,
    pages: Vec<PageSlot>,
    list_state: ListState,
    /// 1.0 fits the page width to the panel.
    zoom: f32,
    /// The list's width as of the last frame. Read in `render`, because the
    /// list's own state is borrowed while it lays out its items.
    viewport_width: Pixels,
    message: Option<SharedString>,
    /// Each drawn page's box, as of its last frame, to place a double-click.
    page_bounds: Rc<RefCell<HashMap<usize, Bounds<Pixels>>>>,
    sync_mark: Option<SyncMark>,
    next_mark: usize,
    _open_task: Option<Task<()>>,
    _mark_task: Option<Task<()>>,
}

impl PdfPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let engine = PdfEngine::start()
            .map(Rc::new)
            .map_err(|error| SharedString::from(format!("{error:#}")));
        match &engine {
            Ok(engine) => log::info!("PDFium loaded from {}", engine.library.display()),
            Err(error) => log::warn!("{error}"),
        }
        Self {
            focus_handle: cx.focus_handle(),
            engine,
            path: None,
            document: None,
            pages: Vec::new(),
            list_state: ListState::new(0, ListAlignment::Top, px(800.)),
            zoom: 1.0,
            viewport_width: px(0.),
            message: None,
            page_bounds: Rc::default(),
            sync_mark: None,
            next_mark: 0,
            _open_task: None,
            _mark_task: None,
        }
    }

    /// Mark `target` (a forward SyncTeX answer) and scroll it to the middle
    /// of the panel, now or once the document being loaded shows.
    pub fn show_sync_target(&mut self, target: &PdfSyncTarget, cx: &mut Context<Self>) {
        let id = self.next_mark;
        self.next_mark += 1;
        self.sync_mark = Some(SyncMark {
            page: (target.page.max(1) - 1) as usize,
            x: target.x as f32,
            y: target.y as f32,
            width: target.width as f32,
            height: target.height as f32,
            id,
            scroll: true,
            drawn: false,
        });
        self._mark_task = None;
        self.scroll_to_mark();
        cx.notify();
    }

    /// The mark was drawn for the first time: it leaves the tree once it has
    /// faded, as the app's highlight does from when it is inserted.
    fn mark_drawn(&mut self, id: usize, cx: &mut Context<Self>) {
        self._mark_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(
                    SYNC_MARK_HOLD
                        + lattice_ui::Motion::SlowExit.duration()
                        + Duration::from_millis(100),
                )
                .await;
            this.update(cx, |this, cx| {
                if this.sync_mark.is_some_and(|mark| mark.id == id) {
                    this.sync_mark = None;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// The last jump's mark, for a scenario: its page (0-based) and whether
    /// it is still waiting to be scrolled to.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn sync_mark(&self) -> Option<(usize, bool)> {
        self.sync_mark.map(|mark| (mark.page, mark.scroll))
    }

    /// The top of the last jump's mark on its page, in PDF points from the
    /// page's top, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn sync_mark_top(&self) -> Option<f32> {
        self.sync_mark.map(|mark| mark.y)
    }

    /// The middle of the last jump's mark on screen, in window coordinates,
    /// for a scenario that double-clicks it.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn sync_mark_center(&self) -> Option<gpui::Point<Pixels>> {
        let mark = self.sync_mark?;
        let page = self.page_bounds.borrow().get(&mark.page).copied()?;
        let (width_pt, _) = self.document.as_ref()?.page_sizes.get(mark.page).copied()?;
        let scale = f32::from(page.size.width) / width_pt.max(1.);
        Some(gpui::point(
            page.origin.x + px((mark.x + mark.width / 2.) * scale),
            page.origin.y + px((mark.y + mark.height / 2.) * scale),
        ))
    }

    /// The height of item `ix` in the list: its gap above and its page.
    fn item_height(&self, ix: usize) -> Pixels {
        let Some(document) = &self.document else {
            return px(0.);
        };
        let (width_pt, height_pt) = document.page_sizes[ix];
        let pad = px(if ix == 0 { PAGE_INSET } else { PAGE_GAP });
        pad + self.page_width() * (height_pt / width_pt.max(1.))
    }

    /// Scroll the pending mark to the middle of the panel, once the document
    /// holding its page is laid out at a known width.
    fn scroll_to_mark(&mut self) {
        let Some(mark) = self.sync_mark.filter(|mark| mark.scroll) else {
            return;
        };
        let Some(document) = &self.document else {
            return;
        };
        if mark.page >= document.page_sizes.len() || self.viewport_width <= px(0.) {
            return;
        }
        let (width_pt, _) = document.page_sizes[mark.page];
        let scale = self.page_width() / width_pt.max(1.);
        let pad = px(if mark.page == 0 { PAGE_INSET } else { PAGE_GAP });
        let center = pad + scale * (mark.y + mark.height.max(12. / f32::from(scale)) / 2.);
        let viewport = self.list_state.viewport_bounds().size.height;
        let mut item_ix = mark.page;
        let mut offset = center - viewport / 2.;
        while offset < px(0.) && item_ix > 0 {
            item_ix -= 1;
            offset += self.item_height(item_ix);
        }
        self.list_state.scroll_to(ListOffset {
            item_ix,
            offset_in_item: offset.max(px(0.)),
        });
        if let Some(mark) = &mut self.sync_mark {
            mark.scroll = false;
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    /// Pages whose image is on screen at the size they are shown, for a
    /// scenario that waits for them.
    #[cfg(all(target_os = "macos", feature = "offscreen-shots"))]
    pub fn pages_drawn(&self) -> usize {
        self.pages
            .iter()
            .filter(|slot| slot.image.is_some() && slot.pending.is_none())
            .count()
    }

    #[cfg(target_os = "macos")]
    pub fn scroll_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        self.list_state.scroll_to(gpui::ListOffset {
            item_ix: page,
            offset_in_item: px(0.),
        });
        cx.notify();
    }

    /// Show `path`, or reload it after a build, keeping the scroll position
    /// and the old page images until the new ones are drawn.
    pub fn open(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let Ok(engine) = self.engine.clone() else {
            return;
        };
        let reload = self.path.as_ref() == Some(&path);
        self.path = Some(path.clone());
        let opened = engine.open(path);
        self._open_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = opened.await;
            this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(Ok(info)) => this.set_document(info, reload, window),
                    Ok(Err(error)) => this.message = Some(format!("{error:#}").into()),
                    Err(_) => this.message = Some("The PDFium worker stopped.".into()),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Show nothing, for a project without a built PDF.
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self._open_task = None;
        self.path = None;
        self.document = None;
        self.message = None;
        for image in self.pages.drain(..).filter_map(|slot| slot.image) {
            window.drop_image(image).ok();
        }
        self.list_state.reset(0);
        cx.notify();
    }

    fn set_document(&mut self, info: DocumentInfo, reload: bool, window: &mut Window) {
        let scroll = self.list_state.logical_scroll_top();
        let count = info.page_sizes.len();
        if reload && self.pages.len() == count {
            for slot in &mut self.pages {
                slot.pending = None;
            }
        } else {
            let old = std::mem::replace(
                &mut self.pages,
                (0..count).map(|_| PageSlot::default()).collect(),
            );
            for image in old.into_iter().filter_map(|slot| slot.image) {
                window.drop_image(image).ok();
            }
        }
        self.list_state.reset(count);
        if reload && scroll.item_ix < count {
            self.list_state.scroll_to(scroll);
        }
        self.document = Some(info);
        self.message = None;
        self.page_bounds.borrow_mut().clear();
        self.scroll_to_mark();
    }

    fn set_zoom(&mut self, zoom: f32, cx: &mut Context<Self>) {
        self.zoom = zoom.clamp(0.25, 4.0);
        self.list_state.remeasure();
        cx.notify();
    }

    /// The page box width in logical pixels at the current zoom.
    fn page_width(&self) -> Pixels {
        let available = self.viewport_width - px(2. * PAGE_INSET);
        available.max(px(200.)) * self.zoom
    }

    fn render_page(
        &mut self,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(document) = &self.document else {
            return div().into_any_element();
        };
        let generation = document.generation;
        let (width_pt, height_pt) = document.page_sizes[ix];
        let width = self.page_width();
        let height = width * (height_pt / width_pt.max(1.));
        let width_px = (f32::from(width) * window.scale_factor()).round() as u32;

        let wanted = (width_px, generation);
        let slot = &mut self.pages[ix];
        if slot.drawn != Some(wanted) && slot.pending != Some(wanted) {
            slot.pending = Some(wanted);
            self.request_render(ix, wanted, window, cx);
        }

        let bounds = self.page_bounds.clone();
        let scale = f32::from(width) / width_pt.max(1.);
        if let Some(mark) = self
            .sync_mark
            .as_mut()
            .filter(|mark| mark.page == ix && !mark.drawn)
        {
            mark.drawn = true;
            let id = mark.id;
            self.mark_drawn(id, cx);
        }
        let palette = cx.palette();
        let mark = self
            .sync_mark
            .filter(|mark| mark.page == ix)
            .map(|mark| sync_mark(mark, scale, palette));
        let page_number = ix as u32 + 1;
        let page = div()
            .relative()
            .w(width)
            .h(height)
            .bg(palette.pdf_page)
            .shadow(elevation::pdf_page(palette))
            .when_some(self.pages[ix].image.clone(), |page, image| {
                page.child(img(image).size_full())
            })
            .child(
                canvas(
                    move |page_box, _, _| {
                        bounds.borrow_mut().insert(ix, page_box);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
            .children(mark)
            // Reverse SyncTeX: a double-click reports the point, in PDF
            // points from the page's top-left corner.
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                    if event.click_count != 2 {
                        return;
                    }
                    let Some(page_box) = this.page_bounds.borrow().get(&ix).copied() else {
                        return;
                    };
                    let to_points = |offset: Pixels| (f32::from(offset) / scale) as f64;
                    let x = to_points(event.position.x - page_box.origin.x);
                    let y = to_points(event.position.y - page_box.origin.y);
                    cx.emit(PdfEvent::SourceAt {
                        page: page_number,
                        x: (x * 1000.).round() / 1000.,
                        y: (y * 1000.).round() / 1000.,
                    });
                }),
            );
        div()
            .w_full()
            .flex()
            .justify_center()
            .pt(px(if ix == 0 { PAGE_INSET } else { PAGE_GAP }))
            .child(page)
            .into_any_element()
    }

    /// The pages on screen, from the scroll position and the page heights.
    fn visible_pages(&self) -> Range<usize> {
        let Some(document) = &self.document else {
            return 0..0;
        };
        let top = self.list_state.logical_scroll_top();
        let viewport = self.list_state.viewport_bounds().size.height + top.offset_in_item;
        let width = self.page_width();
        let mut covered = px(0.);
        let mut end = top.item_ix;
        while end < document.page_sizes.len() && covered < viewport {
            let (width_pt, height_pt) = document.page_sizes[end];
            covered += width * (height_pt / width_pt.max(1.)) + px(PAGE_GAP);

            end += 1;
        }
        top.item_ix..end.max(top.item_ix + 1)
    }

    /// Free the images of pages far from the screen, so a long document keeps
    /// a handful of pages in memory and in the GPU atlas however far it is
    /// scrolled.
    fn evict_offscreen(&mut self, window: &mut Window) {
        let visible = self.visible_pages();
        let keep = visible.start.saturating_sub(KEEP_AROUND)..visible.end + KEEP_AROUND;
        for (page, slot) in self.pages.iter_mut().enumerate() {
            if keep.contains(&page) {
                continue;
            }
            slot.pending = None;
            if let Some(image) = slot.image.take() {
                slot.drawn = None;
                window.drop_image(image).ok();
            }
        }
    }

    fn request_render(
        &mut self,
        ix: usize,
        (width_px, generation): (u32, u64),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Ok(engine) = self.engine.clone() else {
            return;
        };
        let rendered = engine.render(generation, ix, width_px);
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(page)) = rendered.await else {
                return;
            };
            this.update_in(cx, |this, window, cx| {
                let Some(slot) = this.pages.get_mut(page.page) else {
                    return;
                };
                if slot.pending != Some((page.width_px, page.generation)) {
                    window.drop_image(page.image).ok();
                    return;
                }
                if let Some(old) = slot.image.replace(page.image) {
                    window.drop_image(old).ok();
                }
                slot.drawn = Some((page.width_px, page.generation));
                slot.pending = None;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl EventEmitter<PanelEvent> for PdfPanel {}
impl EventEmitter<PdfEvent> for PdfPanel {}

/// The mark on a page where a jump from the source landed: an accent box
/// over the source's box (at least 18 by 12), on the compact corner, held
/// for 1.44 s and then faded on the slow exit tier.
fn sync_mark(mark: SyncMark, scale: f32, palette: &lattice_ui::Palette) -> AnyElement {
    let accent = palette.accent;
    let wash = gpui::Hsla {
        a: accent.a * 0.16,
        ..accent
    };
    let hold = SYNC_MARK_HOLD.as_secs_f32();
    let fade = lattice_ui::Motion::SlowExit.duration().as_secs_f32();
    let total = hold + fade;
    div()
        .absolute()
        .left(px(mark.x * scale))
        .top(px(mark.y * scale))
        .w(px((mark.width * scale).max(18.)))
        .h(px((mark.height * scale).max(12.)))
        .border_2()
        .border_color(accent)
        .rounded(px(4.))
        .bg(wash)
        .with_animation(
            ("pdf-sync-mark", mark.id),
            Animation::new(Duration::from_secs_f32(total)),
            move |this, t| {
                let elapsed = t * total;
                let out = ((elapsed - hold) / fade).clamp(0., 1.);
                this.opacity(1. - lattice_ui::Motion::SlowExit.sample(out))
            },
        )
        .into_any_element()
}

impl Focusable for PdfPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for PdfPanel {
    fn panel_name(&self) -> &'static str {
        "PdfPanel"
    }

    fn closable(&self, _: &App) -> bool {
        false
    }
}

impl PdfPanel {
    /// The page at the top of the view, 0-based.
    fn current_page(&self) -> usize {
        self.list_state.logical_scroll_top().item_ix
    }

    fn go_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if page < self.pages.len() {
            self.list_state.scroll_to(gpui::ListOffset {
                item_ix: page,
                offset_in_item: px(0.),
            });
            cx.notify();
        }
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let count = self.pages.len();
        let current = self.current_page();
        let has_document = self.document.is_some();
        let nav = |id: &'static str, icon: Icon| IconButton::new(id, icon).frame(px(24.), px(28.));
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .h(px(40.))
            .px(px(6.))
            .border_b_1()
            .border_color(palette.line)
            .children(lattice_ui::parity::bordered_probe(
                "pdf/toolbar",
                Edges {
                    bottom: px(1.),
                    ..Edges::default()
                },
            ))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(1.))
                    .child(
                        nav("pdf-previous", Icon::CHEVRON_LEFT)
                            .disabled(!has_document || current == 0)
                            .tooltip("Previous page")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.go_to_page(current.saturating_sub(1), cx)
                            })),
                    )
                    .child({
                        // The app's page value: 44 by 28 on the compact
                        // corner, "1 / 4" as three runs of text.
                        let (page, total): (SharedString, SharedString) = if has_document {
                            ((current + 1).to_string().into(), count.to_string().into())
                        } else {
                            ("–".into(), "–".into())
                        };
                        let run = |slot: usize, text: SharedString, shown: SharedString| {
                            div()
                                .children(lattice_ui::parity::text_probe("pdf/page", slot, text))
                                .child(shown)
                        };
                        div()
                            .w(px(44.))
                            .h(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .whitespace_nowrap()
                            .text_role(TextRole::Micro, cx)
                            .font_weight(lattice_ui::tokens::FONT_WEIGHT_REGULAR)
                            .text_color(palette.text_secondary)
                            .children(lattice_ui::parity::probe("pdf/page"))
                            .child(run(0, page.clone(), page))
                            .child(run(1, "/".into(), " / ".into()))
                            .child(run(2, total.clone(), total))
                    })
                    .child(
                        nav("pdf-next", Icon::CHEVRON_RIGHT)
                            .disabled(!has_document || current + 1 >= count)
                            .tooltip("Next page")
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.go_to_page(current + 1, cx)),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        nav("pdf-outline", Icon::LIST_TREE)
                            .tooltip("Outline — not in the GPUI preview yet"),
                    )
                    .child(
                        div().flex_1().min_w_0().child(
                            SearchField::new("pdf-find", "Find in PDF")
                                .parity("pdf/find")
                                .tooltip("Find in PDF — not in the GPUI preview yet"),
                        ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(2.))
                    .child(
                        nav("pdf-locate", Icon::LOCATE_FIXED)
                            .disabled(!has_document)
                            .tooltip("Reveal cursor in PDF")
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(ForwardSync), cx)
                            }),
                    )
                    .child(div().w(px(1.)).h(px(16.)).bg(palette.line_strong))
                    .child(
                        nav("pdf-fit", Icon::RECTANGLE_HORIZONTAL)
                            .on((self.zoom - 1.0).abs() < f32::EPSILON)
                            .tooltip("Fit width")
                            .on_click(cx.listener(|this, _, _, cx| this.set_zoom(1.0, cx))),
                    ),
            )
    }
}

impl Panel for PdfPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some("PDF".into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        match &self.path {
            Some(path) => format!(
                "PDF · {}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
            None => "PDF".to_string(),
        }
    }

    fn dropdown_menu(
        &mut self,
        menu: PopupMenu,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> PopupMenu {
        let zoom = |label: &'static str, factor: Option<f32>| {
            let view = cx.entity().downgrade();
            PopupMenuItem::new(label).on_click(move |_, _, cx| {
                view.update(cx, |this, cx| {
                    let zoom = factor.map_or(1.0, |factor| this.zoom * factor);
                    this.set_zoom(zoom, cx)
                })
                .ok();
            })
        };
        menu.item(zoom("Zoom in", Some(ZOOM_STEP)))
            .item(zoom("Zoom out", Some(1. / ZOOM_STEP)))
            .item(zoom("Fit width", None))
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for PdfPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.evict_offscreen(window);
        let width = self.list_state.viewport_bounds().size.width;
        if width != self.viewport_width {
            self.viewport_width = width;
            self.list_state.remeasure();
            self.scroll_to_mark();
        }
        let body = if let Err(error) = &self.engine {
            centered_message(error.clone(), cx).into_any_element()
        } else if let Some(message) = &self.message {
            centered_message(message.clone(), cx).into_any_element()
        } else if self.document.is_none() {
            centered_message(
                "Build the project, or pick a PDF in the file tree".into(),
                cx,
            )
            .into_any_element()
        } else {
            list(
                self.list_state.clone(),
                cx.processor(|this, ix, window, cx| this.render_page(ix, window, cx)),
            )
            .size_full()
            .pb(px(PAGE_INSET))
            .into_any_element()
        };
        let palette = cx.palette().clone();
        div()
            .id("pdf-panel")
            .track_focus(&self.focus_handle)
            .size_full()
            .flex()
            .flex_col()
            .bg(palette.editor)
            .rounded_b(PANEL_RADIUS)
            .child(self.toolbar(cx))
            .child(div().flex_1().min_h_0().child(body))
    }
}

fn centered_message(message: SharedString, cx: &App) -> impl IntoElement {
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .p_4()
        .text_role(TextRole::Body, cx)
        .text_color(cx.palette().text_secondary)
        .child(message)
}
