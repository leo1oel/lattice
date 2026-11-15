//! Palette rows the Tauri command table has and the GPUI table lacked
//! (`src/app/use-command-table.ts`), for features the window already has:
//! Open guided tutorial, and in focus mode Hide the PDF or Show the PDF
//! beside the editor. Registered as a window part (`parts.rs`), so other
//! features' rows land beside these without editing the table.

use gpui::{InteractiveElement as _, actions};
use lattice_i18n::t;

use super::{
    Shell,
    commands::{Command, CommandContext, Section},
    parts::Part,
};

actions!(lattice, [OpenGuidedTutorial, ToggleFocusPdf]);

/// The part's state: it keeps none of its own.
struct PaletteCommands;

fn commands(context: &CommandContext, out: &mut Vec<Command>) {
    if context.focus_mode {
        out.push(Command::new(
            "focus-pdf",
            if context.focus_pdf {
                t!("Hide the PDF")
            } else {
                t!("Show the PDF beside the editor")
            },
            Section::Layout,
            ToggleFocusPdf,
        ));
    }
    out.push(Command::new(
        "tutorial",
        t!("Open guided tutorial"),
        Section::Project,
        OpenGuidedTutorial,
    ));
}

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(PaletteCommands),
    views: &[],
    actions: |element, cx| {
        element
            .on_action(
                cx.listener(|this: &mut Shell, _: &OpenGuidedTutorial, window, cx| {
                    this.open_tutorial(window, cx)
                }),
            )
            .on_action(
                cx.listener(|this: &mut Shell, _: &ToggleFocusPdf, window, cx| {
                    let shown = crate::shell::workspaces::Workspaces::global(cx).focus_pdf();
                    this.set_focus_pdf(!shown, window, cx)
                }),
            )
    },
    commands,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_focus_pdf_row_follows_focus_mode_and_the_pdf() {
        let labels = |context: &CommandContext| {
            let mut out = Vec::new();
            commands(context, &mut out);
            out.into_iter()
                .map(|command| command.label.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(labels(&CommandContext::default()), ["Open guided tutorial"]);
        let focus = CommandContext {
            focus_mode: true,
            ..CommandContext::default()
        };
        assert_eq!(labels(&focus)[0], "Show the PDF beside the editor");
        let shown = CommandContext {
            focus_pdf: true,
            ..focus
        };
        assert_eq!(labels(&shown)[0], "Hide the PDF");
    }
}
