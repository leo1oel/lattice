//! Line art that draws itself: a stroked path shown a length at a time, as
//! the app's SVG marks animate `stroke-dashoffset` over a `pathLength` of 1.
//!
//! A [`Line`] is a path flattened to points on its own grid (the 24-unit
//! icon grid, or an SVG's viewBox), with the length run to each point, so a
//! window of it by length ([`Line::window`]) is the part a dash would show.
//! [`paint`] strokes points with round caps and joins, as the app's marks set
//! `stroke-linecap` and `stroke-linejoin`, mapped from the grid into bounds.

use gpui::{
    Bounds, Hsla, Path, PathBuilder, PathStyle, PathVertex, Pixels, Point, StrokeOptions, Window,
    point, px,
};
use lyon::tessellation::{
    BuffersBuilder, LineCap, LineJoin, StrokeTessellator, StrokeVertex, VertexBuffers,
};

/// A path on its own grid, flattened, with the length run to each point.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Line {
    points: Vec<Point<f32>>,
    run: Vec<f32>,
}

impl Line {
    /// The straight segments through `points`.
    pub fn new(points: impl IntoIterator<Item = Point<f32>>) -> Self {
        let mut line = Self::default();
        for p in points {
            line.push(p);
        }
        line
    }

    fn push(&mut self, p: Point<f32>) {
        let run = match (self.points.last(), self.run.last()) {
            (Some(last), Some(run)) => run + distance(*last, p),
            _ => 0.,
        };
        self.points.push(p);
        self.run.push(run);
    }

    /// Continue with a cubic Bézier from the last point, flattened into
    /// `steps` segments (enough that a 2px stroke reads as a curve).
    pub fn cubic_to(
        mut self,
        c1: Point<f32>,
        c2: Point<f32>,
        to: Point<f32>,
        steps: usize,
    ) -> Self {
        let Some(&from) = self.points.last() else {
            self.push(to);
            return self;
        };
        for step in 1..=steps {
            let t = step as f32 / steps as f32;
            let u = 1. - t;
            let (a, b, c, d) = (u * u * u, 3. * u * u * t, 3. * u * t * t, t * t * t);
            self.push(point(
                a * from.x + b * c1.x + c * c2.x + d * to.x,
                a * from.y + b * c1.y + c * c2.y + d * to.y,
            ));
        }
        self
    }

    /// Continue with a straight segment.
    pub fn line_to(mut self, to: Point<f32>) -> Self {
        self.push(to);
        self
    }

    pub fn length(&self) -> f32 {
        self.run.last().copied().unwrap_or(0.)
    }

    /// The points between lengths `from` and `to` along the line, clamped to
    /// it, the ends cut where they fall inside a segment. Empty when the
    /// window holds no length.
    pub fn window(&self, from: f32, to: f32) -> Vec<Point<f32>> {
        let (from, to) = (from.max(0.), to.min(self.length()));
        if to <= from || self.points.len() < 2 {
            return Vec::new();
        }
        let at = |length: f32| {
            let ix = self
                .run
                .partition_point(|run| *run < length)
                .clamp(1, self.points.len() - 1);
            let (a, b) = (self.points[ix - 1], self.points[ix]);
            let span = self.run[ix] - self.run[ix - 1];
            let t = if span > 0. {
                (length - self.run[ix - 1]) / span
            } else {
                0.
            };
            point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
        };
        let mut out = vec![at(from)];
        out.extend(
            self.points
                .iter()
                .zip(&self.run)
                .filter(|(_, run)| **run > from && **run < to)
                .map(|(p, _)| *p),
        );
        out.push(at(to));
        out
    }

    /// The part a dash drawn to `progress` (0..=1 of the length) shows, as
    /// `stroke-dashoffset` from 1 to 0 over a `pathLength` of 1 draws it.
    pub fn drawn(&self, progress: f32) -> Vec<Point<f32>> {
        self.window(0., self.length() * progress.clamp(0., 1.))
    }
}

fn distance(a: Point<f32>, b: Point<f32>) -> f32 {
    ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt()
}

/// Map a grid of `grid` units square onto `bounds`, as an SVG's viewBox
/// meets its box (`xMidYMid meet`).
pub fn to_bounds(p: Point<f32>, grid: f32, bounds: Bounds<Pixels>) -> Point<Pixels> {
    let side = f32::from(bounds.size.width.min(bounds.size.height));
    let scale = side / grid;
    let (dx, dy) = (
        (f32::from(bounds.size.width) - side) / 2.,
        (f32::from(bounds.size.height) - side) / 2.,
    );
    point(
        bounds.origin.x + px(dx + p.x * scale),
        bounds.origin.y + px(dy + p.y * scale),
    )
}

/// Stroke `points` (on a `grid`-unit grid mapped onto `bounds`) `width`
/// grid units wide, with round caps and joins.
pub fn paint(
    points: &[Point<f32>],
    grid: f32,
    bounds: Bounds<Pixels>,
    width: f32,
    color: Hsla,
    window: &mut Window,
) {
    if points.len() < 2 || color.a <= 0. {
        return;
    }
    let scale = f32::from(bounds.size.width.min(bounds.size.height)) / grid;
    let mut path = PathBuilder::stroke(px(width * scale))
        .with_style(PathStyle::Stroke(options(width * scale)));
    path.move_to(to_bounds(points[0], grid, bounds));
    for p in &points[1..] {
        path.line_to(to_bounds(*p, grid, bounds));
    }
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

/// [`paint`] for a line that is a different shape on every frame, as a
/// looping loader's is.
///
/// [`PathBuilder::build`] keeps every path it tessellates for the next of
/// the same shape (gpui-fast's `fast/path_cache.rs`). A loader's shape never
/// comes round again, so each frame's would be kept for nothing until the
/// kept shapes reach their 16 MB cap, pushing out shapes that are drawn
/// again. This tessellates the line as that cache does, at its first point and
/// then moved there, so the triangles are exactly the ones [`paint`] draws,
/// and keeps none of them.
pub fn paint_moving(
    points: &[Point<f32>],
    grid: f32,
    bounds: Bounds<Pixels>,
    width: f32,
    color: Hsla,
    window: &mut Window,
) {
    if color.a <= 0. {
        return;
    }
    if let Some(path) = moving_path(points, grid, bounds, width) {
        window.paint_path(path, color);
    }
}

fn moving_path(
    points: &[Point<f32>],
    grid: f32,
    bounds: Bounds<Pixels>,
    width: f32,
) -> Option<Path<Pixels>> {
    if points.len() < 2 {
        return None;
    }
    let scale = f32::from(bounds.size.width.min(bounds.size.height)) / grid;
    let origin = to_bounds(points[0], grid, bounds);
    let relative = |p: Point<f32>| {
        let p = to_bounds(p, grid, bounds);
        lyon::math::point(
            f32::from(p.x) - f32::from(origin.x),
            f32::from(p.y) - f32::from(origin.y),
        )
    };
    let mut line = lyon::path::Path::builder().with_svg();
    line.move_to(relative(points[0]));
    for p in &points[1..] {
        line.line_to(relative(*p));
    }
    let mut buffers: VertexBuffers<lyon::math::Point, u16> = VertexBuffers::new();
    StrokeTessellator::new()
        .tessellate_path(
            &line.build(),
            &options(width * scale),
            &mut BuffersBuilder::new(&mut buffers, |vertex: StrokeVertex| vertex.position()),
        )
        .ok()?;
    let at_origin = PathBuilder::build_path(buffers);
    let first = at_origin.vertices.first()?;
    let mut path = Path::new(first.xy_position + origin);
    path.vertices = at_origin
        .vertices
        .iter()
        .map(|vertex| PathVertex {
            xy_position: vertex.xy_position + origin,
            ..vertex.clone()
        })
        .collect();
    path.bounds = Bounds {
        origin: at_origin.bounds.origin + origin,
        size: at_origin.bounds.size,
    };
    Some(path)
}

fn options(width: f32) -> StrokeOptions {
    StrokeOptions::default()
        .with_line_width(width)
        .with_line_cap(LineCap::Round)
        .with_line_join(LineJoin::Round)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check() -> Line {
        Line::new([point(20., 6.), point(9., 17.), point(4., 12.)])
    }

    #[test]
    fn a_moving_line_has_the_triangles_a_kept_one_has() {
        let line = Line::new([point(0., 0.)]).cubic_to(
            point(30., 90.),
            point(70., 10.),
            point(97.3, 55.1),
            24,
        );
        let bounds = Bounds::new(point(px(311.37), px(18.6)), gpui::size(px(14.), px(14.)));
        for t in [0., 0.37, 0.81] {
            let points = line.window(line.length() * t, line.length() * (t + 0.6));
            let scale = 14. / 100.;
            let mut kept = PathBuilder::stroke(px(10. * scale))
                .with_style(PathStyle::Stroke(options(10. * scale)));
            kept.move_to(to_bounds(points[0], 100., bounds));
            for p in &points[1..] {
                kept.line_to(to_bounds(*p, 100., bounds));
            }
            let kept = kept.build().unwrap();
            let moving = moving_path(&points, 100., bounds, 10.).unwrap();
            assert_eq!(moving.bounds, kept.bounds);
            assert_eq!(moving.vertices.len(), kept.vertices.len());
            for (a, b) in moving.vertices.iter().zip(&kept.vertices) {
                assert_eq!(a.xy_position, b.xy_position);
                assert_eq!(a.st_position, b.st_position);
            }
        }
    }

    #[test]
    fn a_line_measures_its_segments() {
        let line = check();
        let expected = (2f32 * 121.).sqrt() + (2f32 * 25.).sqrt();
        assert!((line.length() - expected).abs() < 1e-4);
    }

    #[test]
    fn drawing_reveals_the_line_from_its_start() {
        let line = check();
        assert!(line.drawn(0.).is_empty());
        assert_eq!(
            line.drawn(1.),
            vec![point(20., 6.), point(9., 17.), point(4., 12.)]
        );
        // Halfway is inside the first, longer stroke.
        let half = line.drawn(0.5);
        assert_eq!(half.len(), 2);
        assert_eq!(half[0], point(20., 6.));
        let travelled = distance(half[0], half[1]);
        assert!((travelled - line.length() / 2.).abs() < 1e-3);
    }

    #[test]
    fn a_window_cuts_both_ends_inside_their_segments() {
        let line = Line::new([point(0., 0.), point(10., 0.), point(10., 10.)]);
        assert_eq!(
            line.window(5., 15.),
            vec![point(5., 0.), point(10., 0.), point(10., 5.)]
        );
        assert!(line.window(12., 12.).is_empty());
        assert_eq!(line.window(-4., 3.), vec![point(0., 0.), point(3., 0.)]);
    }

    #[test]
    fn a_cubic_lands_on_its_end_point() {
        let line = Line::new([point(0., 0.)]).cubic_to(
            point(0., 10.),
            point(10., 10.),
            point(10., 0.),
            16,
        );
        assert_eq!(line.drawn(1.).last(), Some(&point(10., 0.)));
        // It bows 7.5 up from its 10-unit chord and runs about 20 along.
        assert!((line.length() - 20.).abs() < 0.5, "{}", line.length());
    }
}
