//! The editor's status bar and the build chip in its tab strip, as the
//! running app draws them (Paper's Main window).
//!
//! Status bar: 28px under a hairline, on the editor's sheet; the caret's
//! "Ln, Col" 12px in, then the save state, and the word count at the far end
//! ("Manuscript · 120,400 words", the count in the primary ink).
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
    let main = panel
        .path()
        .file_name()
        .is_some_and(|name| name == "main.tex");
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
        .child(
            div()
                .flex_none()
                .mr(px(4.))
                .whitespace_nowrap()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(format!("Ln {line}, Col {column}")),
        )
        .child(
            StatusItem::new("save-state")
                .icon(Icon::HARD_DRIVE)
                .label(if saved { "Saved" } else { "Edited" }),
        )
        .child(div().flex_1())
        .when_some(panel.words(), |this, words| {
            let scope = if main { "Manuscript" } else { "This file" };
            this.child(
                StatusItem::new("word-count")
                    .label(format!("{scope} ·"))
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
                .child(label),
        )
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
    fn counts_are_grouped_in_thousands() {
        assert_eq!(grouped(120_400), "120,400");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_000_000), "1,000,000");
    }
}
