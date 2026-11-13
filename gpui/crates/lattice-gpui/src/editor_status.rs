//! The editor's status bar and the build chip in its tab strip, as the
//! running app draws them (Paper's Main window).
//!
//! Status bar: 28px under a hairline, on the editor's sheet, its items 22px
//! slabs 6px in; the caret's "Ln 1, Col 1" (four runs of text, the words and
//! the numbers each their own, as the app writes them), then the save state
//! ("Saved", "Saving…", "Couldn’t save": unsaved typing is the tab's dot to
//! say, not this), and the word count at the far end ("This file · 1,204
//! words", the count in the primary ink). The app's "Manuscript" count is
//! the whole project's, which the GPUI app does not count yet, so the
//! buffer's count is always labelled as the file's.
//!
//! Build chip (`.trellis-build-button`): 24px with control corners, the ink
//! at 9% laid on the sheet (#E7E7E7 light, #313134 dark, as measured) under
//! an inset hairline; a 13px mark 8px in, 6px to its label in 12px semibold,
//! 10px to the end. Idle it reads "Build" beside a filled play mark, a
//! running build spins its mark, and the last build's result follows: a
//! green check and its time, or "Failed". It is as wide as its widest state
//! (the longest label, a time up to 999.9 s included), so the strip never
//! shifts as it changes. It builds on click, as ⌘B does.

use gpui::{
    AnimationExt as _, AnyElement, App, BoxShadow, Edges, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, prelude::FluentBuilder as _, px,
};
use language::Rope;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::StatusItem,
    dock::PANEL_RADIUS,
    elevation::ring,
    parity,
    tokens::{FONT_WEIGHT_SEMIBOLD, OPACITY_PRESSED},
    typography::{shaped_width_with, tabular_nums},
};

use crate::{
    build::{hover_card::HoverCard, sequence, word_count},
    build_panel::{BuildPanel, ChipState},
    editor_panel::{EditorPanel, SaveStatus},
    shell::{Build, CleanRebuild},
};

pub fn status_bar(panel: &EditorPanel, cx: &App) -> impl IntoElement {
    let palette = cx.palette();
    let (line, column) = panel.cursor();
    let (save_icon, save_label) = match panel.save_status() {
        SaveStatus::Saved => (Icon::HARD_DRIVE, t!("Saved")),
        SaveStatus::Saving => (Icon::LOADER, t!("Saving…")),
        SaveStatus::Failed(_) => (Icon::CIRCLE_ALERT, t!("Couldn’t save")),
    };
    // The caret's words and numbers, each its own run, as the app's
    // `.status-caret` spans are. The words come from the one translated
    // sentence split at its numbers, as the app splits it ("Ln 1, Col 1",
    // "第 1 行，第 1 列").
    const LINE_MARK: char = '\u{1}';
    const COLUMN_MARK: char = '\u{2}';
    let sentence = t!(
        "Ln {line}, Col {column}",
        line = LINE_MARK,
        column = COLUMN_MARK
    );
    let mut runs: Vec<(SharedString, String)> = Vec::with_capacity(5);
    for (ix, word) in sentence.split([LINE_MARK, COLUMN_MARK]).enumerate() {
        if ix > 0 {
            let number = if ix == 1 { line } else { column };
            runs.push((number.to_string().into(), String::new()));
        }
        if !word.is_empty() {
            runs.push((word.to_string().into(), word.trim_end().to_string()));
        }
    }
    let caret = div()
        .flex()
        .children(runs.into_iter().enumerate().map(|(slot, (shown, word))| {
            let content: SharedString = if word.is_empty() {
                shown.clone()
            } else {
                word.into()
            };
            div()
                .children(parity::text_probe("status/position", slot, content))
                .child(shown)
        }));
    div()
        .flex()
        .flex_none()
        .items_center()
        .h(px(28.))
        .px(px(6.))
        .gap(px(2.))
        .border_t_1()
        .border_color(palette.line)
        // The bar's numbers are tabular, as `.editor-status-bar` sets them.
        .font_features(tabular_nums())
        .bg(palette.editor)
        .rounded_b(PANEL_RADIUS)
        .children(parity::bordered_probe(
            "status-bar",
            Edges {
                top: px(1.),
                ..Edges::default()
            },
        ))
        .child(
            StatusItem::new("caret-position")
                .parity("status/position")
                .child(caret),
        )
        .child(
            StatusItem::new("save-state")
                .icon(save_icon)
                .label(save_label)
                .parity("status/save"),
        )
        .child(div().flex_1())
        .when_some(panel.words(), |this, words| {
            this.child(word_count(panel, words, cx))
        })
}

/// The selection while there is one, else the manuscript, else this file
/// (`crate::build::word_count`).
fn word_count(panel: &EditorPanel, file_words: usize, cx: &App) -> AnyElement {
    use editor::ToOffset as _;
    let editor = panel.editor().read(cx);
    let buffer = editor.buffer().read(cx).snapshot(cx);
    let selection = editor.selections.newest_anchor();
    let (start, end) = (
        selection.start.to_offset(&buffer),
        selection.end.to_offset(&buffer),
    );
    let selected: String = if start == end {
        String::new()
    } else {
        buffer
            .text_for_range(start.min(end)..start.max(end))
            .collect()
    };
    let root = panel.project_root(cx);
    let manuscript = word_count::manuscript_count(&root, cx);
    let file_chars = buffer.text_summary().len_utf16.0;
    let labels = word_count::labels(manuscript.as_ref(), file_words, file_chars, &selected);
    crate::build::word_count_item::item(labels, cx)
}

pub fn build_chip(build: &Entity<BuildPanel>, window: &Window, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let state = build.read(cx).chip();
    let seconds = |took: std::time::Duration| format!("{:.1} s", took.as_secs_f32());
    let (icon, icon_size, ink, label) = match state {
        ChipState::Idle => (
            Icon::PLAY_FILLED,
            px(11.),
            palette.text,
            t!("Build").to_string(),
        ),
        ChipState::Running(_) => (
            Icon::LOADER,
            px(13.),
            palette.text_secondary,
            t!("Build").to_string(),
        ),
        ChipState::Succeeded(took) => (Icon::CHECK_HEAVY, px(13.), palette.success, seconds(took)),
        ChipState::Failed(_) => (Icon::X, px(13.), palette.danger, t!("Failed").to_string()),
    };
    let label_ink = if matches!(state, ChipState::Failed(_)) {
        palette.danger
    } else {
        palette.text
    };
    // The chip's width: its widest state, as the app's hidden sizer makes it.
    let widest = [
        t!("Build").to_string(),
        t!("Failed").to_string(),
        seconds(std::time::Duration::from_secs_f32(999.9)),
    ]
    .into_iter()
    .chain(std::iter::once(label.clone()))
    .map(|text| {
        shaped_width_with(
            &text,
            TextRole::Caption,
            Some(FONT_WEIGHT_SEMIBOLD),
            Some(tabular_nums()),
            window,
            cx,
        )
    })
    .fold(px(0.), |widest, width| widest.max(width));
    let width = px(8.) + px(13.) + px(6.) + widest + px(10.);
    let ground = palette.ink_on(0.09, palette.editor_srgb);
    let hover = palette.ink_on(0.09 + OPACITY_PRESSED / 2., palette.editor_srgb);
    let edge = BoxShadow {
        inset: true,
        ..ring(palette.line)
    };
    let chip = div()
        .id("build-chip")
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .w(width.ceil())
        .h(px(24.))
        .rounded(px(6.))
        .bg(ground)
        .shadow(vec![edge])
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(13.))
                .map(|slot| {
                    let mark = icon.element(icon_size, ink);
                    if matches!(state, ChipState::Running(_)) {
                        // A running build turns its mark once a second.
                        slot.child(mark.with_animation(
                            "build-chip-spin",
                            gpui::Animation::new(std::time::Duration::from_secs(1)).repeat(),
                            |mark, t| {
                                mark.with_transformation(gpui::Transformation::rotate(
                                    gpui::percentage(t),
                                ))
                            },
                        ))
                    } else {
                        slot.child(mark)
                    }
                }),
        )
        .child(
            div()
                .whitespace_nowrap()
                .text_role(TextRole::Caption, cx)
                .line_height(px(15.6))
                .font_weight(FONT_WEIGHT_SEMIBOLD)
                .font_features(tabular_nums())
                .text_color(label_ink)
                .children(parity::text_probe("build-chip", 0, label.clone()))
                .child(label),
        )
        .children(parity::probe("build-chip"))
        // ⇧-click is the clean rebuild, as the Tauri app's Build button has it.
        .on_click(|event, window, cx| {
            if event.modifiers().shift {
                window.dispatch_action(Box::new(CleanRebuild), cx);
            } else {
                window.dispatch_action(Box::new(Build), cx);
            }
        });
    // The build as the sequence it was, in a card under the chip's end.
    let build = build.clone();
    HoverCard::new("build-card", chip, move |_, cx| sequence::card(&build, cx)).into_any_element()
}

/// The file's word count, as the Tauri app counts it
/// (`crate::build::word_count::count_words`).
pub fn count_words(text: &Rope) -> usize {
    word_count::count_words(&text.to_string())
}

/// The caret's 1-based column from the text between the line's start and the
/// caret: characters, not the bytes a buffer point's column counts.
pub fn caret_column<'a>(before_caret: impl IntoIterator<Item = &'a str>) -> u32 {
    let chars: usize = before_caret
        .into_iter()
        .map(|text| text.chars().count())
        .sum();
    chars as u32 + 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_column_counts_characters_not_bytes() {
        // After 你好 the caret is at the third character, though the line's
        // first six bytes lie before it.
        assert_eq!(caret_column(["你好"]), 3);
        assert_eq!(caret_column(["ab", "c"]), 4);
        assert_eq!(caret_column([]), 1);
    }

    #[test]
    fn the_file_is_counted_as_the_tauri_app_counts_it() {
        assert_eq!(
            count_words(&Rope::from("\\section{Attention} it's well-known")),
            4
        );
    }
}
