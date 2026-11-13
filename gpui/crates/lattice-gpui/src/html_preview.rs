//! An HTML file's Preview: the Tauri app's `HtmlPreview`
//! (`src/canvas/html-preview.tsx`) as a webview island, the first island in
//! the GPUI app and the proof of `lattice-webview`.
//!
//! The page (`assets/islands/html-preview/`) builds the same sandboxed
//! document the Tauri app builds and shows it in an opaque-origin frame. The
//! host sends it the editor's text 180 ms after the last keystroke, as the
//! Tauri app settles it; grants it the project images and pages the document
//! names, which the island's protocol then serves; and draws, above the page
//! on GPUI's overlay surface, what the Tauri app draws over its iframe:
//!
//! - the zoom controls at the bottom left (50% to 200% in steps of 10, or a
//!   typed percentage; `ZoomControls`), applied as the page's CSS `zoom`;
//! - Lattice's scrollbar on the right edge, driven by the scroll metrics the
//!   page reports, revealed on the bar and for 500 ms after a scroll (the
//!   page's frame keeps the pointer, so the bar cannot reveal over the area);
//! - until the page's first load, the HTML page skeleton (`DocumentSkeleton`
//!   with `page="html"`), on the loading reveal clock.
//!
//! The scroll position and zoom are the view state the Tauri app files per
//! file (`HtmlFileViewState`): they survive the page's reloads (each edit
//! republishes the document), the island's hibernation and a switch to
//! Source and back.

use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    rc::Rc,
    time::{Duration, Instant},
};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, EventEmitter,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Pixels, Point, Render,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, canvas, deferred,
    div, point, prelude::FluentBuilder as _, px, size,
};
use gpui_kit::{
    base::ScrollbarHandle,
    component::input::{Input, InputEvent, InputState},
};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::IconButton,
    reveal::loading_opacity,
    scrollbar::{FluidScrollbar, MIN_THUMB, ScrollbarFeel, TRACK, TrackPress},
    shape::RADIUS_SURFACE,
};
use lattice_webview::{Bundle, BundleFile, FileScope, Island, IslandConfig, IslandEvent};
use serde_json::{Value, json};

/// The preview's zoom bounds and step (`HTML_PREVIEW_MIN_SCALE`, `…MAX…`,
/// `ZoomControls`' step).
pub const MIN_SCALE: f32 = 0.5;
pub const MAX_SCALE: f32 = 2.;
const ZOOM_STEP: f32 = 0.1;
/// How long the editor's text settles before the page gets it.
const SOURCE_SETTLE: Duration = Duration::from_millis(180);
/// The external scrollbar's feel (`html-preview-scrollbar`): the frame keeps
/// the pointer, so only the bar itself reveals it, and it lingers 500 ms
/// after a scroll.
const SCROLLBAR_FEEL: ScrollbarFeel = ScrollbarFeel {
    reveal_on_area: false,
    linger: Duration::from_millis(500),
    min_thumb: MIN_THUMB,
    press: TrackPress::CenterThumb,
};

static BUNDLE: &[BundleFile] = &[
    BundleFile {
        path: "html-preview/index.html",
        bytes: include_bytes!("../assets/islands/html-preview/index.html"),
    },
    BundleFile {
        path: "html-preview/html-preview.js",
        bytes: include_bytes!("../assets/islands/html-preview/html-preview.js"),
    },
];

/// What the Tauri app keeps per HTML file (`HtmlFileViewState`).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlViewState {
    pub scale: f32,
    pub scroll_top: f32,
    pub scroll_range: f32,
}

impl Default for HtmlViewState {
    fn default() -> Self {
        Self {
            scale: 1.,
            scroll_top: 0.,
            scroll_range: 0.,
        }
    }
}

/// The page's scroll as it last reported it, in its CSS pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
pub struct ScrollMetrics {
    pub client_height: f32,
    pub scroll_height: f32,
    pub scroll_top: f32,
}

/// The scrollbar's view of the page: the island's bounds as the viewport,
/// the page's scroll scaled into them. A drag of the thumb asks the page to
/// scroll.
#[derive(Clone)]
struct PageScroll {
    shared: Rc<RefCell<(Bounds<Pixels>, ScrollMetrics)>>,
    requests: mpsc::UnboundedSender<f32>,
}

impl PageScroll {
    /// Page pixels per window pixel along the viewport.
    fn ratio(&self) -> f32 {
        let (bounds, metrics) = *self.shared.borrow();
        if metrics.client_height > 0. && bounds.size.height > px(0.) {
            f32::from(bounds.size.height) / metrics.client_height
        } else {
            1.
        }
    }
}

impl ScrollbarHandle for PageScroll {
    fn viewport_bounds(&self) -> Bounds<Pixels> {
        self.shared.borrow().0
    }

    fn offset(&self) -> Point<Pixels> {
        let scroll_top = self.shared.borrow().1.scroll_top;
        point(px(0.), px(-scroll_top * self.ratio()))
    }

    fn set_offset(&self, offset: Point<Pixels>) {
        let ratio = self.ratio();
        let scroll_top = (-f32::from(offset.y) / ratio).max(0.);
        self.shared.borrow_mut().1.scroll_top = scroll_top;
        self.requests.unbounded_send(scroll_top).ok();
    }

    fn content_size(&self) -> gpui::Size<Pixels> {
        let (bounds, metrics) = *self.shared.borrow();
        size(bounds.size.width, px(metrics.scroll_height * self.ratio()))
    }
}

/// What the preview tells its document.
pub enum HtmlPreviewEvent {
    /// The view state changed (zoom, or the page settled at a position).
    ViewState(HtmlViewState),
}

pub struct HtmlPreview {
    island: Entity<Island>,
    relative: String,
    files: Option<FileScope>,
    /// The editor's text, and the text the page has.
    source: String,
    sent: Option<String>,
    view: HtmlViewState,
    scroll: PageScroll,
    /// The page has shown its first document.
    loaded: bool,
    opened: Instant,
    zoom_input: Entity<InputState>,
    zoom_editing: bool,
    settle: Option<Task<()>>,
    _scroll_requests: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<HtmlPreviewEvent> for HtmlPreview {}

impl HtmlPreview {
    pub fn new(
        root: &Path,
        relative: String,
        source: String,
        view: HtmlViewState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let files = FileScope::new(root)
            .inspect_err(|error| log::warn!("HTML preview: {error:#}"))
            .ok();
        let config = IslandConfig {
            name: "html-preview".into(),
            entry: "html-preview/index.html",
            bundle: Bundle(BUNDLE),
            files: files.clone(),
            // An authored page is on white whatever the theme.
            ground: Some(gpui::white()),
            reveal_on_ready: false,
        };
        let island = cx.new(|cx| Island::new(config, window, cx));
        let (requests, mut receiver) = mpsc::unbounded::<f32>();
        let scroll_requests = cx.spawn(async move |this, cx| {
            while let Some(scroll_top) = receiver.next().await {
                if this
                    .update(cx, |this, cx| this.set_scroll_top(scroll_top, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        let zoom_input = cx.new(|cx| InputState::new(window, cx));
        let subscriptions = vec![
            cx.subscribe_in(&island, window, Self::on_island),
            // A webview that could not be built changes what the preview shows.
            cx.observe(&island, |_, _, cx| cx.notify()),
            cx.subscribe_in(
                &zoom_input,
                window,
                |this, _, event, window, cx| match event {
                    InputEvent::PressEnter { .. } => this.commit_zoom(window, cx),
                    InputEvent::Blur => this.commit_zoom(window, cx),
                    _ => {}
                },
            ),
        ];
        Self {
            island,
            relative,
            files,
            source,
            sent: None,
            view,
            scroll: PageScroll {
                shared: Rc::default(),
                requests,
            },
            loaded: false,
            opened: Instant::now(),
            zoom_input,
            zoom_editing: false,
            settle: None,
            _scroll_requests: scroll_requests,
            _subscriptions: subscriptions,
        }
    }

    pub fn island(&self) -> &Entity<Island> {
        &self.island
    }

    pub fn view_state(&self) -> HtmlViewState {
        self.view
    }

    pub fn scroll_metrics(&self) -> ScrollMetrics {
        self.scroll.shared.borrow().1
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    /// Show or hide the preview; see [`Island::set_active`].
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        self.island
            .update(cx, |island, cx| island.set_active(active, cx));
        if active && !self.loaded {
            self.opened = Instant::now();
        }
    }

    /// The editor's text changed: the page gets it once typing settles.
    pub fn set_source(&mut self, source: String, cx: &mut Context<Self>) {
        if source == self.source {
            return;
        }
        self.source = source;
        self.settle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SOURCE_SETTLE).await;
            this.update(cx, |this, cx| this.publish(cx)).ok();
        }));
    }

    /// The project's files changed on disk: the page loads its images again.
    pub fn assets_changed(&mut self, cx: &mut Context<Self>) {
        self.island.update(cx, |island, _| {
            island.post("html:assets-changed", Value::Null);
        });
    }

    /// Send the editor's text now rather than after it settles.
    pub fn publish_now(&mut self, cx: &mut Context<Self>) {
        self.settle = None;
        self.publish(cx);
    }

    fn publish(&mut self, cx: &mut Context<Self>) {
        if self.sent.as_ref() == Some(&self.source) {
            return;
        }
        let source = self.source.clone();
        let relative = self.relative.clone();
        let view = self.view;
        self.island.update(cx, |island, _| {
            island.post(
                "html:render",
                json!({
                    "source": source,
                    "path": relative,
                    "relativeLinkTitle": "Relative project links are unavailable in this preview",
                    "scale": view.scale,
                    "scrollTop": view.scroll_top,
                }),
            );
        });
        self.sent = Some(self.source.clone());
    }

    fn on_island(
        &mut self,
        _: &Entity<Island>,
        event: &IslandEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            // A new page (first open, or after a hibernation): send it all.
            IslandEvent::Ready => {
                self.sent = None;
                self.publish(cx);
            }
            IslandEvent::Hibernated => {
                self.loaded = false;
                self.sent = None;
                cx.notify();
            }
            IslandEvent::Message { kind, payload } => self.on_message(kind, payload, cx),
            IslandEvent::Request { id, kind, payload } if kind == "html:resources" => {
                let answer = self.resources(payload, cx);
                let id = *id;
                self.island
                    .update(cx, |island, _| island.respond(id, Ok(answer)));
            }
            IslandEvent::Request { id, kind, .. } => {
                let (id, kind) = (*id, kind.clone());
                self.island.update(cx, |island, _| {
                    island.respond(id, Err(format!("unknown request {kind}")))
                });
            }
            _ => {}
        }
    }

    fn on_message(&mut self, kind: &str, payload: &Value, cx: &mut Context<Self>) {
        match kind {
            "html:loaded" => {
                self.loaded = true;
                self.island.update(cx, |island, cx| island.reveal(cx));
                cx.notify();
            }
            "html:scroll" => {
                let number =
                    |key: &str| payload.get(key).and_then(Value::as_f64).unwrap_or(0.) as f32;
                let metrics = ScrollMetrics {
                    client_height: number("clientHeight"),
                    scroll_height: number("scrollHeight"),
                    scroll_top: number("scrollTop"),
                };
                self.scroll.shared.borrow_mut().1 = metrics;
                if payload.get("settled").and_then(Value::as_bool) == Some(true) {
                    self.view.scroll_top = metrics.scroll_top;
                    self.view.scroll_range = number("scrollRange");
                    cx.emit(HtmlPreviewEvent::ViewState(self.view));
                }
                cx.notify();
            }
            "html:open-external" => {
                if let Some(href) = payload.get("href").and_then(Value::as_str)
                    && is_external_link(href)
                {
                    cx.open_url(href);
                }
            }
            _ => {}
        }
    }

    /// Grant the images the document names and read the pages it embeds
    /// (`onLoadAsset`); a path that is not a readable project file gets
    /// nothing, and the page leaves it as written.
    fn resources(&mut self, payload: &Value, cx: &mut Context<Self>) -> Value {
        let mut answer = serde_json::Map::new();
        let paths = payload
            .get("paths")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let Some(files) = self.files.clone() else {
            return Value::Object(answer);
        };
        for path in paths.iter().filter_map(Value::as_str) {
            let Ok(absolute) = files.resolve(path) else {
                continue;
            };
            if !absolute.is_file() {
                continue;
            }
            let resource = if path.to_ascii_lowercase().ends_with(".html") {
                files
                    .read_text(path)
                    .ok()
                    .map(|html| json!({ "html": html }))
            } else {
                let url = self.island.read(cx).grant(path);
                // The revision makes WebKit ask again after an edit on disk.
                let revision = std::fs::metadata(&absolute)
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_millis())
                    .unwrap_or_default();
                Some(json!({ "url": format!("{url}?v={revision}") }))
            };
            if let Some(resource) = resource {
                answer.insert(path.to_string(), resource);
            }
        }
        Value::Object(answer)
    }

    pub fn set_scale(&mut self, scale: f32, cx: &mut Context<Self>) {
        let scale = ((scale * 100.).round() / 100.).clamp(MIN_SCALE, MAX_SCALE);
        if (scale - self.view.scale).abs() < f32::EPSILON {
            return;
        }
        self.view.scale = scale;
        self.island.update(cx, |island, _| {
            island.post("html:set-zoom", json!({ "scale": scale }));
        });
        cx.emit(HtmlPreviewEvent::ViewState(self.view));
        cx.notify();
    }

    fn step_zoom(&mut self, direction: f32, cx: &mut Context<Self>) {
        // `Number((current + delta).toFixed(1))`
        let next = ((self.view.scale + direction * ZOOM_STEP) * 10.).round() / 10.;
        self.set_scale(next, cx);
    }

    pub fn set_scroll_top(&mut self, scroll_top: f32, cx: &mut Context<Self>) {
        self.island.update(cx, |island, _| {
            island.post("html:set-scroll-top", json!({ "scrollTop": scroll_top }));
        });
    }

    fn edit_zoom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.zoom_editing = true;
        let value = format!("{}", (self.view.scale * 100.).round() as i64);
        let input = self.zoom_input.clone();
        input.update(cx, |input, cx| input.set_value(value, window, cx));
        window.on_next_frame(move |window, cx| {
            input.update(cx, |input, cx| {
                input.focus(window, cx);
                input.select_all(window, cx);
            });
        });
        cx.notify();
    }

    fn commit_zoom(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if !self.zoom_editing {
            return;
        }
        self.zoom_editing = false;
        let draft = self.zoom_input.read(cx).value().to_string();
        if let Some(percent) = parse_percent(&draft) {
            self.set_scale(percent / 100., cx);
        }
        cx.notify();
    }

    fn zoom_controls(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let scale = self.view.scale;
        let mut ground = palette.raised;
        ground.a *= 0.94;
        let value = div()
            .id("html-zoom-value")
            .flex_none()
            .w(px(44.))
            .h(px(28.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .whitespace_nowrap()
            .text_role(TextRole::Micro, cx)
            .text_color(palette.text_secondary);
        let value = if self.zoom_editing {
            value
                .bg(palette.input)
                .border_1()
                .border_color(palette.field_border_hover)
                .capture_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                    if event.keystroke.key == "escape" {
                        cx.stop_propagation();
                        this.zoom_editing = false;
                        cx.notify();
                    }
                }))
                .child(
                    div().w(px(22.)).h_full().child(
                        Input::new(&self.zoom_input)
                            .appearance(false)
                            .px_0()
                            .py_0()
                            .h_full()
                            .text_size(TextRole::Micro.font_size(Default::default(), cx)),
                    ),
                )
                .child("%")
                .into_any_element()
        } else {
            value
                .cursor_text()
                .on_click(cx.listener(|this, _, window, cx| this.edit_zoom(window, cx)))
                // A wheel over the value steps the zoom, as the Tauri app's does.
                .on_scroll(cx.listener(|this, event: &gpui::ScrollEvent, window, cx| {
                    let delta = event.delta.pixel_delta(window.line_height()).y;
                    if delta != px(0.) {
                        cx.stop_propagation();
                        this.step_zoom(if delta > px(0.) { 1. } else { -1. }, cx);
                    }
                }))
                .child(format!("{}%", (scale * 100.).round() as i64))
                .into_any_element()
        };
        let _ = window;
        div()
            .id("html-zoom-controls")
            .absolute()
            .left(px(6.))
            .bottom(px(6.))
            .p(px(2.))
            .flex()
            .items_center()
            .gap(px(1.))
            .rounded(RADIUS_SURFACE)
            .bg(ground)
            .shadow(Elevation::Raised.shadows(&palette))
            .occlude()
            .children(lattice_ui::parity::probe("html/zoom"))
            .child(
                IconButton::new("html-zoom-out", Icon::ZOOM_OUT)
                    .frame(px(24.), px(28.))
                    .tooltip("Zoom out")
                    .disabled(scale <= MIN_SCALE)
                    .on_click(cx.listener(|this, _, _, cx| this.step_zoom(-1., cx))),
            )
            .child(value)
            .child(
                IconButton::new("html-zoom-in", Icon::ZOOM_IN)
                    .frame(px(24.), px(28.))
                    .tooltip("Zoom in")
                    .disabled(scale >= MAX_SCALE)
                    .on_click(cx.listener(|this, _, _, cx| this.step_zoom(1., cx))),
            )
            .into_any_element()
    }

    /// The HTML page skeleton (`document-skeleton.css`, `data-page="html"`):
    /// a white page, the column at the reading measure, a title and blocks
    /// of lines in 9% ink.
    fn skeleton(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        const BLOCKS: &[&[f32]] = &[
            &[58.],
            &[100., 97., 46.],
            &[40.],
            &[99., 100., 95., 100., 62.],
            &[98., 100., 84.],
            &[34.],
            &[100., 96., 100., 93., 100., 38.],
            &[97., 100., 71.],
        ];
        let opacity = loading_opacity("html-preview-skeleton", self.opened, window, cx);
        let ink = gpui::hsla(0., 0., 0., 0.09);
        // The typeset size (16px) and its 1.7 line.
        let size = 16.;
        let pitch = size * 1.7;
        let column = div()
            .w_full()
            .max_w(px(760. + 2. * 24.))
            .mx_auto()
            .pt(px(64.))
            .px(px(24.))
            .opacity(opacity)
            .children(BLOCKS.iter().enumerate().map(|(ix, block)| {
                if block.len() == 1 {
                    // A heading: the first is the title (1.8em at a 1.2 line).
                    let (em, line, above, below) = if ix == 0 {
                        (1.8, 1.2, 0., 0.45)
                    } else {
                        (1.4, 1.3, 1.6, 0.45)
                    };
                    let height = size * em * line;
                    let bar = size * em * line - 2. * size * em * 0.3;
                    div()
                        .mt(px(size * em * above))
                        .mb(px(size * em * below))
                        .h(px(height))
                        .flex()
                        .items_center()
                        .child(
                            div()
                                .w(gpui::relative(block[0] / 100.))
                                .h(px(bar))
                                .rounded_full()
                                .bg(ink),
                        )
                        .into_any_element()
                } else {
                    div()
                        .mb(px(size * 0.85))
                        .children(block.iter().map(|width| {
                            div().h(px(pitch)).flex().items_center().child(
                                div()
                                    .w(gpui::relative(width / 100.))
                                    .h(px(8.))
                                    .rounded_full()
                                    .bg(ink),
                            )
                        }))
                        .into_any_element()
                }
            }));
        div()
            .absolute()
            .inset_0()
            .overflow_hidden()
            .bg(gpui::white())
            .child(column)
            .into_any_element()
    }
}

impl Render for HtmlPreview {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let shared = self.scroll.shared.clone();
        let scroll = self.scroll.clone();
        let island_ready = self.loaded;
        let failure = match self.island.read(cx).state() {
            lattice_webview::IslandState::Failed(error) => Some(error.clone()),
            _ => None,
        };
        div()
            .id("html-preview")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(gpui::white())
            .children(lattice_ui::parity::probe("html/preview"))
            // The island's bounds are the scrollbar's viewport.
            .child(
                canvas(
                    move |bounds, _, _| shared.borrow_mut().0 = bounds,
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .when(!self.loaded && failure.is_none(), |this| {
                this.child(self.skeleton(window, cx))
            })
            // No webview here (WebKitGTK under Wayland, a missing WebView2
            // runtime): say so rather than load forever.
            .when_some(failure, |this, failure| {
                let palette = cx.palette().clone();
                this.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap(px(4.))
                        .px(px(24.))
                        .bg(palette.panel)
                        .child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text)
                                .child("The HTML preview could not start."),
                        )
                        .child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .text_center()
                                .child(failure),
                        ),
                )
            })
            .child(self.island.clone())
            // Above the page, on GPUI's overlay surface. Only the bar's track
            // and the zoom controls take the pointer there: the overlay
            // claims any point one of its hitboxes covers, so nothing in it
            // may cover the page.
            .when(island_ready, |this| {
                this.child(
                    deferred(
                        div()
                            .absolute()
                            .inset_0()
                            .child(
                                div()
                                    .absolute()
                                    .top_0()
                                    .bottom_0()
                                    .right_0()
                                    .w(TRACK)
                                    .child(
                                        FluidScrollbar::vertical("html-preview-scrollbar", &scroll)
                                            .feel(SCROLLBAR_FEEL),
                                    ),
                            )
                            .child(self.zoom_controls(window, cx)),
                    )
                    .with_priority(0),
                )
            })
    }
}

/// A typed percentage ("125", "125%", " 80 "); positive only.
pub fn parse_percent(draft: &str) -> Option<f32> {
    let value: f32 = draft.trim().trim_end_matches('%').trim().parse().ok()?;
    (value.is_finite() && value > 0.).then_some(value)
}

/// The links the page may hand to the system browser.
fn is_external_link(href: &str) -> bool {
    let lower = href.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

/// The view states of HTML files this session, by path, so a document
/// reopened, or its preview rebuilt, comes back where it was read.
#[derive(Default)]
pub struct HtmlViewStates(pub std::collections::HashMap<PathBuf, HtmlViewState>);

impl gpui::Global for HtmlViewStates {}

pub fn saved_view_state(path: &Path, cx: &App) -> HtmlViewState {
    cx.try_global::<HtmlViewStates>()
        .and_then(|states| states.0.get(path).copied())
        .unwrap_or_default()
}

pub fn save_view_state(path: &Path, view: HtmlViewState, cx: &mut App) {
    cx.default_global::<HtmlViewStates>()
        .0
        .insert(path.to_path_buf(), view);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_percentages() {
        assert_eq!(parse_percent(" 125% "), Some(125.));
        assert_eq!(parse_percent("80"), Some(80.));
        assert_eq!(parse_percent("0"), None);
        assert_eq!(parse_percent("abc"), None);
    }

    #[test]
    fn only_web_and_mail_links_leave_the_app() {
        assert!(is_external_link("https://example.com"));
        assert!(is_external_link("MAILTO:a@b.c"));
        assert!(!is_external_link("file:///etc/passwd"));
        assert!(!is_external_link("javascript:alert(1)"));
    }
}
