//! The PDF preview: pages laid out from their sizes at once, drawn by PDFium
//! only when they scroll into view, and redrawn in place after a build.

use std::{ops::Range, path::PathBuf, rc::Rc, sync::Arc};

use gpui::{
    AnyElement, App, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, ListAlignment, ListState, ParentElement as _, Pixels, Render, RenderImage,
    SharedString, Styled as _, Task, Window, div, img, list, prelude::*, px,
};
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Sizable as _,
    button::{Button, ButtonVariants as _},
    dock::{BasePanel, Panel, PanelEvent},
};

use super::engine::{DocumentInfo, PdfEngine};

/// Pages kept drawn on each side of the visible ones.
const KEEP_AROUND: usize = 2;
const PAGE_GAP: f32 = 12.;
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
    _open_task: Option<Task<()>>,
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
            _open_task: None,
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn page_count(&self) -> usize {
        self.pages.len()
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
    }

    fn set_zoom(&mut self, zoom: f32, cx: &mut Context<Self>) {
        self.zoom = zoom.clamp(0.25, 4.0);
        self.list_state.remeasure();
        cx.notify();
    }

    /// The page box width in logical pixels at the current zoom.
    fn page_width(&self) -> Pixels {
        let available = self.viewport_width - px(2. * PAGE_GAP);
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

        let page = div()
            .w(width)
            .h(height)
            .bg(gpui::white())
            .shadow_sm()
            .when_some(self.pages[ix].image.clone(), |page, image| {
                page.child(img(image).size_full())
            });
        div()
            .w_full()
            .flex()
            .justify_center()
            .pt(px(PAGE_GAP))
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

impl Panel for PdfPanel {
    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        match &self.path {
            Some(path) => format!(
                "PDF · {}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
            None => "PDF".to_string(),
        }
    }

    fn toolbar_buttons(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Option<Vec<Button>> {
        Some(vec![
            Button::new("pdf-zoom-out")
                .icon(IconName::ZoomOut)
                .ghost()
                .xsmall()
                .tooltip("Zoom out")
                .on_click(cx.listener(|this, _, _, cx| this.set_zoom(this.zoom / ZOOM_STEP, cx))),
            Button::new("pdf-fit")
                .label(format!("{:.0}%", self.zoom * 100.))
                .ghost()
                .xsmall()
                .tooltip("Fit width")
                .on_click(cx.listener(|this, _, _, cx| this.set_zoom(1.0, cx))),
            Button::new("pdf-zoom-in")
                .icon(IconName::ZoomIn)
                .ghost()
                .xsmall()
                .tooltip("Zoom in")
                .on_click(cx.listener(|this, _, _, cx| this.set_zoom(this.zoom * ZOOM_STEP, cx))),
        ])
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
        }
        let body = if let Err(error) = &self.engine {
            centered_message(error.clone()).into_any_element()
        } else if let Some(message) = &self.message {
            centered_message(message.clone()).into_any_element()
        } else if self.document.is_none() {
            centered_message("Build the project, or pick a PDF in the file tree.".into())
                .into_any_element()
        } else {
            list(
                self.list_state.clone(),
                cx.processor(|this, ix, window, cx| this.render_page(ix, window, cx)),
            )
            .size_full()
            .pb(px(PAGE_GAP))
            .into_any_element()
        };
        div()
            .id("pdf-panel")
            .track_focus(&self.focus_handle)
            .size_full()
            .bg(cx.theme().muted)
            .child(body)
    }
}

fn centered_message(message: SharedString) -> impl IntoElement {
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .p_4()
        .text_sm()
        .child(message)
}
