//! A figure cut out of the built paper: one page of its PDF, cropped to the
//! figure, and that PDF drawn as a TIFF for journals that take only images.

use super::hook::{crop_box, Placed};
use crate::commands;
use lopdf::{Document, Object, ObjectId};
use std::fs;
use std::path::Path;

/// What a page takes from the page tree above it when it does not say itself.
const INHERITED: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

/// What a catalog holds that points at other pages: outlines, named
/// destinations, page labels, the opening view, the structure tree.
const CATALOG_LINKS: [&str; 6] =
    ["Outlines", "Names", "Dests", "OpenAction", "PageLabels", "StructTreeRoot"];

/// The page `figure` is on, alone, cropped to the figure, as PDF bytes.
pub(super) fn crop(pdf: &[u8], figure: &Placed) -> Result<Vec<u8>, String> {
    let fail = |error: lopdf::Error| format!("Could not cut out the figure: {error}");
    let mut doc = Document::load_mem(pdf).map_err(fail)?;
    let page_id = *doc.get_pages().get(&figure.page).ok_or_else(|| {
        format!("The figure is on page {}, which the PDF does not have.", figure.page)
    })?;
    let inherited = inherited_attributes(&doc, page_id);
    let pages_id = doc
        .catalog()
        .and_then(|catalog| catalog.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(fail)?;
    let [left, bottom, right, top] = crop_box(figure);
    let rect = || Object::Array(vec![left.into(), bottom.into(), right.into(), top.into()]);
    {
        let page = doc.get_object_mut(page_id).and_then(Object::as_dict_mut).map_err(fail)?;
        for (key, value) in inherited {
            page.set(key, value);
        }
        page.set("Parent", Object::Reference(pages_id));
        page.set("MediaBox", rect());
        page.set("CropBox", rect());
        for key in ["TrimBox", "BleedBox", "ArtBox", "Annots", "StructParents"] {
            page.remove(key.as_bytes());
        }
    }
    {
        let pages = doc.get_object_mut(pages_id).and_then(Object::as_dict_mut).map_err(fail)?;
        pages.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
        pages.set("Count", 1);
    }
    let catalog = doc.catalog_mut().map_err(fail)?;
    for key in CATALOG_LINKS {
        catalog.remove(key.as_bytes());
    }
    doc.prune_objects();
    doc.compress();
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).map_err(|error| format!("Could not write the figure: {error}"))?;
    Ok(bytes)
}

/// The inheritable attributes the page lacks, from the nearest node above it.
fn inherited_attributes(doc: &Document, page_id: ObjectId) -> Vec<(Vec<u8>, Object)> {
    let Ok(page) = doc.get_dictionary(page_id) else { return Vec::new() };
    let mut found = Vec::new();
    for key in INHERITED {
        if page.has(key) {
            continue;
        }
        let mut node = page.get(b"Parent").and_then(Object::as_reference).ok();
        // A page tree is shallow; a cycle in a damaged one must not hang.
        for _ in 0..32 {
            let Some(id) = node else { break };
            let Ok(dict) = doc.get_dictionary(id) else { break };
            if let Ok(value) = dict.get(key) {
                found.push((key.to_vec(), value.clone()));
                break;
            }
            node = dict.get(b"Parent").and_then(Object::as_reference).ok();
        }
    }
    found
}

/// macOS: PDFKit draws the page into an RGB bitmap on white, saved as an LZW TIFF.
#[cfg(target_os = "macos")]
const RENDER_JXA: &str = r"
ObjC.import('Cocoa');
ObjC.import('Quartz');
function run(argv) {
  const dpi = Number(argv[2]);
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (doc.isNil()) throw new Error('cannot open PDF');
  const page = doc.pageAtIndex(0);
  const b = page.boundsForBox(0);
  const pw = b.size.width, ph = b.size.height;
  const w = Math.max(1, Math.round(pw * dpi / 72)), h = Math.max(1, Math.round(ph * dpi / 72));
  // 3 samples, no alpha, 32 bits per pixel: AppKit draws nothing into a 24-bit one.
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, w, h, 8, 3, false, false, 'NSDeviceRGBColorSpace', 0, 32);
  rep.size = $.NSMakeSize(pw, ph);
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  if (ctx.isNil()) throw new Error('no graphics context for the bitmap');
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(ctx);
  $.NSColor.whiteColor.set;
  $.NSBezierPath.fillRect($.NSMakeRect(0, 0, pw, ph));
  page.drawWithBoxToContext(0, ctx.CGContext);
  ctx.flushGraphics;
  $.NSGraphicsContext.restoreGraphicsState;
  const props = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithInt(5), $.NSImageCompressionMethod);
  if (!rep.representationUsingTypeProperties(0, props).writeToFileAtomically(argv[1], true)) throw new Error('write failed');
}";

/// A TIFF of the one-page PDF at `pdf`, at `dpi`: PDFKit on macOS, else
/// Ghostscript or Poppler's pdftoppm. An error says why there is none.
pub(super) fn render_tiff(pdf: &Path, tiff: &Path, dpi: u32, scratch: &Path) -> Result<(), String> {
    let _ = fs::remove_file(tiff);
    render(pdf, tiff, dpi, scratch)
}

#[cfg(target_os = "macos")]
fn render(pdf: &Path, tiff: &Path, dpi: u32, scratch: &Path) -> Result<(), String> {
    let script = scratch.join("render.js");
    fs::write(&script, RENDER_JXA).map_err(|error| error.to_string())?;
    let output = std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript"])
        .arg(&script)
        .arg(pdf)
        .arg(tiff)
        .arg(dpi.to_string())
        .output()
        .map_err(|error| error.to_string())?;
    if tiff.is_file() {
        Ok(())
    } else {
        Err(format!("macOS could not draw the TIFF: {}", commands::combined_output(&output).trim()))
    }
}

#[cfg(not(target_os = "macos"))]
fn render(pdf: &Path, tiff: &Path, dpi: u32, _scratch: &Path) -> Result<(), String> {
    let gs = if cfg!(windows) { "gswin64c" } else { "gs" };
    let ran = commands::command(gs)
        .args(["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=tiff24nc", "-sCompression=lzw"])
        .arg(format!("-r{dpi}"))
        .arg(format!("-sOutputFile={}", tiff.display()))
        .arg(pdf)
        .output();
    if ran.is_ok() && tiff.is_file() {
        return Ok(());
    }
    let stem = tiff.with_extension("");
    let ran = commands::command("pdftoppm")
        .args(["-r", &dpi.to_string(), "-tiff", "-tiffcompression", "lzw", "-singlefile"])
        .arg(pdf)
        .arg(&stem)
        .output();
    if ran.is_ok() && stem.with_extension("tif").is_file() {
        return fs::rename(stem.with_extension("tif"), tiff).map_err(|error| error.to_string());
    }
    Err("A TIFF needs Ghostscript or pdftoppm (Poppler); the PDF is written.".to_string())
}
