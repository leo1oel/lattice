//! Wrap in environment… (⌘⇧E) and Rename the environment (⌘⌥R) in a LaTeX
//! source (`latexCommandKeymap`'s `wrapEnvironment` and `renameEnvironment`
//! hosts): the rename dialog (`RenameTarget` in `submission/references.rs`)
//! asks for the name, `equation` or the environment's own to start with, and
//! its Rename wraps the selection in `\begin{name}` … `\end{name}`, or
//! renames both delimiters of the environment at the caret
//! (`lattice_editor::latex::{region_edits, environments}`), as one edit ⌘Z undoes.
//! In the Visual view the page asks for the dialog itself and applies its
//! name at the page's own selection (`StructuredDocument::edit_environment`).

use gpui::{AppContext as _, Context, Entity, InteractiveElement as _, Window, actions};
use lattice_editor::latex::{edits::FormatEdit, environments, region_edits};

use super::{Shell, parts::Part};
use crate::editor_panel::EditorPanel;
use crate::submission::references::{RenameEvent, RenameSymbolDialog, RenameTarget};

actions!(lattice, [WrapInEnvironment, RenameEnvironment]);

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(()),
    views: &[],
    actions: |element, cx| {
        element
            .on_action(cx.listener(|this, _: &WrapInEnvironment, window, cx| {
                this.open_environment_dialog(RenameTarget::WrapEnvironment, window, cx)
            }))
            .on_action(cx.listener(|this, _: &RenameEnvironment, window, cx| {
                this.open_environment_dialog(RenameTarget::Environment, window, cx)
            }))
    },
    commands: super::parts::no_commands,
};

impl Shell {
    /// The keys and the palette: the source's selection, or the Visual
    /// page's caret mirrored in it.
    fn open_environment_dialog(
        &mut self,
        target: RenameTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(editor) = self
            .active_editor()
            .filter(|_| self.latex_source_in_front(cx))
        else {
            cx.propagate();
            return;
        };
        let (text, head) = editor.read(cx).latex_selection(cx);
        let start = match target {
            RenameTarget::WrapEnvironment => "equation".to_string(),
            // Nothing to rename away from an environment: the key passes on.
            _ => match environments::environment_name_at(&text, head) {
                Some(name) => name,
                None => {
                    cx.propagate();
                    return;
                }
            },
        };
        self.environment_dialog(editor, target, start, window, cx);
    }

    /// The Visual page's ⌘⇧E (`rename` empty) or ⌘⌥R (the environment's
    /// name at its caret).
    pub(super) fn visual_environment_dialog(
        &mut self,
        editor: Entity<EditorPanel>,
        rename: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (target, start) = match rename {
            Some(name) => (RenameTarget::Environment, name),
            None => (RenameTarget::WrapEnvironment, "equation".to_string()),
        };
        self.environment_dialog(editor, target, start, window, cx);
    }

    fn environment_dialog(
        &mut self,
        editor: Entity<EditorPanel>,
        target: RenameTarget,
        start: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target_editor = editor.downgrade();
        let dialog = cx.new(|cx| RenameSymbolDialog::new(target, start, window, cx));
        let subscription = cx.subscribe_in(&dialog, window, move |this, _, event, window, cx| {
            this.references.rename = None;
            match event {
                RenameEvent::Close => this.focus_front(window, cx),
                RenameEvent::Submit(name) => {
                    if let Some(editor) = target_editor.upgrade() {
                        let name = name.clone();
                        editor.update(cx, |editor, cx| {
                            let rename = target == RenameTarget::Environment;
                            // The Visual page applies it at its own selection.
                            if !editor.edit_visual_environment(rename, &name, window, cx) {
                                editor.edit_latex_selection(
                                    |text, from, to, head| {
                                        environment_edit(target, text, from, to, head, &name)
                                    },
                                    window,
                                    cx,
                                )
                            }
                        });
                    }
                }
            }
            cx.notify();
        });
        self.references.rename = Some((dialog, subscription));
        cx.notify();
    }
}

/// What the dialog's Rename does with the text and the selection.
fn environment_edit(
    target: RenameTarget,
    text: &str,
    from: usize,
    to: usize,
    head: usize,
    name: &str,
) -> Option<FormatEdit> {
    match target {
        RenameTarget::WrapEnvironment => {
            Some(region_edits::wrap_environment(text, from, to, name).into_format())
        }
        RenameTarget::Environment => {
            let changes = environments::rename_environment_at(text, head, name)?;
            // The caret stays where it was, shifted by the \begin's rename
            // when it lies after it.
            let shift = |at: usize| {
                changes
                    .iter()
                    .filter(|change| change.range.end <= at)
                    .fold(at as isize, |at, change| {
                        at + change.insert.len() as isize - change.range.len() as isize
                    }) as usize
            };
            Some(FormatEdit {
                anchor: shift(from),
                head: shift(to),
                changes,
            })
        }
        RenameTarget::Symbol(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_uses_the_name_given_and_rename_renames_both_delimiters() {
        let wrap =
            environment_edit(RenameTarget::WrapEnvironment, "a x b", 2, 3, 3, "center").unwrap();
        assert_eq!(
            lattice_editor::latex::edits::apply("a x b", &wrap.changes),
            "a \\begin{center}\nx\n\\end{center} b"
        );
        let text = "\\begin{a}x\\end{a}";
        let caret = text.find('x').unwrap();
        let rename =
            environment_edit(RenameTarget::Environment, text, caret, caret, caret, "bb").unwrap();
        let renamed = lattice_editor::latex::edits::apply(text, &rename.changes);
        assert_eq!(renamed, "\\begin{bb}x\\end{bb}");
        assert_eq!(&renamed[rename.head..rename.head + 1], "x");
        // A selection made backwards renames the environment at its head.
        let text = "\\begin{a}x\\begin{b}y\\end{b}\\end{a}";
        let (x, y) = (text.find('x').unwrap(), text.find('y').unwrap());
        let rename = environment_edit(RenameTarget::Environment, text, x, y, x, "c").unwrap();
        assert_eq!(
            lattice_editor::latex::edits::apply(text, &rename.changes),
            "\\begin{c}x\\begin{b}y\\end{b}\\end{c}"
        );
    }
}
