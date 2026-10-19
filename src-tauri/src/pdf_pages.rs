//! Which pages of a rebuilt PDF draw differently from the last build's, so the
//! preview redraws only those and keeps the rest of what is on screen.
//!
//! Each page's signature is a digest of everything PDF.js draws it from: the
//! page dictionary with every object it reaches (content streams, fonts with
//! their embedded programs, images, annotations), including what it inherits
//! from the page tree. Object numbers are left out — a rebuild renumbers
//! objects freely — and a reference to a page counts as that page's index,
//! which is what a link to it means. Two builds that give a page the same
//! signature draw it identically.
//!
//! The document signature covers what the viewer shows for the whole file:
//! the page count, outline, page labels, optional content, forms and the
//! structure tree. Named destinations are left out on purpose: a link names
//! its target and the viewer looks it up in whichever document it shows, so a
//! heading moving down a page changes no unrelated page.

use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct PageSignatures {
    pub document: String,
    pub pages: Vec<String>,
}

/// Page attributes a page may inherit from its ancestors in the page tree.
const INHERITED: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];
/// Catalog entries the viewer shows for the whole document.
const DOCUMENT_WIDE: [&[u8]; 5] =
    [b"Outlines", b"PageLabels", b"OCProperties", b"AcroForm", b"StructTreeRoot"];

pub fn signatures(bytes: &[u8]) -> Result<PageSignatures, String> {
    let document = Document::load_mem(bytes)
        .map_err(|error| format!("The PDF could not be read for its pages: {error}"))?;
    let page_ids = document.get_pages();
    let mut digests = Digests {
        document: &document,
        pages: page_ids.values().enumerate().map(|(index, id)| (*id, index)).collect(),
        memo: HashMap::new(),
        visiting: HashSet::new(),
    };
    let pages = page_ids.values().map(|id| hex(&digests.page(*id))).collect::<Vec<_>>();

    let mut whole = Sha256::new();
    whole.update((pages.len() as u64).to_le_bytes());
    if let Ok(catalog) = document.catalog() {
        for key in DOCUMENT_WIDE {
            whole.update(key);
            match catalog.get(key) {
                Ok(value) => digests.write(value, &mut whole),
                Err(_) => whole.update(b"-"),
            }
        }
    }
    Ok(PageSignatures { document: hex(&whole.finalize()), pages })
}

/// Half a SHA-256 digest is plenty to tell one build's page from another's.
fn hex(digest: &[u8]) -> String {
    digest[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

struct Digests<'a> {
    document: &'a Document,
    /// Each page object's index, written in place of a reference to it.
    pages: HashMap<ObjectId, usize>,
    /// Objects are shared (a font by every page that uses it): hash each once.
    memo: HashMap<ObjectId, [u8; 32]>,
    /// The outline and a few other structures link back to their parents.
    visiting: HashSet<ObjectId>,
}

impl<'a> Digests<'a> {
    fn page(&mut self, id: ObjectId) -> [u8; 32] {
        let mut out = Sha256::new();
        let document = self.document;
        let Ok(Object::Dictionary(page)) = document.get_object(id) else {
            return out.finalize().into();
        };
        self.dictionary(page, &mut out);
        for key in INHERITED {
            if page.has(key) {
                continue;
            }
            if let Some(value) = self.inherited(page, key) {
                out.update(key);
                self.write(value, &mut out);
            }
        }
        out.finalize().into()
    }

    fn inherited(&self, page: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
        let document = self.document;
        let mut node = page;
        // A malformed tree could loop; no real one is this deep.
        for _ in 0..64 {
            let parent = node.get(b"Parent").ok()?.as_reference().ok()?;
            node = document.get_object(parent).ok()?.as_dict().ok()?;
            if let Ok(value) = node.get(key) {
                return Some(value);
            }
        }
        None
    }

    fn object(&mut self, id: ObjectId) -> [u8; 32] {
        if let Some(digest) = self.memo.get(&id) {
            return *digest;
        }
        if !self.visiting.insert(id) {
            return [0; 32];
        }
        let mut out = Sha256::new();
        let document = self.document;
        match document.get_object(id) {
            Ok(object) => self.write(object, &mut out),
            Err(_) => out.update(b"missing"),
        }
        let digest: [u8; 32] = out.finalize().into();
        self.visiting.remove(&id);
        self.memo.insert(id, digest);
        digest
    }

    fn dictionary(&mut self, dictionary: &Dictionary, out: &mut Sha256) {
        let mut entries: Vec<_> = dictionary.iter().collect();
        entries.sort_by_key(|(key, _)| *key);
        out.update(b"<<");
        out.update((entries.len() as u64).to_le_bytes());
        for (key, value) in entries {
            // The page tree's back link: its other pages are not this page.
            if key.as_slice() == b"Parent" {
                continue;
            }
            bytes(key, out);
            self.write(value, out);
        }
    }

    fn write(&mut self, object: &Object, out: &mut Sha256) {
        match object {
            Object::Null => out.update(b"n"),
            Object::Boolean(value) => out.update(if *value { b"t" } else { b"f" }),
            Object::Integer(value) => {
                out.update(b"i");
                out.update(value.to_le_bytes());
            }
            Object::Real(value) => {
                out.update(b"r");
                out.update(value.to_le_bytes());
            }
            Object::Name(name) => {
                out.update(b"/");
                bytes(name, out);
            }
            Object::String(text, _) => {
                out.update(b"(");
                bytes(text, out);
            }
            Object::Array(items) => {
                out.update(b"[");
                out.update((items.len() as u64).to_le_bytes());
                for item in items {
                    self.write(item, out);
                }
            }
            Object::Dictionary(dictionary) => self.dictionary(dictionary, out),
            // The encoded bytes: the same content compressed the same way.
            Object::Stream(stream) => {
                out.update(b"stream");
                self.dictionary(&stream.dict, out);
                bytes(&stream.content, out);
            }
            Object::Reference(id) => match self.pages.get(id) {
                Some(index) => {
                    out.update(b"page");
                    out.update((*index as u64).to_le_bytes());
                }
                None => {
                    out.update(b"R");
                    out.update(self.object(*id));
                }
            },
        }
    }
}

/// Length-prefixed, so adjacent values cannot run into each other.
fn bytes(value: &[u8], out: &mut Sha256) {
    out.update((value.len() as u64).to_le_bytes());
    out.update(value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Stream};

    /// A PDF of `pages`, each drawing its text, a link on the first page to
    /// the last, an outline entry per `outline` title, and `padding` unused
    /// objects first so every object number moves.
    fn pdf(pages: &[&str], outline: &[&str], padding: usize) -> Vec<u8> {
        let mut document = Document::with_version("1.5");
        for index in 0..padding {
            document.add_object(Object::Integer(index as i64));
        }
        let pages_id = document.new_object_id();
        let font = document.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        let page_ids: Vec<ObjectId> = (0..pages.len()).map(|_| document.new_object_id()).collect();
        for (index, text) in pages.iter().enumerate() {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec!["F1".into(), 12.into()]),
                    Operation::new("Tj", vec![Object::string_literal(*text)]),
                    Operation::new("ET", vec![]),
                ],
            };
            let contents =
                document.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            let mut page = dictionary! {
                "Type" => "Page", "Parent" => pages_id, "Contents" => contents,
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            };
            if index == 0 {
                let target = *page_ids.last().unwrap();
                let link = document.add_object(dictionary! {
                    "Type" => "Annot", "Subtype" => "Link", "Rect" => vec![0.into(), 0.into(), 9.into(), 9.into()],
                    "Dest" => vec![target.into(), "Fit".into()], "P" => page_ids[0],
                });
                page.set("Annots", vec![link.into()]);
            }
            document.objects.insert(page_ids[index], Object::Dictionary(page));
        }
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Count" => pages.len() as i64,
                "Kids" => page_ids.iter().map(|id| Object::from(*id)).collect::<Vec<_>>(),
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            }),
        );
        let outlines_id = document.new_object_id();
        let items: Vec<ObjectId> = outline
            .iter()
            .map(|title| {
                document.add_object(dictionary! {
                    "Title" => Object::string_literal(*title), "Parent" => outlines_id,
                    "Dest" => Object::string_literal(*title),
                })
            })
            .collect();
        let mut outlines = dictionary! { "Type" => "Outlines", "Count" => items.len() as i64 };
        if let (Some(first), Some(last)) = (items.first(), items.last()) {
            outlines.set("First", *first);
            outlines.set("Last", *last);
        }
        document.objects.insert(outlines_id, Object::Dictionary(outlines));
        let catalog = document.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages_id, "Outlines" => outlines_id,
        });
        document.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn only_the_edited_page_changes_though_every_object_number_moved() {
        let before = signatures(&pdf(&["One", "Two", "Three"], &["Intro"], 0)).unwrap();
        let after = signatures(&pdf(&["One", "Two, edited", "Three"], &["Intro"], 7)).unwrap();
        assert_eq!(before.document, after.document);
        assert_eq!(before.pages.len(), 3);
        assert_eq!(before.pages[0], after.pages[0], "the link still points at the last page");
        assert_ne!(before.pages[1], after.pages[1]);
        assert_eq!(before.pages[2], after.pages[2]);
    }

    #[test]
    fn a_new_page_count_or_outline_changes_the_document() {
        let base = signatures(&pdf(&["One", "Two"], &["Intro"], 0)).unwrap();
        let longer = signatures(&pdf(&["One", "Two", "Three"], &["Intro"], 0)).unwrap();
        assert_ne!(base.document, longer.document);
        let retitled = signatures(&pdf(&["One", "Two"], &["Introduction"], 0)).unwrap();
        assert_ne!(base.document, retitled.document);
        assert_eq!(base.pages, retitled.pages);
    }

    #[test]
    fn a_link_to_another_page_changes_the_page_it_is_on() {
        let short = signatures(&pdf(&["One", "Two"], &[], 0)).unwrap();
        let long = signatures(&pdf(&["One", "Two", "Three"], &[], 0)).unwrap();
        // Page 1 links to the last page, which is now page 3.
        assert_ne!(short.pages[0], long.pages[0]);
        assert_eq!(short.pages[1], long.pages[1]);
    }

    #[test]
    fn bytes_that_are_not_a_pdf_are_refused() {
        assert!(signatures(b"%PDF-1.4 not really").is_err());
    }
}
