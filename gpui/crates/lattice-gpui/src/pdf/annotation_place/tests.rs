//! Oracles: `pdf-annotation-place.ts`, `review-pdf.ts` and
//! `pdf-source-anchor.ts` in the Tauri app, and their tests.

use super::*;

/// A page 600 × 800 points; each line of `lines` set at its (x, y) top-left,
/// 5 points a character and 10 tall, a space between words.
fn page(lines: &[(f32, f32, &str)]) -> PageText {
    let mut chars = Vec::new();
    for (x, y, text) in lines {
        for (ix, ch) in text.chars().enumerate() {
            let x0 = x + ix as f32 * 5.;
            chars.push(TextChar {
                ch,
                x0,
                y0: *y,
                x1: x0 + 5.,
                y1: y + 10.,
                generated: false,
            });
        }
    }
    PageText {
        chars,
        links: Vec::new(),
    }
}

const SIZE: (f32, f32) = (600., 800.);

#[test]
fn letters_fold_ligatures_and_accents_and_case() {
    assert_eq!(fold_letters('ﬁ'), "fi");
    assert_eq!(fold_letters('É'), "e");
    assert_eq!(fold_letters(','), "");
    assert_eq!(
        source_letters(r"A \emph{bold} claim % not this"),
        "aboldclaim"
    );
    assert_eq!(source_letters(r"85\% sure"), "85sure");
    // A citation's key prints as a number: the quote splits around it.
    assert_eq!(
        quote_letters(r"as shown in \cite{vaswani} before"),
        vec!["asshownin", "before"]
    );
}

#[test]
fn a_quote_is_banded_line_by_line_over_its_own_words() {
    let text = page(&[
        (100., 100., "The first line holds a sentence that"),
        (100., 112., "runs onto the second line here."),
    ]);
    let bands = find_bands(&text, SIZE, &quote_letters("sentence that runs onto"), None).unwrap();
    assert_eq!(bands.len(), 2, "{bands:?}");
    // "sentence" starts at character 23 of the first line.
    assert_eq!(bands[0].x, round((100. + 23. * 5.) / 600.));
    assert_eq!(bands[0].y, round(100. / 800.));
    // Past the descenders: a tenth of the line below its box.
    assert_eq!(bands[0].height, round(11. / 800.));
    assert_eq!(bands[1].x, round(100. / 600.));
    // "runs onto" ends at character 9 of the second line.
    assert_eq!(bands[1].width, round(9. * 5. / 600.));
    assert!(find_bands(&text, SIZE, &quote_letters("not on this page at all"), None).is_none());
    assert!(
        find_bands(&text, SIZE, &quote_letters("the"), None).is_none(),
        "too few letters"
    );
}

#[test]
fn of_two_places_the_one_nearest_its_line_is_taken() {
    let text = page(&[
        (100., 100., "repeated words"),
        (100., 400., "repeated words"),
    ]);
    let near = find_bands(&text, SIZE, &quote_letters("repeated words"), Some(395.)).unwrap();
    assert_eq!(near[0].y, round(400. / 800.));
    let first = find_bands(&text, SIZE, &quote_letters("repeated words"), None).unwrap();
    assert_eq!(first[0].y, round(100. / 800.));
}

#[test]
fn a_pin_stands_beside_the_column_its_passage_starts_in() {
    // Two columns: a gutter between 280 and 320.
    let text = page(&[
        (60., 100., "left column words here"),
        (320., 100., "right column words here"),
        (60., 112., "more left column text"),
    ]);
    let left = find_bands(&text, SIZE, &quote_letters("column words"), Some(100.)).unwrap();
    let mark = mark_of(0, &text, SIZE, left).unwrap();
    assert_eq!(mark.pin.side, Side::Start);
    assert_eq!(mark.pin.x, round(60. / 600.));
    let right = find_bands(&text, SIZE, &quote_letters("right column"), None).unwrap();
    let mark = mark_of(0, &text, SIZE, right).unwrap();
    assert_eq!(mark.pin.side, Side::End);
    // The right column's right edge: "right column words here" is 23 characters.
    assert_eq!(mark.pin.x, round((320. + 23. * 5.) / 600.));
    // One column across the middle: the pin stands at its left edge.
    let wide = page(&[(
        60.,
        100.,
        "a single column line that runs right across the middle of it all",
    )]);
    let bands = find_bands(&wide, SIZE, &quote_letters("across the middle"), None).unwrap();
    let mark = mark_of(0, &wide, SIZE, bands).unwrap();
    assert_eq!(
        (mark.pin.side, mark.pin.x),
        (Side::Start, round(60. / 600.))
    );
}

#[test]
fn a_pdf_note_falls_back_to_its_selection_then_its_saved_boxes() {
    let text = page(&[(100., 100., "E = mc2 in the text")]);
    let saved = [Band {
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.02,
    }];
    // The quote is a formula's source, all commands, which reads no letters
    // on the page; the selection's words do.
    let mark = place_pdf_mark(0, &text, SIZE, r"$\alpha + \beta$", "mc2 in the", &saved).unwrap();
    assert_eq!(mark.bands[0].x, round((100. + 4. * 5.) / 600.));
    let mark = place_pdf_mark(0, &text, SIZE, r"\frac{a}{b}", "x", &saved).unwrap();
    assert_eq!(mark.bands, saved.to_vec());
    assert!(place_pdf_mark(0, &text, SIZE, "", "", &[]).is_none());
}

struct Reader {
    pages: Vec<std::sync::Arc<PageText>>,
    boxes: std::collections::HashMap<u32, SyncBox>,
}

impl MarkReader for Reader {
    fn page_count(&self) -> usize {
        self.pages.len()
    }
    fn page(&mut self, page: usize) -> Option<(std::sync::Arc<PageText>, (f32, f32))> {
        self.pages.get(page).map(|text| (text.clone(), SIZE))
    }
    fn sync(&mut self, line: u32, _: u32) -> Option<SyncBox> {
        self.boxes.get(&line).copied()
    }
}

fn sync_box(page: usize, y: f32) -> SyncBox {
    SyncBox {
        page,
        x: 100.,
        y,
        width: 200.,
        height: 10.,
    }
}

#[test]
fn a_source_note_is_drawn_over_its_words_where_synctex_puts_its_line() {
    let source = "Intro line.\nThe passage we noted here.\nMore.\n";
    let from = source.find("passage").unwrap();
    let to = from + "passage we noted".len();
    let mut reader = Reader {
        pages: vec![
            std::sync::Arc::new(page(&[(100., 100., "Intro line.")])),
            // The words broke onto the next page.
            std::sync::Arc::new(page(&[(100., 300., "The passage we noted here.")])),
        ],
        boxes: [(2, sync_box(0, 120.))].into(),
    };
    let mark = place_source_mark("passage we noted", source, from..to, true, &mut reader).unwrap();
    assert_eq!(mark.page, 1, "found on the page after SyncTeX's");
    assert_eq!(mark.bands[0].y, round(300. / 800.));
}

#[test]
fn a_formula_note_falls_back_to_its_line_boxes_only_while_its_lines_are_as_built() {
    let source = "Before.\n$\\alpha$\n$\\beta$\nAfter.\n";
    let from = source.find('$').unwrap();
    let to = source.rfind('$').unwrap() + 1;
    let mut reader = Reader {
        pages: vec![std::sync::Arc::new(page(&[(100., 100., "Before.")]))],
        boxes: [(2, sync_box(0, 140.)), (3, sync_box(0, 160.))].into(),
    };
    let mark = place_source_mark(&source[from..to], source, from..to, true, &mut reader).unwrap();
    assert_eq!(mark.bands.len(), 2);
    assert_eq!(mark.bands[0].y, round(140. / 800.));
    assert!(place_source_mark(&source[from..to], source, from..to, false, &mut reader).is_none());
    // Edited above the note since the build: its lines are not the built ones.
    assert!(!lines_as_built(source, Some("Changed.\n$\\alpha$"), to));
    assert!(lines_as_built(source, Some(source), to));
    // "cdé " before byte 8: four UTF-16 units, so column 5.
    assert_eq!(line_and_column("ab\ncdé f", 8), (2, 5));
}
