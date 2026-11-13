//! Discover literature drawn (`.literature-*` in `workspace-panels.css`): a
//! drawer 480 wide at most, the search box and Title/abstract only, how many
//! results and from where, then the results as Papers rows (the title in the
//! reading face, three lines before the ellipsis; who and when beneath it
//! with how the work ranks at the end), one fluid hover fill gliding between
//! them, hairlines between rows at rest. Hovered, a row's actions come in
//! over its rank; opened, its preview holds them.

use gpui::{
    AnyElement, Context, Focusable as _, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::Input;
use lattice_core::models::LiteratureHit;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, CheckState, Checkbox, Drawer, EmptyState, LayerPlacement, ModalLayer},
    fluid_hover::{FluidHover, ItemKind},
    icons::{ICON, ICON_SMALL},
    interaction::{fade, mix, track_pointer, use_interaction},
    motion::Motion,
    shape,
};

use super::{Literature, hit_key};
use crate::papers::row::tooltip;

/// "9.2K" as Elicit and Matter print counts beside a byline.
fn compact(value: u32) -> String {
    match value {
        0..=999 => value.to_string(),
        1_000..=999_999 => trim(format!("{:.1}K", value as f32 / 1_000.)),
        _ => trim(format!("{:.1}M", value as f32 / 1_000_000.)),
    }
}

fn trim(text: String) -> String {
    text.replace(".0K", "K").replace(".0M", "M")
}

/// How the work ranks where it came from: alphaXiv votes, OpenAlex cites.
fn signal(hit: &LiteratureHit, full: bool) -> Option<String> {
    let count = |value: u32| {
        if full {
            value.to_string()
        } else {
            compact(value)
        }
    };
    match (hit.votes, hit.cited_by_count) {
        (Some(1), _) => Some(t!("1 vote").into()),
        (Some(votes), _) => Some(t!("{0} votes", count(votes))),
        (None, Some(1)) => Some(t!("1 cite").into()),
        (None, Some(cites)) => Some(t!("{0} cites", count(cites))),
        _ => None,
    }
}

fn source_name(hit: &LiteratureHit) -> &'static str {
    if hit.source == "alphaxiv" {
        "alphaXiv"
    } else {
        "OpenAlex"
    }
}

/// Who and when; alphaXiv names no authors, so its rows say which arXiv
/// paper they are instead.
fn byline(hit: &LiteratureHit) -> Vec<String> {
    let authors = if !hit.authors.is_empty() {
        let mut names = hit.authors[..hit.authors.len().min(2)].join(", ");
        if hit.authors.len() > 2 {
            names.push_str(" et al.");
        }
        names
    } else {
        hit.arxiv_id
            .as_ref()
            .map(|id| format!("arXiv {id}"))
            .unwrap_or_default()
    };
    [
        authors,
        hit.year.map(|year| year.to_string()).unwrap_or_default(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect()
}

/// The page a result opens: its landing page, its DOI, or its arXiv abstract.
fn page(hit: &LiteratureHit) -> Option<String> {
    hit.landing_url
        .clone()
        .or_else(|| hit.doi.as_ref().map(|doi| format!("https://doi.org/{doi}")))
        .or_else(|| {
            hit.arxiv_id
                .as_ref()
                .map(|id| format!("https://arxiv.org/abs/{id}"))
        })
}

impl Literature {
    fn row(
        &mut self,
        ix: usize,
        hit: &LiteratureHit,
        lit: bool,
        lit_before: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let key = hit_key(hit);
        let id: gpui::ElementId = SharedString::from(format!("literature:{key}")).into();
        let (interaction, pointer) = use_interaction(id.clone(), window, cx);
        let expanded = self.open.as_ref() == Some(&key);
        let imported = self.imported(hit, cx);
        let busy = self.busy.as_ref() == Some(&key);
        let hovered = interaction.pointer.hovered;
        let actions = fade(
            gpui::ElementId::NamedChild(std::sync::Arc::new(id.clone()), "actions".into()),
            hovered && !expanded && !imported,
            Motion::Fast,
            window,
            cx,
        );
        let hairline = fade(
            gpui::ElementId::NamedChild(std::sync::Arc::new(id.clone()), "hairline".into()),
            ix > 0 && !(lit || lit_before || expanded),
            Motion::Fast,
            window,
            cx,
        );
        let reading = cx.lattice().fonts.ui.clone();
        let in_papers = |cx: &Context<Self>| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(4.))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.success)
                .child(Icon::CHECK.element(ICON_SMALL, palette.success))
                .child(t!("In Papers"))
        };
        let view = cx.entity().downgrade();
        let (add_hit, cite_hit) = (hit.clone(), hit.clone());
        let add_view = view.clone();
        let cite_view = view.clone();
        let quick_actions = div()
            .absolute()
            .right(px(-4.))
            .top(px(-6.))
            .bottom(px(-6.))
            .pl(px(16.))
            .flex()
            .items_center()
            .gap(px(2.))
            .opacity(actions)
            .bg(if expanded {
                palette.row_selected
            } else {
                palette.input
            })
            .when(hit.arxiv_id.is_some(), |actions| {
                actions.child(
                    div()
                        .id(gpui::ElementId::NamedChild(
                            std::sync::Arc::new(id.clone()),
                            "add".into(),
                        ))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .h(px(22.))
                        .pl(px(6.))
                        .pr(px(8.))
                        .rounded(px(4.))
                        .bg(palette.accent_soft)
                        .text_color(palette.accent)
                        .text_role(TextRole::Caption, cx)
                        .cursor_pointer()
                        .on_click(move |_, _, cx| {
                            cx.stop_propagation();
                            add_view.update(cx, |this, cx| this.add(&add_hit, cx)).ok();
                        })
                        .child(
                            if busy { Icon::LOADER } else { Icon::PLUS }
                                .element(px(13.), palette.accent),
                        )
                        .child(t!("Add")),
                )
            })
            .child(
                div()
                    .id(gpui::ElementId::NamedChild(
                        std::sync::Arc::new(id.clone()),
                        "cite".into(),
                    ))
                    .size(px(24.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.))
                    .cursor_pointer()
                    .hover(|style| style.bg(palette.accent_soft))
                    .tooltip(tooltip(t!("Citation only")))
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        cite_view
                            .update(cx, |this, cx| this.add_citation(&cite_hit, cx))
                            .ok();
                    })
                    .child(Icon::FILE_PEN_LINE.element(ICON_SMALL, palette.text_secondary)),
            );
        let meta = div()
            .relative()
            .flex()
            .items_center()
            .gap(px(8.))
            .h(px(16.))
            .mt(px(4.))
            .min_w_0()
            .child(
                div()
                    .flex()
                    .min_w_0()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .whitespace_nowrap()
                    .children(byline(hit).into_iter().enumerate().map(|(ix, part)| {
                        div()
                            .flex()
                            .min_w_0()
                            .when(ix > 0, |part| part.flex_none().child(div().w(px(12.))))
                            .child(div().min_w_0().truncate().child(part))
                    })),
            )
            .map(|meta| {
                if imported {
                    meta.child(div().ml_auto().child(in_papers(cx)))
                } else if let Some(signal) = signal(hit, false) {
                    meta.child(
                        div()
                            .ml_auto()
                            .flex_none()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .opacity(1. - actions)
                            .child(signal),
                    )
                } else {
                    meta
                }
            })
            .when(actions > 0., |meta| meta.child(quick_actions));
        let toggle_key = key.clone();
        let mut row = track_pointer(div().id(id.clone()), pointer)
            .relative()
            .flex()
            .flex_col()
            .when(ix > 0, |row| row.mt(px(2.)))
            .px(px(8.))
            .py(px(10.))
            .rounded(px(6.))
            .when(expanded, |row| row.bg(palette.row_selected))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| this.toggle(toggle_key.clone(), cx)))
            .child(
                div()
                    .absolute()
                    .top(px(-2.))
                    .left(px(8.))
                    .right(px(8.))
                    .h(px(1.))
                    .bg(palette.line)
                    .opacity(hairline),
            )
            .child(
                div()
                    .pr(px(12.))
                    .font_family(reading.clone())
                    .text_role(TextRole::Typeset, cx)
                    .line_height(px(20.))
                    .text_color(palette.text)
                    .when(!expanded, |title| title.line_clamp(3))
                    .child(hit.title.clone()),
            )
            .child(
                div()
                    .absolute()
                    .top(px(14.))
                    .right(px(4.))
                    .opacity(if hovered || expanded { 1. } else { 0. })
                    .child(
                        if expanded {
                            Icon::CHEVRON_UP
                        } else {
                            Icon::CHEVRON_DOWN
                        }
                        .element(ICON_SMALL, palette.text_secondary),
                    ),
            )
            .child(meta);
        if expanded {
            row = row.child(self.preview(hit, imported, busy, cx));
        } else if let Some(snippet) = hit.snippet.clone() {
            row = row.child(
                div()
                    .mt(px(4.))
                    .font_family(reading)
                    .italic()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .line_clamp(2)
                    .child(snippet),
            );
        }
        row.into_any_element()
    }

    /// The preview folded into the row: the abstract in the reading face,
    /// then who, where from and which id, then the actions.
    fn preview(
        &self,
        hit: &LiteratureHit,
        imported: bool,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let reading = cx.lattice().fonts.ui.clone();
        let (text, quiet) = match (&hit.r#abstract, &hit.snippet) {
            (Some(text), _) => (text.clone(), false),
            (None, Some(snippet)) => (snippet.clone(), true),
            _ => (t!("No abstract from this source").to_string(), true),
        };
        let fact = |label: &'static str, value: String, cx: &Context<Self>| {
            div()
                .flex()
                .gap(px(8.))
                .text_role(TextRole::Caption, cx)
                .child(
                    div()
                        .flex_none()
                        .w(px(66.))
                        .text_color(palette.text_secondary)
                        .child(label),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_color(palette.text_secondary)
                        .child(value),
                )
        };
        let source = [Some(source_name(hit).to_string()), signal(hit, true)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ");
        let view = cx.entity().downgrade();
        let (add_hit, cite_hit) = (hit.clone(), hit.clone());
        let (add_view, cite_view) = (view.clone(), view);
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .mt(px(10.))
            .cursor_default()
            .child(
                div()
                    .font_family(reading)
                    .text_role(TextRole::Body, cx)
                    .text_color(if quiet {
                        palette.text_secondary
                    } else {
                        palette.text
                    })
                    .when(quiet, |text| text.italic())
                    .child(text),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .when(!hit.authors.is_empty(), |facts| {
                        facts.child(fact(t!("Authors"), hit.authors.join(", "), cx))
                    })
                    .child(fact(t!("Source"), source, cx))
                    .map(|facts| match (&hit.arxiv_id, &hit.doi) {
                        (Some(id), _) => facts.child(fact("arXiv", id.clone(), cx)),
                        (None, Some(doi)) => facts.child(fact("DOI", doi.clone(), cx)),
                        _ => facts,
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(6.))
                    .map(|actions| {
                        if imported {
                            actions.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(4.))
                                    .px(px(6.))
                                    .text_role(TextRole::Caption, cx)
                                    .text_color(palette.success)
                                    .child(Icon::CHECK.element(ICON_SMALL, palette.success))
                                    .child(t!("In Papers")),
                            )
                        } else if hit.arxiv_id.is_some() {
                            actions.child(
                                Button::new("literature-add", t!("Add to Papers"))
                                    .tinted()
                                    .compact()
                                    .icon(if busy { Icon::LOADER } else { Icon::PLUS })
                                    .disabled(self.busy.is_some())
                                    .on_click(move |_, _, cx| {
                                        add_view.update(cx, |this, cx| this.add(&add_hit, cx)).ok();
                                    }),
                            )
                        } else {
                            actions
                        }
                    })
                    .child(
                        Button::new("literature-cite", t!("Citation only"))
                            .compact()
                            .icon(Icon::FILE_PEN_LINE)
                            .on_click(move |_, _, cx| {
                                cite_view
                                    .update(cx, |this, cx| this.add_citation(&cite_hit, cx))
                                    .ok();
                            }),
                    )
                    .when_some(page(hit), |actions, page| {
                        actions.child(
                            Button::new("literature-page", t!("Open page"))
                                .compact()
                                .icon(Icon::EXTERNAL_LINK)
                                .on_click(move |_, _, cx| cx.open_url(&page)),
                        )
                    }),
            )
            .into_any_element()
    }

    fn search_form(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let focused = self.input().read(cx).focus_handle(cx).is_focused(window);
        let ready = !self.input().read(cx).value().trim().is_empty() && !self.loading;
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .id("literature-field")
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .h(px(32.))
                    .pl(px(9.))
                    .pr(px(4.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(if focused {
                        palette.field_border_hover
                    } else {
                        palette.field_border
                    })
                    .bg(palette.input)
                    .child(Icon::SEARCH.element(ICON, palette.text_secondary))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_role(TextRole::BodyCompact, cx)
                            .child(
                                Input::new(self.input())
                                    .appearance(false)
                                    .bordered(false)
                                    .px_0(),
                            ),
                    )
                    .child(
                        div()
                            .id("literature-submit")
                            .size(px(24.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .when(ready, |button| {
                                button
                                    .cursor_pointer()
                                    .hover(|style| style.bg(palette.accent_soft))
                            })
                            .tooltip(tooltip(t!("Search")))
                            .on_click(cx.listener(|this, _, _, cx| this.search(cx)))
                            .child(
                                if self.loading {
                                    Icon::LOADER
                                } else {
                                    Icon::ARROW_RIGHT
                                }
                                .element(
                                    ICON,
                                    if ready {
                                        palette.accent
                                    } else {
                                        palette.text_secondary
                                    },
                                ),
                            ),
                    ),
            )
            .child(
                Checkbox::new(
                    "literature-precise",
                    if self.precise {
                        CheckState::On
                    } else {
                        CheckState::Off
                    },
                )
                .label(t!("Title/abstract only"))
                .on_toggle(cx.listener(|this, on: &bool, _, cx| this.set_precise(*on, cx))),
            )
            .into_any_element()
    }
}

impl Render for Literature {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        self.settle_busy(cx);
        let mut body: Vec<AnyElement> = vec![self.search_form(window, cx)];
        let message = |text: String, ink: Hsla, cx: &Context<Self>| {
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(ink)
                .child(text)
                .into_any_element()
        };
        if let Some(error) = self.error.clone() {
            body.push(message(error, mix(palette.danger, palette.text, 0.2), cx));
        }
        if let Some(notice) = self.notice.clone() {
            body.push(message(notice, palette.text_secondary, cx));
        }
        if !self.results.is_empty() {
            let count = if self.has_more {
                t!(
                    "{count}+ results for “{shownQuery}”",
                    count = self.results.len(),
                    shownQuery = self.shown_query
                )
            } else if self.results.len() == 1 {
                t!("1 result for “{shownQuery}”", shownQuery = self.shown_query)
            } else {
                t!(
                    "{count} results for “{shownQuery}”",
                    count = self.results.len(),
                    shownQuery = self.shown_query
                )
            };
            let mut sources: Vec<&str> = self.results.iter().map(source_name).collect();
            sources.dedup();
            sources.sort_unstable();
            sources.dedup();
            body.push(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_x(px(8.))
                    .px(px(8.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(div().min_w_0().truncate().child(count))
                    .child(div().child(sources.join(", ")))
                    .into_any_element(),
            );
            let hover = FluidHover::new("literature-hover", window, cx)
                .fill(palette.hover)
                .radius(shape::RADIUS_TARGET);
            let shown: Vec<LiteratureHit> =
                self.results.iter().take(self.visible).cloned().collect();
            let mut rows: Vec<AnyElement> = vec![hover.highlight()];
            for (ix, hit) in shown.iter().enumerate() {
                let lit = hover.is_lit(ix, cx);
                let lit_before = ix > 0 && hover.is_lit(ix - 1, cx);
                let expanded = self.open.as_ref() == Some(&hit_key(hit));
                let row = self.row(ix, hit, lit, lit_before, window, cx);
                let kind = if expanded {
                    ItemKind::skip()
                } else {
                    ItemKind::target()
                };
                rows.push(hover.item_as(ix, kind, row));
            }
            body.push(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .children(rows)
                    .into_any_element(),
            );
            if self.visible < self.results.len() || self.has_more {
                body.push(
                    div()
                        .flex()
                        .justify_center()
                        .child(
                            Button::new(
                                "literature-more",
                                if self.loading_more {
                                    t!("Loading…")
                                } else {
                                    t!("Load more")
                                },
                            )
                            .ghost()
                            .compact()
                            .disabled(self.loading_more)
                            .on_click(cx.listener(|this, _, _, cx| this.load_more(cx))),
                        )
                        .into_any_element(),
                );
            }
        } else if !self.loading && self.error.is_none() && self.notice.is_none() {
            body.push(EmptyState::new(t!("Find your next source")).into_any_element());
        }
        let view = cx.entity().downgrade();
        let close = view.clone();
        let viewport = window.viewport_size();
        let drawer = Drawer::new("literature", t!("Discover literature"))
            .width(px(480.).min(viewport.width))
            .on_close(move |_, cx| {
                close.update(cx, |this, cx| this.close(cx)).ok();
            })
            .children(body);
        ModalLayer::new(
            "literature-layer",
            LayerPlacement::Right,
            drawer,
            move |_, cx| {
                view.update(cx, |this, cx| this.close(cx)).ok();
            },
        )
    }
}
