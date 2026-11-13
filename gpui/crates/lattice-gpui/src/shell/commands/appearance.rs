//! The palette's appearance commands (`use-command-table.ts`): the theme
//! light, dark or the system's, and the interface size, which ⌘+ / ⌘= / ⌘−
//! / ⌘0 also reach (`interface_zoom`).

use gpui::Action;
use lattice_i18n::t;

use super::{
    Command, LargerInterface, ResetInterfaceSize, Section, SmallerInterface, ThemeDark, ThemeLight,
    ThemeSystem,
};

pub(super) fn appearance_commands(out: &mut Vec<Command>) {
    for (id, label, action) in [
        (
            "theme-light",
            t!("Use the light theme"),
            Box::new(ThemeLight) as Box<dyn Action>,
        ),
        ("theme-dark", t!("Use the dark theme"), Box::new(ThemeDark)),
        (
            "theme-system",
            t!("Match the system theme"),
            Box::new(ThemeSystem),
        ),
    ] {
        out.push(Command {
            id: id.into(),
            label: label.into(),
            section: Section::Appearance,
            action,
            palette: true,
            keywords: "theme appearance",
        });
    }
    // The interface size, as every Mac app binds it (`interface-bigger`,
    // `interface-smaller`, `interface-actual-size`).
    for (id, label, action) in [
        (
            "interface-bigger",
            t!("Larger interface"),
            Box::new(LargerInterface) as Box<dyn Action>,
        ),
        (
            "interface-smaller",
            t!("Smaller interface"),
            Box::new(SmallerInterface),
        ),
        (
            "interface-actual-size",
            t!("Reset interface size"),
            Box::new(ResetInterfaceSize),
        ),
    ] {
        out.push(Command {
            id: id.into(),
            label: label.into(),
            section: Section::Appearance,
            action,
            palette: true,
            keywords: "",
        });
    }
}
