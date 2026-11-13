//! The titlebar's and toolbars' small controls: the search field, keycaps and
//! the segmented control.

use std::rc::Rc;

use gpui::{
    AnyElement, App, BoxShadow, ClickEvent, Edges, ElementId, Hsla, InteractiveElement as _,
    IntoElement, ParentElement as _, Pixels, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, point, prelude::FluentBuilder as _,
    px, transparent_black,
};

use gpui::AnyView;

use crate::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{LatticeTooltip, focus_ring},
    elevation::ring,
    icons::ICON,
    interaction::{mix, tab_stop, track_pointer, use_interaction},
    parity, shape,
    sliding::SlidingPlate,
    tokens::FONT_WEIGHT_MEDIUM,
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// A 1px hairline just inside the edge, as `box-shadow: inset 0 0 0 1px`.
fn inset_ring(color: Hsla) -> BoxShadow {
    BoxShadow {
        inset: true,
        ..ring(color)
    }
}

/// A shortcut's keys, as the command table spells them (`⌘K`).
///
/// Measured in the titlebar's search field: 18px tall on the lift, a 1px
/// hairline edge and a 1px hairline under it, the keys in 12px medium
/// secondary ink.
#[derive(IntoElement)]
pub struct Keycap {
    keys: SharedString,
    parity: Option<(SharedString, usize)>,
}

impl Keycap {
    pub fn new(keys: impl Into<SharedString>) -> Self {
        Self {
            keys: keys.into(),
            parity: None,
        }
    }

    /// Record its keys' text style as slot `slot` of the parity-harness
    /// region `name` (`crate::parity`).
    pub fn parity(mut self, name: impl Into<SharedString>, slot: usize) -> Self {
        self.parity = Some((name.into(), slot));
        self
    }
}

impl RenderOnce for Keycap {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        div()
            .flex_none()
            .h(px(18.))
            .px(px(4.))
            .flex()
            .items_center()
            .rounded(shape::CHROME.paint(shape::RADIUS_CHIP))
            .bg(palette.raised)
            .border_1()
            .border_color(palette.line)
            .shadow(vec![BoxShadow {
                color: palette.line,
                offset: point(px(0.), px(1.)),
                blur_radius: px(0.),
                spread_radius: px(0.),
                inset: false,
            }])
            .text_role(TextRole::Caption, cx)
            .font_weight(FONT_WEIGHT_MEDIUM)
            .text_color(palette.text_secondary)
            .children(
                self.parity
                    .and_then(|(name, slot)| parity::text_probe(name, slot, self.keys.clone())),
            )
            .child(self.keys)
    }
}

/// A search field, or the button that stands for one (the titlebar's
/// "Search ⌘K", which opens the palette).
///
/// Two looks, both measured on the Main window: `filled` is the titlebar's
/// (the hover wash with an inset hairline, control corners), the default is a
/// field on a sheet (the field border on the input surface, 11px corners in a
/// panel's toolbar).
#[derive(IntoElement)]
pub struct SearchField {
    id: ElementId,
    placeholder: SharedString,
    keycap: Option<SharedString>,
    filled: bool,
    radius: Pixels,
    width: Option<Pixels>,
    tooltip: Option<SharedString>,
    on_click: Option<ClickHandler>,
    trailing: Option<AnyElement>,
    parity: Option<SharedString>,
}

impl SearchField {
    pub fn new(id: impl Into<ElementId>, placeholder: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            placeholder: placeholder.into(),
            keycap: None,
            filled: false,
            radius: shape::CHROME.paint(shape::RADIUS_TARGET),
            width: None,
            tooltip: None,
            on_click: None,
            trailing: None,
            parity: None,
        }
    }

    /// Name this control as a parity-harness region (`crate::parity`): its
    /// bounds and its placeholder's and keycap's text styles are recorded
    /// under `name`.
    pub fn parity(mut self, name: impl Into<SharedString>) -> Self {
        self.parity = Some(name.into());
        self
    }

    pub fn width(mut self, width: Pixels) -> Self {
        self.width = Some(width);
        self
    }

    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    pub fn filled(mut self) -> Self {
        self.filled = true;
        self.radius = px(6.);
        self
    }

    pub fn keycap(mut self, keys: impl Into<SharedString>) -> Self {
        self.keycap = Some(keys.into());
        self
    }

    pub fn trailing(mut self, element: impl IntoElement) -> Self {
        self.trailing = Some(element.into_any_element());
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

impl RenderOnce for SearchField {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let hover_border = palette.field_border_hover;
        let focus = focus_ring(
            &palette,
            if self.filled {
                palette.titlebar
            } else {
                palette.panel
            },
        );
        let field = div().id(self.id);
        // The button that stands for a search field is a tab stop.
        let field = if self.on_click.is_some() {
            tab_stop(field)
        } else {
            field
        };
        field
            .flex()
            .items_center()
            .gap(px(6.))
            .h(px(28.))
            .rounded(self.radius)
            .map(|this| {
                if self.filled {
                    this.pl(px(8.))
                        .pr(px(4.))
                        .bg(palette.hover)
                        .shadow(vec![inset_ring(palette.line)])
                } else {
                    this.pl(px(10.))
                        .pr(px(4.))
                        .bg(palette.editor)
                        .border_1()
                        .border_color(palette.field_border)
                        .hover(move |style| style.border_color(hover_border))
                }
            })
            .child(Icon::SEARCH.element(ICON, palette.text_secondary))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .children(
                        self.parity
                            .clone()
                            .and_then(|name| parity::text_probe(name, 0, self.placeholder.clone())),
                    )
                    .child(self.placeholder),
            )
            .children(self.parity.clone().and_then(|name| {
                let border = if self.filled { px(0.) } else { px(1.) };
                parity::bordered_probe(name, Edges::all(border))
            }))
            .children(self.trailing)
            .children(self.keycap.map(|keys| {
                let keycap = Keycap::new(keys);
                match self.parity {
                    Some(name) => keycap.parity(name, 1),
                    None => keycap,
                }
            }))
            .when_some(self.width, |this, width| this.w(width).flex_none())
            .when_some(self.tooltip, |this, tooltip| {
                this.tooltip(move |_, cx| -> AnyView {
                    LatticeTooltip::view(tooltip.clone(), None, cx)
                })
            })
            .when_some(self.on_click, |this, on_click| {
                this.cursor_pointer()
                    .focus_visible(move |style| style.shadow(focus))
                    .on_click(move |event, window, cx| on_click(event, window, cx))
            })
    }
}

/// A segmented control: two to four mutually exclusive views, in a track.
///
/// Measured on the titlebar's workspace switcher: a 28px track with an inset
/// hairline, 2px of padding; the selected segment a 24px chip of the panel
/// surface, raised; labels 12/14 in the primary ink, icon-only segments 28px
/// wide. The corners nest (`shape::SEGMENTED`: the control's 6px, 2px in, so
/// the chip's 4px), drawn smoothed as Paper measures them (11px and 7.4px).
/// The chip slides to the newly selected segment on the moderate tier, as the
/// app's `SegmentedControl` (`SlidingTabs`) moves its pill.
#[derive(IntoElement)]
pub struct Segmented {
    id: ElementId,
    segments: Vec<Segment>,
    parity: Option<SharedString>,
    filled: bool,
}

pub struct Segment {
    label: Option<SharedString>,
    icon: Option<Icon>,
    selected: bool,
    on_click: Option<ClickHandler>,
}

impl Segmented {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            segments: Vec::new(),
            parity: None,
            filled: false,
        }
    }

    /// The app's plain `.ui-segmented` (chrome.css), as Settings draws it:
    /// a track of the hairline's grey, 28px with 2px of padding on the 6px
    /// corner; segments on the nested 4px corner (6 less the inset), 10px
    /// in, micro type at medium weight in the tertiary ink; the selected one
    /// on the editor's surface with the raised shadow, in the primary ink.
    /// Without it the control wears the titlebar's workspace switcher skin.
    pub fn filled(mut self) -> Self {
        self.filled = true;
        self
    }

    /// Name this control as a parity-harness region (`crate::parity`): its
    /// bounds and each labelled segment's text style are recorded under
    /// `name`, in the slot of the segment's place.
    pub fn parity(mut self, name: impl Into<SharedString>) -> Self {
        self.parity = Some(name.into());
        self
    }

    pub fn label(
        mut self,
        label: impl Into<SharedString>,
        selected: bool,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.segments.push(Segment {
            label: Some(label.into()),
            icon: None,
            selected,
            on_click: Some(Rc::new(on_click)),
        });
        self
    }

    pub fn icon(
        mut self,
        icon: Icon,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.segments.push(Segment {
            label: None,
            icon: Some(icon),
            selected: false,
            on_click: Some(Rc::new(on_click)),
        });
        self
    }
}

impl RenderOnce for Segmented {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let filled = self.filled;
        let raised = if filled {
            Elevation::Raised.shadows(&palette)
        } else {
            let mut raised = vec![ring(palette.line_strong)];
            raised.extend(Elevation::Raised.shadows(&palette).into_iter().skip(1));
            raised
        };
        let focus = focus_ring(&palette, palette.titlebar);
        // Filled, the corners are Settings' plain 6px and 4px; otherwise the
        // titlebar's, smoothed.
        let (track_radius, chip_radius) = if filled {
            (shape::SEGMENTED.radius, shape::SEGMENTED.inner())
        } else {
            shape::SEGMENTED.painted(shape::CHROME)
        };
        let selected_surface = if filled {
            palette.editor
        } else {
            palette.panel
        };
        let selected = self.segments.iter().position(|segment| segment.selected);
        let plate = SlidingPlate::new(
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "plate".into()),
            selected,
            window,
            cx,
        );
        let plate_drawn = plate.is_drawn(cx);
        // An unselected segment's wash fades on the fast tier
        // (`trellis.css`, `.ui-segmented-tab:not(.active):hover`).
        let washes: Vec<_> = (0..self.segments.len())
            .map(|ix| {
                let id = ElementId::NamedChild(
                    std::sync::Arc::new(self.id.clone()),
                    SharedString::from(format!("segment-{ix}")),
                );
                use_interaction(id, window, cx)
            })
            .collect();
        let chip = plate.plate(
            |chip| {
                chip.rounded(chip_radius)
                    .bg(selected_surface)
                    .shadow(raised.clone())
            },
            cx,
        );
        let track = div()
            .id(self.id)
            .relative()
            .flex()
            .flex_none()
            .h(px(28.))
            .p(shape::SEGMENTED.inset)
            .rounded(track_radius)
            .map(|this| {
                if filled {
                    this.bg(palette.line)
                } else {
                    this.shadow(vec![inset_ring(palette.line)])
                }
            })
            .children(self.parity.clone().and_then(parity::probe))
            .children(chip)
            .children(
                self.segments
                    .into_iter()
                    .enumerate()
                    .map(|(ix, segment)| {
                        let hover = palette.hover;
                        let focus = focus.clone();
                        let segment_box = div().id(ix);
                        let text_probe = self
                            .parity
                            .clone()
                            .zip(segment.label.clone())
                            .and_then(|(name, label)| parity::text_probe(name, ix, label));
                        // Each segment is a tab stop, as each is a button in the app.
                        let (interaction, pointer) = washes[ix].clone();
                        let segment_box = if segment.on_click.is_some() {
                            track_pointer(tab_stop(segment_box), pointer)
                        } else {
                            segment_box
                        };
                        segment_box
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .h(px(24.))
                            .rounded(chip_radius)
                            // Until the sliding chip has been measured, the
                            // selected segment draws its own.
                            .when(segment.selected && !plate_drawn, |this| {
                                this.bg(selected_surface).shadow(raised.clone())
                            })
                            .when(!segment.selected && !filled, |this| {
                                this.bg(mix(transparent_black(), hover, interaction.hover))
                            })
                            .when_some(segment.label, |this, label| {
                                let this = this.px(px(10.));
                                let this = if filled {
                                    this.text_role(TextRole::Micro, cx).text_color(
                                        if segment.selected {
                                            palette.text
                                        } else {
                                            palette.text_secondary
                                        },
                                    )
                                } else {
                                    this.text_role(TextRole::Caption, cx)
                                        .line_height(px(14.))
                                        .text_color(palette.text)
                                };
                                this.child(label).children(text_probe)
                            })
                            .when_some(segment.icon, |this, icon| {
                                this.w(px(28.))
                                    .child(icon.element(ICON, palette.text_secondary))
                            })
                            .when_some(segment.on_click, |this, on_click| {
                                this.cursor_pointer()
                                    .focus_visible(move |style| style.shadow(focus))
                                    .on_click(move |event, window, cx| on_click(event, window, cx))
                            })
                    })
                    .enumerate()
                    .map(|(ix, segment)| plate.item(ix, segment))
                    .collect::<Vec<_>>(),
            );
        plate.strip(track)
    }
}
