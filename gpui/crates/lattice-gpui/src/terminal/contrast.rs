//! xterm.js's `minimumContrastRatio`: a program's colour too faint on the
//! ground it stands on is stepped darker or lighter (10% of the way at a
//! time, as xterm.js's `ensureContrastRatio` steps it) until it reads at the
//! WCAG ratio asked for, so a yellow warning stays readable on a light
//! theme. Whichever way gets closer wins when neither reaches it.

use gpui::{Hsla, Rgba};

/// `ink` on `ground`, lifted to `ratio` if it falls short.
pub fn ensure(ink: Hsla, ground: Hsla, ratio: f32) -> Hsla {
    let alpha = ink.a;
    let fg = bytes(ink);
    let bg = bytes(ground);
    let (fg_l, bg_l) = (luminance(fg), luminance(bg));
    if contrast(fg_l, bg_l) >= ratio {
        return ink;
    }
    let (first, second): (
        fn([u8; 3], f32, f32) -> [u8; 3],
        fn([u8; 3], f32, f32) -> [u8; 3],
    ) = if fg_l < bg_l {
        (darker, lighter)
    } else {
        (lighter, darker)
    };
    let a = first(fg, bg_l, ratio);
    let a_ratio = contrast(luminance(a), bg_l);
    let chosen = if a_ratio >= ratio {
        a
    } else {
        let b = second(fg, bg_l, ratio);
        if a_ratio > contrast(luminance(b), bg_l) {
            a
        } else {
            b
        }
    };
    let mut out: Hsla = Rgba {
        r: chosen[0] as f32 / 255.,
        g: chosen[1] as f32 / 255.,
        b: chosen[2] as f32 / 255.,
        a: 1.,
    }
    .into();
    out.a = alpha;
    out
}

fn bytes(color: Hsla) -> [u8; 3] {
    let rgba = Rgba::from(color);
    let byte = |c: f32| (c * 255.).round().clamp(0., 255.) as u8;
    [byte(rgba.r), byte(rgba.g), byte(rgba.b)]
}

/// WCAG relative luminance.
fn luminance([r, g, b]: [u8; 3]) -> f32 {
    let channel = |c: u8| {
        let c = c as f32 / 255.;
        if c <= 0.039_28 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

fn contrast(a: f32, b: f32) -> f32 {
    let (hi, lo) = if a > b { (a, b) } else { (b, a) };
    (hi + 0.05) / (lo + 0.05)
}

fn darker(mut fg: [u8; 3], bg_l: f32, ratio: f32) -> [u8; 3] {
    while contrast(luminance(fg), bg_l) < ratio && fg.iter().any(|c| *c > 0) {
        for c in &mut fg {
            *c -= ((*c as f32) * 0.1).ceil().max(0.) as u8;
        }
    }
    fg
}

fn lighter(mut fg: [u8; 3], bg_l: f32, ratio: f32) -> [u8; 3] {
    while contrast(luminance(fg), bg_l) < ratio && fg.iter().any(|c| *c < 255) {
        for c in &mut fg {
            *c = (*c as f32 + ((255 - *c) as f32 * 0.1).ceil()).min(255.) as u8;
        }
    }
    fg
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(r: u8, g: u8, b: u8) -> Hsla {
        Rgba {
            r: r as f32 / 255.,
            g: g as f32 / 255.,
            b: b as f32 / 255.,
            a: 1.,
        }
        .into()
    }

    #[test]
    fn a_readable_colour_is_left_alone() {
        let ink = rgb(20, 20, 20);
        assert_eq!(ensure(ink, rgb(255, 255, 255), 4.5), ink);
    }

    #[test]
    fn a_faint_yellow_on_white_darkens_to_the_ratio() {
        let ground = rgb(255, 255, 255);
        let lifted = ensure(rgb(240, 200, 40), ground, 4.5);
        let ratio = contrast(luminance(bytes(lifted)), luminance(bytes(ground)));
        assert!(ratio >= 4.5, "{ratio}");
    }

    #[test]
    fn a_dark_blue_on_black_lightens() {
        let ground = rgb(0, 0, 0);
        let lifted = ensure(rgb(10, 10, 80), ground, 4.5);
        assert!(luminance(bytes(lifted)) > luminance([10, 10, 80]));
    }
}
