//! Find in PDF: matching a query against a page's text the way PDF.js's
//! find controller does for the Tauri app's search field
//! (`src/pdf/use-pdf-search.ts`), with its two options, Match case and
//! Whole word, and diacritics ignored as `matchDiacritics: false` asks.
//!
//! A page's text is read as one string: every run of spaces and line ends
//! is one space, a word hyphenated across a line end is one word, and a
//! ligature is its letters, so a query typed as it reads finds what the page
//! shows. Each match comes back as a range of the page's characters, from
//! which the view draws its boxes.

use std::ops::Range;

use super::text::{PageText, TextChar};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct FindOptions {
    pub match_case: bool,
    pub whole_word: bool,
}

/// A query as it is matched: whitespace collapsed and trimmed; `None` when
/// nothing is left to look for.
pub fn normalize_query(query: &str) -> Option<String> {
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
    (!query.is_empty()).then_some(query)
}

/// What a character is compared as: its letters with the diacritics taken
/// off, folded to lower case unless the case must match.
fn fold(ch: char, match_case: bool, out: &mut Vec<char>) {
    let base = strip_diacritic(ch);
    let letters: &[char] = match base {
        'ﬀ' => &['f', 'f'],
        'ﬁ' => &['f', 'i'],
        'ﬂ' => &['f', 'l'],
        'ﬃ' => &['f', 'f', 'i'],
        'ﬄ' => &['f', 'f', 'l'],
        'ﬅ' | 'ﬆ' => &['s', 't'],
        _ => {
            if match_case {
                out.push(base);
            } else {
                out.extend(base.to_lowercase());
            }
            return;
        }
    };
    for &letter in letters {
        if match_case {
            out.push(letter);
        } else {
            out.extend(letter.to_lowercase());
        }
    }
}

/// The Latin letters a reader types without their accents.
fn strip_diacritic(ch: char) -> char {
    match ch {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' => 'A',
        'ç' | 'ć' | 'č' => 'c',
        'Ç' | 'Ć' | 'Č' => 'C',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ě' => 'e',
        'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ě' => 'E',
        'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
        'Ì' | 'Í' | 'Î' | 'Ï' | 'Ī' => 'I',
        'ñ' | 'ń' | 'ň' => 'n',
        'Ñ' | 'Ń' | 'Ň' => 'N',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' => 'o',
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'Ō' => 'O',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' => 'u',
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ū' | 'Ů' => 'U',
        'ý' | 'ÿ' => 'y',
        'Ý' => 'Y',
        'š' | 'ś' => 's',
        'Š' | 'Ś' => 'S',
        'ž' | 'ź' | 'ż' => 'z',
        'Ž' | 'Ź' | 'Ż' => 'Z',
        'ł' => 'l',
        'Ł' => 'L',
        other => other,
    }
}

/// The page's text as it is searched, and the character each of its
/// letters came from.
struct Searchable {
    letters: Vec<char>,
    from: Vec<usize>,
}

fn searchable(chars: &[TextChar], match_case: bool) -> Searchable {
    let mut letters = Vec::with_capacity(chars.len());
    let mut from = Vec::with_capacity(chars.len());
    let mut folded = Vec::with_capacity(3);
    let mut ix = 0;
    while ix < chars.len() {
        let ch = chars[ix].ch;
        if ch.is_whitespace() || ch == '\u{a0}' {
            // A run of spaces and line ends, read as one space.
            let start = ix;
            while ix < chars.len() && (chars[ix].ch.is_whitespace() || chars[ix].ch == '\u{a0}') {
                ix += 1;
            }
            if letters.last().is_some_and(|last| *last != ' ') {
                letters.push(' ');
                from.push(start);
            }
            continue;
        }
        if ch == '-' || ch == '\u{2}' {
            // A hyphen at the end of a line joins the word across it.
            let mut next = ix + 1;
            let mut line_end = false;
            while next < chars.len() && chars[next].ch.is_whitespace() {
                line_end |= matches!(chars[next].ch, '\r' | '\n');
                next += 1;
            }
            if line_end && next < chars.len() {
                ix = next;
                continue;
            }
        }
        folded.clear();
        fold(ch, match_case, &mut folded);
        for letter in folded.drain(..) {
            letters.push(letter);
            from.push(ix);
        }
        ix += 1;
    }
    Searchable { letters, from }
}

fn is_word(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// Every match of `query` on the page, in order, as ranges of its
/// characters. Matches do not overlap.
pub fn find_in_page(text: &PageText, query: &str, options: FindOptions) -> Vec<Range<usize>> {
    let Some(query) = normalize_query(query) else {
        return Vec::new();
    };
    let mut needle = Vec::new();
    for ch in query.chars() {
        if ch == ' ' {
            needle.push(' ');
        } else {
            fold(ch, options.match_case, &mut needle);
        }
    }
    let page = searchable(&text.chars, options.match_case);
    let (letters, n) = (&page.letters, needle.len());
    let mut matches = Vec::new();
    if n == 0 || letters.len() < n {
        return matches;
    }
    let mut at = 0;
    while at + n <= letters.len() {
        if letters[at..at + n] == needle[..] {
            let whole = !options.whole_word
                || ((at == 0 || !is_word(letters[at - 1]) || !is_word(needle[0]))
                    && (at + n == letters.len()
                        || !is_word(letters[at + n])
                        || !is_word(needle[n - 1])));
            if whole {
                let start = page.from[at];
                let end = page.from[at + n - 1] + 1;
                matches.push(start..end);
                at += n;
                continue;
            }
        }
        at += 1;
    }
    matches
}

/// One match in the document: its page, its characters there, and the boxes
/// it is highlighted with (one per line it runs across, in PDF points from
/// the page's top-left corner).
#[derive(Clone, Debug, PartialEq)]
pub struct Match {
    pub page: usize,
    pub chars: Range<usize>,
    pub boxes: Vec<[f32; 4]>,
}

/// Where a search lands first: the first match on or after the page in
/// view, as PDF.js starts from the current page, else the first of all.
pub fn first_match_from(matches: &[Match], page: usize) -> Option<usize> {
    if matches.is_empty() {
        return None;
    }
    Some(
        matches
            .iter()
            .position(|found| found.page >= page)
            .unwrap_or(0),
    )
}

#[cfg(test)]
mod tests {
    use super::super::text::tests::page;
    use super::*;

    #[test]
    fn a_query_matches_across_line_ends_and_spaces() {
        let text = page(&["the quick", "brown fox"]);
        let found = find_in_page(&text, "quick  brown", FindOptions::default());
        assert_eq!(found.len(), 1);
        // From "q" to the "n" of "brown", across the generated line end.
        assert_eq!(text.chars[found[0].start].ch, 'q');
        assert_eq!(text.chars[found[0].end - 1].ch, 'n');
    }

    #[test]
    fn case_and_whole_words_are_options() {
        let text = page(&["Attention is attention, reattention"]);
        let any = find_in_page(&text, "attention", FindOptions::default());
        assert_eq!(any.len(), 3);
        let cased = find_in_page(
            &text,
            "attention",
            FindOptions {
                match_case: true,
                whole_word: false,
            },
        );
        assert_eq!(cased.len(), 2);
        let words = find_in_page(
            &text,
            "attention",
            FindOptions {
                match_case: false,
                whole_word: true,
            },
        );
        assert_eq!(words.len(), 2);
    }

    #[test]
    fn hyphenated_words_ligatures_and_accents_read_as_typed() {
        let text = page(&["a trans-", "former ﬁgure, naïve"]);
        let options = FindOptions::default();
        assert_eq!(find_in_page(&text, "transformer", options).len(), 1);
        assert_eq!(find_in_page(&text, "figure", options).len(), 1);
        assert_eq!(find_in_page(&text, "naive", options).len(), 1);
        assert!(find_in_page(&text, "   ", options).is_empty());
    }

    #[test]
    fn the_first_match_is_the_one_on_or_after_the_page_in_view() {
        let at = |page| Match {
            page,
            chars: 0..1,
            boxes: Vec::new(),
        };
        let matches = [at(0), at(3), at(5)];
        assert_eq!(first_match_from(&matches, 2), Some(1));
        assert_eq!(first_match_from(&matches, 6), Some(0));
        assert_eq!(first_match_from(&[], 0), None);
    }
}
