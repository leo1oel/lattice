//! The Tauri app's `review-pdf.test.ts`, on PDFium-style per-character
//! boxes (`text::tests::page`: glyphs 5pt wide and 10pt tall, lines 14pt
//! apart from 100pt down).

use std::sync::Arc;

use lattice_core::project::{PdfAnchor, PdfRect};

use super::*;
use crate::pdf::{annotation_place::SyncBox, text::PageText, text::tests::page};

const SIZE: (f32, f32) = (612., 792.);

struct Pages {
    pages: Vec<Arc<PageText>>,
    sync: Option<SyncBox>,
}

impl MarkReader for Pages {
    fn page_count(&self) -> usize {
        self.pages.len()
    }
    fn page(&mut self, page: usize) -> Option<(Arc<PageText>, (f32, f32))> {
        Some((self.pages.get(page)?.clone(), SIZE))
    }
    fn sync(&mut self, _: u32, _: u32) -> Option<SyncBox> {
        self.sync
    }
}

fn reader(pages: &[&[&str]], sync: Option<SyncBox>) -> Pages {
    Pages {
        pages: pages.iter().map(|lines| Arc::new(page(lines))).collect(),
        sync,
    }
}

fn note(quote: &str, pdf: Option<PdfAnchor>) -> EditorComment {
    let mut comment: EditorComment = serde_json::from_value(serde_json::json!({
        "id": "a1", "number": 1, "path": "main.tex", "from": 0,
        "to": quote.encode_utf16().count(), "quote": quote, "body": "Tighten",
        "authorId": "me", "authorName": "Ada", "createdAt": "1", "updatedAt": "1"
    }))
    .unwrap();
    comment.pdf = pdf;
    comment
}

#[test]
fn highlights_a_pdf_selection_on_the_page_it_was_made() {
    let mut pages = reader(&[&["Intro."], &["Results beat the baseline."]], None);
    let anchor = PdfAnchor {
        page: 2,
        rects: vec![PdfRect {
            x: 0.1,
            y: 0.13,
            width: 0.3,
            height: 0.02,
        }],
        text: "beat the baseline".into(),
    };
    let placed = place_review(&note("beat the baseline", Some(anchor)), None, &mut pages);
    let ReviewPlacement::Highlight { page, quads } = placed else {
        panic!("{placed:?}");
    };
    assert_eq!(page, 1);
    // "beat the baseline" starts 8 glyphs in: x 72 + 40, and runs 17 glyphs.
    assert_eq!(quads.len(), 1);
    assert!((quads[0][0] - 112.).abs() < 0.5, "{quads:?}");
    assert!((quads[0][2] - (112. + 85.)).abs() < 0.5, "{quads:?}");
    // User space: the line's top (100pt down) is 692pt up, its foot below.
    assert!((quads[0][1] - 692.).abs() < 0.5, "{quads:?}");
    assert!(quads[0][5] < 692. - 10. + 0.5, "{quads:?}");
}

#[test]
fn looks_on_the_next_page_when_synctex_names_the_one_before() {
    let mut pages = reader(
        &[&["Intro."], &["Results beat the baseline."]],
        Some(SyncBox {
            page: 0,
            x: 72.,
            y: 92.,
            width: 300.,
            height: 10.,
        }),
    );
    let quote = "beat the baseline";
    let placed = place_review(&note(quote, None), Some(quote), &mut pages);
    assert!(
        matches!(placed, ReviewPlacement::Highlight { page: 1, .. }),
        "{placed:?}"
    );
}

#[test]
fn puts_a_note_in_the_margin_beside_synctex_line_when_the_words_are_not_there() {
    let mut pages = reader(
        &[&["α + β"]],
        Some(SyncBox {
            page: 0,
            x: 72.,
            y: 180.,
            width: 300.,
            height: 10.,
        }),
    );
    let quote = "$\\alpha + \\beta$";
    let placed = place_review(&note(quote, None), Some(quote), &mut pages);
    assert_eq!(
        placed,
        ReviewPlacement::Note {
            page: 0,
            x: 612. - 18. - 8.,
            y: 792. - 180.
        }
    );
}

#[test]
fn leaves_unplaced_a_note_synctex_cannot_find() {
    let mut pages = reader(&[&[]], None);
    let quote = "a lost passage";
    assert_eq!(
        place_review(&note(quote, None), Some(quote), &mut pages),
        ReviewPlacement::Unplaced
    );
}

#[test]
fn moves_a_note_that_would_cover_another_in_the_same_margin() {
    let placed = separate_notes(vec![
        ReviewPlacement::Note {
            page: 0,
            x: 586.,
            y: 700.,
        },
        ReviewPlacement::Note {
            page: 0,
            x: 586.,
            y: 705.,
        },
        ReviewPlacement::Note {
            page: 1,
            x: 586.,
            y: 700.,
        },
    ]);
    let ys: Vec<f64> = placed
        .iter()
        .map(|placement| match placement {
            ReviewPlacement::Note { y, .. } => *y,
            _ => f64::NAN,
        })
        .collect();
    assert_eq!(ys, vec![700., 678., 700.]);
}

#[test]
fn names_the_copy_after_the_pdf() {
    assert_eq!(review_file_name("paper.pdf"), "paper-review.pdf");
    assert_eq!(review_file_name("Thesis.PDF"), "Thesis-review.pdf");
    assert_eq!(review_file_name(".pdf"), "paper-review.pdf");
    assert_eq!(short_quote("  a\n  b "), "a b");
    assert_eq!(short_quote(&"x".repeat(90)).chars().count(), 80);
}

#[test]
fn places_through_synctex_a_pdf_note_whose_page_is_gone() {
    // Made on page 3; the rebuild has one page, where SyncTeX puts the line.
    let mut pages = reader(
        &[&["Results beat the baseline."]],
        Some(SyncBox {
            page: 0,
            x: 72.,
            y: 92.,
            width: 300.,
            height: 10.,
        }),
    );
    let anchor = PdfAnchor {
        page: 3,
        rects: Vec::new(),
        text: "beat the baseline".into(),
    };
    let quote = "beat the baseline";
    let placed = place_review(&note(quote, Some(anchor)), Some(quote), &mut pages);
    assert!(
        matches!(placed, ReviewPlacement::Highlight { page: 0, .. }),
        "{placed:?}"
    );
}
