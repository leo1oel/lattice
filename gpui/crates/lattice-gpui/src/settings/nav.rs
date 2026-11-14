//! Settings' left column (`settings-dialog.tsx`'s `<nav>`, dialogs.css
//! `.settings-nav*`): the search, then the sections grouped under micro
//! labels, or, while the search holds a query, its results.
//!
//! The pointer's fill is the shared fluid hover ([`FluidHover`]): one wash
//! that glides between the sections on the fast tier's spring, fades when it
//! crosses a group label, and leaves the chosen section, which wears the
//! accent wash and the accent ink at semibold, alone. The search results run
//! the same hover, shared by the pointer and the arrows. In the narrow form
//! the sections are cards with chevrons under a "Settings" title.

use gpui::{
    AnyElement, ClickEvent, Context, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    div, prelude::FluentBuilder as _, px, svg,
};
use lattice_i18n::t;
use lattice_settings::{Choice as _, SettingsTab};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::Field,
    fluid_hover::{FluidHover, ItemKind},
    interaction::{mix, track_pointer, use_interaction},
    tokens::{FONT_WEIGHT_REGULAR, FONT_WEIGHT_SEMIBOLD},
};

use super::dialog::{NAV_WIDTH, SettingsDialog};

const NAV_PAD_BLOCK: Pixels = px(16.);
const NAV_PAD_INLINE: Pixels = px(9.);
const NAV_GROUP_GAP: Pixels = px(14.);
const NAV_ITEM: Pixels = px(32.);
const NAV_LABEL: Pixels = px(20.);
const NAV_LABEL_GAP: Pixels = px(4.);
const NAV_RADIUS: Pixels = px(6.);

/// A section in the left column.
#[derive(Clone, Copy)]
struct Section {
    tab: SettingsTab,
    icon: Icon,
}

fn groups() -> Vec<(SharedString, Vec<(Section, SharedString)>)> {
    vec![
        (
            t!("General").into(),
            vec![
                (
                    Section {
                        tab: SettingsTab::Appearance,
                        icon: Icon::FADERS,
                    },
                    t!("Appearance").into(),
                ),
                (
                    Section {
                        tab: SettingsTab::Editor,
                        icon: Icon::CLIPBOARD_TEXT,
                    },
                    t!("Editor & builds").into(),
                ),
            ],
        ),
        (
            t!("Integrations").into(),
            vec![(
                Section {
                    tab: SettingsTab::Overleaf,
                    icon: Icon::CLOUD_UPLOAD,
                },
                "Overleaf".into(),
            )],
        ),
        (
            t!("Diagnostics").into(),
            vec![(
                Section {
                    tab: SettingsTab::Doctor,
                    icon: Icon::SPARKLE,
                },
                t!("TeX doctor").into(),
            )],
        ),
    ]
}

impl SettingsDialog {
    /// The left column: the search, then the sections or the results.
    pub(super) fn nav(
        &mut self,
        narrow: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let query = self.fields.search.read(cx).value().to_string();
        self.query = query.clone();
        let searching = !query.trim().is_empty();
        let mut column = div()
            .id("settings-nav")
            .relative()
            .children(lattice_ui::parity::bordered_probe(
                "settings/nav",
                gpui::Edges {
                    right: if narrow { px(0.) } else { px(1.) },
                    ..Default::default()
                },
            ))
            .flex()
            .flex_col()
            .flex_none()
            .h_full()
            .overflow_y_scroll()
            .map(|this| {
                if narrow {
                    this.w_full()
                        .pt(px(10.))
                        .px(px(12.))
                        .pb(px(16.))
                        .bg(palette.panel)
                } else {
                    this.w(NAV_WIDTH)
                        .py(NAV_PAD_BLOCK)
                        .px(NAV_PAD_INLINE)
                        .bg(palette.chrome)
                        .border_r_1()
                        .border_color(palette.line)
                }
            });
        if narrow {
            column = column.child(
                div()
                    .mr(px(36.))
                    .ml(px(4.))
                    .mb(px(10.))
                    .text_role_in(TextRole::Title, TypeScale::Settings, cx)
                    .line_height(px(28.))
                    .text_color(palette.text)
                    .child(t!("Settings")),
            );
        }
        column = column.child(
            div()
                .relative()
                .mb(if narrow { px(16.) } else { NAV_GROUP_GAP })
                .children(lattice_ui::parity::probe("settings/search"))
                .child(Field::new(&self.fields.search).search().compact()),
        );
        if searching {
            return column
                .child(self.results_list(window, cx))
                .into_any_element();
        }

        // The gliding fill: one wash that moves to the section under the
        // pointer. The narrow form's sections are bordered cards, each with
        // its own wash, as the app's narrow settings list has them.
        let hover = (!narrow).then(|| {
            FluidHover::new("settings-nav-hover", window, cx)
                .fill(palette.hover)
                .radius(NAV_RADIUS)
        });
        let groups = groups();
        let mut index = 0;
        let mut items: Vec<AnyElement> = Vec::new();
        for (gix, (label, sections)) in groups.iter().enumerate() {
            let mut group = div().flex().flex_col();
            group = group.when(gix > 0, |this| {
                this.mt(if narrow { px(16.) } else { NAV_GROUP_GAP })
            });
            let probe_label = gix == 0;
            group = group.child(
                div()
                    .relative()
                    .when(probe_label, |this| {
                        this.children(lattice_ui::parity::probe("settings/nav/label"))
                            .children(lattice_ui::parity::text_probe(
                                "settings/nav/label",
                                0,
                                label.clone(),
                            ))
                    })
                    .when(!narrow, |this| this.px(px(10.)).mb(NAV_LABEL_GAP))
                    .when(narrow, |this| this.px(px(4.)).mb(px(6.)))
                    .text_role_in(TextRole::Micro, TypeScale::Settings, cx)
                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                    .line_height(NAV_LABEL)
                    .text_color(palette.text_secondary)
                    .child(label.clone()),
            );
            let count = sections.len();
            for (six, (section, name)) in sections.iter().enumerate() {
                let item = self.nav_item(
                    *section,
                    name.clone(),
                    narrow,
                    (six == 0, six + 1 == count),
                    hover.as_ref().is_some_and(|hover| hover.is_lit(index, cx)),
                    window,
                    cx,
                );
                group = group.child(match &hover {
                    // The chosen section keeps its accent wash, so the fill
                    // clears over it; a group label starts a new section.
                    Some(hover) => {
                        let kind = if section.tab == self.tab {
                            ItemKind::skip()
                        } else {
                            ItemKind::target()
                        };
                        hover.item_as(index, kind.section(gix), item)
                    }
                    None => item,
                });
                index += 1;
            }
            items.push(group.into_any_element());
        }
        column
            .children(hover.map(|hover| hover.highlight()))
            .children(items)
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn nav_item(
        &mut self,
        section: Section,
        name: SharedString,
        narrow: bool,
        (first, last): (bool, bool),
        lit: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let id = ElementId::Name(format!("settings-section-{}", section.tab.tag()).into());
        let (interaction, pointer) = use_interaction(id.clone(), window, cx);
        let active = section.tab == self.tab && !(narrow && !self.narrow_page);
        let tab = section.tab;
        let item = div()
            .id(id)
            .relative()
            .when(active, |this| {
                this.children(lattice_ui::parity::probe("settings/nav/active"))
                    .children(lattice_ui::parity::text_probe(
                        "settings/nav/active",
                        0,
                        name.clone(),
                    ))
            })
            .flex()
            .items_center()
            .gap(px(8.))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.open_tab(tab, cx)));
        let item = if narrow {
            let radius = px(10.);
            item.min_h(px(44.))
                .pl(px(12.))
                .pr(px(10.))
                .border_1()
                .when(!first, |this| this.border_t_0())
                .border_color(palette.line)
                .bg(mix(palette.raised, palette.hover, interaction.hover))
                .when(first, |this| this.rounded_t(radius))
                .when(last, |this| this.rounded_b(radius))
                .text_role_in(TextRole::Body, TypeScale::Settings, cx)
                .font_weight(FONT_WEIGHT_REGULAR)
                .text_color(palette.text)
        } else {
            item.h(NAV_ITEM)
                .px(px(10.))
                .rounded(NAV_RADIUS)
                .when(active, |this| this.bg(palette.accent_soft))
                .text_role_in(TextRole::BodyCompact, TypeScale::Settings, cx)
                .font_weight(if active {
                    FONT_WEIGHT_SEMIBOLD
                } else {
                    FONT_WEIGHT_REGULAR
                })
                .text_color(if active {
                    palette.accent
                } else if lit {
                    palette.text
                } else {
                    palette.text_secondary
                })
        };
        let ink = if active && !narrow {
            palette.accent
        } else if narrow || lit {
            palette.text
        } else {
            palette.text_secondary
        };
        let item = item
            .child(
                svg()
                    .path(section.icon.path())
                    .size(px(15.))
                    .flex_none()
                    .when(section.tab == SettingsTab::Doctor, |this| this.mt(px(-1.)))
                    .text_color(ink),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(name),
            )
            .when(narrow, |this| {
                this.child(
                    svg()
                        .path(Icon::CHEVRON_RIGHT.path())
                        .size(px(14.))
                        .flex_none()
                        .text_color(palette.text_secondary),
                )
            });
        track_pointer(item, pointer).into_any_element()
    }

    fn results_list(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let results = self.results(cx);
        if results.is_empty() {
            return div()
                .px(px(10.))
                .py(px(6.))
                .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                .text_color(palette.text_secondary)
                .child(t!("No matching settings"))
                .into_any_element();
        }
        let current = self
            .reveal
            .as_ref()
            .filter(|(entry, _)| entry.tab == self.tab)
            .map(|(entry, _)| entry.key());
        // One fill for the pointer and the arrows: the row the pointer
        // lights becomes the one Enter opens, as the palette's does.
        let count = results.len();
        let hover = FluidHover::new("settings-results-hover", window, cx)
            .fill(palette.line)
            .radius(NAV_RADIUS);
        let lit = hover.lit(cx);
        if lit != self.results_adopted
            && let Some(lit) = lit.filter(|lit| *lit < count)
        {
            self.result = lit;
        }
        let active = self.result.min(count - 1);
        let hover = hover.follow(Some(active), cx);
        self.results_adopted = hover.lit(cx);
        div()
            .relative()
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(hover.highlight())
            .children(results.into_iter().enumerate().map(|(ix, entry)| {
                let id = ElementId::Name(format!("settings-result-{}", entry.key()).into());
                let is_current = current.as_deref() == Some(entry.key().as_str());
                // The current row's own wash while the glide is elsewhere.
                let wash = if ix == active && !hover.is_lit(ix, cx) {
                    palette.line
                } else {
                    gpui::transparent_black()
                };
                let label = entry.label.clone();
                let place = entry.place.clone();
                let open = entry.clone();
                let row = div()
                    .id(id)
                    .flex()
                    .flex_col()
                    .min_h(px(32.))
                    .px(px(10.))
                    .py(px(6.))
                    .rounded(NAV_RADIUS)
                    .cursor_pointer()
                    .bg(wash)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.open_entry(open.clone(), cx)
                    }))
                    .child(
                        div()
                            .text_role_in(TextRole::BodyCompact, TypeScale::Settings, cx)
                            .line_height(TextRole::Caption.leading(TypeScale::Settings))
                            .font_weight(if is_current {
                                FONT_WEIGHT_SEMIBOLD
                            } else {
                                FontWeight::NORMAL
                            })
                            .text_color(if is_current {
                                palette.accent
                            } else {
                                palette.text
                            })
                            .child(label),
                    )
                    .child(
                        div()
                            .text_role_in(TextRole::Micro, TypeScale::Settings, cx)
                            .font_weight(FontWeight::NORMAL)
                            .text_color(palette.text_secondary)
                            .child(place),
                    );
                hover.item(ix, row)
            }))
            .into_any_element()
    }
}
