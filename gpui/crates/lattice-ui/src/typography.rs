//! The six type roles, each a size with its own leading, taken together.
//!
//! Display 30/36 and Title 18/24 are the serif voice at regular weight, for
//! titles only. Everything else is the interface font: Subtitle 13/18
//! semibold, Body 13/20, Caption 12/16, Micro 11/14 medium; Body compact
//! (12/16 medium) is the text inside a control, and Typeset (14/22) is prose.
//! A region that is read rather than scanned (Settings) runs every role one
//! step up; Display does not step up.

use gpui::{App, FontWeight, Rems, Styled};

use crate::{ActiveLattice as _, fonts::Fonts, tokens::*};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextRole {
    Display,
    Title,
    Subtitle,
    Body,
    BodyCompact,
    Caption,
    Micro,
    Typeset,
}

/// Which scale a role is read from: the interface's, or Settings' one step up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum TypeScale {
    #[default]
    Interface,
    Settings,
}

impl TextRole {
    pub fn size(self, scale: TypeScale) -> Rems {
        match (scale, self) {
            (_, TextRole::Display) => TEXT_DISPLAY,
            (TypeScale::Interface, TextRole::Title) => TEXT_TITLE,
            (TypeScale::Interface, TextRole::Subtitle) => TEXT_SUBTITLE,
            (TypeScale::Interface, TextRole::Body) => TEXT_BODY,
            (TypeScale::Interface, TextRole::BodyCompact) => TEXT_BODY_COMPACT,
            (TypeScale::Interface, TextRole::Caption) => TEXT_CAPTION,
            (TypeScale::Interface, TextRole::Micro) => TEXT_MICRO,
            (TypeScale::Interface, TextRole::Typeset) => TEXT_TYPESET,
            (TypeScale::Settings, TextRole::Title) => TEXT_SETTINGS_TITLE,
            (TypeScale::Settings, TextRole::Subtitle) => TEXT_SETTINGS_SUBTITLE,
            (TypeScale::Settings, TextRole::Body) => TEXT_SETTINGS_BODY,
            (TypeScale::Settings, TextRole::BodyCompact) => TEXT_SETTINGS_BODY_COMPACT,
            (TypeScale::Settings, TextRole::Caption) => TEXT_SETTINGS_CAPTION,
            (TypeScale::Settings, TextRole::Micro) => TEXT_SETTINGS_MICRO,
            (TypeScale::Settings, TextRole::Typeset) => TEXT_SETTINGS_TYPESET,
        }
    }

    pub fn leading(self, scale: TypeScale) -> Rems {
        match (scale, self) {
            (_, TextRole::Display) => LEADING_DISPLAY,
            (TypeScale::Interface, TextRole::Title) => LEADING_TITLE,
            (TypeScale::Interface, TextRole::Subtitle) => LEADING_SUBTITLE,
            (TypeScale::Interface, TextRole::Body) => LEADING_BODY,
            (TypeScale::Interface, TextRole::BodyCompact) => LEADING_BODY_COMPACT,
            (TypeScale::Interface, TextRole::Caption) => LEADING_CAPTION,
            (TypeScale::Interface, TextRole::Micro) => LEADING_MICRO,
            (TypeScale::Interface, TextRole::Typeset) => LEADING_TYPESET,
            (TypeScale::Settings, TextRole::Title) => LEADING_SETTINGS_TITLE,
            (TypeScale::Settings, TextRole::Subtitle) => LEADING_SETTINGS_SUBTITLE,
            (TypeScale::Settings, TextRole::Body) => LEADING_SETTINGS_BODY,
            (TypeScale::Settings, TextRole::BodyCompact) => LEADING_SETTINGS_BODY_COMPACT,
            (TypeScale::Settings, TextRole::Caption) => LEADING_SETTINGS_CAPTION,
            (TypeScale::Settings, TextRole::Micro) => LEADING_SETTINGS_MICRO,
            (TypeScale::Settings, TextRole::Typeset) => LEADING_SETTINGS_TYPESET,
        }
    }

    pub fn weight(self) -> FontWeight {
        match self {
            TextRole::Subtitle => FONT_WEIGHT_SEMIBOLD,
            TextRole::BodyCompact | TextRole::Micro => FONT_WEIGHT_MEDIUM,
            _ => FONT_WEIGHT_REGULAR,
        }
    }

    /// The size the role sets in this build's face: its token, times the
    /// face's size-adjust.
    pub fn font_size(self, scale: TypeScale, cx: &App) -> Rems {
        self.adjusted_size(scale, &cx.lattice().fonts)
    }

    fn adjusted_size(self, scale: TypeScale, fonts: &Fonts) -> Rems {
        let adjust = if self.is_serif() {
            fonts.display_size_adjust
        } else {
            fonts.ui_size_adjust
        };
        Rems(self.size(scale).0 * adjust)
    }

    /// Display and Title are the serif voice.
    pub fn is_serif(self) -> bool {
        matches!(self, TextRole::Display | TextRole::Title)
    }
}

/// Set a role's family, size, leading and weight in one call, so no
/// component sets a size without its leading.
pub trait TextRoleStyle: Styled + Sized {
    fn text_role(self, role: TextRole, cx: &App) -> Self {
        self.text_role_in(role, TypeScale::Interface, cx)
    }

    fn text_role_in(self, role: TextRole, scale: TypeScale, cx: &App) -> Self {
        let fonts = &cx.lattice().fonts;
        let (family, fallbacks) = if role.is_serif() {
            (fonts.display.clone(), Fonts::display_fallbacks())
        } else {
            (fonts.ui.clone(), Fonts::ui_fallbacks())
        };
        let mut this = self
            .font_family(family)
            .text_size(role.font_size(scale, cx))
            .line_height(role.leading(scale))
            .font_weight(role.weight());
        this.text_style().font_fallbacks = Some(fallbacks);
        this
    }
}

impl<T: Styled> TextRoleStyle for T {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_voice_scales_by_its_own_face() {
        let fonts = Fonts {
            ui_size_adjust: 1.04,
            display_size_adjust: 1.05,
            ..Fonts::open()
        };
        for scale in [TypeScale::Interface, TypeScale::Settings] {
            assert_eq!(
                TextRole::Display.adjusted_size(scale, &fonts),
                Rems(30. / 16. * 1.05)
            );
            assert_eq!(
                TextRole::Body.adjusted_size(scale, &fonts),
                Rems(TextRole::Body.size(scale).0 * 1.04)
            );
        }
        let open = Fonts::open();
        assert_eq!(
            TextRole::Title.adjusted_size(TypeScale::Interface, &open),
            TextRole::Title.size(TypeScale::Interface)
        );
    }
}
