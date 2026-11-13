//! An opened version read as prose, ported from the Tauri app's
//! `src/history/version-prose.ts` and `src/components/ui/inline-edit-spans.ts`:
//! the passages of a file that changed, each with its edits, so a version
//! reads in the reading font the way a proofread does rather than as a code
//! diff whose sentence-long lines clip; how many prose words they add and
//! remove; the section a line sits in; and the spans an edit is drawn over.
//!
//! Offsets are byte offsets (the Tauri app's are UTF-16 code units), and the
//! size limits are read in bytes, which only moves where a very large change
//! falls back to its source diff.

use std::sync::LazyLock;

use regex::Regex;

use super::words::{Hunk, phrase_hunks};

/// One edit of a passage: replace `[from, to)` of its text with `insert`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineEdit {
    pub id: usize,
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProsePassage {
    /// The line the passage starts on in the version itself (1-based).
    pub line: usize,
    pub text: String,
    pub edits: Vec<InlineEdit>,
    /// The passage is cut out of a longer paragraph at a sentence edge.
    pub clipped_start: bool,
    pub clipped_end: bool,
}

/// Files whose text reads as prose; anything else opens on its source diff.
pub fn is_prose_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".tex", ".ltx", ".md", ".markdown", ".txt", ".bib"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

/// Past these a change is a rewrite, better read as its source diff.
const MAX_TEXT: usize = 400_000;
const MAX_EDITS: usize = 400;
const MAX_PASSAGE: usize = 2_400;
/// A changed paragraph longer than this is cut to the sentences around its edits.
const LONG_PASSAGE: usize = 640;

fn is_sentence_end(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '。' | '！' | '？' | '；' | ';')
}

/// The byte just past each sentence end in `text`: a mark followed by space or the end.
fn sentence_ends(text: &str) -> impl Iterator<Item = usize> + '_ {
    let mut chars = text.char_indices().peekable();
    std::iter::from_fn(move || {
        while let Some((at, c)) = chars.next() {
            if is_sentence_end(c) && chars.peek().is_none_or(|(_, next)| next.is_whitespace()) {
                return Some(at + c.len_utf8());
            }
        }
        None
    })
}

fn floor_boundary(text: &str, mut at: usize) -> usize {
    at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// Where the sentence holding `offset` starts within `text`.
fn sentence_start(text: &str, offset: usize) -> usize {
    let offset = floor_boundary(text, offset);
    let mut start = sentence_ends(&text[..offset]).last().unwrap_or(0);
    while start < offset {
        let Some(c) = text[start..].chars().next() else {
            break;
        };
        if !c.is_whitespace() {
            break;
        }
        start += c.len_utf8();
    }
    start
}

/// Where the sentence holding `offset` ends within `text`.
fn sentence_end(text: &str, offset: usize) -> usize {
    let offset = floor_boundary(text, offset);
    sentence_ends(&text[offset..])
        .next()
        .map_or(text.len(), |end| offset + end)
}

/// The passages of `before` that `after` changed: whole source lines (a TeX
/// paragraph is usually one), joined where their edits meet, cut to the
/// changed sentences when a paragraph runs long. None when the change is too
/// large to read this way.
pub fn prose_passages(before: &str, after: &str) -> Option<Vec<ProsePassage>> {
    if before.len() + after.len() > MAX_TEXT {
        return None;
    }
    let hunks = phrase_hunks(before, after);
    if hunks.len() > MAX_EDITS {
        return None;
    }

    struct Range<'a> {
        from: usize,
        to: usize,
        hunks: Vec<&'a Hunk>,
    }
    let mut ranges: Vec<Range> = Vec::new();
    for hunk in &hunks {
        let from = before[..hunk.from].rfind('\n').map_or(0, |at| at + 1);
        let search = if hunk.to > hunk.from && before.as_bytes()[hunk.to - 1] == b'\n' {
            hunk.to - 1
        } else {
            hunk.to
        };
        let line_end = before[search..].find('\n').map(|at| search + at);
        let to = hunk.to.max(line_end.unwrap_or(before.len()));
        match ranges.last_mut() {
            Some(last) if from <= last.to + 1 => {
                last.to = last.to.max(to);
                last.hunks.push(hunk);
            }
            _ => ranges.push(Range {
                from,
                to,
                hunks: vec![hunk],
            }),
        }
    }

    let mut shift: isize = 0;
    let mut consumed = 0;
    let mut passages = Vec::with_capacity(ranges.len());
    for range in ranges {
        let (mut from, mut to) = (range.from, range.to);
        let first = range.hunks[0];
        let last = range.hunks[range.hunks.len() - 1];
        let (mut clipped_start, mut clipped_end) = (false, false);
        if to - from > LONG_PASSAGE {
            let paragraph = &before[from..to];
            let start = from + sentence_start(paragraph, first.from - from);
            let end = from + sentence_end(paragraph, (last.to - from).saturating_sub(1));
            clipped_start = start > from;
            clipped_end = end < to;
            from = start;
            to = end;
        }
        if to - from > MAX_PASSAGE {
            return None;
        }
        // Where the passage starts in the version: earlier edits moved it by
        // their difference in length.
        for hunk in &hunks[consumed..] {
            if hunk.from >= from {
                break;
            }
            shift += hunk.insert.len() as isize - (hunk.to - hunk.from) as isize;
            consumed += 1;
        }
        let at = floor_boundary(after, (from as isize + shift).max(0) as usize);
        let line = after[..at].matches('\n').count() + 1;
        passages.push(ProsePassage {
            line,
            text: before[from..to].to_string(),
            edits: range
                .hunks
                .iter()
                .enumerate()
                .map(|(id, hunk)| InlineEdit {
                    id,
                    from: hunk.from - from,
                    to: hunk.to - from,
                    insert: hunk.insert.clone(),
                })
                .collect(),
            clipped_start,
            clipped_end,
        });
    }
    Some(passages)
}

const CJK: &str = r"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]";

/// Each Han, kana or Hangul character is one word, as a CJK count reads;
/// otherwise a run of letters or digits is.
static WORD: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
    let letters = format!(r"(?:(?!{CJK})[\p{{L}}\p{{M}}\p{{N}}])+");
    fancy_regex::Regex::new(&format!(r"{CJK}|{letters}(?:['’-]{letters})*"))
        .expect("the word pattern compiles")
});

static CJK_CHARACTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(CJK).expect("the CJK pattern compiles"));

fn words(text: &str) -> usize {
    WORD.find_iter(text).filter(Result::is_ok).count()
}

/// What is not prose: comments, control sequences, and the arguments of the
/// commands that name rather than say (citations, references, labels,
/// environments, files).
static MARKUP: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
    fancy_regex::Regex::new(
        r"(?<!\\)%.*|\\(?:[A-Za-z]*cite[A-Za-z]*|[A-Za-z]*ref|label|begin|end|input[A-Za-z]*|include[A-Za-z]*|graphicspath|usepackage|documentclass|bibliography|bibliographystyle)\*?(?:[ \t]*(?:\[[^\]]*\]|\{(?:[^{}]|\{[^{}]*\})*\}))+|\\(?:[A-Za-z@]+\*?|.)",
    )
    .expect("the markup pattern compiles")
});

/// `text` with its markup blanked out, keeping every offset where it was.
fn prose_only(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for found in MARKUP.find_iter(text).flatten() {
        out.push_str(&text[cursor..found.start()]);
        out.extend(std::iter::repeat_n(' ', found.end() - found.start()));
        cursor = found.end();
    }
    out.push_str(&text[cursor..]);
    out
}

/// `removed` and `inserted` without the CJK characters they share at either
/// end: the diff takes an unspaced CJK run as one token, so one changed
/// character replaces the whole run.
fn differing(removed: &str, inserted: &str) -> (String, String) {
    let a: Vec<char> = removed.chars().collect();
    let b: Vec<char> = inserted.chars().collect();
    let shared = |x: Option<&char>, y: Option<&char>| matches!((x, y), (Some(x), Some(y)) if x == y && CJK_CHARACTER.is_match(&x.to_string()));
    let mut start = 0;
    while shared(a.get(start), b.get(start)) {
        start += 1;
    }
    let mut end = 0;
    while end < a.len().min(b.len()).saturating_sub(start)
        && shared(a.get(a.len() - 1 - end), b.get(b.len() - 1 - end))
    {
        end += 1;
    }
    (
        a[start..a.len() - end].iter().collect(),
        b[start..b.len() - end].iter().collect(),
    )
}

/// How many prose words the passages' edits add and remove. Each side is
/// read whole, so an edit inside a citation or a comment counts nothing.
pub fn changed_words(passages: &[ProsePassage]) -> (usize, usize) {
    let (mut added, mut removed) = (0, 0);
    for passage in passages {
        let before = prose_only(&passage.text);
        let mut after = String::new();
        let mut cursor = 0;
        let mut inserted = Vec::with_capacity(passage.edits.len());
        for edit in &passage.edits {
            after.push_str(&passage.text[cursor..edit.from]);
            inserted.push((after.len(), after.len() + edit.insert.len()));
            after.push_str(&edit.insert);
            cursor = edit.to;
        }
        after.push_str(&passage.text[cursor..]);
        let prose = prose_only(&after);
        for (edit, (from, to)) in passage.edits.iter().zip(inserted) {
            let (gone, made) = differing(&before[edit.from..edit.to], &prose[from..to]);
            removed += words(&gone);
            added += words(&made);
        }
    }
    (added, removed)
}

static SECTIONING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(section|subsection|subsubsection)(\*?)\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}")
        .expect("the sectioning pattern compiles")
});
static TITLE_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\[A-Za-z]+\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}")
        .expect("the title command pattern compiles")
});
static TITLE_MARKUP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\[A-Za-z]+\*?|[{}~]").expect("the title markup pattern compiles")
});
static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("the spaces pattern compiles"));
static COMMENTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[^\\])%").expect("the comment pattern compiles"));

/// A heading's text without its markup: `\emph{Fast} attention` reads "Fast attention".
fn plain_title(title: &str) -> String {
    let unwrapped = TITLE_COMMAND.replace_all(title, "$1");
    let bare = TITLE_MARKUP.replace_all(&unwrapped, " ");
    SPACES.replace_all(&bare, " ").trim().to_string()
}

/// The section line `line` (1-based) of `source` sits in, numbered as LaTeX
/// numbers it ("§3.2 Training"); an unnumbered one by its title alone. None
/// before the first heading.
pub fn section_at(source: &str, line: usize) -> Option<String> {
    let mut counters = [0usize; 3];
    let mut found = None;
    let mut line_at = 1;
    let mut scanned = 0;
    for captures in SECTIONING.captures_iter(source) {
        let whole = captures.get(0).expect("a match has its whole");
        line_at += source[scanned..whole.start()].matches('\n').count();
        scanned = whole.start();
        if line_at > line {
            break;
        }
        // A commented-out heading is not one.
        let line_start = source[..whole.start()].rfind('\n').map_or(0, |at| at + 1);
        if COMMENTED.is_match(&source[line_start..whole.start()]) {
            continue;
        }
        let level = match &captures[1] {
            "section" => 0,
            "subsection" => 1,
            _ => 2,
        };
        let title = plain_title(&captures[3]);
        if !captures[2].is_empty() {
            found = Some(title);
            continue;
        }
        counters[level] += 1;
        for counter in &mut counters[level + 1..] {
            *counter = 0;
        }
        let number = counters[..=level]
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(".");
        found = Some(format!("§{number} {title}"));
    }
    found
}

/// The words between two edits that join them into one: spaces, or one
/// short word ("a", "the", "of").
fn joining_gap(gap: &str) -> bool {
    let trimmed = gap.trim();
    trimmed.is_empty()
        || (trimmed.chars().count() <= 3 && trimmed.chars().all(|c| c.is_alphanumeric()))
}

/// `passage` as a person would mark it: edits that only a space or a short
/// shared word keep apart join into one, so a rewritten phrase reads as one
/// struck run followed by one new run rather than alternating fragments.
pub fn joined_passage(passage: &ProsePassage) -> ProsePassage {
    let mut edits: Vec<InlineEdit> = Vec::with_capacity(passage.edits.len());
    for edit in &passage.edits {
        match edits.last_mut() {
            Some(last) if joining_gap(&passage.text[last.to..edit.from]) => {
                let gap = &passage.text[last.to..edit.from];
                last.insert = format!("{}{gap}{}", last.insert, edit.insert);
                last.to = edit.to;
            }
            _ => edits.push(InlineEdit {
                id: edits.len(),
                ..edit.clone()
            }),
        }
    }
    ProsePassage {
        edits,
        ..passage.clone()
    }
}

/// An edit as it is drawn: the span of the passage it covers, widened to
/// whole words, the words there now and the words it puts there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineEditSpan {
    pub from: usize,
    pub to: usize,
    pub deleted: String,
    pub inserted: String,
}

/// How far an edit that cuts into a word widens to show the whole word.
const WORD_LIMIT: usize = 32;

fn is_word_char(c: Option<char>) -> bool {
    c.is_some_and(|c| !c.is_whitespace())
}

/// `edits` in order, each widened to whole words when it cuts into one, so
/// `␣of␣the␣` → `-of-the-` reads as `state of the art` → `state-of-the-art`,
/// but never into a neighbouring edit's span.
pub fn inline_edit_spans(text: &str, edits: &[InlineEdit]) -> Vec<InlineEditSpan> {
    let mut sorted: Vec<&InlineEdit> = edits.iter().collect();
    sorted.sort_by_key(|edit| edit.from);
    let mut spans: Vec<InlineEditSpan> = Vec::with_capacity(sorted.len());
    for (index, edit) in sorted.iter().enumerate() {
        let floor = spans.last().map_or(0, |span| span.to);
        let ceiling = sorted.get(index + 1).map_or(text.len(), |next| next.from);
        let deleted = &text[edit.from..edit.to];
        let (mut from, mut to) = (edit.from, edit.to);
        if is_word_char(deleted.chars().next()) || is_word_char(edit.insert.chars().next()) {
            let mut steps = 0;
            while from > floor && steps < WORD_LIMIT {
                let Some(c) = text[..from].chars().last() else {
                    break;
                };
                if c.is_whitespace() {
                    break;
                }
                from -= c.len_utf8();
                steps += 1;
            }
        }
        if is_word_char(deleted.chars().last()) || is_word_char(edit.insert.chars().last()) {
            let mut steps = 0;
            while to < ceiling && steps < WORD_LIMIT {
                let Some(c) = text[to..].chars().next() else {
                    break;
                };
                if c.is_whitespace() {
                    break;
                }
                to += c.len_utf8();
                steps += 1;
            }
        }
        spans.push(InlineEditSpan {
            from,
            to,
            deleted: text[from..to].to_string(),
            inserted: format!(
                "{}{}{}",
                &text[from..edit.from],
                edit.insert,
                &text[edit.to..to]
            ),
        });
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_the_prose_words_edits_add_and_remove() {
        let passages = prose_passages(
            "Attention maps explain predictions. 注意力图解释预测。\n",
            "Attention maps describe routing weights. 注意力图描述权重。\n",
        )
        .unwrap();
        assert_eq!(changed_words(&passages), (3 + 4, 2 + 4));
        assert_eq!(
            changed_words(
                &prose_passages("我们提出了一种新的方法。\n", "我们提出了一种更好的方法。\n")
                    .unwrap()
            ),
            (2, 1)
        );
        let added = prose_passages(
            "Intro.\n",
            "Intro.\n\nnaïve Gödel’s Ελληνικά слово かな 한글\n",
        )
        .unwrap();
        assert_eq!(changed_words(&added), (4 + 2 + 2, 0));
        let cited = prose_passages(
            "Attention helps.\n",
            "Attention helps~\\cite{vaswani2017attention} (see \\eqref{eq:attn}), \\emph{a lot}. % TODO cut\n",
        )
        .unwrap();
        assert_eq!(changed_words(&cited), (3, 0));
        let rekeyed = prose_passages(
            "As shown~\\cite{bahdanau2015neural}.\n",
            "As shown~\\cite{luong2015effective}.\n",
        )
        .unwrap();
        assert_eq!(changed_words(&rekeyed), (0, 0));
        let figure = prose_passages(
            "Results.\n",
            "Results.\n\\begin{figure}[t]\n\\includegraphics[width=0.5\\linewidth]{figures/attn.pdf}\n\\caption{Attention maps.}\n\\end{figure}\n\\begin{tabular}{lcc} x \\end{tabular}\n\\input{sections/intro}\n",
        )
        .unwrap();
        assert_eq!(changed_words(&figure), (3, 0));
    }

    #[test]
    fn names_a_lines_section_as_latex_numbers_it() {
        let source = [
            "\\section{Introduction}",
            "Text.",
            "\\subsection[Short]{Fast \\emph{exact} attention}",
            "% \\section{Commented out}",
            "Text.",
            "\\section*{Acknowledgements}",
            "Thanks.",
            "\\section{Method}",
            "Text.",
        ]
        .join("\n");
        assert_eq!(section_at(&source, 2).as_deref(), Some("§1 Introduction"));
        assert_eq!(
            section_at(&source, 5).as_deref(),
            Some("§1.1 Fast exact attention")
        );
        assert_eq!(section_at(&source, 7).as_deref(), Some("Acknowledgements"));
        assert_eq!(section_at(&source, 9).as_deref(), Some("§2 Method"));
        assert_eq!(section_at("Preamble text.\n\\section{Later}\n", 1), None);
    }

    #[test]
    fn joins_edits_only_a_space_or_a_short_word_keeps_apart() {
        let passages = prose_passages(
            "A decoder could look at encoder states of a source sentence.\n",
            "A decoder could retrieve different encoder states of an entire source sentence.\n",
        )
        .unwrap();
        let passage = &passages[0];
        let joined = joined_passage(passage);
        let read: Vec<(&str, &str)> = joined
            .edits
            .iter()
            .map(|edit| (&passage.text[edit.from..edit.to], edit.insert.as_str()))
            .collect();
        assert_eq!(
            read,
            vec![("look at", "retrieve different"), ("a", "an entire")]
        );
        assert_eq!(
            joined.edits.iter().map(|edit| edit.id).collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[test]
    fn a_passage_names_its_line_in_the_version() {
        let passages =
            prose_passages("One.\nTwo.\nThree.\n", "Zero.\nOne.\nTwo.\nThree!\n").unwrap();
        assert_eq!(
            passages
                .iter()
                .map(|passage| passage.line)
                .collect::<Vec<_>>(),
            vec![1, 4]
        );
    }

    #[test]
    fn spans_widen_to_whole_words() {
        let text = "state of the art";
        let edits = [InlineEdit {
            id: 0,
            from: 5,
            to: 13,
            insert: "-of-the-".into(),
        }];
        let spans = inline_edit_spans(text, &edits);
        assert_eq!(spans[0].deleted, "state of the art");
        assert_eq!(spans[0].inserted, "state-of-the-art");
    }
}
