//! The outline the rail opens (`OutlinePanel` in `latex-outline-rail.tsx`,
//! `.latex-outline-rail-panel` in `editor-workspace.css`): a menu surface
//! 280px wide over the marks' top right corner, "Outline" and the document's
//! name in its header, then one row per heading.
//!
//! - It grows from its top right corner from 95% and travels in the last 6px
//!   from the right, on the pop tier (`popup-motion`, `--popup-motion-from:
//!   translateX(6px)`), and leaves on the pop tier's exit, fading and
//!   shrinking back as it goes (`Presence`).
//! - A row: the number in a 2.5ch column (its own width below the top
//!   level), the title, ellipsized, and the PDF page it landed on in the
//!   caption size; subsections are indented 16 and 32px, in the caption size
//!   and the secondary ink. The rows keep the menu's nested corner
//!   (`shape::MENU`).
//! - The section being read is in the accent on its wash, in medium weight;
//!   the pointer lights the others with the list's one gliding fill in the
//!   same wash (`FluidHover`), which leaves the current row to its own
//!   (`preserveSelection`). The accent treatment is the captain's call for
//!   the rail, matching the PDF toolbar's Outline.
//! - The list scrolls under Lattice's scrollbar, opening on the current row.

use gpui::{
    AnimationExt as _, AnyElement, Context, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    point, prelude::FluentBuilder as _, px, scaled,
};
use lattice_ui::{
    ActiveLattice as _, Motion, TextRole, TextRoleStyle as _,
    components::{LatticeTooltip, MenuSurface},
    fluid_hover::{FluidHover, ItemKind},
    motion::Entrance,
    reveal::Presence,
    scrollbar::FluidScrollbar,
    shape,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_REGULAR},
    typography::{shaped_width, tabular_nums},
};

use super::outline_rail::OutlineRail;

/// The outline's width and its rows' least height.
const PANEL_WIDTH: gpui::Pixels = px(280.);
const ROW_MIN: gpui::Pixels = px(28.);

impl OutlineRail {
    /// The opened outline, while it is open and while it leaves.
    pub(super) fn render_panel(
        &mut self,
        current: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let presence = Presence::new(
            ElementId::NamedInteger("outline-rail-presence".into(), cx.entity_id().as_u64()),
            self.open,
            Motion::Pop,
            window,
            cx,
        )?;
        let leaving = !self.open;
        let palette = cx.palette().clone();
        let header = div()
            .flex()
            .flex_none()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .pt(px(6.))
            .pb(px(4.))
            .px(px(8.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(div().flex_none().child("Outline"))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(self.outline().name.clone()),
            );
        let hover = FluidHover::new(
            ElementId::NamedInteger("outline-rail-hover".into(), cx.entity_id().as_u64()),
            window,
            cx,
        )
        .fill(palette.accent_soft)
        .radius(shape::MENU.inner());
        // The number column: 2.5ch of the body face.
        let number_column = shaped_width("0", TextRole::Body, None, window, cx) * 2.5;
        let center = std::mem::take(&mut self.center_current);
        let rows: Vec<AnyElement> = self
            .outline()
            .entries
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let selected = current == Some(index);
                let deep = entry.depth > 0;
                let title: SharedString = entry.heading.title.clone().into();
                let tooltip: SharedString = if entry.heading.path == self.path() {
                    title.clone()
                } else {
                    format!("{} ({})", entry.heading.title, entry.heading.path).into()
                };
                let ink = if selected {
                    palette.accent
                } else if deep {
                    palette.text_secondary
                } else {
                    palette.text
                };
                let row = div()
                    .id(("outline-rail-row", index))
                    .relative()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .w_full()
                    .min_h(ROW_MIN)
                    .py(px(4.))
                    .pl(px(8. + 16. * entry.depth as f32))
                    .pr(px(8.))
                    .rounded(shape::MENU.inner())
                    .cursor_pointer()
                    .text_color(ink)
                    .font_weight(if selected {
                        FONT_WEIGHT_MEDIUM
                    } else {
                        FONT_WEIGHT_REGULAR
                    })
                    .when(selected, |row| row.bg(palette.accent_soft))
                    .when(deep, |row| row.text_role(TextRole::Caption, cx))
                    .child(
                        div()
                            .flex_none()
                            .when(!deep, |number| number.w(number_column))
                            .whitespace_nowrap()
                            .font_features(tabular_nums())
                            .text_color(if selected {
                                palette.accent
                            } else {
                                palette.text_secondary
                            })
                            .children(entry.number.clone()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(title),
                    )
                    .children(self.page_of(index).map(|page| {
                        div()
                            .flex_none()
                            .whitespace_nowrap()
                            .text_role(TextRole::Caption, cx)
                            .font_features(tabular_nums())
                            .text_color(palette.text_secondary)
                            .child(format!("p.{page}"))
                    }))
                    .when(selected && center, |row| {
                        let list = self.list.clone();
                        row.child(
                            gpui::canvas(
                                move |bounds, window, _| center_row(&list, bounds, window),
                                |_, _, _, _| {},
                            )
                            .absolute()
                            .top_0()
                            .left_0()
                            .size_full(),
                        )
                    })
                    .tooltip(move |_, cx| LatticeTooltip::view(tooltip.clone(), None, cx))
                    .when(!leaving, |row| {
                        row.on_click(cx.listener(move |this, _, _, cx| this.choose(index, cx)))
                    });
                let kind = if selected {
                    ItemKind::skip()
                } else {
                    ItemKind::target()
                };
                hover.item_as(index, kind, row)
            })
            .collect();
        let list = div()
            .relative()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .id("outline-rail-list")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.list)
                    .child(
                        div()
                            .relative()
                            .flex()
                            .flex_col()
                            .child(hover.highlight())
                            .children(rows),
                    ),
            )
            .child(FluidScrollbar::vertical(
                "outline-rail-scrollbar",
                &self.list,
            ));
        let panel = div()
            .id("outline-rail-panel")
            .occlude()
            .flex()
            .flex_col()
            .max_h_full()
            .when(!leaving, |panel| {
                panel.on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                    this.set_over(None, Some(*hovered), cx)
                }))
            })
            .child(
                MenuSurface::new()
                    .w(PANEL_WIDTH)
                    .max_w_full()
                    .max_h_full()
                    .min_h_0()
                    .child(header)
                    .child(list),
            );
        // From its top right corner, 6px in from the right, on the pop tier;
        // out on its exit, shrinking back as it fades.
        let entrance = Entrance::POPUP;
        let body: AnyElement = if leaving {
            let movement = presence.opacity;
            scaled(div().relative().child(panel))
                .origin(point(1., 0.))
                .scale(entrance.scale(movement))
                .map_child(|child| child.opacity(movement))
                .into_any_element()
        } else {
            scaled(div().relative().child(panel))
                .origin(point(1., 0.))
                .with_animation(
                    ElementId::NamedInteger("outline-rail-enter".into(), self.opened as u64),
                    entrance.animation(),
                    move |this, t| {
                        let (movement, fade) = entrance.sample_at(t);
                        this.scale(entrance.scale(movement)).map_child(|child| {
                            child
                                .left(px((1. - movement) * entrance.travel))
                                .opacity(fade)
                        })
                    },
                )
                .into_any_element()
        };
        Some(
            div()
                .absolute()
                .top_0()
                .right_0()
                .w(PANEL_WIDTH)
                .max_w_full()
                .max_h_full()
                .flex()
                .flex_col()
                .child(body)
                .into_any_element(),
        )
    }
}

/// Scroll `list` so the row drawn at `row` sits in its middle, as the Tauri
/// outline opens (`scrollTop = offsetTop - (clientHeight - offsetHeight) / 2`).
fn center_row(list: &gpui::ScrollHandle, row: gpui::Bounds<gpui::Pixels>, window: &mut Window) {
    let viewport = list.bounds();
    let offset = list.offset();
    let top = row.top() - viewport.top() - offset.y;
    let target = (top - (viewport.size.height - row.size.height) / 2.).max(px(0.));
    if -target != offset.y {
        list.set_offset(point(offset.x, -target));
        window.refresh();
    }
}
