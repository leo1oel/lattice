//! Above the Papers list (`paper-list-toolbar.tsx`, `list-tool.tsx`,
//! `.paper-list-toolbar` in `app-shell.css`): how many papers it shows, and
//! the menus that filter, sort and group them, with the active filter as a
//! chip that clears it.
//!
//! The count stands for what is shown, so a search or a filter reads as
//! "3 of 7 papers". Below 300px the tools drop their carets, below 230px
//! they fold to their icons with a weft dot on one that is set, and below
//! 210px the count shortens to "3/7". The menus are Lattice's
//! (`components::Menu`): one fill gliding between rows, the chosen choice
//! checked at the end, each filter with how many papers it keeps.

use gpui::{
    Anchor, App, Context, ElementId, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::Selectable;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{MenuAction, MenuPopover},
    icons::{ICON, ICON_SMALL},
    interaction::{mix, track_pointer, use_interaction},
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{
    PapersPanel,
    model::{Filter, Group, Sort},
    row::tooltip,
};

/// A list's filter or sort: the tool's name quiet, its value in ink, a caret
/// for the menu it opens; folded, its icon alone with a dot once it is set.
#[derive(IntoElement)]
struct ListTool {
    id: ElementId,
    icon: Icon,
    label: SharedString,
    value: Option<SharedString>,
    on: bool,
    caret: bool,
    folded: bool,
    tooltip: &'static str,
    open: bool,
}

impl Selectable for ListTool {
    fn selected(mut self, selected: bool) -> Self {
        self.open = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.open
    }
}

impl RenderOnce for ListTool {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        let lit = if self.open { 1. } else { interaction.hover };
        let bg = mix(
            mix(Hsla::transparent_black(), palette.hover, lit),
            palette.pressed,
            interaction.press,
        );
        let ink = mix(palette.text_secondary, palette.text, lit);
        track_pointer(div().id(self.id), pointer)
            .relative()
            .flex()
            .items_center()
            .gap(px(4.))
            .h(px(28.))
            .min_w(px(28.))
            .map(|tool| {
                if self.folded {
                    tool.w(px(28.)).justify_center()
                } else {
                    tool.pl(px(8.)).pr(px(if self.caret { 6. } else { 8. }))
                }
            })
            .rounded(px(6.))
            .bg(bg)
            .cursor_pointer()
            .tooltip(tooltip(self.tooltip))
            .text_role(TextRole::Caption, cx)
            .text_color(ink)
            .child(div().flex_none().child(self.icon.element(ICON, ink)))
            .when(!self.folded, |tool| {
                tool.child(
                    div()
                        .flex()
                        .min_w_0()
                        .items_baseline()
                        .gap(px(4.))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .child(div().min_w_0().truncate().child(self.label))
                        .when_some(self.value, |text, value| {
                            text.child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .font_weight(FONT_WEIGHT_MEDIUM)
                                    .text_color(palette.text)
                                    .child(value),
                            )
                        }),
                )
            })
            .when(self.caret && !self.folded, |tool| {
                tool.child(div().flex_none().child(Icon::CHEVRON_DOWN.element(
                    ICON_SMALL,
                    mix(palette.text_secondary, palette.text_secondary, lit),
                )))
            })
            // Folded, a tool set away from its default keeps a dot.
            .when(self.folded && self.on, |tool| {
                tool.child(
                    div()
                        .absolute()
                        .top(px(5.))
                        .right(px(5.))
                        .size(px(6.))
                        .rounded_full()
                        .bg(palette.brand_weft)
                        .border_2()
                        .border_color(palette.chrome),
                )
            })
    }
}

impl PapersPanel {
    pub(super) fn render_toolbar(&self, shown: usize, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let width = (self.width - 20.).max(0.);
        let total = self.papers.len();
        let count = if width < 210. {
            if shown != total {
                format!("{shown}/{total}")
            } else {
                total.to_string()
            }
        } else if shown != total {
            if shown == 1 {
                t!("1 of {total} papers", total = total)
            } else {
                t!(
                    "{filtered} of {total} papers",
                    filtered = shown,
                    total = total
                )
            }
        } else if total == 1 {
            t!("1 paper").to_string()
        } else {
            t!("{count} papers", count = total)
        };
        let caret = width >= 300.;
        let folded = width < 230.;
        let filter = self.shown_filter();
        let uses_known = self.uses_known();
        let counts: Vec<(Filter, usize)> = Filter::ALL
            .iter()
            .map(|filter| {
                (
                    *filter,
                    self.papers
                        .iter()
                        .filter(|paper| filter.keeps(paper, &self.facts))
                        .count(),
                )
            })
            .collect();
        let view = cx.entity().downgrade();
        let filter_menu = {
            let view = view.clone();
            move |menu: lattice_ui::components::Menu| {
                counts.iter().fold(menu, |menu, (choice, count)| {
                    let view = view.clone();
                    let choice = *choice;
                    menu.item(
                        MenuAction::new(choice.label(), move |_, cx| {
                            view.update(cx, |this, cx| this.set_filter(choice, cx)).ok();
                        })
                        .checked(choice == filter)
                        .detail(count.to_string())
                        .disabled(!uses_known && choice.needs_uses()),
                    )
                })
            }
        };
        let (sort, group) = (self.sort, self.group);
        let order_menu = {
            let view = view.clone();
            move |menu: lattice_ui::components::Menu| {
                let menu = Group::ALL
                    .iter()
                    .fold(menu.label(t!("Group by")), |menu, choice| {
                        let view = view.clone();
                        let choice = *choice;
                        menu.item(
                            MenuAction::new(choice.label(), move |_, cx| {
                                view.update(cx, |this, cx| this.set_group(choice, cx)).ok();
                            })
                            .checked(choice == group),
                        )
                    });
                Sort::ALL
                    .iter()
                    .fold(menu.separator().label(t!("Sort by")), |menu, choice| {
                        let view = view.clone();
                        let choice = *choice;
                        menu.item(
                            MenuAction::new(choice.label(), move |_, cx| {
                                view.update(cx, |this, cx| this.set_sort(choice, cx)).ok();
                            })
                            .checked(choice == sort)
                            .disabled(!uses_known && choice == Sort::Cited),
                        )
                    })
            }
        };
        let order_value = if group != Group::None {
            group.label()
        } else {
            sort.label()
        };
        div()
            .flex()
            .items_center()
            .gap(px(2.))
            .mt(px(8.))
            .mr(px(10.))
            .min_w_0()
            .child(
                div()
                    .flex_none()
                    .mr_auto()
                    .px(px(8.))
                    .whitespace_nowrap()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(count),
            )
            .child(
                MenuPopover::new(
                    "papers-filter",
                    ListTool {
                        id: "papers-filter-tool".into(),
                        icon: Icon::LIST_FILTER,
                        label: t!("Filter").into(),
                        value: None,
                        on: filter != Filter::All,
                        caret,
                        folded,
                        tooltip: t!("Filter papers"),
                        open: false,
                    },
                    filter_menu,
                )
                .anchor(Anchor::TopRight),
            )
            .child(
                MenuPopover::new(
                    "papers-order",
                    ListTool {
                        id: "papers-order-tool".into(),
                        icon: Icon::ARROW_DOWN_UP,
                        label: if group != Group::None {
                            t!("Group")
                        } else {
                            t!("Sort")
                        }
                        .into(),
                        value: Some(order_value.into()),
                        on: sort != Sort::Title || group != Group::None,
                        caret,
                        folded,
                        tooltip: t!("Sort and group"),
                        open: false,
                    },
                    order_menu,
                )
                .anchor(Anchor::TopRight),
            )
    }

    /// The active filter as a chip under the toolbar; a click clears it.
    pub(super) fn render_chip(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        let filter = self.shown_filter();
        if filter == Filter::All {
            return None;
        }
        let palette = cx.palette().clone();
        let (interaction, pointer) = use_interaction("papers-filter-chip", window, cx);
        let view = cx.entity().downgrade();
        Some(
            div().flex().mt(px(4.)).mr(px(10.)).min_w_0().child(
                track_pointer(div().id("papers-filter-chip"), pointer)
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .h(px(24.))
                    .min_w_0()
                    .pl(px(10.))
                    .pr(px(6.))
                    .rounded_full()
                    .bg(mix(palette.hover, palette.pressed, interaction.hover))
                    .cursor_pointer()
                    .tooltip(tooltip(t!("Clear filter")))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text)
                    .on_click(move |_, _, cx| {
                        view.update(cx, |this, cx| this.set_filter(Filter::All, cx))
                            .ok();
                    })
                    .child(div().min_w_0().truncate().child(filter.label()))
                    .child(div().flex_none().child(Icon::X.element(
                        ICON_SMALL,
                        mix(palette.text_secondary, palette.text, interaction.hover),
                    ))),
            ),
        )
    }
}
