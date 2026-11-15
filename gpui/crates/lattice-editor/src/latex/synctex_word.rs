//! Landing a reverse SyncTeX jump on the word that was double-clicked, not
//! only its line, as the Tauri app's `synctex-word.ts` does. SyncTeX answers
//! with a line, and a LaTeX paragraph is often one long source line, so the
//! clicked word is looked for in that line.
//!
//! The PDF's words are the source after TeX read it: command names, braces,
//! accents spelled `\'e`, `~` ties and `%` comments are gone, ligatures are
//! single glyphs, and a citation reads `[12]` where the source names a key.
//! Both sides are compared as runs of letters and digits, without accents
//! or case, and the source's markup is skipped while reading its words.
//!
//! One PDF line is usually a slice of the source line, so the clicked word
//! is told apart from its other occurrences by its neighbours first. Its
//! position among them settles a tie only when the PDF line holds the word
//! as often as the source line does; anything still ambiguous lands on the
//! line, as the jump always did.

use unicode_normalization::{UnicodeNormalization as _, char::is_combining_mark};

/// The word double-clicked in the PDF, with where it stands in its line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncTexWord {
    /// As both sides compare it (`word_key`).
    pub word: String,
    /// Which of the line's occurrences of it was clicked, from 0.
    pub occurrence: usize,
    /// How often the PDF line holds it.
    pub count: usize,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// One run of letters and digits; combining marks keep a decomposed accent
/// inside its word.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || is_combining_mark(c)
}

/// A word as both sides compare it: letters and digits, accents and case
/// dropped, ligatures spelled out.
fn word_key(text: &str) -> String {
    text.nfkd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
}

/// The word runs of `text`, as (start, end) byte offsets.
fn word_runs(text: &str) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut start = None;
    for (at, c) in text.char_indices() {
        match (is_word_char(c), start) {
            (true, None) => start = Some(at),
            (false, Some(from)) => {
                runs.push((from, at));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(from) = start {
        runs.push((from, text.len()));
    }
    runs
}

/// The word at byte `offset` in a line of PDF text, with where it stands in
/// the line; `None` when `offset` is on a space or punctuation.
pub fn clicked_word_in(line: &str, offset: usize) -> Option<SyncTexWord> {
    let words: Vec<(String, usize, usize)> = word_runs(line)
        .into_iter()
        .map(|(from, to)| (word_key(&line[from..to]), from, to))
        .filter(|(key, _, _)| !key.is_empty())
        .collect();
    let index = words
        .iter()
        .position(|(_, from, to)| offset >= *from && offset < *to)?;
    let key = words[index].0.clone();
    let same: Vec<usize> = (0..words.len()).filter(|ix| words[*ix].0 == key).collect();
    Some(SyncTexWord {
        occurrence: same.iter().position(|ix| *ix == index).unwrap_or(0),
        count: same.len(),
        before: index.checked_sub(1).map(|before| words[before].0.clone()),
        after: words.get(index + 1).map(|(key, _, _)| key.clone()),
        word: key,
    })
}

struct SourceWord {
    key: String,
    from: usize,
}

/// Control symbols that change a letter rather than separate words:
/// accents, `\-` (a hyphenation point).
fn in_word_symbol(c: Option<char>) -> bool {
    matches!(c, Some('\'' | '"' | '`' | '^' | '~' | '=' | '.' | '-'))
}

/// Accents spelled as one-letter commands: `Dvo\v{r}\'ak` is one word.
fn in_word_command(name: &str) -> bool {
    matches!(name, "u" | "v" | "H" | "c" | "d" | "b" | "t" | "r" | "k")
}

/// Commands whose argument is a key or a name, never text on the page:
/// what they print (a citation's number, a reference's label) is not in the
/// source.
fn key_argument(name: &str) -> bool {
    let letters = |s: &str| s.chars().all(|c| c.is_ascii_alphabetic());
    let cite = name
        .find("cite")
        .is_some_and(|at| letters(&name[..at]) && letters(&name[at + 4..]));
    let reference = name.strip_suffix("ref").is_some_and(letters);
    cite || reference
        || matches!(
            name,
            "label"
                | "begin"
                | "end"
                | "includegraphics"
                | "input"
                | "include"
                | "usepackage"
                | "documentclass"
                | "hspace"
                | "vspace"
                | "bibliography"
                | "bibliographystyle"
        )
}

/// Skip the balanced `open`…`close` group starting at `index`; the index
/// just past it.
fn skip_group(line: &[char], index: usize, open: char, close: char) -> usize {
    let mut depth = 0usize;
    let mut at = index;
    while at < line.len() {
        let c = line[at];
        if c == '\\' {
            at += 1;
        } else if c == open {
            depth += 1;
        } else if c == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return at + 1;
            }
        }
        at += 1;
    }
    line.len()
}

/// A key command's starred form, optional and required arguments, from just
/// past its name.
fn skip_key_arguments(line: &[char], index: usize) -> usize {
    let mut at = index;
    loop {
        while at < line.len() && (line[at] == ' ' || line[at] == '*') {
            at += 1;
        }
        match line.get(at) {
            Some('[') => at = skip_group(line, at, '[', ']'),
            Some('{') => return skip_group(line, at, '{', '}'),
            _ => return at,
        }
    }
}

/// The words a source line prints, each with the column (in chars) it
/// starts at.
fn source_words(line: &str) -> Vec<SourceWord> {
    let chars: Vec<char> = line.chars().collect();
    let mut words = Vec::new();
    let mut current: Option<(String, usize)> = None;
    let end = |current: &mut Option<(String, usize)>, words: &mut Vec<SourceWord>| {
        if let Some((text, from)) = current.take() {
            let key = word_key(&text);
            if !key.is_empty() {
                words.push(SourceWord { key, from });
            }
        }
    };
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if c == '%' {
            break;
        }
        if c == '\\' {
            let name: String = chars[index + 1..]
                .iter()
                .take_while(|c| c.is_ascii_alphabetic() || **c == '@')
                .collect();
            if name == "i" || name == "j" {
                // The dotless letters an accent sits on: `na\"{\i}ve`.
                current
                    .get_or_insert_with(|| (String::new(), index))
                    .0
                    .push_str(&name);
                index += 2;
            } else if !name.is_empty() {
                if !in_word_command(&name) {
                    end(&mut current, &mut words);
                }
                index += 1 + name.chars().count();
                if key_argument(&name) {
                    index = skip_key_arguments(&chars, index);
                }
            } else {
                // `\'e` and `hy\-phen` stay one word; `\%`, `\&` and `\\`
                // separate.
                if !in_word_symbol(chars.get(index + 1).copied()) {
                    end(&mut current, &mut words);
                }
                index += 2;
            }
            continue;
        }
        // Braces only group: `\'{e}` and `{\em word}` read as plain letters.
        if c == '{' || c == '}' {
            index += 1;
            continue;
        }
        if is_word_char(c) {
            current
                .get_or_insert_with(|| (String::new(), index))
                .0
                .push(c);
        } else {
            end(&mut current, &mut words);
        }
        index += 1;
    }
    end(&mut current, &mut words);
    words
}

/// The column (in chars) in source `line` where the clicked `word` starts,
/// or `None` when it is not there or its occurrences cannot be told apart.
pub fn source_column_for_word(line: &str, word: &SyncTexWord) -> Option<usize> {
    let words = source_words(line);
    let candidates: Vec<usize> = (0..words.len())
        .filter(|ix| words[*ix].key == word.word)
        .collect();
    match candidates.as_slice() {
        [] => return None,
        [only] => return Some(words[*only].from),
        _ => {}
    }
    let score = |index: usize| {
        let before = word.before.as_ref().is_some_and(|before| {
            index
                .checked_sub(1)
                .is_some_and(|ix| &words[ix].key == before)
        });
        let after = word
            .after
            .as_ref()
            .is_some_and(|after| words.get(index + 1).is_some_and(|w| &w.key == after));
        usize::from(before) + usize::from(after)
    };
    let best = candidates.iter().map(|ix| score(*ix)).max().unwrap_or(0);
    let top: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|ix| score(*ix) == best)
        .collect();
    if best > 0 && top.len() == 1 {
        return Some(words[top[0]].from);
    }
    // The PDF line and the source line hold the word equally often: they
    // are most likely the same text, so its place among them is its place
    // here.
    let by_position = (candidates.len() == word.count)
        .then(|| candidates.get(word.occurrence).copied())
        .flatten();
    by_position
        .filter(|ix| score(*ix) == best)
        .map(|ix| words[ix].from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clicked_word_carries_its_neighbours_and_place() {
        let word = clicked_word_in("the model and the data", 15).unwrap();
        assert_eq!(word.word, "the");
        assert_eq!((word.occurrence, word.count), (1, 2));
        assert_eq!(word.before.as_deref(), Some("and"));
        assert_eq!(word.after.as_deref(), Some("data"));
        assert_eq!(clicked_word_in("a, b", 1), None);
    }

    #[test]
    fn accents_ligatures_and_case_compare_alike() {
        let word = clicked_word_in("Dvořák’s ﬁnal", 0).unwrap();
        assert_eq!(word.word, "dvorak");
        let line = r"As \textit{Dvo\v{r}\'ak} wrote, the \emph{final} result";
        assert_eq!(source_column_for_word(line, &word), Some(11));
        let fin = clicked_word_in("ﬁnal result", 0).unwrap();
        assert_eq!(fin.word, "final");
        assert_eq!(source_column_for_word(line, &fin), Some(42));
    }

    #[test]
    fn markup_and_keys_are_not_words() {
        let line = r"See \citep{the2020} and the result~\ref{fig:the} % the comment";
        let word = SyncTexWord {
            word: "the".into(),
            occurrence: 0,
            count: 1,
            before: Some("and".into()),
            after: Some("result".into()),
        };
        assert_eq!(source_column_for_word(line, &word), Some(24));
    }

    #[test]
    fn an_ambiguous_word_lands_on_the_line() {
        let word = SyncTexWord {
            word: "a".into(),
            occurrence: 0,
            count: 1,
            before: None,
            after: None,
        };
        assert_eq!(source_column_for_word("a b a c a", &word), None);
        let same = SyncTexWord {
            count: 3,
            occurrence: 1,
            ..word
        };
        assert_eq!(source_column_for_word("a b a c a", &same), Some(4));
    }
}
