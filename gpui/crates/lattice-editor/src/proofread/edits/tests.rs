//! The tests of `edits.rs`, ported from `src/agent/proofread-edits.test.ts`
//! with its expected values.

use std::collections::BTreeSet;

use super::*;
use crate::proofread::Category;
use ProtectedKind::*;

fn none() -> Context {
    Context::default()
}

fn changes<'a>(original: &'a str, edits: &'a [Edit]) -> Vec<(&'a str, &'a str)> {
    edits
        .iter()
        .map(|edit| (&original[edit.from..edit.to], edit.insert.as_str()))
        .collect()
}

fn held_kinds(review: &Review) -> Vec<ProtectedKind> {
    review.held.iter().map(|held| held.kind).collect()
}

/// The Tauri app's `inlineEditSpans` (`src/components/ui/inline-edit-spans.ts`),
/// which two of its tests read the edits through: each edit widened to
/// whole words, as `(deleted, inserted)`. Its 32-character limit never
/// binds in these tests, so it counts characters.
fn inline_edit_spans(text: &str, edits: &[Edit]) -> Vec<(String, String)> {
    const WORD_LIMIT: usize = 32;
    let word = |char: Option<char>| char.is_some_and(|char| !char.is_whitespace());
    let mut sorted: Vec<&Edit> = edits.iter().collect();
    sorted.sort_by_key(|edit| edit.from);
    let mut spans = Vec::new();
    let mut floor = 0;
    for (index, edit) in sorted.iter().enumerate() {
        let ceiling = sorted.get(index + 1).map_or(text.len(), |next| next.from);
        let deleted = &text[edit.from..edit.to];
        let (mut from, mut to) = (edit.from, edit.to);
        if word(deleted.chars().next()) || word(edit.insert.chars().next()) {
            while from > floor
                && text[from..edit.from].chars().count() < WORD_LIMIT
                && word(text[..from].chars().next_back())
            {
                from -= text[..from].chars().next_back().unwrap().len_utf8();
            }
        }
        if word(deleted.chars().next_back()) || word(edit.insert.chars().next_back()) {
            while to < ceiling
                && text[edit.to..to].chars().count() < WORD_LIMIT
                && word(text[to..].chars().next())
            {
                to += text[to..].chars().next().unwrap().len_utf8();
            }
        }
        floor = to;
        spans.push((
            text[from..to].to_string(),
            [&text[from..edit.from], &edit.insert, &text[edit.to..to]].concat(),
        ));
    }
    spans
}

fn pairs(spans: &[(&str, &str)]) -> Vec<(String, String)> {
    spans
        .iter()
        .map(|(deleted, inserted)| (deleted.to_string(), inserted.to_string()))
        .collect()
}

#[test]
fn splits_a_suggestion_into_one_edit_per_corrected_word() {
    let original = "We beleive teh results.";
    let review = review(original, "We believe the results.", &none());
    assert_eq!(
        changes(original, &review.edits),
        [("beleive", "believe"), ("teh", "the")]
    );
    assert_eq!(review.held, []);
}

#[test]
fn keeps_changes_inside_one_run_of_non_space_characters_together() {
    let original = "methods achieve state of the art results ,which";
    let review = review(
        original,
        "methods achieves state-of-the-art results, which",
        &none(),
    );
    assert_eq!(
        inline_edit_spans(original, &review.edits),
        pairs(&[
            ("achieve", "achieves"),
            ("state of the art", "state-of-the-art"),
            ("results ,which", "results, which"),
        ])
    );
}

#[test]
fn joins_a_dropped_or_added_word_to_the_rewording_next_to_it() {
    let original = "In this paper we show that it works.";
    let review = review(original, "This paper shows that it works.", &none());
    assert_eq!(
        inline_edit_spans(original, &review.edits),
        pairs(&[("In this", "This"), ("we show", "shows")])
    );
}

#[test]
fn applies_any_subset_of_the_edits_to_the_original() {
    let original = "We beleive teh results.";
    let Review { edits, .. } = review(original, "We believe the results!", &none());
    assert_eq!(apply_edits(original, &edits), "We believe the results!");
    assert_eq!(
        apply_edits(original, &[&edits[0], &edits[2]]),
        "We believe teh results!"
    );
    assert_eq!(apply_edits::<Edit>(original, &[]), original);
}

#[test]
fn holds_back_edits_that_alter_math_or_citation_keys_and_still_offers_the_prose_fix() {
    let original = "We beleive $x$ \\cite{a}.";
    let review = review(original, "We believe $y$ \\cite{b}.", &none());
    assert_eq!(changes(original, &review.edits), [("beleive", "believe")]);
    let held: Vec<_> = review
        .held
        .iter()
        .map(|held| {
            (
                &original[held.edit.from..held.edit.to],
                held.edit.insert.as_str(),
                held.kind,
            )
        })
        .collect();
    assert_eq!(held, [("x", "y", Math), ("a", "b", Reference)]);
}

#[test]
fn holds_an_edit_unsafe_throughout_as_one() {
    let original = "on $\\mathcal{D}$ here";
    let review = review(original, "on $\\hat{\\mathcal{D}}$ here", &none());
    assert_eq!(review.edits, []);
    assert_eq!(held_kinds(&review), [Math]);
    assert_eq!(
        apply_edits(original, &review.held),
        "on $\\hat{\\mathcal{D}}$ here"
    );
}

#[test]
fn splits_a_joined_edit_when_only_part_of_it_touches_protected_latex() {
    let original = "teh$x$";
    let review = review(original, "the$y$", &none());
    assert_eq!(changes(original, &review.edits), [("teh", "the")]);
    assert_eq!(held_kinds(&review), [Math]);
}

#[test]
fn holds_back_a_removed_escape_or_comment_and_a_merged_paragraph() {
    let original = "Our gain was 5\\% % check\nhigh.";
    let held = review(original, "Our gain was 5% high.", &none());
    assert_eq!(held.edits, []);
    assert!(!held.held.is_empty());
    for edit in &held.held {
        assert!(matches!(edit.kind, Command | Comment), "{edit:?}");
    }
    let merged = review("One.\n\nTwo teh.", "One. Two the.", &none());
    assert_eq!(merged.edits.len(), 1);
    assert_eq!(merged.edits[0].insert, "the");
    assert_eq!(merged.held.len(), 1);
    assert_eq!(
        (merged.held[0].edit.insert.as_str(), merged.held[0].kind),
        (" ", Paragraph)
    );
}

#[test]
fn offers_a_translation_around_kept_latex_and_holds_one_that_drops_a_citation() {
    let original = "我们提出 $f(x)$ 方法 \\cite{li2024}。";
    let translated = "We propose the $f(x)$ method \\cite{li2024}.";
    let kept = review(original, translated, &none());
    assert_eq!(kept.held, []);
    assert_eq!(apply_edits(original, &kept.edits), translated);
    let dropped = review(original, "We propose the $f(x)$ method.", &none());
    assert_eq!(held_kinds(&dropped), [Reference]);
    assert!(apply_edits(original, &dropped.edits).contains("\\cite{li2024}"));
}

#[test]
fn offers_nothing_for_an_unchanged_suggestion() {
    assert_eq!(
        review("Fine as is.", "Fine as is.", &none()),
        Review::default()
    );
}

#[test]
fn reads_a_selection_that_starts_inside_math_with_its_context() {
    let doc = "Let $a + b$ hold.";
    let from = doc.find("b$").unwrap();
    let to = doc.len();
    let context = context(doc, from, to);
    assert_eq!(
        context,
        Context {
            before: "$a + ".into(),
            after: String::new(),
        }
    );
    let original = &doc[from..to];
    // Out of context `b$ hold` reads as prose followed by an unclosed
    // math span.
    let review = review(original, "c$ holds.", &context);
    assert_eq!(changes(original, &review.edits), [("hold", "holds")]);
    assert_eq!(held_kinds(&review), [Math]);
}

#[test]
fn protects_a_command_name_the_selection_begins_against() {
    let doc = "\\LaTeX: is great";
    let context = context(doc, 6, doc.len());
    assert_eq!(
        context,
        Context {
            before: "\\LaTeX".into(),
            after: String::new(),
        }
    );
    assert_eq!(
        protected_change(": is great", "is great", &context),
        Some(Command)
    );
}

/// Not in the TypeScript tests: byte offsets through curly quotes and
/// Chinese, which JavaScript would count in UTF-16 units.
#[test]
fn edits_are_byte_offsets_on_character_boundaries() {
    let original = "“Teh” 结果 ‘are’ gud — $数$.";
    let review = review(original, "“The” 结果 ‘are’ good — $数$.", &none());
    assert_eq!(
        changes(original, &review.edits),
        [("Teh", "The"), ("gud", "good")]
    );
    assert_eq!(review.edits[0].from, "“".len());
    assert_eq!(review.edits[1].from, original.find("gud").unwrap());
    let swapped = super::review("中文，句子。", "中文, 句子.", &none());
    assert_eq!(apply_edits("中文，句子。", &swapped.edits), "中文, 句子.");
}

/// Not in the TypeScript tests: a selection ending inside math reads to
/// the span's end in a document with multi-byte text before it.
#[test]
fn reads_a_selection_that_ends_inside_math_with_its_context() {
    let doc = "公式 $a + b$ 成立";
    let to = doc.find(" b$").unwrap();
    let context = context(doc, 0, to);
    assert_eq!(context.after, " b$");
}

#[test]
fn chooses_the_edits_not_rejected() {
    let original = "We beleive teh results.";
    let review = review(original, "We believe the results!", &none());
    let rejected = BTreeSet::from([1]);
    let chosen = chosen_edits(&review, &rejected);
    assert_eq!(
        chosen.iter().map(|edit| edit.id).collect::<Vec<_>>(),
        [0, 2]
    );
    assert_eq!(apply_edits(original, &chosen), "We believe teh results!");
}

#[test]
fn attaches_each_reason_to_the_edit_it_quotes() {
    let original = "We beleive teh results of $x$ in 中文。";
    let review = review(original, "We believe the results of $y$ in 中文.", &none());
    let line = |from: &str, to: &str, category, note: &str| ReasonLine {
        from: from.into(),
        to: to.into(),
        category,
        note: note.into(),
    };
    let reasons = [
        line("We beleive", "We believe", Some(Category::Spelling), ""),
        line(
            "teh  results",
            "the results",
            Some(Category::Spelling),
            "typo",
        ),
        line("$x$", "$y$", None, "renamed"),
        line("中文。", "中文.", Some(Category::Punctuation), ""),
        line(
            "unrelated",
            "words",
            Some(Category::Clarity),
            "never matches",
        ),
    ];
    let reasoned = with_reasons(review, original, &reasons);
    let reason = |category, note: &str| {
        Some(Reason {
            category,
            note: note.into(),
        })
    };
    let offered: Vec<_> = reasoned
        .edits
        .iter()
        .map(|edit| edit.reason.clone())
        .collect();
    assert_eq!(
        offered,
        [
            reason(Some(Category::Spelling), ""),
            reason(Some(Category::Spelling), "typo"),
            reason(Some(Category::Punctuation), ""),
        ]
    );
    assert_eq!(reasoned.held[0].edit.reason, reason(None, "renamed"));
    let unchanged = with_reasons(reasoned.clone(), original, &[]);
    assert_eq!(unchanged, reasoned);
}

#[test]
fn joins_held_edits_of_one_construct_into_one_run() {
    let original = "on $q k$ and $z$ here";
    let review = review(original, "on $\\hat{q k}$ and $w$ here", &none());
    assert_eq!(held_kinds(&review), [Math, Math, Math]);
    let runs = held_runs(original, &review);
    let drawn: Vec<_> = runs
        .iter()
        .map(|run| (&original[run.from..run.to], run.insert.as_str(), run.id))
        .collect();
    assert_eq!(drawn, [("q k$ and $z", "\\hat{q k}$ and $w", 0)]);

    // An offered edit between two held ones keeps them apart.
    let original = "$a$ teh $b$";
    let review = super::review(original, "$c$ the $d$", &none());
    assert_eq!(review.edits.len(), 1);
    assert_eq!(held_runs(original, &review).len(), 2);
}
