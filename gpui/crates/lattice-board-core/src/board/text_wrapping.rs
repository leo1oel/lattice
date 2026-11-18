// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Soft wrapping. Port of Excalidraw `packages/element/src/textWrapping.ts`
//! @ 3a317b5: `parseTokens` splits a hard line at break opportunities,
//! `getWrappedTextLines` reflows each hard line, `wrapLine` / `wrapWord`
//! assemble tokens, `trimLine` / `trimLineEndAtSoftBreak` drop trailing
//! whitespace as browsers do.
//!
//! Upstream splits with one big regex of lookbehind / lookahead rules
//! (`getLineBreakRegexAdvanced`). Every rule there looks at one character on
//! each side of a position, so here the rules are a predicate over the pair
//! of characters around it (`is_break`), and `String.split`'s semantics
//! (emoji matches kept as their own tokens, no empty split right after the
//! previous one) are reproduced in `parse_tokens`. The emoji regex is
//! upstream's, in `regex` syntax. Character classes match upstream's: `\s` is
//! JavaScript's whitespace (`js_space`), scripts are Unicode `Script` values.
//!
//! Differences: line offsets (`WrappedTextLine::start` / `end`) are byte
//! offsets into the text (upstream: UTF-16 units); like upstream they assume
//! NFC input, as tokens come from the NFC form of each line.

use super::text_measure::{Font, Measure, char_width, get_line_width};
use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// JavaScript's `\s`: WhiteSpace and LineTerminator.
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trimEnd`.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(js_space)
}

// COMMON
const COMMON_OPENING: &str = "<([{";
const COMMON_CLOSING: &str = ">)]}.,:;!?…/";
// CJK
const CJK_CHAR_EXTRA: &str = "｀＇＾〃〰〆＃＆＊＋－ー／＼＝｜￤〒￢￣";
const CJK_OPENING: &str = "（［｛〈《｟｢「『【〖〔〘〚＜〝";
const CJK_CLOSING: &str = "）］｝〉》｠｣」』】〗〕〙〛＞。．，、〟‥？！：；・〜〞";
const CJK_CURRENCY: &str = "￥￦￡￠＄";

static CJK_SCRIPT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}").unwrap()
});

fn in_set(c: char, set: &str) -> bool {
    set.contains(c)
}
fn cjk_char(c: char) -> bool {
    in_set(c, CJK_CHAR_EXTRA) || CJK_SCRIPT.is_match(c.encode_utf8(&mut [0; 4]))
}

/// `containsCJK`: any CJK character, symbol or punctuation.
pub fn contains_cjk(text: &str) -> bool {
    text.chars().any(|c| {
        cjk_char(c) || in_set(c, CJK_OPENING) || in_set(c, CJK_CLOSING) || in_set(c, CJK_CURRENCY)
    })
}

const EMOJI_JOINER: &str =
    r"(?:\p{Emoji_Modifier}|\x{FE0F}\x{20E3}?|[\x{E0020}-\x{E007E}]+\x{E007F})?";
const EMOJI_FLAG: &str = r"\p{Regional_Indicator}\p{Regional_Indicator}";

/// `getEmojiRegexUnicode`'s body: flags, and pictographs with modifiers and
/// ZWJ sequences.
fn emoji_pattern() -> String {
    format!(
        r"(?:{EMOJI_FLAG}|[\p{{Extended_Pictographic}}\p{{Emoji_Presentation}}]{EMOJI_JOINER}(?:\x{{200D}}(?:{EMOJI_FLAG}|[\p{{Emoji}}]{EMOJI_JOINER}))*)"
    )
}
static EMOJI_AT_START: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^{}", emoji_pattern())).unwrap());
static EMOJI_ANY: LazyLock<Regex> = LazyLock::new(|| Regex::new(&emoji_pattern()).unwrap());

/// Whether a line may break between `a` and `b` (`getLineBreakRegexAdvanced`
/// minus the emoji alternative).
fn is_break(a: char, b: char) -> bool {
    let (open_a, close_b) = (
        in_set(a, COMMON_OPENING) || in_set(a, CJK_OPENING),
        in_set(b, COMMON_CLOSING),
    );
    // before whitespace; after whitespace and hyphens
    js_space(b) || js_space(a) || a == '-'
        // before CJK chars and currency, unless after an opening symbol
        || ((cjk_char(b) || in_set(b, CJK_CURRENCY)) && !open_a)
        // after CJK chars, unless before a hyphen or a closing symbol
        || (cjk_char(a) && !(b == '-' || close_b || in_set(b, CJK_CLOSING)))
        // before a run of CJK opening symbols, unless after an opening symbol
        || (in_set(b, CJK_OPENING) && !open_a)
        // after a run of CJK closing symbols, unless before a closing symbol
        || (in_set(a, CJK_CLOSING) && !in_set(b, CJK_CLOSING) && !close_b)
        // after a run of closing symbols followed by an opening one
        || (in_set(a, COMMON_CLOSING) && !close_b && in_set(b, COMMON_OPENING))
}

/// `parseTokens`: the line (NFC-normalized) split at its break
/// opportunities; emojis are tokens of their own.
pub fn parse_tokens(line: &str) -> Vec<String> {
    let s: String = line.nfc().collect();
    let mut out = vec![];
    let mut p = 0;
    let mut prev: Option<char> = None;
    let mut it = s.char_indices().peekable();
    while let Some((q, c)) = it.next() {
        if let Some(m) = EMOJI_AT_START.find(&s[q..]) {
            let e = q + m.end();
            out.push(&s[p..q]);
            out.push(&s[q..e]);
            p = e;
            while it.peek().is_some_and(|&(i, _)| i < e) {
                prev = it.next().map(|(_, c)| c);
            }
            continue;
        }
        if q != p
            && let Some(a) = prev
            && is_break(a, c)
        {
            out.push(&s[p..q]);
            p = q;
        }
        prev = Some(c);
    }
    out.push(&s[p..]);
    out.into_iter()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A rendered line: `start..end` is the byte range of the original text it
/// came from (soft breaks excluded; whitespace trimmed at a wrap is not in it).
#[derive(Clone, Debug, PartialEq)]
pub struct WrappedTextLine {
    pub text: String,
    pub start: usize,
    pub end: usize,
}

/// `wrapText`: the text wrapped at `max_width`, lines joined with `\n`.
pub fn wrap_text(m: &dyn Measure, text: &str, font: Font, max_width: f64) -> String {
    get_wrapped_text_lines(m, text, font, max_width)
        .into_iter()
        .map(|l| l.text)
        .collect::<Vec<_>>()
        .join("\n")
}

fn get_hard_line_breaks(text: &str) -> Vec<WrappedTextLine> {
    let mut offset = 0;
    text.split('\n')
        .map(|l| {
            let start = offset;
            offset += l.len() + 1;
            WrappedTextLine {
                text: l.into(),
                start,
                end: start + l.len(),
            }
        })
        .collect()
}

/// `getWrappedTextLines`: the rendered lines with their source ranges. A
/// width that isn't a finite non-negative number only splits hard lines.
pub fn get_wrapped_text_lines(
    m: &dyn Measure,
    text: &str,
    font: Font,
    max_width: f64,
) -> Vec<WrappedTextLine> {
    if !max_width.is_finite() || max_width < 0. {
        return get_hard_line_breaks(text);
    }
    let mut lines = vec![];
    let mut offset = 0;
    for line in text.split('\n') {
        if get_line_width(m, line, font) <= max_width {
            lines.push(WrappedTextLine {
                text: line.into(),
                start: offset,
                end: offset + line.len(),
            });
        } else {
            lines.extend(wrap_line(m, line, font, max_width, offset));
        }
        offset += line.len() + 1;
    }
    lines
}

fn is_single_character(s: &str) -> bool {
    let mut c = s.chars();
    c.next().is_some() && c.next().is_none()
}

fn wrap_line(
    m: &dyn Measure,
    line: &str,
    font: Font,
    max_width: f64,
    line_start: usize,
) -> Vec<WrappedTextLine> {
    let mut lines = vec![];
    let tokens = parse_tokens(line);
    let mut cur = String::new();
    let (mut cur_start, mut cur_end, mut cur_width) = (line_start, line_start, 0.);
    let mut token_offset = line_start;
    let mut i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        let (token_start, token_end) = (token_offset, token_offset + token.len());
        let test_line = format!("{cur}{token}");
        // single codepoints are cached: kerning doesn't apply between them
        let test_width = if is_single_character(token) {
            cur_width + char_width(m, token, font)
        } else {
            get_line_width(m, &test_line, font)
        };
        // build up the line; possibly trailing whitespace skips the check
        if token.chars().any(js_space) || test_width <= max_width {
            if cur.is_empty() {
                cur_start = token_start;
            }
            cur = test_line;
            cur_end = token_end;
            cur_width = test_width;
            token_offset = token_end;
            i += 1;
            continue;
        }
        if cur.is_empty() {
            // the token alone is wider than the line
            let mut wrapped = wrap_word(m, token, font, max_width, token_start);
            let trailing = wrapped.pop().unwrap_or(WrappedTextLine {
                text: String::new(),
                start: token_start,
                end: token_start,
            });
            lines.extend(wrapped);
            // the word's last line may still take the next tokens
            cur_width = get_line_width(m, &trailing.text, font);
            (cur, cur_start, cur_end) = (trailing.text, trailing.start, trailing.end);
            token_offset = token_end;
            i += 1;
        } else {
            // push and reset, and try the token again on the next line
            lines.push(trim_line_end_at_soft_break(&cur, cur_start, cur_end));
            cur.clear();
            (cur_start, cur_end, cur_width) = (token_start, token_start, 0.);
        }
    }
    if !cur.is_empty() {
        lines.push(trim_line(m, &cur, cur_start, cur_end, font, max_width));
    }
    lines
}

fn wrap_word(
    m: &dyn Measure,
    word: &str,
    font: Font,
    max_width: f64,
    word_start: usize,
) -> Vec<WrappedTextLine> {
    // emoji sequences are already split apart and don't split further
    if EMOJI_ANY.is_match(word) {
        return vec![WrappedTextLine {
            text: word.into(),
            start: word_start,
            end: word_start + word.len(),
        }];
    }
    debug_assert!(
        !word.chars().any(js_space),
        "Word should not contain any whitespaces!"
    );
    let mut lines = vec![];
    let mut cur = String::new();
    let (mut cur_start, mut cur_end, mut cur_width) = (word_start, word_start, 0.);
    let mut offset = word_start;
    for (i, c) in word.char_indices() {
        let ch = &word[i..i + c.len_utf8()];
        let (start, end) = (offset, offset + ch.len());
        let w = char_width(m, ch, font);
        offset = end;
        if cur_width + w <= max_width {
            if cur.is_empty() {
                cur_start = start;
            }
            cur.push_str(ch);
            cur_end = end;
            cur_width += w;
            continue;
        }
        if !cur.is_empty() {
            lines.push(WrappedTextLine {
                text: std::mem::take(&mut cur),
                start: cur_start,
                end: cur_end,
            });
        }
        cur.push_str(ch);
        (cur_start, cur_end, cur_width) = (start, end, w);
    }
    if !cur.is_empty() {
        lines.push(WrappedTextLine {
            text: cur,
            start: cur_start,
            end: cur_end,
        });
    }
    lines
}

/// `trimLine`: the last line of a hard line keeps the trailing whitespace
/// that still fits.
fn trim_line(
    m: &dyn Measure,
    line: &str,
    start: usize,
    end: usize,
    font: Font,
    max_width: f64,
) -> WrappedTextLine {
    if get_line_width(m, line, font) <= max_width {
        return WrappedTextLine {
            text: line.into(),
            start,
            end,
        };
    }
    // `/^(.+?)(\s+)$/`, else `trimEnd`
    let run = line.len() - js_trim_end(line).len();
    let first = line.chars().next().map_or(0, char::len_utf8);
    let split = (line.len() - run).max(first);
    let terminator = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let (mut trimmed, spaces) = if split < line.len() && !line[..split].chars().any(terminator) {
        (line[..split].to_owned(), &line[split..])
    } else {
        (js_trim_end(line).to_owned(), "")
    };
    let mut width = get_line_width(m, &trimmed, font);
    for (i, c) in spaces.char_indices() {
        let ch = &spaces[i..i + c.len_utf8()];
        let w = width + char_width(m, ch, font);
        if w > max_width {
            break;
        }
        trimmed.push_str(ch);
        width = w;
    }
    let end = end - (line.len() - trimmed.len());
    WrappedTextLine {
        text: trimmed,
        start,
        end,
    }
}

/// `trimLineEndAtSoftBreak`: no trailing whitespace before a soft break.
fn trim_line_end_at_soft_break(line: &str, start: usize, end: usize) -> WrappedTextLine {
    let trimmed = js_trim_end(line);
    WrappedTextLine {
        text: trimmed.into(),
        start,
        end: end - (line.len() - trimmed.len()),
    }
}
