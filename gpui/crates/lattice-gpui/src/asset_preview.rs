//! A project image, or any other binary file, opened as a document: the
//! Tauri app's `ProjectAssetPreview` (`src/canvas/project-asset-preview.tsx`,
//! styled by `.asset-preview*` in `src/styles/editor-workspace.css`).
//!
//! The Project tree opens a figure (`.png`, `.jpg`, `.jpeg`, `.svg`, `.eps`,
//! `.webp`) and anything lattice-core files as binary or a link here, as the
//! Tauri tree's `onAsset` does; a PDF keeps its own viewer. The bytes come
//! from lattice-core's `read_asset`, the Tauri app's `read_project_asset`, so
//! a file it refuses (too large, not UTF-8 source, text) is refused with the
//! same words, as a notice, and its tab closes.
//!
//! What it shows is what the Tauri app shows:
//!
//! - a 38px heading with the image mark, the file's path and, for a PNG,
//!   JPEG, WebP or SVG, the zoom controls (`ZoomControls`: Zoom out, the
//!   percentage, typed or stepped by the wheel over it, Zoom in, 30% to 500%
//!   in steps of 10);
//! - the stage, a checkerboard the image sits on 28px in from its edges:
//!   at 100% the image is fitted inside the stage (never past its pixel size,
//!   never wider than 1100px), and the zoom scales that fitted size, the
//!   stage scrolling both ways once it is larger; ⌘-wheel / Ctrl-wheel and a
//!   pinch zoom it;
//! - for every other format (EPS, GIF, a font, an archive, anything binary),
//!   the file mark and "This format cannot be rendered in the preview".
//!
//! Each file's zoom and scroll are kept for the session (`ImageFileViewState`),
//! so the image opens again where it was left.

use std::{
    cell::Cell,
    collections::HashMap,
    path::{Path, PathBuf},
    rc::Rc,
    sync::Arc,
};

use base64::Engine as _;
use gpui::{
    AnyElement, App, AppContext as _, Bounds, BoxShadow, Context, DispatchPhase, Entity,
    EventEmitter, FocusHandle, Focusable, HitboxBehavior, ImageFormat, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, PinchEvent, Pixels, Point, Render, RenderImage,
    ScrollDelta, ScrollEvent, ScrollHandle, SharedString, Size, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, Window, canvas, div, fill, img, point,
    prelude::FluentBuilder as _, px, size,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    input::{Input, InputEvent, InputState},
};
use lattice_core::project::{self as core_project, AssetContent};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, components::IconButton,
    interaction::mix, scrollbar::FluidScrollbar,
};

/// The image's zoom bounds (`IMAGE_MIN_SCALE`, `IMAGE_MAX_SCALE`) and
/// `ZoomControls`' step.
pub const MIN_SCALE: f32 = 0.3;
pub const MAX_SCALE: f32 = 5.;
const ZOOM_STEP: f32 = 0.1;
/// The stage's padding around the image (`.asset-preview-stage-content`).
const STAGE_PADDING: f32 = 28.;
/// The widest the image is fitted at 100% (`max-width: min(100%, 1100px)`).
const FIT_MAX_WIDTH: f32 = 1100.;
/// The checkerboard's square (`background-size: 20px 20px`, two per tile).
const CHECKER: f32 = 10.;
/// An SVG is rasterized once at this many pixels per CSS pixel, so it stays
/// sharp on a Retina screen up to 100% and past it on a standard one.
const SVG_RASTER_SCALE: f32 = 2.;

/// What the Tauri app keeps per image file (`ImageFileViewState`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImageViewState {
    pub scale: f32,
    pub scroll: Point<Pixels>,
}

impl Default for ImageViewState {
    fn default() -> Self {
        Self {
            scale: 1.,
            scroll: Point::default(),
        }
    }
}

/// The view states of images this session, by path.
#[derive(Default)]
struct ImageViewStates(HashMap<PathBuf, ImageViewState>);

impl gpui::Global for ImageViewStates {}

/// What the preview shows once the file is read.
enum Shown {
    Loading,
    /// The decoded image and its natural size in CSS pixels.
    Image {
        image: Arc<RenderImage>,
        natural: Size<f32>,
    },
    /// A format the preview does not draw.
    Unsupported,
}

pub enum AssetPanelEvent {
    /// lattice-core refused the file: the shell says why and closes the tab.
    Failed(String),
}

pub struct AssetPanel {
    focus_handle: FocusHandle,
    path: PathBuf,
    relative: String,
    shown: Shown,
    view: ImageViewState,
    scroll: ScrollHandle,
    /// The stage's bounds as last laid out, which the fit is measured in.
    stage: Rc<Cell<Bounds<Pixels>>>,
    /// The saved scroll is put back once the image is laid out at its size.
    restore_scroll: bool,
    zoom_input: Entity<InputState>,
    zoom_editing: bool,
    _load: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl AssetPanel {
    /// The preview of `relative` in the project at `root`, read off the main
    /// thread.
    pub fn new(
        root: PathBuf,
        relative: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let path = root.join(&relative);
        let zoom_input = cx.new(|cx| InputState::new(window, cx));
        let subscriptions = vec![
            cx.subscribe_in(&zoom_input, window, |this, _, event, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                    this.commit_zoom(window, cx);
                }
            }),
            // The image's texture leaves every window's atlas with the panel,
            // and its place is filed for the next time it opens.
            cx.on_release(|this, cx| {
                let view = ImageViewState {
                    scale: this.view.scale,
                    scroll: this.scroll.offset(),
                };
                cx.default_global::<ImageViewStates>()
                    .0
                    .insert(this.path.clone(), view);
                if let Shown::Image { image, .. } =
                    std::mem::replace(&mut this.shown, Shown::Loading)
                {
                    cx.drop_image(image, None);
                }
            }),
        ];
        let view = cx
            .try_global::<ImageViewStates>()
            .and_then(|states| states.0.get(&path).copied())
            .unwrap_or_default();
        let load = Self::load(root, relative.clone(), cx);
        Self {
            focus_handle: cx.focus_handle(),
            path,
            relative,
            shown: Shown::Loading,
            view,
            scroll: ScrollHandle::new(),
            stage: Rc::default(),
            restore_scroll: true,
            zoom_input,
            zoom_editing: false,
            _load: load,
            _subscriptions: subscriptions,
        }
    }

    fn load(root: PathBuf, relative: String, cx: &mut Context<Self>) -> Task<()> {
        let svg_renderer = cx.svg_renderer();
        let read = cx.background_spawn(async move {
            let preview = core_project::read_asset(&root, &relative)?;
            Ok::<_, String>(decode(&preview.mime_type, preview.content, &svg_renderer))
        });
        cx.spawn(async move |this, cx| {
            let read = read.await;
            this.update(cx, |this, cx| {
                match read {
                    Ok(Some((image, natural))) => this.shown = Shown::Image { image, natural },
                    Ok(None) => this.shown = Shown::Unsupported,
                    Err(error) => cx.emit(AssetPanelEvent::Failed(error)),
                }
                cx.notify();
            })
            .ok();
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn relative(&self) -> &str {
        &self.relative
    }

    /// The file moved (a rename or a move in the tree): the tab follows it.
    pub fn moved_to(&mut self, root: &Path, relative: String, cx: &mut Context<Self>) {
        self.path = root.join(&relative);
        self.relative = relative;
        cx.notify();
    }

    /// The zoom, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn scale(&self) -> f32 {
        self.view.scale
    }

    /// The image's natural size and the size it is drawn at, once it is
    /// read; `None` while loading or for a format it does not draw.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn image_sizes(&self) -> Option<(Size<f32>, Size<f32>)> {
        match &self.shown {
            Shown::Image { natural, .. } => Some((*natural, self.drawn_size(*natural))),
            _ => None,
        }
    }

    /// Whether it shows the "cannot be rendered" fallback, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn unsupported(&self) -> bool {
        matches!(self.shown, Shown::Unsupported)
    }

    pub fn set_scale(&mut self, scale: f32, cx: &mut Context<Self>) {
        // `Number(x.toFixed(3))`, within bounds.
        let scale = ((scale * 1000.).round() / 1000.).clamp(MIN_SCALE, MAX_SCALE);
        if (scale - self.view.scale).abs() > f32::EPSILON {
            self.view.scale = scale;
            cx.notify();
        }
    }

    fn step_zoom(&mut self, direction: f32, cx: &mut Context<Self>) {
        // `Number((current + delta).toFixed(1))`
        let next = ((self.view.scale + direction * ZOOM_STEP) * 10.).round() / 10.;
        self.set_scale(next, cx);
    }

    /// ⌘-wheel and Ctrl-wheel: `current * exp(-deltaY * 0.01)`, a mouse
    /// notch taken as one step of about 5%, as the PDF viewer takes it.
    fn zoom_wheel(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        let delta_y = match event.delta {
            ScrollDelta::Pixels(delta) => {
                let pixels = -f32::from(delta.y);
                if pixels.abs() < 50. {
                    pixels
                } else {
                    pixels.signum() * 5.
                }
            }
            ScrollDelta::Lines(lines) => -lines.y.signum() * 5.,
        };
        if delta_y != 0. {
            self.set_scale(self.view.scale * (-delta_y * 0.01).exp(), cx);
        }
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
        if let Some(percent) = crate::html_preview::parse_percent(&draft) {
            self.set_scale(percent / 100., cx);
        }
        cx.notify();
    }

    /// The size the image is drawn at: fitted inside the stage at 100%, then
    /// scaled by the zoom.
    fn drawn_size(&self, natural: Size<f32>) -> Size<f32> {
        let stage = self.stage.get().size;
        let room = size(
            (f32::from(stage.width) - 2. * STAGE_PADDING).max(1.),
            (f32::from(stage.height) - 2. * STAGE_PADDING).max(1.),
        );
        let fit = fitted(natural, room);
        size(fit.width * self.view.scale, fit.height * self.view.scale)
    }

    fn zoom_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let scale = self.view.scale;
        let value = div()
            .id("asset-zoom-value")
            .flex_none()
            .w(px(44.))
            .h(px(28.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .whitespace_nowrap();
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
                .on_scroll(cx.listener(|this, event: &ScrollEvent, window, cx| {
                    let delta = event.delta.pixel_delta(window.line_height()).y;
                    if delta != px(0.) {
                        cx.stop_propagation();
                        this.step_zoom(if delta > px(0.) { 1. } else { -1. }, cx);
                    }
                }))
                .child(format!("{}%", (scale * 100.).round() as i64))
                .into_any_element()
        };
        div()
            .id("asset-zoom-controls")
            .flex_none()
            .ml_auto()
            .flex()
            .items_center()
            .gap(px(1.))
            .child(
                IconButton::new("asset-zoom-out", Icon::ZOOM_OUT)
                    .frame(px(24.), px(28.))
                    .tooltip(t!("Zoom out"))
                    .disabled(scale <= MIN_SCALE)
                    .on_click(cx.listener(|this, _, _, cx| this.step_zoom(-1., cx))),
            )
            .child(value)
            .child(
                IconButton::new("asset-zoom-in", Icon::ZOOM_IN)
                    .frame(px(24.), px(28.))
                    .tooltip(t!("Zoom in"))
                    .disabled(scale >= MAX_SCALE)
                    .on_click(cx.listener(|this, _, _, cx| this.step_zoom(1., cx))),
            )
            .into_any_element()
    }

    fn heading(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .flex_none()
            .h(px(38.))
            .px(px(13.))
            .border_b_1()
            .border_color(palette.line)
            .flex()
            .items_center()
            .gap(px(8.))
            .text_role(TextRole::Micro, cx)
            .text_color(palette.text_secondary)
            .child(Icon::IMAGE.element(px(14.), palette.text_secondary))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(SharedString::from(self.relative.clone())),
            )
            .when(matches!(self.shown, Shown::Image { .. }), |this| {
                this.child(self.zoom_controls(cx))
            })
            .into_any_element()
    }

    /// The image on the stage, with its hairline and its shadow.
    fn image(&self, image: &Arc<RenderImage>, drawn: Size<f32>, cx: &App) -> AnyElement {
        let palette = cx.palette();
        let edge = if palette.is_dark() {
            gpui::hsla(0., 0., 1., 0.1)
        } else {
            gpui::hsla(0., 0., 0., 0.1)
        };
        let radius = px(3.);
        div()
            .id("asset-image")
            .relative()
            .flex_none()
            .w(px(drawn.width))
            .h(px(drawn.height))
            .rounded(radius)
            .shadow(vec![BoxShadow {
                color: gpui::hsla(0., 0., 0., 0.11),
                offset: point(px(0.), px(10.)),
                blur_radius: px(24.),
                spread_radius: px(0.),
                inset: false,
            }])
            .child(
                img(gpui::ImageSource::Render(image.clone()))
                    .size_full()
                    .rounded(radius),
            )
            // `outline: 1px; outline-offset: -1px`: inside the image's edge.
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(radius)
                    .border_1()
                    .border_color(edge),
            )
            .into_any_element()
    }

    fn unsupported_note(cx: &App) -> AnyElement {
        let palette = cx.palette();
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(8.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(Icon::FILE_TEXT.element(px(28.), palette.text_secondary))
            .child(t!("This format cannot be rendered in the preview"))
            .into_any_element()
    }

    fn stage(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        // `color-mix(in srgb, panel 88%, border-subtle)`, and the squares'
        // `color-mix(border-subtle 42%, transparent)`.
        let ground = mix(palette.panel, palette.line, 0.12);
        let square = palette.line.opacity(0.42);
        let stage_bounds = self.stage.clone();
        let stage = self.stage.get().size;
        let (content, drawn) = match &self.shown {
            Shown::Image { image, natural } => {
                let drawn = self.drawn_size(*natural);
                (Some(self.image(image, drawn, cx)), Some(drawn))
            }
            Shown::Unsupported => (Some(Self::unsupported_note(cx)), None),
            Shown::Loading => (None, None),
        };
        // Grown past the stage once the image is: the stage scrolls both ways.
        let (width, height) = match drawn {
            Some(drawn) => (
                f32::from(stage.width).max(drawn.width + 2. * STAGE_PADDING),
                f32::from(stage.height).max(drawn.height + 2. * STAGE_PADDING),
            ),
            None => (f32::from(stage.width), f32::from(stage.height)),
        };
        // The saved place, once the image is laid out at its saved size.
        if self.restore_scroll && drawn.is_some() && stage.width > px(0.) {
            self.restore_scroll = false;
            let scroll = self.scroll.clone();
            let offset = self.view.scroll;
            window.on_next_frame(move |_, _| scroll.set_offset(offset));
        }
        let view = cx.entity().downgrade();
        div()
            .id("asset-stage")
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .bg(ground)
            // The checkerboard, fixed to the stage as a CSS background is.
            .child(
                canvas(
                    move |bounds, window, _| {
                        // The fit is measured in the stage: a stage laid out
                        // at a new size draws the image again at its fit.
                        if bounds.size != stage_bounds.get().size {
                            window.request_animation_frame();
                        }
                        stage_bounds.set(bounds);
                    },
                    move |bounds, _, window, _| {
                        let mut y = 0.;
                        let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
                        let mut row = 0;
                        while y < h {
                            let mut x = if row % 2 == 0 { 0. } else { CHECKER };
                            while x < w {
                                let origin = bounds.origin + point(px(x), px(y));
                                let side = size(px(CHECKER.min(w - x)), px(CHECKER.min(h - y)));
                                window.paint_quad(fill(Bounds::new(origin, side), square));
                                x += 2. * CHECKER;
                            }
                            y += CHECKER;
                            row += 1;
                        }
                    },
                )
                .absolute()
                .inset_0(),
            )
            .child(
                div()
                    .id("asset-stage-scroll")
                    .absolute()
                    .inset_0()
                    .overflow_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .w(px(width))
                            .h(px(height))
                            .p(px(STAGE_PADDING))
                            .flex()
                            .items_center()
                            .justify_center()
                            .children(content),
                    ),
            )
            .child(FluidScrollbar::vertical(
                "asset-stage-scrollbar",
                &self.scroll,
            ))
            .child(FluidScrollbar::horizontal(
                "asset-stage-scrollbar-x",
                &self.scroll,
            ))
            // ⌘-wheel, Ctrl-wheel and a pinch zoom, taken before the stage
            // scrolls.
            .child(
                canvas(
                    |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
                    move |_, hitbox, window, _| {
                        let wheel = view.clone();
                        let over = hitbox.clone();
                        window.on_mouse_event(move |event: &ScrollEvent, phase, window, cx| {
                            let zoom = event.modifiers.platform || event.modifiers.control;
                            if phase != DispatchPhase::Capture || !zoom || !over.is_hovered(window)
                            {
                                return;
                            }
                            cx.stop_propagation();
                            wheel.update(cx, |this, cx| this.zoom_wheel(event, cx)).ok();
                        });
                        let pinch = view.clone();
                        window.on_mouse_event(move |event: &PinchEvent, phase, window, cx| {
                            if phase != DispatchPhase::Capture || !hitbox.is_hovered(window) {
                                return;
                            }
                            cx.stop_propagation();
                            pinch
                                .update(cx, |this, cx| {
                                    this.set_scale(this.view.scale * (1. + event.delta), cx)
                                })
                                .ok();
                        });
                    },
                )
                .absolute()
                .inset_0(),
            )
            .into_any_element()
    }
}

/// The decoded image and its natural size in CSS pixels, from lattice-core's
/// asset: `None` for a format the preview does not draw (or bytes it cannot
/// decode), as the Tauri app's `<img>` draws only `image/*`.
fn decode(
    mime_type: &str,
    content: AssetContent,
    svg_renderer: &gpui::SvgRenderer,
) -> Option<(Arc<RenderImage>, Size<f32>)> {
    let format = image_format(mime_type)?;
    let AssetContent::Base64(encoded) = content else {
        return None;
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let (image, density) = if format == ImageFormat::Svg {
        let image = svg_renderer
            .render_single_frame(&bytes, SVG_RASTER_SCALE)
            .ok()?;
        (image, SVG_RASTER_SCALE)
    } else {
        let image = gpui::Image::from_bytes(format, bytes)
            .to_image_data(svg_renderer.clone())
            .ok()?;
        (image, 1.)
    };
    let pixels = image.size(0);
    let natural = size(
        pixels.width.0 as f32 / density,
        pixels.height.0 as f32 / density,
    );
    (natural.width > 0. && natural.height > 0.).then_some((image, natural))
}

/// The formats the preview draws: lattice-core's `image/*` mime types.
fn image_format(mime_type: &str) -> Option<ImageFormat> {
    match mime_type {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" => Some(ImageFormat::Jpeg),
        "image/webp" => Some(ImageFormat::Webp),
        "image/svg+xml" => Some(ImageFormat::Svg),
        _ => None,
    }
}

/// `natural` fitted inside `room` as `max-width: min(100%, 1100px);
/// max-height: 100%; object-fit: contain` fits it: shrunk to fit, never
/// enlarged.
fn fitted(natural: Size<f32>, room: Size<f32>) -> Size<f32> {
    let max_width = room.width.min(FIT_MAX_WIDTH);
    let factor = (max_width / natural.width)
        .min(room.height / natural.height)
        .min(1.);
    size(natural.width * factor, natural.height * factor)
}

impl EventEmitter<PanelEvent> for AssetPanel {}
impl EventEmitter<AssetPanelEvent> for AssetPanel {}

impl Focusable for AssetPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for AssetPanel {
    fn panel_name(&self) -> &'static str {
        "AssetPanel"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for AssetPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(file_name(&self.path).into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        file_name(&self.path)
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

impl Render for AssetPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let heading = self.heading(cx);
        let stage = self.stage(window, cx);
        div()
            .id("asset-preview")
            .track_focus(&self.focus_handle)
            .size_full()
            .flex()
            .flex_col()
            .bg(palette.panel)
            .child(heading)
            .child(stage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_is_fitted_inside_the_stage_and_never_enlarged() {
        // Smaller than the stage: its own size.
        assert_eq!(fitted(size(400., 300.), size(800., 600.)), size(400., 300.));
        // Taller than the stage: its height fitted.
        assert_eq!(
            fitted(size(400., 1200.), size(800., 600.)),
            size(200., 600.)
        );
        // Wider than 1100px on a wide stage: 1100px wide.
        assert_eq!(
            fitted(size(2200., 1000.), size(3000., 2000.)),
            size(1100., 500.)
        );
    }

    #[test]
    fn only_the_formats_the_tauri_preview_draws_are_drawn() {
        assert_eq!(image_format("image/png"), Some(ImageFormat::Png));
        assert_eq!(image_format("image/jpeg"), Some(ImageFormat::Jpeg));
        assert_eq!(image_format("image/webp"), Some(ImageFormat::Webp));
        assert_eq!(image_format("image/svg+xml"), Some(ImageFormat::Svg));
        // EPS and everything lattice-core calls octet-stream (a GIF, a font,
        // an archive) show "This format cannot be rendered in the preview".
        assert_eq!(image_format("application/postscript"), None);
        assert_eq!(image_format("application/octet-stream"), None);
    }
}
