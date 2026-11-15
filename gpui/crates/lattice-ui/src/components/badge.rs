//! A badge: a short status or count on a 6px corner, 20px tall (16 compact).
//!
//! Paper's Small controls: a neutral badge is the ink's 8% wash with
//! secondary ink; a status badge is its status's 12% wash with the status ink
//! (the only place a status colours words is the badge that names it).

use gpui::{
    App, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::{ActiveLattice as _, Icon, TextRole, TextRoleStyle as _};

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
    icon: Option<Icon>,
    shrinks: bool,
}

impl Badge {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            tone: BadgeTone::Neutral,
            compact: false,
            elevated: false,
            icon: None,
            shrinks: false,
        }
    }

    /// A 12px glyph before the label, in the label's ink (a citation
    /// card's fact: a check, or a warning triangle).
    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// Narrower than its words when its row is: the words give way to an
    /// ellipsis (a long DOI on a citation card, `.citation-card-fact`).
    pub fn shrinks(mut self) -> Self {
        self.shrinks = true;
        self
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
            .when(!self.shrinks, |badge| badge.flex_none())
            .when(self.shrinks, |badge| badge.min_w_0().max_w_full())
            .items_center()
            .gap(px(4.))
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
            .when_some(self.icon, |badge, icon| {
                badge.child(icon.element(px(12.), ink).flex_none())
            })
            .map(|badge| {
                if self.shrinks {
                    badge.child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(self.label),
                    )
                } else {
                    badge.child(self.label)
                }
            })
    }
}
