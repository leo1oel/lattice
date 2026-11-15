//! The palette's appearance commands (`use-command-table.ts`): the theme
//! light, dark or the system's, and the interface size, which ⌘+ / ⌘= / ⌘−
//! / ⌘0 also reach (`interface_zoom`).

use gpui::Action;
use lattice_i18n::t;
use lattice_settings::ThemePreference;

use super::{
    Command, LargerInterface, ResetInterfaceSize, Section, SmallerInterface, ThemeDark, ThemeLight,
    ThemeSystem,
};

/// The theme rows leave out the one in use (`preference !== themePreference`).
pub(super) fn appearance_commands(theme: ThemePreference, out: &mut Vec<Command>) {
    for (preference, id, label, action) in [
        (
            ThemePreference::Light,
            "theme-light",
            t!("Use the light theme"),
            Box::new(ThemeLight) as Box<dyn Action>,
        ),
        (
            ThemePreference::Dark,
            "theme-dark",
            t!("Use the dark theme"),
            Box::new(ThemeDark),
        ),
        (
            ThemePreference::System,
            "theme-system",
            t!("Match the system theme"),
            Box::new(ThemeSystem),
        ),
    ] {
        if preference == theme {
            continue;
        }
        out.push(Command {
            id: id.into(),
            label: label.into(),
            section: Section::Appearance,
            action,
            palette: true,
            keywords: "theme appearance",
            detail: None,
            recent: true,
            keys_of: None,
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
            detail: None,
            recent: true,
            keys_of: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_theme_in_use_is_not_offered() {
        // use-command-table.ts: the two preferences not in use.
        for (theme, left_out) in [
            (ThemePreference::Light, "theme-light"),
            (ThemePreference::Dark, "theme-dark"),
            (ThemePreference::System, "theme-system"),
        ] {
            let mut out = Vec::new();
            appearance_commands(theme, &mut out);
            let themes: Vec<_> = out
                .iter()
                .map(|command| command.id.to_string())
                .filter(|id| id.starts_with("theme-"))
                .collect();
            assert_eq!(themes.len(), 2);
            assert!(!themes.iter().any(|id| id == left_out));
        }
    }
}
