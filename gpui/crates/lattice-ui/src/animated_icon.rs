//! The animated product icons: the Tauri app's 13 icons that replay a
//! gesture when their control is hovered or focused
//! (`src/animated-icons/`): Settings' sections (faders, logs, robot, plugs,
//! package, clock, sparkle, key, cloud, receipt, chat) and the titlebar's
//! Annotations, Git, History and linked Overleaf.
//!
//! At rest an icon is its static glyph ([`ProductIcon::rest`]), the frame
//! every gesture starts and ends on. Playing, each frame is the icon's SVG
//! with its pieces where the Tauri app's keyframes put them at that moment,
//! rasterized by GPUI's SVG renderer at the window's scale: the pieces, their
//! tracks and their timing are generated from the Tauri app's components and
//! stylesheet (`node scripts/gpui-animated-icons.mjs` writes [`catalog`]),
//! and replayed here with CSS's rules (see that script). A replay starts from
//! the first frame, as the Tauri app remounts the icon; leaving the control
//! lets a gesture finish.
//!
//! The key's toss is 3D in the Tauri app (seven layers in depth turned
//! under a 90px perspective); each layer is drawn here under the affine map
//! that the perspective takes it by at its own centre, which keeps the
//! layers' parallax (the lit edge the turn shows) and drops only the slight
//! keystone a 16px key has mid-turn. The linked Overleaf cloud's arrow is
//! Motion-driven there (`provided-icons.tsx`) and is replayed by hand.
//!
//! Under reduced motion (`adaptive-feedback.css`) nothing moves: the glyph
//! blinks to 35% and back over 0.7 s, as the app's reduced feedback does.

#[rustfmt::skip]
mod catalog;

use std::{sync::Arc, time::Duration};

use gpui::{
    AnyElement, App, ElementId, Hsla, ImageSource, IntoElement, ParentElement as _, Pixels,
    RenderImage, Rgba, Styled as _, Window, div, img,
};

use crate::{Icon, token_types::Ease};

// ── The catalog's data ──────────────────────────────────────────────────

/// One icon: its SVG, each animated piece marked `data-part="N"`.
struct IconData {
    kind: &'static str,
    svg: &'static str,
    parts: &'static [Part],
}

struct Part {
    /// The transform origin, in the view box.
    origin: [f32; 2],
    base: Base,
    animations: &'static [Animation],
}

/// A piece's own values, where no keyframe moves it.
struct Base {
    transform: &'static [TransformFn],
    opacity: f32,
    visible: bool,
    d: Option<&'static str>,
    dash: f32,
}

struct Animation {
    duration: f32,
    delay: f32,
    tracks: &'static [Track],
}

struct Track {
    prop: Prop,
    stops: &'static [Stop],
}

struct Stop {
    at: f32,
    /// The cubic Bézier the segment from here eases on.
    ease: [f32; 4],
    value: Value,
}

#[derive(Clone, Copy)]
enum Value {
    Transform(&'static [TransformFn]),
    Number(f32),
    /// The path with each number a `#`, and its numbers.
    Path(&'static str, &'static [f32]),
    Visible(bool),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum TransformFn {
    Translate(f32, f32),
    Scale(f32, f32),
    /// Degrees.
    Rotate(f32),
    /// Degrees, about the horizontal axis (the key's turn).
    RotateX(f32),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Prop {
    Transform,
    Opacity,
    Visibility,
    D,
    DashOffset,
}

/// The key's toss: its path, the perspective (in icon sizes), its layers
/// in depth, and the three tracks of `.lg-toss`.
struct KeyToss {
    path: &'static str,
    perspective: f32,
    layers: &'static [Layer],
    arc: Animation,
    spin: Animation,
    tilt: Animation,
}

/// One layer of the key: its depth and scale (CSS pixels at a 16px icon)
/// and how far its ink is mixed toward white.
struct Layer {
    z: f32,
    scale: f32,
    shade: f32,
}

// ── The icons ───────────────────────────────────────────────────────────

/// An icon that replays its gesture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProductIcon {
    Faders,
    Chat,
    /// The titlebar's Annotations: the chat drawn as an outline
    /// (`converted`).
    ChatOutline,
    CloudUpload,
    ApiKey,
    /// The titlebar's Git: the branch with its 20-unit strokes.
    GitBranch,
    Plugs,
    Logs,
    Robot,
    Sparkle,
    ClockBack,
    /// The titlebar's History: the clock with its heavier hands and arrow.
    ClockBackTitlebar,
    Receipt,
    Package,
    /// The titlebar's linked Overleaf: Lucide's cloud-upload, its arrow
    /// dipping and springing back.
    CloudUploadOutline,
}

/// The view box the Phosphor icons are drawn in.
const VIEW: f32 = 256.;
/// The reduced feedback: 35% at 45% of 0.7 s, on `ease`.
const REDUCED: Duration = Duration::from_millis(700);
const CSS_EASE: Ease = Ease::CubicBezier(0.25, 0.1, 0.25, 1.);

impl ProductIcon {
    pub const ALL: [ProductIcon; 15] = [
        Self::Faders,
        Self::Chat,
        Self::ChatOutline,
        Self::CloudUpload,
        Self::ApiKey,
        Self::GitBranch,
        Self::Plugs,
        Self::Logs,
        Self::Robot,
        Self::Sparkle,
        Self::ClockBack,
        Self::ClockBackTitlebar,
        Self::Receipt,
        Self::Package,
        Self::CloudUploadOutline,
    ];

    /// The glyph at rest: the first and last frame of the gesture.
    pub fn rest(self) -> Icon {
        match self {
            Self::Faders => Icon::FADERS,
            Self::Chat => Icon::CHAT,
            Self::ChatOutline => Icon::ANNOTATIONS,
            Self::CloudUpload => Icon::CLOUD_UPLOAD_FILL,
            Self::ApiKey => Icon::API_KEY,
            Self::GitBranch => Icon::GIT,
            Self::Plugs => Icon::PLUGS,
            Self::Logs => Icon::CLIPBOARD_TEXT,
            Self::Robot => Icon::ROBOT,
            Self::Sparkle => Icon::SPARKLE,
            Self::ClockBack => Icon::CLOCK_BACK,
            Self::ClockBackTitlebar => Icon::HISTORY,
            Self::Receipt => Icon::RECEIPT,
            Self::Package => Icon::PACKAGE,
            Self::CloudUploadOutline => Icon::CLOUD_UPLOAD,
        }
    }

    fn kind(self) -> &'static str {
        match self {
            Self::Faders => "faders",
            Self::Chat => "chat",
            Self::ChatOutline => "chat-outline",
            Self::CloudUpload => "cloud-upload",
            Self::ApiKey => "api-key",
            Self::GitBranch => "git-branch-titlebar",
            Self::Plugs => "plugs",
            Self::Logs => "logs",
            Self::Robot => "robot",
            Self::Sparkle => "sparkle",
            Self::ClockBack => "clock-back",
            Self::ClockBackTitlebar => "clock-back-titlebar",
            Self::Receipt => "receipt",
            Self::Package => "package",
            Self::CloudUploadOutline => "cloud-upload-outline",
        }
    }

    fn data(self) -> Option<&'static IconData> {
        catalog::ICONS.iter().find(|icon| icon.kind == self.kind())
    }

    /// How long its gesture runs.
    pub fn duration(self) -> Duration {
        let seconds = match self {
            Self::ApiKey => {
                let toss = &catalog::KEY_TOSS;
                [&toss.arc, &toss.spin, &toss.tilt]
                    .iter()
                    .map(|animation| animation.delay + animation.duration)
                    .fold(0., f32::max)
            }
            Self::CloudUploadOutline => CLOUD_DIP + CLOUD_SPRING,
            _ => self.data().map_or(0., |icon| {
                icon.parts
                    .iter()
                    .flat_map(|part| part.animations)
                    .map(|animation| animation.delay + animation.duration)
                    .fold(0., f32::max)
            }),
        };
        Duration::from_secs_f32(seconds)
    }

    /// The frame `elapsed` into the gesture as SVG, `size` pixels square, in
    /// `ink` (`#rrggbb`).
    pub fn frame_svg(self, elapsed: Duration, size: f32, ink: &str) -> String {
        let t = elapsed.as_secs_f32();
        let body = match self {
            Self::ApiKey => key_toss(t, ink),
            Self::CloudUploadOutline => cloud_outline(t),
            _ => match self.data() {
                Some(icon) => icon_frame(icon, t),
                None => String::new(),
            },
        };
        let body = body.replace("currentColor", ink);
        // The frame's pixel size; the view box stays the icon's.
        body.replacen(
            "<svg",
            &format!("<svg width=\"{size}\" height=\"{size}\""),
            1,
        )
    }
}

// ── Replaying a track ───────────────────────────────────────────────────

/// How far through its keyframes an animation is at `t` seconds, with
/// `animation-fill-mode: both`.
fn progress(animation: &Animation, t: f32) -> f32 {
    ((t - animation.delay) / animation.duration).clamp(0., 1.)
}

#[derive(Clone, Debug, PartialEq)]
enum Sampled {
    Transform(Vec<TransformFn>),
    Number(f32),
    Path(String),
    Visible(bool),
}

fn lerp(a: f32, b: f32, w: f32) -> f32 {
    a + (b - a) * w
}

/// A track's value at progress `p`: between the keyframes either side,
/// eased by the timing function of the one the segment starts at.
fn sample(track: &Track, p: f32) -> Sampled {
    let stops = track.stops;
    let last = stops.len() - 1;
    let (from, to, w) = if p <= stops[0].at {
        (&stops[0], &stops[0], 0.)
    } else if p >= stops[last].at {
        (&stops[last], &stops[last], 0.)
    } else {
        let next = stops.iter().position(|stop| stop.at > p).unwrap_or(last);
        let (from, to) = (&stops[next - 1], &stops[next]);
        let span = to.at - from.at;
        let local = if span > 0. { (p - from.at) / span } else { 1. };
        let [x1, y1, x2, y2] = from.ease;
        (from, to, Ease::CubicBezier(x1, y1, x2, y2).sample(local))
    };
    interpolate(from.value, to.value, w)
}

fn interpolate(from: Value, to: Value, w: f32) -> Sampled {
    match (from, to) {
        (Value::Transform(a), Value::Transform(b)) => Sampled::Transform(
            a.iter()
                .zip(b)
                .map(|(a, b)| match (*a, *b) {
                    (TransformFn::Translate(ax, ay), TransformFn::Translate(bx, by)) => {
                        TransformFn::Translate(lerp(ax, bx, w), lerp(ay, by, w))
                    }
                    (TransformFn::Scale(ax, ay), TransformFn::Scale(bx, by)) => {
                        TransformFn::Scale(lerp(ax, bx, w), lerp(ay, by, w))
                    }
                    (TransformFn::Rotate(a), TransformFn::Rotate(b)) => {
                        TransformFn::Rotate(lerp(a, b, w))
                    }
                    (TransformFn::RotateX(a), TransformFn::RotateX(b)) => {
                        TransformFn::RotateX(lerp(a, b, w))
                    }
                    // The generator aligns every list of a track.
                    (a, _) => a,
                })
                .collect(),
        ),
        (Value::Number(a), Value::Number(b)) => Sampled::Number(lerp(a, b, w)),
        (Value::Path(shape, a), Value::Path(_, b)) => {
            let mut numbers = a.iter().zip(b).map(|(a, b)| lerp(*a, *b, w));
            let mut path = String::with_capacity(shape.len() + 32);
            for ch in shape.chars() {
                if ch == '#' {
                    path.push_str(&format_number(numbers.next().unwrap_or(0.)));
                } else {
                    path.push(ch);
                }
            }
            Sampled::Path(path)
        }
        // Visibility is discrete: between a visible and a hidden keyframe the
        // piece is visible.
        (Value::Visible(a), Value::Visible(b)) => Sampled::Visible(if w <= 0. {
            a
        } else if w >= 1. {
            b
        } else {
            a || b
        }),
        (from, _) => interpolate(from, from, 0.),
    }
}

fn format_number(value: f32) -> String {
    let rounded = (value * 1000.).round() / 1000.;
    if rounded == rounded.trunc() {
        format!("{}", rounded as i64)
    } else {
        format!("{rounded}")
    }
}

fn svg_transform(fns: &[TransformFn]) -> String {
    fns.iter()
        .map(|f| match *f {
            TransformFn::Translate(x, y) => {
                format!("translate({} {})", format_number(x), format_number(y))
            }
            TransformFn::Scale(x, y) => format!("scale({} {})", format_number(x), format_number(y)),
            TransformFn::Rotate(a) | TransformFn::RotateX(a) => {
                format!("rotate({})", format_number(a))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A piece's attributes at `t` seconds.
fn part_attributes(part: &Part, t: f32) -> String {
    let mut transform = Sampled::Transform(part.base.transform.to_vec());
    let mut opacity = part.base.opacity;
    let mut visible = part.base.visible;
    let mut d = part.base.d.map(str::to_string);
    let mut dash = part.base.dash;
    let mut dashed = false;
    for animation in part.animations {
        let p = progress(animation, t);
        for track in animation.tracks {
            match (track.prop, sample(track, p)) {
                (Prop::Transform, value) => transform = value,
                (Prop::Opacity, Sampled::Number(value)) => opacity = value,
                (Prop::Visibility, Sampled::Visible(value)) => visible = value,
                (Prop::D, Sampled::Path(path)) => d = Some(path),
                (Prop::DashOffset, Sampled::Number(value)) => {
                    dash = value;
                    dashed = true;
                }
                _ => {}
            }
        }
    }
    let mut attributes = String::new();
    if let Sampled::Transform(fns) = transform
        && !fns.is_empty()
    {
        let [ox, oy] = part.origin.map(format_number);
        attributes.push_str(&format!(
            " transform=\"translate({ox} {oy}) {} translate(-{ox} -{oy})\"",
            svg_transform(&fns)
        ));
    }
    if opacity < 1. {
        attributes.push_str(&format!(" opacity=\"{}\"", format_number(opacity.max(0.))));
    }
    if !visible {
        attributes.push_str(" visibility=\"hidden\"");
    }
    if let Some(d) = d {
        attributes.push_str(&format!(" d=\"{d}\""));
    }
    if dashed || dash != 0. {
        attributes.push_str(&format!(" stroke-dashoffset=\"{}\"", format_number(dash)));
    }
    attributes
}

fn icon_frame(icon: &IconData, t: f32) -> String {
    let mut svg = icon.svg.to_string();
    for (ix, part) in icon.parts.iter().enumerate() {
        svg = svg.replacen(
            &format!(" data-part=\"{ix}\""),
            &part_attributes(part, t),
            1,
        );
    }
    svg
}

// ── The key's toss ──────────────────────────────────────────────────────

fn transform_at(animation: &Animation, t: f32) -> Vec<TransformFn> {
    let p = progress(animation, t);
    animation
        .tracks
        .iter()
        .find(|track| track.prop == Prop::Transform)
        .map_or_else(Vec::new, |track| match sample(track, p) {
            Sampled::Transform(fns) => fns,
            _ => Vec::new(),
        })
}

/// Each layer under the turn: the arc lifts the key, the spin turns it
/// about its length (after squashing it on the catch), the tilt levels
/// it; the perspective is taken at each layer's centre.
fn key_toss(t: f32, ink: &str) -> String {
    let toss = &catalog::KEY_TOSS;
    // CSS pixels at the 16px icon the stylesheet was written for.
    let unit = VIEW / 16.;
    let lift = transform_at(&toss.arc, t)
        .iter()
        .map(|f| match *f {
            TransformFn::Translate(_, y) => y,
            _ => 0.,
        })
        .sum::<f32>()
        * unit;
    let (mut turn, mut squash) = (0., 1.);
    for f in transform_at(&toss.spin, t) {
        match f {
            TransformFn::RotateX(angle) => turn = angle.to_radians(),
            TransformFn::Scale(_, y) => squash = y,
            _ => {}
        }
    }
    let tilt = transform_at(&toss.tilt, t)
        .iter()
        .map(|f| match *f {
            TransformFn::Rotate(angle) => angle.to_radians(),
            _ => 0.,
        })
        .sum::<f32>();
    let perspective = toss.perspective * VIEW;
    let (cos, sin) = (turn.cos(), turn.sin());
    let mut layers: Vec<(f32, String)> = toss
        .layers
        .iter()
        .map(|layer| {
            let z = layer.z * unit;
            let depth = z * cos;
            let f = perspective / (perspective - depth);
            // [x, y] -> f·diag(1, cos)·diag(1, squash)·R(tilt)·scale·[x, y]
            let (rc, rs) = (tilt.cos(), tilt.sin());
            let k = layer.scale;
            let (a, b) = (f * k * rc, f * cos * squash * k * rs);
            let (c, d) = (-f * k * rs, f * cos * squash * k * rc);
            let (cx, cy) = (VIEW / 2., VIEW / 2. + lift - z * sin * f);
            // Applied to the path about its centre.
            let e = cx - a * VIEW / 2. - c * VIEW / 2.;
            let g = cy - b * VIEW / 2. - d * VIEW / 2.;
            let fill = mix_white(ink, layer.shade);
            (
                depth,
                format!(
                    "<path transform=\"matrix({} {} {} {} {} {})\" fill=\"{fill}\" d=\"{}\"/>",
                    format_number(a),
                    format_number(b),
                    format_number(c),
                    format_number(d),
                    format_number(e),
                    format_number(g),
                    toss.path
                ),
            )
        })
        .collect();
    // Painted far to near, as the preserved 3D context sorts them.
    layers.sort_by(|a, b| a.0.total_cmp(&b.0));
    let body: String = layers.into_iter().map(|(_, path)| path).collect();
    format!("<svg viewBox=\"0 0 256 256\">{body}</svg>")
}

/// `color-mix(in srgb, ink, #fff share)`.
fn mix_white(ink: &str, share: f32) -> String {
    let channel = |at: usize| {
        let value = u8::from_str_radix(ink.get(at..at + 2).unwrap_or("00"), 16).unwrap_or(0);
        (f32::from(value) * (1. - share) + 255. * share).round() as u8
    };
    format!("#{:02x}{:02x}{:02x}", channel(1), channel(3), channel(5))
}

// ── The linked Overleaf cloud ───────────────────────────────────────────

/// The arrow dips 2 units over 0.3 s (`controls.start("initial")`), then
/// at 320 ms springs back over 0.3 s, both on `[.68, -.6, .32, 1.6]`.
const CLOUD_DIP: f32 = 0.32;
const CLOUD_SPRING: f32 = 0.3;
const CLOUD_EASE: Ease = Ease::CubicBezier(0.68, -0.6, 0.32, 1.6);

fn cloud_arrow_y(t: f32) -> f32 {
    if t < CLOUD_DIP {
        -2. * CLOUD_EASE.sample((t / 0.3).min(1.))
    } else {
        -2. * (1. - CLOUD_EASE.sample(((t - CLOUD_DIP) / CLOUD_SPRING).min(1.)))
    }
}

fn cloud_outline(t: f32) -> String {
    format!(
        "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" \
         stroke-linejoin=\"round\" stroke-width=\"2\"><path d=\"M4.2 15.1A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2\"/>\
         <g transform=\"translate(0 {})\"><path d=\"M12 13v8\"/><path d=\"m8 17 4-4 4 4\"/></g></svg>",
        format_number(cloud_arrow_y(t))
    )
}

// ── Drawing it ──────────────────────────────────────────────────────────

/// Where an icon's gesture is.
#[derive(Default)]
struct Playback {
    /// The last frame drawn, given back when the next replaces it.
    frame: Option<Arc<RenderImage>>,
}

fn state(id: &ElementId, window: &mut Window, cx: &mut App) -> gpui::Entity<Playback> {
    window.use_keyed_state(id.clone(), cx, |_, _| Playback::default())
}

thread_local! {
    // When each icon's gesture began, by its id: a replay comes from an
    // event handler, outside any element's render, where keyed element
    // state cannot be reached. Main thread only.
    static STARTED: std::cell::RefCell<std::collections::HashMap<ElementId, std::time::Instant>> =
        std::cell::RefCell::default();
}

/// Play `id`'s gesture from its start: its control was hovered or focused.
pub fn replay(id: impl Into<ElementId>, window: &mut Window, _: &mut App) {
    let id = id.into();
    STARTED.with(|started| started.borrow_mut().insert(id, std::time::Instant::now()));
    window.refresh();
}

/// Replay `id`'s gesture when `active` (its control hovered or focused)
/// has just become true; called as the control draws, so it reads the
/// control's own hover rather than taking its one hover listener.
pub fn replay_on(id: impl Into<ElementId>, active: bool, window: &mut Window, cx: &mut App) {
    let id = id.into();
    let was = window.use_keyed_state(
        ElementId::NamedChild(Arc::new(id.clone()), "was-active".into()),
        cx,
        |_, _| false,
    );
    let rose = active && !*was.read(cx);
    if *was.read(cx) != active {
        was.update(cx, |was, _| *was = active);
    }
    if rose {
        replay(id, window, cx);
    }
}

/// `icon` at `size` in `color`, playing its gesture after [`replay`] with
/// the same `id`, its glyph at rest otherwise.
pub fn product_icon(
    id: impl Into<ElementId>,
    icon: ProductIcon,
    size: Pixels,
    color: Hsla,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let drawn = draw(id.into(), icon, size, color, window, cx);
    // Named for the parity harness and the e2e scenario, which hover it.
    div()
        .relative()
        .flex_none()
        .size(size)
        .child(drawn)
        .children(crate::parity::probe(format!(
            "animated-icon/{}",
            icon.kind()
        )))
        .into_any_element()
}

thread_local! {
    // Drawn on the main thread only.
    static FRAMES: std::cell::RefCell<std::collections::HashMap<ProductIcon, usize>> =
        std::cell::RefCell::default();
}

/// How many moving frames of `icon` have been drawn, in every place it
/// shows: the e2e scenario reads it to see a gesture play and stop.
pub fn frames_drawn(icon: ProductIcon) -> usize {
    FRAMES.with(|frames| frames.borrow().get(&icon).copied().unwrap_or(0))
}

fn draw(
    id: ElementId,
    icon: ProductIcon,
    size: Pixels,
    color: Hsla,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let state = state(&id, window, cx);
    let elapsed = STARTED.with(|started| started.borrow().get(&id).map(|at| at.elapsed()));
    let rest = || icon.rest().element(size, color).into_any_element();
    let give_back = |window: &mut Window, cx: &mut App| {
        if let Some(frame) = state.update(cx, |state, _| state.frame.take()) {
            window.drop_image(frame).ok();
        }
    };
    let Some(elapsed) = elapsed else {
        return rest();
    };
    if cx.reduce_motion() {
        give_back(window, cx);
        if elapsed >= REDUCED {
            STARTED.with(|started| started.borrow_mut().remove(&id));
            return rest();
        }
        window.request_animation_frame();
        let p = elapsed.as_secs_f32() / REDUCED.as_secs_f32();
        let dim = if p < 0.45 {
            CSS_EASE.sample(p / 0.45)
        } else {
            1. - CSS_EASE.sample((p - 0.45) / 0.55)
        };
        return div()
            .opacity(1. - 0.65 * dim)
            .child(icon.rest().element(size, color))
            .into_any_element();
    }
    if elapsed >= icon.duration() {
        give_back(window, cx);
        STARTED.with(|started| started.borrow_mut().remove(&id));
        return rest();
    }
    window.request_animation_frame();
    let ink = {
        let rgba = Rgba::from(color.opacity(1.));
        let channel = |value: f32| (value.clamp(0., 1.) * 255.).round() as u8;
        format!(
            "#{:02x}{:02x}{:02x}",
            channel(rgba.r),
            channel(rgba.g),
            channel(rgba.b)
        )
    };
    let svg = icon.frame_svg(elapsed, f32::from(size), &ink);
    let frame = cx
        .svg_renderer()
        .render_single_frame(svg.as_bytes(), window.scale_factor());
    let Ok(frame) = frame else {
        return rest();
    };
    if let Some(previous) = state.update(cx, |state, _| state.frame.replace(frame.clone())) {
        window.drop_image(previous).ok();
    }
    FRAMES.with(|frames| *frames.borrow_mut().entry(icon).or_default() += 1);
    img(ImageSource::Render(frame))
        .size(size)
        .flex_none()
        .opacity(color.a)
        .into_any_element()
}

/// [`product_icon`] as an element, for a place that builds its content
/// before it is drawn.
#[derive(IntoElement)]
pub struct AnimatedProductIcon {
    id: ElementId,
    icon: ProductIcon,
    size: Pixels,
    color: Hsla,
}

impl AnimatedProductIcon {
    pub fn new(id: impl Into<ElementId>, icon: ProductIcon, size: Pixels, color: Hsla) -> Self {
        Self {
            id: id.into(),
            icon,
            size,
            color,
        }
    }
}

impl gpui::RenderOnce for AnimatedProductIcon {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        product_icon(self.id, self.icon, self.size, self.color, window, cx)
    }
}

/// The id an [`crate::components::IconButton`] gives its icon, for content
/// of its own that replays with it.
pub fn button_icon_id(button: impl Into<ElementId>) -> ElementId {
    ElementId::NamedChild(Arc::new(button.into()), "icon".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every gesture starts and ends on its resting frame, as the Tauri app's
    // icons are built to (frame 0 == final frame).
    #[test]
    fn every_gesture_ends_where_it_started() {
        for icon in ProductIcon::ALL {
            // Drawn, not written: the log's tail lands three lines on, on
            // lines as ragged as the first.
            let renderer = gpui::SvgRenderer::new(std::sync::Arc::new(crate::UiAssets));
            let draw = |at: Duration| {
                let svg = icon.frame_svg(at, 16., "#000000");
                let image = renderer.render_single_frame(svg.as_bytes(), 2.).unwrap();
                image.as_bytes(0).unwrap().to_vec()
            };
            // Within antialiasing: the sparkle's star ends half a turn on.
            let (start, end) = (draw(Duration::ZERO), draw(icon.duration()));
            let worst = start
                .iter()
                .zip(&end)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap_or(0);
            assert!(start.len() == end.len() && worst <= 48, "{icon:?}: {worst}");
            assert!(icon.duration() > Duration::from_millis(300), "{icon:?}");
        }
    }

    // bakai-icons.css: the left fader's knob is at translateY(-48px) from
    // 19.101% to 33.708% of its 0.89 s.
    #[test]
    fn a_keyframe_holds_its_value_between_its_offsets() {
        let mid = Duration::from_secs_f32(0.89 * 0.26);
        let svg = ProductIcon::Faders.frame_svg(mid, 16., "#000000");
        assert!(svg.contains("translate(0 -48)"), "{svg}");
        assert!(svg.contains("d=\"M56,40L56,64\""), "{svg}");
    }

    // The ripple names transform only at 0% and 100% and opacity at 0%,
    // 16%, 55% and 100%: each property runs between the keyframes naming it.
    #[test]
    fn properties_interpolate_between_their_own_keyframes() {
        let ring = catalog::ICONS
            .iter()
            .find(|icon| icon.kind == "sparkle")
            .unwrap()
            .parts
            .iter()
            .find(|part| part.base.opacity == 0.)
            .expect("the ring rests hidden");
        let animation = &ring.animations[0];
        let at = |p: f32| animation.delay + p * animation.duration;
        let opacity = |t: f32| match animation
            .tracks
            .iter()
            .find(|track| track.prop == Prop::Opacity)
            .map(|track| sample(track, progress(animation, t)))
        {
            Some(Sampled::Number(value)) => value,
            _ => f32::NAN,
        };
        assert_eq!(opacity(at(0.3)), 1.);
        assert!(opacity(at(0.8)) < 1. && opacity(at(0.8)) > 0.);
    }

    #[test]
    fn visibility_is_visible_between_a_visible_and_a_hidden_keyframe() {
        assert_eq!(
            interpolate(Value::Visible(false), Value::Visible(true), 0.5),
            Sampled::Visible(true)
        );
        assert_eq!(
            interpolate(Value::Visible(false), Value::Visible(true), 0.),
            Sampled::Visible(false)
        );
    }

    // The key is still, level and in place at rest, and in the air mid-toss.
    #[test]
    fn the_key_rises_and_turns_mid_toss() {
        let rest = ProductIcon::ApiKey.frame_svg(Duration::ZERO, 16., "#000000");
        let mid = ProductIcon::ApiKey.frame_svg(Duration::from_millis(300), 16., "#000000");
        assert_ne!(rest, mid);
        assert_eq!(mix_white("#000000", 0.25), "#404040");
    }

    #[test]
    fn the_cloud_s_arrow_dips_and_comes_back() {
        assert!(cloud_arrow_y(0.).abs() < 1e-6);
        assert!((cloud_arrow_y(0.3) + 2.).abs() < 0.05);
        assert!(cloud_arrow_y(CLOUD_DIP + CLOUD_SPRING).abs() < 1e-3);
    }
}
