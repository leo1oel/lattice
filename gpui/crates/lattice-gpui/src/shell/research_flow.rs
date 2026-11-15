//! The palette's Research section, as the Tauri command table has it
//! (`use-command-table.ts`, `group: "research"`): Add papers, Discover
//! literature and Check references, each what the Papers panel's own
//! buttons do, while a project is open.

use gpui::{InteractiveElement as _, actions};
use lattice_i18n::t;

use super::{
    Shell,
    commands::{Command, CommandContext, Section},
    parts::Part,
};

actions!(lattice, [AddPapers, DiscoverLiterature, CheckReferences]);

/// Nothing of its own to keep: its rows open what the Papers panel opens.
struct Research;

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(Research),
    views: &[],
    actions: |element, cx| {
        element
            .on_action(cx.listener(|this: &mut Shell, _: &AddPapers, window, cx| {
                this.open_add_papers(String::new(), window, cx)
            }))
            .on_action(
                cx.listener(|this: &mut Shell, _: &DiscoverLiterature, window, cx| {
                    this.open_literature(String::new(), window, cx)
                }),
            )
            .on_action(
                cx.listener(|this: &mut Shell, _: &CheckReferences, window, cx| {
                    this.open_audit(window, cx)
                }),
            )
    },
    commands,
};

fn commands(context: &CommandContext, out: &mut Vec<Command>) {
    if !context.in_project {
        return;
    }
    out.push(
        Command::new("bib", t!("Add papers"), Section::Research, AddPapers)
            .keywords(t!("DOIs, arXiv IDs, links, titles or BibTeX")),
    );
    // The sources' own names, for search only.
    out.push(
        Command::new(
            "discover",
            t!("Discover literature"),
            Section::Research,
            DiscoverLiterature,
        )
        .keywords("alphaXiv OpenAlex"),
    );
    out.push(Command::new(
        "check-references",
        t!("Check references"),
        Section::Research,
        CheckReferences,
    ));
}
