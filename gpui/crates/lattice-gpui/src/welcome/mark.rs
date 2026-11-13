//! The Lattice mark with its weave (`src/components/ui/lattice-mark.tsx`
//! and `lattice-mark.css`): the app icon's woven lattice on its 1024 grid,
//! turned 45°: three weft threads across, the warp threads broken wherever
//! they pass under a weft, and the six nodes that pin the warp.
//!
//! The weave draws the weft across, then the warp thread by thread (each
//! 55 ms after the last, from 120 ms, on the draw tier), and the nodes land
//! last (from 640 ms, 30 ms apart, on the moderate tier). Every 7.2 s a
//! short glint runs along each weft thread in turn, under the warp. The far
//! end of each thread is lifted toward the glint, as the icon's gradients
//! are. With motion reduced the finished mark simply appears.

use std::time::Instant;

use gpui::{
    Bounds, Context, Corners, Hsla, IntoElement, PathBuilder, Pixels, Point, Render, Rgba,
    Styled as _, Window, canvas, fill, linear_color_stop, linear_gradient, point, px,
};
use lattice_ui::{ActiveLattice as _, Appearance, Motion, interaction::mix};

const WEFT: [f32; 3] = [336., 512., 688.];
/// Warp segments as (x, from y, to y), in the icon's draw order.
const WARP: [(f32, f32, f32); 7] = [
    (336., 250., 478.),
    (336., 546., 774.),
    (512., 250., 302.),
    (512., 370., 654.),
    (512., 722., 774.),
    (688., 250., 478.),
    (688., 546., 774.),
];
const NODES: [(f32, f32); 6] = [
    (336., 250.),
    (512., 250.),
    (688., 250.),
    (336., 774.),
    (512., 774.),
    (688., 774.),
];
const THREAD: f32 = 68.;
const GLINT: f32 = 30.;
const GLINT_CYCLE: f32 = 7.2;

pub struct LatticeMark {
    size: f32,
    started: Instant,
}

impl LatticeMark {
    pub fn new(size: f32, _: &mut Context<Self>) -> Self {
        Self {
            size,
            started: Instant::now(),
        }
    }
}

/// The icon's point (x, y) turned 45° about its centre, in the element.
fn place(origin: Point<Pixels>, scale: f32, x: f32, y: f32) -> Point<Pixels> {
    let (c, s) = (
        std::f32::consts::FRAC_1_SQRT_2,
        std::f32::consts::FRAC_1_SQRT_2,
    );
    let (dx, dy) = (x - 512., y - 512.);
    let (rx, ry) = (512. + dx * c - dy * s, 512. + dx * s + dy * c);
    origin + point(px((rx - 160.) * scale), px((ry - 160.) * scale))
}

fn alpha(color: Hsla, a: f32) -> Hsla {
    Hsla {
        a: color.a * a.clamp(0., 1.),
        ..color
    }
}

/// The glint's colour (`--brand-glint`): white, a little weaker in dark.
fn glint(appearance: Appearance) -> Hsla {
    Rgba {
        r: 1.,
        g: 1.,
        b: 1.,
        a: if appearance == Appearance::Dark {
            0.7
        } else {
            0.85
        },
    }
    .into()
}

/// A thread from `a` to `b`, drawn to `progress` of its length.
#[allow(clippy::too_many_arguments)]
fn thread(
    window: &mut Window,
    origin: Point<Pixels>,
    scale: f32,
    a: (f32, f32),
    b: (f32, f32),
    progress: f32,
    width: f32,
    colors: (Hsla, Hsla),
    angle: f32,
    round: bool,
) {
    if progress <= 0. {
        return;
    }
    let end = (a.0 + (b.0 - a.0) * progress, a.1 + (b.1 - a.1) * progress);
    let (from, to) = (
        place(origin, scale, a.0, a.1),
        place(origin, scale, end.0, end.1),
    );
    let mut path = PathBuilder::stroke(px(width * scale));
    path.move_to(from);
    path.line_to(to);
    let tip = mix(colors.0, colors.1, progress);
    if let Ok(path) = path.build() {
        window.paint_path(
            path,
            linear_gradient(
                angle,
                linear_color_stop(colors.0, 0.),
                linear_color_stop(tip, 1.),
            ),
        );
    }
    if round {
        let r = px(width * scale / 2.);
        for (at, color) in [(from, colors.0), (to, tip)] {
            window.paint_quad(
                fill(
                    Bounds::new(at - point(r, r), gpui::size(r * 2., r * 2.)),
                    color,
                )
                .corner_radii(Corners::all(r)),
            );
        }
    }
}

impl Render for LatticeMark {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let elapsed = self.started.elapsed().as_secs_f32();
        let reduced = cx.reduce_motion();
        let size = self.size;
        canvas(
            |_, _, _| {},
            move |bounds, _, window, cx| {
                let palette = cx.palette().clone();
                let scale = size / 704.;
                let origin = bounds.origin;
                let shine = glint(palette.appearance);
                let weft = (palette.brand_weft, mix(palette.brand_weft, shine, 0.28));
                let warp = (mix(palette.brand_warp, shine, 0.26), palette.brand_warp);
                let draw = Motion::Draw;
                let thread_progress = |order: usize| -> (f32, f32) {
                    if reduced {
                        return (1., 1.);
                    }
                    let start = 0.12 + order as f32 * 0.055;
                    let t = (elapsed - start) / draw.duration().as_secs_f32();
                    if t <= 0. {
                        return (0., 0.);
                    }
                    (draw.sample(t.min(1.)).min(1.), (t / 0.12).min(1.))
                };
                let mut animating = false;
                // The weft, across (round ends), along +x before the turn:
                // after it, toward the lower right.
                for (ix, y) in WEFT.iter().enumerate() {
                    let (progress, fade) = thread_progress(ix);
                    animating |= progress < 1.;
                    thread(
                        window,
                        origin,
                        scale,
                        (250., *y),
                        (774., *y),
                        progress,
                        THREAD,
                        (alpha(weft.0, fade), alpha(weft.1, fade)),
                        135.,
                        true,
                    );
                }
                // The glints run each weft thread in turn, under the warp.
                if !reduced {
                    animating = true;
                    for (ix, y) in WEFT.iter().enumerate() {
                        let delay = 1.6 + ix as f32 * 0.18;
                        if elapsed < delay {
                            continue;
                        }
                        let t = ((elapsed - delay) % GLINT_CYCLE) / GLINT_CYCLE;
                        if t > 0.18 {
                            continue;
                        }
                        let eased = {
                            let u = t / 0.18;
                            u * u * (3. - 2. * u)
                        };
                        let head = -0.1 + 1.1 * eased;
                        let (a, b) = (head.max(0.), (head + 0.1).min(1.));
                        let opacity = if t < 0.02 {
                            t / 0.02
                        } else if t > 0.16 {
                            (0.18 - t) / 0.02
                        } else {
                            1.
                        };
                        if b > a {
                            let x0 = 250. + 524. * a;
                            let x1 = 250. + 524. * b;
                            let color = alpha(shine, opacity);
                            thread(
                                window,
                                origin,
                                scale,
                                (x0, *y),
                                (x1, *y),
                                1.,
                                GLINT,
                                (color, color),
                                135.,
                                true,
                            );
                        }
                    }
                }
                // The warp, thread by thread (square ends), along +y before
                // the turn: after it, toward the lower left.
                for (ix, (x, from, to)) in WARP.iter().enumerate() {
                    let (progress, fade) = thread_progress(WEFT.len() + ix);
                    animating |= progress < 1.;
                    thread(
                        window,
                        origin,
                        scale,
                        (*x, *from),
                        (*x, *to),
                        progress,
                        THREAD,
                        (alpha(warp.0, fade), alpha(warp.1, fade)),
                        225.,
                        false,
                    );
                }
                // The nodes pin the warp, last.
                for (ix, (x, y)) in NODES.iter().enumerate() {
                    let pin = if reduced {
                        1.
                    } else {
                        let start = 0.64 + ix as f32 * 0.03;
                        let t = (elapsed - start) / Motion::Moderate.duration().as_secs_f32();
                        if t <= 0. {
                            0.
                        } else {
                            Motion::Moderate.sample(t.min(1.))
                        }
                    };
                    animating |= pin < 1.;
                    if pin <= 0. {
                        continue;
                    }
                    let at = place(origin, scale, *x, *y);
                    let r = px(34. * scale * pin.max(0.));
                    let color = alpha(mix(warp.0, warp.1, (*y - 224.) / 576.), pin.min(1.));
                    window.paint_quad(
                        fill(
                            Bounds::new(at - point(r, r), gpui::size(r * 2., r * 2.)),
                            color,
                        )
                        .corner_radii(Corners::all(r)),
                    );
                }
                if animating {
                    window.request_animation_frame();
                }
            },
        )
        .size(px(size))
    }
}
