// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Element geometry: the rough.js drawables every element paints, and the
//! outline it is hit-tested against. Port of Excalidraw @ 3a317b5
//! `element/src/shape.ts` (`generateRoughOptions`, `_generateElementShape`,
//! arrowhead shapes, freedraw outlines, elbow arrow path,
//! `generateLinearCollisionShape`, `getElementShape`,
//! `toggleLinePolygonState`) and `utils/src/shape.ts` (pure geometric
//! shapes), drawing with the rough.js port in `rough/`.
//!
//! Differences: shapes are generated without the theme (colors stay the
//! element's; the backend applies the dark-mode filter, `color.rs`), and
//! with the export-time iframe placeholder colors; an arrowhead says what
//! fills it (`HeadFill`) instead of carrying the canvas color string; the
//! per-element cache is the renderer's (keyed by element version, the
//! drawables being theme-free), not `ShapeCache`; constant-width freedraw
//! outlines come from perfect-freehand at the laser pointer's radius.

use super::bounds::{
    CARDINALITY_INNER_BAR_OFFSET, CARDINALITY_ONE_OR_MANY_BAR_OFFSET,
    CARDINALITY_ZERO_CIRCLE_OFFSET, CARDINALITY_ZERO_CIRCLE_SCALE, element_center_point,
    get_arrowhead_points, get_diamond_points, get_element_absolute_coords,
};
use super::collision::should_test_inside;
use super::consts::ROUGHNESS_CARTOONIST;
use super::freehand::{InputPoint, StrokeOptions, get_stroke, get_stroke_points};
use super::math::*;
use super::rough::{self, Random, path_data::Seg};
use super::types::{
    Arrowhead, Element, ElementType, FillStyle, StartOrEnd, StrokeStyle, StrokeVariability,
    can_become_polygon,
};
use super::utils::{
    ElementsMap, can_change_roundness, get_corner_radius, is_path_a_loop, is_transparent,
};

pub use super::rough::curve::{curve_to_bezier, points_on_bezier_curves, simplify};
pub use super::rough::{Drawable, Op, OpSet, OpSetType};

/// A drawing command, in the element's local (unrotated) coordinates unless
/// said otherwise.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PathCmd {
    MoveTo(Point),
    LineTo(Point),
    QuadTo(Point, Point),
    CubicTo(Point, Point, Point),
    Close,
}

pub fn ops_to_path(ops: &[Op]) -> Vec<PathCmd> {
    ops.iter()
        .map(|o| match *o {
            Op::Move(p) => PathCmd::MoveTo(p),
            Op::LineTo(p) => PathCmd::LineTo(p),
            Op::BCurveTo(a, b, c) => PathCmd::CubicTo(a, b, c),
        })
        .collect()
}

/// Our commands as path segments (for `rough::path_segs`).
pub fn path_to_segs(cmds: &[PathCmd]) -> Vec<Seg> {
    cmds.iter()
        .map(|c| match *c {
            PathCmd::MoveTo(p) => Seg::new('M', &p),
            PathCmd::LineTo(p) => Seg::new('L', &p),
            PathCmd::QuadTo(a, p) => Seg::new('Q', &[a[0], a[1], p[0], p[1]]),
            PathCmd::CubicTo(a, b, p) => Seg::new('C', &[a[0], a[1], b[0], b[1], p[0], p[1]]),
            PathCmd::Close => Seg::new('Z', &[]),
        })
        .collect()
}

pub fn translate_path(cmds: &[PathCmd], d: Vector) -> Vec<PathCmd> {
    let t = |p: Point| point_translate(p, d);
    cmds.iter()
        .map(|c| match *c {
            PathCmd::MoveTo(p) => PathCmd::MoveTo(t(p)),
            PathCmd::LineTo(p) => PathCmd::LineTo(t(p)),
            PathCmd::QuadTo(a, p) => PathCmd::QuadTo(t(a), t(p)),
            PathCmd::CubicTo(a, b, p) => PathCmd::CubicTo(t(a), t(b), t(p)),
            PathCmd::Close => PathCmd::Close,
        })
        .collect()
}

// rough options

/// `getDashArrayDashed`.
pub fn dash_array_dashed(sw: f64) -> Vec<f64> {
    vec![8., 8. + sw]
}
/// `getDashArrayDotted`.
pub fn dash_array_dotted(sw: f64) -> Vec<f64> {
    vec![1.5, 6. + sw]
}

/// `adjustRoughness`: small shapes are drawn less rough.
pub fn adjust_roughness(e: &Element) -> f64 {
    let (max, min) = (e.width.max(e.height), e.width.min(e.height));
    if (min >= 20. && max >= 50.)
        || (min >= 15. && e.roundness.is_some() && can_change_roundness(e.ty()))
        || (e.is_linear() && max >= 50.)
    {
        return e.roughness;
    }
    (e.roughness / if max < 10. { 3. } else { 2. }).min(2.5)
}

fn rough_fill_style(f: FillStyle) -> rough::FillStyle {
    match f {
        FillStyle::Hachure => rough::FillStyle::Hachure,
        FillStyle::CrossHatch => rough::FillStyle::CrossHatch,
        FillStyle::Solid => rough::FillStyle::Solid,
        FillStyle::Zigzag => rough::FillStyle::Zigzag,
    }
}

/// `generateRoughOptions` (light theme: colors as stored).
pub fn generate_rough_options(e: &Element, continuous_path: bool) -> rough::Options {
    let sw = e.stroke_width;
    let mut o = rough::Options {
        seed: e.seed,
        stroke_line_dash: match e.stroke_style {
            StrokeStyle::Dashed => Some(dash_array_dashed(sw)),
            StrokeStyle::Dotted => Some(dash_array_dotted(sw)),
            StrokeStyle::Solid => None,
        },
        disable_multi_stroke: e.stroke_style != StrokeStyle::Solid,
        stroke_width: if e.stroke_style != StrokeStyle::Solid {
            sw + 0.5
        } else {
            sw
        },
        fill_weight: sw / 2.,
        hachure_gap: sw * 4.,
        roughness: adjust_roughness(e),
        stroke: Some(e.stroke_color.clone()),
        preserve_vertices: continuous_path || e.roughness < ROUGHNESS_CARTOONIST,
        ..Default::default()
    };
    match e.ty() {
        ElementType::Rectangle
        | ElementType::Iframe
        | ElementType::Embeddable
        | ElementType::Diamond
        | ElementType::Ellipse => {
            o.fill_style = rough_fill_style(e.fill_style);
            o.fill = (!is_transparent(&e.background_color)).then(|| e.background_color.clone());
            if e.ty() == ElementType::Ellipse {
                o.curve_fitting = 1.;
            }
        }
        ElementType::Line | ElementType::FreeDraw
            if is_path_a_loop(e.points().unwrap_or(&[]), 1.) =>
        {
            o.fill_style = rough_fill_style(e.fill_style);
            o.fill = (e.background_color != "transparent").then(|| e.background_color.clone());
        }
        _ => {}
    }
    o
}

/// `modifyIframeLikeForRoughOptions` as when exporting: the element an
/// iframe-like is drawn as.
fn iframe_like_for_rough_options(e: &Element) -> std::borrow::Cow<'_, Element> {
    use std::borrow::Cow;
    if e.is_iframe_like() && is_transparent(&e.background_color) && is_transparent(&e.stroke_color)
    {
        let mut m = e.clone();
        m.roughness = 0.;
        m.background_color = "#d3d3d3".into();
        m.fill_style = FillStyle::Solid;
        return Cow::Owned(m);
    }
    if e.is_iframe() {
        let mut m = e.clone();
        if is_transparent(&m.stroke_color) {
            m.stroke_color = "#000000".into();
        }
        if is_transparent(&m.background_color) {
            m.background_color = "#f4f4f6".into();
        }
        return Cow::Owned(m);
    }
    Cow::Borrowed(e)
}

// element shapes

/// What fills an arrowhead: the arrow's stroke color or the canvas
/// background (the `*_outline` heads).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeadFill {
    Stroke,
    Background,
}

/// One drawable of a line or arrow: the line itself first, then its
/// arrowheads (with what fills them).
#[derive(Clone, Debug, PartialEq)]
pub struct LinearPart {
    pub drawable: Drawable,
    pub head_fill: Option<HeadFill>,
}

/// `ElementShape`.
#[derive(Clone, Debug, PartialEq)]
pub enum ElementShape {
    /// Drawn otherwise (text, image, frame, sticky note, selection).
    None,
    /// Rectangles, diamonds, ellipses and iframe-likes.
    Single(Drawable),
    Linear(Vec<LinearPart>),
    /// The background curve of a loop, and the ink outline (filled with the
    /// stroke color).
    Freedraw {
        fill: Option<Drawable>,
        stroke: Vec<PathCmd>,
    },
}

/// `getCurvePathOps`: the first outline set's ops.
pub fn get_curve_path_ops(d: &Drawable) -> &[Op] {
    d.sets
        .iter()
        .find(|s| s.ty == OpSetType::Path)
        .or(d.sets.first())
        .map_or(&[], |s| &s.ops)
}

/// The rounded rectangle path of `_generateElementShape`.
pub fn rounded_rect_path(w: f64, h: f64, r: f64) -> Vec<PathCmd> {
    use PathCmd::*;
    vec![
        MoveTo([r, 0.]),
        LineTo([w - r, 0.]),
        QuadTo([w, 0.], [w, r]),
        LineTo([w, h - r]),
        QuadTo([w, h], [w - r, h]),
        LineTo([r, h]),
        QuadTo([0., h], [0., h - r]),
        LineTo([0., r]),
        QuadTo([0., 0.], [r, 0.]),
    ]
}

/// The rounded diamond path of `_generateElementShape`.
pub fn rounded_diamond_path(e: &Element) -> Vec<PathCmd> {
    let [tx, ty, rx, ry, bx, by, lx, ly] = get_diamond_points(e);
    let v = get_corner_radius((tx - lx).abs(), e);
    let h = get_corner_radius((ry - ty).abs(), e);
    use PathCmd::*;
    vec![
        MoveTo([tx + v, ty + h]),
        LineTo([rx - v, ry - h]),
        CubicTo([rx, ry], [rx, ry], [rx - v, ry + h]),
        LineTo([bx + v, by - h]),
        CubicTo([bx, by], [bx, by], [bx - v, by - h]),
        LineTo([lx + v, ly + h]),
        CubicTo([lx, ly], [lx, ly], [lx + v, ly - h]),
        LineTo([tx - v, ty + h]),
        CubicTo([tx, ty], [tx, ty], [tx + v, ty + h]),
    ]
}

/// The points a linear element draws through (`[0, 0]` while empty).
fn linear_points(e: &Element) -> Vec<Point> {
    let p = e.points().unwrap_or(&[]);
    if p.is_empty() {
        vec![[0., 0.]]
    } else {
        p.to_vec()
    }
}

fn extreme(points: &[Point]) -> bool {
    !points
        .iter()
        .all(|p| p[0].abs() <= 1e6 && p[1].abs() <= 1e6)
}

/// The line or arrow drawable (`shape[0]`) through `points`.
fn linear_drawable(e: &Element, points: &[Point]) -> Option<Drawable> {
    if e.is_elbow_arrow() {
        // upstream doesn't render elbow arrows with extreme points
        if extreme(points) {
            return None;
        }
        return Some(rough::path_segs(
            &path_to_segs(&generate_elbow_arrow_shape(
                points,
                ELBOW_ARROW_CORNER_RADIUS,
            )),
            &generate_rough_options(e, true),
        ));
    }
    let o = generate_rough_options(e, false);
    Some(if e.roundness.is_none() {
        if o.fill.is_some() {
            rough::polygon(points, &o)
        } else {
            rough::linear_path(points, &o)
        }
    } else {
        rough::curve(points, &o)
    })
}

/// The outline ops (`getCurvePathOps(shape[0])`) of a line or arrow drawn
/// through `points`, local and unrotated. Only the outline is generated:
/// rough.js draws it before any fill, so the fill doesn't change it.
pub fn linear_ops_for_points(e: &Element, points: &[Point]) -> Vec<Op> {
    if e.is_elbow_arrow() {
        if extreme(points) {
            return vec![];
        }
        let o = generate_rough_options(e, true);
        let segs = rough::path_data::normalize(&rough::path_data::absolutize(&path_to_segs(
            &generate_elbow_arrow_shape(points, ELBOW_ARROW_CORNER_RADIUS),
        )));
        return rough::renderer::svg_path(&segs, &o, &mut Random::new(o.seed)).ops;
    }
    let o = generate_rough_options(e, false);
    let mut r = Random::new(o.seed);
    if e.roundness.is_none() {
        rough::renderer::linear_path(points, o.fill.is_some(), &o, &mut r).ops
    } else {
        rough::renderer::curve(points, &o, &mut r).ops
    }
}

/// The ops of `points` drawn with rough.js `linearPath` or `curve` and the
/// element's options (`getElementPointsCoords`, `getResizedElementAbsoluteCoords`).
pub fn points_curve_ops(e: &Element, points: &[Point]) -> Vec<Op> {
    let o = generate_rough_options(e, false);
    let mut r = Random::new(o.seed);
    if e.roundness.is_none() {
        rough::renderer::linear_path(points, false, &o, &mut r).ops
    } else {
        rough::renderer::curve(points, &o, &mut r).ops
    }
}

/// `ShapeCache.generateElementShape(element)[0]`'s path ops for lines and
/// arrows.
pub fn linear_shape_ops(e: &Element) -> Vec<Op> {
    linear_ops_for_points(e, &linear_points(e))
}

/// `_generateElementShape` (light theme, iframe-likes as exported).
pub fn generate_element_shape(e: &Element) -> ElementShape {
    match e.ty() {
        ElementType::Rectangle | ElementType::Iframe | ElementType::Embeddable => {
            let m = iframe_like_for_rough_options(e);
            ElementShape::Single(if e.roundness.is_some() {
                let r = get_corner_radius(e.width.min(e.height), e);
                rough::path_segs(
                    &path_to_segs(&rounded_rect_path(e.width, e.height, r)),
                    &generate_rough_options(&m, true),
                )
            } else {
                rough::rectangle(
                    0.,
                    0.,
                    e.width,
                    e.height,
                    &generate_rough_options(&m, false),
                )
            })
        }
        ElementType::Diamond => ElementShape::Single(if e.roundness.is_some() {
            rough::path_segs(
                &path_to_segs(&rounded_diamond_path(e)),
                &generate_rough_options(e, true),
            )
        } else {
            let [tx, ty, rx, ry, bx, by, lx, ly] = get_diamond_points(e);
            rough::polygon(
                &[[tx, ty], [rx, ry], [bx, by], [lx, ly]],
                &generate_rough_options(e, false),
            )
        }),
        ElementType::Ellipse => ElementShape::Single(rough::ellipse(
            e.width / 2.,
            e.height / 2.,
            e.width,
            e.height,
            &generate_rough_options(e, false),
        )),
        ElementType::Line | ElementType::Arrow => {
            let points = linear_points(e);
            let Some(line) = linear_drawable(e, &points) else {
                return ElementShape::Linear(vec![]);
            };
            let mut parts = vec![LinearPart {
                drawable: line,
                head_fill: None,
            }];
            if let Some(l) = e.linear().filter(|_| e.is_arrow()) {
                let options = generate_rough_options(e, false);
                let ops = get_curve_path_ops(&parts[0].drawable).to_vec();
                for (pos, head) in [
                    (StartOrEnd::Start, l.start_arrowhead),
                    (StartOrEnd::End, l.end_arrowhead),
                ] {
                    if let Some(head) = head {
                        parts.extend(arrowhead_shapes(e, &ops, pos, head, &options));
                    }
                }
            }
            ElementShape::Linear(parts)
        }
        ElementType::FreeDraw => {
            let fill = is_path_a_loop(e.points().unwrap_or(&[]), 1.).then(|| {
                rough::curve(
                    &get_freedraw_fill_curve_points(e),
                    &rough::Options {
                        stroke: None,
                        ..generate_rough_options(e, false)
                    },
                )
            });
            ElementShape::Freedraw {
                fill,
                stroke: get_svg_path_from_stroke(&get_freedraw_outline_points(e)),
            }
        }
        _ => ElementShape::None,
    }
}

// arrowheads

/// `getArrowheadLineOptions`.
fn arrowhead_line_options(e: &Element, o: &rough::Options) -> rough::Options {
    let mut lo = o.clone();
    lo.stroke_line_dash = (e.stroke_style == StrokeStyle::Dotted).then(|| {
        let d = dash_array_dotted(e.stroke_width - 1.);
        vec![d[0], d[1] - 1.]
    });
    lo.roughness = lo.roughness.min(1.);
    lo
}

/// `fillArrowheadOutline`: a fill set along the outline's (single) stroke.
fn fill_arrowhead_outline(mut d: Drawable, fill: HeadFill, stroke: &str) -> LinearPart {
    let ops: Vec<Op> = d
        .sets
        .iter()
        .flat_map(|s| s.ops.iter())
        .enumerate()
        .map(|(i, o)| match *o {
            Op::Move(p) if i > 0 => Op::LineTo(p),
            o => o,
        })
        .collect();
    d.options.fill = (fill == HeadFill::Stroke).then(|| stroke.to_owned());
    d.sets.insert(
        0,
        OpSet {
            ty: OpSetType::FillPath,
            ops,
        },
    );
    LinearPart {
        drawable: d,
        head_fill: Some(fill),
    }
}

/// `getArrowheadShapes` for one end, local coordinates. `ops` is the arrow's
/// `getCurvePathOps(shape[0])`, `options` its `generateRoughOptions`.
pub fn arrowhead_shapes(
    e: &Element,
    ops: &[Op],
    position: StartOrEnd,
    arrowhead: Arrowhead,
    options: &rough::Options,
) -> Vec<LinearPart> {
    let stroke = e.stroke_color.as_str();
    let pts = |head: Arrowhead, offset: f64| get_arrowhead_points(e, ops, position, head, offset);
    let line_opts = arrowhead_line_options(e, options);
    let part = |d: Drawable| LinearPart {
        drawable: d,
        head_fill: None,
    };
    let one = |p: Option<Vec<f64>>| -> Vec<LinearPart> {
        p.map(|p| part(rough::line(p[2], p[3], p[4], p[5], &line_opts)))
            .into_iter()
            .collect()
    };
    let to_tip = |p: Option<Vec<f64>>| -> Vec<LinearPart> {
        p.map(|p| {
            vec![
                part(rough::line(p[2], p[3], p[0], p[1], &line_opts)),
                part(rough::line(p[4], p[5], p[0], p[1], &line_opts)),
            ]
        })
        .unwrap_or_default()
    };
    let circle = |p: Option<Vec<f64>>, fill: HeadFill, scale: f64| -> Vec<LinearPart> {
        p.map(|p| {
            let co = rough::Options {
                stroke: Some(stroke.into()),
                roughness: options.roughness.min(0.5),
                disable_multi_stroke: true,
                stroke_line_dash: None,
                ..options.clone()
            };
            fill_arrowhead_outline(rough::circle(p[0], p[1], p[2] * scale, &co), fill, stroke)
        })
        .into_iter()
        .collect()
    };
    let polygon = |p: Option<Vec<f64>>, fill: HeadFill| -> Vec<LinearPart> {
        p.map(|p| {
            let po = rough::Options {
                roughness: options.roughness.min(1.),
                disable_multi_stroke: true,
                preserve_vertices: true,
                stroke_line_dash: None,
                ..options.clone()
            };
            fill_arrowhead_outline(
                rough::polygon(&p.chunks(2).map(|c| [c[0], c[1]]).collect::<Vec<_>>(), &po),
                fill,
                stroke,
            )
        })
        .into_iter()
        .collect()
    };
    let fill_of = |outline: bool| {
        if outline {
            HeadFill::Background
        } else {
            HeadFill::Stroke
        }
    };
    use Arrowhead::*;
    match arrowhead {
        Circle | CircleOutline => {
            circle(pts(arrowhead, 0.), fill_of(arrowhead == CircleOutline), 1.)
        }
        Triangle | TriangleOutline => {
            polygon(pts(arrowhead, 0.), fill_of(arrowhead == TriangleOutline))
        }
        Diamond | DiamondOutline => {
            polygon(pts(arrowhead, 0.), fill_of(arrowhead == DiamondOutline))
        }
        CardinalityOne => one(pts(CardinalityOne, 0.)),
        CardinalityMany => to_tip(pts(CardinalityMany, 0.)),
        CardinalityOneOrMany => [
            to_tip(pts(CardinalityMany, 0.)),
            one(pts(CardinalityOne, CARDINALITY_ONE_OR_MANY_BAR_OFFSET)),
        ]
        .concat(),
        CardinalityExactlyOne => [
            one(pts(CardinalityOne, CARDINALITY_INNER_BAR_OFFSET)),
            one(pts(CardinalityOne, 0.)),
        ]
        .concat(),
        CardinalityZeroOrOne => [
            circle(
                pts(CircleOutline, CARDINALITY_ZERO_CIRCLE_OFFSET),
                HeadFill::Background,
                CARDINALITY_ZERO_CIRCLE_SCALE,
            ),
            one(pts(CardinalityOne, CARDINALITY_INNER_BAR_OFFSET)),
        ]
        .concat(),
        CardinalityZeroOrMany => [
            to_tip(pts(CardinalityMany, 0.)),
            circle(
                pts(CircleOutline, CARDINALITY_ZERO_CIRCLE_OFFSET),
                HeadFill::Background,
                CARDINALITY_ZERO_CIRCLE_SCALE,
            ),
        ]
        .concat(),
        Arrow | Bar => to_tip(pts(arrowhead, 0.)),
    }
}

// elbow arrows

pub const ELBOW_ARROW_CORNER_RADIUS: f64 = 16.;

/// `generateElbowArrowShape`: straight runs joined by quadratic corners.
pub fn generate_elbow_arrow_shape(route: &[Point], radius: f64) -> Vec<PathCmd> {
    // a jog too short to see is drawn straight (see upstream)
    let is_jog = |i: usize| {
        if i < 2 || i + 2 > route.len() {
            return false;
        }
        let (a, b, c, d) = (route[i - 2], route[i - 1], route[i], route[i + 1]);
        point_distance(b, c) < 1.
            && point_distance(a, b) >= 1.
            && point_distance(c, d) >= 1.
            && (b[0] - a[0]) * (d[0] - c[0]) + (b[1] - a[1]) * (d[1] - c[1]) > 0.
    };
    let points: Vec<Point> = route
        .iter()
        .enumerate()
        .filter(|&(i, _)| !is_jog(i) && !is_jog(i + 1))
        .map(|(_, &p)| p)
        .collect();
    if points.is_empty() {
        return vec![];
    }
    let mut sub: Vec<Point> = vec![];
    for i in 1..points.len().saturating_sub(1) {
        let (prev, next, p) = (points[i - 1], points[i + 1], points[i]);
        let corner = radius
            .min(point_distance(p, next) / 2.)
            .min(point_distance(p, prev) / 2.);
        let side = |towards: Point, horizontal: bool| {
            if horizontal {
                if towards[0] < p[0] {
                    [p[0] - corner, p[1]]
                } else {
                    [p[0] + corner, p[1]]
                }
            } else if towards[1] < p[1] {
                [p[0], p[1] - corner]
            } else {
                [p[0], p[1] + corner]
            }
        };
        sub.push(side(prev, heading_for_point_is_horizontal(p, prev)));
        sub.push(p);
        sub.push(side(next, heading_for_point_is_horizontal(next, p)));
    }
    let mut d = vec![PathCmd::MoveTo(points[0])];
    for c in sub.chunks(3) {
        d.push(PathCmd::LineTo(c[0]));
        d.push(PathCmd::QuadTo(c[1], c[2]));
    }
    d.push(PathCmd::LineTo(points[points.len() - 1]));
    d
}

/// `headingForPointIsHorizontal` (heading.ts).
fn heading_for_point_is_horizontal(p: Point, o: Point) -> bool {
    let (x, y) = (p[0] - o[0], p[1] - o[1]);
    x > y.abs() || x <= -y.abs()
}

/// `generateLinearCollisionShape`: rotated ops, relative to `x`, `y`.
pub fn generate_linear_collision_shape(e: &Element, map: &dyn ElementsMap) -> Vec<Op> {
    let center = element_center_point(e, map, 0., 0.);
    let rot = |p: Point| {
        let q = point_rotate_rads([e.x + p[0], e.y + p[1]], center, e.angle);
        [q[0] - e.x, q[1] - e.y]
    };
    let options = rough::Options {
        seed: e.seed,
        disable_multi_stroke: true,
        disable_multi_stroke_fill: true,
        roughness: 0.,
        preserve_vertices: true,
        ..Default::default()
    };
    if e.is_freedraw() {
        let outline = get_freedraw_outline_points(e);
        if outline.len() < 2 {
            return vec![];
        }
        let outline = if e
            .freedraw()
            .is_some_and(|f| f.stroke_options.variability == StrokeVariability::Constant)
        {
            simplify(&outline, CONSTANT_COLLISION_SIMPLIFY_TOLERANCE)
        } else {
            outline
        };
        if outline.len() < 2 {
            return vec![];
        }
        let mut closed = outline.clone();
        if outline[0] != outline[outline.len() - 1] {
            closed.push(outline[0]);
        }
        return closed
            .iter()
            .enumerate()
            .map(|(i, &p)| {
                if i == 0 {
                    Op::Move(rot(p))
                } else {
                    Op::LineTo(rot(p))
                }
            })
            .collect();
    }
    let points = linear_points(e);
    if e.is_elbow_arrow() {
        let d = rough::path_segs(
            &path_to_segs(&generate_elbow_arrow_shape(
                &points,
                ELBOW_ARROW_CORNER_RADIUS,
            )),
            &options,
        );
        return d.sets.first().map_or(vec![], |s| s.ops.clone());
    }
    if e.roundness.is_none() {
        return points
            .iter()
            .enumerate()
            .map(|(i, &p)| {
                if i == 0 {
                    Op::Move(rot(p))
                } else {
                    Op::LineTo(rot(p))
                }
            })
            .collect();
    }
    let n = e.points().map_or(0, |p| p.len());
    let d = rough::curve(&points, &options);
    d.sets.first().map_or(vec![], |s| {
        s.ops.iter().take(n).map(|o| o.map(rot)).collect()
    })
}

// freedraw

const VARIABLE_SIZE_FACTOR: f64 = 4.25;
const VARIABLE_THINNING: f64 = 0.6;
const VARIABLE_SMOOTHING: f64 = 0.5;
const CONSTANT_SIZE_FACTOR: f64 = 1.4;
const CONSTANT_COLLISION_SIMPLIFY_TOLERANCE: f64 = 0.2;

fn freedraw_streamline(e: &Element) -> f64 {
    e.freedraw()
        .map_or(super::consts::DEFAULT_STROKE_STREAMLINE, |f| {
            f.stroke_options.streamline
        })
}
fn ease_out_sine(t: f64) -> f64 {
    (t * PI / 2.).sin()
}

/// `getFreedrawOutlinePoints`: the ink outline, local coordinates.
///
/// Constant-width strokes upstream come from `@excalidraw/laser-pointer`
/// (pressure pinned to 1, size `strokeWidth * 1.4` as the radius); we
/// approximate them with perfect-freehand without thinning at the same
/// radius.
pub fn get_freedraw_outline_points(e: &Element) -> Vec<Point> {
    let Some(f) = e.freedraw() else { return vec![] };
    if f.stroke_options.variability == StrokeVariability::Constant {
        let input: Vec<InputPoint> = f
            .points
            .iter()
            .map(|&point| InputPoint {
                point,
                pressure: Some(1.),
            })
            .collect();
        let o = StrokeOptions {
            size: e.stroke_width * CONSTANT_SIZE_FACTOR * 2.,
            thinning: 0.,
            smoothing: VARIABLE_SMOOTHING,
            streamline: freedraw_streamline(e),
            simulate_pressure: false,
            last: true,
            ..Default::default()
        };
        return get_stroke(&input, &o);
    }
    let input: Vec<InputPoint> = if f.simulate_pressure {
        f.points
            .iter()
            .map(|&point| InputPoint {
                point,
                pressure: None,
            })
            .collect()
    } else if !f.points.is_empty() {
        f.points
            .iter()
            .enumerate()
            .map(|(i, &point)| InputPoint {
                point,
                pressure: f.pressures.get(i).copied(),
            })
            .collect()
    } else {
        vec![InputPoint {
            point: [0., 0.],
            pressure: Some(0.5),
        }]
    };
    let o = StrokeOptions {
        size: e.stroke_width * VARIABLE_SIZE_FACTOR,
        thinning: VARIABLE_THINNING,
        smoothing: VARIABLE_SMOOTHING,
        streamline: freedraw_streamline(e),
        easing: ease_out_sine,
        simulate_pressure: f.simulate_pressure,
        last: true,
    };
    get_stroke(&input, &o)
}

/// `getFreedrawMaxStrokeRadius`: how far ink can reach past the points.
pub fn get_freedraw_max_stroke_radius(e: &Element) -> f64 {
    if e.freedraw()
        .is_some_and(|f| f.stroke_options.variability == StrokeVariability::Constant)
    {
        e.stroke_width * CONSTANT_SIZE_FACTOR
    } else {
        e.stroke_width * VARIABLE_SIZE_FACTOR + 3.
    }
}

/// `getFreedrawStrokeCenterPoints`: the smoothed centerline.
pub fn get_freedraw_stroke_center_points(e: &Element) -> Vec<Point> {
    let pts: Vec<InputPoint> = e
        .points()
        .unwrap_or(&[])
        .iter()
        .map(|&point| InputPoint {
            point,
            pressure: None,
        })
        .collect();
    let o = StrokeOptions {
        size: e.stroke_width * VARIABLE_SIZE_FACTOR,
        streamline: freedraw_streamline(e),
        last: true,
        ..Default::default()
    };
    get_stroke_points(&pts, &o)
        .into_iter()
        .map(|p| p.point)
        .collect()
}

/// `getFreedrawFillCurvePoints`: the simplified centerline a loop's fill
/// is drawn along.
pub fn get_freedraw_fill_curve_points(e: &Element) -> Vec<Point> {
    simplify(e.points().unwrap_or(&[]), 0.75)
}

/// `getFreedrawFillPolygon`: the flattened fill contour of a loop, local.
pub fn get_freedraw_fill_polygon(e: &Element) -> Vec<Point> {
    let d = rough::curve(
        &get_freedraw_fill_curve_points(e),
        &rough::Options {
            roughness: 0.,
            disable_multi_stroke: true,
            ..Default::default()
        },
    );
    let mut pts = vec![];
    for o in get_curve_path_ops(&d) {
        match *o {
            Op::Move(p) | Op::LineTo(p) => pts.push(p),
            Op::BCurveTo(a, b, c) => pts.extend([a, b, c]),
        }
    }
    polygon_from_points(&points_on_bezier_curves(&pts, 0.5, None))
}

/// The SVG number truncation of `getSvgPathFromStroke` (`TO_FIXED_PRECISION`):
/// at most two decimals, cut, not rounded (of the number as JS prints it,
/// so 0.29 stays 0.29).
fn to_fixed_precision(v: f64) -> f64 {
    let r = (v * 100.).round() / 100.;
    if (r - v).abs() < 1e-9 || !v.is_finite() {
        return v;
    }
    (v * 100.).trunc() / 100.
}

/// `getSvgPathFromStroke`: quadratic midpoints through the outline.
pub fn get_svg_path_from_stroke(points: &[Point]) -> Vec<PathCmd> {
    if points.is_empty() {
        return vec![];
    }
    let f = |p: Point| [to_fixed_precision(p[0]), to_fixed_precision(p[1])];
    let n = points.len();
    let mid = |a: Point, b: Point| f(point_center(a, b));
    let mut d = vec![
        PathCmd::MoveTo(f(points[0])),
        PathCmd::QuadTo(f(points[0]), mid(points[0], points[1 % n])),
    ];
    for i in 1..n {
        d.push(PathCmd::QuadTo(
            f(points[i]),
            mid(points[i], points[(i + 1) % n]),
        ));
    }
    d.push(PathCmd::LineTo(f(points[0])));
    d.push(PathCmd::Close);
    d
}

// utils/src/shape.ts: pure geometric shapes, in scene coordinates

#[derive(Clone, Debug, PartialEq)]
pub enum GeometricShape {
    Line(Segment),
    Polygon(Vec<Point>),
    Curve(Curve),
    Ellipse {
        center: Point,
        angle: f64,
        half_width: f64,
        half_height: f64,
    },
    Polyline(Vec<Segment>),
    Polycurve(Vec<Curve>),
}

/// `getPolygonShape`: rectangles, diamonds, frames, images, text, selection.
pub fn get_polygon_shape(e: &Element) -> GeometricShape {
    let (cx, cy) = (e.x + e.width / 2., e.y + e.height / 2.);
    let c = [cx, cy];
    let r = |p: Point| point_rotate_rads(p, c, e.angle);
    GeometricShape::Polygon(if e.ty() == ElementType::Diamond {
        vec![
            r([cx, e.y]),
            r([e.x + e.width, cy]),
            r([cx, e.y + e.height]),
            r([e.x, cy]),
        ]
    } else {
        vec![
            r([e.x, e.y]),
            r([e.x + e.width, e.y]),
            r([e.x + e.width, e.y + e.height]),
            r([e.x, e.y + e.height]),
        ]
    })
}

/// `getSelectionBoxShape` (padding 10 upstream).
pub fn get_selection_box_shape(e: &Element, map: &dyn ElementsMap, padding: f64) -> GeometricShape {
    let [x1, y1, x2, y2, cx, cy] = get_element_absolute_coords(e, map, true);
    let (x1, y1, x2, y2) = (x1 - padding, y1 - padding, x2 + padding, y2 + padding);
    let r = |p: Point| point_rotate_rads(p, [cx, cy], e.angle);
    GeometricShape::Polygon(vec![r([x1, y1]), r([x2, y1]), r([x2, y2]), r([x1, y2])])
}

pub fn get_ellipse_shape(e: &Element) -> GeometricShape {
    GeometricShape::Ellipse {
        center: [e.x + e.width / 2., e.y + e.height / 2.],
        angle: e.angle,
        half_width: e.width / 2.,
        half_height: e.height / 2.,
    }
}

/// `getCurveShape`: the cubics among `ops` (lines as straight cubics), moved
/// to `start` and rotated.
pub fn get_curve_shape(ops: &[Op], start: Point, angle: f64, center: Point) -> GeometricShape {
    let t = |p: Point| point_rotate_rads([p[0] + start[0], p[1] + start[1]], center, angle);
    let (mut out, mut p0) = (vec![], [0., 0.]);
    for o in ops {
        match *o {
            Op::Move(p) => p0 = t(p),
            Op::BCurveTo(a, b, c) => {
                let p3 = t(c);
                out.push([p0, t(a), t(b), p3]);
                p0 = p3;
            }
            // rough.js draws lines as straight cubics (ours are `LineTo`s)
            Op::LineTo(p) => {
                let p3 = t(p);
                out.push([
                    p0,
                    point_lerp(p0, p3, 1. / 3.),
                    point_lerp(p0, p3, 2. / 3.),
                    p3,
                ]);
                p0 = p3;
            }
        }
    }
    GeometricShape::Polycurve(out)
}

fn point_lerp(a: Point, b: Point, t: f64) -> Point {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/// `getFreedrawShape`.
pub fn get_freedraw_shape(e: &Element, center: Point, closed: bool) -> GeometricShape {
    let pts: Vec<Point> = e
        .points()
        .unwrap_or(&[])
        .iter()
        .map(|p| point_rotate_rads([p[0] + e.x, p[1] + e.y], center, e.angle))
        .collect();
    let segs: Vec<Segment> = pts.windows(2).map(|w| [w[0], w[1]]).collect();
    if closed {
        GeometricShape::Polygon(polygon_from_points(
            &segs.iter().flatten().copied().collect::<Vec<_>>(),
        ))
    } else {
        GeometricShape::Polyline(segs)
    }
}

/// `getClosedCurveShape`.
pub fn get_closed_curve_shape(
    e: &Element,
    ops: &[Op],
    start: Point,
    angle: f64,
    center: Point,
) -> GeometricShape {
    let t = |p: Point| point_rotate_rads([p[0] + start[0], p[1] + start[1]], center, angle);
    if e.roundness.is_none() {
        return GeometricShape::Polygon(polygon_from_points(
            &e.points()
                .unwrap_or(&[])
                .iter()
                .map(|&p| t(p))
                .collect::<Vec<_>>(),
        ));
    }
    let (mut pts, mut odd) = (vec![], false);
    for o in ops {
        match *o {
            Op::Move(p) => {
                odd = !odd;
                if odd {
                    pts.push(p)
                }
            }
            Op::BCurveTo(a, b, c) => {
                if odd {
                    pts.extend([a, b, c])
                }
            }
            Op::LineTo(p) => {
                if odd {
                    pts.push(p)
                }
            }
        }
    }
    GeometricShape::Polygon(polygon_from_points(
        &points_on_bezier_curves(&pts, 10., Some(5.))
            .into_iter()
            .map(t)
            .collect::<Vec<_>>(),
    ))
}

/// `getElementShape`: the pure shape hit tests use.
pub fn get_element_shape(e: &Element, map: &dyn ElementsMap) -> GeometricShape {
    match e.ty() {
        ElementType::Ellipse => get_ellipse_shape(e),
        ElementType::Arrow | ElementType::Line => {
            let ops = linear_shape_ops(e);
            let [.., cx, cy] = get_element_absolute_coords(e, map, false);
            if should_test_inside(e) {
                get_closed_curve_shape(e, &ops, [e.x, e.y], e.angle, [cx, cy])
            } else {
                get_curve_shape(&ops, [e.x, e.y], e.angle, [cx, cy])
            }
        }
        ElementType::FreeDraw => {
            let [.., cx, cy] = get_element_absolute_coords(e, map, false);
            get_freedraw_shape(e, [cx, cy], should_test_inside(e))
        }
        _ => get_polygon_shape(e),
    }
}

/// `segmentIntersectRectangleElement`.
pub fn segment_intersect_rectangle_element(e: &Element, s: Segment, gap: f64) -> Vec<Point> {
    let b = [
        e.x - gap,
        e.y - gap,
        e.x + e.width + gap,
        e.y + e.height + gap,
    ];
    let c = [(b[0] + b[2]) / 2., (b[1] + b[3]) / 2.];
    let r = |x: f64, y: f64| point_rotate_rads([x, y], c, e.angle);
    [
        [r(b[0], b[1]), r(b[2], b[1])],
        [r(b[2], b[1]), r(b[2], b[3])],
        [r(b[2], b[3]), r(b[0], b[3])],
        [r(b[0], b[3]), r(b[0], b[1])],
    ]
    .into_iter()
    .filter_map(|side| segments_intersect_at(s, side))
    .collect()
}

fn distance_to_rotated_ellipse(p: Point, center: Point, angle: f64, a: f64, b: f64) -> f64 {
    let [rx, ry] = point_rotate_rads([p[0] - center[0], p[1] - center[1]], [0., 0.], -angle);
    let (px, py) = (rx.abs(), ry.abs());
    let (mut tx, mut ty) = (0.707f64, 0.707f64);
    for _ in 0..3 {
        let (x, y) = (a * tx, b * ty);
        let ex = (a * a - b * b) * tx.powi(3) / a;
        let ey = (b * b - a * a) * ty.powi(3) / b;
        let (r, q) = ((y - ey).hypot(x - ex), (py - ey).hypot(px - ex));
        tx = ((((px - ex) * r) / q + ex) / a).clamp(0., 1.);
        ty = ((((py - ey) * r) / q + ey) / b).clamp(0., 1.);
        let t = ty.hypot(tx);
        tx /= t;
        ty /= t;
    }
    let sign = |v: f64| {
        if v > 0. {
            1.
        } else if v < 0. {
            -1.
        } else {
            0.
        }
    };
    point_distance([rx, ry], [a * tx * sign(rx), b * ty * sign(ry)])
}

/// `pointOnEllipse` (threshold `PRECISION` upstream) for an
/// `GeometricShape::Ellipse`.
pub fn point_on_ellipse(
    p: Point,
    center: Point,
    angle: f64,
    half_width: f64,
    half_height: f64,
    threshold: f64,
) -> bool {
    distance_to_rotated_ellipse(p, center, angle, half_width, half_height) <= threshold
}
pub fn point_in_ellipse(
    p: Point,
    center: Point,
    angle: f64,
    half_width: f64,
    half_height: f64,
) -> bool {
    let [x, y] = point_rotate_rads([p[0] - center[0], p[1] - center[1]], [0., 0.], -angle);
    (x / half_width) * (x / half_width) + (y / half_height) * (y / half_height) <= 1.
}

/// `toggleLinePolygonState`: the new `(polygon, points)`, None when the
/// line can't become a polygon.
pub fn toggle_line_polygon_state(e: &Element, next: bool) -> Option<(bool, Vec<Point>)> {
    let mut pts = e.points().unwrap_or(&[]).to_vec();
    if next {
        if !can_become_polygon(&pts) {
            return None;
        }
        let (first, last) = (pts[0], pts[pts.len() - 1]);
        if (first[0] - last[0]).hypot(first[1] - last[1]) > LINE_POLYGON_POINT_MERGE_DISTANCE
            || pts.len() < 4
        {
            pts.push(first)
        } else {
            let n = pts.len();
            pts[n - 1] = first;
        }
    }
    Some((next, pts))
}

/// `LINE_POLYGON_POINT_MERGE_DISTANCE`.
pub const LINE_POLYGON_POINT_MERGE_DISTANCE: f64 = 20.;
