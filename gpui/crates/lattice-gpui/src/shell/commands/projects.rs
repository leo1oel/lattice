//! The table's ways to another project (`src/app/project-switch-commands.ts`
//! and the project group of `use-command-table.ts`): a new project, a folder
//! (in a window of its own once this one shows a project, or here), each
//! recent project the same two ways, a clone or an Overleaf ZIP, windows, and
//! the projects in this window.

use super::*;

pub(super) fn project_commands(context: &CommandContext, out: &mut Vec<Command>) {
    out.push(Command::new(
        "new-project",
        "New project",
        Section::Project,
        NewProject,
    ));
    out.push(Command::new(
        "open-folder",
        "Open another folder",
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
        "New window",
        Section::Project,
        NewWindow,
    ));
    if context.in_project {
        out.push(Command::new(
            "open-in-new-window",
            "Open this project in a new window",
            Section::Project,
            OpenInNewWindow,
        ));
    }
    out.push(Command::new(
        "doctor",
        "Run TeX doctor",
        Section::Project,
        OpenTexDoctor,
    ));
    if context.projects > 1 {
        out.push(Command::new(
            "next-project",
            "Next project",
            Section::Project,
            NextProject,
        ));
        out.push(Command::new(
            "previous-project",
            "Previous project",
            Section::Project,
            PreviousProject,
        ));
        out.push(Command::new(
            "close-project",
            "Close this project",
            Section::Project,
            CloseProject,
        ));
    }
}
