//! The table's ways to another project (`src/app/project-switch-commands.ts`
//! and the project group of `use-command-table.ts`): a new project, a folder
//! (in a window of its own once this one shows a project, or here), each
//! recent project the same two ways, a clone or an Overleaf ZIP, windows, and
//! the projects in this window.

use super::*;
use crate::shell::history_flow::{OpenHistory, ResolveConflicts};
use crate::shell::overleaf_flow::{OpenOnOverleaf, OpenOverleafProject, SyncOverleaf};

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
    // The Overleaf group (`use-command-table.ts`).
    out.push(Command::new(
        "import-zip",
        t!("Import Overleaf ZIP"),
        Section::Overleaf,
        ImportZip,
    ));
    out.push(Command::new(
        "overleaf-open",
        t!("Open an Overleaf project"),
        Section::Overleaf,
        OpenOverleafProject,
    ));
    if context.in_project && context.overleaf_linked && !context.overleaf_syncing {
        out.push(Command::new(
            "overleaf-sync",
            t!("Sync with Overleaf"),
            Section::Overleaf,
            SyncOverleaf,
        ));
    }
    if context.in_project && context.overleaf_linked {
        out.push(Command::new(
            "overleaf-web",
            t!("Open this project on Overleaf"),
            Section::Overleaf,
            OpenOnOverleaf,
        ));
    }
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
        super::submission::project_commands(out);
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
    out.push(
        Command::new(
            "whats-new",
            t!("What’s new in Lattice"),
            Section::Project,
            crate::shell::WhatsNew,
        )
        .keywords(crate::help::whats_new::RUNNING_VERSION),
    );
    out.push(Command::new(
        "doctor",
        t!("Run TeX doctor"),
        Section::Project,
        OpenTexDoctor,
    ));
    out.push(Command::new(
        "report-problem",
        t!("Report a problem"),
        Section::Project,
        crate::shell::ReportProblem,
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
