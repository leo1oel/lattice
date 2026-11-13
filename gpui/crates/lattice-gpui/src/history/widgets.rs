//! The history's own controls, each the Tauri app's rule in
//! `history-timeline.css` and `compare-versions.css`: the view pills, the
//! outlined actions (Save version, Restore this file), a row's icon tools,
//! a version's file chips, the underlined switches, the ↑ ↓ steps. Hover and
//! press fade on the fast tier (`lattice_ui::interaction`), as the CSS
//! transitions do, and a keyboard focus draws the one focus ring.

use std::rc::Rc;

use gpui::{
    AnimationExt as _, AnyElement, App, ClickEvent, ElementId, Hsla, InteractiveElement as _,
    IntoElement, ParentElement as _, Pixels, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
    transparent_black,
};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{LatticeTooltip, focus_ring},
    interaction::{tab_stop, track_pointer, use_interaction},
    tokens::{FONT_WEIGHT_MEDIUM, RADIUS_CONTROL, RADIUS_PILL},
};

/// A click's handler, as rows and controls take one.
pub type ClickHandler = dyn Fn(&gpui::ClickEvent, &mut Window, &mut App);

type OnClick = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// The shape every history control shares: what it shows and does.
#[derive(IntoElement)]
pub struct Control {
    id: ElementId,
    kind: Kind,
    icon: Option<Icon>,
    icon_size: Pixels,
    label: Option<SharedString>,
    tooltip: Option<SharedString>,
    on: bool,
    disabled: bool,
    danger: bool,
    ground: Option<Hsla>,
    spinning: bool,
    leading: Option<AnyElement>,
    parity: Option<SharedString>,
    on_click: Option<OnClick>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// `.history-view`: a pill, ringed until pressed.
    Pill,
    /// `.versions-save` / `.version-action`: the strong hairline, no slab.
    Outline { medium: bool },
    /// `.history-tool` / `.version-step`: 24px, icon only.
    Tool { square: bool, hover_pressed: bool },
    /// `.versions-icon-button`: 28px, icon only.
    IconButton,
    /// `.version-file`: a chip on the hover wash, the accent when open.
    Chip,
    /// `.version-more-files` / `.compare-back`: quiet text.
    Quiet,
    /// `.version-mode-switch`: underlined text in the primary ink.
    Link,
    /// `.compare-picker-more`: a full-width row under a hairline.
    Row,
}

impl Control {
    fn new(id: impl Into<ElementId>, kind: Kind) -> Self {
        Self {
            id: id.into(),
            kind,
            icon: None,
            icon_size: px(12.),
            label: None,
            tooltip: None,
            on: false,
            disabled: false,
            danger: false,
            ground: None,
            spinning: false,
            leading: None,
            parity: None,
            on_click: None,
        }
    }

    pub fn pill(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self::new(id, Kind::Pill).label(label)
    }

    /// Save version and the toolbar's buttons: medium weight.
    pub fn outline(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self::new(id, Kind::Outline { medium: true }).label(label)
    }

    /// An opened version's actions: regular weight, primary ink.
    pub fn action(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self::new(id, Kind::Outline { medium: false }).label(label)
    }

    /// A row's tool: its hover is the pressed wash, as `.history-tool:hover` is.
    pub fn tool(id: impl Into<ElementId>, icon: Icon, tooltip: impl Into<SharedString>) -> Self {
        let mut control = Self::new(
            id,
            Kind::Tool {
                square: true,
                hover_pressed: true,
            },
        )
        .icon(icon, px(13.));
        control.tooltip = Some(tooltip.into());
        control
    }

    /// A ↑ ↓ step, its hover the hover wash; `round` for the compare pill's.
    pub fn step(
        id: impl Into<ElementId>,
        icon: Icon,
        tooltip: impl Into<SharedString>,
        round: bool,
    ) -> Self {
        let mut control = Self::new(
            id,
            Kind::Tool {
                square: !round,
                hover_pressed: false,
            },
        )
        .icon(icon, if round { px(13.) } else { px(12.) });
        control.tooltip = Some(tooltip.into());
        control
    }

    pub fn icon_button(
        id: impl Into<ElementId>,
        icon: Icon,
        tooltip: impl Into<SharedString>,
    ) -> Self {
        let mut control = Self::new(id, Kind::IconButton).icon(icon, px(13.));
        control.tooltip = Some(tooltip.into());
        control
    }

    pub fn chip(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self::new(id, Kind::Chip).label(label)
    }

    pub fn quiet(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self::new(id, Kind::Quiet).label(label)
    }

    pub fn link(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self::new(id, Kind::Link).label(label)
    }

    pub fn row(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self::new(id, Kind::Row).label(label)
    }

    pub fn icon(mut self, icon: Icon, size: Pixels) -> Self {
        self.icon = Some(icon);
        self.icon_size = size;
        self
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    /// Pressed (a pill), open (a chip).
    pub fn on(mut self, on: bool) -> Self {
        self.on = on;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// A destructive tool: its hover is the danger wash.
    pub fn danger(mut self) -> Self {
        self.danger = true;
        self
    }

    /// Something before the label in place of an icon: a file's kind.
    pub fn leading(mut self, leading: AnyElement) -> Self {
        self.leading = Some(leading);
        self
    }

    /// Name it as a parity-harness region (`lattice_ui::parity`), its label
    /// as the region's run of text.
    pub fn parity(mut self, name: impl Into<SharedString>) -> Self {
        self.parity = Some(name.into());
        self
    }

    /// Its icon turning, as a refresh's does while it reads (`ReloadGlyph`).
    pub fn spinning(mut self, spinning: bool) -> Self {
        self.spinning = spinning;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Control {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        let live = self.on_click.is_some() && !self.disabled;
        let clear = transparent_black();
        // Each kind's rest, hover and press washes and its ink.
        let (rest, hover, pressed, ink, hover_ink) = match self.kind {
            Kind::Pill if self.on => (
                palette.pressed,
                palette.pressed,
                palette.pressed,
                palette.text,
                palette.text,
            ),
            Kind::Pill => (
                clear,
                palette.hover,
                palette.pressed,
                palette.text_secondary,
                palette.text,
            ),
            Kind::Outline { .. } => (
                clear,
                palette.hover,
                palette.pressed,
                palette.text,
                palette.text,
            ),
            Kind::Tool { hover_pressed, .. } => {
                let (hover, ink) = if self.danger {
                    (palette.danger_soft, palette.danger)
                } else if hover_pressed {
                    (palette.pressed, palette.text)
                } else {
                    (palette.hover, palette.text)
                };
                (clear, hover, hover, palette.text_secondary, ink)
            }
            Kind::IconButton => (
                clear,
                palette.hover,
                palette.pressed,
                palette.text_secondary,
                palette.text,
            ),
            Kind::Chip if self.on => (
                palette.accent_soft,
                palette.accent_soft,
                palette.accent_soft,
                palette.accent,
                palette.accent,
            ),
            Kind::Chip => (
                palette.hover,
                palette.pressed,
                palette.pressed,
                palette.text_secondary,
                palette.text,
            ),
            Kind::Quiet => (
                clear,
                palette.hover,
                palette.pressed,
                palette.text_secondary,
                palette.text,
            ),
            Kind::Link => (clear, clear, clear, palette.text, palette.text),
            Kind::Row => (
                clear,
                palette.hover,
                palette.pressed,
                palette.text_secondary,
                palette.text,
            ),
        };
        let bg = if live {
            interaction.wash(rest, hover, pressed)
        } else {
            rest
        };
        let ink = if live {
            lattice_ui::interaction::mix(ink, hover_ink, interaction.hover)
        } else {
            ink
        };
        let disabled_outline = self.disabled && matches!(self.kind, Kind::Outline { .. });
        let (bg, ink) = if disabled_outline {
            (palette.disabled_surface, palette.disabled_ink)
        } else {
            (bg, ink)
        };
        let fade = self.disabled && !disabled_outline;
        let ground = self.ground.unwrap_or(palette.input);
        let focus = focus_ring(&palette, ground);

        let mut element = div().id(self.id.clone());
        if live {
            element = track_pointer(tab_stop(element), pointer)
                .cursor_pointer()
                .focus_visible(move |style| style.shadow(focus));
        }
        if let (Some(handler), true) = (self.on_click.clone(), live) {
            element = element.on_click(move |event, window, cx| handler(event, window, cx));
        }
        if let Some(tooltip) = self.tooltip.clone() {
            element = element.tooltip(move |_, cx| LatticeTooltip::view(tooltip.clone(), None, cx));
        }
        let spinning = self.spinning;
        let icon_id = self.id.clone();
        let icon = self.icon.map(|icon| {
            let glyph = icon.element(self.icon_size, ink);
            if spinning {
                glyph
                    .with_animation(
                        ElementId::NamedChild(std::sync::Arc::new(icon_id), "spin".into()),
                        gpui::Animation::new(std::time::Duration::from_millis(900)).repeat(),
                        |glyph, t| {
                            glyph.with_transformation(gpui::Transformation::rotate(gpui::radians(
                                t * std::f32::consts::TAU,
                            )))
                        },
                    )
                    .into_any_element()
            } else {
                glyph.into_any_element()
            }
        });
        let parity = self.parity.clone();
        let label =
            self.label
                .clone()
                .filter(|label| !label.is_empty())
                .map(|label| {
                    div()
                        .relative()
                        .children(parity.clone().and_then(|name| {
                            lattice_ui::parity::text_probe(name, 0, label.clone())
                        }))
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .child(label)
                });
        // The bordered kinds' regions are border boxes in the Tauri app.
        let border = match self.kind {
            Kind::Pill if !self.on => px(1.),
            Kind::Outline { .. } => px(1.),
            _ => px(0.),
        };
        let edges = gpui::Edges {
            top: border,
            right: border,
            bottom: border,
            left: border,
        };
        let element = element
            .relative()
            .children(parity.and_then(|name| lattice_ui::parity::bordered_probe(name, edges)))
            .flex()
            .flex_none()
            .items_center()
            .min_w_0()
            .max_w_full()
            .text_color(ink)
            .bg(bg)
            .when(fade, |this| this.opacity(0.42));
        match self.kind {
            // An idle pill's outline is an inset shadow in the Tauri app
            // (`.history-view`), so it takes no width: the border comes out
            // of the padding.
            Kind::Pill => element
                .h(px(28.))
                .px(px(10.) - border)
                .gap(px(4.))
                .rounded(RADIUS_PILL)
                .when(!self.on, |this| this.border_1().border_color(palette.line))
                .text_role(TextRole::Caption, cx)
                .when(self.on, |this| this.font_weight(FONT_WEIGHT_MEDIUM))
                .children(icon)
                .children(label)
                .into_any_element(),
            Kind::Outline { medium } => element
                .h(px(28.))
                .px(px(10.))
                .gap(px(4.))
                .rounded(RADIUS_CONTROL)
                .border_1()
                .border_color(if disabled_outline {
                    palette.disabled_border
                } else {
                    palette.line_strong
                })
                .text_role(TextRole::Caption, cx)
                .when(medium, |this| this.font_weight(FONT_WEIGHT_MEDIUM))
                .children(icon)
                .children(label)
                .into_any_element(),
            Kind::Tool { square, .. } => element
                .size(px(24.))
                .justify_center()
                .rounded(if square { RADIUS_CONTROL } else { RADIUS_PILL })
                .children(icon)
                .into_any_element(),
            Kind::IconButton => element
                .size(px(28.))
                .justify_center()
                .rounded(RADIUS_CONTROL)
                .children(icon)
                .into_any_element(),
            Kind::Chip => element
                .h(px(24.))
                .px(px(8.))
                .gap(px(4.))
                .rounded(RADIUS_CONTROL)
                .text_role(TextRole::Caption, cx)
                .when(self.on, |this| this.font_weight(FONT_WEIGHT_MEDIUM))
                .children(icon)
                .children(self.leading)
                .children(label)
                .into_any_element(),
            Kind::Quiet => element
                .h(px(28.))
                .px(px(4.))
                .gap(px(4.))
                .rounded(RADIUS_CONTROL)
                .text_role(TextRole::Caption, cx)
                .children(icon)
                .children(label)
                .into_any_element(),
            Kind::Row => element
                .w_full()
                .h(px(28.))
                .justify_center()
                .border_t_1()
                .border_color(palette.line)
                .text_role(TextRole::Caption, cx)
                .children(label)
                .into_any_element(),
            Kind::Link => {
                let underline = lattice_ui::interaction::mix(
                    palette.line_strong,
                    palette.text,
                    interaction.hover,
                );
                element
                    .text_decoration_1()
                    .text_decoration_color(underline)
                    .children(label)
                    .into_any_element()
            }
        }
    }
}

/// A line under a loader: "Loading diff…", "Comparing…".
pub fn loading_line(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .flex()
        .items_center()
        .gap(px(4.))
        .text_role(TextRole::Micro, cx)
        .text_color(palette.text_secondary)
        .child(crate::build::chip_mark::infinity_loader(
            id,
            px(12.),
            &palette,
        ))
        .child(label.into())
        .into_any_element()
}

/// `InlineMessage`: a 13px status icon on the first line, caption text
/// beside it; an error's text in the primary ink, the rest secondary.
pub fn inline_message(text: impl Into<SharedString>, error: bool, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let (icon, icon_ink) = if error {
        (Icon::CIRCLE_ALERT, palette.danger)
    } else {
        (Icon::INFO, palette.info)
    };
    div()
        .min_w_0()
        .flex()
        .items_start()
        .gap(px(6.))
        .text_role(TextRole::Caption, cx)
        .text_color(if error {
            palette.text
        } else {
            palette.text_secondary
        })
        .child(
            div()
                .flex_none()
                .pt(px(1.5))
                .child(icon.element(px(13.), icon_ink)),
        )
        .child(div().min_w_0().child(text.into()))
        .into_any_element()
}

const PEER_COLORS: [u32; 8] = [
    0x0b6e4f, 0x1d4ed8, 0xb45309, 0x7c3aed, 0xbe123c, 0x0e7490, 0xa16207, 0xc026d3,
];

/// A person's stable colour (`peerColorForName` in `collab-colors.ts`: FNV-1a
/// over the name's UTF-16 units).
pub fn peer_color(name: &str) -> Hsla {
    let seed = name.trim();
    let seed = if seed.is_empty() { "anonymous" } else { seed };
    let mut hash: u32 = 2166136261;
    for unit in seed.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(16777619);
    }
    gpui::rgb(PEER_COLORS[(hash % PEER_COLORS.len() as u32) as usize]).into()
}

/// Up to two letters standing in for a name (`peerInitials`).
pub fn initials(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    match words.as_slice() {
        [] => "?".into(),
        [word] => word.chars().take(2).collect::<String>().to_uppercase(),
        [first, .., last] => format!(
            "{}{}",
            first.chars().next().unwrap_or_default(),
            last.chars().next().unwrap_or_default()
        )
        .to_uppercase(),
    }
}
