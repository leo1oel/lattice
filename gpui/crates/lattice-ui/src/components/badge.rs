//! A badge: a short status or count on a 6px corner, 20px tall (16 compact).
//!
//! Paper's Small controls: a neutral badge is the ink's 8% wash with
//! secondary ink; a status badge is its status's 12% wash with the status ink
//! (the only place a status colours words is the badge that names it).

use gpui::{
    App, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _, Window, div, px,
};

use crate::{ActiveLattice as _, TextRole, TextRoleStyle as _};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum BadgeTone {
    #[default]
    Neutral,
    Success,
    Warning,
    Danger,
}

#[derive(IntoElement)]
pub struct Badge {
    label: SharedString,
    tone: BadgeTone,
    compact: bool,
    elevated: bool,
}

impl Badge {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            tone: BadgeTone::Neutral,
            compact: false,
            elevated: false,
        }
    }

    pub fn tone(mut self, tone: BadgeTone) -> Self {
        self.tone = tone;
        self
    }

    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    /// On the elevated surface with the primary ink, 6px either side: a
    /// label laid over a picture, which the neutral wash would let show
    /// through (`.welcome-desk-venue`).
    pub fn elevated(mut self) -> Self {
        self.elevated = true;
        self
    }
}

impl RenderOnce for Badge {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        let (bg, ink) = match self.tone {
            _ if self.elevated => (palette.raised, palette.text),
            BadgeTone::Neutral => (palette.pressed, palette.text_secondary),
            BadgeTone::Success => (palette.success_soft, palette.success),
            BadgeTone::Warning => (palette.warning_soft, palette.warning),
            BadgeTone::Danger => (palette.danger_soft, palette.danger),
        };
        let (height, role) = if self.compact {
            (px(16.), TextRole::Micro)
        } else {
            (px(20.), TextRole::Caption)
        };
        div()
            .flex()
            .flex_none()
            .items_center()
            .h(height)
            .px(px(if self.compact && !self.elevated {
                4.
            } else {
                6.
            }))
            .rounded(px(6.))
            .bg(bg)
            .whitespace_nowrap()
            .text_role(role, cx)
            .font_weight(crate::tokens::FONT_WEIGHT_MEDIUM)
            .text_color(ink)
            .child(self.label)
    }
}
