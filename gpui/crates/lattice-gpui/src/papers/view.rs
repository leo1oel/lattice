//! The Papers panel drawn: the box, the toolbar and chip, the add and
//! pending rows, the list (grouped or not, a table when wide) and, beside it
//! in a wide panel, the selected paper's inspector.
//!
//! Measured on the Main window (`.papers-section`): 7px under the tab strip,
//! 10px in from the panel's left edge and the box 10px short of its right,
//! the list running to the edge with 12px of its own inset so its scrollbar
//! has a gutter.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, canvas, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, EmptyState, ErrorState},
    fluid_hover::{FluidHover, ItemKind},
    icons::ICON_SMALL,
    reveal::{Arrival, reveal},
    scrollbar::{FluidScrollbar, ScrollbarFeel},
    shape,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_REGULAR},
};

use super::{
    Load, PapersPanel, TextSearch,
    model::{self, Group},
    row::{RowFacts, TABLE_AUTHORS, TABLE_CITED, TABLE_GAP, TABLE_VENUE, TABLE_YEAR},
};

/// The inspector's width, and its margins (`.paper-inspector`).
const INSPECTOR_WIDTH: f32 = 360.;

impl PapersPanel {
    /// The library while its list is not there yet, or why reading it
    /// failed; never the empty library's invitation.
    fn render_load_status(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let palette = cx.palette().clone();
        match &self.load {
            Load::Ready => None,
            Load::Loading => Some(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(8.))
                    .py(px(10.))
                    .child(Icon::LOADER.element(ICON_SMALL, palette.text_secondary))
                    .child(
                        div()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(t!("Loading references…")),
                    )
                    .into_any_element(),
            ),
            Load::Failed(error) => {
                let view = cx.entity().downgrade();
                Some(
                    ErrorState::new(t!("Couldn’t read your references"))
                        .detail(error.clone())
                        .action(
                            Button::new("papers-retry", t!("Try again"))
                                .compact()
                                .on_click(move |_, _, cx| {
                                    view.update(cx, |this, cx| this.reload(cx)).ok();
                                }),
                        )
                        .into_any_element(),
                )
            }
        }
    }

    /// Where the full-text half of a search has got, when it is slow or
    /// failed: a short list is then not read as the library lacking it.
    fn render_text_status(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let palette = cx.palette().clone();
        let line = |icon: AnyElement, text: &'static str, cx: &Context<Self>| {
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .min_w_0()
                .px(px(8.))
                .py(px(6.))
                .child(icon)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(text),
                )
        };
        match &self.text_search {
            TextSearch::Searching => Some(
                line(
                    Icon::LOADER
                        .element(ICON_SMALL, palette.text_secondary)
                        .into_any_element(),
                    t!("Searching saved text…"),
                    cx,
                )
                .into_any_element(),
            ),
            TextSearch::Failed(error) => {
                let view = cx.entity().downgrade();
                let error = SharedString::from(error.clone());
                Some(
                    line(
                        Icon::CIRCLE_ALERT
                            .element(px(13.), palette.text_secondary)
                            .into_any_element(),
                        t!("Saved-text search unavailable"),
                        cx,
                    )
                    .id("papers-text-status")
                    .tooltip(move |_, cx| {
                        lattice_ui::components::LatticeTooltip::view(error.clone(), None, cx)
                    })
                    .child(
                        Button::new("papers-text-retry", t!("Try again"))
                            .compact()
                            .on_click(move |_, _, cx| {
                                view.update(cx, |this, cx| this.search_now(cx)).ok();
                            }),
                    )
                    .into_any_element(),
                )
            }
            _ => None,
        }
    }

    /// A wide list's column headers; each sorts by its column.
    fn render_table_head(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let sort = self.sort;
        let view = cx.entity().downgrade();
        let header = |id: &'static str,
                      label: &'static str,
                      value: model::Sort,
                      width: Option<f32>,
                      end: bool| {
            let view = view.clone();
            let on = sort == value;
            div()
                .flex()
                .when_some(width, |cell, width| cell.flex_none().w(px(width)))
                .when(width.is_none(), |cell| cell.flex_1().min_w_0())
                .when(end, |cell| cell.justify_end())
                .child(
                    div()
                        .id(id)
                        .flex()
                        .items_center()
                        .gap(px(2.))
                        .h(px(24.))
                        .ml(px(-4.))
                        .px(px(4.))
                        .min_w_0()
                        .rounded(px(4.))
                        .cursor_pointer()
                        .hover(|style| style.bg(palette.hover))
                        .text_role(TextRole::Caption, cx)
                        .text_color(if on {
                            palette.text
                        } else {
                            palette.text_secondary
                        })
                        .on_click(move |_, _, cx| {
                            view.update(cx, |this, cx| this.set_sort(value, cx)).ok();
                        })
                        .child(div().min_w_0().truncate().child(label))
                        .when(on, |cell| {
                            cell.child(Icon::ARROW_DOWN.element(ICON_SMALL, palette.text))
                        }),
                )
        };
        div()
            .flex()
            .items_center()
            .gap(px(TABLE_GAP))
            .mb(px(2.))
            .px(px(12.))
            .py(px(4.))
            .border_b_1()
            .border_color(palette.line)
            .child(div().flex_none().w(px(16. + TABLE_GAP - 6.)))
            .child(header(
                "papers-head-title",
                t!("Title"),
                model::Sort::Title,
                None,
                false,
            ))
            .child(header(
                "papers-head-authors",
                t!("Authors"),
                model::Sort::Author,
                Some(TABLE_AUTHORS),
                false,
            ))
            .child(header(
                "papers-head-year",
                t!("Year"),
                model::Sort::Year,
                Some(TABLE_YEAR),
                false,
            ))
            .child(header(
                "papers-head-venue",
                t!("Venue"),
                model::Sort::Venue,
                Some(TABLE_VENUE),
                false,
            ))
            .child(if self.uses_known() {
                header(
                    "papers-head-cited",
                    t!("Cited"),
                    model::Sort::Cited,
                    Some(TABLE_CITED),
                    true,
                )
                .into_any_element()
            } else {
                div().flex_none().w(px(TABLE_CITED)).into_any_element()
            })
            .into_any_element()
    }

    fn render_list(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let shown: Vec<_> = self.shown(cx).into_iter().cloned().collect();
        let table = self.wide();
        let list_width = if table && self.selected.is_some() {
            self.width - 10. - INSPECTOR_WIDTH - 14.
        } else {
            self.width - 10.
        };
        let row_width = (list_width - 12. - 16.).max(0.);
        let hits = self.current_hits(cx).cloned().unwrap_or_default();
        let sections = model::group(shown.iter().collect(), self.group, &self.facts);
        let hover = FluidHover::new("papers-hover", window, cx)
            .fill(palette.hover)
            .radius(shape::RADIUS_TARGET)
            .quiet_after_scroll(std::time::Duration::from_millis(150), cx);
        let mut out: Vec<AnyElement> = vec![];
        if let Some(status) = self.render_text_status(cx) {
            out.push(status);
        }
        if let Some(add) = self.render_add_rows(shown.len(), window, cx) {
            out.push(add);
        }
        if table && !shown.is_empty() {
            out.push(self.render_table_head(cx));
        }
        let mut index = 0;
        let mut rows: Vec<AnyElement> = vec![hover.highlight()];
        for (section_ix, section) in sections.iter().enumerate() {
            if self.group != Group::None {
                rows.push(
                    div()
                        .flex()
                        .items_baseline()
                        .gap(px(6.))
                        .min_w_0()
                        .mt(px(if section_ix == 0 { 4. } else { 16. }))
                        .mb(px(4.))
                        .mx(px(if table { 12. } else { 8. }))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text)
                        .child(div().min_w_0().truncate().child(section.name.clone()))
                        .child(
                            div()
                                .flex_none()
                                .font_weight(FONT_WEIGHT_REGULAR)
                                .text_color(palette.text_secondary)
                                .child(section.papers.len().to_string()),
                        )
                        .into_any_element(),
                );
            }
            let mut previous: Option<(usize, bool)> = None;
            for paper in &section.papers {
                let key = model::paper_key(paper);
                let current = self.active.as_deref() == Some(key.as_str());
                let selected = table && self.selected.as_deref() == Some(key.as_str());
                let lit = hover.is_lit(index, cx);
                let match_hits = hits
                    .get(&model::search_identity(paper))
                    .map(|found| (found.hits.clone(), self.expanded_hits.contains(&key)));
                let facts = RowFacts {
                    venue: self.facts.venue(paper).to_string(),
                    uses: self.facts.uses(paper),
                    fetch: self.fetching.states.get(&key).copied(),
                    current,
                    selected,
                    recent: model::is_just_added(paper, &self.just_added),
                    lit,
                    lit_before: previous.is_some_and(|(before, _)| hover.is_lit(before, cx)),
                    held_before: previous.is_some_and(|(_, held)| held),
                    after_row: previous.is_some(),
                    width: row_width,
                    table,
                    hits: match_hits,
                };
                let kind = if current || selected {
                    ItemKind::skip()
                } else {
                    ItemKind::target()
                }
                .section(section_ix);
                let row = self.render_row(paper, facts, window, cx);
                rows.push(hover.item_as(index, kind, row));
                previous = Some((index, current || selected));
                index += 1;
            }
        }
        out.push(
            div()
                .relative()
                .flex()
                .flex_col()
                .children(rows)
                .into_any_element(),
        );
        if shown.is_empty() && model::reference_kind(&self.query(cx)).is_none() {
            out.push(reveal(
                "papers-no-match",
                Arrival::PRODUCT,
                EmptyState::new(t!("No matching papers")),
                cx,
            ));
        }
        div()
            .relative()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(
                div()
                    .id("papers-list")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .pt(px(7.))
                    .pr(px(12.))
                    .children(out),
            )
            .child(
                FluidScrollbar::vertical("papers-scrollbar", &self.scroll)
                    .feel(ScrollbarFeel::LIST),
            )
            .into_any_element()
    }

    /// The empty library's invitation, the add rows when the box holds
    /// something to add, or the load's status.
    fn render_empty(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut body = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .pt(px(7.))
            .pr(px(12.));
        if let Some(add) = self.render_add_rows(0, window, cx) {
            return body.child(add).into_any_element();
        }
        if let Some(status) = self.render_load_status(cx) {
            return body.child(status).into_any_element();
        }
        let input = self.input().clone();
        body = body.items_center().justify_center().child(reveal(
            "papers-empty",
            Arrival::PRODUCT,
            EmptyState::new(t!("No papers yet")).action(
                // Only focuses the box: what to add is the writer's to type.
                Button::new("papers-first", t!("Add your first paper"))
                    .compact()
                    .on_click(move |_, window, cx| {
                        input.update(cx, |input, cx| input.focus(window, cx));
                    }),
            ),
            cx,
        ));
        body.into_any_element()
    }
}

impl Render for PapersPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let view = cx.entity().downgrade();
        let width = self.width;
        let mut section = div()
            .id("papers")
            .key_context("LatticePapers")
            .track_focus(&self.focus_handle)
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .min_w_0()
            .pt(px(7.))
            .pb(px(10.))
            .pl(px(10.))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                if event.keystroke.key != "escape" {
                    return;
                }
                // The inspector closes first; then Escape ends the search
                // where it began, and stops a download under way.
                if this.selected.is_some() && this.wide() {
                    this.select(None, cx);
                } else if this.fetching.busy() {
                    this.cancel_fetches(cx);
                } else if !this.query(cx).is_empty() {
                    this.clear_query(window, cx);
                } else {
                    return;
                }
                cx.stop_propagation();
            }))
            .child(self.render_field(window, cx));
        if self.root.is_none() {
            return section
                .child(
                    div()
                        .pt(px(12.))
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.text_secondary)
                        .child(t!("Open a project to see its papers")),
                )
                .into_any_element();
        }
        if self.papers.is_empty() {
            section = section.child(self.render_empty(window, cx));
        } else {
            let shown = self.shown(cx).len();
            section = section
                .child(self.render_toolbar(shown, cx))
                .children(self.render_chip(window, cx));
            let inspected = self
                .selected
                .as_ref()
                .filter(|_| self.wide())
                .and_then(|key| {
                    self.papers
                        .iter()
                        .find(|paper| &model::paper_key(paper) == key)
                })
                .cloned();
            let list = self.render_list(window, cx);
            section = section.child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .child(list)
                    .when_some(inspected, |body, paper| {
                        body.child(self.render_inspector(&paper, INSPECTOR_WIDTH, window, cx))
                    }),
            );
        }
        // The panel learns its width while it is laid out: the toolbar
        // folds, rows shorten their bylines, and a wide panel becomes a
        // table with an inspector.
        section
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let measured = f32::from(bounds.size.width);
                        if (measured - width).abs() > 0.5
                            && let Some(view) = view.upgrade()
                        {
                            view.update(cx, |this, _| this.width = measured);
                            window.on_next_frame(move |_, cx| view.update(cx, |_, cx| cx.notify()));
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
            .into_any_element()
    }
}
