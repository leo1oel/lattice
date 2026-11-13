//! The welcome screen's backdrop, as the Tauri app draws it
//! (`src/project/welcome-lattice.tsx` and `welcome-lattice.css`): the
//! mark's lattice repeated as a faint field of threads and knots, hollowed
//! out behind the copy and gone at the window's edges. Now and then a pulse
//! runs along a few threads to a knot that blooms.
//!
//! The drawing is 1440 × 900 and slices to fill any window (it scales to
//! cover, centred), so the knots stay where the threads cross at every size;
//! strokes keep their pixel width at any scale. The app's luminance mask (a
//! radial gradient: hidden to 30% of the way out, shown from 55%, 55% at
//! 82%, gone at the edge) becomes each thread segment's, knot's and pulse's
//! own opacity, read at its place.
//!
//! Each route's pulse takes its turn in a shared 9.6 s cycle (1.4 s, then
//! 1.6 s apart), so only two or three move at once: the head travels in the
//! first 22% leaving a fading trail, its knot blooms and a ring spreads from
//! it, then the route rests. The field fades in over 1.2 s. With motion
//! reduced the field is still: no pulses.

use std::time::Instant;

use gpui::{
    App, Bounds, Context, Corners, Hsla, IntoElement, PathBuilder, Pixels, Point, Render,
    Styled as _, Window, canvas, fill, point, px,
};
use lattice_ui::ActiveLattice as _;

const WIDTH: f32 = 1440.;
const HEIGHT: f32 = 900.;
const STEP: f32 = 40.;
/// Opacity buckets the threads are drawn in, one path each.
const LEVELS: usize = 24;
const CYCLE: f32 = 9.6;
const ARRIVE: f32 = 1.2;

#[derive(Clone, Copy)]
enum Direction {
    Ne,
    Se,
    Sw,
    Nw,
}

use Direction::*;

/// Kept to the field's visible ring: clear of the hollow behind the copy
/// and of the window edges.
const ROUTES: [((i32, i32), &[Direction]); 6] = [
    ((-15, -5), &[Se, Se, Se, Ne, Ne, Se, Se]),
    ((12, -8), &[Sw, Sw, Se, Se, Se, Ne]),
    ((-13, 6), &[Ne, Ne, Se, Se, Se]),
    ((14, 5), &[Nw, Nw, Nw, Sw, Sw]),
    ((-8, -10), &[Se, Se, Ne, Ne, Se]),
    ((6, 10), &[Ne, Ne, Se, Se, Ne]),
];

/// Grid point (m, n), in the drawing's units.
fn grid(m: i32, n: i32) -> (f32, f32) {
    (WIDTH / 2. + STEP * m as f32, HEIGHT / 2. + STEP * n as f32)
}

/// A route's knots, start to end.
fn route_points(start: (i32, i32), steps: &[Direction]) -> Vec<(f32, f32)> {
    let (mut m, mut n) = start;
    let mut points = vec![grid(m, n)];
    for step in steps {
        let (dm, dn) = match step {
            Ne => (1, -1),
            Se => (1, 1),
            Sw => (-1, 1),
            Nw => (-1, -1),
        };
        m += dm;
        n += dn;
        points.push(grid(m, n));
    }
    points
}

/// The mask's opacity at a point of the drawing.
fn mask(x: f32, y: f32) -> f32 {
    let dx = (x - WIDTH / 2.) / (WIDTH / 2.);
    let dy = (y - HEIGHT / 2.) / (HEIGHT / 2.);
    let d = (dx * dx + dy * dy).sqrt();
    if d <= 0.3 {
        0.
    } else if d <= 0.55 {
        (d - 0.3) / 0.25
    } else if d <= 0.82 {
        1. - 0.45 * (d - 0.55) / 0.27
    } else if d <= 1. {
        0.55 * (1. - (d - 0.82) / 0.18)
    } else {
        0.
    }
}

/// A value keyed through `stops` (cycle fraction, value), linear between.
fn keyed(t: f32, stops: &[(f32, f32)]) -> f32 {
    let Some(first) = stops.first() else {
        return 0.;
    };
    if t <= first.0 {
        return first.1;
    }
    for pair in stops.windows(2) {
        let ((t0, v0), (t1, v1)) = (pair[0], pair[1]);
        if t <= t1 {
            return if t1 > t0 {
                v0 + (v1 - v0) * (t - t0) / (t1 - t0)
            } else {
                v1
            };
        }
    }
    stops.last().map_or(0., |last| last.1)
}

/// The field's view: its own entity, so the frames it asks for redraw only
/// it, not the welcome screen over it.
pub struct LatticeField {
    started: Instant,
}

impl LatticeField {
    pub fn new(_: &mut Context<Self>) -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

/// How a drawing point lands in the window: the drawing scaled to cover
/// `bounds`, centred.
#[derive(Clone, Copy)]
struct Slice {
    origin: Point<Pixels>,
    scale: f32,
    left: f32,
    top: f32,
}

impl Slice {
    fn new(bounds: Bounds<Pixels>) -> Self {
        let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        let scale = (w / WIDTH).max(h / HEIGHT);
        Self {
            origin: bounds.origin,
            scale,
            left: (w - WIDTH * scale) / 2.,
            top: (h - HEIGHT * scale) / 2.,
        }
    }

    fn at(&self, x: f32, y: f32) -> Point<Pixels> {
        self.origin
            + point(
                px(self.left + x * self.scale),
                px(self.top + y * self.scale),
            )
    }
}

fn with_alpha(color: Hsla, alpha: f32) -> Hsla {
    Hsla {
        a: color.a * alpha.clamp(0., 1.),
        ..color
    }
}

fn dot(window: &mut Window, at: Point<Pixels>, radius: f32, color: Hsla) {
    let r = px(radius);
    window.paint_quad(
        fill(
            Bounds::new(at - point(r, r), gpui::size(r * 2., r * 2.)),
            color,
        )
        .corner_radii(Corners::all(r)),
    );
}

/// The part of the polyline `points` from fraction `from` to `to` of its
/// length.
fn sub_path(points: &[(f32, f32)], from: f32, to: f32) -> Vec<(f32, f32)> {
    let lengths: Vec<f32> = points
        .windows(2)
        .map(|pair| ((pair[1].0 - pair[0].0).powi(2) + (pair[1].1 - pair[0].1).powi(2)).sqrt())
        .collect();
    let total: f32 = lengths.iter().sum();
    let (from, to) = (from.clamp(0., 1.) * total, to.clamp(0., 1.) * total);
    if to <= from {
        return Vec::new();
    }
    let lerp =
        |a: (f32, f32), b: (f32, f32), t: f32| (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
    let mut out = Vec::new();
    let mut walked = 0.;
    for (ix, length) in lengths.iter().enumerate() {
        let (start, end) = (walked, walked + length);
        if end >= from && start <= to && *length > 0. {
            let a = ((from - start) / length).clamp(0., 1.);
            let b = ((to - start) / length).clamp(0., 1.);
            if out.is_empty() {
                out.push(lerp(points[ix], points[ix + 1], a));
            }
            out.push(lerp(points[ix], points[ix + 1], b));
        }
        walked = end;
    }
    out
}

fn stroke(
    window: &mut Window,
    slice: Slice,
    points: &[(f32, f32)],
    width: f32,
    color: Hsla,
    round: bool,
) {
    if points.len() < 2 || color.a <= 0.001 {
        return;
    }
    let mut path = PathBuilder::stroke(px(width));
    path.move_to(slice.at(points[0].0, points[0].1));
    for &(x, y) in &points[1..] {
        path.line_to(slice.at(x, y));
    }
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
    if round {
        for &(x, y) in [points[0], points[points.len() - 1]].iter() {
            dot(window, slice.at(x, y), width / 2., color);
        }
    }
}

fn paint_field(bounds: Bounds<Pixels>, elapsed: f32, reduced: bool, window: &mut Window, cx: &App) {
    let palette = cx.palette();
    let slice = Slice::new(bounds);
    let arrive = if reduced {
        1.
    } else {
        // ease-out over 1.2 s.
        let t = (elapsed / ARRIVE).clamp(0., 1.);
        1. - (1. - t).powi(2)
    };
    // Threads: rising (x + y constant) and falling (x − y constant), cut
    // where the threads cross so each piece takes the mask at its middle.
    let mut buckets: Vec<PathBuilder> = (0..LEVELS).map(|_| PathBuilder::stroke(px(1.))).collect();
    let mut used = [false; LEVELS];
    for k in -16..=16 {
        let rise = WIDTH / 2. + HEIGHT / 2. + 2. * STEP * k as f32;
        let fall = WIDTH / 2. - HEIGHT / 2. + 2. * STEP * k as f32;
        for (start, dir) in [((rise + 100., -100.), -1f32), ((fall - 100., -100.), 1f32)] {
            let pieces = (1200. / STEP) as i32;
            for piece in 0..pieces {
                let a = (
                    start.0 + dir * STEP * piece as f32,
                    start.1 + STEP * piece as f32,
                );
                let b = (a.0 + dir * STEP, a.1 + STEP);
                let alpha = mask((a.0 + b.0) / 2., (a.1 + b.1) / 2.);
                if alpha <= 0.01 {
                    continue;
                }
                let level = ((alpha * LEVELS as f32).ceil() as usize).clamp(1, LEVELS) - 1;
                buckets[level].move_to(slice.at(a.0, a.1));
                buckets[level].line_to(slice.at(b.0, b.1));
                used[level] = true;
            }
        }
    }
    for (level, path) in buckets.into_iter().enumerate() {
        if !used[level] {
            continue;
        }
        if let Ok(path) = path.build() {
            let alpha = (level + 1) as f32 / LEVELS as f32;
            window.paint_path(path, with_alpha(palette.line, alpha * arrive));
        }
    }
    // Knots: where the threads cross.
    for m in -19..=19 {
        for n in -12..=12 {
            if (m + n) % 2 != 0 {
                continue;
            }
            let (x, y) = grid(m, n);
            let alpha = mask(x, y);
            if alpha > 0.01 {
                dot(
                    window,
                    slice.at(x, y),
                    1.5,
                    with_alpha(palette.line_strong, alpha * arrive),
                );
            }
        }
    }
    if reduced {
        return;
    }
    for (ix, (start, steps)) in ROUTES.iter().enumerate() {
        let delay = 1.4 + ix as f32 * 1.6;
        if elapsed < delay {
            continue;
        }
        let t = ((elapsed - delay) % CYCLE) / CYCLE;
        let thread = if ix % 2 == 1 {
            palette.brand_warp
        } else {
            palette.brand_weft
        };
        let points = route_points(*start, steps);
        let (end_x, end_y) = *points.last().unwrap_or(&(0., 0.));
        let shade = mask(end_x, end_y).max(mask(points[0].0, points[0].1));
        // The trail draws in behind the head, then fades.
        let trail = keyed(t, &[(0., 0.), (0.22, 1.), (1., 1.)]);
        let trail_alpha = keyed(t, &[(0., 0.45), (0.22, 0.45), (0.40, 0.), (1., 0.)]);
        stroke(
            window,
            slice,
            &sub_path(&points, 0., trail),
            1.5,
            with_alpha(thread, trail_alpha * shade),
            false,
        );
        // The head: a short dash running the route.
        let offset = keyed(t, &[(0., 0.07), (0.23, -1.), (1., -1.)]);
        let head_alpha = keyed(t, &[(0., 0.), (0.02, 1.), (0.21, 1.), (0.23, 0.), (1., 0.)]);
        stroke(
            window,
            slice,
            &sub_path(&points, -offset, -offset + 0.07),
            3.,
            with_alpha(thread, head_alpha * shade),
            true,
        );
        let end = slice.at(end_x, end_y);
        // The knot blooms…
        let bloom_scale = keyed(t, &[(0.21, 0.), (0.25, 1.5), (0.30, 1.), (1., 1.)]);
        let bloom_alpha = keyed(
            t,
            &[(0.21, 0.), (0.25, 1.), (0.30, 0.9), (0.44, 0.), (1., 0.)],
        );
        if bloom_alpha > 0. && bloom_scale > 0. {
            dot(
                window,
                end,
                3.5 * bloom_scale,
                with_alpha(thread, bloom_alpha * shade),
            );
        }
        // …and a ring spreads from it.
        let ring_scale = keyed(t, &[(0.22, 1.), (0.38, 4.5), (1., 4.5)]);
        let ring_alpha = keyed(t, &[(0.22, 0.), (0.24, 0.55), (0.38, 0.), (1., 0.)]);
        if ring_alpha > 0. {
            let r = px(4. * ring_scale);
            window.paint_quad(gpui::quad(
                Bounds::new(end - point(r, r), gpui::size(r * 2., r * 2.)),
                Corners::all(r),
                gpui::transparent_black(),
                px(1.5),
                with_alpha(thread, ring_alpha * shade),
                gpui::BorderStyle::Solid,
            ));
        }
    }
    window.request_animation_frame();
}

impl Render for LatticeField {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let elapsed = self.started.elapsed().as_secs_f32();
        let reduced = cx.reduce_motion();
        canvas(
            |_, _, _| {},
            move |bounds, _, window, cx| paint_field(bounds, elapsed, reduced, window, cx),
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mask_hollows_the_middle_and_fades_at_the_edges() {
        assert_eq!(mask(WIDTH / 2., HEIGHT / 2.), 0.);
        assert!((mask(WIDTH / 2. + 0.55 * WIDTH / 2., HEIGHT / 2.) - 1.).abs() < 1e-4);
        assert_eq!(mask(0., 0.), 0.);
    }

    #[test]
    fn a_route_ends_where_its_steps_lead() {
        let points = route_points((0, 0), &[Ne, Se]);
        assert_eq!(points.last(), Some(&grid(2, 0)));
    }

    #[test]
    fn a_sub_path_takes_its_share_of_the_length() {
        let line = [(0., 0.), (10., 0.), (10., 10.)];
        assert_eq!(
            sub_path(&line, 0.25, 0.75),
            vec![(5., 0.), (10., 0.), (10., 5.)]
        );
        assert!(sub_path(&line, 0.5, 0.5).is_empty());
    }
}
