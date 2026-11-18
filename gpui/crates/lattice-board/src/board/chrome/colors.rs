// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The color picker's palette, after Excalidraw `packages/common/src/colors.ts`
//! @ 3a317b5. Element colors are scene data, so these are upstream's hex
//! strings verbatim (open-color shades 50/200/400/600/800, radix bronze).

pub const TRANSPARENT: &str = "transparent";
pub const BLACK: &str = "#1e1e1e";
pub const WHITE: &str = "#ffffff";

/// `COLOR_PALETTE`'s shaded hues, in the picker's order: the two neutrals of
/// the first row, then `COMMON_ELEMENT_SHADES`.
pub const HUES: [(&str, [&str; 5]); 12] = [
    (
        "gray",
        ["#f8f9fa", "#e9ecef", "#ced4da", "#868e96", "#343a40"],
    ),
    (
        "bronze",
        ["#f8f1ee", "#eaddd7", "#d2bab0", "#a18072", "#846358"],
    ),
    (
        "cyan",
        ["#e3fafc", "#99e9f2", "#3bc9db", "#15aabf", "#0c8599"],
    ),
    (
        "blue",
        ["#e7f5ff", "#a5d8ff", "#4dabf7", "#228be6", "#1971c2"],
    ),
    (
        "violet",
        ["#f3f0ff", "#d0bfff", "#9775fa", "#7950f2", "#6741d9"],
    ),
    (
        "grape",
        ["#f8f0fc", "#eebefa", "#da77f2", "#be4bdb", "#9c36b5"],
    ),
    (
        "pink",
        ["#fff0f6", "#fcc2d7", "#f783ac", "#e64980", "#c2255c"],
    ),
    (
        "green",
        ["#ebfbee", "#b2f2bb", "#69db7c", "#40c057", "#2f9e44"],
    ),
    (
        "teal",
        ["#e6fcf5", "#96f2d7", "#38d9a9", "#12b886", "#099268"],
    ),
    (
        "yellow",
        ["#fff9db", "#ffec99", "#ffd43b", "#fab005", "#f08c00"],
    ),
    (
        "orange",
        ["#fff4e6", "#ffd8a8", "#ffa94d", "#fd7e14", "#e8590c"],
    ),
    (
        "red",
        ["#fff5f5", "#ffc9c9", "#ff8787", "#fa5252", "#e03131"],
    ),
];

/// `DEFAULT_ELEMENT_STROKE_COLOR_INDEX` / `DEFAULT_ELEMENT_BACKGROUND_COLOR_INDEX`.
pub const STROKE_SHADE: usize = 4;
pub const BACKGROUND_SHADE: usize = 1;

/// `DEFAULT_ELEMENT_STROKE_PICKS` (black, red, green, blue, yellow at shade 4).
pub const STROKE_PICKS: [&str; 5] = [BLACK, "#e03131", "#2f9e44", "#1971c2", "#f08c00"];
/// `DEFAULT_ELEMENT_BACKGROUND_PICKS`.
pub const BACKGROUND_PICKS: [&str; 5] = [TRANSPARENT, "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"];
/// `DEFAULT_CANVAS_BACKGROUND_PICKS` (white, radix slate2 / blue2 / yellow2 / bronze2).
pub const CANVAS_BACKGROUND_PICKS: [&str; 5] = [WHITE, "#f8f9fa", "#f5faff", "#fffce8", "#fdf8f6"];
/// `STICKY_NOTE_BACKGROUND_PICKS`: never transparent.
pub const STICKY_BACKGROUND_PICKS: [&str; 5] =
    ["#ffdf6b", "#fcc2d7", "#b2f2bb", "#a5d8ff", "#ffd8a8"];

fn hue_index(name: &str) -> usize {
    HUES.iter().position(|(n, _)| *n == name).unwrap_or(0)
}

/// Which hue and shade `color` is, if it's a palette color.
pub fn find(color: &str) -> Option<(usize, usize)> {
    let c = color.to_ascii_lowercase();
    HUES.iter()
        .enumerate()
        .find_map(|(h, (_, shades))| shades.iter().position(|s| *s == c).map(|i| (h, i)))
}

/// The palette grid (5 per row, `COLORS_PER_ROW`): transparent, white, gray,
/// black, bronze; then the ten hues. Shaded hues show `shade`.
pub fn grid(shade: usize) -> Vec<&'static str> {
    let at = |name: &str| HUES[hue_index(name)].1[shade];
    let mut v = vec![TRANSPARENT, WHITE, at("gray"), BLACK, at("bronze")];
    v.extend(HUES[2..].iter().map(|(_, s)| s[shade]));
    v
}

/// Upstream's color names (`colors.*`), for tooltips.
pub fn name(color: &str) -> &'static str {
    use crate::settings::tr;
    let c = color.to_ascii_lowercase();
    if crate::board::utils::is_transparent(&c) {
        return tr("透明", "Transparent");
    }
    if c == BLACK {
        return tr("黑", "Black");
    }
    if c == WHITE {
        return tr("白", "White");
    }
    match find(&c).map(|(h, _)| HUES[h].0) {
        Some("gray") => tr("灰", "Gray"),
        Some("bronze") => tr("古铜", "Bronze"),
        Some("cyan") => tr("青", "Cyan"),
        Some("blue") => tr("蓝", "Blue"),
        Some("violet") => tr("蓝紫", "Violet"),
        Some("grape") => tr("紫红", "Grape"),
        Some("pink") => tr("粉红", "Pink"),
        Some("green") => tr("绿", "Green"),
        Some("teal") => tr("蓝绿", "Teal"),
        Some("yellow") => tr("黄", "Yellow"),
        Some("orange") => tr("橙", "Orange"),
        Some("red") => tr("红", "Red"),
        _ => color_name_custom(),
    }
}

fn color_name_custom() -> &'static str {
    crate::settings::tr("颜色", "Color")
}
