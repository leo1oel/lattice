//! How the checklist is drawn (`.checklist-*` in the Tauri app's
//! `dialogs.css`): the verdict on a raised plate with its track, then
//! grouped lists divided by hairlines, each row leading with its result as
//! a mark (a tick, an exclamation, a dash) so colour never carries it
//! alone, its value in ink, a budget's gauge and the distance to it under
//! the label; and the limits closing the panel as a section of their own.

use gpui::{
    AnyElement, App, Context, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    PathBuilder, Render, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    canvas, div, point, prelude::FluentBuilder as _, px, relative,
};
use lattice_i18n::{comma, format_count, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Field},
    interaction::{track_pointer, use_interaction},
    scrollbar::FluidScrollbar,
    shape::RADIUS_SURFACE,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD, RADIUS_PILL},
    typography::tabular_nums,
};

use super::{ChecklistEvent, ChecklistPanel, model};

/// A row's result, as its mark and its gauge read it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Tone {
    Ok,
    Warn,
    None,
}

impl Tone {
    pub(super) fn of(result: Option<bool>) -> Tone {
        match result {
            Some(true) => Tone::Ok,
            Some(false) => Tone::Warn,
            None => Tone::None,
        }
    }
}

/// The check's result as a mark (`CheckStatus`): a tick when it passes, an
/// exclamation when it needs attention, a dash when it cannot be settled,
/// on a disc in the result's soft tone.
pub(super) fn status_mark(tone: Tone, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let (ground, ink) = match tone {
        Tone::Ok => (palette.success_soft, palette.success),
        Tone::Warn => (palette.warning_soft, palette.warning),
        Tone::None => (palette.line, palette.text_secondary),
    };
    let glyph = match tone {
        Tone::Ok => Icon::CHECK.element(px(12.), ink).into_any_element(),
        Tone::None => Icon::MINUS.element(px(12.), ink).into_any_element(),
        Tone::Warn => exclamation(ink),
    };
    mark_disc(ground, glyph)
}

/// The 18px disc a row's mark stands on, on its label's first line.
pub(super) fn mark_disc(ground: Hsla, glyph: AnyElement) -> AnyElement {
    div()
        .flex_none()
        .mt(px(1.))
        .size(px(18.))
        .rounded(RADIUS_PILL)
        .flex()
        .items_center()
        .justify_center()
        .bg(ground)
        .child(glyph)
        .into_any_element()
}

/// Lucide has no bare exclamation: its CircleAlert's two strokes, drawn.
pub(super) fn exclamation(ink: Hsla) -> AnyElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let unit = bounds.size.width / 24.;
            let at = |x: f32, y: f32| point(bounds.origin.x + unit * x, bounds.origin.y + unit * y);
            let mut stroke = PathBuilder::stroke(unit * 2.25);
            stroke.move_to(at(12., 5.));
            stroke.line_to(at(12., 14.));
            if let Ok(path) = stroke.build() {
                window.paint_path(path, ink);
            }
            let mut dot = PathBuilder::stroke(unit * 2.25);
            dot.move_to(at(12., 18.6));
            dot.line_to(at(12., 19.4));
            if let Ok(path) = dot.build() {
                window.paint_path(path, ink);
            }
        },
    )
    .size(px(12.))
    .into_any_element()
}

/// One grouped list: hairline-divided rows on the raised surface.
pub(super) fn rows_group(rows: Vec<AnyElement>, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let count = rows.len();
    div()
        .mb(px(16.))
        .flex()
        .flex_col()
        .rounded(RADIUS_SURFACE)
        .border_1()
        .border_color(palette.line)
        .bg(palette.raised)
        .overflow_hidden()
        .children(rows.into_iter().enumerate().map(|(index, row)| {
            div()
                .when(index > 0 && index < count, |row| {
                    row.border_t_1().border_color(palette.line)
                })
                .child(row)
        }))
        .into_any_element()
}

/// A row's parts: its result, label, value, and what goes under the label.
pub(super) struct RowParts {
    pub id: SharedString,
    pub tone: Tone,
    pub mark: Option<AnyElement>,
    pub label: SharedString,
    pub value: Option<AnyElement>,
    pub under: Vec<AnyElement>,
    pub on_click: Option<Box<dyn Fn(&mut Window, &mut App)>>,
    pub chevron: bool,
}

/// A checklist row (`.checklist-row`): 10px by 12px, the mark, the label
/// in the body's medium weight, the value at the end in the same, a
/// chevron when the row leads somewhere; a row that leads somewhere lights
/// under the pointer on the fast tier.
pub(super) fn checklist_row(parts: RowParts, window: &mut Window, cx: &mut App) -> AnyElement {
    let palette = cx.palette().clone();
    let clickable = parts.on_click.is_some();
    let (state, pointer) = use_interaction(parts.id.clone(), window, cx);
    let value = div()
        .flex_none()
        .flex()
        .items_center()
        .gap(px(4.))
        .text_role(TextRole::Body, cx)
        .font_weight(FONT_WEIGHT_MEDIUM)
        .font_features(tabular_nums())
        .text_color(palette.text)
        .children(parts.value)
        .when(parts.chevron, |value| {
            value.child(Icon::CHEVRON_RIGHT.element(px(13.), palette.text_secondary))
        });
    let row = div()
        .id(parts.id)
        .flex()
        .items_start()
        .gap(px(10.))
        .px(px(12.))
        .py(px(10.))
        .when(clickable, |row| {
            row.cursor_pointer().bg(state.wash(
                gpui::transparent_black(),
                palette.hover,
                palette.pressed,
            ))
        })
        .child(parts.mark.unwrap_or_else(|| status_mark(parts.tone, cx)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .justify_between()
                        .gap_x(px(10.))
                        .child(
                            div()
                                .min_w_0()
                                .text_role(TextRole::Body, cx)
                                .font_weight(FONT_WEIGHT_MEDIUM)
                                .text_color(palette.text)
                                .child(parts.label),
                        )
                        .child(value),
                )
                .children(parts.under),
        );
    match parts.on_click {
        Some(on_click) => track_pointer(
            row.on_click(move |_, window, cx| on_click(window, cx)),
            pointer,
        )
        .into_any_element(),
        None => row.into_any_element(),
    }
}

/// How far a count sits from its limit (`BudgetMeter`): the track spans the
/// larger of the two, so an overshoot keeps its proportion, the excess its
/// own segment past a notch at the limit.
fn budget_meter(value: u32, limit: u32, tone: Tone, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let span = value.max(limit).max(1) as f32;
    let over = value > limit;
    let tone_ink = match tone {
        Tone::Ok => palette.success,
        Tone::Warn => palette.warning,
        Tone::None => palette.text_secondary,
    };
    let fill = if over {
        palette.text_secondary.opacity(0.42)
    } else {
        tone_ink.opacity(0.56)
    };
    let filled = value.min(limit) as f32 / span;
    div()
        .relative()
        .mt(px(6.))
        .mb(px(2.))
        .h(px(4.))
        .w_full()
        .rounded(RADIUS_PILL)
        .bg(palette.line)
        .overflow_hidden()
        .when(limit > 0, |meter| {
            meter.child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left_0()
                    .w(relative(filled))
                    .bg(fill),
            )
        })
        .when(over, |meter| {
            let start = limit as f32 / span;
            meter.child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(relative(start))
                    .w(relative((value - limit) as f32 / span))
                    .bg(tone_ink)
                    .when(limit > 0, |excess| {
                        excess.border_l_2().border_color(palette.raised)
                    }),
            )
        })
        .into_any_element()
}

/// The caption under a row: the distance to its limit in bold, then its detail.
fn row_detail(distance: Option<String>, detail: Option<String>, cx: &App) -> Option<AnyElement> {
    if distance.is_none() && detail.is_none() {
        return None;
    }
    let palette = cx.palette().clone();
    let both = distance.is_some() && detail.is_some();
    Some(
        div()
            .flex()
            .flex_wrap()
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .children(distance.map(|distance| {
                div()
                    .text_color(palette.text)
                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                    .child(distance)
            }))
            .when(both, |line| line.child(comma()))
            .children(detail)
            .into_any_element(),
    )
}

impl ChecklistPanel {
    /// The verdict and its track (`.checklist-summary`).
    fn render_summary(&self, checks: &[Option<bool>], cx: &App) -> AnyElement {
        let palette = cx.palette().clone();
        let verdict = model::verdict(checks);
        let segments = checks.iter().map(|check| {
            div()
                .flex_1()
                .h_full()
                .rounded(RADIUS_PILL)
                .bg(match check {
                    Some(true) => palette.success,
                    Some(false) => palette.warning,
                    None => palette.line_strong,
                })
        });
        div()
            .relative()
            .mb(px(12.))
            .pt(px(12.))
            .px(px(12.))
            .pb(px(10.))
            .rounded(RADIUS_SURFACE)
            .border_1()
            .border_color(palette.line)
            .bg(palette.raised)
            .children(lattice_ui::parity::probe("checklist/summary"))
            .child(
                div()
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child(verdict.text),
            )
            .child(
                div()
                    .mt(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .h(px(4.))
                            .flex()
                            .gap(px(2.))
                            .children(segments),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .font_features(tabular_nums())
                            .child(format!("{}/{}", verdict.passing, verdict.total)),
                    ),
            )
            .into_any_element()
    }

    /// Body words, main (or PDF) pages, TODOs, unused labels and cites, the
    /// last build.
    pub(super) fn automatic_rows(
        &self,
        facts: &AutomaticFacts,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut rows = Vec::new();
        // Words: a missing or partial count is never a pass.
        let counted_words = facts.words.filter(|_| facts.texcount);
        let words_ok = facts
            .word_budget
            .zip(counted_words)
            .map(|(limit, count)| count <= limit);
        let word_value = match facts.words {
            None => t!("Unavailable").to_string(),
            Some(words) if !facts.texcount => format!("≈{}", format_count(words as i64)),
            Some(words) => match facts.word_budget {
                Some(limit) => format!(
                    "{} / {}",
                    format_count(words as i64),
                    format_count(limit as i64)
                ),
                None => format_count(words as i64),
            },
        };
        let word_detail = match facts.words {
            None => Some(model::with_limit(
                t!("Needs a root document to count from").into(),
                model::word_limit_note(facts.word_budget),
            )),
            Some(_) if !facts.texcount => Some(model::with_limit(
                t!("Root document only, estimated without texcount").into(),
                model::word_limit_note(facts.word_budget),
            )),
            _ => None,
        };
        let word_meter = counted_words.zip(facts.word_budget);
        rows.push(self.budget_row(
            "checklist-words",
            t!("Body words").into(),
            word_value,
            words_ok,
            word_meter.map(|(count, limit)| (count, limit, model::word_distance(count, limit))),
            word_detail,
            window,
            cx,
        ));
        // Pages: the main body's, against the page budget.
        let counted_pages = model::counted_pages(facts.pages, facts.body);
        let pages_ok = facts
            .page_budget
            .zip(counted_pages)
            .map(|(limit, count)| count <= limit);
        let page_label = if facts.pages.is_some() && facts.body != model::Body::None {
            t!("Main pages")
        } else {
            t!("PDF pages")
        };
        let page_value = match (facts.pages, counted_pages) {
            (None, _) => t!("Build to count").to_string(),
            (Some(_), None) => t!("Unavailable").to_string(),
            (Some(_), Some(count)) => match facts.page_budget {
                Some(limit) => format!("{count} / {limit}"),
                None => count.to_string(),
            },
        };
        let page_meter = counted_pages.zip(facts.page_budget);
        rows.push(self.budget_row(
            "checklist-pages",
            page_label.into(),
            page_value,
            pages_ok,
            page_meter.map(|(count, limit)| (count, limit, model::page_distance(count, limit))),
            model::page_detail(facts.pages, facts.body, facts.page_budget),
            window,
            cx,
        ));
        let entity = cx.entity().downgrade();
        rows.push(checklist_row(
            RowParts {
                id: "checklist-todos".into(),
                tone: Tone::of(Some(facts.todos == 0)),
                mark: None,
                label: t!("TODOs").into(),
                value: Some(facts.todos.to_string().into_any_element()),
                under: Vec::new(),
                on_click: Some(Box::new(move |_, cx| {
                    entity
                        .update(cx, |_, cx| cx.emit(ChecklistEvent::OpenTodos))
                        .ok();
                })),
                chevron: true,
            },
            window,
            cx,
        ));
        let unused = facts.unused_labels + facts.unused_citations;
        rows.push(checklist_row(
            RowParts {
                id: "checklist-unused".into(),
                tone: Tone::of(Some(unused == 0)),
                mark: None,
                label: t!("Unused labels / cites").into(),
                value: Some(
                    format!("{} / {}", facts.unused_labels, facts.unused_citations)
                        .into_any_element(),
                ),
                under: Vec::new(),
                on_click: None,
                chevron: false,
            },
            window,
            cx,
        ));
        let build_value = match facts.build_ok {
            None => t!("Not built"),
            Some(true) => t!("OK"),
            Some(false) => t!("Failed"),
        };
        rows.push(checklist_row(
            RowParts {
                id: "checklist-build".into(),
                tone: Tone::of(facts.build_ok),
                mark: None,
                label: t!("Last build").into(),
                value: Some(build_value.into_any_element()),
                under: row_detail(
                    None,
                    Some(facts.build_message.clone()).filter(|m| !m.is_empty()),
                    cx,
                )
                .into_iter()
                .collect(),
                on_click: None,
                chevron: false,
            },
            window,
            cx,
        ));
        rows_group(rows, cx)
    }

    #[allow(clippy::too_many_arguments)]
    fn budget_row(
        &self,
        id: &'static str,
        label: SharedString,
        value: String,
        ok: Option<bool>,
        meter: Option<(u32, u32, String)>,
        detail: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let tone = Tone::of(ok);
        let mut under = Vec::new();
        let distance = meter.as_ref().map(|(_, _, distance)| distance.clone());
        if let Some((count, limit, _)) = meter {
            under.push(budget_meter(count, limit, tone, cx));
        }
        under.extend(row_detail(distance, detail, cx));
        checklist_row(
            RowParts {
                id: id.into(),
                tone,
                mark: None,
                label,
                value: Some(value.into_any_element()),
                under,
                on_click: None,
                chevron: false,
            },
            window,
            cx,
        )
    }

    /// The way into the figure inventory: no result, only the row's shape
    /// and where it leads.
    fn figures_link(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let entity = cx.entity().downgrade();
        let row = checklist_row(
            RowParts {
                id: "checklist-figures".into(),
                tone: Tone::None,
                mark: Some(mark_disc(
                    palette.line,
                    Icon::IMAGES
                        .element(px(12.), palette.text_secondary)
                        .into_any_element(),
                )),
                label: t!("Figure inventory").into(),
                value: None,
                under: Vec::new(),
                on_click: Some(Box::new(move |_, cx| {
                    entity
                        .update(cx, |_, cx| cx.emit(ChecklistEvent::OpenFigures))
                        .ok();
                })),
                chevron: true,
            },
            window,
            cx,
        );
        rows_group(vec![row], cx)
    }

    /// The word and page limits, a section of their own.
    fn limits(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let field =
            |label: &'static str, state: &gpui::Entity<gpui_kit::component::input::InputState>| {
                div()
                    .flex_grow(3.)
                    .flex_basis(px(88.))
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .text_role(TextRole::Caption, cx)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text_secondary)
                    .child(label)
                    .child(Field::new(state))
            };
        div()
            .child(section_title(t!("Word and page limits"), cx))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_end()
                    .gap(px(8.))
                    .child(field(t!("Word budget"), &self.word_budget))
                    .child(field(t!("Page budget"), &self.page_budget))
                    .child(
                        div()
                            .flex_grow(1.)
                            .flex_shrink_0()
                            .flex_basis(px(88.))
                            .child(
                                Button::new("checklist-save-budgets", t!("Save budgets"))
                                    .tinted()
                                    .on_click(cx.listener(|this, _, _, cx| this.save_budgets(cx))),
                            ),
                    ),
            )
            .into_any_element()
    }
}

/// A section's heading (`.checklist-review h3`, `.checklist-limits h3`).
pub(super) fn section_title(title: impl Into<SharedString>, cx: &App) -> AnyElement {
    div()
        .mb(px(6.))
        .text_role(TextRole::Subtitle, cx)
        .text_color(cx.palette().text)
        .child(title.into())
        .into_any_element()
}

/// The counts the automatic rows read, gathered for one frame.
pub(super) struct AutomaticFacts {
    pub words: Option<u32>,
    pub texcount: bool,
    pub word_budget: Option<u32>,
    pub pages: Option<u32>,
    pub body: model::Body,
    pub page_budget: Option<u32>,
    pub todos: usize,
    pub unused_labels: usize,
    pub unused_citations: usize,
    pub build_ok: Option<bool>,
    pub build_message: String,
}

impl Render for ChecklistPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let facts = self.automatic_facts(cx);
        let review_rows = super::review::rows(self.facts.review.as_ref());
        let item_results = self.item_results(cx);
        let mut checks = vec![
            facts
                .word_budget
                .zip(facts.words.filter(|_| facts.texcount))
                .map(|(l, c)| c <= l),
            facts
                .page_budget
                .zip(model::counted_pages(facts.pages, facts.body))
                .map(|(l, c)| c <= l),
            Some(facts.todos == 0),
            Some(facts.unused_labels + facts.unused_citations == 0),
            facts.build_ok,
        ];
        checks.extend(review_rows.iter().map(|row| row.ok));
        checks.extend(item_results);
        let content = div()
            .flex()
            .flex_col()
            .min_w_0()
            .child(self.render_deadline(window, cx))
            .child(self.render_summary(&checks, cx))
            .child(self.automatic_rows(&facts, window, cx))
            .children(self.render_review(&review_rows, window, cx))
            .child(self.render_items(window, cx))
            .child(self.figures_link(window, cx))
            .child(self.limits(cx));
        div()
            .id("checklist-panel")
            .track_focus(&self.focus_handle)
            .relative()
            .size_full()
            .bg(palette.input)
            .child(
                div()
                    .id("checklist-scroll")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(div().p(px(14.)).child(content)),
            )
            .child(FluidScrollbar::vertical(
                "checklist-scrollbar",
                &self.scroll,
            ))
    }
}

impl ChecklistPanel {
    fn automatic_facts(&self, cx: &App) -> AutomaticFacts {
        let root = self.root(cx);
        let manifest = self.manifest(cx);
        let words = root
            .as_deref()
            .and_then(|root| crate::build::word_count::manuscript_count(root, cx));
        let last = self.build.read(cx).last();
        let pages = (self
            .build
            .read(cx)
            .last()
            .is_some_and(|last| last.wrote_pdf)
            || self.pdf.read(cx).page_count(cx) > 0)
            .then(|| self.pdf.read(cx).page_count(cx) as u32)
            .filter(|pages| *pages > 0);
        AutomaticFacts {
            words: words.as_ref().map(|count| count.total),
            texcount: words
                .as_ref()
                .is_some_and(|count| count.source == "texcount"),
            word_budget: manifest.and_then(|manifest| manifest.word_budget),
            pages,
            body: self.facts.body.unwrap_or(model::Body::None),
            page_budget: manifest.and_then(|manifest| manifest.page_budget),
            todos: root
                .as_deref()
                .map_or(0, |root| crate::status_counters::todo_hits(root, cx).len()),
            unused_labels: self.facts.unused_labels,
            unused_citations: self.facts.unused_citations,
            build_ok: last.map(|last| last.success),
            build_message: last
                .and_then(|last| last.log.lines().last().map(str::to_string))
                .unwrap_or_default(),
        }
    }
}
