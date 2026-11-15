//! The word under a double-click on a PDF page, for a reverse SyncTeX jump
//! to land on it, as the Tauri app's `pdf-clicked-word.ts` reads it off
//! PDF.js's text layer. Here the page's characters are PDFium's, with their
//! boxes: the clicked character is the one whose box holds the point, and
//! its visual line is the run of characters PDFium reads as one line, a
//! character it generated between words (a space, a line end) read as a
//! space.

use lattice_editor::latex::synctex_word::{SyncTexWord, clicked_word_in};

use super::text::{PageText, TextChar};

fn has_box(ch: &TextChar) -> bool {
    ch.x1 > ch.x0 && ch.y1 > ch.y0
}

/// The word double-clicked at (`x`, `y`), PDF points from the page's
/// top-left corner; `None` off the text or on a space or punctuation.
pub fn word_at(text: &PageText, x: f32, y: f32) -> Option<SyncTexWord> {
    let hit = text
        .chars
        .iter()
        .position(|ch| has_box(ch) && x >= ch.x0 && x <= ch.x1 && y >= ch.y0 && y <= ch.y1)?;
    let line = text.lines().into_iter().find(|line| line.contains(&hit))?;
    let mut joined = String::new();
    let mut offset = None;
    for ix in line {
        let ch = text.chars[ix];
        if ix == hit {
            offset = Some(joined.len());
        }
        if ch.ch.is_whitespace() || ch.ch.is_control() {
            if !joined.ends_with(' ') {
                joined.push(' ');
            }
        } else {
            joined.push(ch.ch);
        }
    }
    clicked_word_in(&joined, offset?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glyph(ch: char, x: f32, y: f32) -> TextChar {
        TextChar {
            ch,
            x0: x,
            y0: y,
            x1: x + 5.,
            y1: y + 10.,
            generated: false,
        }
    }

    fn space() -> TextChar {
        TextChar {
            ch: ' ',
            x0: 0.,
            y0: 0.,
            x1: 0.,
            y1: 0.,
            generated: true,
        }
    }

    /// "the cat sat" on one line, "the end" on the next.
    fn page() -> PageText {
        let mut chars = Vec::new();
        let mut x = 0.;
        for word in ["the", "cat", "the"] {
            for ch in word.chars() {
                chars.push(glyph(ch, x, 0.));
                x += 5.;
            }
            chars.push(space());
            x += 5.;
        }
        x = 0.;
        for ch in "end".chars() {
            chars.push(glyph(ch, x, 20.));
            x += 5.;
        }
        PageText {
            chars,
            links: Vec::new(),
        }
    }

    #[test]
    fn the_word_under_the_click_knows_its_line() {
        // The second "the", its first letter.
        let word = word_at(&page(), 41., 5.).unwrap();
        assert_eq!(word.word, "the");
        assert_eq!((word.occurrence, word.count), (1, 2));
        assert_eq!(word.before.as_deref(), Some("cat"));
        assert_eq!(word.after, None);
        assert_eq!(word_at(&page(), 2., 25.).unwrap().word, "end");
        assert_eq!(word_at(&page(), 200., 5.), None);
    }
}
