//! An unverified candidate set beside the writer's entry
//! (`.bibliography-audit-compare` in `bibliography-audit.css`): one box per
//! field the candidate gives differently, the field's name over Yours and
//! the source's value, only the words that differ marked on the warning
//! wash. Nothing here reads as a change to apply: no strike, no insertion.

use std::ops::Range;

use gpui::{
    AnyElement, App, HighlightStyle, IntoElement, ParentElement as _, SharedString, Styled as _,
    StyledText, div, px,
};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, tokens::FONT_WEIGHT_MEDIUM};

use super::{
    Change, Finding, summary,
    typeset::{Word, word_difference},
};

/// The words as one text, the differing ones marked.
fn marked(words: &[Word], cx: &App) -> AnyElement {
    let palette = cx.palette();
    let mut text = String::new();
    let mut marks: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    for word in words {
        let start = text.len();
        text.push_str(&word.word);
        if word.differs {
            marks.push((
                start..text.len(),
                HighlightStyle {
                    background_color: Some(palette.warning_soft),
                    font_weight: Some(FONT_WEIGHT_MEDIUM),
                    ..HighlightStyle::default()
                },
            ));
        }
    }
    div()
        .min_w_0()
        .text_role(TextRole::Body, cx)
        .text_color(palette.text)
        .child(StyledText::new(SharedString::from(text)).with_highlights(marks))
        .into_any_element()
}

/// One side of the comparison: its label over its words.
fn side(label: String, words: &[Word], first: bool, cx: &App) -> AnyElement {
    let palette = cx.palette();
    let side = div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .px(px(12.))
        .py(px(10.))
        .child(
            div()
                .text_role(TextRole::Micro, cx)
                .text_color(palette.text_secondary.opacity(0.8))
                .child(label),
        )
        .child(marked(words, cx));
    if first {
        side.into_any_element()
    } else {
        side.border_t_1()
            .border_color(palette.line)
            .into_any_element()
    }
}

/// Who gave the candidate, for its side's label: the source whose outcome
/// was a candidate record.
fn candidate_source(result: &Finding) -> Option<&str> {
    result
        .sources
        .iter()
        .find(|source| source.outcome.starts_with("candidate"))
        .map(|source| source.source.as_str())
}

/// The candidate's fields beside the writer's.
pub(super) fn compare(result: &Finding, changes: &[Change], cx: &App) -> Vec<AnyElement> {
    let palette = cx.palette().clone();
    let theirs: String = match candidate_source(result) {
        Some(source) => lattice_i18n::t!("Not verified against {0}", summary::source_name(source)),
        None => lattice_i18n::t!("Source not verified").into(),
    };
    let or_dash = |value: &str| {
        if value.is_empty() {
            "—".to_string()
        } else {
            value.to_string()
        }
    };
    changes
        .iter()
        .map(|change| {
            let (ours, candidate) =
                word_difference(&or_dash(&change.before), &or_dash(&change.after));
            div()
                .flex()
                .flex_col()
                .rounded(px(10.))
                .border_1()
                .border_color(palette.line)
                .overflow_hidden()
                .child(
                    div()
                        .px(px(12.))
                        .pt(px(8.))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text_secondary)
                        .child(summary::field_label(&change.field)),
                )
                .child(side(lattice_i18n::t!("Yours").into(), &ours, true, cx))
                .child(side(theirs.clone(), &candidate, false, cx))
                .into_any_element()
        })
        .collect()
}
