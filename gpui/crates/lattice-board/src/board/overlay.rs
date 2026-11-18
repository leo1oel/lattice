// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The interactive layer over the scene, after Excalidraw
//! `renderer/interactiveScene.ts` and `renderSnaps.ts` @ 3a317b5: selection
//! borders (per element, groups dashed, the multi-selection box), transform
//! and rotation handles, the line editor's points and midpoints, the binding
//! highlight, snap lines, the box selection, the lasso and eraser trails, the
//! frame a drag drops into and the crop editor's handles (pending flowchart
//! nodes are drawn by the scene, faded). Built in `render`
//! as screen-space primitives (sizes in screen px, as upstream divides by
//! the zoom) and painted after the scene. Colors are upstream's: the
//! selection color is `--color-selection` (#6965db, dark #b4b0ff), the other
//! UI colors go through the dark-mode mapping (`getThemedColor`) as
//! upstream's do, the binding highlight and snap lines use upstream's own
//! dark values. Differs: no focus-point indicators or remote selections; the lasso trail is the path itself (dashed 7/7, no
//! taper), the eraser trail a 5px line without the fade.

use super::BoardView;
use super::bounds::{
    get_common_bounds, get_element_absolute_coords, get_element_line_segments,
    get_points_global_coordinates,
};
use super::canvas::Gesture;
use super::consts::DEFAULT_TRANSFORM_HANDLE_SPACING;
use super::groups::{get_elements_in_group, get_selected_group_ids, is_selected_via_group};
use super::handles::{
    HandleType, OMIT_SIDES_FOR_FRAME, PointerType, get_omit_sides_for_editor,
    get_transform_handles, get_transform_handles_from_coords, has_bounding_box,
};
use super::linear::get_editor_mid_points;
use super::math::point_rotate_rads;
use super::render::View;
use super::snapping::SnapLine;
use super::types::Element;
use gpui::*;

enum Prim {
    Poly {
        pts: Vec<Point<Pixels>>,
        closed: bool,
        stroke: Option<(Hsla, f32, Option<(f32, f32)>)>,
        fill: Option<Hsla>,
    },
    Circle {
        c: Point<Pixels>,
        r: f32,
        fill: Option<Hsla>,
        stroke: Option<(Hsla, f32)>,
    },
}

#[derive(Default)]
pub struct Overlay {
    prims: Vec<Prim>,
}

const POINT: f32 = super::bounds::POINT_HANDLE_SIZE as f32;

impl Overlay {
    fn line(
        &mut self,
        pts: Vec<Point<Pixels>>,
        closed: bool,
        color: Hsla,
        w: f32,
        dash: Option<(f32, f32)>,
    ) {
        self.prims.push(Prim::Poly {
            pts,
            closed,
            stroke: Some((color, w, dash)),
            fill: None,
        });
    }
    fn circle(
        &mut self,
        c: Point<Pixels>,
        r: f32,
        fill: Option<Hsla>,
        stroke: Option<(Hsla, f32)>,
    ) {
        self.prims.push(Prim::Circle { c, r, fill, stroke });
    }

    /// A rectangle `[x1, y1, x2, y2]` (scene) rotated about `c`, padded by
    /// `pad` screen px.
    fn rect(
        &mut self,
        v: &View,
        r: [f64; 4],
        c: [f64; 2],
        angle: f64,
        pad: f32,
        color: Hsla,
        dash: Option<(f32, f32)>,
    ) {
        let p = (pad / v.zoom) as f64;
        let corners = [
            [r[0] - p, r[1] - p],
            [r[2] + p, r[1] - p],
            [r[2] + p, r[3] + p],
            [r[0] - p, r[3] + p],
        ];
        let pts = corners
            .iter()
            .map(|q| v.to_screen(point_rotate_rads(*q, c, angle)))
            .collect();
        self.line(pts, true, color, 1., dash);
    }

    pub fn paint(&self, window: &mut Window) {
        // outside the canvas isn't drawn (a large selection outlines every element)
        let vis = window.content_mask().bounds;
        let (vx0, vy0, vx1, vy1) = (
            f32::from(vis.origin.x) - 16.,
            f32::from(vis.origin.y) - 16.,
            f32::from(vis.right()) + 16.,
            f32::from(vis.bottom()) + 16.,
        );
        let away = |pts: &[Point<Pixels>]| {
            let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for q in pts {
                let (x, y) = (f32::from(q.x), f32::from(q.y));
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            }
            x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1
        };
        for p in &self.prims {
            match p {
                Prim::Poly {
                    pts,
                    closed,
                    stroke,
                    fill,
                } => {
                    if pts.len() < 2 || away(pts) {
                        continue;
                    }
                    if let Some(f) = fill {
                        let mut pb = PathBuilder::fill();
                        pb.move_to(pts[0]);
                        for q in &pts[1..] {
                            pb.line_to(*q);
                        }
                        pb.close();
                        if let Ok(path) = pb.build() {
                            window.paint_path(path, *f);
                        }
                    }
                    if let Some((c, w, dash)) = stroke {
                        let mut pb = PathBuilder::stroke(px(*w));
                        if let Some((d, g)) = dash {
                            pb = pb.dash_array(&[px(*d), px(*g)]);
                        }
                        pb.move_to(pts[0]);
                        for q in &pts[1..] {
                            pb.line_to(*q);
                        }
                        if *closed {
                            pb.close();
                        }
                        if let Ok(path) = pb.build() {
                            window.paint_path(path, *c);
                        }
                    }
                }
                Prim::Circle { c, r, fill, stroke } => {
                    if away(&[
                        point(c.x - px(*r), c.y - px(*r)),
                        point(c.x + px(*r), c.y + px(*r)),
                    ]) {
                        continue;
                    }
                    let pts: Vec<Point<Pixels>> = (0..24)
                        .map(|i| {
                            let a = i as f32 / 24. * std::f32::consts::TAU;
                            point(c.x + px(r * a.cos()), c.y + px(r * a.sin()))
                        })
                        .collect();
                    if let Some(f) = fill {
                        let mut pb = PathBuilder::fill();
                        pb.move_to(pts[0]);
                        for q in &pts[1..] {
                            pb.line_to(*q);
                        }
                        pb.close();
                        if let Ok(path) = pb.build() {
                            window.paint_path(path, *f);
                        }
                    }
                    if let Some((col, w)) = stroke {
                        let mut pb = PathBuilder::stroke(px(*w));
                        pb.move_to(pts[0]);
                        for q in &pts[1..] {
                            pb.line_to(*q);
                        }
                        pb.close();
                        if let Ok(path) = pb.build() {
                            window.paint_path(path, *col);
                        }
                    }
                }
            }
        }
    }
}

/// `renderConfig.selectionColor` (`--color-selection`).
fn accent() -> Hsla {
    crate::board::chrome::style::selection()
}
/// `getThemedColor(c)`: an upstream UI color, dark-mode mapped as the canvas.
fn themed(r: u8, g: u8, b: u8, a: f64) -> Hsla {
    super::render::color(super::color::Rgba { r, g, b, a: 255 }, a)
}
fn handle_fill() -> Hsla {
    themed(255, 255, 255, 1.)
}
/// `BINDING_HIGHLIGHT_RGB`.
fn binding_highlight() -> Hsla {
    if crate::theme::dark() {
        Hsla::from(rgb(0x68b6f0))
    } else {
        Hsla::from(rgb(0x6abdfc))
    }
}

/// A rectangle with rounded corners (`roundRect`), as a polygon.
fn round_rect(a: Point<Pixels>, b: Point<Pixels>, r: f32) -> Vec<Point<Pixels>> {
    let (x0, y0, x1, y1) = (
        f32::from(a.x),
        f32::from(a.y),
        f32::from(b.x),
        f32::from(b.y),
    );
    let r = r.min((x1 - x0) / 2.).min((y1 - y0) / 2.).max(0.);
    let mut pts = vec![];
    for (cx, cy, start) in [
        (x1 - r, y0 + r, -90f32),
        (x1 - r, y1 - r, 0.),
        (x0 + r, y1 - r, 90.),
        (x0 + r, y0 + r, 180.),
    ] {
        for i in 0..=4 {
            let t = (start + i as f32 * 22.5).to_radians();
            pts.push(point(px(cx + r * t.cos()), px(cy + r * t.sin())));
        }
    }
    pts
}

/// Upstream `renderTransformHandles`: white boxes with 2px corners, the
/// rotation knob round, 1px selection-color borders.
fn handles(o: &mut Overlay, v: &View, hs: &super::handles::TransformHandles) {
    for (t, h) in &hs.0 {
        let a = v.to_screen([h[0], h[1]]);
        let b = v.to_screen([h[0] + h[2], h[1] + h[3]]);
        if *t == HandleType::Rotation {
            let c = point((a.x + b.x) / 2., (a.y + b.y) / 2.);
            o.circle(
                c,
                f32::from(b.x - a.x) / 2.,
                Some(handle_fill()),
                Some((accent(), 1.)),
            );
        } else {
            o.prims.push(Prim::Poly {
                pts: round_rect(a, b, 2.),
                closed: true,
                stroke: Some((accent(), 1., None)),
                fill: Some(handle_fill()),
            });
        }
    }
}

/// Upstream `renderCropHandles`: an L at each corner, 3px wide, 20px long.
fn crop_handles(o: &mut Overlay, v: &View, e: &Element, scene: &super::scene::Scene) {
    let [x1, y1, _, _, cx, cy] = get_element_absolute_coords(e, scene, false);
    let z = v.zoom as f64;
    let (lw, len) = (3. / z, 20. / z);
    let (hw, hh) = (cx - x1 + lw, cy - y1 + lw);
    let (lx, ly) = (len.min(hw), len.min(hh));
    let h = lw / 2.;
    // corner, then the horizontal and the vertical stroke (relative)
    let corners: [([f64; 2], [[f64; 2]; 4]); 4] = [
        ([-hw, -hh], [[0., h], [lx, h], [h, 0.], [h, ly]]),
        ([hw - h, -hh], [[h, h], [-lx + h, h], [0., 0.], [0., ly]]),
        ([-hw, hh], [[0., -h], [lx, -h], [h, 0.], [h, -ly]]),
        ([hw - h, hh], [[h, -h], [-lx + h, -h], [0., 0.], [0., -ly]]),
    ];
    let at =
        |q: [f64; 2]| v.to_screen(point_rotate_rads([cx + q[0], cy + q[1]], [cx, cy], e.angle));
    for ([x, y], s) in corners {
        o.line(
            vec![
                at([x + s[0][0], y + s[0][1]]),
                at([x + s[1][0], y + s[1][1]]),
            ],
            false,
            accent(),
            3.,
            None,
        );
        o.line(
            vec![
                at([x + s[2][0], y + s[2][1]]),
                at([x + s[3][0], y + s[3][1]]),
            ],
            false,
            accent(),
            3.,
            None,
        );
    }
}

pub fn build(me: &BoardView) -> Overlay {
    let mut o = Overlay::default();
    let v = me.view();
    let z = me.app.zoom;
    // Find on canvas's matches (\`renderSearchMatches\`): yellow, the focused
    // one orange, each a box over its run of text
    if let Some(search) = &me.search {
        for (i, m) in search.matches.iter().enumerate().filter(|(_, m)| !m.frame) {
            let Some(e) = me.scene.get_non_deleted_element(&m.id) else {
                continue;
            };
            let Some(q) = super::chrome::search::quad(e, m, &*me.m) else {
                continue;
            };
            let fill = if search.focus == Some(i) {
                hsla(29. / 360., 1., 0.5, 0.4)
            } else {
                hsla(60. / 360., 1., 0.62, 0.4)
            };
            o.prims.push(Prim::Poly {
                pts: q.iter().map(|p| v.to_screen(*p)).collect(),
                closed: true,
                stroke: None,
                fill: Some(fill),
            });
        }
    }
    let scene = &me.scene;
    // the frame a drag drops into (`renderFrameHighlight`: rgb(0,118,255),
    // the frame's 2px stroke and 8px radius)
    if let Some(f) = me
        .app
        .frame_to_highlight
        .as_deref()
        .and_then(|f| scene.get_non_deleted_element(f))
    {
        let [x1, y1, x2, y2, cx, cy] = get_element_absolute_coords(f, scene, false);
        let (a, b) = (v.to_screen([x1, y1]), v.to_screen([x2, y2]));
        let r = (super::consts::FrameStyle::RADIUS as f32).min(f32::from(b.x - a.x) / 2.);
        let pts = round_rect(a, b, r)
            .into_iter()
            .map(|p| {
                let q = v.to_scene(p);
                v.to_screen(point_rotate_rads(q, [cx, cy], f.angle))
            })
            .collect();
        o.line(
            pts,
            true,
            themed(0, 118, 255, 1.),
            super::consts::FrameStyle::STROKE_WIDTH as f32,
            None,
        );
    }
    // what an arrow end would bind to (`renderBindingHighlightForBindableElement_simple`:
    // the outline in `BINDING_HIGHLIGHT_RGB`, clamp(1.75, strokeWidth, 4) wide,
    // the snapped midpoint a 4px dot)
    if let Some(s) = &me.suggested
        && let Some(e) = scene.get_non_deleted_element(&s.element)
    {
        let col = binding_highlight();
        let w = if e.is_frame_like() {
            super::consts::FrameStyle::STROKE_WIDTH as f32
        } else {
            (e.stroke_width.clamp(1.75, 4.) * z / z.max(0.25)) as f32
        };
        for seg in get_element_line_segments(e, scene) {
            o.line(
                vec![v.to_screen(seg[0]), v.to_screen(seg[1])],
                false,
                col,
                w,
                None,
            );
        }
        if let Some(m) = s.mid_point {
            o.circle(v.to_screen(m), 4., Some(col), None);
        }
    }
    let creating = matches!(
        me.gesture,
        Some(Gesture::Shape(_)) | Some(Gesture::Linear(_)) | Some(Gesture::FreeDraw(_))
    ) || me.multi.is_some();
    let editing_line = me.linear.as_ref().is_some_and(|l| l.is_editing);
    let sel: Vec<&Element> = me.selected_elements();
    // line editor points (`renderLinearPointHandles` / `renderSingleLinearPoint`:
    // #5e5ad8 1px rings filled white 90%, selected rgba(134,131,226,.9); the
    // midpoints phantom rgba(177,151,252,.7) without a ring; the hovered
    // point or midpoint highlighted rgba(105,101,219,.4) at full size)
    if !creating
        && let [e] = sel.as_slice()
        && e.is_linear()
        && !e.locked
        && let Some(le) = me.linear.as_ref().filter(|l| l.element_id == e.id)
    {
        let pts = get_points_global_coordinates(e, scene);
        let r = if le.is_editing { POINT } else { POINT / 2. };
        let n = pts.len();
        let ring = themed(0x5e, 0x5a, 0xd8, 1.);
        for (i, p) in pts.iter().enumerate() {
            if e.is_elbow_arrow() && i != 0 && i != n - 1 {
                continue;
            }
            let selected = le.is_editing
                && le
                    .selected_points_indices
                    .as_ref()
                    .is_some_and(|s| s.contains(&i));
            let fill = if selected {
                themed(134, 131, 226, 0.9)
            } else {
                themed(255, 255, 255, 0.9)
            };
            o.circle(v.to_screen(*p), r, Some(fill), Some((ring, 1.)));
        }
        if le.is_editing || n == 2 {
            for m in get_editor_mid_points(e, scene, z, le.is_editing)
                .into_iter()
                .flatten()
            {
                o.circle(
                    v.to_screen(m),
                    POINT / 2.,
                    Some(themed(177, 151, 252, 0.7)),
                    None,
                );
            }
        }
        if !le.is_dragging {
            let hi = themed(105, 101, 219, 0.4);
            let hp = le.hover_point_index;
            if let Some(m) = le.segment_mid_point_hovered_coords {
                o.circle(v.to_screen(m), POINT, Some(hi), None);
            } else if hp >= 0
                && (hp as usize) < n
                && (!e.is_elbow_arrow() || hp == 0 || hp as usize == n - 1)
                && !(le.is_editing
                    && le
                        .selected_points_indices
                        .as_ref()
                        .is_some_and(|s| s.contains(&(hp as usize))))
            {
                o.circle(v.to_screen(pts[hp as usize]), POINT, Some(hi), None);
            }
        }
    }
    if !creating && !editing_line && me.text.is_none() {
        let show_box = has_bounding_box(&sel, me.linear_editing(), false);
        // `renderSelectionBorder`: 1px; dashed 8 / 4 for locked elements and groups
        let dashed = Some((8., 4.));
        let locked_col = themed(0xce, 0xd4, 0xda, 1.);
        if show_box {
            // off-canvas outlines aren't built: a shape's box lies within the
            // circle around its middle (lines and freedraw reach past theirs)
            let (ca, cb) = {
                let b = me.bounds.get();
                (v.to_scene(b.origin), v.to_scene(b.bottom_right()))
            };
            let margin = 64. / z;
            let off = |e: &Element| {
                !e.is_linear() && !e.is_freedraw() && {
                    let (mx, my, r) = (
                        e.x + e.width / 2.,
                        e.y + e.height / 2.,
                        e.width.hypot(e.height) / 2. + margin,
                    );
                    mx + r < ca[0] || mx - r > cb[0] || my + r < ca[1] || my - r > cb[1]
                }
            };
            for e in &sel {
                if off(e) {
                    continue;
                }
                if is_selected_via_group(
                    &me.app.selected_group_ids,
                    me.app.editing_group_id.as_deref(),
                    e,
                ) {
                    continue;
                }
                if sel.len() == 1 && e.is_elbow_arrow() && e.is_arrow_bound() {
                    continue;
                }
                let [x1, y1, x2, y2, cx, cy] = get_element_absolute_coords(e, scene, true);
                let pad = if e.is_image()
                    || me.app.cropping_element_id.as_deref() == Some(e.id.as_str())
                {
                    0.
                } else {
                    (DEFAULT_TRANSFORM_HANDLE_SPACING * 2.) as f32
                };
                let (col, dash) = if e.locked {
                    (locked_col, dashed)
                } else {
                    (accent(), None)
                };
                o.rect(&v, [x1, y1, x2, y2], [cx, cy], e.angle, pad, col, dash);
            }
            let els = scene.elements_including_deleted();
            let mut groups = get_selected_group_ids(&me.app.selected_group_ids);
            if let Some(g) = &me.app.editing_group_id {
                groups.push(g.clone());
            }
            for g in groups {
                let members: Vec<&Element> = get_elements_in_group(els, &g)
                    .into_iter()
                    .filter(|e| !e.is_deleted)
                    .collect();
                if members.is_empty() {
                    continue;
                }
                let [x1, y1, x2, y2] = get_common_bounds(members.iter().copied(), scene);
                let pad = (DEFAULT_TRANSFORM_HANDLE_SPACING * 2.) as f32;
                let col = if members.iter().any(|e| e.locked) {
                    locked_col
                } else {
                    themed(0, 0, 0, 1.)
                };
                o.rect(
                    &v,
                    [x1, y1, x2, y2],
                    [(x1 + x2) / 2., (y1 + y2) / 2.],
                    0.,
                    pad,
                    col,
                    dashed,
                );
            }
        }
        let rotating = matches!(&me.gesture, Some(Gesture::Select(s)) if s.resize.as_ref().is_some_and(|r| r.handle == HandleType::Rotation && r.started));
        if let Some(e) = me
            .app
            .cropping_element_id
            .as_deref()
            .and_then(|c| scene.get_non_deleted_element(c))
            .filter(|e| e.is_image())
        {
            if !me.app.is_cropping {
                crop_handles(&mut o, &v, e, scene);
            }
        } else if sel.len() == 1 && show_box {
            let hs = get_transform_handles(
                sel[0],
                z,
                scene,
                PointerType::Mouse,
                get_omit_sides_for_editor(true),
            );
            handles(&mut o, &v, &hs);
        } else if sel.len() > 1 && !rotating && !sel.iter().any(|e| e.locked) {
            // the common box dashed 2 / 2
            let [x1, y1, x2, y2] = get_common_bounds(sel.iter().copied(), scene);
            let pad = (DEFAULT_TRANSFORM_HANDLE_SPACING * 2.) as f32;
            o.rect(
                &v,
                [x1, y1, x2, y2],
                [(x1 + x2) / 2., (y1 + y2) / 2.],
                0.,
                pad,
                accent(),
                Some((2., 2.)),
            );
            let frame = sel.iter().any(|e| e.is_frame_like());
            let omit = if frame {
                OMIT_SIDES_FOR_FRAME
            } else {
                get_omit_sides_for_editor(true)
            };
            let hs = get_transform_handles_from_coords(
                [x1, y1, x2, y2, (x1 + x2) / 2., (y1 + y2) / 2.],
                0.,
                z,
                PointerType::Mouse,
                omit,
                4.,
                DEFAULT_TRANSFORM_HANDLE_SPACING,
            );
            handles(&mut o, &v, &hs);
        }
    }
    // snap lines (`renderSnaps`: #ff6b6b, dark #ff9090, 1px; 2px crosses at
    // points; gaps with 8px end ticks and a double tick in the middle)
    let snap = if crate::theme::dark() {
        Hsla::from(rgb(0xff9090))
    } else {
        Hsla::from(rgb(0xff6b6b))
    };
    let cross = |o: &mut Overlay, c: Point<Pixels>| {
        let s = px(2.);
        o.line(
            vec![point(c.x - s, c.y - s), point(c.x + s, c.y + s)],
            false,
            snap,
            1.,
            None,
        );
        o.line(
            vec![point(c.x + s, c.y - s), point(c.x - s, c.y + s)],
            false,
            snap,
            1.,
            None,
        );
    };
    for l in &me.snap_lines {
        match l {
            SnapLine::Points(ps) => {
                if ps.len() > 1 {
                    o.line(
                        vec![v.to_screen(ps[0]), v.to_screen(ps[ps.len() - 1])],
                        false,
                        snap,
                        1.,
                        None,
                    );
                }
                for p in ps {
                    cross(&mut o, v.to_screen(*p));
                }
            }
            SnapLine::Pointer { points, .. } => {
                cross(&mut o, v.to_screen(points[0]));
                o.line(
                    vec![v.to_screen(points[0]), v.to_screen(points[1])],
                    false,
                    snap,
                    1.,
                    None,
                );
            }
            SnapLine::Gap { direction, points } => {
                let (a, b) = (v.to_screen(points[0]), v.to_screen(points[1]));
                let (full, half, quarter) = (px(8.), px(4.), px(2.));
                let horizontal = matches!(direction, super::snapping::LineDirection::Horizontal);
                let mid = point((a.x + b.x) / 2., (a.y + b.y) / 2.);
                let tick = |o: &mut Overlay, c: Point<Pixels>, len: Pixels| {
                    if horizontal {
                        o.line(
                            vec![point(c.x, c.y - len), point(c.x, c.y + len)],
                            false,
                            snap,
                            1.,
                            None,
                        )
                    } else {
                        o.line(
                            vec![point(c.x - len, c.y), point(c.x + len, c.y)],
                            false,
                            snap,
                            1.,
                            None,
                        )
                    }
                };
                tick(&mut o, a, full);
                if horizontal {
                    tick(&mut o, point(mid.x - quarter, mid.y), half);
                    tick(&mut o, point(mid.x + quarter, mid.y), half);
                } else {
                    tick(&mut o, point(mid.x, mid.y - quarter), half);
                    tick(&mut o, point(mid.x, mid.y + quarter), half);
                }
                tick(&mut o, b, full);
                o.line(vec![a, b], false, snap, 1., None);
            }
        }
    }
    match &me.gesture {
        // the box selection (`renderSelectionElement`): rgba(0,0,200,.04), 1px selection color
        Some(Gesture::Select(s)) => {
            if let Some(r) = s.rect {
                let a = v.to_screen([r[0], r[1]]);
                let b = v.to_screen([r[2], r[3]]);
                o.prims.push(Prim::Poly {
                    pts: vec![a, point(b.x, a.y), b, point(a.x, b.y)],
                    closed: true,
                    stroke: Some((accent(), 1., None)),
                    fill: Some(themed(0, 0, 200, 0.04)),
                });
            }
        }
        // `LassoTrail`: the selection color, its fill at 5%, dashed 7 / 7
        Some(Gesture::Lasso(l)) => {
            let pts: Vec<_> = l.trail.points.iter().map(|p| v.to_screen(*p)).collect();
            let mut f = accent();
            f.a = 0.05;
            o.prims.push(Prim::Poly {
                pts,
                closed: false,
                stroke: Some((accent(), 1., Some((7., 7.)))),
                fill: Some(f),
            });
        }
        // `EraserTrail`: 5px, black 20% (dark: white 20%)
        Some(Gesture::Eraser(e)) => {
            let pts: Vec<_> = e
                .points()
                .iter()
                .rev()
                .take(24)
                .rev()
                .map(|p| v.to_screen(*p))
                .collect();
            let c = if crate::theme::dark() {
                gpui::hsla(0., 0., 1., 0.2)
            } else {
                gpui::hsla(0., 0., 0., 0.2)
            };
            o.line(pts, false, c, 5., None);
        }
        _ => {}
    }
    o
}
