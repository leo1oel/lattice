//! The reference in front (`bib-entry-detail.tsx`): its type, key, links and
//! where the manuscript cites it, set as a citation card (its title, byline
//! and venue as the paper would carry them), then a form whose every field
//! edits the file in place. A value is written back when its box loses
//! focus, or on Enter (⌘Enter in a long field); a value that cannot be
//! written keeps its box and says why.

use gpui::{
    AnyElement, AppContext as _, ClickEvent, Context, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement as _, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use lattice_core::bib_document::{self, BibValueStyle};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, IconButton, MenuAction, MenuPopover},
    interaction::mix,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{
    BibEditor,
    model::{self, ENTRY_TYPES, PaperState},
};

/// A field's box: one line, or one that wraps and grows.
pub(super) enum FieldBox {
    Line(Entity<InputState>),
    Long(Entity<TextareaState>),
}

impl FieldBox {
    pub(super) fn value(&self, cx: &gpui::App) -> String {
        match self {
            FieldBox::Line(input) => input.read(cx).value().to_string(),
            FieldBox::Long(input) => input.read(cx).value().to_string(),
        }
    }

    fn focused(&self, window: &Window, cx: &gpui::App) -> bool {
        match self {
            FieldBox::Line(input) => input.read(cx).focus_handle(cx).is_focused(window),
            FieldBox::Long(input) => input.read(cx).focus_handle(cx).is_focused(window),
        }
    }

    fn focus_handle(&self, cx: &gpui::App) -> gpui::FocusHandle {
        match self {
            FieldBox::Line(input) => input.read(cx).focus_handle(cx),
            FieldBox::Long(input) => input.read(cx).focus_handle(cx),
        }
    }

    fn set_value(&self, text: String, window: &mut Window, cx: &mut gpui::App) {
        match self {
            FieldBox::Line(input) => {
                input.update(cx, |input, cx| input.set_value(text, window, cx))
            }
            FieldBox::Long(input) => {
                input.update(cx, |input, cx| input.set_value(text, window, cx))
            }
        }
    }
}

pub(super) struct FieldRow {
    pub(super) name: String,
    /// Its place among the entry's fields as built: of two fields with one
    /// name, the one an edit finds.
    pub(super) index: usize,
    pub(super) style: BibValueStyle,
    pub(super) input: FieldBox,
    pub(super) invalid: bool,
}

pub(in crate::papers) struct Detail {
    /// The reference it was built for, and its text then.
    pub(super) key: String,
    signature: String,
    key_input: Entity<InputState>,
    pub(super) key_error: Option<String>,
    pub(super) fields: Vec<FieldRow>,
    pub(super) new_name: Entity<InputState>,
    pub(super) new_value: Entity<InputState>,
    pub(super) new_error: Option<String>,
    scroll: ScrollHandle,
    _subscriptions: Vec<Subscription>,
}

impl BibEditor {
    /// The form's boxes as drawn, each field's name and what its box holds,
    /// for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn form_fields(&self, cx: &gpui::App) -> Vec<(String, String)> {
        self.detail
            .iter()
            .flat_map(|detail| &detail.fields)
            .map(|field| (field.name.clone(), field.input.value(cx)))
            .collect()
    }

    /// The focus of the form's box for the field `name`, for a scenario to
    /// type into it.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn field_focus(&self, name: &str, cx: &gpui::App) -> Option<gpui::FocusHandle> {
        let detail = self.detail.as_ref()?;
        let field = detail.fields.iter().find(|field| field.name == name)?;
        Some(field.input.focus_handle(cx))
    }

    /// The form for the reference in front, built again when another comes
    /// to the front or its text changed under it. Rebuilt for the same
    /// reference (an edit, a rename, a field added or removed), it keeps each
    /// box by its field's name, so the box the writer is in keeps its focus
    /// and what they typed; the others show the file as it is now.
    pub(super) fn ensure_detail(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.selected_row().cloned() else {
            self.detail = None;
            return;
        };
        let signature = self
            .text
            .get(row.entry.from..row.entry.to)
            .unwrap_or("")
            .to_string();
        if let Some(detail) = &self.detail
            && detail.key == row.entry.key
            && detail.signature == signature
        {
            return;
        }
        let previous = self
            .detail
            .take()
            .filter(|detail| detail.key == row.entry.key);
        let (key_input, mut kept, new_name, new_value, scroll) = match previous {
            Some(previous) => {
                let input = previous.key_input.clone();
                if !input.read(cx).focus_handle(cx).is_focused(window) {
                    input.update(cx, |input, cx| {
                        input.set_value(row.entry.key.clone(), window, cx)
                    });
                }
                let boxes: Vec<(String, FieldBox)> = previous
                    .fields
                    .into_iter()
                    .map(|field| (field.name, field.input))
                    .collect();
                (
                    input,
                    boxes,
                    previous.new_name,
                    previous.new_value,
                    previous.scroll,
                )
            }
            None => (
                cx.new(|cx| {
                    let mut input = InputState::new(window, cx);
                    input.set_value(row.entry.key.clone(), window, cx);
                    input
                }),
                Vec::new(),
                cx.new(|cx| InputState::new(window, cx).placeholder(t!("Field"))),
                cx.new(|cx| InputState::new(window, cx).placeholder(t!("Value"))),
                ScrollHandle::default(),
            ),
        };
        let mut subscriptions = Vec::new();
        subscriptions.push(cx.subscribe_in(
            &key_input,
            window,
            |this, input, event, window, cx| {
                if matches!(event, InputEvent::Blur | InputEvent::PressEnter { .. }) {
                    let value = input.read(cx).value().to_string();
                    this.rename_key(value, cx);
                    if matches!(event, InputEvent::PressEnter { .. }) {
                        window.focus(&this.focus, cx);
                    }
                }
            },
        ));
        let mut fields = Vec::new();
        for (index, field) in row.entry.fields.iter().enumerate() {
            let raw = self
                .text
                .get(field.value_from..field.value_to)
                .unwrap_or("");
            let (text, style) = bib_document::editable_value(raw);
            let reused = kept
                .iter()
                .position(|(name, _)| *name == field.name)
                .map(|at| kept.remove(at).1);
            let input = match reused {
                Some(input) => {
                    if !input.focused(window, cx) && input.value(cx) != text {
                        input.set_value(text, window, cx);
                    }
                    input
                }
                None if model::long_field(&field.name, &text) => FieldBox::Long(cx.new(|cx| {
                    let mut input = TextareaState::new(window, cx).auto_grow(1, 12);
                    input.set_value(text, window, cx);
                    input
                })),
                None => FieldBox::Line(cx.new(|cx| {
                    let mut input = InputState::new(window, cx);
                    input.set_value(text, window, cx);
                    input
                })),
            };
            let at = fields.len();
            // Enter leaves a one-line box; a long one takes ⌘Enter.
            let line = matches!(input, FieldBox::Line(_));
            let on_event = move |this: &mut Self,
                                 event: &InputEvent,
                                 window: &mut Window,
                                 cx: &mut Context<Self>| {
                match event {
                    InputEvent::Blur => this.commit_field(at, cx),
                    InputEvent::PressEnter { secondary, .. } if *secondary || line => {
                        this.commit_field(at, cx);
                        window.focus(&this.focus, cx);
                    }
                    _ => {}
                }
            };
            subscriptions.push(match &input {
                FieldBox::Line(input) => {
                    cx.subscribe_in(input, window, move |this, _, event, window, cx| {
                        on_event(this, event, window, cx)
                    })
                }
                FieldBox::Long(input) => {
                    cx.subscribe_in(input, window, move |this, _, event, window, cx| {
                        on_event(this, event, window, cx)
                    })
                }
            });
            fields.push(FieldRow {
                name: field.name.clone(),
                index,
                style,
                input,
                invalid: false,
            });
        }
        for input in [&new_name, &new_value] {
            subscriptions.push(
                cx.subscribe_in(input, window, |this, _, event, window, cx| match event {
                    InputEvent::PressEnter { .. } => this.add_field(window, cx),
                    InputEvent::Change => {
                        if let Some(detail) = &mut this.detail {
                            detail.new_error = None;
                        }
                        cx.notify();
                    }
                    _ => {}
                }),
            );
        }
        self.detail = Some(Detail {
            key: row.entry.key.clone(),
            signature,
            key_input,
            key_error: None,
            fields,
            new_name,
            new_value,
            new_error: None,
            scroll,
            _subscriptions: subscriptions,
        });
    }

    /// The reference in front, drawn; `back` gives a pane too narrow for
    /// both the way back to the list.
    pub(super) fn render_detail(&self, back: bool, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let (Some(row), Some(detail)) = (self.selected_row().cloned(), self.detail.as_ref()) else {
            return div().into_any_element();
        };
        let entry = &row.entry;
        let summary = &row.summary;
        let caption = |text: String, ink: gpui::Hsla, cx: &Context<Self>| {
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(ink)
                .child(text)
        };
        let error_ink = mix(palette.danger, palette.text, 0.2);
        let view = cx.entity().downgrade();
        let kind = entry.kind.clone();
        let types_menu = move |menu: lattice_ui::components::Menu| {
            // An entry of a type the menu does not offer keeps it, listed first.
            let mut types: Vec<String> = ENTRY_TYPES.iter().map(|kind| kind.to_string()).collect();
            if !types.contains(&kind) {
                types.insert(0, kind.clone());
            }
            types.into_iter().fold(menu, |menu, choice| {
                let view = view.clone();
                let checked = choice == kind;
                menu.item(
                    MenuAction::new(format!("@{choice}"), move |_, cx| {
                        let choice = choice.clone();
                        view.update(cx, |this, cx| this.change_type(choice, cx))
                            .ok();
                    })
                    .checked(checked),
                )
            })
        };
        let copy_key = entry.key.clone();
        let identity = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            .child(MenuPopover::new(
                "bib-type",
                Button::new("bib-type-button", format!("@{}", entry.kind))
                    .compact()
                    .ghost()
                    .tooltip(t!("Entry type")),
                types_menu,
            ))
            .child(
                div()
                    .flex_1()
                    .min_w(px(120.))
                    .h(px(28.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .rounded(px(6.))
                    .bg(palette.input)
                    .border_1()
                    .border_color(if detail.key_error.is_some() {
                        palette.danger
                    } else {
                        palette.field_border
                    })
                    .font_family(editor_font.clone())
                    .child(
                        Input::new(&detail.key_input)
                            .appearance(false)
                            .bordered(false)
                            .px_0(),
                    ),
            )
            .child(
                IconButton::new("bib-copy-key", Icon::COPY)
                    .tooltip(t!("Copy citation key"))
                    .on_click(move |_, _, cx| {
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy_key.clone()))
                    }),
            );
        let doi_url = (!summary.doi.is_empty() && summary.doi.starts_with("10."))
            .then(|| format!("https://doi.org/{}", summary.doi));
        let arxiv_url = (!summary.arxiv_id.is_empty())
            .then(|| format!("https://arxiv.org/abs/{}", summary.arxiv_id));
        let web_url = (summary.url.starts_with("http://") || summary.url.starts_with("https://"))
            .then(|| summary.url.clone())
            .filter(|url| Some(url) != doi_url.as_ref() && Some(url) != arxiv_url.as_ref());
        let paper_state = self.papers().map(|papers| {
            let library = papers.read(cx);
            model::entry_paper(
                &library.papers,
                &entry.key,
                summary,
                &library.fetching.states,
            )
            .1
        });
        let link = |id: &'static str, label: SharedString, url: String| {
            Button::new(id, label)
                .compact()
                .ghost()
                .icon(Icon::EXTERNAL_LINK)
                .tooltip(url.clone())
                .on_click(move |_, _, cx| crate::papers::model::open_link(&url, cx))
        };
        let open_key = entry.key.clone();
        let (path, line) = (self.path.clone(), entry.line as u32);
        let (delete_key, delete_index) = (entry.key.clone(), row.index);
        let mut actions = div().flex().flex_wrap().gap(px(4.)).mt(px(8.));
        actions = match paper_state.unwrap_or(PaperState::None) {
            PaperState::None => actions,
            state => {
                let (icon, label) = match state {
                    PaperState::Open => (Icon::BOOK_OPEN, t!("Open paper")),
                    PaperState::Download => (Icon::FILE_DOWN, t!("Download and open")),
                    _ => (Icon::LOADER, t!("Downloading…")),
                };
                actions.child(
                    Button::new("bib-open-paper", label)
                        .compact()
                        .icon(icon)
                        .disabled(state == PaperState::Downloading)
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.open_paper(&open_key, window, cx)
                        })),
                )
            }
        };
        actions = actions
            .when_some(doi_url, |actions, url| {
                actions.child(link("bib-doi", "DOI".into(), url))
            })
            .when_some(arxiv_url, |actions, url| {
                actions.child(link("bib-arxiv", "arXiv".into(), url))
            })
            .when_some(web_url, |actions, url| {
                actions.child(link("bib-web", t!("Link").into(), url))
            })
            .child(
                Button::new("bib-show-source", t!("Show in source"))
                    .compact()
                    .ghost()
                    .icon(Icon::CODE_XML)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.open_line(path.clone(), line, cx)
                    })),
            )
            .child(
                Button::new("bib-delete", t!("Delete"))
                    .compact()
                    .ghost()
                    .icon(Icon::TRASH)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.delete(delete_key.clone(), delete_index, cx)
                    })),
            );
        let no_paper = (paper_state == Some(PaperState::None)).then(|| {
            caption(
                t!("No full text to download").into(),
                palette.text_secondary,
                cx,
            )
        });
        let venue_line = [summary.venue.as_str(), summary.year.as_str()]
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(", ");
        let header = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(identity)
            .when_some(detail.key_error.clone(), |header, error| {
                header.child(caption(error, error_ink, cx))
            })
            .child(
                div()
                    .mt(px(12.))
                    .text_role(TextRole::Title, cx)
                    .font_family(cx.lattice().fonts.ui.clone())
                    .font_weight(gpui::FontWeight::NORMAL)
                    .text_color(palette.text)
                    .child(if summary.title.is_empty() {
                        SharedString::from(t!("Untitled"))
                    } else {
                        summary.title.clone().into()
                    }),
            )
            .when(!summary.authors.is_empty(), |header| {
                header.child(
                    div()
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.text_secondary)
                        .child(summary.authors.clone()),
                )
            })
            .when(!venue_line.is_empty(), |header| {
                header.child(
                    div()
                        .text_role(TextRole::Body, cx)
                        .italic()
                        .text_color(palette.text_secondary)
                        .child(venue_line),
                )
            })
            .child(actions)
            .children(no_paper);
        div()
            .id("bib-detail")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&detail.scroll)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .px(px(if back { 16. } else { 32. }))
                    .pt(px(if back { 16. } else { 24. }))
                    .pb(px(32.))
                    .when(back, |content| {
                        content.child(
                            div().mb(px(12.)).child(
                                Button::new("bib-back", t!("All references"))
                                    .compact()
                                    .ghost()
                                    .icon(Icon::ARROW_LEFT)
                                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                        this.detail_open = false;
                                        window.focus(&this.focus, cx);
                                        cx.notify();
                                    })),
                            ),
                        )
                    })
                    .child(header)
                    .child(self.usages_section(&entry.key, cx))
                    .child(self.fields_section(detail, cx)),
            )
            .into_any_element()
    }

    fn section_title(title: &'static str, cx: &Context<Self>) -> AnyElement {
        div()
            .mt(px(24.))
            .mb(px(8.))
            .text_role(TextRole::Caption, cx)
            .font_weight(FONT_WEIGHT_MEDIUM)
            .text_color(cx.palette().text_secondary)
            .child(title)
            .into_any_element()
    }

    fn usages_section(&self, key: &str, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let mut section = div()
            .flex()
            .flex_col()
            .child(Self::section_title(t!("Cited in"), cx));
        let quiet = |text: String, ink: gpui::Hsla, cx: &Context<Self>| {
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(ink)
                .child(text)
        };
        let Some(usages) = &self.usages else {
            return section
                .child(quiet(
                    t!("Looking through the manuscript…").into(),
                    palette.text_secondary,
                    cx,
                ))
                .into_any_element();
        };
        let list = usages.of(key);
        if list.is_empty() {
            let text = if usages.everything {
                t!(
                    "Not cited by key, but {nociteAll} includes every entry",
                    nociteAll = "\\nocite{*}"
                )
            } else {
                t!("Not cited in any .tex file").to_string()
            };
            return section
                .child(quiet(text, mix(palette.warning, palette.text, 0.3), cx))
                .into_any_element();
        }
        for (at, usage) in list.iter().enumerate() {
            let (path, line) = (usage.path.clone(), usage.line);
            section = section.child(
                div()
                    .id(("bib-usage", at))
                    .flex()
                    .items_baseline()
                    .gap(px(10.))
                    .px(px(8.))
                    .py(px(6.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|style| style.bg(palette.hover))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.open_line(path.clone(), line, cx)
                    }))
                    .child(
                        div()
                            .flex_none()
                            .max_w(px(200.))
                            .truncate()
                            .px(px(4.))
                            .rounded(px(4.))
                            .bg(palette.hover)
                            .text_role(TextRole::Micro, cx)
                            .text_color(palette.text)
                            .child(format!("{}:{}", usage.path, usage.line)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .font_family(editor_font.clone())
                            .text_size(px(12.))
                            .line_height(px(18.))
                            .text_color(palette.text_secondary)
                            .child(usage.snippet.trim().to_string()),
                    ),
            );
        }
        section.into_any_element()
    }

    fn fields_section(&self, detail: &Detail, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let error_ink = mix(palette.danger, palette.text, 0.2);
        let mut card = div()
            .flex()
            .flex_col()
            .px(px(12.))
            .py(px(8.))
            .rounded(px(10.))
            .bg(palette.raised)
            .shadow(lattice_ui::elevation::Elevation::Raised.shadows(&palette));
        for (at, field) in detail.fields.iter().enumerate() {
            let name = field.name.clone();
            let value: AnyElement = match &field.input {
                FieldBox::Line(input) => Input::new(input)
                    .appearance(false)
                    .bordered(false)
                    .px_0()
                    .into_any_element(),
                FieldBox::Long(input) => Textarea::new(input)
                    .appearance(false)
                    .bordered(false)
                    .px_0()
                    .into_any_element(),
            };
            let invalid = field.invalid;
            card = card.child(
                div()
                    .flex()
                    .flex_col()
                    .when(at > 0, |row| row.border_t_1().border_color(palette.line))
                    .py(px(4.))
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex_none()
                                    .w(px(84.))
                                    .pt(px(5.))
                                    .truncate()
                                    .font_family(editor_font.clone())
                                    .text_role(TextRole::Caption, cx)
                                    .text_color(palette.text_secondary)
                                    .child(name.clone()),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .min_h(px(28.))
                                    .px(px(6.))
                                    .rounded(px(6.))
                                    .border_1()
                                    .border_color(if invalid {
                                        palette.danger
                                    } else {
                                        gpui::transparent_black()
                                    })
                                    .hover(|style| style.border_color(palette.field_border))
                                    .font_family(editor_font.clone())
                                    .child(value),
                            )
                            .child(
                                IconButton::new(("bib-remove-field", at), Icon::X)
                                    .tooltip(t!("Remove the {name} field", name = name))
                                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                        this.remove_field(at, cx)
                                    })),
                            ),
                    )
                    .when(invalid, |row| {
                        row.child(
                            div()
                                .pl(px(120.))
                                .text_role(TextRole::Caption, cx)
                                .text_color(error_ink)
                                .child(if field.style == BibValueStyle::Raw {
                                    t!("This value joins strings with #; keep it valid BibTeX.")
                                } else {
                                    t!("Braces in the value must be balanced.")
                                }),
                        )
                    }),
            );
        }
        let field_box = |input: &Entity<InputState>, width: Option<f32>| {
            div()
                .when_some(width, |field, width| field.flex_none().w(px(width)))
                .when(width.is_none(), |field| field.flex_1().min_w_0())
                .h(px(28.))
                .px(px(8.))
                .flex()
                .items_center()
                .rounded(px(6.))
                .bg(palette.input)
                .border_1()
                .border_color(palette.field_border)
                .font_family(editor_font.clone())
                .child(Input::new(input).appearance(false).bordered(false).px_0())
        };
        let can_add = !detail.new_name.read(cx).value().trim().is_empty();
        div()
            .flex()
            .flex_col()
            .child(Self::section_title(t!("Fields"), cx))
            .child(card)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .mt(px(12.))
                    .child(field_box(&detail.new_name, Some(112.)))
                    .child(field_box(&detail.new_value, None))
                    .child(
                        Button::new("bib-add-field", t!("Add field"))
                            .compact()
                            .disabled(!can_add)
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                this.add_field(window, cx)
                            })),
                    ),
            )
            .when_some(detail.new_error.clone(), |section, error| {
                section.child(
                    div()
                        .mt(px(6.))
                        .text_role(TextRole::Caption, cx)
                        .text_color(error_ink)
                        .child(error),
                )
            })
            .into_any_element()
    }
}
