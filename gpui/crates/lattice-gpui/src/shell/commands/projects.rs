//! The table's ways to another project (`src/app/project-switch-commands.ts`
//! and the project group of `use-command-table.ts`): a new project, a folder
//! (in a window of its own once this one shows a project, or here), each
//! recent project the same two ways, a clone or an Overleaf ZIP, windows, and
//! the projects in this window.

use super::*;
use crate::shell::history_flow::{OpenHistory, ResolveConflicts};

pub(super) fn project_commands(context: &CommandContext, out: &mut Vec<Command>) {
    out.push(Command::new(
        "new-project",
        "New project",
        Section::Project,
        NewProject,
    ));
    out.push(Command::new(
        "open-folder",
        t!("Open another folder"),
        Section::Project,
        OpenFolder,
    ));
    if context.in_project {
        out.push(Command::new(
            "open-folder-here",
            "Open a folder in this window",
            Section::Project,
            OpenFolderHere,
        ));
    }
    // The other recent projects (`project-switch-commands.ts`): each in a
    // window of its own, and from a project each in this window too.
    for (here, recent) in [(false, true), (true, context.in_project)] {
        if !recent {
            continue;
        }
        for (index, (name, path)) in context.recent.iter().enumerate() {
            let (id, label) = if here {
                (
                    format!("recent-project-here-{index}"),
                    format!("Open {name} in this window"),
                )
            } else {
                (format!("recent-project-{index}"), format!("Open {name}"))
            };
            out.push(Command::new(
                id,
                label,
                Section::Project,
                OpenRecentProject {
                    path: path.clone(),
                    here,
                },
            ));
        }
    }
    out.push(
        Command::new(
            "clone-repository",
            "Clone a Git repository",
            Section::Project,
            CloneRepository,
        )
        .keywords("git clone GitHub GitLab"),
    );
    out.push(Command::new(
        "import-zip",
        "Import Overleaf ZIP",
        Section::Project,
        ImportZip,
    ));
    out.push(Command::new(
        "new-window",
        t!("New window"),
        Section::Project,
        NewWindow,
    ));
    if context.in_project {
        out.push(Command::new(
            "open-in-new-window",
            t!("Open this project in a new window"),
            Section::Project,
            OpenInNewWindow,
        ));
    }
    if context.in_project {
        out.push(Command::new(
            "history",
            t!("Open project history"),
            Section::Project,
            OpenHistory,
        ));
        out.push(
            Command::new(
                "resolve-conflicts",
                t!("Resolve conflicts…"),
                Section::Project,
                ResolveConflicts,
            )
            .keywords("git merge markers"),
        );
    }
    out.push(Command::new(
        "doctor",
        t!("Run TeX doctor"),
        Section::Project,
        OpenTexDoctor,
    ));
    out.push(Command::new(
        "settings",
        t!("Open settings"),
        Section::Project,
        OpenSettings,
    ));
    if context.projects > 1 {
        out.push(Command::new(
            "next-project",
            t!("Next project in this window"),
            Section::Project,
            NextProject,
        ));
        out.push(Command::new(
            "previous-project",
            t!("Previous project in this window"),
            Section::Project,
            PreviousProject,
        ));
        out.push(Command::new(
            "close-project",
            t!("Close this project"),
            Section::Project,
            CloseProject,
        ));
    }
}
