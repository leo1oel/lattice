//! The names of a PDF's links that go to named destinations, which PDFium
//! resolves to their page and drops: hyperref's citation links go to
//! `cite.KEY` (biblatex's to `cite.REFSECTION@KEY`), and the Tauri app's
//! citation hover reads the key from that name, never from the visible
//! number (`pdfCitationForLink` in `src/pdf/pdf-citation-hover.tsx`).
//!
//! pdfium-render keeps a link's raw handles to itself, so the names are read
//! from the file with lopdf, a page's link annotations by their `/Rect`, off
//! the PDFium worker and only for a viewer that shows citations; the engine
//! pairs each with PDFium's link of the same rectangle.

use std::collections::HashMap;

use lopdf::{Dictionary, Document, Object};

/// A file larger than this is not read for names: a scan that size has no
/// citation links, and reading it twice would cost seconds.
const MAX_BYTES: usize = 64 * 1024 * 1024;

/// A link annotation's rectangle in PDF user space, `[left, bottom, right,
/// top]`, and the destination name it goes to.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct NamedLink {
    pub rect: [f32; 4],
    pub name: String,
}

/// Each page's named links (0-based pages), read from the file's bytes;
/// empty for a file that cannot be read or is too large, or that lopdf
/// panics on.
pub(super) fn read(bytes: &[u8]) -> HashMap<usize, Vec<NamedLink>> {
    if bytes.len() > MAX_BYTES {
        return HashMap::new();
    }
    std::panic::catch_unwind(|| read_pages(bytes)).unwrap_or_default()
}

fn read_pages(bytes: &[u8]) -> HashMap<usize, Vec<NamedLink>> {
    let Ok(document) = Document::load_mem(bytes) else {
        return HashMap::new();
    };
    let mut pages = HashMap::new();
    for (number, page) in document.get_pages() {
        let Ok(annotations) = document.get_page_annotations(page) else {
            continue;
        };
        let links: Vec<NamedLink> = annotations
            .into_iter()
            .filter_map(|annotation| named_link(&document, annotation))
            .collect();
        if !links.is_empty() {
            pages.insert(number as usize - 1, links);
        }
    }
    pages
}

fn named_link(document: &Document, annotation: &Dictionary) -> Option<NamedLink> {
    let subtype = annotation.get(b"Subtype").ok()?.as_name().ok()?;
    if subtype != b"Link" {
        return None;
    }
    let destination = match annotation.get(b"Dest") {
        Ok(destination) => destination,
        Err(_) => {
            let (_, action) = document.dereference(annotation.get(b"A").ok()?).ok()?;
            let action = action.as_dict().ok()?;
            if action.get(b"S").ok()?.as_name().ok()? != b"GoTo" {
                return None;
            }
            action.get(b"D").ok()?
        }
    };
    let (_, destination) = document.dereference(destination).ok()?;
    let name = match destination {
        Object::String(bytes, _) => decode(bytes),
        Object::Name(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        _ => return None,
    };
    let (_, rect) = document.dereference(annotation.get(b"Rect").ok()?).ok()?;
    let values: Vec<f32> = rect
        .as_array()
        .ok()?
        .iter()
        .filter_map(|value| {
            let (_, value) = document.dereference(value).ok()?;
            value.as_float().ok()
        })
        .collect();
    let [x0, y0, x1, y1] = values[..] else {
        return None;
    };
    Some(NamedLink {
        rect: [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)],
        name,
    })
}

/// A PDF text string: UTF-16 behind its byte-order mark, else (as hyperref
/// writes names) bytes read as Latin-1, which keeps ASCII as it is.
fn decode(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        let (pairs, _) = rest.as_chunks::<2>();
        let units: Vec<u16> = pairs.iter().map(|pair| u16::from_be_bytes(*pair)).collect();
        return String::from_utf16_lossy(&units);
    }
    bytes.iter().map(|&byte| byte as char).collect()
}

/// The citation key a destination name names: `cite.KEY`, or for biblatex
/// `cite.REFSECTION@KEY` (`pdfCitationForLink`); `None` for any other name.
pub fn citation_keys(name: &str) -> Option<(&str, Option<&str>)> {
    let key = name.strip_prefix("cite.")?;
    let bare = key
        .split_once('@')
        .filter(|(section, _)| !section.is_empty() && section.bytes().all(|b| b.is_ascii_digit()))
        .map(|(_, bare)| bare);
    (!key.is_empty()).then_some((key, bare))
}

/// Whether PDFium's link rectangle (user space) is the annotation `named`.
pub(super) fn same_rect(named: &[f32; 4], rect: [f32; 4]) -> bool {
    named.iter().zip(rect).all(|(a, b)| (a - b).abs() < 0.05)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    /// One page with three links: hyperref's `cite.knuth1984` through a
    /// GoTo action, a biblatex name as a direct `/Dest`, and a link to a web
    /// address, which names nothing; the catalog's name tree resolves both
    /// names.
    pub(crate) fn linked_pdf() -> Vec<u8> {
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R /Names << /Dests 7 0 R >> >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R 5 0 R 6 0 R] >>",
            "<< /Type /Annot /Subtype /Link /Rect [20 150 40 162] /A << /S /GoTo /D (cite.knuth1984) >> >>",
            "<< /Type /Annot /Subtype /Link /Rect [60 162 80 150] /Dest (cite.0@lamport1994) >>",
            "<< /Type /Annot /Subtype /Link /Rect [20 100 90 112] /A << /S /URI /URI (https://example.org) >> >>",
            // The name tree a citation's name resolves through, as hyperref
            // writes one; PDFium keeps only links whose destination resolves.
            "<< /Names [(cite.0@lamport1994) [3 0 R /XYZ 0 60 null] (cite.knuth1984) [3 0 R /XYZ 0 40 null]] >>",
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (ix, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend(format!("{} 0 obj\n{object}\nendobj\n", ix + 1).bytes());
        }
        let xref = pdf.len();
        pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
        for offset in offsets {
            pdf.extend(format!("{offset:010} 00000 n \n").bytes());
        }
        pdf.extend(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .bytes(),
        );
        pdf
    }

    #[test]
    fn a_pages_links_name_where_they_go() {
        let pages = read(&linked_pdf());
        assert_eq!(
            pages.get(&0),
            Some(&vec![
                NamedLink {
                    rect: [20., 150., 40., 162.],
                    name: "cite.knuth1984".into()
                },
                // The rectangle normalized, as PDFium gives it.
                NamedLink {
                    rect: [60., 150., 80., 162.],
                    name: "cite.0@lamport1994".into()
                },
            ])
        );
        assert!(read(b"not a pdf").is_empty());
    }

    #[test]
    fn citation_names_give_their_keys() {
        assert_eq!(citation_keys("cite.knuth1984"), Some(("knuth1984", None)));
        assert_eq!(
            citation_keys("cite.0@lamport1994"),
            Some(("0@lamport1994", Some("lamport1994")))
        );
        // A key with an @ that is not biblatex's section stays whole.
        assert_eq!(citation_keys("cite.a@b"), Some(("a@b", None)));
        assert_eq!(citation_keys("section.2"), None);
        assert_eq!(citation_keys("cite."), None);
        assert_eq!(decode(&[0xfe, 0xff, 0, b'c', 0, b'i']), "ci");
    }
}
