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
//! Build chip: 24px with control corners, the ink at 9% laid on the sheet
//! (#E7E7E7 light, #313134 dark, as measured) under an inset hairline; a 13px
//! mark 8px in and the last build's time in 12px semibold. It builds on
//! click, as ⌘B does.

use gpui::{
    AnyElement, AnyView, App, AppContext as _, BoxShadow, Edges, Entity, FontFeatures,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _, px,
};
use language::Rope;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::StatusItem,
    dock::PANEL_RADIUS,
    elevation::ring,
    parity,
    tokens::{FONT_WEIGHT_SEMIBOLD, OPACITY_PRESSED},
};

use crate::{
    build::{sequence::BuildSequence, word_count},
    build_panel::{BuildPanel, ChipState},
    editor_panel::{EditorPanel, SaveStatus},
    shell::{Build, CleanRebuild},
};

pub fn status_bar(panel: &EditorPanel, cx: &App) -> impl IntoElement {
    let palette = cx.palette();
    let (line, column) = panel.cursor();
    let (save_icon, save_label) = match panel.save_status() {
        SaveStatus::Saved => (Icon::HARD_DRIVE, "Saved"),
        SaveStatus::Saving => (Icon::LOADER, "Saving…"),
        SaveStatus::Failed(_) => (Icon::CIRCLE_ALERT, "Couldn’t save"),
    };
    // The caret's words and numbers, each its own run, as the app's
    // `.status-caret` spans are.
    let runs: [(SharedString, &str); 4] = [
        ("Ln ".into(), "Ln"),
        (line.to_string().into(), ""),
        (", Col ".into(), ", Col"),
        (column.to_string().into(), ""),
    ];
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
        // The bar's numbers are tabular, as `.editor-status-bar` sets them.
        .font_features(FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)])))
        .border_t_1()
        .border_color(palette.line)
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

pub fn build_chip(build: &Entity<BuildPanel>, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let state = build.read(cx).chip();
    let (icon, ink, label) = match state {
        ChipState::Idle => (Icon::HAMMER, palette.text_secondary, "Build".to_string()),
        ChipState::Running(elapsed) => (
            Icon::LOADER,
            palette.text_secondary,
            format!("{:.1} s", elapsed.as_secs_f32()),
        ),
        ChipState::Succeeded(took) => (
            Icon::CHECK_HEAVY,
            palette.success,
            format!("{:.1} s", took.as_secs_f32()),
        ),
        ChipState::Failed(0) => (Icon::CIRCLE_ALERT, palette.danger, "Failed".to_string()),
        ChipState::Failed(errors) => (
            Icon::CIRCLE_ALERT,
            palette.danger,
            format!("{errors} error{}", if errors == 1 { "" } else { "s" }),
        ),
    };
    let ground = palette.ink_on(0.09, palette.editor_srgb);
    let hover = palette.ink_on(0.09 + OPACITY_PRESSED / 2., palette.editor_srgb);
    let edge = BoxShadow {
        inset: true,
        ..ring(palette.line)
    };
    div()
        .id("build-chip")
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .h(px(24.))
        .pl(px(8.))
        .pr(px(10.))
        .rounded(px(6.))
        .bg(ground)
        .shadow(vec![edge])
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(icon.element(px(13.), ink))
        .child(
            div()
                .whitespace_nowrap()
                .text_role(TextRole::Caption, cx)
                .line_height(px(15.6))
                .font_weight(FONT_WEIGHT_SEMIBOLD)
                .text_color(palette.text)
                .children(parity::text_probe("build-chip", 0, label.clone()))
                .child(label),
        )
        .children(parity::probe("build-chip"))
        // The build as the sequence it was, after the hover card's 280 ms.
        .hoverable_tooltip({
            let build = build.clone();
            move |_, cx| -> AnyView { cx.new(|cx| BuildSequence::new(build.clone(), cx)).into() }
        })
        .tooltip_show_delay(std::time::Duration::from_millis(280))
        // ⇧-click is the clean rebuild, as the Tauri app's Build button has it.
        .on_click(|event, window, cx| {
            if event.modifiers().shift {
                window.dispatch_action(Box::new(CleanRebuild), cx);
            } else {
                window.dispatch_action(Box::new(Build), cx);
            }
        })
        .into_any_element()
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
