//! Palette rows the Tauri command table has and the GPUI table lacked
//! (`src/app/use-command-table.ts`), for features the window already has:
//! Open guided tutorial; in focus mode Hide the PDF or Show the PDF beside
//! the editor; a Markdown or HTML file's Edit, Split and Preview under the
//! names their switch gives them, the one shown left out; the PDF's own
//! window (Open the PDF in a separate window, Return the PDF to the
//! workspace) and Dark or Light PDF pages; and the Project panel's New
//! folder, Import files… and Refresh file tree (`project-panel-commands.ts`),
//! which bring the panel up first. Registered as a window part (`parts.rs`), so other
//! features' rows land beside these without editing the table.

use gpui::{Context, InteractiveElement as _, Window, actions};
use lattice_i18n::t;

use super::{
    Shell,
    commands::{Command, CommandContext, Section},
    parts::Part,
};

use crate::editor_panel::views::DocumentView;

actions!(
    lattice,
    [
        OpenGuidedTutorial,
        ToggleFocusPdf,
        ShowDocumentSource,
        ShowDocumentSplit,
        ShowDocumentPreview,
        TogglePdfWindow,
        TogglePdfDarkPages,
        NewFolderInProject,
        ImportFilesIntoProject,
        RefreshFileTree,
    ]
);

impl Shell {
    /// Show the document in front in `view`, as its switch does.
    fn show_document_view(
        &mut self,
        view: DocumentView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(editor) = self.active_editor() {
            editor.update(cx, |panel, cx| panel.set_document_view(view, window, cx));
        }
    }
}

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
    if let Some((html, shown)) = context.document_views {
        for view in DocumentView::ALL.into_iter().filter(|view| *view != shown) {
            let (id, label): (&str, &str) = match (view, html) {
                (DocumentView::Source, true) => ("view-source", t!("Edit HTML")),
                (DocumentView::Split, true) => ("view-split", t!("Edit and preview HTML")),
                (DocumentView::Preview, true) => ("view-pdf", t!("Preview HTML")),
                (DocumentView::Source, false) => ("view-source", t!("Edit Markdown")),
                (DocumentView::Split, false) => ("view-split", t!("Edit and preview Markdown")),
                (DocumentView::Preview, false) => ("view-pdf", t!("Preview Markdown")),
            };
            out.push(match view {
                DocumentView::Source => Command::new(id, label, Section::View, ShowDocumentSource),
                DocumentView::Split => Command::new(id, label, Section::View, ShowDocumentSplit),
                DocumentView::Preview => {
                    Command::new(id, label, Section::View, ShowDocumentPreview)
                }
            });
        }
    }
    if context.in_project {
        out.push(Command::new(
            "pdf-window",
            if context.pdf_window {
                t!("Return the PDF to the workspace")
            } else {
                t!("Open the PDF in a separate window")
            },
            Section::Layout,
            TogglePdfWindow,
        ));
    }
    out.push(Command::new(
        "pdf-dark-pages",
        if context.pdf_dark {
            t!("Light PDF pages")
        } else {
            t!("Dark PDF pages")
        },
        Section::Layout,
        TogglePdfDarkPages,
    ));
    if context.in_project {
        out.push(Command::new(
            "new-folder",
            t!("New folder"),
            Section::Project,
            NewFolderInProject,
        ));
        out.push(Command::new(
            "new-import",
            t!("Import files…"),
            Section::Project,
            ImportFilesIntoProject,
        ));
        out.push(
            Command::new(
                "refresh-tree",
                t!("Refresh file tree"),
                Section::Project,
                RefreshFileTree,
            )
            .keywords(t!("reload files folders sync disk")),
        );
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
            .on_action(
                cx.listener(|this: &mut Shell, _: &ShowDocumentSource, window, cx| {
                    this.show_document_view(DocumentView::Source, window, cx)
                }),
            )
            .on_action(
                cx.listener(|this: &mut Shell, _: &ShowDocumentSplit, window, cx| {
                    this.show_document_view(DocumentView::Split, window, cx)
                }),
            )
            .on_action(
                cx.listener(|this: &mut Shell, _: &ShowDocumentPreview, window, cx| {
                    this.show_document_view(DocumentView::Preview, window, cx)
                }),
            )
            .on_action(
                cx.listener(|this: &mut Shell, _: &TogglePdfWindow, window, cx| {
                    this.pdf.update(cx, |panel, cx| {
                        if panel.is_detached() {
                            panel.dock(true, window, cx)
                        } else {
                            panel.detach(window, cx)
                        }
                    })
                }),
            )
            .on_action(
                cx.listener(|this: &mut Shell, _: &TogglePdfDarkPages, _, cx| {
                    let view = this.pdf.read(cx).live_view().clone();
                    view.update(cx, |view, cx| view.toggle_dark_pages(cx))
                }),
            )
            .on_action(
                cx.listener(|this: &mut Shell, _: &NewFolderInProject, window, cx| {
                    this.show_view("project", false, window, cx);
                    this.file_tree()
                        .clone()
                        .update(cx, |tree, cx| tree.begin_create("", true, window, cx))
                }),
            )
            .on_action(
                cx.listener(|this: &mut Shell, _: &ImportFilesIntoProject, window, cx| {
                    this.show_view("project", false, window, cx);
                    this.choose_imports(String::new(), window, cx)
                }),
            )
            .on_action(cx.listener(|this: &mut Shell, _: &RefreshFileTree, _, cx| {
                this.file_tree()
                    .clone()
                    .update(cx, |tree, cx| tree.refresh(cx))
            }))
    },
    commands,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(context: &CommandContext) -> Vec<String> {
        let mut out = Vec::new();
        commands(context, &mut out);
        out.into_iter()
            .map(|command| command.label.to_string())
            .collect()
    }

    #[test]
    fn the_focus_pdf_row_follows_focus_mode_and_the_pdf() {
        assert_eq!(
            labels(&CommandContext::default()),
            ["Dark PDF pages", "Open guided tutorial"]
        );
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

    #[test]
    fn the_view_rows_are_the_two_views_not_shown_under_the_switch_names() {
        // use-command-table.ts: `view-${mode}`, the mode in use left out.
        let markdown = CommandContext {
            document_views: Some((false, DocumentView::Split)),
            ..CommandContext::default()
        };
        let shown = labels(&markdown);
        assert!(shown.contains(&"Edit Markdown".to_string()));
        assert!(shown.contains(&"Preview Markdown".to_string()));
        assert!(
            !shown
                .iter()
                .any(|label| label == "Edit and preview Markdown")
        );
        let html = CommandContext {
            document_views: Some((true, DocumentView::Preview)),
            ..CommandContext::default()
        };
        let shown = labels(&html);
        assert!(shown.contains(&"Edit HTML".to_string()));
        assert!(shown.contains(&"Edit and preview HTML".to_string()));
        assert!(!shown.iter().any(|label| label == "Preview HTML"));
    }

    #[test]
    fn the_pdf_rows_say_what_they_will_do() {
        let project = CommandContext {
            in_project: true,
            ..CommandContext::default()
        };
        let shown = labels(&project);
        assert!(shown.contains(&"Open the PDF in a separate window".to_string()));
        assert!(shown.contains(&"Dark PDF pages".to_string()));
        assert!(shown.contains(&"Refresh file tree".to_string()));
        let detached = CommandContext {
            pdf_window: true,
            pdf_dark: true,
            ..project
        };
        let shown = labels(&detached);
        assert!(shown.contains(&"Return the PDF to the workspace".to_string()));
        assert!(shown.contains(&"Light PDF pages".to_string()));
        // Without a project there is no PDF window to open.
        assert!(
            !labels(&CommandContext::default())
                .iter()
                .any(|label| label.contains("separate window"))
        );
    }
}
