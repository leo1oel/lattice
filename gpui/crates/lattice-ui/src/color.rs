//! Colours as a custom colour picker holds them (`src/components/ui/color-picker.tsx`):
//! `#RRGGBB` for what is written and stored, HSV for the draft, so a grey
//! or black keeps the hue it came from and every brightness is one drag
//! away; and a short spoken name for a colour, its hue and how pale, soft
//! or dark it is.

use lattice_i18n::t;

/// A colour as the picker drafts it: hue in degrees (0 to 360),
/// saturation and value in percent (0 to 100).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hsv {
    pub h: f32,
    pub s: f32,
    pub v: f32,
}

/// `#RRGGBB` for a typed or pasted colour, with or without `#`, in three or
/// six digits (`normalizeHex`).
pub fn normalize_hex(value: &str) -> Option<String> {
    let text = value.trim();
    let text = text.strip_prefix('#').unwrap_or(text);
    if !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    match text.len() {
        3 => Some(format!(
            "#{}",
            text.chars()
                .flat_map(|digit| [digit, digit])
                .collect::<String>()
        )),
        6 => Some(format!("#{text}")),
        _ => None,
    }
    .map(|hex| hex.to_ascii_uppercase())
}

/// `0xRRGGBB` for a `#RRGGBB` colour.
pub fn hex_value(hex: &str) -> Option<u32> {
    let digits = hex.strip_prefix('#')?;
    (digits.len() == 6)
        .then(|| u32::from_str_radix(digits, 16).ok())
        .flatten()
}

/// `#RRGGBB` for `0xRRGGBB`.
pub fn hex_of(value: u32) -> String {
    format!("#{:06X}", value & 0xFF_FFFF)
}

fn rgb_of(value: u32) -> [f32; 3] {
    [
        ((value >> 16) & 0xff) as f32,
        ((value >> 8) & 0xff) as f32,
        (value & 0xff) as f32,
    ]
}

/// `rgbToHsv`.
pub fn rgb_to_hsv(value: u32) -> Hsv {
    let [red, green, blue] = rgb_of(value).map(|channel| channel / 255.);
    let max = red.max(green).max(blue);
    let delta = max - red.min(green).min(blue);
    let mut hue = 0.;
    if delta > 0. {
        hue = if max == red {
            ((green - blue) / delta) % 6.
        } else if max == green {
            (blue - red) / delta + 2.
        } else {
            (red - green) / delta + 4.
        };
        hue = (hue * 60. + 360.) % 360.;
    }
    Hsv {
        h: hue,
        s: if max > 0. { delta / max * 100. } else { 0. },
        v: max * 100.,
    }
}

/// `hsvToRgb`, rounded to `0xRRGGBB`.
pub fn hsv_to_rgb(hsv: Hsv) -> u32 {
    let chroma = hsv.v / 100. * (hsv.s / 100.);
    let section = hsv.h.rem_euclid(360.) / 60.;
    let x = chroma * (1. - ((section % 2.) - 1.).abs());
    let (red, green, blue) = match section {
        s if s < 1. => (chroma, x, 0.),
        s if s < 2. => (x, chroma, 0.),
        s if s < 3. => (0., chroma, x),
        s if s < 4. => (0., x, chroma),
        s if s < 5. => (x, 0., chroma),
        _ => (chroma, 0., x),
    };
    let offset = hsv.v / 100. - chroma;
    let byte = |channel: f32| ((channel + offset) * 255.).round().clamp(0., 255.) as u32;
    (byte(red) << 16) | (byte(green) << 8) | byte(blue)
}

/// The draft for `hex`, keeping `hue` when the colour itself has none (a
/// grey) (`hsvOf`).
pub fn hsv_of(hex: &str, hue: f32) -> Option<Hsv> {
    let next = rgb_to_hsv(hex_value(hex)?);
    Some(if next.s == 0. {
        Hsv { h: hue, ..next }
    } else {
        next
    })
}

/// `#RRGGBB` for a draft.
pub fn hsv_hex(hsv: Hsv) -> String {
    hex_of(hsv_to_rgb(hsv))
}

/// A short spoken name for `hex` (`colorName`): its hue, then how pale,
/// soft or dark it is.
pub fn color_name(hex: &str) -> String {
    let Some(value) = hex_value(hex) else {
        return String::new();
    };
    let Hsv { h, s, v } = rgb_to_hsv(value);
    if s < 8. {
        return if v > 96. {
            t!("White")
        } else if v > 78. {
            t!("Light Gray")
        } else if v > 42. {
            t!("Gray")
        } else if v > 10. {
            t!("Dark Gray")
        } else {
            t!("Black")
        }
        .to_string();
    }
    let hues = [
        t!("Red"),
        t!("Orange"),
        t!("Yellow"),
        t!("Lime"),
        t!("Green"),
        t!("Teal"),
        t!("Cyan"),
        t!("Azure"),
        t!("Blue"),
        t!("Indigo"),
        t!("Violet"),
        t!("Magenta"),
    ];
    let name = hues[(h / 30.).round() as usize % hues.len()];
    if v < 45. {
        t!("Dark {name}", name = name)
    } else if s < 30. {
        t!("Pale {name}", name = name)
    } else if s < 55. || (v > 94. && s < 75.) {
        t!("Soft {name}", name = name)
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_codes_are_read_in_three_or_six_digits() {
        assert_eq!(normalize_hex("fff1a6").as_deref(), Some("#FFF1A6"));
        assert_eq!(normalize_hex(" #abc ").as_deref(), Some("#AABBCC"));
        assert_eq!(normalize_hex("#ABCD"), None);
        assert_eq!(normalize_hex("ggg"), None);
        assert_eq!(normalize_hex(""), None);
    }

    // The textbook HSV corners: pure red is 0°, 100%, 100%; pure blue 240°;
    // mid grey has no saturation and half the value.
    #[test]
    fn hsv_round_trips_the_textbook_colours() {
        assert_eq!(
            rgb_to_hsv(0xFF0000),
            Hsv {
                h: 0.,
                s: 100.,
                v: 100.
            }
        );
        assert_eq!(rgb_to_hsv(0x0000FF).h, 240.);
        let grey = rgb_to_hsv(0x808080);
        assert_eq!(grey.s, 0.);
        assert!((grey.v - 50.2).abs() < 0.1);
        for value in [0xFFF1A6, 0x123456, 0x000000, 0xFFFFFF, 0xCFEFC6] {
            assert_eq!(hsv_to_rgb(rgb_to_hsv(value)), value, "{value:06X}");
        }
        assert_eq!(
            hsv_to_rgb(Hsv {
                h: 120.,
                s: 100.,
                v: 100.
            }),
            0x00FF00
        );
    }

    // Dragging to black and back keeps the hue the writer was on.
    #[test]
    fn a_grey_keeps_the_hue_it_came_from() {
        assert_eq!(hsv_of("#000000", 210.).map(|hsv| hsv.h), Some(210.));
        assert_eq!(hsv_of("#FF0000", 210.).map(|hsv| hsv.h), Some(0.));
    }

    #[test]
    fn colours_are_named_by_hue_and_how_light_they_are() {
        assert_eq!(color_name("#FFFFFF"), "White");
        assert_eq!(color_name("#000000"), "Black");
        assert_eq!(color_name("#FF0000"), "Red");
        assert_eq!(color_name("#FFF1A6"), "Soft Yellow");
        assert_eq!(color_name("#202060"), "Dark Blue");
        assert_eq!(color_name("#E8EEF2"), "Light Gray");
    }
}
