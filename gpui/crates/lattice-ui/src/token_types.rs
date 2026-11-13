//! The value types `tokens.rs` is written in.
//!
//! Every token keeps the unit it has in `design-system/tokens.json`: colours
//! as 8-bit sRGB with a float alpha (so `rgb(28 28 31 / 9%)` stays 9%, not the
//! 23/255 a byte would round it to), sizes as rems of a 16px root (so the
//! interface size setting scales them through `Window::set_rem_size`),
//! durations as `Duration`, curves as the stop lists CSS `linear()` takes.

use std::time::Duration;

use gpui::{BoxShadow, Hsla, Rgba, point, px};

use crate::Appearance;

/// One sRGB colour with straight alpha.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Srgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: f32,
}

/// `#RRGGBB`.
pub const fn hex(rgb: u32) -> Srgb {
    Srgb {
        r: (rgb >> 16) as u8,
        g: (rgb >> 8) as u8,
        b: rgb as u8,
        a: 1.0,
    }
}

/// `rgb(r g b / a)`, alpha in 0..=1.
pub const fn rgba8(r: u8, g: u8, b: u8, a: f32) -> Srgb {
    Srgb { r, g, b, a }
}

impl Srgb {
    pub fn rgba(self) -> Rgba {
        Rgba {
            r: self.r as f32 / 255.,
            g: self.g as f32 / 255.,
            b: self.b as f32 / 255.,
            a: self.a,
        }
    }

    pub fn hsla(self) -> Hsla {
        self.rgba().into()
    }

    /// The same colour at `alpha` times its own opacity, as CSS
    /// `color-mix(in srgb, <colour> <alpha>, transparent)` gives it.
    pub fn alpha(self, alpha: f32) -> Hsla {
        Srgb {
            a: self.a * alpha,
            ..self
        }
        .hsla()
    }

    /// `color-mix(in srgb, self <1 - amount>, other <amount>)` for opaque
    /// colours: how the app lays a veil or a wash over a surface and keeps the
    /// result opaque.
    pub fn mix(self, other: Srgb, amount: f32) -> Srgb {
        let channel = |a: u8, b: u8| (a as f32 * (1. - amount) + b as f32 * amount).round() as u8;
        Srgb {
            r: channel(self.r, other.r),
            g: channel(self.g, other.g),
            b: channel(self.b, other.b),
            a: self.a * (1. - amount) + other.a * amount,
        }
    }

    /// This colour laid over an opaque `ground`: what the eye sees, as one
    /// opaque colour.
    pub fn over(self, ground: Srgb) -> Srgb {
        let mixed = ground.mix(Srgb { a: 1., ..self }, self.a);
        Srgb { a: 1., ..mixed }
    }

    /// `color-mix(in srgb, self <amount>, other)` as CSS mixes colours that
    /// may be translucent: the channels are mixed premultiplied by their
    /// alpha, so `color-mix(in srgb, #fff 34%, transparent)` is white at 34%
    /// and a veil over a translucent sheet keeps the sheet's hue.
    pub fn color_mix(self, amount: f32, other: Srgb) -> Srgb {
        let (p, q) = (amount, 1. - amount);
        let a = self.a * p + other.a * q;
        if a <= 0. {
            return Srgb { a: 0., ..other };
        }
        let channel = |x: u8, y: u8| {
            ((x as f32 * self.a * p + y as f32 * other.a * q) / a)
                .round()
                .clamp(0., 255.) as u8
        };
        Srgb {
            r: channel(self.r, other.r),
            g: channel(self.g, other.g),
            b: channel(self.b, other.b),
            a,
        }
    }

    /// This colour painted over `ground`, either of them translucent
    /// (source-over): one fill that looks like the two layers.
    pub fn composite_over(self, ground: Srgb) -> Srgb {
        let a = self.a + ground.a * (1. - self.a);
        if a <= 0. {
            return Srgb { a: 0., ..ground };
        }
        let channel = |x: u8, y: u8| {
            ((x as f32 * self.a + y as f32 * ground.a * (1. - self.a)) / a)
                .round()
                .clamp(0., 255.) as u8
        };
        Srgb {
            r: channel(self.r, ground.r),
            g: channel(self.g, ground.g),
            b: channel(self.b, ground.b),
            a,
        }
    }

    /// This colour with alpha `a`.
    pub fn with_alpha(self, a: f32) -> Srgb {
        Srgb { a, ..self }
    }
}

/// A colour with its light and dark values. Tokens with one value (a PDF page,
/// a search hit) carry it twice.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorToken {
    pub light: Srgb,
    pub dark: Srgb,
}

impl ColorToken {
    pub const fn new(light: Srgb, dark: Srgb) -> Self {
        Self { light, dark }
    }

    pub const fn same(both: Srgb) -> Self {
        Self {
            light: both,
            dark: both,
        }
    }

    pub fn get(self, appearance: Appearance) -> Srgb {
        match appearance {
            Appearance::Light => self.light,
            Appearance::Dark => self.dark,
        }
    }

    pub fn hsla(self, appearance: Appearance) -> Hsla {
        self.get(appearance).hsla()
    }
}

/// One layer of a CSS `box-shadow`, in pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShadowLayer {
    pub x: f32,
    pub y: f32,
    pub blur: f32,
    pub spread: f32,
    pub color: Srgb,
}

pub const fn layer(x: f32, y: f32, blur: f32, spread: f32, color: Srgb) -> ShadowLayer {
    ShadowLayer {
        x,
        y,
        blur,
        spread,
        color,
    }
}

impl ShadowLayer {
    pub fn box_shadow(self) -> BoxShadow {
        BoxShadow {
            color: self.color.hsla(),
            offset: point(px(self.x), px(self.y)),
            blur_radius: px(self.blur),
            spread_radius: px(self.spread),
            inset: false,
        }
    }
}

/// A shadow stack in each appearance; shadows deepen in dark.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShadowToken {
    pub light: &'static [ShadowLayer],
    pub dark: &'static [ShadowLayer],
}

impl ShadowToken {
    pub fn get(self, appearance: Appearance) -> &'static [ShadowLayer] {
        match appearance {
            Appearance::Light => self.light,
            Appearance::Dark => self.dark,
        }
    }
}

/// A CSS font stack, first choice first. Generic families (`sans-serif`)
/// are kept so the list reads as the CSS does; `fonts.rs` decides which
/// names GPUI can resolve.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontStack(pub &'static [&'static str]);

/// A timing curve.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ease {
    /// CSS `linear()` with evenly spaced stops: the spring samples.
    Linear(&'static [f32]),
    /// CSS `cubic-bezier()`, the fallback where `linear()` is unsupported.
    CubicBezier(f32, f32, f32, f32),
    /// CSS `ease-out`.
    EaseOut,
}

impl Ease {
    /// The curve's progress at `t` in 0..=1. A spring curve may overshoot 1.
    pub fn sample(self, t: f32) -> f32 {
        let t = t.clamp(0., 1.);
        match self {
            Ease::Linear(stops) => {
                let last = stops.len().saturating_sub(1);
                if last == 0 {
                    return stops.first().copied().unwrap_or(t);
                }
                let position = t * last as f32;
                let index = (position.floor() as usize).min(last - 1);
                let fraction = position - index as f32;
                stops[index] + (stops[index + 1] - stops[index]) * fraction
            }
            Ease::CubicBezier(x1, y1, x2, y2) => cubic_bezier(x1, y1, x2, y2, t),
            // CSS's `ease-out` is cubic-bezier(0, 0, 0.58, 1).
            Ease::EaseOut => cubic_bezier(0., 0., 0.58, 1., t),
        }
    }
}

/// Solve a CSS cubic Bézier timing function at `x` by bisection, which is
/// exact enough for animation and needs no derivative.
fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, x: f32) -> f32 {
    let curve = |t: f32, p1: f32, p2: f32| {
        let u = 1. - t;
        3. * u * u * t * p1 + 3. * u * t * t * p2 + t * t * t
    };
    let (mut low, mut high) = (0f32, 1f32);
    for _ in 0..32 {
        let mid = (low + high) / 2.;
        if curve(mid, x1, x2) < x {
            low = mid;
        } else {
            high = mid;
        }
    }
    curve((low + high) / 2., y1, y2)
}

/// A motion tier: duration and curve taken together, as the design system
/// asks (`--motion-fast`, `--motion-pop-exit`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionToken {
    pub duration: Duration,
    pub ease: Ease,
}

impl MotionToken {
    pub const fn new(duration: Duration, ease: Ease) -> Self {
        Self { duration, ease }
    }
}
