//! The editor's status bar and the build chip in its tab strip, as the
//! running app draws them (Paper's Main window).
//!
//! Status bar: 28px under a hairline, on the editor's sheet; the caret's
//! "Ln, Col" 12px in, then the save state, and the word count at the far end
//! ("This file · 1,204 words", the count in the primary ink). The app's
//! "Manuscript" count is the whole project's, which the GPUI app does not
//! count yet, so the buffer's count is always labelled as the file's.
//!
//! Build chip: 24px with control corners, the ink at 9% laid on the sheet
//! (#E7E7E7 light, #313134 dark, as measured) under an inset hairline; a 13px
//! mark 8px in and the last build's time in 12px semibold. It builds on
//! click, as ⌘B does.

use gpui::{
    AnyElement, AnyView, App, BoxShadow, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, div,
    prelude::FluentBuilder as _, px,
};
use language::Rope;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{LatticeTooltip, StatusItem},
    dock::PANEL_RADIUS,
    elevation::ring,
    parity,
    tokens::{FONT_WEIGHT_SEMIBOLD, OPACITY_PRESSED},
};

use crate::{
    build_panel::{BuildPanel, ChipState},
    editor_panel::EditorPanel,
    shell::{BUILD_SHORTCUT_LABEL, Build},
};

pub fn status_bar(panel: &EditorPanel, cx: &App) -> impl IntoElement {
    let palette = cx.palette();
    let (line, column) = panel.cursor();
    let saved = !panel.is_dirty(cx);
    div()
        .flex()
        .flex_none()
        .items_center()
        .h(px(28.))
        .pl(px(12.))
        .pr(px(6.))
        .gap(px(2.))
        .border_t_1()
        .border_color(palette.line)
        .bg(palette.editor)
        .rounded_b(PANEL_RADIUS)
        .children(parity::probe("status-bar"))
        .child(
            div()
                .flex_none()
                .mr(px(4.))
                .whitespace_nowrap()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(format!("Ln {line}, Col {column}"))
                .children(parity::probe("status/position"))
                .children(parity::text_probe("status/position")),
        )
        .child(
            StatusItem::new("save-state")
                .icon(Icon::HARD_DRIVE)
                .label(if saved { "Saved" } else { "Edited" })
                .parity("status/save"),
        )
        .child(div().flex_1())
        .when_some(panel.words(), |this, words| {
            this.child(
                StatusItem::new("word-count")
                    .parity("status/words")
                    .label("This file ·")
                    .child(
                        div()
                            .text_color(palette.text)
                            .child(format!("{} words", grouped(words))),
                    ),
            )
        })
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
                .child(label)
                .children(parity::text_probe("build-chip")),
        )
        .children(parity::probe("build-chip"))
        .tooltip(|_, cx| -> AnyView {
            LatticeTooltip::view("Build", Some(BUILD_SHORTCUT_LABEL.into()), cx)
        })
        .on_click(|_, window, cx| window.dispatch_action(Box::new(Build), cx))
        .into_any_element()
}

/// `120400` → `120,400`.
fn grouped(count: usize) -> String {
    let digits = count.to_string();
    let mut out = String::new();
    for (ix, digit) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// A rough word count of LaTeX source: comments and command names are not
/// words; a run of letters or digits is one; each CJK character is one, as
/// writers of Chinese count.
pub fn count_words(text: &Rope) -> usize {
    let mut words = 0;
    let mut in_word = false;
    let mut in_comment = false;
    let mut in_command = false;
    let mut escaped = false;
    for chunk in text.chunks() {
        for c in chunk.chars() {
            if in_comment {
                if c == '\n' {
                    in_comment = false;
                }
                continue;
            }
            if in_command {
                if c.is_alphabetic() || c == '@' {
                    // A command's name ends the backslash's escape: only the
                    // character straight after it (`\\`, `\%`) is escaped.
                    escaped = false;
                    continue;
                }
                in_command = false;
            }
            if c == '%' && !escaped {
                in_comment = true;
                in_word = false;
                continue;
            }
            let backslash = c == '\\' && !escaped;
            if backslash {
                in_command = true;
                in_word = false;
            } else if is_cjk(c) {
                words += 1;
                in_word = false;
            } else if c.is_alphanumeric() {
                if !in_word {
                    words += 1;
                    in_word = true;
                }
            } else if c != '\'' && c != '-' {
                in_word = false;
            }
            escaped = backslash;
        }
    }
    words
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

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x3040..=0x30FF)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_and_comments_are_not_words() {
        let text = Rope::from("\\section{Attention turns} tokens % not these\nINTO 2 things 你好");
        assert_eq!(count_words(&text), 2 + 1 + 1 + 1 + 1 + 2);
    }

    #[test]
    fn a_command_after_a_command_is_not_a_word() {
        assert_eq!(
            count_words(&Rope::from("\\centering\\includegraphics{fig}")),
            1
        );
    }

    #[test]
    fn a_comment_straight_after_a_command_is_not_counted() {
        assert_eq!(count_words(&Rope::from("\\maketitle% note")), 0);
    }

    #[test]
    fn escaped_symbols_stay_escaped() {
        // `\\` is a line break and `\%` a literal percent sign: the words
        // after each still count.
        assert_eq!(count_words(&Rope::from("one\\\\two 50\\% three")), 4);
    }

    #[test]
    fn the_column_counts_characters_not_bytes() {
        // After 你好 the caret is at the third character, though the line's
        // first six bytes lie before it.
        assert_eq!(caret_column(["你好"]), 3);
        assert_eq!(caret_column(["ab", "c"]), 4);
        assert_eq!(caret_column([]), 1);
    }

    #[test]
    fn counts_are_grouped_in_thousands() {
        assert_eq!(grouped(120_400), "120,400");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_000_000), "1,000,000");
    }
}
