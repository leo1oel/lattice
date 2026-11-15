//! The table's layout presets (`src/app/use-command-table.ts`): Switch to
//! the Writing, Reading or Bibliography layout, the one in use not offered
//! again.

use super::*;

pub(super) fn preset_commands(context: &CommandContext, out: &mut Vec<Command>) {
    for preset in Preset::ALL {
        if context.preset == Some(preset) {
            continue;
        }
        let (id, label, action): (&str, &str, Box<dyn Action>) = match preset {
            Preset::Writing => (
                "preset-writing",
                t!("Switch to the Writing layout"),
                Box::new(WritingPreset),
            ),
            Preset::Reading => (
                "preset-reading",
                t!("Switch to the Reading layout"),
                Box::new(ReadingPreset),
            ),
            Preset::Bibliography => (
                "preset-bibliography",
                t!("Switch to the Bibliography layout"),
                Box::new(BibliographyPreset),
            ),
        };
        out.push(Command {
            id: id.into(),
            label: label.into(),
            section: Section::Layout,
            action,
            palette: true,
            keywords: "preset",
            detail: None,
            recent: true,
            keys_of: None,
        });
    }
}
