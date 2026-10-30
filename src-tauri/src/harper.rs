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
//!   which is what harper.js `lint_kind()` returned;
//! - each lint names its rule (a `rules()` name) and the sentence it sits in,
//!   which is what a project ignores when it ignores one sentence; the
//!   frontend compares that sentence's source text, so masking stays its own.

use harper_core::linting::{FlatConfig, Lint, LintGroup, Suggestion};
use harper_core::spell::{Dictionary, FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::{remove_overlaps_map, Dialect, DictWordMetadata, Document, TokenStringExt};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    pub rule: String,
    /// The sentence holding the lint, in the same UTF-16 offsets.
    pub sentence_start: u32,
    pub sentence_end: u32,
}

/// One rule as Settings lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarperRuleOut {
    pub name: String,
    /// Harper's own English description, Markdown with backticked examples.
    pub description: String,
    /// On in Harper's curated set, which the standard profile is.
    pub default_on: bool,
    /// Turned off by the academic profile (`ACADEMIC_OFF`).
    pub academic_off: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarperDialect {
    #[default]
    American,
    British,
}

impl HarperDialect {
    fn harper(self) -> Dialect {
        match self {
            HarperDialect::American => Dialect::American,
            HarperDialect::British => Dialect::British,
        }
    }
}

/// Which rule set a document is checked with. Standard is Harper's curated
/// set, tuned for everyday prose; academic turns off what papers do on
/// purpose. The frontend picks academic for LaTeX unless the writer chose.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarperProfile {
    #[default]
    Standard,
    Academic,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarperOptions {
    #[serde(default)]
    pub dialect: HarperDialect,
    #[serde(default)]
    pub profile: HarperProfile,
    /// Rules switched on or off over the profile: the writer's choices in
    /// Settings, and the rules the open project ignores (off). Names Harper
    /// does not have are skipped.
    #[serde(default)]
    pub rules: BTreeMap<String, bool>,
}

/// Rules the academic profile turns off, chosen by linting Lattice's
/// templates and the research-env sample papers: on that prose each one
/// flagged deliberate academic usage far more often than a mistake. Why each
/// is off, as Settings words it, is `src/settings/grammar-rule-reasons.ts`.
pub const ACADEMIC_OFF: &[&str] = &[
    "ExpandMemoryShorthands",
    "ExpandMinimum",
    "ExpandTimeShorthands",
    "LongSentences",
    "MoreAdjective",
    "OxfordComma",
    "PhrasalVerbAsCompoundNoun",
    "SplitWords",
    "ToTwoToo",
];

/// Abbreviations papers write that Harper's dictionary lacks. The academic
/// profile accepts them as spelled (exact case), beside any acronym.
const ACADEMIC_WORDS: &[&str] = &[
    "Alg", "Algs", "Apx", "Cor", "Defn", "Eq", "Eqs", "Fig", "Figs", "Lem", "Prop", "Sec", "Secs",
    "Thm", "Thms", "cf", "i.i.d", "i.i.d.", "iid", "resp", "s", "viz", "w.r.t", "w.r.t.", "wrt",
];

/// Abbreviations that end in a period mid-sentence, which Harper reads as a
/// sentence end: the academic profile does not ask for a capital after one.
const MID_SENTENCE_ABBREVIATIONS: &[&str] =
    &["approx.", "cf.", "e.g.", "i.e.", "i.i.d.", "resp.", "viz.", "vs.", "w.r.t."];

struct HarperSession {
    words_key: String,
    dialect: HarperDialect,
    dictionary: Arc<MergedDictionary>,
    linter: LintGroup,
    /// The profile and rule choices `linter.config` holds.
    configured: Option<(HarperProfile, BTreeMap<String, bool>)>,
}

/// One session per process. The lint group is rebuilt only when the project
/// dictionary or the dialect changes (the curated dictionary loads once); a
/// new profile or rule choice only swaps its config.
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

fn profile_config(
    group: &LintGroup, profile: HarperProfile, rules: &BTreeMap<String, bool>,
) -> FlatConfig {
    let mut config = FlatConfig::new_curated();
    if profile == HarperProfile::Academic {
        for rule in ACADEMIC_OFF {
            config.set_rule_enabled(rule, false);
        }
    }
    for (rule, &enabled) in rules {
        if group.contains_key(rule) {
            config.set_rule_enabled(rule, enabled);
        }
    }
    config
}

/// An acronym or initialism ("MLP", "ECE", "C1", "MLPs"), which papers
/// define once and use throughout.
fn is_acronym(word: &str) -> bool {
    let word = word.trim_end_matches('.');
    let word = word.strip_suffix('s').unwrap_or(word);
    word.chars().any(|ch| ch.is_ascii_uppercase())
        && word.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit())
}

/// Whether the academic profile keeps `lint`, raised by `rule` over `source`.
fn academic_keeps(rule: &str, lint: &Lint, source: &[char]) -> bool {
    let end = lint.span.end.min(source.len());
    let start = lint.span.start.min(end);
    match rule {
        "SpellCheck" => {
            let word: String = source[start..end].iter().collect();
            !is_acronym(&word) && !ACADEMIC_WORDS.contains(&word.as_str())
        }
        "SentenceCapitalization" => {
            let before = source[..start].iter().rev().skip_while(|ch| ch.is_whitespace());
            let mut previous: Vec<char> =
                before.take_while(|ch| !ch.is_whitespace()).copied().collect();
            previous.reverse();
            let previous: String = previous.into_iter().collect();
            let previous = previous.trim_start_matches(['(', '[']).to_lowercase();
            !MID_SENTENCE_ABBREVIATIONS.contains(&previous.as_str())
        }
        _ => true,
    }
}

pub fn lint(text: &str, project_words: &[String], options: &HarperOptions) -> Vec<HarperLintOut> {
    let mut guard = SESSION.lock().unwrap();
    let words_key = project_words.join("\n");
    if guard
        .as_ref()
        .is_none_or(|session| session.words_key != words_key || session.dialect != options.dialect)
    {
        let dictionary = session_dictionary(project_words);
        let linter = LintGroup::new_curated(dictionary.clone(), options.dialect.harper());
        *guard = Some(HarperSession {
            words_key,
            dialect: options.dialect,
            dictionary,
            linter,
            configured: None,
        });
    }
    let session = guard.as_mut().unwrap();
    let wanted = (options.profile, options.rules.clone());
    if session.configured.as_ref() != Some(&wanted) {
        session.linter.config = profile_config(&session.linter, options.profile, &options.rules);
        session.configured = Some(wanted);
    }
    let document = Document::new_plain_english(text, session.dictionary.as_ref());
    let mut by_rule = session.linter.organized_lints(&document);
    if options.profile == HarperProfile::Academic {
        let source = document.get_source();
        for (rule, lints) in by_rule.iter_mut() {
            lints.retain(|lint| academic_keeps(rule, lint, source));
        }
    }
    remove_overlaps_map(&mut by_rule);
    let sentences: Vec<_> =
        document.iter_sentences().filter_map(|sentence| sentence.span()).collect();

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

    let mut out: Vec<HarperLintOut> = by_rule
        .into_iter()
        .flat_map(|(rule, lints)| lints.into_iter().map(move |lint| (rule.clone(), lint)))
        .map(|(rule, lint)| {
            let sentence = sentences
                .get(sentences.partition_point(|sentence| sentence.end <= lint.span.start))
                .filter(|sentence| sentence.start <= lint.span.start)
                .copied()
                .unwrap_or(lint.span);
            HarperLintOut {
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
                            Suggestion::InsertAfter(chars) => {
                                ("insert-after", chars.iter().collect())
                            }
                            Suggestion::Remove => ("remove", String::new()),
                        };
                        HarperSuggestionOut { kind: kind.to_string(), replacement }
                    })
                    .collect(),
                rule,
                sentence_start: clamp(sentence.start),
                sentence_end: clamp(sentence.end),
            }
        })
        .collect();
    out.sort_by_key(|lint| (lint.start, lint.end));
    out
}

/// Every rule Harper has, for the Settings rule list.
pub fn rules() -> Vec<HarperRuleOut> {
    let group = LintGroup::new_curated(Arc::new(MutableDictionary::new()), Dialect::American);
    let descriptions = group.all_descriptions();
    let mut rules: Vec<HarperRuleOut> = group
        .iter_keys()
        .map(|name| HarperRuleOut {
            name: name.to_string(),
            description: descriptions.get(name).copied().unwrap_or_default().to_string(),
            default_on: group.config.is_rule_enabled(name),
            academic_off: ACADEMIC_OFF.contains(&name),
        })
        .collect();
    rules.sort_by(|left, right| left.name.cmp(&right.name));
    rules
}

#[cfg(test)]
mod tests {
    use super::*;

    fn standard() -> HarperOptions {
        HarperOptions::default()
    }

    fn academic() -> HarperOptions {
        HarperOptions { profile: HarperProfile::Academic, ..HarperOptions::default() }
    }

    fn flagged(text: &str, options: &HarperOptions) -> Vec<(String, String)> {
        let units: Vec<u16> = text.encode_utf16().collect();
        lint(text, &[], options)
            .into_iter()
            .map(|entry| {
                let span = &units[entry.start as usize..entry.end as usize];
                (entry.rule, String::from_utf16_lossy(span))
            })
            .collect()
    }

    #[test]
    fn flags_misspellings_at_utf16_offsets_with_replacement_suggestions() {
        // "𝒜" is a surrogate pair (2 UTF-16 units, 1 char); the misspelling
        // after it must land on JS-string offsets.
        for text in ["This is a mispelling of a word.", "𝒜 mispelling here."] {
            let spelling = lint(text, &[], &standard())
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
        let before = lint(text, &[], &standard());
        assert!(flags_frobnicator(&before));
        assert!(!flags_frobnicator(&lint(text, &["frobnicator".to_string()], &standard())));
        // Back to the empty dictionary: the session must rebuild again.
        let reverted = lint(text, &[], &standard());
        assert_eq!(before.len(), reverted.len());
    }

    #[test]
    fn each_lint_carries_the_sentence_it_sits_in() {
        let text = "This one is fine. Here is a mispelling in a sentence. And a last one.";
        let spelling = lint(text, &[], &standard())
            .into_iter()
            .find(|entry| entry.kind == "Spelling" || entry.kind == "Typo")
            .unwrap();
        let sentence = &text[spelling.sentence_start as usize..spelling.sentence_end as usize];
        assert_eq!(sentence.trim(), "Here is a mispelling in a sentence.");
    }

    #[test]
    fn the_academic_profile_leaves_academic_usage_alone() {
        // Each line drew a lint under Harper's curated rules on Lattice's
        // templates or sample papers, and none of them is a mistake in a paper.
        let cases = [
            ("We report the expected calibration error of the resulting estimator on twelve public datasets, averaged over five random seeds with error bars denoting one standard deviation, and we compare it with the baseline without calibration, with global temperature scaling, and with the two methods that the related work section discusses in detail.", "LongSentences"),
            ("The row-wise softmax converts those scores into weights.", "SplitWords"),
            ("We split the data for training, calibration and testing.", "OxfordComma"),
            ("Curricula show examples in a meaningful order, typically from easy to hard.", "ToTwoToo"),
            ("The scores become weights that sum to one.", "ToTwoToo"),
            ("The curriculum helps most early in training.", "MoreAdjective"),
            ("Setup and evaluation follow the protocol of prior work.", "PhrasalVerbAsCompoundNoun"),
            ("We train on 8 GPUs with 80 GB of memory.", "ExpandMemoryShorthands"),
            ("We run the experiment for 30 min on one node.", "ExpandMinimum"),
            ("The latency is 40 ms per request.", "ExpandTimeShorthands"),
            ("Our method, cf. the discussion below, scales well.", "SentenceCapitalization"),
            ("The models reach 81% and 84%, resp. the third diverges.", "SentenceCapitalization"),
            ("The MLP reaches a lower ECE than the ResNet baseline.", "SpellCheck"),
            ("As shown in Eq. 3 and Thm. 2, the loss is minimized w.r.t. the encoder.", "SpellCheck"),
        ];
        for (text, rule) in cases {
            let standard = flagged(text, &standard());
            assert!(
                standard.iter().any(|(raised, _)| raised == rule),
                "{rule}: {text} {standard:?}"
            );
            let academic = flagged(text, &academic());
            let left: Vec<_> = academic
                .iter()
                .filter(|(raised, word)| raised == rule && word != "ResNet")
                .collect();
            assert!(left.is_empty(), "{rule}: {text} {left:?}");
        }
    }

    #[test]
    fn the_academic_profile_still_catches_mistakes() {
        for (text, rule) in [
            ("This is a mispelling of a word.", "SpellCheck"),
            ("We propose an method for calibration.", "AnA"),
            ("The the model is trained twice.", "RepeatedWords"),
            ("this sentence starts in lowercase. so does this one.", "SentenceCapitalization"),
        ] {
            let academic = flagged(text, &academic());
            assert!(
                academic.iter().any(|(raised, _)| raised == rule),
                "{rule}: {text} {academic:?}"
            );
        }
    }

    #[test]
    fn rule_choices_and_the_dialect_change_what_is_flagged() {
        let text = "We split the data for training, calibration and testing.";
        let mut options = academic();
        options.rules.insert("OxfordComma".to_string(), true);
        assert!(flagged(text, &options).iter().any(|(rule, _)| rule == "OxfordComma"));
        let mut options = standard();
        options.rules.insert("OxfordComma".to_string(), false);
        options.rules.insert("NoSuchRule".to_string(), true);
        assert!(!flagged(text, &options).iter().any(|(rule, _)| rule == "OxfordComma"));

        let british = "The colour of each bar marks the optimiser.";
        let american = "The color of each bar marks the optimizer.";
        let uk = HarperOptions { dialect: HarperDialect::British, ..standard() };
        let spelled = |text: &str, options: &HarperOptions| -> Vec<String> {
            flagged(text, options)
                .into_iter()
                .filter(|(rule, _)| rule == "SpellCheck")
                .map(|(_, word)| word)
                .collect()
        };
        assert_eq!(spelled(british, &standard()), ["colour", "optimiser"]);
        assert!(spelled(british, &uk).is_empty());
        assert!(spelled(american, &standard()).is_empty());
    }

    #[test]
    fn the_rule_list_names_every_academic_rule_and_its_reason() {
        let rules = rules();
        for name in ACADEMIC_OFF {
            let rule = rules.iter().find(|rule| rule.name == *name);
            assert!(rule.is_some_and(|rule| rule.default_on && rule.academic_off), "{name}");
        }
        // Settings explains every rule the profile turns off, and nothing else.
        let reasons = include_str!("../../src/settings/grammar-rule-reasons.ts");
        for name in ACADEMIC_OFF {
            assert!(
                reasons.contains(&format!("  {name}: msg`")),
                "{name} has no reason in Settings"
            );
        }
        assert_eq!(reasons.matches(": msg`").count(), ACADEMIC_OFF.len());
    }
}
