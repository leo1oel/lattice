//! A wide library's detail pane for the selected paper (`paper-inspector.tsx`,
//! `paper-inspector.css`): where it appeared and when, its title and
//! authors, what can be done with it, every place the manuscript cites it
//! (each a jump to that line), its abstract and its record.
//!
//! A plate raised inside the panel, 360 wide, its top on the list's first
//! row; it scrolls on its own, so the list keeps its place. Sections part
//! on hairlines, each heading a caption with its count beside it.

use lattice_i18n::t;
use std::collections::HashMap;

use gpui::{
    AnyElement, AppContext as _, Context, ElementId, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Task, Window,
    div, prelude::FluentBuilder as _, px,
};
use lattice_core::papers::PaperSummary;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, IconButton},
    icons::ICON_SMALL,
    interaction::{mix, track_pointer, use_interaction},
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_REGULAR},
};

use super::{PapersEvent, PapersPanel, model};

pub(super) mod uses;

/// The abstracts read so far, by arXiv id; `None` for a paper without one.
#[derive(Default)]
pub struct Abstracts {
    read: HashMap<String, Option<Vec<String>>>,
    pending: Option<(String, Task<()>)>,
}

impl PapersPanel {
    fn abstract_of(&mut self, paper: &PaperSummary, cx: &mut Context<Self>) -> Option<Vec<String>> {
        if !paper.has_full_text {
            return None;
        }
        let id = paper.arxiv_id.clone();
        if let Some(read) = self.abstracts.read.get(&id) {
            return read.clone();
        }
        if self
            .abstracts
            .pending
            .as_ref()
            .is_some_and(|(at, _)| *at == id)
        {
            return None;
        }
        let root = self.root.clone()?;
        let read_id = id.clone();
        let read = cx.background_spawn(async move {
            lattice_core::papers::read_paper(&root, &read_id)
                .ok()
                .and_then(|markdown| model::paper_abstract(&markdown))
        });
        let task = cx.spawn(async move |this, cx| {
            let found = read.await;
            this.update(cx, |this, cx| {
                this.abstracts.read.insert(id, found);
                this.abstracts.pending = None;
                cx.notify();
            })
            .ok();
        });
        self.abstracts.pending = Some((paper.arxiv_id.clone(), task));
        None
    }

    pub(super) fn render_inspector(
        &mut self,
        paper: &PaperSummary,
        width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let venue = self.facts.venue(paper).to_string();
        let year = paper.year.as_deref().map(str::trim).unwrap_or("");
        let kicker = [venue.as_str(), year]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        let names = model::author_names(paper);
        let authors = if names.len() > 8 {
            t!(
                "{names} and {count} more",
                names = names[..6].join(", "),
                count = names.len() - 6
            )
        } else {
            names.join(", ")
        };
        let state = model::reading_state(paper);
        let cite_key = paper.citation_key.clone();
        let usages = self.facts.usages(paper).map(<[_]>::to_vec);
        let details = match (&usages, cite_key.as_deref()) {
            (Some(usages), Some(key)) if !usages.is_empty() => self.use_details_of(key, usages, cx),
            _ => Vec::new(),
        };
        let abstract_text = self.abstract_of(paper, cx);
        let view = cx.entity().downgrade();
        let editor_font = cx.lattice().fonts.editor.clone();
        let reading_font = cx.lattice().fonts.ui.clone();

        let section = |title: &'static str, count: Option<usize>, cx: &Context<Self>| {
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .pt(px(12.))
                .border_t_1()
                .border_color(palette.line)
                .child(
                    div()
                        .flex()
                        .items_baseline()
                        .gap(px(6.))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text)
                        .child(title)
                        .when_some(count.filter(|count| *count > 0), |head, count| {
                            head.child(
                                div()
                                    .font_weight(FONT_WEIGHT_REGULAR)
                                    .text_color(palette.text_secondary)
                                    .child(count.to_string()),
                            )
                        }),
                )
        };

        let mut actions = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            .mt(px(4.))
            .mb(px(8.));
        if state != model::ReadingState::Citation {
            let (open_view, opened) = (view.clone(), paper.clone());
            actions = actions.child(
                Button::new(
                    "paper-inspector-open",
                    if state == model::ReadingState::FullText {
                        t!("Open paper")
                    } else {
                        t!("Download paper")
                    },
                )
                .tinted()
                .compact()
                .on_click(move |_, window, cx| {
                    open_view
                        .update(cx, |this, cx| this.activate(&opened, None, window, cx))
                        .ok();
                }),
            );
        }
        if let Some(key) = cite_key.clone() {
            let copy_view = view.clone();
            actions = actions.child(
                Button::new("paper-inspector-cite", t!("Copy \\cite"))
                    .compact()
                    .icon(Icon::COPY)
                    .tooltip(t!("Copy \\cite command"))
                    .on_click(move |_, _, cx| {
                        copy_view
                            .update(cx, |this, cx| this.copy(format!("\\cite{{{key}}}"), cx))
                            .ok();
                    }),
            );
        }
        if cite_key.is_some() {
            let (edit_view, edited) = (view.clone(), paper.clone());
            actions = actions.child(
                IconButton::new("paper-inspector-edit", Icon::PENCIL)
                    .tooltip(t!("Edit bibliography entry"))
                    .on_click(move |_, _, cx| {
                        edit_view
                            .update(cx, |_, cx| {
                                cx.emit(PapersEvent::EditEntry(Box::new(edited.clone())))
                            })
                            .ok();
                    }),
            );
        }
        if let Some(link) = model::link_url(paper) {
            actions = actions.child(
                IconButton::new("paper-inspector-link", Icon::EXTERNAL_LINK)
                    .tooltip(t!("Open link in browser"))
                    .on_click(move |_, _, cx| model::open_link(&link, cx)),
            );
        }

        let mut body = div()
            .id("paper-inspector")
            .flex()
            .flex_col()
            .flex_none()
            .w(px(width))
            .min_h_0()
            .mt(px(4.))
            .mr(px(10.))
            .ml(px(4.))
            .pt(px(12.))
            .px(px(16.))
            .pb(px(20.))
            .gap(px(8.))
            .rounded(px(10.))
            .overflow_y_scroll()
            .bg(palette.raised)
            .shadow(Elevation::Raised.shadows(&palette))
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(8.))
                    .min_h(px(28.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .py(px(6.))
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(kicker),
                    )
                    .child({
                        let close_view = view.clone();
                        IconButton::new("paper-inspector-close", Icon::X)
                            .tooltip(t!("Close paper details"))
                            .mr(px(-8.))
                            .on_click(move |_, _, cx| {
                                close_view.update(cx, |this, cx| this.select(None, cx)).ok();
                            })
                    }),
            )
            .child(
                div()
                    .mt(px(-4.))
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child(paper.title.clone()),
            )
            .when(!authors.is_empty(), |body| {
                body.child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(authors),
                )
            })
            .child(actions);

        // Every citation, in the order the manuscript reads; each opens its
        // line.
        if let Some(usages) = usages {
            let mut uses = section(t!("In this paper"), Some(usages.len()), cx);
            if usages.is_empty() {
                uses = uses.child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(t!("Not cited in this paper yet")),
                );
            } else {
                let mut list = div().flex().flex_col().gap(px(2.)).mx(px(-8.));
                for (ix, usage) in usages.into_iter().enumerate() {
                    let id: ElementId =
                        SharedString::from(format!("paper-inspector-use:{ix}")).into();
                    let (interaction, pointer) = use_interaction(id.clone(), window, cx);
                    let open_view = view.clone();
                    let (path, line) = (usage.path.clone(), usage.line);
                    let context =
                        model::cite_context(&usage.snippet, cite_key.as_deref().unwrap_or(""));
                    let snippet = usage.snippet.trim().to_string();
                    let detail = details.get(ix).cloned().unwrap_or_default();
                    let place = match detail.page {
                        Some(page) => format!(
                            "{}:{} · {}",
                            usage.path,
                            usage.line,
                            t!("p. {page}", page = page)
                        ),
                        None => format!("{}:{}", usage.path, usage.line),
                    };
                    let why = detail.reason.and_then(|(role, body)| {
                        let label = uses::role_label(&role)?;
                        let (fill, ink) = match role.as_str() {
                            "supporting" => (palette.success_soft, palette.success),
                            "counterexample" => (palette.warning_soft, palette.warning),
                            _ => (palette.hover, palette.text),
                        };
                        Some(
                            div()
                                .flex()
                                .items_baseline()
                                .gap(px(6.))
                                .min_w_0()
                                .child(
                                    div()
                                        .flex_none()
                                        .px(px(6.))
                                        .rounded(px(4.))
                                        .bg(fill)
                                        .text_color(ink)
                                        .text_role(TextRole::Micro, cx)
                                        .child(label),
                                )
                                .when(!body.is_empty(), |why| {
                                    why.child(
                                        div()
                                            .min_w_0()
                                            .truncate()
                                            .text_role(TextRole::Caption, cx)
                                            .text_color(palette.text_secondary)
                                            .child(body),
                                    )
                                }),
                        )
                    });
                    list = list.child(
                        track_pointer(div().id(id), pointer)
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .px(px(8.))
                            .py(px(6.))
                            .rounded(px(6.))
                            .bg(mix(
                                Hsla::transparent_black(),
                                palette.hover,
                                interaction.hover,
                            ))
                            .cursor_pointer()
                            .tooltip(move |_, cx| {
                                lattice_ui::components::LatticeTooltip::view(
                                    snippet.clone(),
                                    None,
                                    cx,
                                )
                            })
                            .on_click(move |_, _, cx| {
                                open_view
                                    .update(cx, |_, cx| {
                                        cx.emit(PapersEvent::Open {
                                            path: path.clone(),
                                            line: Some(line),
                                        })
                                    })
                                    .ok();
                            })
                            .child(
                                div()
                                    .truncate()
                                    .font_family(editor_font.clone())
                                    .text_size(px(11.))
                                    .line_height(px(14.))
                                    .text_color(palette.text_secondary)
                                    .child(place),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .font_family(reading_font.clone())
                                    .text_role(TextRole::Caption, cx)
                                    .text_color(palette.text)
                                    .child(context),
                            )
                            .children(why),
                    );
                }
                uses = uses.child(list);
            }
            body = body.child(uses);
        }
        if let Some(paragraphs) = abstract_text {
            body = body.child(section(t!("Abstract"), None, cx).children(
                paragraphs.into_iter().map(|paragraph| {
                    div()
                        .font_family(reading_font.clone())
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.text)
                        .child(paragraph)
                }),
            ));
        }

        // The record: a label column wide enough for the longest label, the
        // values wrapping under themselves.
        let record_row = |label: &'static str, value: AnyElement, cx: &Context<Self>| {
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
        let mut record = section(t!("Record"), None, cx);
        let mut rows = div().flex().flex_col().gap(px(4.));
        if let Some(key) = cite_key.clone() {
            rows = rows.child(record_row(
                t!("Key"),
                div()
                    .font_family(editor_font.clone())
                    .text_size(px(11.))
                    .text_color(palette.text)
                    .child(key)
                    .into_any_element(),
                cx,
            ));
        }
        if model::source_label(paper).is_some_and(|label| label.starts_with("arXiv ")) {
            rows = rows.child(record_row(
                "arXiv",
                div()
                    .child(paper.arxiv_id.trim().to_string())
                    .into_any_element(),
                cx,
            ));
        }
        if let Some(doi) = paper.doi.clone().filter(|doi| !doi.is_empty()) {
            rows = rows.child(record_row("DOI", div().child(doi).into_any_element(), cx));
        }
        if let Some(health) = paper.citation_health.as_ref() {
            let value = match model::health_parts(Some(health)) {
                Some((kind, detail)) => {
                    let ink = if health.kind == "retracted" {
                        mix(palette.danger, palette.text, 0.2)
                    } else {
                        mix(palette.warning, palette.text, 0.22)
                    };
                    let mut flag = div()
                        .id("paper-inspector-flag")
                        .flex()
                        .items_center()
                        .gap(px(2.))
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(ink)
                        .child(kind);
                    if let Some(link) = health
                        .link
                        .clone()
                        .filter(|link| model::openable_link(link))
                    {
                        flag = flag
                            .px(px(2.))
                            .mx(px(-2.))
                            .rounded(px(4.))
                            .cursor_pointer()
                            .hover(|style| style.bg(palette.hover))
                            .on_click(move |_, _, cx| model::open_link(&link, cx))
                            .child(Icon::ARROW_UP_RIGHT.element(ICON_SMALL, ink));
                    }
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_x(px(6.))
                        .child(flag)
                        .when(!detail.is_empty(), |value| value.child(detail))
                        .into_any_element()
                }
                None if health.kind == "unavailable" => {
                    div().child(t!("Unavailable right now")).into_any_element()
                }
                None => div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(Icon::CHECK.element(ICON_SMALL, palette.success))
                    .child(t!(
                        "No notices, checked {date}",
                        date = health.checked_at.get(..10).unwrap_or(&health.checked_at)
                    ))
                    .into_any_element(),
            };
            let title = model::health_title(Some(health)).unwrap_or_default();
            let value = div()
                .id("paper-inspector-health")
                .tooltip(move |_, cx| {
                    lattice_ui::components::LatticeTooltip::view(title.clone(), None, cx)
                })
                .child(value)
                .into_any_element();
            rows = rows.child(record_row(t!("Crossref"), value, cx));
        }
        let full_text = match (paper.has_full_text, paper.has_blog) {
            (true, true) => t!("Saved, with its overview"),
            (true, false) => t!("Saved"),
            (false, true) => t!("Overview only"),
            _ if state == model::ReadingState::Downloadable => t!("Not downloaded"),
            _ => t!("Citation only"),
        };
        rows = rows.child(record_row(
            t!("Full text"),
            div().child(full_text).into_any_element(),
            cx,
        ));
        record = record.child(rows);
        body = body.child(record);
        body.into_any_element()
    }
}
