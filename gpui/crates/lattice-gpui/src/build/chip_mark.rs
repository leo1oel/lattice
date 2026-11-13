//! The Build chip's mark and the moment a build ends, as the Tauri app draws
//! them (`BuildStatusGlyph` and `InfinityLoader` in
//! `src/trellis/trellis-header-tools.tsx` and `activity-icons.tsx`, their
//! keyframes in `trellis.css`).
//!
//! On the 24-unit grid of the icons beside it, 13px square, stroked 2.5
//! units wide with round caps and joins:
//!
//! - a running build: the infinity loader, its 10-unit stroke on a 100-unit
//!   grid scaled to 80% about the centre, four fifths of the path drawn and
//!   one fifth open, the dash running round once every 2 s, in the ink at
//!   72% (black in light, white in dark, as the image is inverted there);
//! - a success: the check `M20 6 9 17l-5-5` in the success ink, with a
//!   warning dot (r 3.5 at 20.5, 18) when the build left warnings;
//! - a failure: the cross `M18 6 6 18` and `m6 6 12 12` in the danger ink.
//!
//! The first time an outcome shows (within 900 ms of the build ending, as
//! `isFreshOutcome` allows a remount), it arrives: its strokes draw on the
//! moderate tier (the cross's second 70 ms after the first), a clean success
//! throws six rays in the mark's two threads from 120 ms (from 55% to 120%
//! of their place on the flourish, their opacity up in its first quarter and
//! out over the rest), a warning's dot settles in from 20% at four fifths of
//! the moderate tier, a failure shakes from 140 ms on the slow tier, and the
//! chip washes once in the outcome's colour from 22% (not for warnings).
//! Each CSS keyframe interval takes the tier's curve, so the parts are eased
//! interval by interval here too.

use std::time::Duration;

use gpui::{
    AnimationExt as _, AnyElement, Bounds, Hsla, IntoElement, ParentElement as _, Pixels, Point,
    Styled as _, Window, canvas, div, point, px,
};
use lattice_ui::{
    Appearance, Motion, Palette,
    stroke::{self, Line},
    tokens::DURATION_MODERATE,
};

/// The mark's box.
pub const MARK: Pixels = px(13.);
/// How long after a build ends its outcome still arrives when first shown.
pub const FRESH_WINDOW: Duration = Duration::from_millis(900);
/// The whole moment: the rays' delay and the flourish.
pub const MOMENT: Duration = Duration::from_millis(120 + 720);

const GRID: f32 = 24.;
const STROKE: f32 = 2.5;

/// What the chip's mark shows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mark {
    Running,
    Succeeded { warned: bool },
    Failed,
}

fn check() -> Line {
    Line::new([point(20., 6.), point(9., 17.), point(4., 12.)])
}

fn cross() -> [Line; 2] {
    [
        Line::new([point(18., 6.), point(6., 18.)]),
        Line::new([point(6., 6.), point(18., 18.)]),
    ]
}

/// The six rays, alternating the weft's thread and the warp's, from 14 to
/// 18 units out from the centre, the first straight up.
fn rays() -> [(Line, bool); 6] {
    std::array::from_fn(|index| {
        let angle = (index as f32 * 60. - 90.).to_radians();
        let at = |radius: f32| point(12. + angle.cos() * radius, 12. + angle.sin() * radius);
        (Line::new([at(14.), at(18.)]), index % 2 == 0)
    })
}

/// The infinity loader's path on its 100-unit grid, scaled to 80% about
/// its centre as the SVG's `transform` does.
fn infinity() -> Line {
    let p = |x: f32, y: f32| point(50. + (x - 50.) * 0.8, 50. + (y - 50.) * 0.8);
    Line::new([p(24.3, 30.)])
        .cubic_to(p(11.4, 30.), p(5., 43.3), p(5., 50.), 12)
        .cubic_to(p(5., 56.7), p(11.4, 70.), p(24.3, 70.), 12)
        .cubic_to(p(43.6, 70.), p(56.4, 30.), p(75.7, 30.), 24)
        .cubic_to(p(88.6, 30.), p(95., 43.3), p(95., 50.), 12)
        .cubic_to(p(95., 56.7), p(88.6, 70.), p(75.7, 70.), 12)
        .cubic_to(p(56.4, 70.), p(43.6, 30.), p(24.3, 30.), 24)
}

/// A keyframed property: `(offset, value)` stops from 0 to 1, each interval
/// eased on `motion`'s curve, as a CSS animation eases between keyframes.
fn keyframes(stops: &[(f32, f32)], motion: Motion, t: f32) -> f32 {
    let t = t.clamp(0., 1.);
    for pair in stops.windows(2) {
        let ((a, va), (b, vb)) = (pair[0], pair[1]);
        if t <= b {
            let local = if b > a { (t - a) / (b - a) } else { 1. };
            return va + (vb - va) * motion.sample(local);
        }
    }
    stops.last().map_or(0., |(_, v)| *v)
}

/// `t` through an animation of `duration` that starts `delay` into the
/// moment, `elapsed` in; before its delay it holds its first keyframe
/// (`animation-fill-mode: both`).
fn progress(elapsed: Duration, delay: Duration, duration: Duration) -> f32 {
    (elapsed.saturating_sub(delay).as_secs_f32() / duration.as_secs_f32()).clamp(0., 1.)
}

/// One frame of the moment, `elapsed` after the outcome first showed (`None`
/// once it has, or for an outcome shown later).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    /// How much of each stroke is drawn (the cross's two; a check uses the first).
    pub strokes: [f32; 2],
    /// The warning dot's opacity and scale.
    pub pip: (f32, f32),
    /// The rays' opacity and scale about the centre; `None`: no rays.
    pub rays: Option<(f32, f32)>,
    /// The mark's sideways shake, in pixels.
    pub shake: f32,
    /// The chip's wash in the outcome's colour.
    pub wash: f32,
}

impl Frame {
    pub const AT_REST: Frame = Frame {
        strokes: [1., 1.],
        pip: (1., 1.),
        rays: None,
        shake: 0.,
        wash: 0.,
    };

    pub fn at(mark: Mark, elapsed: Option<Duration>) -> Frame {
        let Some(elapsed) = elapsed else {
            return Frame::AT_REST;
        };
        let moderate = DURATION_MODERATE;
        let flourish = Motion::Flourish.duration();
        let draw = |delay: u64| {
            keyframes(
                &[(0., 0.), (1., 1.)],
                Motion::Moderate,
                progress(elapsed, Duration::from_millis(delay), moderate),
            )
        };
        let wash_at = keyframes(
            &[(0., 0.22), (1., 0.)],
            Motion::Flourish,
            progress(elapsed, Duration::ZERO, flourish),
        );
        match mark {
            Mark::Running => Frame::AT_REST,
            Mark::Succeeded { warned } => {
                let pip_t = progress(elapsed, moderate.mul_f32(0.8), moderate);
                let rays_t = progress(elapsed, Duration::from_millis(120), flourish);
                Frame {
                    strokes: [draw(0), 1.],
                    pip: (
                        keyframes(&[(0., 0.), (1., 1.)], Motion::Moderate, pip_t),
                        keyframes(&[(0., 0.2), (1., 1.)], Motion::Moderate, pip_t),
                    ),
                    rays: (!warned).then(|| {
                        (
                            keyframes(&[(0., 0.), (0.25, 1.), (1., 0.)], Motion::Flourish, rays_t),
                            keyframes(&[(0., 0.55), (1., 1.2)], Motion::Flourish, rays_t),
                        )
                    }),
                    shake: 0.,
                    wash: if warned { 0. } else { wash_at },
                }
            }
            Mark::Failed => Frame {
                strokes: [draw(0), draw(70)],
                pip: (1., 1.),
                rays: None,
                shake: keyframes(
                    &[
                        (0., 0.),
                        (0.2, -1.5),
                        (0.45, 1.5),
                        (0.7, -1.),
                        (0.85, 0.5),
                        (1., 0.),
                    ],
                    Motion::Slow,
                    progress(elapsed, Duration::from_millis(140), Motion::Slow.duration()),
                ),
                wash: wash_at,
            },
        }
    }
}

/// The parts of a running build's loader drawn `t` (0..1) into its 2 s turn:
/// the dash pattern's offset runs once round the path, so the drawn four
/// fifths travel backwards along it.
fn loader_parts(line: &Line, t: f32) -> Vec<Vec<Point<f32>>> {
    let length = line.length();
    let offset = length * t;
    let (start, end) = (-offset, length * 0.8 - offset);
    // The window [start, end) wraps once round the closed path.
    let mut parts = Vec::new();
    for shift in [0., length] {
        let part = line.window(start + shift, end + shift);
        if part.len() >= 2 {
            parts.push(part);
        }
    }
    parts
}

fn ink_for(mark: Mark, palette: &Palette) -> Hsla {
    match mark {
        Mark::Running => match palette.appearance {
            Appearance::Light => gpui::hsla(0., 0., 0., 0.72),
            Appearance::Dark => gpui::hsla(0., 0., 1., 0.72),
        },
        Mark::Succeeded { .. } => palette.success,
        Mark::Failed => palette.danger,
    }
}

fn paint_frame(
    mark: Mark,
    frame: Frame,
    bounds: Bounds<Pixels>,
    palette: &Palette,
    window: &mut Window,
) {
    let ink = ink_for(mark, palette);
    match mark {
        Mark::Running => {}
        Mark::Succeeded { warned } => {
            stroke::paint(
                &check().drawn(frame.strokes[0]),
                GRID,
                bounds,
                STROKE,
                ink,
                window,
            );
            if warned {
                let (opacity, scale) = frame.pip;
                let center = stroke::to_bounds(point(20.5, 18.), GRID, bounds);
                let radius = px(3.5 * f32::from(bounds.size.width) / GRID * scale);
                window.paint_quad(
                    gpui::fill(
                        Bounds::new(
                            point(center.x - radius, center.y - radius),
                            gpui::size(radius * 2., radius * 2.),
                        ),
                        palette.warning.opacity(opacity),
                    )
                    .corner_radii(radius),
                );
            }
            if let Some((opacity, scale)) = frame.rays {
                // Scaled about the grid's centre: grow the bounds about theirs.
                let grown = Bounds::from_corners(
                    stroke::to_bounds(point(12. - 12. * scale, 12. - 12. * scale), GRID, bounds),
                    stroke::to_bounds(point(12. + 12. * scale, 12. + 12. * scale), GRID, bounds),
                );
                for (ray, weft) in rays() {
                    let color = if weft {
                        palette.brand_weft
                    } else {
                        palette.brand_warp
                    };
                    stroke::paint(
                        &ray.drawn(1.),
                        GRID,
                        grown,
                        2.,
                        color.opacity(opacity),
                        window,
                    );
                }
            }
        }
        Mark::Failed => {
            for (line, drawn) in cross().iter().zip(frame.strokes) {
                stroke::paint(&line.drawn(drawn), GRID, bounds, STROKE, ink, window);
            }
        }
    }
}

/// The mark, arriving when `fresh` holds the moment's key and its age.
pub fn mark(mark: Mark, fresh: Option<(usize, Duration)>, palette: &Palette) -> AnyElement {
    let palette = palette.clone();
    let slot = div().relative().flex_none().size(MARK);
    if mark == Mark::Running {
        let ink = ink_for(mark, &palette);
        let line = infinity();
        return slot
            .with_animation(
                "build-chip-loader",
                gpui::Animation::new(Duration::from_secs(2)).repeat(),
                move |slot, t| {
                    let line = line.clone();
                    slot.child(
                        canvas(
                            |_, _, _| (),
                            move |bounds, _, window, _| {
                                for part in loader_parts(&line, t) {
                                    stroke::paint(&part, 100., bounds, 10., ink, window);
                                }
                            },
                        )
                        .size_full(),
                    )
                },
            )
            .into_any_element();
    }
    let draw = move |slot: gpui::Div, frame: Frame| {
        let palette = palette.clone();
        slot.child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    let bounds = Bounds::new(
                        point(bounds.origin.x + px(frame.shake), bounds.origin.y),
                        bounds.size,
                    );
                    paint_frame(mark, frame, bounds, &palette, window);
                },
            )
            .size_full(),
        )
    };
    match fresh {
        Some((key, age)) if age < MOMENT => slot
            .with_animation(
                ("build-chip-moment", key),
                gpui::Animation::new(MOMENT),
                move |slot, _| draw(slot, Frame::at(mark, Some(age))),
            )
            .into_any_element(),
        _ => draw(slot, Frame::AT_REST).into_any_element(),
    }
}

/// The chip's wash in the outcome's colour, over the chip.
pub fn wash(mark: Mark, fresh: Option<(usize, Duration)>, palette: &Palette) -> Option<AnyElement> {
    let color = match mark {
        Mark::Succeeded { warned: false } => palette.success,
        Mark::Failed => palette.danger,
        _ => return None,
    };
    let (key, age) = fresh.filter(|(_, age)| *age < Motion::Flourish.duration())?;
    Some(
        div()
            .absolute()
            .inset_0()
            .rounded(px(6.))
            .with_animation(
                ("build-chip-wash", key),
                gpui::Animation::new(Motion::Flourish.duration()),
                move |wash, _| wash.bg(color.opacity(Frame::at(mark, Some(age)).wash)),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(ms: u64) -> Option<Duration> {
        Some(Duration::from_millis(ms))
    }

    #[test]
    fn a_fresh_check_draws_on_the_moderate_tier_and_washes_once() {
        let start = Frame::at(Mark::Succeeded { warned: false }, ms(0));
        assert_eq!(start.strokes[0], 0.);
        assert!((start.wash - 0.22).abs() < 1e-4);
        let drawn = Frame::at(Mark::Succeeded { warned: false }, ms(160));
        assert!((drawn.strokes[0] - 1.).abs() < 1e-3);
        let end = Frame::at(Mark::Succeeded { warned: false }, ms(840));
        assert!(end.wash.abs() < 1e-3);
        assert!(end.rays.unwrap().0.abs() < 1e-3, "the rays are gone");
    }

    #[test]
    fn the_rays_wait_120ms_then_peak_a_quarter_into_the_flourish() {
        let before = Frame::at(Mark::Succeeded { warned: false }, ms(100))
            .rays
            .unwrap();
        assert_eq!(before, (0., 0.55));
        let peak = Frame::at(Mark::Succeeded { warned: false }, ms(120 + 180))
            .rays
            .unwrap();
        assert!((peak.0 - 1.).abs() < 1e-3);
        assert!(peak.1 > 0.55 && peak.1 < 1.2);
    }

    #[test]
    fn a_warned_check_settles_its_dot_without_rays_or_wash() {
        let frame = Frame::at(Mark::Succeeded { warned: true }, ms(100));
        assert_eq!(frame.rays, None);
        assert_eq!(frame.wash, 0.);
        assert_eq!(
            frame.pip,
            (0., 0.2),
            "the dot waits for four fifths of the tier"
        );
        let landed = Frame::at(Mark::Succeeded { warned: true }, ms(128 + 160));
        assert!((landed.pip.0 - 1.).abs() < 1e-3 && (landed.pip.1 - 1.).abs() < 1e-3);
    }

    #[test]
    fn a_failure_draws_its_second_stroke_late_and_shakes() {
        let frame = Frame::at(Mark::Failed, ms(60));
        assert!(frame.strokes[0] > 0.);
        assert_eq!(frame.strokes[1], 0.);
        assert_eq!(Frame::at(Mark::Failed, ms(139)).shake, 0.);
        // A fifth into the shake it is at its first keyframe, 1.5px left.
        let first = Frame::at(Mark::Failed, ms(140 + 48)).shake;
        assert!((first + 1.5).abs() < 0.05, "{first}");
        assert!(Frame::at(Mark::Failed, ms(140 + 240)).shake.abs() < 1e-3);
    }

    #[test]
    fn an_outcome_shown_later_is_at_rest() {
        assert_eq!(Frame::at(Mark::Failed, None), Frame::AT_REST);
    }

    #[test]
    fn the_loader_draws_four_fifths_of_its_path() {
        let line = infinity();
        for t in [0., 0.3, 0.9] {
            let drawn: f32 = loader_parts(&line, t)
                .iter()
                .map(|part| Line::new(part.iter().copied()).length())
                .sum();
            assert!((drawn / line.length() - 0.8).abs() < 0.01, "t {t}: {drawn}");
        }
    }
}
