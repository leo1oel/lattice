//! Export figures for a journal… (`journal-export-command.ts`,
//! `src/project/journal-export.ts`): the palette's row in a project. It asks
//! for a folder, saves what the editors hold, says it is typesetting, then
//! has lattice-core's `export_journal` write each figure made from a drawing
//! as the files a journal asks for (`Scheme1.pdf`, `Scheme1.tiff` at
//! 600 dpi) and the paper as a source pack that includes them, into a new
//! folder of its own there. Nothing in the project changes.
//!
//! The outcome replaces the typesetting notice under the same key: a success
//! naming the figures, an info that stays when something went wrong without
//! stopping the export (its problems as the detail), each with Show in
//! Finder on the folder; or an error with lattice-core's message.

use std::path::{Path, PathBuf};

use gpui::{AppContext as _, Context, InteractiveElement as _, PathPromptOptions, Window, actions};
use lattice_core::latex::{JournalExport, JournalOptions};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;

use super::{
    Shell,
    commands::{Command, CommandContext, Section},
    parts::Part,
};
use crate::notices::{self, Notice, NoticeAction};

actions!(lattice, [ExportForJournal]);

/// The notices' shared key (`dedupeKey: "journal-export"`).
const KEY: &str = "journal-export";

/// Journals ask for 300 dpi in colour and up to 1200 for line art; 600
/// keeps a scheme's thin bonds and small numbers sharp at a size they all
/// accept (`TIFF_DPI`).
const TIFF_DPI: u32 = 600;

const OPTIONS: JournalOptions = JournalOptions {
    tiff: true,
    dpi: TIFF_DPI,
    article: true,
};

/// The part's state: whether an export is under way, so a second run of the
/// command waits for the first rather than typesetting the paper twice.
#[derive(Default)]
struct JournalExportState {
    busy: bool,
}

/// The notice that says how the export ended.
fn outcome(result: Result<JournalExport, String>) -> Notice {
    let source = t!("Export figures for a journal");
    let export = match result {
        Ok(export) => export,
        Err(message) => {
            return Notice::new(ToastLevel::Error, message).source(source).key(KEY);
        }
    };
    let figures = export.figures.join(", ");
    let title = t!("Exported {figures} and the paper that includes them", figures = figures);
    let mut notice = if export.problems.is_empty() {
        Notice::new(ToastLevel::Success, title)
    } else {
        // Something went wrong without stopping it: it stays to be read.
        Notice::new(ToastLevel::Info, title)
            .detail(export.problems.join("\n"))
            .persistent()
    };
    notice = notice.source(source).key(KEY);
    let folder = PathBuf::from(export.folder);
    notice.action(NoticeAction::new(t!("Show in Finder"), move |_, cx| {
        cx.reveal_path(&folder)
    }))
}

impl Shell {
    /// Whether an export is under way.
    pub(crate) fn exporting_for_journal(&self) -> bool {
        self.parts.get::<JournalExportState>().busy
    }

    pub(crate) fn export_for_journal(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if self.root(cx).is_none() || self.exporting_for_journal() {
            return;
        }
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(t!("Choose where to put the figures for the journal").into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else {
                return;
            };
            let Some(parent) = paths.into_iter().next() else {
                return;
            };
            Self::export_journal_into(this, parent, cx).await;
        })
        .detach();
    }

    /// Save, then write the export into a new folder in `parent`.
    async fn export_journal_into(
        this: gpui::WeakEntity<Self>,
        parent: PathBuf,
        cx: &mut gpui::AsyncApp,
    ) {
        let Ok(Some(root)) = this.update(cx, |this, cx| {
            let root = this.root(cx)?;
            this.parts.get_mut::<JournalExportState>().busy = true;
            Some(root)
        }) else {
            return;
        };
        // A save that fails says why itself, and nothing is written.
        let saved = match this.update(cx, |this, cx| this.save_editors(cx)) {
            Ok(task) => task.await,
            Err(_) => false,
        };
        if saved {
            cx.update(|cx| {
                notices::show(
                    Notice::new(ToastLevel::Info, t!("Typesetting the paper to cut out its figures…"))
                        .source(t!("Export figures for a journal"))
                        .key(KEY),
                    cx,
                )
            });
            let result = cx
                .background_spawn(async move { export(&root, &parent) })
                .await;
            cx.update(|cx| notices::show(outcome(result), cx));
        }
        this.update(cx, |this, _| {
            this.parts.get_mut::<JournalExportState>().busy = false;
        })
        .ok();
    }

    /// Export into `parent` without asking where, for scenarios.
    pub(crate) fn export_for_journal_into(&mut self, parent: PathBuf, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| Self::export_journal_into(this, parent, cx).await)
            .detach();
    }
}

fn export(root: &Path, parent: &Path) -> Result<JournalExport, String> {
    lattice_core::latex::export_journal(root, parent, OPTIONS)
}

fn commands(context: &CommandContext, out: &mut Vec<Command>) {
    if context.in_project {
        out.push(Command::new(
            "export-journal",
            t!("Export figures for a journal…"),
            Section::Project,
            ExportForJournal,
        ));
    }
}

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(JournalExportState::default()),
    views: &[],
    actions: |element, cx| {
        element.on_action(
            cx.listener(|this: &mut Shell, _: &ExportForJournal, window, cx| {
                this.export_for_journal(window, cx)
            }),
        )
    },
    commands,
};
