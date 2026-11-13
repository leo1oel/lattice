//! Add reference, from a `.bib` file's visual form (`bib-entry-dialog.tsx`):
//! a lookup first (a DOI, an arXiv id, a link or a title, resolved by
//! lattice-core's `resolve_citation_query`), its candidates when it found
//! several, or the fields entered by hand; the entry as a reference list
//! will print it above the fields, and Save entry appends it to the file.

use gpui::{
    AnyElement, AppContext as _, ClickEvent, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, WeakEntity, Window, anchored, deferred, div, prelude::FluentBuilder as _,
    px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use lattice_core::{bib_document::bib_text_to_plain, models::ResolvedCitation};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, MenuAction, MenuPopover},
    interaction::mix,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{BibEditor, model::Draft};
use crate::search::sheet::SheetFrame;

/// The types the form offers, as BibTeX writes them.
const TYPES: [&str; 4] = ["article", "inproceedings", "book", "misc"];

fn type_label(kind: &str) -> &'static str {
    match kind {
        "article" => t!("Article"),
        "inproceedings" => t!("In proceedings"),
        "book" => t!("Book"),
        _ => t!("Misc"),
    }
}

/// The text fields, in the order a record fills them.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Title,
    Author,
    Year,
    Venue,
    Publisher,
    Doi,
    Url,
    Key,
}

const FIELDS: [Field; 8] = [
    Field::Title,
    Field::Author,
    Field::Year,
    Field::Venue,
    Field::Publisher,
    Field::Doi,
    Field::Url,
    Field::Key,
];

pub struct AddReference {
    editor: WeakEntity<BibEditor>,
    lookup: Entity<InputState>,
    inputs: Vec<(Field, Entity<InputState>)>,
    entry_type: String,
    show_fields: bool,
    resolving: bool,
    candidates: Vec<ResolvedCitation>,
    chosen: usize,
    extra: Vec<(String, String)>,
    error: Option<String>,
    generation: u64,
    _lookup: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl AddReference {
    pub fn new(editor: WeakEntity<BibEditor>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let lookup = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(t!("10.1038/… or arXiv:1706.03762 or paper title"))
        });
        let mut subscriptions =
            vec![
                cx.subscribe_in(&lookup, window, |this, _, event, window, cx| match event {
                    InputEvent::PressEnter { .. } => this.resolve(window, cx),
                    InputEvent::Change => this.abandon(cx),
                    _ => {}
                }),
            ];
        let inputs: Vec<(Field, Entity<InputState>)> = FIELDS
            .iter()
            .map(|field| {
                let placeholder = match field {
                    Field::Author => t!("Last, First and Last, First"),
                    Field::Venue => t!("NeurIPS, CVPR, Nature, …"),
                    Field::Doi => "10.…",
                    Field::Key => "author2024title",
                    _ => "",
                };
                (
                    *field,
                    cx.new(|cx| InputState::new(window, cx).placeholder(placeholder)),
                )
            })
            .collect();
        for (_, input) in &inputs {
            subscriptions.push(cx.observe(input, |_, _, cx| cx.notify()));
        }
        Self {
            editor,
            lookup,
            inputs,
            entry_type: "article".into(),
            show_fields: false,
            resolving: false,
            candidates: Vec::new(),
            chosen: 0,
            extra: Vec::new(),
            error: None,
            generation: 0,
            _lookup: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn focus_lookup(&self, window: &mut Window, cx: &mut gpui::App) {
        self.lookup.update(cx, |input, cx| input.focus(window, cx));
    }

    fn input(&self, field: Field) -> &Entity<InputState> {
        &self
            .inputs
            .iter()
            .find(|(each, _)| *each == field)
            .expect("every field has a box")
            .1
    }

    fn value(&self, field: Field, cx: &gpui::App) -> String {
        self.input(field).read(cx).value().to_string()
    }

    fn draft(&self, cx: &gpui::App) -> Draft {
        let venue = self.value(Field::Venue, cx);
        Draft {
            entry_type: self.entry_type.clone(),
            key: self.value(Field::Key, cx),
            title: self.value(Field::Title, cx),
            author: self.value(Field::Author, cx),
            year: self.value(Field::Year, cx),
            journal: if self.entry_type == "article" {
                venue.clone()
            } else {
                String::new()
            },
            booktitle: if self.entry_type == "article" {
                String::new()
            } else {
                venue
            },
            publisher: self.value(Field::Publisher, cx),
            url: self.value(Field::Url, cx),
            doi: self.value(Field::Doi, cx),
            extra: self.extra.clone(),
        }
    }

    /// A new query abandons the lookup in flight and what it offered.
    fn abandon(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.resolving = false;
        self.candidates.clear();
        self.error = None;
        cx.notify();
    }

    fn resolve(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let query = self.lookup.read(cx).value().trim().to_string();
        if query.is_empty() || self.resolving {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.resolving = true;
        self.error = None;
        let lookup = cx
            .background_spawn(async move { lattice_core::project::resolve_citation_query(&query) });
        self._lookup = Some(cx.spawn_in(window, async move |this, cx| {
            let resolved = lookup.await;
            this.update_in(cx, |this, window, cx| {
                if this.generation != generation {
                    return;
                }
                this.resolving = false;
                match resolved {
                    Ok(resolved) if !resolved.candidates.is_empty() => {
                        this.candidates = resolved.candidates;
                        this.chosen = 0;
                    }
                    Ok(resolved) => this.apply_with_window(resolved, window, cx),
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Fill the fields from a record.
    fn apply_with_window(
        &mut self,
        record: ResolvedCitation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let article = record.entry_type == "article"
            || (!TYPES.contains(&record.entry_type.as_str()) && !record.journal.is_empty());
        self.entry_type = if TYPES.contains(&record.entry_type.as_str()) {
            record.entry_type.clone()
        } else if article {
            "article".into()
        } else if !record.booktitle.is_empty() {
            "inproceedings".into()
        } else if !record.publisher.is_empty() {
            "book".into()
        } else {
            "misc".into()
        };
        let venue = if self.entry_type == "article" {
            record.journal.clone()
        } else {
            record.booktitle.clone()
        };
        for (field, value) in [
            (Field::Title, record.title.clone()),
            (Field::Author, record.author.clone()),
            (Field::Year, record.year.clone()),
            (Field::Venue, venue),
            (Field::Publisher, record.publisher.clone()),
            (Field::Doi, record.doi.clone()),
            (Field::Url, record.url.clone()),
            (Field::Key, record.key.clone()),
        ] {
            self.input(field)
                .clone()
                .update(cx, |input, cx| input.set_value(value, window, cx));
        }
        self.extra = record.extra_fields.into_iter().collect();
        self.candidates.clear();
        self.show_fields = true;
        cx.notify();
    }

    /// Entering by hand declines every candidate; what the query already
    /// says about the work fills the fields still empty.
    fn enter_manually(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.abandon(cx);
        let query = self.lookup.read(cx).value().trim().to_string();
        let lower = query.to_lowercase();
        let field = if lower.starts_with("10.")
            || lower.starts_with("doi:")
            || lower.contains("doi.org/")
        {
            Some((
                Field::Doi,
                query.trim_start_matches("doi:").trim().to_string(),
            ))
        } else if lower.starts_with("http://") || lower.starts_with("https://") {
            Some((Field::Url, query.clone()))
        } else if lower.starts_with("arxiv:") {
            Some((
                Field::Url,
                format!("https://arxiv.org/abs/{}", query[6..].trim()),
            ))
        } else {
            (!query.is_empty()).then(|| (Field::Title, query.clone()))
        };
        if let Some((field, value)) = field
            && self.value(field, cx).trim().is_empty()
        {
            self.input(field)
                .clone()
                .update(cx, |input, cx| input.set_value(value, window, cx));
        }
        self.show_fields = true;
        self.input(Field::Title)
            .clone()
            .update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let draft = self.draft(cx);
        let entry = draft.format();
        let key = draft.key();
        let saved = self
            .editor
            .update(cx, |editor, cx| editor.add_entry(&entry, &key, window, cx));
        match saved {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                self.error = Some(error);
                cx.notify();
            }
            Err(_) => {}
        }
    }

    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.editor
            .update(cx, |editor, cx| editor.close_add(window, cx))
            .ok();
    }

    fn field(&self, field: Field, label: &'static str, cx: &Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w(px(140.))
            .gap(px(4.))
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text_secondary)
                    .child(label),
            )
            .child(
                div()
                    .h(px(30.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .rounded(px(6.))
                    .bg(palette.input)
                    .border_1()
                    .border_color(palette.field_border)
                    .child(
                        Input::new(self.input(field))
                            .appearance(false)
                            .bordered(false)
                            .px_0(),
                    ),
            )
            .into_any_element()
    }

    /// The entry as a reference list will print it, its key beside it.
    fn typeset(&self, cx: &Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let draft = self.draft(cx);
        let unfilled = palette.text_secondary.opacity(0.6);
        let title = bib_text_to_plain(draft.title.trim());
        let authors = draft.author.trim().replace(" and ", ", ");
        let venue = if draft.entry_type == "book" {
            bib_text_to_plain(&draft.publisher)
        } else {
            bib_text_to_plain(if draft.entry_type == "article" {
                &draft.journal
            } else {
                &draft.booktitle
            })
        };
        let year = draft.year.trim().to_string();
        let doi = draft.doi();
        let mut tail = vec![venue.clone(), year.clone()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        if !doi.is_empty() {
            tail = if tail.is_empty() {
                format!("doi:{doi}")
            } else {
                format!("{tail} doi:{doi}")
            };
        }
        div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .p(px(12.))
            .rounded(px(8.))
            .bg(palette.text.opacity(0.03))
            .when(!title.is_empty(), |card| {
                card.child(
                    div()
                        .font_family(cx.lattice().fonts.editor.clone())
                        .text_role(TextRole::Micro, cx)
                        .text_color(palette.text_secondary)
                        .child(draft.key()),
                )
            })
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(if authors.is_empty() {
                        unfilled
                    } else {
                        palette.text_secondary
                    })
                    .child(if authors.is_empty() {
                        SharedString::from(t!("Author"))
                    } else {
                        authors.into()
                    }),
            )
            .child(
                div()
                    .text_role(TextRole::Typeset, cx)
                    .text_color(if title.is_empty() {
                        unfilled
                    } else {
                        palette.text
                    })
                    .child(if title.is_empty() {
                        SharedString::from(t!("Title"))
                    } else {
                        title.into()
                    }),
            )
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .italic()
                    .text_color(if tail.is_empty() {
                        unfilled
                    } else {
                        palette.text_secondary
                    })
                    .child(if tail.is_empty() {
                        SharedString::from(if draft.entry_type == "book" {
                            t!("Publisher")
                        } else {
                            t!("Venue")
                        })
                    } else {
                        tail.into()
                    }),
            )
            .into_any_element()
    }

    fn candidates(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let mut list = div().flex().flex_col().gap(px(4.));
        for (at, candidate) in self.candidates.iter().enumerate() {
            let chosen = at == self.chosen;
            let byline = [candidate.author.as_str(), candidate.year.as_str()]
                .iter()
                .filter(|part| !part.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" · ");
            list = list.child(
                div()
                    .id(("bib-candidate", at))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .p(px(10.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(if chosen { palette.accent } else { palette.line })
                    .cursor_pointer()
                    .hover(|style| style.bg(palette.hover))
                    .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                        this.chosen = at;
                        if event.click_count() == 2 {
                            let record = this.candidates[at].clone();
                            this.apply_with_window(record, window, cx);
                        }
                        cx.notify();
                    }))
                    .child(
                        div()
                            .text_role(TextRole::Typeset, cx)
                            .text_color(palette.text)
                            .child(bib_text_to_plain(&candidate.title)),
                    )
                    .child(
                        div()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(byline),
                    ),
            );
        }
        list.into_any_element()
    }
}

impl Render for AddReference {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let resolving = self.resolving;
        let has_query = !self.lookup.read(cx).value().trim().is_empty();
        let mut body: Vec<AnyElement> = vec![
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .h(px(32.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .rounded(px(8.))
                        .bg(palette.input)
                        .border_1()
                        .border_color(palette.field_border)
                        .child(
                            Input::new(&self.lookup)
                                .appearance(false)
                                .bordered(false)
                                .px_0(),
                        ),
                )
                .child(
                    Button::new(
                        "bib-resolve",
                        if resolving {
                            t!("Resolving…")
                        } else {
                            t!("Resolve")
                        },
                    )
                    .map(|button| {
                        if self.show_fields || !self.candidates.is_empty() {
                            button
                        } else {
                            button.primary()
                        }
                    })
                    .disabled(!has_query || resolving)
                    .on_click(
                        cx.listener(|this, _: &ClickEvent, window, cx| this.resolve(window, cx)),
                    ),
                )
                .into_any_element(),
        ];
        if !self.show_fields {
            body.push(
                div()
                    .child(
                        Button::new("bib-manual", t!("Enter manually"))
                            .compact()
                            .ghost()
                            .icon(Icon::PEN_LINE)
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                this.enter_manually(window, cx)
                            })),
                    )
                    .into_any_element(),
            );
        }
        if let Some(error) = self.error.clone() {
            body.push(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(mix(palette.danger, palette.text, 0.2))
                    .child(error)
                    .into_any_element(),
            );
        }
        if !self.candidates.is_empty() {
            body.push(self.candidates(cx));
        }
        if self.show_fields && self.candidates.is_empty() {
            let view = cx.entity().downgrade();
            let kind = self.entry_type.clone();
            let types_menu = move |menu: lattice_ui::components::Menu| {
                TYPES.iter().fold(menu, |menu, choice| {
                    let view = view.clone();
                    let choice = *choice;
                    menu.item(
                        MenuAction::new(type_label(choice), move |_, cx| {
                            view.update(cx, |this, cx| {
                                this.entry_type = choice.into();
                                cx.notify();
                            })
                            .ok();
                        })
                        .checked(choice == kind),
                    )
                })
            };
            let venue_label = if self.entry_type == "book" {
                t!("Publisher")
            } else {
                t!("Venue")
            };
            let venue_field = if self.entry_type == "book" {
                Field::Publisher
            } else {
                Field::Venue
            };
            body.push(self.typeset(cx));
            body.push(
                div()
                    .id("bib-entry-fields")
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .overflow_y_scroll()
                    .child(self.field(Field::Title, t!("Title"), cx))
                    .child(self.field(Field::Author, t!("Author"), cx))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(10.))
                            .child(self.field(Field::Year, t!("Year"), cx))
                            .child(self.field(venue_field, venue_label, cx)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(10.))
                            .child(self.field(Field::Doi, "DOI", cx))
                            .child(self.field(Field::Url, "URL", cx)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_end()
                            .gap(px(10.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .child(
                                        div()
                                            .text_role(TextRole::Caption, cx)
                                            .font_weight(FONT_WEIGHT_MEDIUM)
                                            .text_color(palette.text_secondary)
                                            .child(t!("Type")),
                                    )
                                    .child(MenuPopover::new(
                                        "bib-entry-type",
                                        Button::new(
                                            "bib-entry-type-button",
                                            type_label(&self.entry_type),
                                        )
                                        .icon(Icon::CHEVRON_DOWN)
                                        .tooltip(t!("Entry type")),
                                        types_menu,
                                    )),
                            )
                            .child(self.field(Field::Key, t!("Citation key"), cx)),
                    )
                    .into_any_element(),
            );
        }
        let draft = self.draft(cx);
        let complete = !draft.title.trim().is_empty()
            && !draft.author.trim().is_empty()
            && !draft.year.trim().is_empty();
        let mut actions: Vec<AnyElement> = vec![
            Button::new("bib-add-cancel", t!("Cancel"))
                .ghost()
                .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.close(window, cx)))
                .into_any_element(),
        ];
        if !self.candidates.is_empty() {
            actions.push(
                Button::new("bib-use-record", t!("Use this record"))
                    .primary()
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        let record =
                            this.candidates[this.chosen.min(this.candidates.len() - 1)].clone();
                        this.apply_with_window(record, window, cx);
                    }))
                    .into_any_element(),
            );
        } else if self.show_fields {
            actions.push(
                Button::new("bib-save-entry", t!("Save entry"))
                    .primary()
                    .disabled(!complete || resolving)
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.save(window, cx)))
                    .into_any_element(),
            );
        }
        let view = cx.entity().downgrade();
        let viewport = window.viewport_size();
        let sheet = SheetFrame {
            id: "add-reference",
            icon: Icon::BOOK_MARKED,
            title: t!("Add bibliography entry"),
            body,
            actions,
            scrim_closes: !self.show_fields,
        }
        .render(window, cx, move |window, cx| {
            view.update(cx, |this, cx| this.close(window, cx)).ok();
        });
        // Over the whole window, as the project's other sheets are, though
        // it belongs to this editor.
        deferred(
            anchored().position(gpui::point(px(0.), px(0.))).child(
                div()
                    .relative()
                    .w(viewport.width)
                    .h(viewport.height)
                    .child(sheet),
            ),
        )
        .with_priority(1)
    }
}
