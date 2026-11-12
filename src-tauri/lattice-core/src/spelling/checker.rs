//! Spelling, not grammar, in a language Harper does not know, with a
//! Hunspell dictionary read by spellbook (pure Rust, no system hunspell).
//!
//! The contract with the frontend is Harper's (`harper.rs`): the text is the
//! already-masked prose, and each misspelling comes back as a `Spelling`
//! lint of the `SpellCheck` rule at UTF-16 offsets, so the editor shows,
//! fixes and adds words to the project dictionary the same way for both.

use crate::harper::{HarperLintOut, HarperSuggestionOut};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use unicode_normalization::char::is_combining_mark;

/// Suggestions are slow (tens of milliseconds a word in a big dictionary),
/// so a pass spends at most this long on new ones; words left over get their
/// suggestion on a later pass. Each word's suggestion is remembered.
const SUGGESTION_BUDGET: Duration = Duration::from_millis(150);

struct Loaded {
    dictionary: spellbook::Dictionary,
    /// The first usable suggestion for each misspelling seen so far.
    suggestions: Mutex<HashMap<String, Option<String>>>,
}

/// Loaded dictionaries by language code; parsing one takes 10–100 ms.
static LOADED: LazyLock<Mutex<HashMap<String, Arc<Loaded>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn loaded(code: &str, aff: &str, dic: &str) -> Result<Arc<Loaded>, String> {
    let mut cache = LOADED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(loaded) = cache.get(code) {
        return Ok(loaded.clone());
    }
    let dictionary = spellbook::Dictionary::new(aff, dic).map_err(|error| error.to_string())?;
    let loaded = Arc::new(Loaded { dictionary, suggestions: Mutex::new(HashMap::new()) });
    cache.insert(code.to_string(), loaded.clone());
    Ok(loaded)
}

/// Check `text` against the dictionary of `code`, read from `aff` and `dic`
/// on first use. `project_words` are accepted in any case.
pub fn lint(
    code: &str, read: impl FnOnce() -> Result<(String, String), String>, text: &str,
    project_words: &[String],
) -> Result<Vec<HarperLintOut>, String> {
    let cached = LOADED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(code).cloned();
    let loaded = match cached {
        Some(loaded) => loaded,
        None => {
            let (aff, dic) = read()?;
            loaded(code, &aff, &dic)?
        }
    };
    Ok(check(&loaded, text, project_words))
}

fn check(loaded: &Loaded, text: &str, project_words: &[String]) -> Vec<HarperLintOut> {
    let known: HashSet<String> = project_words.iter().map(|word| word.to_lowercase()).collect();
    let started = Instant::now();
    let mut suggestions =
        loaded.suggestions.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut out = Vec::new();
    for word in words(text) {
        if skipped(&word.text) || known.contains(&word.text.to_lowercase()) {
            continue;
        }
        let candidates = [word.text.as_str(), word.text.trim_end_matches(['\'', '’', '.'])];
        if candidates
            .iter()
            .any(|candidate| !candidate.is_empty() && loaded.dictionary.check(candidate))
        {
            continue;
        }
        let bare = candidates[1];
        let suggestion = match suggestions.get(bare) {
            Some(suggestion) => suggestion.clone(),
            None if started.elapsed() < SUGGESTION_BUDGET => {
                let suggestion = first_suggestion(&loaded.dictionary, bare);
                suggestions.insert(bare.to_string(), suggestion.clone());
                suggestion
            }
            None => None,
        };
        let end = word.start + bare.encode_utf16().count() as u32;
        out.push(HarperLintOut {
            start: word.start,
            end,
            kind: "Spelling".to_string(),
            // The editor words the finding in the interface language.
            message: String::new(),
            suggestions: suggestion
                .into_iter()
                .map(|replacement| HarperSuggestionOut { kind: "replace".to_string(), replacement })
                .collect(),
            rule: "SpellCheck".to_string(),
            sentence_start: word.start,
            sentence_end: end,
        });
    }
    out
}

/// spellbook also offers word fragments ("Fehl-", "-trasse") and split
/// phrases, which are not a fix for a word in prose.
fn first_suggestion(dictionary: &spellbook::Dictionary, word: &str) -> Option<String> {
    let mut found = Vec::new();
    dictionary.suggest(word, &mut found);
    found.into_iter().find(|suggestion| {
        !suggestion.starts_with('-') && !suggestion.ends_with('-') && !suggestion.contains(' ')
    })
}

/// Words a dictionary cannot judge: a single letter, an acronym ("GPU",
/// "GPUs"), and words glued to a digit or an underscore (`x_1`, `10th`),
/// which are identifiers or numbers, not prose.
fn skipped(word: &str) -> bool {
    let letters = word.trim_end_matches(['\'', '’', '.']);
    let mut chars = letters.chars();
    if chars.next().is_none() || chars.next().is_none() {
        return true;
    }
    let stem = letters.strip_suffix('s').unwrap_or(letters);
    stem.chars().count() > 1 && stem.chars().all(|ch| ch.is_uppercase() || !ch.is_alphabetic())
}

struct Word {
    /// UTF-16 offset of the first character.
    start: u32,
    text: String,
}

fn is_letter(ch: char) -> bool {
    ch.is_alphabetic() || is_combining_mark(ch)
}

/// Runs of letters, joined across an apostrophe, a hyphen or a period that
/// sits between letters ("aujourd'hui", "c'est-à-dire", "z.B"). A word keeps
/// a closing apostrophe (French elision before a masked command, "qu'") and a
/// closing period after an inner one ("z.B."), which dictionaries list.
/// Words touching a digit, an underscore or a backslash are dropped.
fn words(text: &str) -> Vec<Word> {
    let chars: Vec<char> = text.chars().collect();
    let mut utf16 = Vec::with_capacity(chars.len() + 1);
    let mut offset = 0u32;
    for ch in &chars {
        utf16.push(offset);
        offset += ch.len_utf16() as u32;
    }
    utf16.push(offset);
    let glued = |index: usize| {
        chars.get(index).is_some_and(|ch| ch.is_ascii_digit() || *ch == '_' || *ch == '\\')
    };
    let mut out = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if !is_letter(chars[index]) {
            index += 1;
            continue;
        }
        let start = index;
        let joins = |at: usize| {
            matches!(chars[at], '\'' | '’' | '-' | '.')
                && chars.get(at + 1).is_some_and(|next| is_letter(*next))
        };
        while index < chars.len() && (is_letter(chars[index]) || joins(index)) {
            index += 1;
        }
        let inner_period = chars[start..index].contains(&'.');
        if chars
            .get(index)
            .is_some_and(|ch| matches!(ch, '\'' | '’') || (*ch == '.' && inner_period))
        {
            index += 1;
        }
        if (start > 0 && glued(start - 1)) || glued(index) {
            continue;
        }
        out.push(Word { start: utf16[start], text: chars[start..index].iter().collect() });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny French-like dictionary: elision prefixes, a plural suffix, and
    /// an apostrophe conversion, enough to exercise what the checker relies
    /// on from Hunspell's format without the network.
    const AFF: &str = "SET UTF-8\nWORDCHARS -’'.\nICONV 1\nICONV ’ '\nTRY esianrtolcdugmphbyfvkwzESIANRTOLCDUGMPHBYFVKWZ'\n\nPFX L Y 1\nPFX L 0 l' [aeiouéh]\n\nSFX S Y 1\nSFX S 0 s .\n";
    const DIC: &str =
        "8\nhomme/LS\nréseau\nréseaux\nneuronal\nélève/LS\naujourd'hui\nc'est-à-dire\nz.B.\n";

    fn fixture(code: &str) -> Arc<Loaded> {
        loaded(code, AFF, DIC).unwrap()
    }

    fn flagged(text: &str, words: &[&str]) -> Vec<(String, Vec<String>)> {
        let loaded = fixture("xx-fixture");
        let words: Vec<String> = words.iter().map(|word| word.to_string()).collect();
        let units: Vec<u16> = text.encode_utf16().collect();
        check(&loaded, text, &words)
            .into_iter()
            .map(|lint| {
                let word = String::from_utf16_lossy(&units[lint.start as usize..lint.end as usize]);
                (word, lint.suggestions.into_iter().map(|s| s.replacement).collect())
            })
            .collect()
    }

    #[test]
    fn flags_unknown_words_with_a_suggestion() {
        let found = flagged("Le réseau neuronal de l'élève est un résaeu.", &[]);
        let words: Vec<&str> = found.iter().map(|(word, _)| word.as_str()).collect();
        assert_eq!(words, ["Le", "de", "est", "un", "résaeu"]);
        let (_, suggestions) = found.last().unwrap();
        assert_eq!(suggestions, &["réseau"]);
    }

    #[test]
    fn affixes_apostrophes_and_hyphens_follow_the_dictionary() {
        for text in [
            "l'homme hommes l’élève élèves",
            "aujourd'hui, aujourd’hui c'est-à-dire réseaux",
            "Réseau HOMME z.B. neuronal.",
        ] {
            assert!(flagged(text, &[]).is_empty(), "{text}: {:?}", flagged(text, &[]));
        }
    }

    #[test]
    fn acronyms_identifiers_and_project_words_are_left_alone() {
        assert!(flagged("GPU GPUs x_1 10th a l' réseau", &[]).is_empty());
        assert_eq!(flagged("Lattice frobnique", &["lattice"]).len(), 1);
        assert!(flagged("Lattice frobnique", &["LATTICE", "frobnique"]).is_empty());
    }

    #[test]
    fn spans_are_utf16_offsets() {
        let text = "𝒜 résaeu";
        let found = check(&fixture("xx-fixture"), text, &[]);
        assert_eq!(found.len(), 1);
        // "𝒜" is two UTF-16 units, then a space.
        assert_eq!((found[0].start, found[0].end), (3, 9));
        assert_eq!((found[0].kind.as_str(), found[0].rule.as_str()), ("Spelling", "SpellCheck"));
    }

    #[test]
    fn a_dictionary_loads_once_and_a_broken_one_is_an_error() {
        let mut reads = 0;
        for _ in 0..2 {
            lint(
                "xx-loads-once",
                || {
                    reads += 1;
                    Ok((AFF.to_string(), DIC.to_string()))
                },
                "réseau",
                &[],
            )
            .unwrap();
        }
        assert_eq!(reads, 1);
        let missing = lint("xx-missing", || Err("not installed".to_string()), "réseau", &[]);
        assert_eq!(missing.unwrap_err(), "not installed");
    }
}
