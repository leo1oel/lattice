//! Harper grammar/spell linting on the Rust side.
//!
//! Harper's WASM Worker never reaches its ready event under WKWebView, so in
//! the webview every lint pass would run on the main thread and compete with
//! typing. The identical `harper-core` engine (the crate harper.js wraps,
//! pinned to the same 2.7 line) runs in a blocking-pool command instead.
//!
//! Contract with `src/editor/harper-spellcheck.ts`:
//! - input text is the already-masked prose (masking stays in the frontend
//!   so offsets keep matching the CodeMirror document);
//! - spans come back in UTF-16 code units (what CodeMirror and JS strings
//!   index by), converted from harper's char-indexed spans here;
//! - suggestion kinds serialize to the same "replace" / "insert-after" /
//!   "remove" strings the harper.js path produced;
//! - lint kinds serialize via `LintKind`'s Display ("Spelling", "Typo", …),
//!   which is what harper.js `lint_kind()` returned.

use harper_core::linting::{LintGroup, Linter, Suggestion};
use harper_core::spell::{Dictionary, FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::{remove_overlaps, Dialect, DictWordMetadata, Document};
use serde::Serialize;
use std::sync::{Arc, LazyLock, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarperSuggestionOut {
    pub kind: String,
    pub replacement: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarperLintOut {
    /// UTF-16 code-unit offsets into the submitted text.
    pub start: u32,
    pub end: u32,
    pub kind: String,
    pub message: String,
    pub suggestions: Vec<HarperSuggestionOut>,
}

struct HarperSession {
    words_key: String,
    dictionary: Arc<MergedDictionary>,
    linter: LintGroup,
}

/// One session per process. Rebuilding the lint group is only needed when
/// the project dictionary changes; the curated dictionary loads once.
static SESSION: LazyLock<Mutex<Option<HarperSession>>> = LazyLock::new(|| Mutex::new(None));

fn session_dictionary(project_words: &[String]) -> Arc<MergedDictionary> {
    let mut merged = MergedDictionary::new();
    merged.add_dictionary(FstDictionary::curated() as Arc<dyn Dictionary>);
    if !project_words.is_empty() {
        let mut custom = MutableDictionary::new();
        for word in project_words {
            custom.append_word_str(word, DictWordMetadata::default());
        }
        merged.add_dictionary(Arc::new(custom));
    }
    Arc::new(merged)
}

pub fn lint(text: &str, project_words: &[String]) -> Vec<HarperLintOut> {
    let mut guard = SESSION.lock().unwrap();
    let words_key = project_words.join("\n");
    if guard.as_ref().is_none_or(|session| session.words_key != words_key) {
        let dictionary = session_dictionary(project_words);
        let linter = LintGroup::new_curated(dictionary.clone(), Dialect::American);
        *guard = Some(HarperSession { words_key, dictionary, linter });
    }
    let session = guard.as_mut().unwrap();
    let document = Document::new_plain_english(text, session.dictionary.as_ref());
    let mut lints = session.linter.lint(&document);
    remove_overlaps(&mut lints);

    // harper spans index chars; JS strings index UTF-16 code units. Build the
    // prefix sum once per lint pass.
    let mut utf16_at_char = Vec::with_capacity(text.chars().count() + 1);
    let mut utf16 = 0u32;
    utf16_at_char.push(0u32);
    for ch in text.chars() {
        utf16 += ch.len_utf16() as u32;
        utf16_at_char.push(utf16);
    }
    let clamp = |char_index: usize| utf16_at_char[char_index.min(utf16_at_char.len() - 1)];

    lints
        .into_iter()
        .map(|lint| HarperLintOut {
            start: clamp(lint.span.start),
            end: clamp(lint.span.end),
            kind: lint.lint_kind.to_string(),
            message: lint.message.clone(),
            suggestions: lint
                .suggestions
                .iter()
                .map(|suggestion| {
                    let (kind, replacement) = match suggestion {
                        Suggestion::ReplaceWith(chars) => ("replace", chars.iter().collect()),
                        Suggestion::InsertAfter(chars) => ("insert-after", chars.iter().collect()),
                        Suggestion::Remove => ("remove", String::new()),
                    };
                    HarperSuggestionOut { kind: kind.to_string(), replacement }
                })
                .collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_misspellings_at_utf16_offsets_with_replacement_suggestions() {
        // "𝒜" is a surrogate pair (2 UTF-16 units, 1 char); the misspelling
        // after it must land on JS-string offsets.
        for text in ["This is a mispelling of a word.", "𝒜 mispelling here."] {
            let spelling = lint(text, &[])
                .into_iter()
                .find(|entry| entry.kind == "Spelling" || entry.kind == "Typo")
                .expect("expected a spelling lint");
            let units: Vec<u16> = text.encode_utf16().collect();
            let problem =
                String::from_utf16_lossy(&units[spelling.start as usize..spelling.end as usize]);
            assert_eq!(problem, "mispelling", "{text}");
            assert!(spelling.suggestions.iter().any(|s| s.kind == "replace"), "{text}");
        }
    }

    #[test]
    fn project_words_suppress_spelling_lints_and_cache_rebuilds() {
        let text = "The lattice frobnicator is ready.";
        let flags_frobnicator = |lints: &[HarperLintOut]| {
            lints
                .iter()
                .any(|entry| &text[entry.start as usize..entry.end as usize] == "frobnicator")
        };
        let before = lint(text, &[]);
        assert!(flags_frobnicator(&before));
        assert!(!flags_frobnicator(&lint(text, &["frobnicator".to_string()])));
        // Back to the empty dictionary: the session must rebuild again.
        let reverted = lint(text, &[]);
        assert_eq!(before.len(), reverted.len());
    }
}
