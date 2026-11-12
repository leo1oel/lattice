//! The six type roles, each a size with its own leading, taken together.
//!
//! Display 30/36 and Title 18/24 are the serif voice at regular weight, for
//! titles only. Everything else is the interface font: Subtitle 13/18
//! semibold, Body 13/20, Caption 12/16, Micro 11/14 medium; Body compact
//! (12/16 medium) is the text inside a control, and Typeset (14/22) is prose.
//! A region that is read rather than scanned (Settings) runs every role one
//! step up; Display does not step up.
//!
//! Every role sets normal tracking (`--tracking-normal`); an uppercase micro
//! label (a venue's kind, a colour's hex, a board's eyebrow) opens it to
//! `--tracking-caps` with [`TextRoleStyle::tracking`].

use gpui::{App, FontWeight, Rems, Styled, relative};

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

/// How open a run of type is set, in ems of its size.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Tracking {
    /// Every interface role.
    #[default]
    Normal,
    /// An uppercase micro label.
    Caps,
}

impl Tracking {
    pub fn em(self) -> f32 {
        match self {
            Tracking::Normal => TRACKING_NORMAL,
            Tracking::Caps => TRACKING_CAPS,
        }
    }
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

    /// The size the role sets in this build's face: its token, the
    /// interface roles times the sans's size-adjust. The serif roles have
    /// none.
    pub fn font_size(self, scale: TypeScale, cx: &App) -> Rems {
        self.adjusted_size(scale, &cx.lattice().fonts)
    }

    fn adjusted_size(self, scale: TypeScale, fonts: &Fonts) -> Rems {
        let size = self.size(scale);
        if self.is_serif() {
            size
        } else {
            Rems(size.0 * fonts.ui_size_adjust)
        }
    }

    /// Display and Title are the serif voice.
    pub fn is_serif(self) -> bool {
        matches!(self, TextRole::Display | TextRole::Title)
    }
}

/// Set a role's family, size, leading, weight and tracking in one call, so
/// no component sets a size without its leading.
/// How wide `text` draws in `role` at `weight` (the role's own when `None`),
/// for a layout that has to know before it lays the text out: a strip
/// deciding which tabs keep their names.
/// CSS's `font-variant-numeric: tabular-nums`: every digit as wide as every
/// other, for counts and times that change in place (the status bar, the
/// Build button).
pub fn tabular_nums() -> gpui::FontFeatures {
    gpui::FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)]))
}

pub fn shaped_width(
    text: &str,
    role: TextRole,
    weight: Option<FontWeight>,
    window: &gpui::Window,
    cx: &App,
) -> gpui::Pixels {
    shaped_width_with(text, role, weight, None, window, cx)
}

/// [`shaped_width`] with OpenType `features` (say [`tabular_nums`]).
pub fn shaped_width_with(
    text: &str,
    role: TextRole,
    weight: Option<FontWeight>,
    features: Option<gpui::FontFeatures>,
    window: &gpui::Window,
    cx: &App,
) -> gpui::Pixels {
    let fonts = &cx.lattice().fonts;
    let (family, fallbacks) = if role.is_serif() {
        (fonts.display.clone(), Fonts::display_fallbacks())
    } else {
        (fonts.ui.clone(), Fonts::ui_fallbacks())
    };
    let mut font = gpui::font(family);
    font.weight = weight.unwrap_or(role.weight());
    font.fallbacks = Some(fallbacks);
    if let Some(features) = features {
        font.features = features;
    }
    let size = role
        .font_size(TypeScale::Interface, cx)
        .to_pixels(window.rem_size());
    let run = gpui::TextRun {
        len: text.len(),
        font,
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window
        .text_system()
        .shape_line(text.to_string().into(), size, &[run], None)
        .width
}

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
            .font_weight(role.weight())
            .letter_spacing(relative(Tracking::Normal.em()));
        this.text_style().font_fallbacks = Some(fallbacks);
        this
    }

    /// Open (or close) the tracking of what the role set; type it in capitals
    /// yourself, GPUI has no text transform.
    fn tracking(self, tracking: Tracking) -> Self {
        self.letter_spacing(relative(tracking.em()))
    }
}

impl<T: Styled> TextRoleStyle for T {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_tracking_opens_a_label_by_the_token() {
        assert_eq!(Tracking::Normal.em(), 0.);
        let mut label = gpui::div().tracking(Tracking::Caps);
        assert_eq!(
            label.text_style().letter_spacing,
            Some(relative(TRACKING_CAPS))
        );
        assert_eq!(TRACKING_CAPS, 0.04);
    }

    #[test]
    fn only_the_interface_sans_is_scaled() {
        // The Tauri build gives Timeless Sans `size-adjust: 104%` and the
        // display serif none.
        let fonts = Fonts {
            ui_size_adjust: 1.04,
            ..Fonts::open()
        };
        assert_eq!(
            TextRole::Body.adjusted_size(TypeScale::Interface, &fonts),
            Rems(13. / 16. * 1.04)
        );
        assert_eq!(
            TextRole::Display.adjusted_size(TypeScale::Interface, &fonts),
            Rems(30. / 16.)
        );
    }
}
