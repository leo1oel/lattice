// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The display list: what each element paints, as plain data, for any
//! backend (the GPUI renderer, later vello, and `export_svg`). Port of the
//! drawing half of Excalidraw @ 3a317b5 `element/src/renderElement.ts`
//! (`drawElementOnCanvas`, `drawElement`, `resolveElementRenderState`) and the
//! element pass of `excalidraw/renderer/staticScene.ts` /
//! `staticSvgScene.ts` (order, bound text after its container, iframe-likes
//! last, frame clipping, arrow label holes), plus the frame labels of
//! `scene/export.ts`.
//!
//! Shapes, lines, arrows and freedraw fills are rough.js drawables
//! (`shape.rs`), each op set an item as `RoughCanvas.draw` paints it:
//! outlines stroked with the stroke color at `strokeWidth` (dashed by
//! `strokeLineDash`), `fillPath` filled, `fillSketch` lines stroked with the
//! background at `fillWeight`; caps and joins round. Colors are the
//! element's, parsed; the dark theme is the backend's job (`theme_color`,
//! upstream's `applyDarkModeFilter`), and `Paint::CanvasBackground` stands
//! for the canvas color the `*_outline` arrowheads are filled with.
//!
//! Left out: embeddable contents and their placeholder label, link icons,
//! selection rendering (overlay). The sticky note edge is a 0.5px stroke
//! inside the paper's outline rather than a 1px one clipped to it. Upstream
//! divides frame outlines' width and radius by the zoom on the interactive
//! canvas; here they are in scene units, as exported. Frame names are in
//! scene units too (`RenderOpts::frame_name`, as exported); the board view
//! leaves them out and draws upstream's screen-size DOM names itself.

use super::bounds::*;
use super::color::{Rgba, apply_dark_mode_filter, color_or_black, parse_color};
use super::consts::{BOUND_TEXT_PADDING, FrameStyle, STICKY_NOTE_SHADOW_OPACITY};
use super::math::*;
use super::shape::*;
use super::text_measure::{
    Font, Measure, get_line_height_in_px, get_line_width, get_vertical_offset, measure_text,
};
use super::types::{Element, ElementType, ImageStatus, TextAlign};
use super::utils::{ElementsMap, is_invisibly_small_element};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Paint {
    Color(Rgba),
    CanvasBackground,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FillRule {
    NonZero,
    EvenOdd,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fill {
    pub paint: Paint,
    pub rule: FillRule,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineCap {
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineJoin {
    Miter,
    Round,
    Bevel,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stroke {
    pub paint: Paint,
    pub width: f64,
    pub dash: Option<Vec<f64>>,
    pub cap: LineCap,
    pub join: LineJoin,
}

/// One line of text: `x` is the anchor (left, center or right edge by
/// `align`), `top` the top of its line box, `baseline` the alphabetic
/// baseline upstream draws at (from Excalidraw's font metrics; a backend
/// with other fonts may center glyphs in the line box instead).
#[derive(Clone, Debug, PartialEq)]
pub struct TextLine {
    pub text: String,
    pub x: f64,
    pub top: f64,
    pub baseline: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextRun {
    pub lines: Vec<TextLine>,
    /// `FONT_FAMILY` number; `text_measure::get_font_family_string` names it.
    pub font_family: u32,
    pub font_size: f64,
    pub color: Paint,
    pub align: TextAlign,
    /// px.
    pub line_height: f64,
    pub rtl: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImageItem {
    pub file_id: Option<String>,
    pub status: ImageStatus,
    /// Where the (cropped) image goes, local `[x, y, width, height]`.
    pub dest: [f64; 4],
    /// Source rectangle in natural pixels, `[x, y, width, height]`; None for
    /// the whole image.
    pub crop: Option<[f64; 4]>,
    /// Mirroring (`scale`, ±1 per axis) about the center of `dest`.
    pub flip: [f64; 2],
    /// The image's natural size when cropped (`crop.naturalWidth` / `Height`).
    pub natural_size: Option<[f64; 2]>,
    /// Rounded clip, 0 for none.
    pub corner_radius: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum DisplayItem {
    Path {
        cmds: Vec<PathCmd>,
        fill: Option<Fill>,
        stroke: Option<Stroke>,
    },
    Text(TextRun),
    Image(ImageItem),
}

/// A clip in scene coordinates: the rounded `rect` rotated by `angle` about
/// its center.
#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    pub frame_id: String,
    pub rect: [f64; 4],
    pub radius: f64,
    pub angle: f64,
}

/// What one element paints. Items are in local coordinates; a local point
/// `p` lands at `origin + rotate(p, center, angle)` in the scene.
#[derive(Clone, Debug, PartialEq)]
pub struct ElementDisplay {
    pub id: String,
    pub ty: ElementType,
    pub origin: Point,
    /// Radians, clockwise, about `center` (local).
    pub angle: f64,
    pub center: Point,
    /// 0-1, applied to the group (upstream: fill and stroke opacity).
    pub opacity: f64,
    pub clip: Option<Clip>,
    /// A local rectangle the element doesn't paint in (an arrow's label).
    pub knockout: Option<[f64; 4]>,
    pub link: Option<String>,
    pub items: Vec<DisplayItem>,
}

impl ElementDisplay {
    pub fn to_scene(&self, p: Point) -> Point {
        point_translate(point_rotate_rads(p, self.center, self.angle), self.origin)
    }
}

/// `frameRendering`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RenderOpts {
    pub frame_outline: bool,
    pub frame_name: bool,
    pub frame_clip: bool,
}
impl Default for RenderOpts {
    fn default() -> Self {
        RenderOpts {
            frame_outline: true,
            frame_name: true,
            frame_clip: true,
        }
    }
}

fn color(s: &str) -> Option<Paint> {
    let c = color_or_black(s);
    (!c.is_transparent()).then_some(Paint::Color(c))
}

/// `RoughCanvas.draw` as display items: outlines stroked with `stroke` at
/// `strokeWidth` (dashed by `strokeLineDash`), `fillPath` sets filled with
/// `fill` (`fill_paint` when given: an arrowhead's), fill lines stroked with
/// `fill` at `fillWeight`. `round` is the canvas's round caps and joins
/// (shapes and lines; freedraw fills keep the defaults).
fn drawable_items(
    d: &Drawable,
    fill_paint: Option<Paint>,
    round: bool,
    items: &mut Vec<DisplayItem>,
) {
    let o = &d.options;
    let (cap, join) = if round {
        (LineCap::Round, LineJoin::Round)
    } else {
        (LineCap::Butt, LineJoin::Miter)
    };
    let fill = fill_paint.or_else(|| o.fill.as_deref().and_then(color));
    for set in &d.sets {
        if set.ops.is_empty() {
            continue;
        }
        let cmds = ops_to_path(&set.ops);
        match set.ty {
            OpSetType::Path => {
                if let Some(paint) = o.stroke.as_deref().and_then(color) {
                    items.push(DisplayItem::Path {
                        cmds,
                        fill: None,
                        stroke: Some(Stroke {
                            paint,
                            width: o.stroke_width,
                            dash: o.stroke_line_dash.clone(),
                            cap,
                            join,
                        }),
                    });
                }
            }
            OpSetType::FillPath => {
                if let Some(paint) = fill {
                    items.push(DisplayItem::Path {
                        cmds,
                        fill: Some(Fill {
                            paint,
                            rule: if d.even_odd() {
                                FillRule::EvenOdd
                            } else {
                                FillRule::NonZero
                            },
                        }),
                        stroke: None,
                    });
                }
            }
            OpSetType::FillSketch => {
                if let Some(paint) = fill {
                    items.push(DisplayItem::Path {
                        cmds,
                        fill: None,
                        stroke: Some(Stroke {
                            paint,
                            width: o.fill_weight_or_default(),
                            dash: o.fill_line_dash.clone(),
                            cap,
                            join,
                        }),
                    });
                }
            }
        }
    }
}

/// `drawElementOnCanvas` for the elements drawn with rough.js.
fn rough_items(e: &Element) -> Vec<DisplayItem> {
    let mut items = vec![];
    match generate_element_shape(e) {
        ElementShape::None => {}
        ElementShape::Single(d) => drawable_items(&d, None, true, &mut items),
        ElementShape::Linear(parts) => {
            for p in &parts {
                let fill = p.head_fill.map(|f| match f {
                    HeadFill::Stroke => {
                        color(&e.stroke_color).unwrap_or(Paint::Color(Rgba::TRANSPARENT))
                    }
                    HeadFill::Background => Paint::CanvasBackground,
                });
                drawable_items(&p.drawable, fill, true, &mut items);
            }
        }
        ElementShape::Freedraw { fill, stroke } => {
            if let Some(d) = fill {
                drawable_items(&d, None, false, &mut items);
            }
            if let Some(paint) = color(&e.stroke_color)
                && !stroke.is_empty()
            {
                items.push(DisplayItem::Path {
                    cmds: stroke,
                    fill: Some(Fill {
                        paint,
                        rule: FillRule::NonZero,
                    }),
                    stroke: None,
                });
            }
        }
    }
    items
}

/// A display color as the canvas paints it: in `dark` mode upstream's
/// `applyDarkModeFilter` on every element color, but for what it paints
/// literally (a sticky note's shadow and edge, translucent black) and the
/// AI frame outline, which has its own dark color.
pub fn theme_color(c: Rgba, ty: ElementType, dark: bool) -> Rgba {
    if !dark {
        return c;
    }
    if ty == ElementType::StickyNote && c.r == 0 && c.g == 0 && c.b == 0 && c.a < 255 {
        return c;
    }
    if ty == ElementType::MagicFrame && c == color_or_black(MAGIC_FRAME_STROKE_COLOR) {
        return apply_dark_mode_filter(color_or_black(MAGIC_FRAME_STROKE_COLOR_DARK));
    }
    apply_dark_mode_filter(c)
}

/// The canvas color (`viewBackgroundColor`) as painted: filtered in dark
/// mode, white when unreadable.
pub fn canvas_color(view_background: &str, dark: bool) -> Rgba {
    let c = parse_color(view_background).unwrap_or(Rgba::rgb(255, 255, 255));
    if dark { apply_dark_mode_filter(c) } else { c }
}

/// `drawImagePlaceholder`'s box color (not filtered).
pub fn image_placeholder_color(dark: bool) -> Rgba {
    if dark {
        Rgba::rgb(0x2e, 0x2e, 0x2e)
    } else {
        Rgba::rgb(0xe7, 0xe7, 0xe7)
    }
}

/// `isRTL`: the first directional character is right-to-left.
pub fn is_rtl(text: &str) -> bool {
    for c in text.chars() {
        let u = c as u32;
        let ltr = c.is_ascii_alphabetic()
            || (0xC0..=0xD6).contains(&u)
            || (0xD8..=0xF6).contains(&u)
            || (0xF8..=0x2B8).contains(&u)
            || (0x300..=0x590).contains(&u)
            || (0x800..=0x1FFF).contains(&u)
            || (0x2C00..=0xFB1C).contains(&u)
            || (0xFDFE..=0xFE6F).contains(&u)
            || u >= 0xFEFD;
        if ltr {
            return false;
        }
        if (0x591..=0x7FF).contains(&u)
            || (0xFB1D..=0xFDFD).contains(&u)
            || (0xFE70..=0xFEFC).contains(&u)
        {
            return true;
        }
    }
    false
}

/// A text run laid out as upstream draws text: one line per `\n`.
pub fn text_run(
    text: &str,
    width: f64,
    font_family: u32,
    font_size: f64,
    line_height: f64,
    align: TextAlign,
    paint: Paint,
) -> TextRun {
    let lh = get_line_height_in_px(font_size, line_height);
    let x = match align {
        TextAlign::Center => width / 2.,
        TextAlign::Right => width,
        TextAlign::Left => 0.,
    };
    let vo = get_vertical_offset(font_family, font_size, lh);
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines = normalized
        .split('\n')
        .enumerate()
        .map(|(i, l)| TextLine {
            text: l.into(),
            x,
            top: i as f64 * lh,
            baseline: i as f64 * lh + vo,
        })
        .collect();
    TextRun {
        lines,
        font_family,
        font_size,
        color: paint,
        align,
        line_height: lh,
        rtl: is_rtl(text),
    }
}

fn text_items(e: &Element) -> Vec<DisplayItem> {
    let Some(t) = e.text() else { return vec![] };
    let Some(paint) = color(&e.stroke_color) else {
        return vec![];
    };
    vec![DisplayItem::Text(text_run(
        &t.text,
        e.width,
        t.font_family,
        t.font_size,
        t.line_height,
        t.text_align,
        paint,
    ))]
}

fn image_items(e: &Element) -> Vec<DisplayItem> {
    let Some(i) = e.image() else { return vec![] };
    let radius = if e.roundness.is_some() {
        super::utils::get_corner_radius(e.width.min(e.height), e)
    } else {
        0.
    };
    vec![DisplayItem::Image(ImageItem {
        file_id: i.file_id.clone(),
        status: i.status,
        dest: [0., 0., e.width, e.height],
        crop: i.crop.map(|c| [c.x, c.y, c.width, c.height]),
        flip: i.scale,
        natural_size: i.crop.map(|c| [c.natural_width, c.natural_height]),
        corner_radius: radius,
    })]
}

const DEFAULT_FRAME_NAME: &str = "Frame";
const DEFAULT_AI_FRAME_NAME: &str = "AI Frame";
const MAGIC_FRAME_STROKE_COLOR: &str = "#7affd7";
const MAGIC_FRAME_STROKE_COLOR_DARK: &str = "#1d8264";

/// `getFrameLikeTitle`.
pub fn get_frame_like_title(e: &Element) -> String {
    e.frame_name().map(str::to_owned).unwrap_or_else(|| {
        if e.is_magic_frame() {
            DEFAULT_AI_FRAME_NAME.into()
        } else {
            DEFAULT_FRAME_NAME.into()
        }
    })
}

/// A frame's name label as upstream exports it (`addFrameLabelsAsTextElements`
/// and `truncateText`): `(text, [x, y, width, height])` in scene
/// coordinates, above the frame's top-left corner.
pub fn frame_label(e: &Element, m: &dyn Measure) -> (String, [f64; 4]) {
    let font = Font::new(
        FrameStyle::NAME_FONT_SIZE,
        super::consts::font_family::HELVETICA,
    );
    let mut text = get_frame_like_title(e);
    let size = measure_text(m, &text, font, FrameStyle::NAME_LINE_HEIGHT);
    let mut width = size.width;
    if width > e.width {
        if get_line_width(m, &text, font) > e.width {
            let units: Vec<u16> = text.encode_utf16().collect();
            let mut truncated = String::new();
            for i in (0..=units.len()).rev() {
                let t = format!("{}...", String::from_utf16_lossy(&units[..i]));
                if get_line_width(m, &t, font) <= e.width {
                    truncated = t;
                    break;
                }
            }
            text = truncated;
        }
        width = e.width;
    }
    let y = e.y - FrameStyle::NAME_OFFSET_Y - size.height;
    (text, [e.x, y, width, size.height])
}

fn frame_items(e: &Element, m: &dyn Measure, o: &RenderOpts) -> Vec<DisplayItem> {
    let mut items = vec![];
    if o.frame_outline {
        let c = if e.is_magic_frame() {
            MAGIC_FRAME_STROKE_COLOR
        } else {
            FrameStyle::STROKE_COLOR
        };
        let paint = Paint::Color(color_or_black(c));
        items.push(DisplayItem::Path {
            cmds: rounded_rect_path(
                e.width,
                e.height,
                FrameStyle::RADIUS
                    .min(e.width.abs() / 2.)
                    .min(e.height.abs() / 2.),
            ),
            fill: None,
            stroke: Some(Stroke {
                paint,
                width: FrameStyle::STROKE_WIDTH,
                dash: None,
                cap: LineCap::Butt,
                join: LineJoin::Miter,
            }),
        });
    }
    if o.frame_name {
        let (text, [x, y, w, _]) = frame_label(e, m);
        if !text.is_empty() {
            let mut run = text_run(
                &text,
                w,
                super::consts::font_family::HELVETICA,
                FrameStyle::NAME_FONT_SIZE,
                FrameStyle::NAME_LINE_HEIGHT,
                TextAlign::Left,
                Paint::Color(color_or_black(FrameStyle::NAME_COLOR_LIGHT)),
            );
            for l in &mut run.lines {
                l.x += x - e.x;
                l.top += y - e.y;
                l.baseline += y - e.y;
            }
            items.push(DisplayItem::Text(run));
        }
    }
    items
}

fn sticky_items(e: &Element) -> Vec<DisplayItem> {
    let close = |mut p: Vec<PathCmd>| {
        p.push(PathCmd::Close);
        p
    };
    let shadow = close(super::sticky::get_sticky_note_path_commands(e, true));
    let mut items = vec![DisplayItem::Path {
        cmds: shadow,
        fill: Some(Fill {
            paint: Paint::Color(Rgba::BLACK.with_alpha(STICKY_NOTE_SHADOW_OPACITY)),
            rule: FillRule::NonZero,
        }),
        stroke: None,
    }];
    let body = close(super::sticky::get_sticky_note_path_commands(e, false));
    if let Some(paint) = parse_color(&e.background_color).map(Paint::Color) {
        items.push(DisplayItem::Path {
            cmds: body.clone(),
            fill: Some(Fill {
                paint,
                rule: FillRule::NonZero,
            }),
            stroke: None,
        });
    }
    // the edge: a 1px stroke clipped to the paper upstream, i.e. its inner half
    let edge = Paint::Color(Rgba::BLACK.with_alpha(super::sticky::STICKY_NOTE_EDGE_SHADOW_OPACITY));
    items.push(DisplayItem::Path {
        cmds: body,
        fill: None,
        stroke: Some(Stroke {
            paint: edge,
            width: super::sticky::STICKY_NOTE_EDGE_SHADOW_WIDTH,
            dash: None,
            cap: LineCap::Butt,
            join: LineJoin::Miter,
        }),
    });
    // the creation-date footer (`getStickyNoteFooter`): 12px Helvetica in the
    // ink, right-aligned on its baseline; the label is absolute, so a cached
    // display only goes stale at a year boundary (as upstream's canvas)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    if let Some((text, x, y)) =
        super::sticky::get_sticky_note_footer(e, now, crate::time::local_offset() * 1000)
        && let Some(paint) = color(&e.stroke_color)
    {
        let mut run = text_run(
            &text,
            x,
            super::consts::font_family::HELVETICA,
            super::consts::STICKY_NOTE_FOOTER_FONT_SIZE,
            1.25,
            TextAlign::Right,
            paint,
        );
        for l in &mut run.lines {
            let dy = y - l.baseline;
            l.top += dy;
            l.baseline += dy;
        }
        items.push(DisplayItem::Text(run));
    }
    items
}

/// What `e` paints; None for elements that paint nothing (selection).
pub fn element_display(
    e: &Element,
    map: &dyn ElementsMap,
    m: &dyn Measure,
    o: &RenderOpts,
) -> Option<ElementDisplay> {
    let items = match e.ty() {
        ElementType::Selection => return None,
        ElementType::Rectangle
        | ElementType::Diamond
        | ElementType::Ellipse
        | ElementType::Iframe
        | ElementType::Embeddable
        | ElementType::Line
        | ElementType::Arrow
        | ElementType::FreeDraw => rough_items(e),
        ElementType::Text => text_items(e),
        ElementType::Image => image_items(e),
        ElementType::Frame | ElementType::MagicFrame => frame_items(e, m, o),
        ElementType::StickyNote => sticky_items(e),
    };
    let [x1, y1, x2, y2, ..] = get_element_absolute_coords(e, map, false);
    let mut origin = [e.x, e.y];
    let mut center = [(x2 - x1) / 2. - (e.x - x1), (y2 - y1) / 2. - (e.y - y1)];
    if e.is_text()
        && let Some(c) = get_container_element(e, map).filter(|c| c.is_arrow())
    {
        let [cx1, cy1, cx2, cy2, ..] = get_element_absolute_coords(c, map, false);
        let p = get_bound_text_element_position(c, e, map);
        center = [
            (cx2 - cx1) / 2. - (p[0] - cx1),
            (cy2 - cy1) / 2. - (p[1] - cy1),
        ];
        origin = p;
    }
    let frame = get_containing_frame(e, map);
    let opacity =
        frame.map_or(100., |f| f.opacity.clamp(0., 100.)) * e.opacity.clamp(0., 100.) / 10000.;
    let clip = frame
        .filter(|f| o.frame_clip && f.is_frame_like() && is_frame_clippable(e, map))
        .map(|f| Clip {
            frame_id: f.id.clone(),
            rect: [f.x, f.y, f.width, f.height],
            radius: FrameStyle::RADIUS,
            angle: f.angle,
        });
    let knockout = if e.is_arrow()
        && let Some(t) = get_bound_text_element(e, map)
    {
        let [tx, ty] = get_bound_text_element_position(e, t, map);
        Some([
            tx - e.x - BOUND_TEXT_PADDING,
            ty - e.y - BOUND_TEXT_PADDING,
            t.width + BOUND_TEXT_PADDING * 2.,
            t.height + BOUND_TEXT_PADDING * 2.,
        ])
    } else {
        None
    };
    Some(ElementDisplay {
        id: e.id.clone(),
        ty: e.ty(),
        origin,
        angle: e.angle,
        center,
        opacity,
        clip,
        knockout,
        link: e.link.clone().filter(|l| !l.is_empty()),
        items,
    })
}

/// The elements a scene paints, in paint order: visible elements, each
/// container followed by its text, iframe-likes on top.
pub fn renderable_elements<'a>(
    elements: &'a [Element],
    map: &'a dyn ElementsMap,
) -> Vec<&'a Element> {
    let visible = |e: &&Element| !e.is_deleted && !is_invisibly_small_element(e);
    let mut out = vec![];
    for pass_iframes in [false, true] {
        for e in elements
            .iter()
            .filter(visible)
            .filter(|e| e.is_iframe_like() == pass_iframes)
        {
            if e.is_text() && e.container_id().is_some_and(|c| map.has_element(c)) {
                continue;
            }
            out.push(e);
            if !pass_iframes
                && let Some(t) = e
                    .bound_text_id()
                    .and_then(|id| map.get_element(id))
                    .filter(|t| !t.is_deleted)
            {
                out.push(t);
            }
        }
    }
    out
}

/// `renderStaticScene`'s element pass as data.
pub fn scene_display(
    elements: &[Element],
    map: &dyn ElementsMap,
    m: &dyn Measure,
    o: &RenderOpts,
) -> Vec<ElementDisplay> {
    renderable_elements(elements, map)
        .into_iter()
        .filter_map(|e| element_display(e, map, m, o))
        .collect()
}
