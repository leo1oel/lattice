//! Dark pages: the PDF read as light type on a dark page, one choice for
//! every PDF viewer in every window, off until the reader turns it on
//! (`src/pdf/pdf-dark-pages.ts`).
//!
//! The Tauri app draws the pages as PDF.js paints them and turns them dark
//! with a CSS filter on their canvases, `invert(0.86) hue-rotate(180deg)`
//! (`--pdf-dark-page-filter`): lightness flips and hue stays, so a red curve
//! stays red. Here the same two filter functions are applied to the bitmap
//! PDFium draws, in sRGB as CSS applies its shorthand filters, with the
//! matrices the Filter Effects spec gives them. Everything drawn over the
//! pages (the SyncTeX mark, search hits, the selection) keeps its own colour.

use std::sync::atomic::{AtomicBool, Ordering};

/// The page's ground before its bitmap is drawn: what the filter makes of
/// white (`--dark-page`).
pub const DARK_PAGE: u32 = 0x242424;
/// The SyncTeX mark on a dark page, which the light theme's accent would
/// sink into (`--dark-page-mark`).
pub const DARK_PAGE_MARK: u32 = 0xe7e7e4;

const INVERT: f32 = 0.86;

/// `hue-rotate(180deg)`: the spec's matrix with cos = −1, sin = 0. Each row
/// sums to 1, so a grey stays grey.
const HUE_ROTATE_180: [[f32; 3]; 3] = [
    [-0.574, 1.430, 0.144],
    [0.426, 0.430, 0.144],
    [0.426, 1.430, -0.856],
];

/// One pixel through the filter, channels from 0 to 1 in RGB order.
pub fn filter(rgb: [f32; 3]) -> [f32; 3] {
    // invert(a): a + c·(1 − 2a), per channel.
    let inverted = rgb.map(|c| INVERT + c * (1. - 2. * INVERT));
    HUE_ROTATE_180.map(|row| {
        (row[0] * inverted[0] + row[1] * inverted[1] + row[2] * inverted[2]).clamp(0., 1.)
    })
}

/// Turn a page bitmap dark in place. PDFium's bitmaps are BGRA, the order
/// GPUI uploads, and opaque: a page is drawn on its white ground.
pub fn darken_bgra(pixels: &mut [u8]) {
    // A table per output channel and input channel would be nine of 256
    // entries; the bitmap is a few million pixels at most, and plain float
    // arithmetic over it takes a few milliseconds on the PDFium thread.
    for pixel in pixels.as_chunks_mut::<4>().0 {
        let rgb = [pixel[2], pixel[1], pixel[0]].map(|c| f32::from(c) / 255.);
        let [r, g, b] = filter(rgb).map(|c| (c * 255.).round() as u8);
        pixel[0] = b;
        pixel[1] = g;
        pixel[2] = r;
    }
}

static DARK_PAGES: AtomicBool = AtomicBool::new(false);

/// Set when the reader turns dark pages on or off; every viewer observes it.
pub struct DarkPages;

impl gpui::Global for DarkPages {}

/// Whether pages are drawn dark, in every viewer.
pub fn enabled() -> bool {
    DARK_PAGES.load(Ordering::Relaxed)
}

pub(super) fn set_enabled(dark: bool) {
    DARK_PAGES.store(dark, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn byte(rgb: [f32; 3]) -> [u8; 3] {
        rgb.map(|c| (c * 255.).round() as u8)
    }

    #[test]
    fn white_paper_turns_the_dark_page_token() {
        let [r, g, b] = byte(filter([1., 1., 1.]));
        assert_eq!(u32::from_be_bytes([0, r, g, b]), DARK_PAGE);
    }

    #[test]
    fn black_type_turns_light_and_greys_stay_grey() {
        assert_eq!(byte(filter([0., 0., 0.])), [219, 219, 219]);
        let [r, g, b] = filter([0.4, 0.4, 0.4]);
        assert!((r - g).abs() < 1e-4 && (g - b).abs() < 1e-4);
    }

    #[test]
    fn a_red_curve_stays_red() {
        let [r, g, b] = filter([0.8, 0.1, 0.1]);
        assert!(r > g && r > b, "{r} {g} {b}");
    }

    #[test]
    fn bgra_bitmaps_keep_their_byte_order_and_alpha() {
        let mut pixels = [255, 255, 255, 255, 0, 0, 204, 255];
        darken_bgra(&mut pixels);
        assert_eq!(&pixels[..4], &[0x24, 0x24, 0x24, 255]);
        // Red (B=0, G=0, R=204) keeps red as its strongest channel.
        assert!(pixels[6] > pixels[4] && pixels[6] > pixels[5]);
        assert_eq!(pixels[7], 255);
    }
}
