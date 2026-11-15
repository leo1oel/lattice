//! Where each annotation goes in a review copy of the compiled PDF, as the
//! Tauri app's `review-pdf.ts` places it for `save_review_pdf`
//! (lattice-core's `review_pdf.rs`), measured on the PDF on screen. The
//! words the annotation quotes are looked for on its page (the page it was
//! made on, or the one SyncTeX gives for its source line) and on the pages
//! either side, compared as letters alone (`annotation_place.rs`). Found,
//! they become a highlight over exactly those words; not found (a formula, a
//! passage edited since the build), the note becomes a sticky note in the
//! page's right margin beside where SyncTeX or the original selection put
//! it. A note with neither is reported unplaced, never pinned to some other
//! place that happens to read the same.
//!
//! Positions here are PDF user space: points from the page's bottom-left
//! corner, as the review copy's annotations take them.

use lattice_core::project::EditorComment;

use super::annotation_place::{
    Band, MarkReader, find_bands, line_and_column, pdf_text_letters, quote_letters,
};
use crate::annotations::model;

/// A sticky note's icon is this square (`NOTE_SIZE` in review_pdf.rs), kept
/// this far inside the page.
pub const NOTE_SIZE: f64 = 18.;
const NOTE_INSET: f64 = 8.;

/// Upper-left, upper-right, lower-left and lower-right corners.
pub type Quad = [f64; 8];

#[derive(Clone, Debug, PartialEq)]
pub enum ReviewPlacement {
    /// Over the note's words on `page` (0-based), one quad per line.
    Highlight {
        page: usize,
        quads: Vec<Quad>,
    },
    /// A sticky note whose icon's top-left corner is at `x`, `y`.
    Note {
        page: usize,
        x: f64,
        y: f64,
    },
    Unplaced,
}

impl ReviewPlacement {
    pub fn page(&self) -> Option<usize> {
        match self {
            Self::Highlight { page, .. } | Self::Note { page, .. } => Some(*page),
            Self::Unplaced => None,
        }
    }
}

/// The quads over `bands` (fractions of a page `size` points, from its
/// top-left corner).
fn quads_of(bands: &[Band], (width, height): (f32, f32)) -> Vec<Quad> {
    let (width, height) = (f64::from(width), f64::from(height));
    bands
        .iter()
        .map(|band| {
            let left = f64::from(band.x) * width;
            let right = f64::from(band.x + band.width) * width;
            let top = height - f64::from(band.y) * height;
            let bottom = height - f64::from(band.y + band.height) * height;
            [left, top, right, top, left, bottom, right, bottom]
        })
        .collect()
}

/// The page's right margin, where a sticky note's icon stands, at `top`
/// (user space) kept on the page.
fn margin_note(page: usize, (width, height): (f32, f32), top: f64) -> ReviewPlacement {
    let (width, height) = (f64::from(width), f64::from(height));
    ReviewPlacement::Note {
        page,
        x: (width - NOTE_SIZE - NOTE_INSET).max(0.),
        y: (height - NOTE_INSET).min(top.max(NOTE_SIZE + NOTE_INSET)),
    }
}

/// Where `note` goes on the PDF `reader` reads; `source` is its .tex file's
/// text, for a note made there (`placeAnnotation`).
pub fn place_review(
    note: &EditorComment,
    source: Option<&str>,
    reader: &mut impl MarkReader,
) -> ReviewPlacement {
    let count = reader.page_count();
    let anchor = note
        .pdf
        .as_ref()
        .filter(|anchor| anchor.page >= 1 && (anchor.page as usize) <= count);
    // Where on its page it was: the selection's first line, or SyncTeX's box.
    let (home, top_from_page_top) = match anchor {
        Some(anchor) => (anchor.page as usize - 1, None),
        None => {
            let Some(sync) = source
                .and_then(|text| {
                    let range = model::anchor_of(text, note)?;
                    let (line, column) = line_and_column(text, range.start);
                    reader.sync(line, column)
                })
                .filter(|sync| sync.page < count)
            else {
                return ReviewPlacement::Unplaced;
            };
            (sync.page, Some(sync.y))
        }
    };
    let Some((home_text, home_size)) = reader.page(home) else {
        return ReviewPlacement::Unplaced;
    };
    let from_top = top_from_page_top.unwrap_or_else(|| {
        anchor
            .and_then(|anchor| anchor.rects.first())
            .map_or(0., |rect| rect.y as f32 * home_size.1)
    });
    let top = f64::from(home_size.1 - from_top);
    let mut pages = vec![home, home + 1];
    if home > 0 {
        pages.push(home - 1);
    }
    for page in pages.into_iter().filter(|page| *page < count) {
        let Some((text, size)) = (if page == home {
            Some((home_text.clone(), home_size))
        } else {
            reader.page(page)
        }) else {
            continue;
        };
        let near = (page == home).then_some(from_top);
        let bands = find_bands(&text, size, &quote_letters(&note.quote), near).or_else(|| {
            anchor.and_then(|anchor| find_bands(&text, size, &pdf_text_letters(&anchor.text), near))
        });
        if let Some(bands) = bands {
            return ReviewPlacement::Highlight {
                page,
                quads: quads_of(&bands, size),
            };
        }
    }
    margin_note(home, home_size, top)
}

/// Sticky notes that would stand on one another in a page's margin, moved
/// down (or up, near the page's foot) until each has its own place
/// (`separateNotes`); `bottoms` is each page's lowest user-space y.
pub fn separate_notes(placements: Vec<ReviewPlacement>) -> Vec<ReviewPlacement> {
    let mut taken: std::collections::HashMap<usize, Vec<f64>> = Default::default();
    let step = NOTE_SIZE + 4.;
    placements
        .into_iter()
        .map(|placement| {
            let ReviewPlacement::Note { page, x, y } = placement else {
                return placement;
            };
            let used = taken.entry(page).or_default();
            let bottom = NOTE_SIZE + NOTE_INSET;
            let clear = |direction: f64, used: &[f64]| {
                let mut y = y;
                while let Some(other) = used.iter().find(|other| (**other - y).abs() < step) {
                    y = other + direction * step;
                }
                y
            };
            let mut placed = clear(-1., used);
            if placed < bottom {
                placed = clear(1., used);
            }
            used.push(placed);
            ReviewPlacement::Note { page, x, y: placed }
        })
        .collect()
}

/// `paper.pdf` → `paper-review.pdf`.
pub fn review_file_name(file_name: &str) -> String {
    let stem = file_name
        .strip_suffix(".pdf")
        .or_else(|| file_name.strip_suffix(".PDF"))
        .unwrap_or(file_name);
    let stem = if stem.is_empty() { "paper" } else { stem };
    format!("{stem}-review.pdf")
}

/// A quote cut to 80 characters on one line.
pub fn short_quote(quote: &str) -> String {
    let flat = quote.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 80 {
        let cut: String = flat.chars().take(79).collect();
        format!("{cut}…")
    } else {
        flat
    }
}

#[cfg(test)]
mod tests;
