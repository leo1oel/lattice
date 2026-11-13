//! A panel strip's view switch: a document's modes (a .tex file's Source and
//! Visual) as the Trellis header draws them (`.trellis-view-switcher` in
//! `src/trellis/trellis.css` over `.ui-segmented` in `chrome.css`).
//!
//! A 28px track with no ground and 2px of inset; each mode a 24px button of
//! its 14px icon and, in room to spare, its name (12px medium) 6px after it,
//! padded 8px before and 10px after (6px each side with the icon alone). The
//! chosen mode stands on a raised plate of the panel's own surface, ringed in
//! the strong hairline, its corner nested in the track's (`shape::SEGMENTED`,
//! drawn as the chrome draws it), in the primary ink; the plate slides to a
//! newly chosen mode on the moderate tier (`SlidingPlate`). The others are
//! secondary ink, and take a plate of the ink at 6% and the primary ink under
//! the pointer, 14% while pressed, both on the fast tier. The chosen mode
//! does not react: choosing it changes nothing.
//!
//! A mode can be unavailable (the GPUI preview's Visual editor): it keeps its
//! place and look, answers the pointer with its tooltip only, and is never
//! chosen.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::LatticeTooltip,
    elevation::{Elevation, ring},
    icons::ICON,
    interaction::{mix, track_pointer, use_interaction},
    parity, shape,
    sliding::SlidingPlate,
    tokens::FONT_WEIGHT_MEDIUM,
    typography::shaped_width,
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// The track's height and a mode's height; the inset is the nest's.
const TRACK: Pixels = px(28.);
const INSET: Pixels = shape::SEGMENTED.inset;
const MODE: Pixels = px(24.);
/// A named mode's padding before its icon and after its name, and the gap
/// between them; an icon-only mode's padding.
const NAMED_START: Pixels = px(8.);
const NAMED_END: Pixels = px(10.);
const NAMED_GAP: Pixels = px(6.);
const ICON_ONLY_PAD: Pixels = px(6.);

struct Mode {
    icon: Icon,
    name: SharedString,
    chosen: bool,
    /// Why the mode cannot be chosen here, shown as its tooltip.
    unavailable: Option<SharedString>,
    on_choose: Option<ClickHandler>,
}

#[derive(IntoElement)]
pub struct ViewSwitch {
    id: ElementId,
    modes: Vec<Mode>,
    named: bool,
    /// The panel surface the chosen plate is cut from.
    surface: Option<gpui::Hsla>,
    parity: Option<SharedString>,
}

impl ViewSwitch {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            modes: Vec::new(),
            named: true,
            surface: None,
            parity: None,
        }
    }

    /// A mode the writer can choose.
    pub fn mode(
        mut self,
        icon: Icon,
        name: impl Into<SharedString>,
        chosen: bool,
        on_choose: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.modes.push(Mode {
            icon,
            name: name.into(),
            chosen,
            unavailable: None,
            on_choose: Some(Rc::new(on_choose)),
        });
        self
    }

    /// A mode shown in its place that cannot be chosen, saying why.
    pub fn unavailable_mode(
        mut self,
        icon: Icon,
        name: impl Into<SharedString>,
        why: impl Into<SharedString>,
    ) -> Self {
        self.modes.push(Mode {
            icon,
            name: name.into(),
            chosen: false,
            unavailable: Some(why.into()),
            on_choose: None,
        });
        self
    }

    /// Whether the names show beside the icons (only in room to spare).
    pub fn named(mut self, named: bool) -> Self {
        self.named = named;
        self
    }

    /// The panel's surface, which the chosen mode's plate is.
    pub fn surface(mut self, surface: gpui::Hsla) -> Self {
        self.surface = Some(surface);
        self
    }

    /// Name this control as a parity-harness region (`crate::parity`).
    pub fn parity(mut self, name: impl Into<SharedString>) -> Self {
        self.parity = Some(name.into());
        self
    }

    /// The switch's width with `names` (each mode's name) shown or not.
    pub fn width(names: &[&str], named: bool, window: &Window, cx: &App) -> Pixels {
        let modes = names.iter().fold(px(0.), |sum, name| {
            sum + if named {
                NAMED_START
                    + ICON
                    + NAMED_GAP
                    + shaped_width(
                        name,
                        TextRole::Caption,
                        Some(FONT_WEIGHT_MEDIUM),
                        window,
                        cx,
                    )
                    + NAMED_END
            } else {
                ICON_ONLY_PAD * 2. + ICON
            }
        });
        modes + INSET * 2.
    }
}

impl RenderOnce for ViewSwitch {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let surface = self.surface.unwrap_or(palette.editor);
        let mut raised = vec![ring(palette.line_strong)];
        raised.extend(Elevation::Raised.shadows(&palette).into_iter().skip(1));
        // `--chrome-hover-surface`, and the press's 14%.
        let hover = palette.text.opacity(0.06 * palette.text.a);
        let pressed = palette.text.opacity(0.14 * palette.text.a);
        let clear = hover.opacity(0.);
        let named = self.named;
        let parity_name = self.parity.clone();
        let (_, plate_radius) = shape::SEGMENTED.painted(shape::CHROME);
        let chosen = self.modes.iter().position(|mode| mode.chosen);
        let plate = SlidingPlate::new(
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "plate".into()),
            chosen,
            window,
            cx,
        );
        let plate_drawn = plate.is_drawn(cx);
        let modes: Vec<AnyElement> = self
            .modes
            .into_iter()
            .enumerate()
            .map(|(ix, mode)| {
                let id = ElementId::NamedChild(
                    std::sync::Arc::new(self.id.clone()),
                    format!("mode-{ix}").into(),
                );
                let (interaction, pointer) = use_interaction(id.clone(), window, cx);
                let reacts = !mode.chosen && mode.unavailable.is_none();
                let (ground, ink) = if mode.chosen {
                    // Until the plate has been measured, the chosen mode
                    // draws its own.
                    (if plate_drawn { clear } else { surface }, palette.text)
                } else if reacts {
                    (
                        interaction.wash(clear, hover, pressed),
                        mix(palette.text_secondary, palette.text, interaction.hover),
                    )
                } else {
                    (clear, palette.text_secondary)
                };
                let text_probe = parity_name
                    .clone()
                    .filter(|_| named)
                    .and_then(|name| parity::text_probe(name, ix, mode.name.clone()));
                let tooltip = mode.unavailable.clone().unwrap_or(mode.name.clone());
                let button = track_pointer(
                    div()
                        .id(id)
                        .flex()
                        .flex_none()
                        .items_center()
                        .h(MODE)
                        .rounded(plate_radius)
                        .bg(ground)
                        .when(mode.chosen && !plate_drawn, |this| {
                            this.shadow(raised.clone())
                        })
                        .when(named, |this| {
                            this.pl(NAMED_START).pr(NAMED_END).gap(NAMED_GAP)
                        })
                        .when(!named, |this| this.px(ICON_ONLY_PAD))
                        .child(mode.icon.element(ICON, ink))
                        .when(named, |this| {
                            this.child(
                                div()
                                    .whitespace_nowrap()
                                    .text_role(TextRole::Caption, cx)
                                    // `.ui-segmented-tab`: the micro line
                                    // height under the caption size.
                                    .line_height(px(14.))
                                    .font_weight(FONT_WEIGHT_MEDIUM)
                                    .text_color(ink)
                                    .children(text_probe)
                                    .child(mode.name.clone()),
                            )
                        })
                        .tooltip(move |_, cx| LatticeTooltip::view(tooltip.clone(), None, cx))
                        .when(reacts, |this| this.cursor_pointer()),
                    pointer,
                );
                let button = match mode.on_choose.filter(|_| reacts) {
                    Some(on_choose) => button
                        .on_click(move |event, window, cx| on_choose(event, window, cx))
                        .into_any_element(),
                    None => button.into_any_element(),
                };
                plate.item(ix, button)
            })
            .collect();
        let chip = plate.plate(
            |chip| {
                chip.rounded(plate_radius)
                    .bg(surface)
                    .shadow(raised.clone())
            },
            cx,
        );
        plate.strip(
            div()
                .relative()
                .flex()
                .flex_none()
                .items_center()
                .h(TRACK)
                .p(INSET)
                .children(parity_name.and_then(parity::probe))
                .children(chip)
                .children(modes),
        )
    }
}
