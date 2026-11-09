//! What a drawing may make Inkscape read. Inkscape embeds a linked image in
//! the PDF it writes, and that PDF is a project file an Overleaf collaborator
//! or a `git push` carries away, so a drawing that links outside the project
//! is refused before the program ever sees it.
//!
//! The document is read as XML, the way Inkscape's own parser reads it, rather
//! than searched for keywords: an attribute value is what the parser makes of
//! it (character references of any length decoded), an `<a>` target is a link
//! in the PDF only when the element really is `<a>`, and a style sheet's
//! `url(…)` is read where it sits. A file Lattice cannot read as plain XML
//! text — compressed, UTF-16, anything with a NUL — is refused rather than
//! scanned as bytes, since the parser would then read what the scan did not.

use super::super::paths::{safe_path, NOT_FOUND};
use super::{read_plain, MAX_DRAWING_BYTES};
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const OUTSIDE: &str = "This drawing links to a file outside the project. Embed the image in the drawing, or keep it inside the project.";
const NOT_PLAIN: &str = "This drawing is not plain, uncompressed XML text, so Lattice cannot check what it links to. Save it as plain SVG.";

/// How deep a chain of in-project SVGs is followed. Inkscape renders an SVG
/// used as an image by loading that document, with its links.
const MAX_DEPTH: usize = 4;

/// The longest `url(…)` or `@import` value read. A style sheet's value is a
/// file name; anything longer is not one, and bounding it keeps the scan linear.
const MAX_VALUE_BYTES: usize = 4 * 1024;

/// Embedded images Inkscape decodes itself; an embedded SVG or style sheet
/// could carry links of its own, so those are refused.
const EMBEDDED_IMAGES: [&str; 7] = ["png", "jpeg", "jpg", "gif", "webp", "bmp", "tiff"];

/// Refuses a drawing that would make Inkscape read a file outside the project,
/// or anything over the network, into the figure. `folder` is the drawing's
/// folder, relative to the project.
pub(super) fn check_svg_links(root: &Path, folder: &str, svg: &[u8]) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    check_document(root, folder, svg, 0, &mut seen)
}

fn check_document(
    root: &Path, folder: &str, svg: &[u8], depth: usize, seen: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    for target in links_of(plain_xml(svg)?)? {
        match resolve(root, folder, &target) {
            Target::Harmless => {}
            Target::Outside => return Err(OUTSIDE.to_string()),
            Target::Inside { folder, path } => {
                // Only an SVG is a document of its own; any other type
                // Inkscape embeds as pixels, links and all already checked.
                if !is_svg(&path) || !seen.insert(path.clone()) {
                    continue;
                }
                if depth + 1 > MAX_DEPTH {
                    return Err(OUTSIDE.to_string());
                }
                let nested = read_plain(&path, MAX_DRAWING_BYTES).ok_or(NOT_PLAIN)?;
                check_document(root, &folder, &nested, depth + 1, seen)?;
            }
        }
    }
    Ok(())
}

fn is_svg(path: &Path) -> bool {
    path.extension().and_then(|kind| kind.to_str()).is_some_and(|kind| kind.eq_ignore_ascii_case("svg"))
}

/// The document as text, or a refusal: the scan must read the same characters
/// the program's parser will. Compression and any encoding but UTF-8 would
/// hide every link from a scan of these bytes.
fn plain_xml(svg: &[u8]) -> Result<&str, String> {
    let refuse = || NOT_PLAIN.to_string();
    // gzip (a .svgz saved under .svg), zip, and UTF-16/32 byte-order marks.
    for magic in [[0x1f, 0x8b].as_slice(), b"PK", &[0xff, 0xfe], &[0xfe, 0xff], &[0x00, 0x00]] {
        if svg.starts_with(magic) {
            return Err(refuse());
        }
    }
    if svg.contains(&0) {
        return Err(refuse());
    }
    let text = std::str::from_utf8(svg).map_err(|_| refuse())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // A declaration naming another encoding: the parser would read other
    // characters than these, even where the bytes happen to be valid UTF-8.
    if let Some(encoding) = declared_encoding(text) {
        if !matches!(encoding.as_str(), "utf-8" | "utf8" | "us-ascii" | "ascii") {
            return Err(refuse());
        }
    }
    Ok(text)
}

/// The `encoding` of a leading XML declaration, lowercased.
fn declared_encoding(text: &str) -> Option<String> {
    let declaration = window(text.strip_prefix("<?xml")?, 512).split("?>").next()?;
    let rest = declaration.split("encoding").nth(1)?.trim_start().strip_prefix('=')?.trim_start();
    let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    Some(rest[1..].split(quote).next()?.trim().to_ascii_lowercase())
}

/// The first `limit` bytes of `text`, cut at a character boundary.
fn window(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// A name without its namespace prefix, lowercased.
fn local(name: &[u8]) -> Vec<u8> {
    let name = match name.iter().rposition(|byte| *byte == b':') {
        Some(colon) => &name[colon + 1..],
        None => name,
    };
    name.to_ascii_lowercase()
}

/// Every file the document asks the program to read.
fn links_of(text: &str) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().check_end_names = false;
    let mut links = Vec::new();
    // A style sheet's text sits in the element, not in an attribute.
    let mut in_style = false;
    loop {
        match reader.read_event().map_err(|_| NOT_PLAIN.to_string())? {
            Event::Eof => break,
            // A doctype can define an entity that names a file for the parser
            // to read into the document. Inkscape never writes one.
            Event::DocType(_) => return Err(OUTSIDE.to_string()),
            // `<?xml-stylesheet href="…"?>` names a style sheet to read.
            Event::PI(pi) => {
                if local(&pi).starts_with(b"xml-stylesheet") {
                    return Err(OUTSIDE.to_string());
                }
            }
            Event::Start(element) => {
                in_style = local(element.name().as_ref()) == b"style";
                attribute_links(&element, &mut links)?;
            }
            Event::Empty(element) => attribute_links(&element, &mut links)?,
            Event::End(_) => in_style = false,
            Event::Text(text) if in_style => {
                let css = text.xml_content(XmlVersion::Implicit1_0).map_err(|_| NOT_PLAIN.to_string())?;
                style_links(&css, &mut links)?;
            }
            Event::CData(data) if in_style => {
                let css = String::from_utf8_lossy(&data).into_owned();
                style_links(&css, &mut links)?;
            }
            _ => {}
        }
    }
    Ok(links)
}

fn attribute_links(element: &BytesStart, links: &mut Vec<String>) -> Result<(), String> {
    // The element decides what a target means, so `<a href>` is a link in the
    // PDF (never fetched) only when the element itself is `<a>`.
    let hyperlink = local(element.name().as_ref()) == b"a";
    for attribute in element.attributes().with_checks(false) {
        let attribute = attribute.map_err(|_| NOT_PLAIN.to_string())?;
        let name = local(attribute.key.as_ref());
        // The parser's own value: `&#00000000047;` is `/` however it is written.
        let value =
            attribute.normalized_value(XmlVersion::Implicit1_0).map_err(|_| NOT_PLAIN.to_string())?;
        match name.as_slice() {
            // `xml:base` moves every relative link in the element's subtree.
            b"base" => return Err(OUTSIDE.to_string()),
            b"href" if hyperlink => {}
            // `absref` is Inkscape's own fallback when a link fails.
            b"href" | b"absref" | b"src" => links.push(value.into_owned()),
            // `style`, and the presentation attributes that take a `url(…)` of
            // their own: `fill`, `stroke`, `filter`, `mask`, `clip-path`.
            _ => style_links(&value, links)?,
        }
    }
    Ok(())
}

/// The files a style sheet reads: `url(…)` and `@import`.
fn style_links(css: &str, links: &mut Vec<String>) -> Result<(), String> {
    for (keyword, end) in [("url(", ")"), ("@import", ";")] {
        let mut rest = css;
        while let Some(at) = rest.find(keyword) {
            rest = &rest[at + keyword.len()..];
            // No end within a file name's length: not a name this scan can
            // read, and stopping here keeps one pass over the document.
            let Some(stop) = window(rest, MAX_VALUE_BYTES).find(end) else {
                return Err(OUTSIDE.to_string());
            };
            let value = rest[..stop].trim();
            let value = value.strip_prefix("url(").map_or(value, |rest| rest.trim_end_matches(')'));
            links.push(value.trim().trim_matches(['"', '\'']).to_string());
            rest = &rest[stop..];
        }
    }
    Ok(())
}

enum Target {
    /// Nothing to read: the drawing itself, or data it carries.
    Harmless,
    /// A path inside the project, with its folder relative to the project.
    Inside { folder: String, path: PathBuf },
    Outside,
}

/// Where following `link` from the drawing in `folder` leads.
fn resolve(root: &Path, folder: &str, link: &str) -> Target {
    let link = link.trim();
    if link.is_empty() || link.starts_with('#') {
        return Target::Harmless;
    }
    let lower: String = link.to_ascii_lowercase().split_whitespace().collect();
    if let Some(data) = lower.strip_prefix("data:") {
        let embedded = EMBEDDED_IMAGES.iter().any(|kind| {
            data.strip_prefix("image/")
                .and_then(|rest| rest.strip_prefix(kind))
                .is_some_and(|rest| rest.starts_with([';', ',']))
        });
        return if embedded { Target::Harmless } else { Target::Outside };
    }
    // A scheme, a drive, an absolute or home path, or an escape the program
    // would decode into one of those.
    if link.contains([':', '\\', '%', '?']) || link.starts_with(['/', '~']) {
        return Target::Outside;
    }
    // `other.svg#shape` reads `other.svg`.
    let file = link.split('#').next().unwrap_or_default();
    let mut parts: Vec<&str> = folder.split('/').filter(|part| !part.is_empty()).collect();
    for part in file.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Target::Outside;
                }
            }
            name => parts.push(name),
        }
    }
    if parts.is_empty() {
        return Target::Harmless;
    }
    let relative = parts.join("/");
    // Real folders and files only: a link inside the project may lead out of
    // it through a symbolic link, which `safe_path` refuses on every component.
    match safe_path(root, &relative) {
        Ok(path) => {
            let folder = parts[..parts.len() - 1].join("/");
            Target::Inside { folder, path }
        }
        // Nothing there yet is nothing to read.
        Err(error) if error == NOT_FOUND => Target::Harmless,
        Err(_) => Target::Outside,
    }
}
