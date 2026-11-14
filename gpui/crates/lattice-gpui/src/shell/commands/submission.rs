//! The commands and keys of getting a manuscript ready to send
//! (`crate::submission`): the TODOs panel and Export for arXiv in the
//! palette, a symbol's references and its rename on the Tauri app's keys.

use gpui::KeyBinding;
use lattice_i18n::t;

use super::{Command, Section};
use crate::shell::{ExportArxiv, FindReferences, OpenChecklist, OpenTodos, RenameSymbol};

/// The Edit section's: Manuscript TODOs and the submission checklist.
pub(super) fn edit_commands(out: &mut Vec<Command>) {
    out.push(Command::new(
        "todos",
        t!("Manuscript TODOs"),
        Section::Edit,
        OpenTodos,
    ));
    out.push(
        Command::new(
            "checklist",
            t!("Submission checklist"),
            Section::Edit,
            OpenChecklist,
        )
        .keywords("Words / pages / TODOs"),
    );
}

/// Insert table (in a LaTeX source) and Paste clipboard image as figure,
/// the Tauri app's `table` and `paste-image` commands.
pub(super) fn insert_commands(context: &super::CommandContext, out: &mut Vec<Command>) {
    if context.latex_source {
        out.push(Command::new(
            "table",
            t!("Insert table"),
            Section::Edit,
            crate::shell::InsertTable,
        ));
    }
    out.push(Command::new(
        "paste-image",
        t!("Paste clipboard image as figure"),
        Section::Edit,
        crate::shell::PasteImageAsFigure,
    ));
}

/// The Project section's: Export for arXiv….
pub(super) fn project_commands(out: &mut Vec<Command>) {
    out.push(Command::new(
        "export-arxiv",
        t!("Export for arXiv…"),
        Section::Project,
        ExportArxiv,
    ));
}

/// A label's or citation key's references and its rename, over Zed's own
/// (TexLab's), as the Tauri app's LaTeX keymap binds them
/// (`latex-shortcuts.ts`).
pub(super) fn bindings() -> [KeyBinding; 2] {
    [
        KeyBinding::new("shift-f12", FindReferences, Some("Editor")),
        KeyBinding::new("f2", RenameSymbol, Some("Editor")),
    ]
}
