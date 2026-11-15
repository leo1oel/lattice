//! Where an annotation is drawn on a page of the PDF, as the Tauri app
//! measures it (`pdf-annotation-place.ts`, `review-pdf.ts`): the words its
//! source range quotes are looked for in the page's text, compared as
//! letters alone (accents dropped, ligatures spelled out, lower case), and
//! highlighted one band per line, each reaching a little below the
//! descenders so its rule never cuts a letter. A note made on the PDF whose
//! quote does not read on the page (a formula) falls back to the
//! selection's own text, then to its boxes as they were saved. The pin
//! stands in the margin beside the column the passage starts in.
//!
//! The Tauri app reads PDF.js's text runs and shares each run's width among
//! its characters; PDFium gives each character its own box, so the bands
//! here are the glyphs' own extents.

use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization as _;

use super::text::{PageText, TextChar};

/// A box on a page as fractions of its width and height, from its
/// top-left corner (`PdfRect`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Band {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Which margin of its column a pin stands in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    /// The left margin.
    Start,
    /// The right margin of a page's right-hand column.
    End,
}

/// A pin's place: its column edge and its first line's middle, as fractions
/// of the page.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pin {
    pub x: f32,
    pub y: f32,
    pub side: Side,
}

/// A mark on a page: one band per line, and its pin.
#[derive(Clone, Debug, PartialEq)]
pub struct MarkPlace {
    /// 0-based.
    pub page: usize,
    pub bands: Vec<Band>,
    pub pin: Pin,
}

/// A box on the page: x, y, width, height.
type Rect = (f32, f32, f32, f32);

/// Letters matched from each end of the quote; shorter ends are tried when
/// these miss.
const END_LENGTHS: [usize; 2] = [24, 12];
/// How far a band reaches below the glyph box, as a fraction of its height.
const RULE_CLEARANCE: f32 = 0.1;

/// Commands whose argument is a key the page never prints: `\cite{vaswani}`
/// reads "[1]", so its letters would only match the bibliography.
static KEY_COMMANDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\\(?:[a-zA-Z]*cite[a-zA-Z]*|[a-zA-Z]*ref|label|url|href)\*?(?:\[[^\]]*\])*\{[^{}]*\}",
    )
    .unwrap()
});

fn round(value: f32) -> f32 {
    (value * 10_000.).round() / 10_000.
}

/// One character's letters as compared: ligatures spelled out, accents
/// dropped, lower case.
pub fn fold_letters(ch: char) -> String {
    ch.to_string()
        .nfkd()
        .filter(|part| !unicode_normalization::char::is_combining_mark(*part))
        .flat_map(char::to_lowercase)
        .filter(|part| part.is_alphanumeric())
        .collect()
}

/// The prose letters of a source passage, lower case: command names
/// (`\section`) and `%` comments are not prose (`sourceLetters`).
pub fn source_letters(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut letters = String::new();
    let mut ix = 0;
    while ix < chars.len() {
        let ch = chars[ix];
        if ch == '\\' {
            while ix + 1 < chars.len()
                && (chars[ix + 1].is_ascii_alphabetic() || chars[ix + 1] == '@')
            {
                ix += 1;
            }
        } else if ch == '%' && (ix == 0 || chars[ix - 1] != '\\') {
            while ix + 1 < chars.len() && chars[ix + 1] != '\n' {
                ix += 1;
            }
        } else if ch.is_alphanumeric() {
            letters.extend(ch.to_lowercase());
        }
        ix += 1;
    }
    letters
}

/// The prose letters of a source quote in the stretches between its
/// citations and cross-references, whose printed form is unknown here.
pub fn quote_letters(quote: &str) -> Vec<String> {
    KEY_COMMANDS
        .split(quote)
        .map(|prose| {
            source_letters(prose)
                .chars()
                .map(fold_letters)
                .collect::<String>()
        })
        .filter(|letters| !letters.is_empty())
        .collect()
}

/// The letters a selection on the PDF reads, as one stretch.
pub fn pdf_text_letters(text: &str) -> Vec<String> {
    vec![text.chars().map(fold_letters).collect()]
}

fn has_box(ch: &TextChar) -> bool {
    ch.x1 > ch.x0 && ch.y1 > ch.y0
}

/// The page's letters, each with the character it was read from.
fn page_letters(text: &PageText) -> (Vec<char>, Vec<usize>) {
    let mut letters = Vec::new();
    let mut at = Vec::new();
    for (ix, ch) in text.chars.iter().enumerate() {
        if !has_box(ch) {
            continue;
        }
        for letter in fold_letters(ch.ch).chars() {
            letters.push(letter);
            at.push(ix);
        }
    }
    (letters, at)
}

fn find_from(haystack: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&ix| haystack[ix..ix + needle.len()] == *needle)
}

/// The bands over the characters `span` names (indices into the page's
/// characters), one per line, top to bottom, in points.
fn line_boxes(text: &PageText, span: &[usize]) -> Vec<Rect> {
    let mut lines: Vec<Rect> = Vec::new();
    let mut last = None;
    for &ix in span {
        if last == Some(ix) {
            continue;
        }
        last = Some(ix);
        let ch = &text.chars[ix];
        let middle = (ch.y0 + ch.y1) / 2.;
        let height = ch.y1 - ch.y0;
        match lines.iter_mut().find(|line| {
            let line_middle = (line.1 + line.3) / 2.;
            (line_middle - middle).abs() < (line.3 - line.1).min(height) / 2.
        }) {
            Some(line) => {
                line.0 = line.0.min(ch.x0);
                line.1 = line.1.min(ch.y0);
                line.2 = line.2.max(ch.x1);
                line.3 = line.3.max(ch.y1);
            }
            None => lines.push((ch.x0, ch.y0, ch.x1, ch.y1)),
        }
    }
    lines.sort_by(|a, b| a.1.total_cmp(&b.1));
    lines
}

/// The bands (fractions of a page `size` points) over `wanted` (stretches of
/// letters, in order): from the first occurrence of its opening letters to
/// the nearest following occurrence of its closing ones. With several, the
/// one whose top is nearest `near_y` (points from the page's top). `None`
/// when it is not on the page (`findQuads`).
pub fn find_bands(
    text: &PageText,
    size: (f32, f32),
    wanted: &[String],
    near_y: Option<f32>,
) -> Option<Vec<Band>> {
    let (width, height) = size;
    if width <= 0. || height <= 0. {
        return None;
    }
    let first: Vec<char> = wanted.first()?.chars().collect();
    let last: Vec<char> = wanted.last()?.chars().collect();
    let total: usize = wanted.iter().map(|part| part.chars().count()).sum();
    if total < 4 {
        return None;
    }
    let (letters, at) = page_letters(text);
    for length in END_LENGTHS {
        let head = &first[..first.len().min(length)];
        let tail = &last[last.len().saturating_sub(length)..];
        // A citation or formula inside the quote reads differently on the
        // page; allow for it.
        let longest = total as f32 * 1.5 + 40.;
        let shortest = head.len().max(tail.len()).max(total - total / 2);
        let mut best: Option<(Vec<Rect>, f32)> = None;
        let mut from = 0;
        while let Some(start) = find_from(&letters, head, from) {
            from = start + 1;
            let Some(end) = find_from(
                &letters,
                tail,
                (start + shortest).saturating_sub(tail.len()),
            ) else {
                continue;
            };
            if (end + tail.len() - start) as f32 > longest {
                continue;
            }
            let lines = line_boxes(text, &at[start..end + tail.len()]);
            let Some(top) = lines.first().map(|line| line.1) else {
                continue;
            };
            let distance = near_y.map_or(0., |near| (top - near).abs());
            if best.as_ref().is_none_or(|(_, best)| distance < *best) {
                best = Some((lines, distance));
            }
            if near_y.is_none() {
                break;
            }
        }
        if let Some((lines, _)) = best {
            return Some(
                lines
                    .into_iter()
                    .map(|(x0, y0, x1, y1)| {
                        let low = y1 + (y1 - y0) * RULE_CLEARANCE;
                        Band {
                            x: round(x0 / width),
                            y: round(y0 / height),
                            width: round((x1 - x0) / width),
                            height: round((low - y0) / height),
                        }
                    })
                    .collect(),
            );
        }
        if first.len() <= length && last.len() <= length {
            break;
        }
    }
    None
}

/// The pin's place for a passage whose first line is `first`: the left edge
/// of its text column, or for a passage in the right-hand column of a
/// two-column page, that column's right edge. A line with text across the
/// page's middle (no gutter there) is one column wide.
fn pin_place(text: &PageText, size: (f32, f32), first: Band) -> Pin {
    let (width, height) = size;
    let y = round(first.y + first.height / 2.);
    let glyphs: Vec<&TextChar> = text
        .chars
        .iter()
        .filter(|ch| has_box(ch) && !ch.ch.is_whitespace())
        .collect();
    if glyphs.is_empty() || width <= 0. {
        return Pin {
            x: first.x,
            y,
            side: Side::Start,
        };
    }
    let middle = width / 2.;
    let (top, bottom) = (first.y * height, (first.y + first.height) * height);
    let mut line: Vec<&TextChar> = glyphs
        .iter()
        .copied()
        .filter(|ch| {
            let centre = (ch.y0 + ch.y1) / 2.;
            centre >= top && centre <= bottom
        })
        .collect();
    line.sort_by(|a, b| a.x0.total_cmp(&b.x0));
    // A gutter: no glyph across the middle, and a gap there wider than a
    // couple of letters.
    let straddles = line.iter().any(|ch| ch.x0 < middle && ch.x1 > middle);
    let gutter = line.windows(2).any(|pair| {
        let gap = pair[1].x0 - pair[0].x1;
        pair[0].x1 <= middle && pair[1].x0 >= middle && gap > 2. * (pair[0].y1 - pair[0].y0)
    });
    let spans_middle = straddles
        || (!gutter
            && line.iter().any(|ch| ch.x1 <= middle)
            && line.iter().any(|ch| ch.x0 >= middle));
    let fraction = |value: f32| round(value / width);
    if !spans_middle && first.x * width > middle {
        let right = glyphs
            .iter()
            .filter(|ch| ch.x0 >= middle)
            .map(|ch| ch.x1)
            .fold(f32::MIN, f32::max);
        return Pin {
            x: fraction(right),
            y,
            side: Side::End,
        };
    }
    let left = glyphs
        .iter()
        .filter(|ch| spans_middle || ch.x0 < middle)
        .map(|ch| ch.x0)
        .fold(f32::MAX, f32::min);
    Pin {
        x: first.x.min(fraction(left)),
        y,
        side: Side::Start,
    }
}

/// A mark of `bands` on page `page`, its pin beside the first line's column.
pub fn mark_of(
    page: usize,
    text: &PageText,
    size: (f32, f32),
    bands: Vec<Band>,
) -> Option<MarkPlace> {
    let first = *bands.first()?;
    let first = Band {
        x: bands.iter().map(|band| band.x).fold(f32::MAX, f32::min),
        ..first
    };
    let pin = pin_place(text, size, first);
    Some(MarkPlace { page, bands, pin })
}

/// Where a note made on the PDF is drawn on its page: over the words its
/// source range quotes, else the words of the selection, else the
/// selection's boxes as saved (`placePdfMark`).
pub fn place_pdf_mark(
    page: usize,
    text: &PageText,
    size: (f32, f32),
    quote: &str,
    selection: &str,
    saved: &[Band],
) -> Option<MarkPlace> {
    let near_y = saved.first().map(|band| band.y * size.1);
    let bands = find_bands(text, size, &quote_letters(quote), near_y)
        .or_else(|| find_bands(text, size, &pdf_text_letters(selection), near_y))
        .unwrap_or_else(|| saved.to_vec());
    mark_of(page, text, size, bands)
}

/// SyncTeX's box for a source line: its page (0-based) and its top-left
/// corner and size, in points from the page's top-left corner.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SyncBox {
    pub page: usize,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// What placing a source note reads: the PDF on screen, and SyncTeX's map
/// of the build it came from (`SourceMarkReader`).
pub trait MarkReader {
    fn page_count(&self) -> usize;
    /// A page's text and size in points; `None` when it cannot be read.
    fn page(&mut self, page: usize) -> Option<(std::sync::Arc<PageText>, (f32, f32))>;
    /// SyncTeX's box for a 1-based source line and column.
    fn sync(&mut self, line: u32, column: u32) -> Option<SyncBox>;
}

/// Source lines looked up for a long range's line marks, each a SyncTeX
/// lookup of its own.
const MAX_LINE_BOXES: u32 = 12;
/// A box taller than this (points) is not a line: SyncTeX answers a line in
/// a figure or a float with the whole of it.
const MAX_LINE_HEIGHT: f32 = 36.;

/// The 1-based line and column (UTF-16 units, as SyncTeX takes them from
/// the Tauri app) of byte `offset` in `source`.
pub fn line_and_column(source: &str, offset: usize) -> (u32, u32) {
    let before = &source[..offset.min(source.len())];
    let start = before.rfind('\n').map_or(0, |ix| ix + 1);
    let line = before.matches('\n').count() as u32 + 1;
    (line, before[start..].encode_utf16().count() as u32 + 1)
}

/// Whether the lines up to a note's range end (`to`, bytes) are the lines
/// the PDF was built from (`built`, its file's text then): only then do
/// SyncTeX's line numbers still name its passage (`linesAsBuilt`).
pub fn lines_as_built(source: &str, built: Option<&str>, to: usize) -> bool {
    built.is_some_and(|built| {
        source
            .get(..to)
            .is_some_and(|head| built.get(..to) == Some(head))
    })
}

/// Where a note made in a .tex file (`range`, bytes of `source`, its file's
/// text now) is drawn on the PDF: over its words where SyncTeX puts its first
/// line, on that page or the ones either side; else, while its lines are as
/// built, over SyncTeX's boxes for its lines; else nowhere
/// (`placeSourceMark`).
pub fn place_source_mark(
    quote: &str,
    source: &str,
    range: std::ops::Range<usize>,
    as_built: bool,
    reader: &mut impl MarkReader,
) -> Option<MarkPlace> {
    let (line, column) = line_and_column(source, range.start);
    let first = reader.sync(line, column)?;
    if first.page >= reader.page_count() {
        return None;
    }
    let home = first.page;
    let wanted = quote_letters(quote);
    let mut nearby = vec![home, home + 1];
    if home > 0 {
        nearby.push(home - 1);
    }
    let count = reader.page_count();
    for page in nearby.into_iter().filter(|page| *page < count) {
        let Some((text, size)) = reader.page(page) else {
            continue;
        };
        let near = (page == home).then_some(first.y);
        if let Some(bands) = find_bands(&text, size, &wanted, near) {
            return mark_of(page, &text, size, bands);
        }
    }
    if !as_built {
        return None;
    }
    let (text, size) = reader.page(home)?;
    let (last_line, _) = line_and_column(source, range.end.saturating_sub(1).max(range.start));
    let last_line = last_line.min(line + MAX_LINE_BOXES - 1);
    let mut bands: Vec<Band> = Vec::new();
    for at in line..=last_line {
        let found = if at == line {
            Some(first)
        } else {
            reader.sync(at, 1)
        };
        let Some(found) = found.filter(|found| found.page == home) else {
            continue;
        };
        if found.width <= 0. || found.height <= 0. || found.height > MAX_LINE_HEIGHT {
            continue;
        }
        let x = (found.x / size.0).clamp(0., 1.);
        let y = (found.y / size.1).clamp(0., 1.);
        let band = Band {
            x: round(x),
            y: round(y),
            width: round((found.width / size.0).min(1. - x)),
            height: round((found.height / size.1).min(1. - y)),
        };
        // Lines TeX set as one give one box.
        if !bands
            .iter()
            .any(|other| other.x == band.x && other.y == band.y)
        {
            bands.push(band);
        }
    }
    bands.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
    mark_of(home, &text, size, bands)
}

#[cfg(test)]
mod tests;
