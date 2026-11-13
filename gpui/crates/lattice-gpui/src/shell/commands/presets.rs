//! The table's layout presets (`src/app/use-command-table.ts`): each of
//! Writing, Reading and Bibliography, or the way back from the one showing.

use super::*;

pub(super) fn preset_commands(context: &CommandContext, out: &mut Vec<Command>) {
    for preset in Preset::ALL {
        let on = context.preset == Some(preset);
        let (id, action): (&str, Box<dyn Action>) = match (preset, on) {
            (_, true) => ("preset-return", Box::new(ReturnToWorkspace)),
            (Preset::Writing, false) => ("preset-writing", Box::new(WritingPreset)),
            (Preset::Reading, false) => ("preset-reading", Box::new(ReadingPreset)),
            (Preset::Bibliography, false) => ("preset-bibliography", Box::new(BibliographyPreset)),
        };
        out.push(Command {
            id: id.into(),
            label: match (preset, on) {
                (Preset::Writing, true) => t!("Leave the Writing layout"),
                (Preset::Reading, true) => t!("Leave the Reading layout"),
                (Preset::Bibliography, true) => t!("Leave the Bibliography layout"),
                (Preset::Writing, false) => t!("Writing layout"),
                (Preset::Reading, false) => t!("Reading layout"),
                (Preset::Bibliography, false) => t!("Bibliography layout"),
            }
            .into(),
            section: Section::Layout,
            action,
            palette: true,
            keywords: "preset",
        });
    }
}
