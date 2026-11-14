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
//! running build runs the infinity loader, and the last build's result
//! follows: a green check and its time (with a warning dot when it left
//! warnings), or a cross and "Failed", drawing themselves the first time
//! they show (`build::chip_mark`). It is as wide as its widest state (the
//! longest label, a time up to 999.9 s included), so the strip never shifts
//! as it changes. Its fill eases under the pointer and a press shrinks it to
//! 96%, both on the fast tier. It builds on click, as ⌘B does. In a strip
//! short of room for its tabs it keeps only its mark, 8px in at each side
//! (`[data-tools="icon"]`), before the strip drops it for the ⋯ menu's
//! Build.

use gpui::{
    AnyElement, App, BoxShadow, Edges, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window, canvas,
    div, prelude::FluentBuilder as _, px,
};
use language::Rope;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::StatusItem,
    dock::PANEL_RADIUS,
    elevation::ring,
    interaction::{mix, track_pointer, use_interaction},
    parity,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD, OPACITY_PRESSED},
    typography::{shaped_width_with, tabular_nums},
};

use crate::{
    build::{
        chip_mark::{self, Mark},
        hover_card::HoverCard,
        sequence, word_count,
    },
    build_panel::{BuildPanel, ChipState},
    editor_panel::{EditorPanel, SaveStatus},
    shell::{Build, CleanRebuild},
};

/// What the status bar leaves out as it narrows, as the Tauri app's
/// container queries fold `.editor-status-bar` (`app-shell.css`): the
/// counters' nouns at 520px, the save state's label and the word count's
/// scope at 420px, the word count at 340px, the caret's words at 240px (it
/// reads "61:2"), and the counters at 180px, so the bar never spills past
/// its end. Until the bar has been drawn once, nothing folds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StatusFolds {
    pub counter_labels: bool,
    pub save_label: bool,
    pub word_scope: bool,
    pub words: bool,
    pub caret_words: bool,
    pub counters: bool,
}

impl StatusFolds {
    pub fn at(width: Option<f32>) -> Self {
        let Some(width) = width else {
            return Self::default();
        };
        Self {
            counter_labels: width <= 520.,
            save_label: width <= 420.,
            word_scope: width <= 420.,
            words: width <= 340.,
            caret_words: width <= 240.,
            counters: width <= 180.,
        }
    }
}

pub fn status_bar(panel: &EditorPanel, cx: &App) -> impl IntoElement {
    let palette = cx.palette();
    let measured = panel.status_width().clone();
    let folds = StatusFolds::at(measured.get().map(f32::from));
    let (line, column) = panel.cursor();
    // With a linked Overleaf project, the slot also says whether the text
    // reached Overleaf (`StatusSaveState`).
    use crate::overleaf::bridge::OverleafSaveState as Overleaf;
    let (save_icon, save_label) = match (panel.save_status(), panel.overleaf_save()) {
        (SaveStatus::Failed(_), _) => (Icon::CIRCLE_ALERT, t!("Couldn’t save")),
        (SaveStatus::Saving, _) => (Icon::LOADER, t!("Saving…")),
        (SaveStatus::Saved, Some(Overleaf::Offline)) => (Icon::CLOUD_OFF, t!("Saved on this Mac")),
        (SaveStatus::Saved, Some(Overleaf::Live)) => (Icon::CLOUD_CHECK, t!("Saved and synced")),
        (SaveStatus::Saved, Some(Overleaf::Syncing | Overleaf::Sending)) => {
            (Icon::LOADER, t!("Saved, syncing…"))
        }
        (SaveStatus::Saved, _) => (Icon::HARD_DRIVE, t!("Saved")),
    };
    // The caret's words and numbers, each its own run, as the app's
    // `.status-caret` spans are; folded, the numbers with a colon between.
    // The words come from the one translated sentence split at its numbers,
    // as the app splits it ("Ln 1, Col 1", "第 1 行，第 1 列").
    const LINE_MARK: char = '\u{1}';
    const COLUMN_MARK: char = '\u{2}';
    let mut runs: Vec<(SharedString, String)> = Vec::with_capacity(5);
    if folds.caret_words {
        runs.push(("".into(), String::new()));
        runs.push((line.to_string().into(), String::new()));
        runs.push((":".into(), ":".to_string()));
        runs.push((column.to_string().into(), String::new()));
    } else {
        let sentence = t!(
            "Ln {line}, Col {column}",
            line = LINE_MARK,
            column = COLUMN_MARK
        );
        for (ix, word) in sentence.split([LINE_MARK, COLUMN_MARK]).enumerate() {
            if ix > 0 {
                let number = if ix == 1 { line } else { column };
                runs.push((number.to_string().into(), String::new()));
            }
            if !word.is_empty() {
                runs.push((word.to_string().into(), word.trim_end().to_string()));
            }
        }
    }
    let caret = div().flex().children(
        runs.into_iter()
            .enumerate()
            .filter(|(_, (shown, _))| !shown.is_empty())
            .map(|(slot, (shown, word))| {
                let content: SharedString = if word.is_empty() {
                    shown.clone()
                } else {
                    word.into()
                };
                div()
                    .children(parity::text_probe("status/position", slot, content))
                    .child(shown)
            }),
    );
    let save = StatusItem::new("save-state")
        .icon(save_icon)
        .parity("status/save");
    let save = if folds.save_label {
        save
    } else {
        save.label(save_label)
    };
    div()
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .h(px(28.))
        .px(px(6.))
        .gap(px(2.))
        .overflow_hidden()
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
        // The bar's width for the next frame's folds; a change redraws.
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    if measured.replace(Some(bounds.size.width)) != Some(bounds.size.width) {
                        window.refresh();
                    }
                },
            )
            .absolute()
            .size_full(),
        )
        .child(
            StatusItem::new("caret-position")
                .parity("status/position")
                .child(caret),
        )
        .child(save)
        .child(div().flex_1())
        .when(!folds.counters, |this| {
            this.children(counters(panel, folds.counter_labels, cx))
        })
        .when_some(panel.words().filter(|_| !folds.words), |this, words| {
            this.child(word_count(panel, words, !folds.word_scope, cx))
        })
}

/// The two counters before the word count (`useCounters`): an icon, its
/// noun and, when there is something open, the count in medium weight, the
/// icon and the count in the accent. TODOs opens the TODOs tool panel;
/// Annotations is not in the GPUI app yet, which its tooltip says.
fn counters(panel: &EditorPanel, nouns_folded: bool, cx: &App) -> [AnyElement; 2] {
    let palette = cx.palette();
    let counts = crate::status_counters::counts(
        &panel.project_root(cx),
        panel.relative(),
        panel.buffer_todos(),
        cx,
    );
    let item = |id: &'static str,
                icon: Icon,
                noun: &'static str,
                title: String,
                count: usize,
                open: Option<Box<dyn gpui::Action>>| {
        StatusItem::new(id)
            .icon(icon)
            .accent_icon(count > 0)
            .when(!nouns_folded, |item| item.label(noun))
            .when(count > 0, |item| {
                item.child(
                    div()
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.accent)
                        .child(crate::status_counters::format_count(count)),
                )
            })
            .tooltip(title)
            .on_click(move |_, window, cx| {
                if let Some(open) = &open {
                    window.dispatch_action(open.boxed_clone(), cx);
                }
            })
            .into_any_element()
    };
    [
        item(
            "status-comments",
            Icon::MESSAGE_SQUARE_TEXT,
            t!("Annotations"),
            t!(
                "{name} — not in the GPUI preview yet",
                name = t!("Annotations")
            ),
            counts.annotations,
            None,
        ),
        item(
            "status-manuscript-todos",
            Icon::LIST_TODO,
            t!("TODOs"),
            t!("Manuscript TODOs").to_string(),
            counts.todos,
            Some(Box::new(crate::shell::OpenTodos)),
        ),
    ]
}

/// The selection while there is one, else the manuscript, else this file
/// (`crate::build::word_count`).
fn word_count(panel: &EditorPanel, file_words: usize, scoped: bool, cx: &App) -> AnyElement {
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
    crate::build::word_count_item::item(labels, scoped, cx)
}

/// The build chip's labels' widths in each of its states, at least, so it
/// is as wide as its widest whatever it shows.
fn chip_label_width(label: Option<&str>, window: &Window, cx: &App) -> gpui::Pixels {
    let seconds = format!("{:.1} s", 999.9f32);
    [t!("Build"), t!("Failed"), seconds.as_str()]
        .into_iter()
        .chain(label)
        .map(|text| {
            shaped_width_with(
                text,
                TextRole::Caption,
                Some(FONT_WEIGHT_SEMIBOLD),
                Some(tabular_nums()),
                window,
                cx,
            )
        })
        .fold(px(0.), |widest, width| widest.max(width))
}

/// The build chip's width with its label: 8px in, the mark, 6px, the
/// widest label, 10px.
fn chip_full_width(label: Option<&str>, window: &Window, cx: &App) -> gpui::Pixels {
    (px(8.) + chip_mark::MARK + px(6.) + chip_label_width(label, window, cx) + px(10.)).ceil()
}

/// The build chip with its mark alone (`padding-inline: var(--space-4)`).
fn chip_icon_width() -> gpui::Pixels {
    px(8.) + chip_mark::MARK + px(8.)
}

/// How much narrower the build chip draws with its mark alone.
pub fn build_chip_icon_saving(window: &Window, cx: &App) -> gpui::Pixels {
    chip_full_width(None, window, cx) - chip_icon_width()
}

pub fn build_chip(
    build: &Entity<BuildPanel>,
    icon_only: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let panel = build.read(cx);
    let state = panel.chip();
    let moment = panel.chip_moment();
    let warned = panel.chip_warned();
    let seconds = |took: std::time::Duration| format!("{:.1} s", took.as_secs_f32());
    let (mark, label) = match state {
        ChipState::Idle => (None, t!("Build").to_string()),
        ChipState::Running(_) => (Some(Mark::Running), t!("Build").to_string()),
        ChipState::Succeeded(took) => (Some(Mark::Succeeded { warned }), seconds(took)),
        ChipState::Failed(_) => (Some(Mark::Failed), t!("Failed").to_string()),
    };
    let label_ink = if matches!(state, ChipState::Failed(_)) {
        palette.danger
    } else {
        palette.text
    };
    // The chip's width: its widest state, as the app's hidden sizer makes it,
    // or its mark alone.
    let width = if icon_only {
        chip_icon_width()
    } else {
        chip_full_width(Some(&label), window, cx)
    };
    // `.trellis-build-button`: the ink at 9% on the sheet, 14% under the
    // pointer, the fill easing on the fast tier; a press shrinks it to 96%
    // on the same tier (`scale` is in its transition too).
    let ground = palette.ink_on(0.09, palette.editor_srgb);
    let hover = palette.ink_on(0.09 + OPACITY_PRESSED / 2., palette.editor_srgb);
    let (interaction, pointer) = use_interaction("build-chip", window, cx);
    let edge = BoxShadow {
        inset: true,
        ..ring(palette.line)
    };
    let glyph = match mark {
        // Idle: the filled play mark, 11px in the 13px slot.
        None => div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(chip_mark::MARK)
            .child(Icon::PLAY_FILLED.element(px(11.), palette.text))
            .into_any_element(),
        Some(mark) => chip_mark::mark(mark, moment, &palette),
    };
    let wash = mark.and_then(|mark| chip_mark::wash(mark, moment, &palette));
    let chip = track_pointer(
        div()
            .id("build-chip")
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .w(width)
            .h(px(24.))
            .rounded(px(6.))
            .bg(mix(ground, hover, interaction.hover))
            .shadow(vec![edge])
            .cursor_pointer(),
        pointer,
    )
    .child(glyph)
    .when(!icon_only, |chip| {
        chip.child(
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
    })
    .children(wash)
    .children(parity::probe("build-chip"))
    // ⇧-click is the clean rebuild, as the Tauri app's Build button has it.
    .on_click(|event, window, cx| {
        if event.modifiers().shift {
            window.dispatch_action(Box::new(CleanRebuild), cx);
        } else {
            window.dispatch_action(Box::new(Build), cx);
        }
    });
    let chip = gpui::scaled(chip).scale(1. - 0.04 * interaction.press);
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

    #[test]
    fn the_status_bar_folds_at_the_app_s_widths() {
        assert_eq!(StatusFolds::at(None), StatusFolds::default());
        assert_eq!(StatusFolds::at(Some(640.)), StatusFolds::default());
        let at_500 = StatusFolds::at(Some(500.));
        assert!(at_500.counter_labels && !at_500.save_label);
        let at_400 = StatusFolds::at(Some(400.));
        assert!(at_400.save_label && at_400.word_scope && !at_400.words);
        let at_300 = StatusFolds::at(Some(300.));
        assert!(at_300.words && !at_300.caret_words);
        let at_200 = StatusFolds::at(Some(200.));
        assert!(at_200.caret_words && !at_200.counters);
        assert!(StatusFolds::at(Some(170.)).counters);
    }

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
