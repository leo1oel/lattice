//! Where a paper dropped into a source editor goes, and what goes in: the
//! Tauri app's `latexCitationDrop` (`src/editor/paper-drop.ts`) and
//! `paperMarkdownCitation` (`src/papers/paper-drag.ts`), as pure functions
//! over the text near the drop.
//!
//! - In LaTeX a citation snaps past the word under or before the pointer,
//!   never inside it or after the space that follows it, and goes in as
//!   `\citep{key}`, tied to the text it follows.
//! - A drop on (or just past) a live citation command's key list joins that
//!   list at the nearest key boundary, once; a commented-out command is
//!   prose.
//! - In Markdown it is an `@key` label, a link to the paper's reading file
//!   when the library holds its text.
//!
//! Offsets are bytes of the text given, where the Tauri app counts UTF-16
//! units: a key boundary's midpoint is the only place the two can differ,
//! and only for a non-ASCII key.

use std::{ops::Range, sync::LazyLock};

use lattice_core::papers::PaperSummary;
use regex::Regex;

/// One edit: `insert` over `range` of the text given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CitationEdit {
    pub range: Range<usize>,
    pub insert: String,
}

/// Letters of scripts that separate words with spaces; Chinese or Japanese
/// prose has no word to snap to.
static WORD_CHARACTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}]$")
        .expect("the word pattern compiles")
});

static CITATION_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\\(?:[Cc]ite(?:p|t|alp|alt|author|year(?:par)?|num|url)?|[Pp]arencite|[Tt]extcite|[Aa]utocite|[Ff]ootcite|[Ss]martcite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)\}",
    )
    .expect("the citation pattern compiles")
});

/// An unescaped `%` before a command on its line comments it out.
static COMMENTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[^\\])(?:\\\\)*%").expect("the comment pattern compiles"));

static KEY_PART: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^,\s]+").expect("the key pattern compiles"));

fn char_at(source: &str, index: usize) -> Option<char> {
    source.get(index..)?.chars().next()
}

fn char_before(source: &str, index: usize) -> Option<char> {
    source.get(..index)?.chars().next_back()
}

fn is_word(character: Option<char>) -> bool {
    character.is_some_and(|character| {
        let mut buffer = [0u8; 4];
        WORD_CHARACTER.is_match(character.encode_utf8(&mut buffer))
    })
}

/// Where a citation dropped into prose goes: after the word under or before
/// the pointer, never inside it or after the space that follows it. A drop
/// at the start of the next word ("word |next") otherwise came out as
/// "word ~\citep{key}next": a doubled space before the tie and the citation
/// glued to the following word.
fn prose_citation_point(source: &str, position: usize) -> usize {
    let mut point = position;
    while is_word(char_before(source, point)) && is_word(char_at(source, point)) {
        point += char_at(source, point).map_or(1, char::len_utf8);
    }
    while matches!(char_before(source, point), Some(' ' | '\t')) {
        point -= 1;
    }
    point
}

/// The key list `range` of a citation command, with the key boundary `index`
/// a new key joins at, at offset `at`.
struct CitationList {
    range: Range<usize>,
    keys: Vec<String>,
    index: usize,
    at: usize,
}

/// The key list of a live citation command at `position`, split at the
/// nearest key boundary.
fn citation_list(source: &str, position: usize) -> Option<CitationList> {
    for found in CITATION_COMMAND.captures_iter(source) {
        let whole = found.get(0)?;
        let (start, end) = (whole.start(), whole.end());
        // Both halves of the closing brace must merge: coordinate hit-testing
        // can resolve its right half to the boundary immediately after it.
        if position < start || position > end {
            continue;
        }
        // A commented-out command must not absorb a citation dropped in prose.
        let line_start = source[..start].rfind('\n').map_or(0, |at| at + 1);
        if COMMENTED.is_match(&source[line_start..start]) {
            continue;
        }
        let list = found.get(1)?;
        let from = list.start();
        let parts: Vec<_> = KEY_PART.find_iter(list.as_str()).collect();
        let offset = position as isize - from as isize;
        // Before a key's middle, the boundary before it.
        let found = parts
            .iter()
            .position(|part| 2 * offset <= (2 * part.start() + part.len()) as isize);
        let index = found.unwrap_or(parts.len());
        let at = from
            + match (found, parts.last()) {
                (Some(found), _) => parts[found].start(),
                (None, Some(last)) => last.end(),
                (None, None) => 0,
            };
        return Some(CitationList {
            range: from..list.end(),
            keys: parts.iter().map(|part| part.as_str().to_string()).collect(),
            index,
            at,
        });
    }
    None
}

/// Where a citation dropped at `drop` goes: a citation list there or just
/// before it, else a word end.
fn latex_citation_point(source: &str, drop: usize) -> (usize, Option<CitationList>) {
    if let Some(list) = citation_list(source, drop) {
        return (list.at, Some(list));
    }
    let position = prose_citation_point(source, drop);
    // A drop just past a citation and its space joins that citation.
    let adjacent = (position != drop)
        .then(|| citation_list(source, position))
        .flatten();
    match adjacent {
        Some(list) => (list.at, Some(list)),
        None => (position, None),
    }
}

/// Whether `key` can be written into a citation as it stands.
fn writable_key(key: &str) -> bool {
    !key.is_empty()
        && !key
            .chars()
            .any(|character| character.is_whitespace() || ",{}\\%".contains(character))
}

/// The edit that cites `key` in LaTeX `source` dropped at byte `drop`:
/// snapped to a key boundary instead of splitting a key under the pointer,
/// or `None` when it inserts nothing (the key is already there, or is not
/// one a citation can hold).
pub fn latex_citation_drop(source: &str, drop: usize, key: &str) -> Option<CitationEdit> {
    if !writable_key(key) || !source.is_char_boundary(drop.min(source.len())) {
        return None;
    }
    let drop = drop.min(source.len());
    let (at, list) = latex_citation_point(source, drop);
    if let Some(list) = list {
        if list.keys.iter().any(|existing| existing == key) {
            return None;
        }
        let mut keys: Vec<&str> = Vec::new();
        let ordered = list.keys[..list.index]
            .iter()
            .map(String::as_str)
            .chain([key])
            .chain(list.keys[list.index..].iter().map(String::as_str));
        for each in ordered {
            if !keys.contains(&each) {
                keys.push(each);
            }
        }
        return Some(CitationEdit {
            range: list.range,
            insert: keys.join(", "),
        });
    }
    // A tie binds the citation to the text it follows; at the start of a
    // line there is nothing to bind, and a word right after needs its space
    // back.
    let tie = char_before(source, at)
        .is_some_and(|before| !before.is_whitespace() && !"([{".contains(before));
    let space = is_word(char_at(source, at));
    Some(CitationEdit {
        range: at..at,
        insert: format!(
            "{}\\citep{{{key}}}{}",
            if tie { "~" } else { "" },
            if space { " " } else { "" }
        ),
    })
}

/// Where the drop caret goes for `key` dropped at byte `drop` of LaTeX
/// `source`: where [`latex_citation_drop`] puts it, or `None` when that drop
/// inserts nothing.
pub fn latex_citation_caret(source: &str, drop: usize, key: &str) -> Option<usize> {
    latex_citation_drop(source, drop, key)?;
    Some(latex_citation_point(source, drop.min(source.len())).0)
}

/// The paper's reading file from a note at `path` (project-relative):
/// relative, so the link stays a plain Markdown link any tool resolves
/// (`paperLinkHref`).
pub fn paper_link_href(path: &str, paper: &PaperSummary) -> String {
    let depth = path
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .count()
        .saturating_sub(1);
    let file = if paper.has_full_text { "paper" } else { "blog" };
    format!(
        "{}.research/papers/{}/{file}.md",
        "../".repeat(depth),
        paper.arxiv_id
    )
}

/// What a paper dropped into the Markdown source at `path` writes: its
/// `@key` (the title without a key), Markdown's specials escaped, linked to
/// its reading file when the library holds its text or overview.
pub fn markdown_citation(path: &str, paper: &PaperSummary) -> String {
    let name = paper
        .citation_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .unwrap_or(&paper.title);
    let mut label = String::from("@");
    for character in name.chars() {
        if "\\[]*_`".contains(character) {
            label.push('\\');
        }
        label.push(character);
    }
    if !paper.arxiv_id.is_empty() && (paper.has_full_text || paper.has_blog) {
        format!("[{label}]({})", paper_link_href(path, paper))
    } else {
        label
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `marked` with its `|` the drop point, after dropping `key` there: the
    /// Tauri app's `drop` helper in `src/papers/paper-drag.test.ts`.
    fn drop_with(marked: &str, key: &str) -> String {
        let position = marked.find('|').expect("a drop point");
        let source = marked.replacen('|', "", 1);
        match latex_citation_drop(&source, position, key) {
            Some(edit) => format!(
                "{}{}{}",
                &source[..edit.range.start],
                edit.insert,
                &source[edit.range.end..]
            ),
            None => source,
        }
    }

    fn drop(marked: &str) -> String {
        drop_with(marked, "new2026")
    }

    // The Tauri app's table, case for case.
    #[test]
    fn a_citation_goes_in_atomically_where_the_tauri_app_puts_it() {
        for (source, expected) in [
            ("Before| after", "Before~\\citep{new2026} after"),
            ("\\ci|tep{alpha,beta}", "\\citep{new2026, alpha, beta}"),
            ("\\citep|{alpha,beta}", "\\citep{new2026, alpha, beta}"),
            ("\\citep{|alpha,beta}", "\\citep{new2026, alpha, beta}"),
            ("\\citep{a|lpha,beta}", "\\citep{new2026, alpha, beta}"),
            ("\\citep{alph|a,beta}", "\\citep{alpha, new2026, beta}"),
            ("\\citep{alpha,|beta}", "\\citep{alpha, new2026, beta}"),
            ("\\citep{alpha,beta|}", "\\citep{alpha, beta, new2026}"),
            ("\\citep{alpha,beta}|", "\\citep{alpha, beta, new2026}"),
            ("\\citep{alpha,beta} |", "\\citep{alpha, beta, new2026} "),
            // Prose drops land after the word, never inside it or past its space.
            ("Before |after", "Before~\\citep{new2026} after"),
            ("Bef|ore after", "Before~\\citep{new2026} after"),
            ("Before\t |after", "Before~\\citep{new2026}\t after"),
            ("Model (|ours)", "Model (\\citep{new2026} ours)"),
            (
                "Line one\n|Next line",
                "Line one\n\\citep{new2026} Next line",
            ),
            ("|Start", "\\citep{new2026} Start"),
            ("Prior work|.", "Prior work~\\citep{new2026}."),
            ("注意力|机制", "注意力~\\citep{new2026}机制"),
            (
                "\\citep[see][p. 7]{alpha, |beta}",
                "\\citep[see][p. 7]{alpha, new2026, beta}",
            ),
            ("\\citep*{|}", "\\citep*{new2026}"),
            (
                "\\textcite{alpha,, |beta,alpha,}",
                "\\textcite{alpha, new2026, beta}",
            ),
            (
                "\\citep{alpha}\n\\citep{be|ta}",
                "\\citep{alpha}\n\\citep{new2026, beta}",
            ),
        ] {
            assert_eq!(drop(source), expected, "dropped at {source:?}");
        }
    }

    #[test]
    fn a_key_is_never_doubled_nor_invented() {
        assert_eq!(
            drop_with("\\citep{al|pha, beta}", "beta"),
            "\\citep{alpha, beta}"
        );
        for key in ["", "bad key", "bad,key", "bad}key"] {
            assert_eq!(drop_with("before|after", key), "beforeafter", "{key:?}");
        }
    }

    #[test]
    fn a_commented_command_is_not_a_live_citation() {
        assert_eq!(
            drop("% \\citep{alpha|}"),
            "% \\citep{alpha~\\citep{new2026}}"
        );
        assert_eq!(drop("\\% \\citep{alpha|}"), "\\% \\citep{alpha, new2026}");
    }

    // `src/editor/paper-drop.test.ts`: the editor's own document and drops.
    #[test]
    fn the_editor_merges_at_the_pointer_or_cites_after_the_word() {
        let source = "See \\citep{older,later}.";
        let edit = latex_citation_drop(source, 16, "attention2017").unwrap();
        let mut merged = source.to_string();
        merged.replace_range(edit.range, &edit.insert);
        assert_eq!(merged, "See \\citep{older, attention2017, later}.");
        let edit = latex_citation_drop(source, 3, "attention2017").unwrap();
        let mut cited = source.to_string();
        cited.replace_range(edit.range, &edit.insert);
        assert_eq!(cited, "See~\\citep{attention2017} \\citep{older,later}.");
    }

    #[test]
    fn the_caret_shows_where_the_citation_goes() {
        // After the word, not inside it; at the key boundary of a list.
        assert_eq!(latex_citation_caret("Before after", 3, "k"), Some(6));
        assert_eq!(latex_citation_caret("\\citep{alpha,beta}", 9, "k"), Some(7));
        assert_eq!(latex_citation_caret("\\citep{alpha,beta}", 9, "beta"), None);
        assert_eq!(latex_citation_caret("Before after", 3, ""), None);
    }

    fn paper() -> PaperSummary {
        serde_json::from_value(serde_json::json!({
            "arxivId": "1706.03762",
            "title": "Attention [revisited]",
            "authors": "",
            "citationKey": "vaswani2017",
            "hasFullText": true,
            "hasBlog": false,
            "hasLocalPdf": false,
        }))
        .expect("a paper")
    }

    #[test]
    fn markdown_takes_an_at_label_linked_to_the_reading_file() {
        let paper = paper();
        assert_eq!(
            markdown_citation("notes/nested/test.md", &paper),
            "[@vaswani2017](../../.research/papers/1706.03762/paper.md)"
        );
        let unsaved = PaperSummary {
            arxiv_id: String::new(),
            has_full_text: false,
            ..paper.clone()
        };
        assert_eq!(markdown_citation("test.md", &unsaved), "@vaswani2017");
        let keyless = PaperSummary {
            citation_key: None,
            ..paper.clone()
        };
        assert_eq!(
            markdown_citation("test.md", &keyless),
            "[@Attention \\[revisited\\]](.research/papers/1706.03762/paper.md)"
        );
        // `paper-drop.test.ts`'s note, one folder down.
        let attention = PaperSummary {
            citation_key: Some("attention2017".into()),
            ..paper
        };
        assert_eq!(
            markdown_citation("notes/note.md", &attention),
            "[@attention2017](../.research/papers/1706.03762/paper.md)"
        );
    }
}
