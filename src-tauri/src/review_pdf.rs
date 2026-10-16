//! A review copy of the compiled PDF: the writer's chosen annotations written
//! into it as standard PDF annotations, so a collaborator who reads it in
//! Preview, Acrobat or Zotero sees each note where it applies. Text the note
//! is about becomes a Highlight with the note as its comment; a note whose
//! words could not be found on the page becomes a sticky note beside them.
//!
//! The copy is the compiled PDF's own bytes with one incremental update
//! appended (new annotation objects, and the pages they sit on with their
//! `/Annots` extended), so the typeset pages are exactly the ones the writer
//! built. The frontend measures where each note goes against the same bytes:
//! `digest` is their SHA-256, and a PDF rebuilt in between is refused rather
//! than annotated at positions measured on another layout.

use lopdf::{dictionary, IncrementalDocument, Object, ObjectId, Stream, StringFormat};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The highlight's ink, close to the amber the preview draws annotations in.
const HIGHLIGHT_COLOUR: [f32; 3] = [1.0, 0.78, 0.25];
/// A sticky note's icon is this square, in PDF points.
const NOTE_SIZE: f64 = 18.0;
/// Where a comment's popup opens, beside its mark, when a reader opens it.
const POPUP_WIDTH: f64 = 220.0;
const POPUP_HEIGHT: f64 = 120.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ReviewMark {
    /// Text on the page, as quadrilaterals in PDF user space: x1 y1 x2 y2 x3
    /// y3 x4 y4 for its upper-left, upper-right, lower-left and lower-right
    /// corners, the order every reader takes.
    Highlight { quads: Vec<[f64; 8]> },
    /// A sticky note whose icon's top-left corner is at `x`, `y`.
    Note { x: f64, y: f64 },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewNote {
    /// Kept in the annotation's `/NM`, so a reader's copy can be matched back
    /// to the Lattice annotation it came from.
    pub id: String,
    /// 1-based.
    pub page: u32,
    #[serde(flatten)]
    pub mark: ReviewMark,
    pub contents: String,
    pub author: String,
    /// RFC 3339.
    pub created: String,
    pub modified: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPdf {
    pub digest: String,
    pub notes: Vec<ReviewNote>,
}

pub const PDF_CHANGED: &str = "The PDF was rebuilt while you were exporting. Export again.";

/// `bytes` with `review`'s notes added; refused if they are not the PDF the
/// notes were placed on.
pub fn annotate(bytes: Vec<u8>, review: &ReviewPdf) -> Result<Vec<u8>, String> {
    let digest =
        Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    if !digest.eq_ignore_ascii_case(&review.digest) {
        return Err(PDF_CHANGED.to_string());
    }
    let unreadable = |error: lopdf::Error| format!("The compiled PDF could not be read: {error}");
    let mut document = IncrementalDocument::load_from(bytes.as_slice()).map_err(unreadable)?;
    if document.get_prev_documents().is_encrypted() {
        return Err("An encrypted PDF cannot be annotated.".to_string());
    }
    let pages = document.get_prev_documents().get_pages();
    for note in &review.notes {
        let page_id =
            *pages.get(&note.page).ok_or_else(|| format!("The PDF has no page {}.", note.page))?;
        let annotation = add_note(&mut document, page_id, note);
        append_annotation(&mut document, page_id, annotation).map_err(unreadable)?;
    }
    let mut output = Vec::with_capacity(review.notes.len() * 1024);
    document
        .save_to(&mut output)
        .map_err(|error| format!("The review PDF could not be written: {error}"))?;
    Ok(output)
}

/// Add `note`'s annotation and its popup; returns the annotation.
fn add_note(document: &mut IncrementalDocument, page_id: ObjectId, note: &ReviewNote) -> ObjectId {
    let new = &mut document.new_document;
    let [r, g, b] = HIGHLIGHT_COLOUR;
    let mut annotation = dictionary! {
        "Type" => "Annot",
        "P" => page_id,
        "F" => 4,
        "C" => vec![r.into(), g.into(), b.into()],
        "Contents" => text_string(&note.contents),
        "T" => text_string(&note.author),
        "NM" => text_string(&format!("lattice-annotation-{}", note.id)),
        "CreationDate" => pdf_date(&note.created),
        "M" => pdf_date(&note.modified),
    };
    let rect = match &note.mark {
        ReviewMark::Highlight { quads } => {
            let rect = bounds(quads);
            annotation.set("Subtype", "Highlight");
            annotation.set("Rect", rect_object(rect));
            annotation.set(
                "QuadPoints",
                quads.iter().flatten().map(|value| Object::Real(*value as f32)).collect::<Vec<_>>(),
            );
            annotation.set("CA", 1);
            let appearance = new.add_object(highlight_appearance(rect, quads));
            annotation.set("AP", dictionary! { "N" => appearance });
            rect
        }
        ReviewMark::Note { x, y } => {
            let rect = [*x, y - NOTE_SIZE, x + NOTE_SIZE, *y];
            annotation.set("Subtype", "Text");
            annotation.set("Name", "Comment");
            annotation.set("Open", false);
            annotation.set("Rect", rect_object(rect));
            rect
        }
    };
    let annotation_id = new.add_object(annotation);
    let popup = new.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "Parent" => annotation_id,
        "Open" => false,
        "Rect" => rect_object([rect[2], rect[3] - POPUP_HEIGHT, rect[2] + POPUP_WIDTH, rect[3]]),
    });
    if let Ok(Object::Dictionary(annotation)) = new.get_object_mut(annotation_id) {
        annotation.set("Popup", popup);
    }
    annotation_id
}

/// The highlight as readers that draw an annotation's own appearance show
/// it (Preview does): its quads filled with the ink, multiplied over the
/// text so the words stay legible.
fn highlight_appearance(rect: [f64; 4], quads: &[[f64; 8]]) -> Stream {
    let [r, g, b] = HIGHLIGHT_COLOUR;
    let mut content = format!("/GS0 gs {r} {g} {b} rg\n");
    for quad in quads {
        let [x1, y1, x2, y2, x3, y3, x4, y4] = quad.map(|value| format!("{value:.2}"));
        content.push_str(&format!("{x1} {y1} m {x2} {y2} l {x4} {y4} l {x3} {y3} l h f\n"));
    }
    Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => rect_object(rect),
            "Resources" => dictionary! {
                "ExtGState" => dictionary! {
                    "GS0" => dictionary! { "Type" => "ExtGState", "BM" => "Multiply", "CA" => 1, "ca" => 1 },
                },
            },
        },
        content.into_bytes(),
    )
}

/// Add `annotation` to the page's `/Annots`, an array kept inline or as its
/// own object (hyperref's links are either), copied into the update first.
fn append_annotation(
    document: &mut IncrementalDocument, page_id: ObjectId, annotation: ObjectId,
) -> lopdf::Result<()> {
    document.opt_clone_object_to_new_document(page_id)?;
    let shared = match document.new_document.get_dictionary(page_id)?.get(b"Annots") {
        Ok(Object::Reference(id)) => Some(*id),
        _ => None,
    };
    if let Some(array_id) = shared {
        document.opt_clone_object_to_new_document(array_id)?;
        if let Object::Array(items) = document.new_document.get_object_mut(array_id)? {
            items.push(annotation.into());
            return Ok(());
        }
    }
    let page = document.new_document.get_dictionary_mut(page_id)?;
    match page.get_mut(b"Annots") {
        Ok(Object::Array(items)) => items.push(annotation.into()),
        _ => page.set("Annots", vec![annotation.into()]),
    }
    Ok(())
}

fn bounds(quads: &[[f64; 8]]) -> [f64; 4] {
    let mut rect = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for quad in quads {
        for point in quad.chunks(2) {
            rect[0] = rect[0].min(point[0]);
            rect[1] = rect[1].min(point[1]);
            rect[2] = rect[2].max(point[0]);
            rect[3] = rect[3].max(point[1]);
        }
    }
    if rect[0].is_finite() {
        rect
    } else {
        [0.0; 4]
    }
}

fn rect_object(rect: [f64; 4]) -> Object {
    rect.iter().map(|value| Object::Real(*value as f32)).collect::<Vec<_>>().into()
}

/// A PDF text string: plain bytes for ASCII, else UTF-16BE behind its BOM,
/// which every reader decodes (PDFDocEncoding covers too little for notes).
fn text_string(text: &str) -> Object {
    if text.is_ascii() {
        return Object::String(text.as_bytes().to_vec(), StringFormat::Literal);
    }
    let mut bytes = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

/// `D:YYYYMMDDHHmmSSZ`, the date format annotations carry, from RFC 3339;
/// a date that does not parse is left out of the string rather than guessed.
fn pdf_date(rfc3339: &str) -> Object {
    let formatted = chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|date| date.with_timezone(&chrono::Utc).format("D:%Y%m%d%H%M%SZ").to_string())
        .unwrap_or_default();
    Object::String(formatted.into_bytes(), StringFormat::Literal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};
    use lopdf::{Dictionary, Document};

    /// A two-page PDF with a link annotation on page 1, written with an
    /// xref stream and object streams as pdfTeX does.
    fn sample_pdf() -> Vec<u8> {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        let mut kids = Vec::new();
        for page in 0..2 {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec!["F1".into(), 12.into()]),
                    Operation::new("Td", vec![72.into(), 700.into()]),
                    Operation::new("Tj", vec![Object::string_literal(format!("Page {page}"))]),
                    Operation::new("ET", vec![]),
                ],
            };
            let content_id =
                document.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            let mut page_dict = dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
            };
            if page == 0 {
                let link = document.add_object(dictionary! {
                    "Type" => "Annot", "Subtype" => "Link", "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                });
                page_dict.set("Annots", vec![link.into()]);
            }
            kids.push(document.add_object(page_dict).into());
        }
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => 2,
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            }),
        );
        let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        document.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        document
            .save_with_options(
                &mut bytes,
                lopdf::SaveOptions::builder()
                    .use_object_streams(true)
                    .use_xref_streams(true)
                    .build(),
            )
            .unwrap();
        bytes
    }

    fn digest(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn note(page: u32, mark: ReviewMark, contents: &str) -> ReviewNote {
        ReviewNote {
            id: format!("a{page}"),
            page,
            mark,
            contents: contents.to_string(),
            author: "Ada".to_string(),
            created: "2026-10-16T08:30:00Z".to_string(),
            modified: "2026-10-16T09:00:00+08:00".to_string(),
        }
    }

    fn annotations(document: &Document, page: u32) -> Vec<Dictionary> {
        let page_id = document.get_pages()[&page];
        document.get_page_annotations(page_id).unwrap().into_iter().cloned().collect()
    }

    #[test]
    fn appends_highlights_and_notes_after_the_original_bytes() {
        let original = sample_pdf();
        let review = ReviewPdf {
            digest: digest(&original),
            notes: vec![
                note(
                    1,
                    ReviewMark::Highlight {
                        quads: vec![[72.0, 712.0, 140.0, 712.0, 72.0, 698.0, 140.0, 698.0]],
                    },
                    "Tighten this — 太长",
                ),
                note(2, ReviewMark::Note { x: 580.0, y: 700.0 }, "On “Page 1”: cite it"),
            ],
        };
        let annotated = annotate(original.clone(), &review).unwrap();
        assert!(annotated.starts_with(&original), "the typeset pages keep their exact bytes");

        let document = Document::load_mem(&annotated).unwrap();
        let first = annotations(&document, 1);
        assert_eq!(first.len(), 2, "the existing link stays beside the highlight");
        let highlight = first
            .iter()
            .find(|annotation| {
                annotation.get(b"Subtype").unwrap().as_name().unwrap() == b"Highlight"
            })
            .unwrap();
        assert_eq!(highlight.get(b"QuadPoints").unwrap().as_array().unwrap().len(), 8);
        let contents = highlight.get(b"Contents").unwrap().as_str().unwrap();
        assert_eq!(&contents[..2], &[0xFE, 0xFF], "non-ASCII notes are UTF-16BE");
        assert_eq!(highlight.get(b"T").unwrap().as_str().unwrap(), b"Ada");
        assert_eq!(highlight.get(b"NM").unwrap().as_str().unwrap(), b"lattice-annotation-a1");
        assert_eq!(highlight.get(b"M").unwrap().as_str().unwrap(), b"D:20261016010000Z");
        assert!(highlight.get(b"AP").is_ok() && highlight.get(b"Popup").is_ok());

        let second = annotations(&document, 2);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].get(b"Subtype").unwrap().as_name().unwrap(), b"Text");
        let rect: Vec<f32> = second[0]
            .get(b"Rect")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_float().unwrap())
            .collect();
        assert_eq!(rect, vec![580.0, 682.0, 598.0, 700.0]);
    }

    #[test]
    fn refuses_a_pdf_rebuilt_since_the_notes_were_placed() {
        let original = sample_pdf();
        let review = ReviewPdf { digest: digest(b"another build"), notes: vec![] };
        assert_eq!(annotate(original, &review).unwrap_err(), PDF_CHANGED);
    }

    #[test]
    fn refuses_a_page_the_pdf_does_not_have() {
        let original = sample_pdf();
        let review = ReviewPdf {
            digest: digest(&original),
            notes: vec![note(3, ReviewMark::Note { x: 0.0, y: 0.0 }, "x")],
        };
        assert_eq!(annotate(original, &review).unwrap_err(), "The PDF has no page 3.");
    }
}
