//! A page's text as PDFium reads it, and the reader's selection in it.
//!
//! The Tauri app selects through PDF.js's text layer and works around the
//! browser's DOM-order selection (`src/pdf/pdf-text-layer-selection.ts`):
//! a drag selects the glyphs between where it started and where the pointer
//! is, in reading order, never the whole page; the highlight is drawn from
//! the glyphs' line boxes in the editor's selection blue at 35%; and what is
//! copied reads each line end as a space, joining a word hyphenated across
//! one. Here the glyphs are PDFium's characters with their boxes, so the
//! same rules are plain arithmetic.

use std::ops::Range;

/// One character on a page: its box in PDF points from the page's top-left
/// corner (`x0, y0` its top-left, `x1, y1` its bottom-right). A character
/// PDFium generated (a space between words, a line end) may have no box.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextChar {
    pub ch: char,
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub generated: bool,
}

impl TextChar {
    fn has_box(&self) -> bool {
        self.x1 > self.x0 && self.y1 > self.y0
    }

    fn center_y(&self) -> f32 {
        (self.y0 + self.y1) / 2.
    }
}

/// Where a link on a page leads.
#[derive(Clone, Debug, PartialEq)]
pub enum LinkTarget {
    /// A place in this PDF: a page (0-based) and, when the link names it, the
    /// point to bring to the top of the view, in PDF points from the page's
    /// top-left corner.
    Page {
        page: usize,
        x: Option<f32>,
        y: Option<f32>,
    },
    /// A web address, opened in the browser.
    Uri(String),
}

/// Whether a link's address may be opened: http, https, mailto and tel, the
/// Tauri app's opener scope (`opener:allow-default-urls`). Anything else (a
/// file, an app's own scheme) would launch whatever handles it.
pub fn openable_uri(uri: &str) -> bool {
    ["http://", "https://", "mailto:", "tel:"]
        .iter()
        .any(|scheme| {
            uri.get(..scheme.len())
                .is_some_and(|start| start.eq_ignore_ascii_case(scheme))
        })
}

/// A link's box on its page, in PDF points from the top-left corner.
#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub target: LinkTarget,
}

impl Link {
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x0 && x <= self.x1 && y >= self.y0 && y <= self.y1
    }
}

/// A page's characters, in PDFium's reading order, and its links.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PageText {
    pub chars: Vec<TextChar>,
    pub links: Vec<Link>,
}

/// A position between two characters of a page: before `chars[index]`.
pub type Caret = usize;

impl PageText {
    /// The line each character is on: characters that follow one another
    /// and overlap vertically share one. A generated character joins the
    /// line before it.
    pub fn lines(&self) -> Vec<Range<usize>> {
        let mut lines = Vec::new();
        let mut start = 0;
        let mut band: Option<(f32, f32)> = None;
        for (ix, ch) in self.chars.iter().enumerate() {
            if !ch.has_box() {
                continue;
            }
            match band {
                Some((top, bottom)) if ch.center_y() >= top && ch.center_y() <= bottom => {
                    band = Some((top.min(ch.y0), bottom.max(ch.y1)));
                }
                Some(_) => {
                    lines.push(start..ix);
                    start = ix;
                    band = Some((ch.y0, ch.y1));
                }
                None => band = Some((ch.y0, ch.y1)),
            }
        }
        if start < self.chars.len() {
            lines.push(start..self.chars.len());
        }
        lines
    }

    /// The caret nearest the point (`x`, `y`), in PDF points: on the line
    /// under it (or the nearest line), before or after the character under
    /// it by which half of it the point is in. `None` on a page with no text.
    pub fn caret_at(&self, x: f32, y: f32) -> Option<Caret> {
        let lines = self.lines();
        let distance = |line: &Range<usize>| {
            let (top, bottom) = self.chars[line.clone()]
                .iter()
                .filter(|ch| ch.has_box())
                .fold((f32::MAX, f32::MIN), |(top, bottom), ch| {
                    (top.min(ch.y0), bottom.max(ch.y1))
                });
            if y < top {
                top - y
            } else if y > bottom {
                y - bottom
            } else {
                0.
            }
        };
        let line = lines
            .iter()
            .min_by(|a, b| distance(a).total_cmp(&distance(b)))?;
        let mut best: Option<(f32, Caret)> = None;
        for ix in line.clone() {
            let ch = &self.chars[ix];
            if !ch.has_box() {
                continue;
            }
            let caret = if x < (ch.x0 + ch.x1) / 2. { ix } else { ix + 1 };
            let gap = if x < ch.x0 {
                ch.x0 - x
            } else if x > ch.x1 {
                x - ch.x1
            } else {
                0.
            };
            if best.is_none_or(|(nearest, _)| gap < nearest) {
                best = Some((gap, caret));
            }
        }
        best.map(|(_, caret)| caret)
    }

    /// The selection's highlight on this page for the characters in
    /// `range`: one box per line, from its first to its last selected glyph,
    /// as tall as the line.
    pub fn highlight(&self, range: Range<usize>) -> Vec<[f32; 4]> {
        let mut boxes = Vec::new();
        for line in self.lines() {
            let start = line.start.max(range.start);
            let end = line.end.min(range.end);
            if start >= end {
                continue;
            }
            let (top, bottom) = self.chars[line.clone()]
                .iter()
                .filter(|ch| ch.has_box())
                .fold((f32::MAX, f32::MIN), |(top, bottom), ch| {
                    (top.min(ch.y0), bottom.max(ch.y1))
                });
            let (left, right) = self.chars[start..end]
                .iter()
                .filter(|ch| ch.has_box())
                .fold((f32::MAX, f32::MIN), |(left, right), ch| {
                    (left.min(ch.x0), right.max(ch.x1))
                });
            if left < right && top < bottom {
                boxes.push([left, top, right, bottom]);
            }
        }
        boxes
    }

    /// The characters in `range` as they are copied: a line end is a line
    /// end until the text is joined (`copied`).
    pub fn raw_text(&self, range: Range<usize>) -> String {
        let lines = self.lines();
        let mut text = String::new();
        for (ix, ch) in self.chars[range.clone()].iter().enumerate() {
            let ix = range.start + ix;
            match ch.ch {
                '\r' | '\n' => {
                    if !text.ends_with('\n') {
                        text.push('\n');
                    }
                }
                ch => text.push(ch),
            }
            // A line that ends without a generated line end still ends.
            if lines
                .iter()
                .any(|line| line.end == ix + 1 && line.end < range.end)
                && !text.ends_with('\n')
                && !matches!(
                    self.chars.get(ix + 1).map(|next| next.ch),
                    Some('\r' | '\n')
                )
            {
                text.push('\n');
            }
        }
        text
    }
}

/// What a selection copies (`textFromRange` then `normalizePdfSelection`):
/// a hyphen ending a line joins the word across it, then every run of
/// spaces and line ends is one space, trimmed.
pub fn copied(raw: &str) -> String {
    let mut joined = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '-' {
            // `-[\t ]*\n\s*` is dropped.
            let rest: String = chars.clone().collect();
            let trimmed = rest.trim_start_matches([' ', '\t']);
            if let Some(after) = trimmed.strip_prefix('\n') {
                let after = after.trim_start();
                let skip = rest.chars().count() - after.chars().count();
                for _ in 0..skip {
                    chars.next();
                }
                continue;
            }
        }
        joined.push(if ch == '\u{a0}' { ' ' } else { ch });
    }
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A selection across pages: from the caret where the drag started to the
/// one under the pointer, in reading order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub anchor: (usize, Caret),
    pub focus: (usize, Caret),
}

impl Selection {
    /// Its start and end, in reading order.
    pub fn ordered(&self) -> ((usize, Caret), (usize, Caret)) {
        if self.anchor <= self.focus {
            (self.anchor, self.focus)
        } else {
            (self.focus, self.anchor)
        }
    }

    pub fn is_empty(&self) -> bool {
        self.anchor == self.focus
    }

    /// The characters it covers on `page`, which has `len` of them.
    pub fn range_on(&self, page: usize, len: usize) -> Option<Range<usize>> {
        let ((start_page, start), (end_page, end)) = self.ordered();
        if page < start_page || page > end_page {
            return None;
        }
        let from = if page == start_page {
            start.min(len)
        } else {
            0
        };
        let to = if page == end_page { end.min(len) } else { len };
        (from < to).then_some(from..to)
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    #[test]
    fn only_web_mail_and_phone_links_open() {
        for uri in [
            "https://arxiv.org/abs/1706.03762",
            "HTTP://example.com",
            "mailto:someone@example.com",
            "tel:+15551234567",
        ] {
            assert!(openable_uri(uri), "{uri}");
        }
        for uri in [
            "file:///Applications/Utilities/Terminal.app",
            "javascript:alert(1)",
            "x-apple-systempreferences:com.apple.preference.security",
            "httpx://example.com",
            "",
        ] {
            assert!(!openable_uri(uri), "{uri}");
        }
    }

    /// A page of `lines`, each 10pt tall, glyphs 5pt wide, a generated line
    /// end after each line but the last.
    pub fn page(lines: &[&str]) -> PageText {
        let mut chars = Vec::new();
        for (row, line) in lines.iter().enumerate() {
            let y0 = 100. + row as f32 * 14.;
            for (col, ch) in line.chars().enumerate() {
                let x0 = 72. + col as f32 * 5.;
                chars.push(TextChar {
                    ch,
                    x0,
                    y0,
                    x1: x0 + 5.,
                    y1: y0 + 10.,
                    generated: false,
                });
            }
            if row + 1 < lines.len() {
                for ch in ['\r', '\n'] {
                    chars.push(TextChar {
                        ch,
                        x0: 0.,
                        y0: 0.,
                        x1: 0.,
                        y1: 0.,
                        generated: true,
                    });
                }
            }
        }
        PageText {
            chars,
            links: Vec::new(),
        }
    }

    #[test]
    fn lines_follow_the_glyphs_vertical_bands() {
        let text = page(&["first line", "second"]);
        let lines = text.lines();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], 0..12);
        assert_eq!(lines[1], 12..18);
    }

    #[test]
    fn a_point_finds_the_caret_on_the_nearest_line() {
        let text = page(&["abcdef", "ghijkl"]);
        // Inside "c", in its left half: before it.
        assert_eq!(text.caret_at(72. + 2. * 5. + 1., 105.), Some(2));
        // Its right half: after it.
        assert_eq!(text.caret_at(72. + 2. * 5. + 4., 105.), Some(3));
        // Past the end of the second line, below it: after its last glyph.
        assert_eq!(text.caret_at(400., 200.), Some(14));
        // Above the text: the first line.
        assert_eq!(text.caret_at(60., 10.), Some(0));
    }

    #[test]
    fn the_highlight_is_one_box_per_line() {
        let text = page(&["abcdef", "ghijkl"]);
        let boxes = text.highlight(3..11);
        assert_eq!(boxes.len(), 2);
        assert_eq!(boxes[0], [87., 100., 102., 110.]);
        assert_eq!(boxes[1], [72., 114., 87., 124.]);
    }

    #[test]
    fn copying_joins_lines_and_hyphenated_words() {
        let text = page(&["a hyphen-", "ated word", "and more"]);
        let raw = text.raw_text(0..text.chars.len());
        assert_eq!(raw, "a hyphen-\nated word\nand more");
        assert_eq!(copied(&raw), "a hyphenated word and more");
        assert_eq!(copied("  spaced\u{a0} out \n"), "spaced out");
        // A hyphen inside a line stays.
        assert_eq!(copied("well-known"), "well-known");
    }

    #[test]
    fn a_selection_covers_pages_in_reading_order() {
        let selection = Selection {
            anchor: (2, 5),
            focus: (0, 3),
        };
        assert_eq!(selection.range_on(0, 10), Some(3..10));
        assert_eq!(selection.range_on(1, 7), Some(0..7));
        assert_eq!(selection.range_on(2, 10), Some(0..5));
        assert_eq!(selection.range_on(3, 10), None);
        let collapsed = Selection {
            anchor: (1, 4),
            focus: (1, 4),
        };
        assert!(collapsed.is_empty());
        assert_eq!(collapsed.range_on(1, 10), None);
    }
}
