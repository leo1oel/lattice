//! The status bar's word count and its popover (`StatusWordCount` and
//! `WordCountDetails` in the Tauri app's `editor-status-bar.tsx`,
//! `.word-count-popover` in app-shell.css): the scope's name, a space, then
//! the count in the primary ink; a click opens every count by scope above
//! it, aligned to its end.

use gpui::{
    Anchor, AnyElement, App, IntoElement, ParentElement as _, SharedString, Styled as _, div,
    prelude::*, px,
};
use gpui_kit::base::Popover;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{PopFrom, StatusItem, pop_in},
    elevation::Elevation,
    parity,
    tokens::FONT_WEIGHT_SEMIBOLD,
};

use super::word_count::WordCountLabels;

/// One scope's rows: its name and count, and the notes under them.
fn scope(
    name: &'static str,
    count: String,
    notes: Vec<String>,
    first: bool,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let strong = |text: SharedString| {
        div()
            .text_role(TextRole::BodyCompact, cx)
            .font_weight(FONT_WEIGHT_SEMIBOLD)
            .text_color(palette.text)
            .child(text)
    };
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .py(px(10.))
        .px(px(12.))
        .when(!first, |rows| rows.border_t_1().border_color(palette.line))
        .child(
            div()
                .flex()
                .items_baseline()
                .justify_between()
                .gap(px(12.))
                .child(strong(name.into()))
                .child(strong(count.into()).whitespace_nowrap()),
        )
        .children(notes.into_iter().map(|note| {
            div()
                .text_role(TextRole::Micro, cx)
                .font_weight(gpui::FontWeight::NORMAL)
                .text_color(palette.text_secondary)
                .child(note)
        }))
        .into_any_element()
}

fn details(labels: &WordCountLabels, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let manuscript_notes = labels
        .manuscript_note
        .map(str::to_string)
        .into_iter()
        .chain(labels.manuscript_breakdown.clone())
        .collect();
    let mut rows = vec![
        scope(
            "Manuscript",
            labels
                .manuscript
                .clone()
                .unwrap_or_else(|| "Unavailable".into()),
            manuscript_notes,
            true,
            cx,
        ),
        scope(
            "This file",
            labels.file.clone(),
            vec![labels.file_note.clone()],
            false,
            cx,
        ),
    ];
    if let Some(selection) = &labels.selection {
        rows.push(scope(
            "Selection",
            selection.clone(),
            vec![labels.selection_note.clone()],
            false,
            cx,
        ));
    }
    div()
        .w(px(284.))
        .p(px(4.))
        .rounded(px(10.))
        .bg(palette.raised)
        .shadow(Elevation::Popover.shadows(&palette))
        .children(rows)
        .into_any_element()
}

/// The footer's item: "Manuscript 120,400 words", and its popover.
pub fn item(labels: WordCountLabels, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let count: SharedString = labels.count.clone().into();
    let trigger = StatusItem::new("word-count")
        .parity("status/words")
        .label(labels.scope)
        .child(
            div()
                // The scope's trailing no-break space and its 4px margin.
                .ml(px(7.))
                .text_color(palette.text)
                .children(parity::text_probe("status/words", 1, count.clone()))
                .child(count),
        )
        .on_click(|_, _, _| {});
    Popover::new("word-count-popover")
        .anchor(Anchor::BottomRight)
        .offset(px(6.))
        .trigger_with(move |_, _, _| trigger.into_any_element())
        .content(move |_, _, cx| pop_in("word-count-details", PopFrom::Below, details(&labels, cx)))
        .into_any_element()
}
