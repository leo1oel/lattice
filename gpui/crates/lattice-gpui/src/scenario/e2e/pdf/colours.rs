//! The pages' colours, end to end: a swatch of known colour reaches the page
//! image GPUI uploads as drawn, light and dark, and Dark pages draws every
//! page dark and back.

use std::cell::Cell;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::{pdf::PdfView, scenario::Run};

/// Page 3's swatch, `\textcolor[RGB]{230,40,30}`.
const SWATCH: [u8; 3] = [230, 40, 30];

/// The swatch's RGB bytes in the page image, light or through the dark
/// pages' filter.
fn swatch_rgb(dark: bool) -> [u8; 3] {
    if !dark {
        return SWATCH;
    }
    crate::pdf::dark_filter(SWATCH.map(|c| f32::from(c) / 255.)).map(|c| (c * 255.).round() as u8)
}

/// Of `page`'s image, once drawn `dark` or not: the pixels in the swatch's
/// colour, and those in it with red and blue traded. A channel may be one
/// off, for the PDF's colour written to five decimals.
fn swatch_pixels(view: &PdfView, page: usize, dark: bool) -> Option<(usize, usize)> {
    let (image, drawn_dark) = view.page_image(page)?;
    if drawn_dark != dark {
        return None;
    }
    let [r, g, b] = swatch_rgb(dark);
    let near = |pixel: &[u8], want: [u8; 3]| {
        pixel
            .iter()
            .zip(want)
            .all(|(have, want)| have.abs_diff(want) <= 1)
    };
    let (mut matching, mut swapped) = (0, 0);
    for pixel in image.as_bytes(0)?.as_chunks::<4>().0 {
        // BGRA, the order GPUI uploads.
        if near(&pixel[..3], [b, g, r]) {
            matching += 1;
        } else if near(&pixel[..3], [r, g, b]) {
            swapped += 1;
        }
    }
    Some((matching, swapped))
}

impl Run {
    /// The swatch's colours, then Dark pages on and off.
    pub(super) async fn colours(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.page_colours(cx, steps).await?;
        self.dark_pages(cx, steps).await
    }

    /// Page 3's swatch reaches the page image GPUI uploads in its own colour,
    /// light and dark: BGRA bytes of sRGB (230, 40, 30), or of what the dark
    /// pages' filter makes of it, and none with red and blue traded (PDFium
    /// handing over RGBA once drew a red figure blue).
    async fn page_colours(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        const PAGE: usize = 2;
        self.with_view(cx, |view, _, cx| view.go_to_page(PAGE, cx))?;
        let mut seen = Vec::new();
        for dark in [false, true] {
            if dark {
                self.with_view(cx, |view, _, cx| view.toggle_dark_pages(cx))?;
            }
            let counted = Cell::new(None);
            self.wait_view(cx, 10, |view, _| {
                counted.set(swatch_pixels(view, PAGE, dark));
                counted.get().is_some_and(|(matching, _)| matching > 0)
            })
            .await;
            seen.push((dark, counted.get()));
        }
        self.with_view(cx, |view, _, cx| view.toggle_dark_pages(cx))?;
        self.wait_view(cx, 10, |view, _| {
            !view.dark_pages() && view.images_follow_dark_pages()
        })
        .await;
        // A 3 cm × 1 cm swatch holds well over a thousand device pixels at the
        // zoom the viewer opens at (1452 in a 1440 px window at 1x).
        let pass = seen.iter().all(|(_, counted)| {
            counted.is_some_and(|(matching, swapped)| matching > 400 && swapped == 0)
        });
        let detail: Vec<_> = seen
            .iter()
            .map(|(dark, counted)| {
                json!({
                    "dark": dark,
                    "expected_rgb": swatch_rgb(*dark),
                    "matching_pixels": counted.map(|(matching, _)| matching),
                    "red_blue_swapped_pixels": counted.map(|(_, swapped)| swapped),
                })
            })
            .collect();
        steps.check(
            "PDF: a page's colours reach the screen as drawn, light and dark (no red/blue swap)",
            pass,
            json!({ "samples": detail }),
        );
        Ok(())
    }

    async fn dark_pages(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_view(cx, |view, _, cx| view.toggle_dark_pages(cx))?;
        let dark = self
            .wait_view(cx, 10, |view, _| {
                view.dark_pages() && view.images_follow_dark_pages()
            })
            .await;
        self.with_view(cx, |view, _, cx| view.toggle_dark_pages(cx))?;
        let light = self
            .wait_view(cx, 10, |view, _| {
                !view.dark_pages() && view.images_follow_dark_pages()
            })
            .await;
        steps.check(
            "PDF: Dark pages draws the pages dark, and back",
            dark && light,
            json!({ "dark": dark, "light": light }),
        );
        Ok(())
    }
}
