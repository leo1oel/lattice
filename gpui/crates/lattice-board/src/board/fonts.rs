// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The board's fonts: Excalidraw's own (assets/fonts/excalidraw, licenses in
//! THIRD_PARTY_NOTICES.md), registered with GPUI, and the family → font
//! mapping of Excalidraw `packages/common/src/utils.ts` `getFontFamilyString`
//! / `constants.ts` `getFontFamilyFallbacks` @ 3a317b5.
//!
//! Upstream lets CSS fall back per character: `Excalifont, Xiaolai,
//! sans-serif, Segoe UI Emoji`. Lattice doesn't ship Xiaolai (14 MB
//! compressed): a character the family's font lacks falls back to the
//! system's, PingFang SC for CJK, through the font's fallback list, as a
//! browser without Xiaolai would draw it.
//!
//! Bundled: Excalifont, Nunito, Comic Shanns (the three the picker offers),
//! and Virgil, Cascadia and Lilita One for files that name them (about
//! 760 KB). Helvetica (2) and Liberation Sans (9) draw with the system's
//! Helvetica / Arial, as browsers resolve them.

use gpui::{App, Font, FontFallbacks, FontFeatures, FontStyle, FontWeight};
use lattice_board_core::board::consts::font_family as ff;
use lattice_board_core::board::text_measure::set_font_source;
use std::borrow::Cow;

/// Bundled faces: family number, family name (as Excalidraw's CSS names it,
/// and as the font's name table says), the font file.
const BUNDLED: [(u32, &str, &[u8]); 6] = [
    (
        ff::EXCALIFONT,
        "Excalifont",
        include_bytes!("../../assets/fonts/excalidraw/Excalifont-Regular.ttf"),
    ),
    (
        ff::VIRGIL,
        "Virgil",
        include_bytes!("../../assets/fonts/excalidraw/Virgil-Regular.ttf"),
    ),
    (
        ff::NUNITO,
        "Nunito",
        include_bytes!("../../assets/fonts/excalidraw/Nunito-Medium.ttf"),
    ),
    (
        ff::LILITA_ONE,
        "Lilita One",
        include_bytes!("../../assets/fonts/excalidraw/LilitaOne-Regular.ttf"),
    ),
    (
        ff::COMIC_SHANNS,
        "Comic Shanns",
        include_bytes!("../../assets/fonts/excalidraw/ComicShanns-Regular.ttf"),
    ),
    (
        ff::CASCADIA,
        "Cascadia",
        include_bytes!("../../assets/fonts/excalidraw/CascadiaCode-Regular.ttf"),
    ),
];

/// The font file of a family (core's `FontSource`, for SVG export).
pub fn bytes(family: u32) -> Option<&'static [u8]> {
    BUNDLED.iter().find(|b| b.0 == family).map(|b| b.2)
}

/// Registers the faces and hands core the font files for SVG export.
pub fn load(cx: &App) {
    let fonts = BUNDLED.iter().map(|b| Cow::Borrowed(b.2)).collect();
    if let Err(e) = cx.text_system().add_fonts(fonts) {
        log::warn!("board fonts: {e}");
    }
    set_font_source(bytes);
}

/// Adds the bundled fonts to a usvg font database (copy as PNG rasterizes
/// the exported SVG; usvg skips its inlined `@font-face`s).
pub fn load_into(db: &mut resvg::usvg::fontdb::Database) {
    for (_, _, b) in BUNDLED {
        db.load_font_source(resvg::usvg::fontdb::Source::Binary(std::sync::Arc::new(b)));
    }
}

/// The family name GPUI looks a family up by.
pub fn family_name(family: u32) -> &'static str {
    let arial = if cfg!(target_os = "linux") {
        "Liberation Sans"
    } else {
        "Arial"
    };
    match family {
        ff::HELVETICA => {
            if cfg!(target_os = "macos") {
                "Helvetica"
            } else {
                arial
            }
        }
        ff::LIBERATION_SANS => arial,
        f => BUNDLED
            .iter()
            .find(|b| b.0 == f)
            .map_or("Excalifont", |b| b.1),
    }
}

/// The system fonts behind a family: `sans-serif` or `monospace`, then CJK
/// and emoji (`Segoe UI Emoji` upstream).
fn system_fallbacks(family: u32) -> Vec<String> {
    let mono = ff::is_monospace(family);
    let v: &[&str] = if cfg!(target_os = "macos") {
        if mono {
            &["Menlo", "PingFang SC", "Apple Color Emoji"]
        } else {
            &["Helvetica", "PingFang SC", "Apple Color Emoji"]
        }
    } else if cfg!(target_os = "windows") {
        if mono {
            &["Consolas", "Microsoft YaHei", "Segoe UI Emoji"]
        } else {
            &["Arial", "Microsoft YaHei", "Segoe UI Emoji"]
        }
    } else {
        &[]
    };
    v.iter().map(|s| s.to_string()).collect()
}

/// A family's font, with the system's fonts behind it.
pub fn font(family: u32) -> Font {
    Font {
        family: family_name(family).into(),
        features: FontFeatures::default(),
        fallbacks: Some(FontFallbacks::from_fonts(system_fallbacks(family))),
        weight: FontWeight::NORMAL,
        style: FontStyle::Normal,
    }
}

/// `text` as runs by font (byte lengths): one, the family's; the text
/// system falls back per character.
pub fn runs(text: &str, family: u32) -> Vec<(usize, Font)> {
    vec![(text.len(), font(family))]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_fonts_are_truetype() {
        for (_, name, b) in BUNDLED {
            assert!(b.starts_with(&[0, 1, 0, 0]), "{name} is TrueType");
        }
        assert_eq!(family_name(ff::EXCALIFONT), "Excalifont");
        assert_eq!(family_name(ff::CASCADIA), "Cascadia");
    }
}
