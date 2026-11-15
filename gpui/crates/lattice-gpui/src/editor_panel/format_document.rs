//! Format document (the palette's, in a LaTeX source): latexindent through
//! `lattice_core::format_latex`, as the Tauri app's `formatDocument`
//! (`src/app/format-document.ts`) runs it. latexindent takes seconds on a
//! long file, and the writer may type meanwhile, so the result is applied
//! only while the buffer still holds the text it was made from, as the one
//! change between them (the caret outside it stays where it was) that ⌘Z
//! undoes; otherwise it is dropped and a notice says to run it again.

use gpui::{AppContext as _, Context, actions};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;

use super::EditorPanel;
use crate::notices::{self, Notice};

actions!(lattice, [FormatDocument]);

/// One key for the action's notices: a newer outcome replaces the older.
const NOTICE: &str = "format-document";

fn notice(level: ToastLevel, title: String, cx: &mut gpui::App) {
    notices::show(Notice::new(level, title).key(NOTICE), cx);
}

/// The one replacement that turns `old` into `new`: what lies between their
/// common start and their common end, in `old`'s byte offsets.
fn changed_span(old: &str, new: &str) -> (std::ops::Range<usize>, String) {
    let prefix = old
        .char_indices()
        .zip(new.chars())
        .take_while(|((_, a), b)| a == b)
        .last()
        .map_or(0, |((at, c), _)| at + c.len_utf8());
    let suffix = old[prefix..]
        .chars()
        .rev()
        .zip(new[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum::<usize>();
    let suffix = suffix.min(new.len() - prefix);
    (
        prefix..old.len() - suffix,
        new[prefix..new.len() - suffix].to_string(),
    )
}

impl EditorPanel {
    /// The action's handler, on the panel's element.
    pub(super) fn format_actions(element: gpui::Div, cx: &mut Context<Self>) -> gpui::Div {
        use gpui::InteractiveElement as _;
        element.on_action(cx.listener(|this, _: &FormatDocument, _, cx| this.format_document(cx)))
    }

    /// Format the file with latexindent, and apply the result while the
    /// buffer still holds the text it was made from.
    pub(crate) fn format_document(&mut self, cx: &mut Context<Self>) {
        let path = self.relative().to_string();
        if !path.ends_with(".tex") {
            notice(
                ToastLevel::Error,
                t!("Open a .tex file before formatting.").to_string(),
                cx,
            );
            return;
        }
        let text = self.editor().read(cx).buffer().read(cx).snapshot(cx).text();
        let root = self.project_root(cx);
        let (relative, source) = (path.clone(), text.clone());
        let formatting = cx.background_spawn(async move {
            lattice_core::format_latex::format_document(&root, &relative, &source)
        });
        cx.spawn(async move |this, cx| {
            let result = formatting.await;
            this.update(cx, |this, cx| match result {
                Ok(formatted) if formatted == text => notice(
                    ToastLevel::Success,
                    t!("Document is already formatted.").to_string(),
                    cx,
                ),
                Ok(formatted) => {
                    let now = this.editor().read(cx).buffer().read(cx).snapshot(cx).text();
                    if now != text {
                        notice(
                            ToastLevel::Warning,
                            t!(
                                "{path} changed while it was being formatted, so the result was not applied. Run Format document again.",
                                path = path
                            )
                            .to_string(),
                            cx,
                        );
                        return;
                    }
                    let (range, insert) = changed_span(&text, &formatted);
                    let editor = this.editor().clone();
                    editor.update(cx, |editor, cx| {
                        editor.buffer().update(cx, |buffer, cx| {
                            buffer.edit(
                                [(
                                    editor::MultiBufferOffset(range.start)
                                        ..editor::MultiBufferOffset(range.end),
                                    insert.as_str(),
                                )],
                                None,
                                cx,
                            )
                        })
                    });
                    notice(ToastLevel::Success, t!("Formatted with latexindent.").to_string(), cx);
                }
                Err(error) => notices::show(
                    Notice::new(
                        ToastLevel::Error,
                        t!("{action} failed", action = t!("Format document")),
                    )
                        .detail(error)
                        .key(NOTICE),
                    cx,
                ),
            })
            .ok();
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::changed_span;

    #[test]
    fn the_change_is_what_lies_between_the_common_ends() {
        let (range, insert) = changed_span("a\n\\item x\nb", "a\n  \\item x\nb");
        assert_eq!((range, insert.as_str()), (2..2, "  "));
        let (range, insert) = changed_span("same", "same");
        assert_eq!((range, insert.as_str()), (4..4, ""));
        // A repeated character the prefix already took is not counted twice.
        let (range, insert) = changed_span("aa", "aaa");
        assert_eq!((range, insert.as_str()), (2..2, "a"));
        let (range, insert) = changed_span("é x", "é  x");
        assert_eq!(&"é x"[range.clone()], "");
        assert_eq!(insert, " ");
    }
}
