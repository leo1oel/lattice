// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/motion.ts).

//! Spring and tween constants for the camera and layout motion.

use std::collections::HashMap;

use crate::model::Rect;

pub struct Spring {
    pub stiffness: f64,
    pub damping: f64,
    pub max_step: f64,
    pub epsilon: f64,
}

pub const SPRING: Spring = Spring {
    stiffness: 210.,
    damping: 29.,
    max_step: 0.032,
    epsilon: 0.0001,
};
/// A layout change's tween.
pub const LAYOUT_MS: f64 = 460.;
/// The lifted window easing to a compact card.
pub const PICKUP_MS: f64 = 280.;
/// A new panel's appearance: Trellis's 220ms, as Lattice's trellis.css
/// draws it on the slow tier (240ms).
pub const APPEAR_MS: f64 = 240.;

pub fn ease_out_quint(t: f64) -> f64 {
    1. - (1. - t.clamp(0., 1.)).powi(5)
}

pub fn lerp_rect(a: Rect, b: Rect, t: f64) -> Rect {
    Rect {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        w: a.w + (b.w - a.w) * t,
        h: a.h + (b.h - a.h) * t,
    }
}

pub fn same_rect(a: Rect, b: Rect, epsilon: f64) -> bool {
    (a.x - b.x).abs() < epsilon
        && (a.y - b.y).abs() < epsilon
        && (a.w - b.w).abs() < epsilon
        && (a.h - b.h).abs() < epsilon
}

/// A critically-damped-ish spring over a rect. Deterministic: `step(dt)`.
#[derive(Clone, Debug)]
pub struct RectSpring {
    pub value: Rect,
    pub target: Rect,
    pub velocity: Rect,
}

impl RectSpring {
    pub fn new(initial: Rect) -> RectSpring {
        RectSpring {
            value: initial,
            target: initial,
            velocity: Rect::ZERO,
        }
    }

    pub fn moving(&self) -> bool {
        !same_rect(self.value, self.target, 1e-9) || !same_rect(self.velocity, Rect::ZERO, 1e-9)
    }

    /// Returns true while still moving.
    pub fn step(&mut self, dt: f64) -> bool {
        let dt = if dt > 0. { dt } else { 0.016 }.min(SPRING.max_step);
        let mut error = 0.;
        let fields: [fn(&mut Rect) -> &mut f64; 4] =
            [|r| &mut r.x, |r| &mut r.y, |r| &mut r.w, |r| &mut r.h];
        for field in fields {
            let target = *field(&mut self.target);
            let value = *field(&mut self.value);
            let velocity = field(&mut self.velocity);
            *velocity += ((target - value) * SPRING.stiffness - *velocity * SPRING.damping) * dt;
            let velocity = *velocity;
            let value = field(&mut self.value);
            *value += velocity * dt;
            error += (target - *value).abs() + velocity.abs() * 0.1;
        }
        if error <= SPRING.epsilon {
            self.finish();
            return false;
        }
        true
    }

    pub fn finish(&mut self) {
        self.value = self.target;
        self.velocity = Rect::ZERO;
    }

    pub fn jump(&mut self, rect: Rect) {
        self.target = rect;
        self.finish();
    }
}

/// Per-element transitions from a captured screen rect to a live target.
#[derive(Clone, Debug)]
pub struct LayoutTween {
    pub from: HashMap<String, Rect>,
    pub start: f64,
    pub progress: f64,
}

impl Default for LayoutTween {
    fn default() -> Self {
        LayoutTween {
            from: HashMap::new(),
            start: 0.,
            progress: 1.,
        }
    }
}

impl LayoutTween {
    pub fn begin(&mut self, from: HashMap<String, Rect>, now: f64) {
        self.progress = if from.is_empty() { 1. } else { 0. };
        self.from = from;
        self.start = now;
    }

    pub fn step(&mut self, now: f64) -> bool {
        self.step_for(now, LAYOUT_MS)
    }

    pub fn step_for(&mut self, now: f64, duration: f64) -> bool {
        let elapsed = if duration > 0. {
            (now - self.start) / duration
        } else {
            1.
        };
        self.progress = ease_out_quint(elapsed);
        if elapsed >= 1. {
            self.stop();
        }
        self.progress < 1.
    }

    pub fn stop(&mut self) {
        self.progress = 1.;
        self.from.clear();
    }

    pub fn active(&self) -> bool {
        self.progress < 1.
    }

    pub fn apply(&self, id: &str, target: Rect) -> Rect {
        match self.from.get(id) {
            Some(from) if self.progress < 1. => lerp_rect(*from, target, self.progress),
            _ => target,
        }
    }
}

/// A CSS cubic-bezier timing function, for animations driven per frame.
pub fn cubic_bezier(x1: f64, y1: f64, x2: f64, y2: f64) -> impl Fn(f64) -> f64 {
    let sample = |a: f64, b: f64, t: f64| ((1. - 3. * b + 3. * a) * t + (3. * b - 6. * a)) * t * t + 3. * a * t;
    move |x: f64| {
        if x <= 0. {
            return 0.;
        }
        if x >= 1. {
            return 1.;
        }
        let (mut lo, mut hi, mut t) = (0., 1., x);
        for _ in 0..24 {
            let v = sample(x1, x2, t);
            if (v - x).abs() < 1e-5 {
                break;
            }
            if v < x {
                lo = t;
            } else {
                hi = t;
            }
            t = (lo + hi) / 2.;
        }
        sample(y1, y2, t)
    }
}

/// The minimize/restore curve.
pub fn dock_ease(t: f64) -> f64 {
    cubic_bezier(0.2, 0.75, 0.2, 1.)(t)
}

pub const DOCK_HIDE_MS: f64 = 300.;
pub const DOCK_RESTORE_MS: f64 = 380.;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spring_settles_on_its_target() {
        let mut spring = RectSpring::new(Rect::new(0., 0., 1., 1.));
        spring.target = Rect::new(0.2, 0.2, 0.5, 0.5);
        let mut frames = 0;
        while spring.step(1. / 60.) {
            frames += 1;
            assert!(frames < 600);
        }
        assert_eq!(spring.value, spring.target);
        // Visually there in about half a second; the last hundredths of a
        // pixel take it to about a second at 60 Hz.
        assert!((40..90).contains(&frames), "{frames}");
    }

    #[test]
    fn the_dock_curve_runs_from_zero_to_one() {
        assert_eq!(dock_ease(0.), 0.);
        assert_eq!(dock_ease(1.), 1.);
        assert!(dock_ease(0.5) > 0.8);
    }
}
