//! The LaTeX source's Bold (⌘B, `\textbf`) and Emphasis (⌘I, `\emph`), as the
//! Tauri app's `latexCommandKeymap` binds them (`latex-shortcuts.ts`): each
//! toggles on the main selection (`lattice_editor::latex::edits`), as one
//! edit ⌘Z undoes, the toggled text left selected. Elsewhere the key passes
//! on.

use editor::{MultiBufferOffset, SelectionEffects, ToOffset as _, scroll::Autoscroll};
use gpui::{Context, Window, actions};
use lattice_editor::latex::edits::{self, InlineFormat};

use super::EditorPanel;

actions!(lattice, [ToggleBold, ToggleEmphasis]);

impl EditorPanel {
    pub(super) fn toggle_bold(
        &mut self,
        _: &ToggleBold,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_inline(InlineFormat::Bold, window, cx);
    }

    pub(super) fn toggle_emphasis(
        &mut self,
        _: &ToggleEmphasis,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_inline(InlineFormat::Emphasis, window, cx);
    }

    fn toggle_inline(&mut self, format: InlineFormat, window: &mut Window, cx: &mut Context<Self>) {
        if !lattice_editor::latex::is_tex_source(std::path::Path::new(self.relative())) {
            cx.propagate();
            return;
        }
        let editor = self.editor().clone();
        editor.update(cx, |editor, cx| {
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            let selection = editor.selections.newest_anchor();
            let (start, end) = (
                selection.start.to_offset(&snapshot).0,
                selection.end.to_offset(&snapshot).0,
            );
            let result = edits::toggle_inline(&snapshot.text(), start, end, format);
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
                editor.change_selections(
                    SelectionEffects::scroll(Autoscroll::fit()),
                    window,
                    cx,
                    |selections| {
                        selections.select_ranges([
                            MultiBufferOffset(result.anchor)..MultiBufferOffset(result.head)
                        ])
                    },
                );
            });
        });
    }
}
