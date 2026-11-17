//! Which page of a paper's PDF holds a passage read elsewhere
//! (`pdf-quote-page.ts`): the full text Lattice converted from the paper's
//! HTML has no pages, so its Copy source link and Add to note look the
//! passage up in the PDF, page by page, and name it there with the anchors
//! that find it and nothing else on that page.
//!
//! A page's text is what the viewer's selection reads (PDFium's characters,
//! a line end after each line), as PDF.js's text layer is what the Tauri
//! app searches, so the anchors chosen here are the ones the reader's
//! highlight finds again.

use std::path::PathBuf;

use gpui::{App, Task};

use super::pdf::cached_pdf;
use crate::papers::source_link::{SourcePlace, quote_anchors_in};
use crate::pdf::PdfEngine;

/// Where the PDF to search is: the bundle's own file, or an address on the
/// web, fetched once into the reader's cache.
#[derive(Clone, Debug, PartialEq)]
pub enum QuotePdf {
    File(PathBuf),
    Web(String),
}

/// Find `quote` in the PDF at `pdf` (`findQuotePage`): its place, `None`
/// when no page holds it once, an error when the PDF could not be read.
pub fn locate_quote(
    pdf: QuotePdf,
    quote: String,
    cx: &mut App,
) -> Task<Result<Option<SourcePlace>, String>> {
    let engine = match PdfEngine::global(cx) {
        Ok(engine) => engine,
        Err(error) => return Task::ready(Err(error.to_string())),
    };
    cx.background_executor().spawn(async move {
        let bytes = match pdf {
            QuotePdf::File(path) => std::fs::read(&path).map_err(|error| error.to_string())?,
            QuotePdf::Web(url) => {
                let file = cached_pdf(&url)?;
                std::fs::read(&file).map_err(|error| error.to_string())?
            }
        };
        let doc = engine.new_document();
        let found = async {
            let info = engine
                .open(doc, bytes)
                .await
                .map_err(|_| "The PDF reader stopped.".to_string())?
                .map_err(|error| format!("{error:#}"))?;
            // Each page is read only once the ones before it lacked the
            // passage: most passages are found in the first pages.
            for page in 0..info.page_sizes.len() {
                let text = engine
                    .text(doc, info.generation, page)
                    .await
                    .map_err(|_| "The PDF reader stopped.".to_string())?
                    .map_err(|error| format!("{error:#}"))?;
                let text = text.raw_text(0..text.chars.len());
                if let Some((first, last)) = quote_anchors_in(&text, &quote) {
                    let page = page as u32 + 1;
                    return Ok(Some(SourcePlace { page, first, last }));
                }
            }
            Ok(None)
        }
        .await;
        engine.close(doc);
        found
    })
}
