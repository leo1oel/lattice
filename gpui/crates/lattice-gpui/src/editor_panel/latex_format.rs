//! The LaTeX source's own commands, as the Tauri app's `latexCommandKeymap`
//! binds them (`latex-shortcuts.ts`): Bold (⌘B, `\textbf`), Emphasis (⌘I,
//! `\emph`) and Inline math (⌘⇧M) as toggles; line comments (⌘/), a comment
//! environment (⌘⌥/), `\iffalse … \fi` (⌘⌥;), equation (⌘⌥E) and itemize
//! (⌘⌥I) around the selection; sort lines (⌘⌥S) and UPPER, lower and Title
//! Case (⌘⌥U, ⌘⌥L, ⌘⌥C); Select the environment (⌘⌥A) and the matching
//! `\begin` or `\end` (Ctrl-M, else the matching math delimiter). Each acts
//! on the main selection (`lattice_editor::latex::{edits, region_edits,
//! environments, syntax}`) as one edit ⌘Z undoes, the result selected. In a
//! file that is not LaTeX the key passes on.

use editor::{MultiBufferOffset, SelectionEffects, ToOffset as _, scroll::Autoscroll};
use gpui::{Context, Window, actions};
use lattice_editor::latex::{
    edits::{self, FormatEdit, InlineFormat},
    environments,
    region_edits::{self, CaseMode, CommentWrap},
    syntax,
};

use super::EditorPanel;

actions!(
    lattice,
    [
        ToggleBold,
        ToggleEmphasis,
        ToggleInlineMath,
        ToggleLineComments,
        WrapCommentEnvironment,
        WrapIfFalse,
        WrapEquation,
        WrapItemize,
        SortLines,
        UpperCase,
        LowerCase,
        TitleCase,
        SelectEnvironment,
        MatchingEnvironment,
    ]
);

/// What a command does with the text and the main selection.
pub(super) enum Outcome {
    Edit(FormatEdit),
    Select(std::ops::Range<usize>),
    Nothing,
    /// The key is not the command's here: it goes on to the editor.
    Pass,
}

impl EditorPanel {
    /// Every command's handler, on the panel's element.
    pub(super) fn latex_commands(element: gpui::Div, cx: &mut Context<Self>) -> gpui::Div {
        use gpui::InteractiveElement as _;
        element
            .on_action(cx.listener(|this, _: &ToggleBold, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| {
                        Outcome::Edit(edits::toggle_inline(text, from, to, InlineFormat::Bold))
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &ToggleEmphasis, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| {
                        Outcome::Edit(edits::toggle_inline(text, from, to, InlineFormat::Emphasis))
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &ToggleInlineMath, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| Outcome::Edit(region_edits::toggle_math(text, from, to)),
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &ToggleLineComments, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| {
                        Outcome::Edit(
                            region_edits::toggle_line_comments(text, from, to).into_format(),
                        )
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &WrapCommentEnvironment, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| {
                        Outcome::Edit(
                            region_edits::wrap_comment_region(
                                text,
                                from,
                                to,
                                CommentWrap::Environment,
                            )
                            .into_format(),
                        )
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &WrapIfFalse, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| {
                        Outcome::Edit(
                            region_edits::wrap_comment_region(text, from, to, CommentWrap::IfFalse)
                                .into_format(),
                        )
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &WrapEquation, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| {
                        Outcome::Edit(
                            region_edits::wrap_environment(text, from, to, "equation")
                                .into_format(),
                        )
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &WrapItemize, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| {
                        Outcome::Edit(
                            region_edits::wrap_environment(text, from, to, "itemize").into_format(),
                        )
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &SortLines, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| changed(region_edits::sort_selected_lines(text, from, to)),
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &UpperCase, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| {
                        changed(region_edits::transform_case(
                            text,
                            from,
                            to,
                            CaseMode::Upper,
                        ))
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &LowerCase, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| {
                        changed(region_edits::transform_case(
                            text,
                            from,
                            to,
                            CaseMode::Lower,
                        ))
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &TitleCase, window, cx| {
                this.run_latex_command(
                    |text, from, to, _| {
                        changed(region_edits::transform_case(
                            text,
                            from,
                            to,
                            CaseMode::Title,
                        ))
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &SelectEnvironment, window, cx| {
                this.run_latex_command(
                    |text, _, _, head| {
                        selected(environments::enclosing_environment_range(text, head))
                    },
                    window,
                    cx,
                )
            }))
            .on_action(cx.listener(|this, _: &MatchingEnvironment, window, cx| {
                this.run_latex_command(
                    |text, _, _, head| {
                        selected(
                            environments::matching_environment_target(text, head)
                                .or_else(|| syntax::matching_math_delimiter(text, head)),
                        )
                    },
                    window,
                    cx,
                )
            }))
    }

    /// An edit the window asks for on the main selection (Wrap in
    /// environment…, Rename environment), applied as the keys' are, the
    /// keyboard back in the text.
    pub(crate) fn edit_latex_selection(
        &mut self,
        make: impl FnOnce(&str, usize, usize, usize) -> Option<FormatEdit>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.run_latex_command(
            |text, from, to, head| {
                make(text, from, to, head).map_or(Outcome::Nothing, Outcome::Edit)
            },
            window,
            cx,
        );
        let focus = gpui::Focusable::focus_handle(self.editor().read(cx), cx);
        window.focus(&focus, cx);
    }

    /// The text, and the main selection's head.
    pub(crate) fn latex_selection(&self, cx: &gpui::App) -> (String, usize) {
        let editor = self.editor().read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        let head = editor.selections.newest_anchor().head();
        (snapshot.text(), head.to_offset(&snapshot).0)
    }

    /// Run `command` on the text and the main selection's start, end and
    /// head, or pass the key on outside a LaTeX file.
    pub(super) fn run_latex_command(
        &mut self,
        command: impl FnOnce(&str, usize, usize, usize) -> Outcome,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !lattice_editor::latex::is_tex_source(std::path::Path::new(self.relative())) {
            cx.propagate();
            return;
        }
        let editor = self.editor().clone();
        let passed = editor.update(cx, |editor, cx| {
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            let selection = editor.selections.newest_anchor();
            let (start, end, head) = (
                selection.start.to_offset(&snapshot).0,
                selection.end.to_offset(&snapshot).0,
                selection.head().to_offset(&snapshot).0,
            );
            let select = |editor: &mut editor::Editor,
                          range: std::ops::Range<usize>,
                          window: &mut Window,
                          cx: &mut Context<editor::Editor>| {
                editor.change_selections(
                    SelectionEffects::scroll(Autoscroll::fit()),
                    window,
                    cx,
                    |selections| {
                        selections.select_ranges([
                            MultiBufferOffset(range.start)..MultiBufferOffset(range.end)
                        ])
                    },
                );
            };
            match command(&snapshot.text(), start, end, head) {
                Outcome::Pass => return true,
                Outcome::Nothing => {}
                Outcome::Select(range) => select(editor, range, window, cx),
                Outcome::Edit(result) => {
                    editor.transact(window, cx, |editor, window, cx| {
                        editor.buffer().update(cx, |buffer, cx| {
                            buffer.edit(
                                result.changes.iter().map(|change| {
                                    (
                                        MultiBufferOffset(change.range.start)
                                            ..MultiBufferOffset(change.range.end),
                                        change.insert.as_str(),
                                    )
                                }),
                                None,
                                cx,
                            );
                        });
                        select(editor, result.anchor..result.head, window, cx);
                    });
                }
            }
            false
        });
        if passed {
            cx.propagate();
        }
    }
}

fn changed(edit: Option<region_edits::SelectionEdit>) -> Outcome {
    edit.map_or(Outcome::Nothing, |edit| Outcome::Edit(edit.into_format()))
}

fn selected(range: Option<std::ops::Range<usize>>) -> Outcome {
    range.map_or(Outcome::Nothing, Outcome::Select)
}
