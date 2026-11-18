// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! CSS colors as Excalidraw stores them. Upstream hands color strings to the
//! canvas / SVG as they are (and reads them with tinycolor2 in
//! `common/src/colors.ts`); the display list needs numbers, so this parses
//! what a browser accepts for element colors @ 3a317b5: `#rgb`, `#rgba`,
//! `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` (commas or spaces, `/` alpha,
//! percentages), `hsl()` / `hsla()`, the CSS named colors and `transparent`.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    pub const TRANSPARENT: Rgba = Rgba {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
    };
    pub const BLACK: Rgba = Rgba {
        r: 0,
        g: 0,
        b: 0,
        a: 255,
    };
    pub fn rgb(r: u8, g: u8, b: u8) -> Rgba {
        Rgba { r, g, b, a: 255 }
    }
    pub fn alpha(&self) -> f64 {
        self.a as f64 / 255.
    }
    pub fn with_alpha(self, a: f64) -> Rgba {
        Rgba {
            a: (a.clamp(0., 1.) * 255.).round() as u8,
            ..self
        }
    }
    pub fn is_transparent(&self) -> bool {
        self.a == 0
    }
    /// `#rrggbb`, the alpha left to the caller (SVG `*-opacity`).
    pub fn hex_rgb(&self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }
}

const DARK_MODE_FILTER_INVERT: f64 = 0.93;
const DARK_MODE_FILTER_HUE_ROTATE_DEGREES: f64 = 180.;

/// `applyDarkModeFilter` (common/src/colors.ts): the dark theme's
/// `invert(93%) hue-rotate(180deg)` worked out per color, as upstream does
/// for everything on the canvas (each step rounded to whole channels, the
/// hue rotation with the CSS filter-effects matrix); alpha is kept.
pub fn apply_dark_mode_filter(c: Rgba) -> Rgba {
    let p = DARK_MODE_FILTER_INVERT;
    let inv = |v: u8| {
        let v = v as f64;
        crate::board::math::js_round((v * (1. - p) + (255. - v) * p).clamp(0., 255.))
    };
    let (r, g, b) = (inv(c.r) / 255., inv(c.g) / 255., inv(c.b) / 255.);
    let a = DARK_MODE_FILTER_HUE_ROTATE_DEGREES * std::f64::consts::PI / 180.;
    let (cs, sn) = (a.cos(), a.sin());
    let m = [
        0.213 + cs * 0.787 - sn * 0.213,
        0.715 - cs * 0.715 - sn * 0.715,
        0.072 - cs * 0.072 + sn * 0.928,
        0.213 - cs * 0.213 + sn * 0.143,
        0.715 + cs * 0.285 + sn * 0.14,
        0.072 - cs * 0.072 - sn * 0.283,
        0.213 - cs * 0.213 - sn * 0.787,
        0.715 - cs * 0.715 + sn * 0.715,
        0.072 + cs * 0.928 + sn * 0.072,
    ];
    let ch = |v: f64| crate::board::math::js_round(v.clamp(0., 1.) * 255.) as u8;
    // upstream rebuilds `#rrggbbaa` from tinycolor's alpha: round(a * 255)
    Rgba {
        r: ch(r * m[0] + g * m[1] + b * m[2]),
        g: ch(r * m[3] + g * m[4] + b * m[5]),
        b: ch(r * m[6] + g * m[7] + b * m[8]),
        a: c.a,
    }
}

/// Parses a CSS color; `None` for anything a browser would reject (upstream
/// then keeps the previous canvas color, which in practice is black).
pub fn parse_color(s: &str) -> Option<Rgba> {
    let c = s.trim().to_ascii_lowercase();
    if c == "transparent" {
        return Some(Rgba::TRANSPARENT);
    }
    if let Some(hex) = c.strip_prefix('#') {
        return parse_hex(hex);
    }
    if let Some((f, args)) = c.split_once('(') {
        let args = args.strip_suffix(')')?;
        let parts: Vec<&str> = args
            .split(|ch: char| ch == ',' || ch == '/' || ch.is_whitespace())
            .filter(|p| !p.is_empty())
            .collect();
        if parts.len() != 3 && parts.len() != 4 {
            return None;
        }
        let alpha = match parts.get(3) {
            Some(a) => unit(a)?,
            None => 1.,
        };
        let rgb = match f.trim() {
            "rgb" | "rgba" => {
                let ch = |p: &str| -> Option<f64> {
                    Some(if let Some(v) = p.strip_suffix('%') {
                        v.parse::<f64>().ok()? * 2.55
                    } else {
                        p.parse().ok()?
                    })
                };
                [ch(parts[0])?, ch(parts[1])?, ch(parts[2])?]
            }
            "hsl" | "hsla" => {
                let h = parts[0].trim_end_matches("deg").parse::<f64>().ok()?;
                let pct = |p: &str| -> Option<f64> {
                    Some(p.strip_suffix('%').unwrap_or(p).parse::<f64>().ok()? / 100.)
                };
                hsl_to_rgb(h, pct(parts[1])?, pct(parts[2])?)
            }
            _ => return None,
        };
        let b = |v: f64| v.round().clamp(0., 255.) as u8;
        return Some(Rgba {
            r: b(rgb[0]),
            g: b(rgb[1]),
            b: b(rgb[2]),
            a: (alpha.clamp(0., 1.) * 255.).round() as u8,
        });
    }
    named(&c)
}

/// Like `parse_color`, unparseable colors as opaque black.
pub fn color_or_black(s: &str) -> Rgba {
    parse_color(s).unwrap_or(Rgba::BLACK)
}

fn unit(a: &str) -> Option<f64> {
    if let Some(p) = a.strip_suffix('%') {
        Some(p.parse::<f64>().ok()? / 100.)
    } else {
        a.parse().ok()
    }
}

fn parse_hex(h: &str) -> Option<Rgba> {
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let d = |i: usize| u8::from_str_radix(&h[i..i + 1], 16).unwrap() * 17;
    let dd = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap();
    Some(match h.len() {
        3 => Rgba::rgb(d(0), d(1), d(2)),
        4 => Rgba {
            r: d(0),
            g: d(1),
            b: d(2),
            a: d(3),
        },
        6 => Rgba::rgb(dd(0), dd(2), dd(4)),
        8 => Rgba {
            r: dd(0),
            g: dd(2),
            b: dd(4),
            a: dd(6),
        },
        _ => return None,
    })
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> [f64; 3] {
    let h = h.rem_euclid(360.) / 360.;
    let (s, l) = (s.clamp(0., 1.), l.clamp(0., 1.));
    if s == 0. {
        return [l * 255.; 3];
    }
    let q = if l < 0.5 { l * (1. + s) } else { l + s - l * s };
    let p = 2. * l - q;
    let f = |mut t: f64| {
        if t < 0. {
            t += 1.
        }
        if t > 1. {
            t -= 1.
        }
        255. * if t < 1. / 6. {
            p + (q - p) * 6. * t
        } else if t < 0.5 {
            q
        } else if t < 2. / 3. {
            p + (q - p) * (2. / 3. - t) * 6.
        } else {
            p
        }
    };
    [f(h + 1. / 3.), f(h), f(h - 1. / 3.)]
}

fn named(n: &str) -> Option<Rgba> {
    let v: u32 = match n {
        "aliceblue" => 0xf0f8ff,
        "antiquewhite" => 0xfaebd7,
        "aqua" => 0x00ffff,
        "aquamarine" => 0x7fffd4,
        "azure" => 0xf0ffff,
        "beige" => 0xf5f5dc,
        "bisque" => 0xffe4c4,
        "black" => 0x000000,
        "blanchedalmond" => 0xffebcd,
        "blue" => 0x0000ff,
        "blueviolet" => 0x8a2be2,
        "brown" => 0xa52a2a,
        "burlywood" => 0xdeb887,
        "cadetblue" => 0x5f9ea0,
        "chartreuse" => 0x7fff00,
        "chocolate" => 0xd2691e,
        "coral" => 0xff7f50,
        "cornflowerblue" => 0x6495ed,
        "cornsilk" => 0xfff8dc,
        "crimson" => 0xdc143c,
        "cyan" => 0x00ffff,
        "darkblue" => 0x00008b,
        "darkcyan" => 0x008b8b,
        "darkgoldenrod" => 0xb8860b,
        "darkgray" | "darkgrey" => 0xa9a9a9,
        "darkgreen" => 0x006400,
        "darkkhaki" => 0xbdb76b,
        "darkmagenta" => 0x8b008b,
        "darkolivegreen" => 0x556b2f,
        "darkorange" => 0xff8c00,
        "darkorchid" => 0x9932cc,
        "darkred" => 0x8b0000,
        "darksalmon" => 0xe9967a,
        "darkseagreen" => 0x8fbc8f,
        "darkslateblue" => 0x483d8b,
        "darkslategray" | "darkslategrey" => 0x2f4f4f,
        "darkturquoise" => 0x00ced1,
        "darkviolet" => 0x9400d3,
        "deeppink" => 0xff1493,
        "deepskyblue" => 0x00bfff,
        "dimgray" | "dimgrey" => 0x696969,
        "dodgerblue" => 0x1e90ff,
        "firebrick" => 0xb22222,
        "floralwhite" => 0xfffaf0,
        "forestgreen" => 0x228b22,
        "fuchsia" => 0xff00ff,
        "gainsboro" => 0xdcdcdc,
        "ghostwhite" => 0xf8f8ff,
        "gold" => 0xffd700,
        "goldenrod" => 0xdaa520,
        "gray" | "grey" => 0x808080,
        "green" => 0x008000,
        "greenyellow" => 0xadff2f,
        "honeydew" => 0xf0fff0,
        "hotpink" => 0xff69b4,
        "indianred" => 0xcd5c5c,
        "indigo" => 0x4b0082,
        "ivory" => 0xfffff0,
        "khaki" => 0xf0e68c,
        "lavender" => 0xe6e6fa,
        "lavenderblush" => 0xfff0f5,
        "lawngreen" => 0x7cfc00,
        "lemonchiffon" => 0xfffacd,
        "lightblue" => 0xadd8e6,
        "lightcoral" => 0xf08080,
        "lightcyan" => 0xe0ffff,
        "lightgoldenrodyellow" => 0xfafad2,
        "lightgray" | "lightgrey" => 0xd3d3d3,
        "lightgreen" => 0x90ee90,
        "lightpink" => 0xffb6c1,
        "lightsalmon" => 0xffa07a,
        "lightseagreen" => 0x20b2aa,
        "lightskyblue" => 0x87cefa,
        "lightslategray" | "lightslategrey" => 0x778899,
        "lightsteelblue" => 0xb0c4de,
        "lightyellow" => 0xffffe0,
        "lime" => 0x00ff00,
        "limegreen" => 0x32cd32,
        "linen" => 0xfaf0e6,
        "magenta" => 0xff00ff,
        "maroon" => 0x800000,
        "mediumaquamarine" => 0x66cdaa,
        "mediumblue" => 0x0000cd,
        "mediumorchid" => 0xba55d3,
        "mediumpurple" => 0x9370db,
        "mediumseagreen" => 0x3cb371,
        "mediumslateblue" => 0x7b68ee,
        "mediumspringgreen" => 0x00fa9a,
        "mediumturquoise" => 0x48d1cc,
        "mediumvioletred" => 0xc71585,
        "midnightblue" => 0x191970,
        "mintcream" => 0xf5fffa,
        "mistyrose" => 0xffe4e1,
        "moccasin" => 0xffe4b5,
        "navajowhite" => 0xffdead,
        "navy" => 0x000080,
        "oldlace" => 0xfdf5e6,
        "olive" => 0x808000,
        "olivedrab" => 0x6b8e23,
        "orange" => 0xffa500,
        "orangered" => 0xff4500,
        "orchid" => 0xda70d6,
        "palegoldenrod" => 0xeee8aa,
        "palegreen" => 0x98fb98,
        "paleturquoise" => 0xafeeee,
        "palevioletred" => 0xdb7093,
        "papayawhip" => 0xffefd5,
        "peachpuff" => 0xffdab9,
        "peru" => 0xcd853f,
        "pink" => 0xffc0cb,
        "plum" => 0xdda0dd,
        "powderblue" => 0xb0e0e6,
        "purple" => 0x800080,
        "rebeccapurple" => 0x663399,
        "red" => 0xff0000,
        "rosybrown" => 0xbc8f8f,
        "royalblue" => 0x4169e1,
        "saddlebrown" => 0x8b4513,
        "salmon" => 0xfa8072,
        "sandybrown" => 0xf4a460,
        "seagreen" => 0x2e8b57,
        "seashell" => 0xfff5ee,
        "sienna" => 0xa0522d,
        "silver" => 0xc0c0c0,
        "skyblue" => 0x87ceeb,
        "slateblue" => 0x6a5acd,
        "slategray" | "slategrey" => 0x708090,
        "snow" => 0xfffafa,
        "springgreen" => 0x00ff7f,
        "steelblue" => 0x4682b4,
        "tan" => 0xd2b48c,
        "teal" => 0x008080,
        "thistle" => 0xd8bfd8,
        "tomato" => 0xff6347,
        "turquoise" => 0x40e0d0,
        "violet" => 0xee82ee,
        "wheat" => 0xf5deb3,
        "white" => 0xffffff,
        "whitesmoke" => 0xf5f5f5,
        "yellow" => 0xffff00,
        "yellowgreen" => 0x9acd32,
        _ => return None,
    };
    Some(Rgba::rgb((v >> 16) as u8, (v >> 8) as u8, v as u8))
}
