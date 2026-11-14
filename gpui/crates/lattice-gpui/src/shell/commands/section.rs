//! The palette's sections: each command's group, its heading and icon.

use lattice_i18n::t;
use lattice_ui::Icon;

/// The palette's sections, in the order an empty palette lists them
/// (`src/app/palette-sections.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Section {
    Navigate,
    Edit,
    Build,
    View,
    Layout,
    Overleaf,
    Project,
    Appearance,
}

impl Section {
    pub fn label(self) -> &'static str {
        match self {
            Section::Navigate => t!("Navigate"),
            Section::Edit => t!("Edit"),
            Section::Build => t!("Build"),
            Section::View => t!("View"),
            Section::Layout => t!("Layout"),
            Section::Overleaf => t!("Overleaf"),
            Section::Project => t!("Project"),
            Section::Appearance => t!("Appearance"),
        }
    }

    pub fn icon(self) -> Icon {
        match self {
            Section::Navigate => Icon::COMPASS,
            Section::Edit => Icon::PEN_LINE,
            Section::Build => Icon::HAMMER,
            Section::View => Icon::EYE,
            Section::Layout => Icon::LAYOUT_PANEL_LEFT,
            Section::Overleaf => Icon::CLOUD,
            Section::Project => Icon::FOLDER_OPEN,
            Section::Appearance => Icon::SUN_MOON,
        }
    }
}
