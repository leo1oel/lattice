//! Add reference's form as the Tauri app lays it out (`bib-entry-dialog.tsx`,
//! `.bib-entry-form` in `app-shell.css`): the work (title and authors at
//! full width, the year beside its venue), then, past a hairline, the record
//! (DOI beside URL, type beside the citation key); each field's label at its
//! start, the way a reference manager's info pane reads. A sheet under 480px
//! gives every field a row of its own.
//!
//! Around it: how a looked-up record was matched (and, once a field
//! differs, that it was edited), the records a lookup could not tell apart,
//! the BibTeX the form will write a click away, and the choice to cite the
//! entry at the caret once it is saved.

use gpui::{
    AnyElement, ClickEvent, Context, Hsla, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, CheckState, Checkbox, MenuAction, MenuPopover},
    interaction::{fade, mix, track_pointer, use_interaction},
    motion::Motion,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD},
};

use super::{AddReference, Field, TYPES, type_label};
use crate::papers::candidates::{candidate_list, evidence_line};

/// The label column (`grid-template-columns: 64px …`).
const LABEL: f32 = 64.;
/// A year's column: four digits and the stepper.
const YEAR: f32 = 112.;
/// Below this the sheet stacks every field (`@container bib-entry (width < 480px)`).
const NARROW: f32 = 480.;

impl AddReference {
    /// Whether the sheet is too narrow for two fields on a row.
    fn narrow(window: &Window) -> bool {
        crate::search::sheet::body_width(window) < NARROW
    }

    /// One field's box, as the form draws every text field.
    pub(super) fn field_box(&self, field: Field, cx: &Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .relative()
            .flex_1()
            .min_w_0()
            .h(px(30.))
            .px(px(8.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .bg(palette.input)
            .border_1()
            .border_color(palette.field_border)
            .child(
                gpui_kit::component::input::Input::new(self.input(field))
                    .disabled(field == Field::Key && self.editing())
                    .appearance(false)
                    .bordered(false)
                    .px_0(),
            )
            .into_any_element()
    }

    /// A label and what it names, side by side; a label in the first column
    /// takes its 64px, one in the second its own width.
    fn labeled(
        label: &'static str,
        control: AnyElement,
        first: bool,
        cx: &Context<Self>,
    ) -> gpui::Div {
        let palette = cx.palette().clone();
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .min_w_0()
            .child(
                div()
                    .flex_none()
                    .when(first, |label| label.w(px(LABEL)))
                    .min_w_0()
                    .text_role(TextRole::Caption, cx)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text_secondary)
                    .child(label),
            )
            .child(control)
    }

    /// The year's box, with its stepper at the end (`.year-stepper`).
    fn year_box(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let step = |id: &'static str,
                    icon: Icon,
                    label: &'static str,
                    by: i64,
                    top: bool,
                    window: &mut Window,
                    cx: &mut Context<Self>| {
            let (interaction, pointer) = use_interaction(id, window, cx);
            let hover = interaction.hover;
            track_pointer(div().id(id), pointer)
                .flex_1()
                .w(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .border_l_1()
                .border_color(palette.line)
                .when(top, |button| button.border_b_1())
                .cursor_pointer()
                .bg(mix(Hsla::transparent_black(), palette.accent_soft, hover))
                .tooltip(crate::papers::row::tooltip(label))
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.step_year(by, window, cx)
                }))
                .child(icon.element(px(12.), mix(palette.text_secondary, palette.accent, hover)))
        };
        // The buttons stand inside the field's border, at its end.
        div()
            .relative()
            .flex_none()
            .w(px(YEAR))
            .h(px(30.))
            .pl(px(8.))
            .pr(px(26.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .overflow_hidden()
            .bg(palette.input)
            .border_1()
            .border_color(palette.field_border)
            .child(
                gpui_kit::component::input::Input::new(self.input(Field::Year))
                    .appearance(false)
                    .bordered(false)
                    .px_0(),
            )
            .child(
                div()
                    .absolute()
                    .top_0()
                    .right_0()
                    .bottom_0()
                    .w(px(22.))
                    .flex()
                    .flex_col()
                    .child(step(
                        "bib-year-up",
                        Icon::CHEVRON_UP,
                        t!("Increment year"),
                        1,
                        true,
                        window,
                        cx,
                    ))
                    .child(step(
                        "bib-year-down",
                        Icon::CHEVRON_DOWN,
                        t!("Decrement year"),
                        -1,
                        false,
                        window,
                        cx,
                    )),
            )
            .into_any_element()
    }

    /// Step the year by `by`, when it reads as a number.
    fn step_year(&mut self, by: i64, window: &mut Window, cx: &mut Context<Self>) {
        let year = self.value(Field::Year, cx);
        let digits: String = year
            .trim()
            .chars()
            .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
            .collect();
        if let Ok(parsed) = digits.parse::<i64>() {
            self.input(Field::Year).clone().update(cx, |input, cx| {
                input.set_value((parsed + by).to_string(), window, cx)
            });
            cx.notify();
        }
    }

    /// The entry type's menu.
    fn type_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let view = cx.entity().downgrade();
        let kind = self.entry_type.clone();
        MenuPopover::new(
            "bib-entry-type",
            Button::new("bib-entry-type-button", type_label(&self.entry_type))
                .icon(Icon::CHEVRON_DOWN)
                .tooltip(t!("Entry type")),
            move |menu, _, _| {
                TYPES.iter().fold(menu, |menu, choice| {
                    let view = view.clone();
                    let choice = *choice;
                    menu.item(
                        MenuAction::new(type_label(choice), move |window, cx| {
                            view.update(cx, |this, cx| this.set_type(choice, window, cx))
                                .ok();
                        })
                        .checked(choice == kind),
                    )
                })
            },
        )
        .into_any_element()
    }

    /// The work, then the record past a hairline.
    pub(super) fn fields(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let narrow = Self::narrow(window);
        // Two pairs on a row, or each on its own when narrow.
        let pair_row = |left: gpui::Div, right: gpui::Div| {
            if narrow {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .child(left)
                    .child(right.child(div()))
            } else {
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .child(left)
                    .child(right.flex_1())
            }
        };
        let second = |label, control, cx: &Context<Self>| {
            // Stacked, a second-column label takes the first column's width.
            Self::labeled(label, control, narrow, cx).flex_1()
        };
        let venue = if self.entry_type == "book" {
            self.field_box(Field::Publisher, cx)
        } else {
            self.venue_field(cx)
        };
        let venue_label = if self.entry_type == "book" {
            t!("Publisher")
        } else {
            t!("Venue")
        };
        let year = self.year_box(window, cx);
        let work = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(Self::labeled(
                t!("Title"),
                self.field_box(Field::Title, cx),
                true,
                cx,
            ))
            .child(Self::labeled(
                t!("Author"),
                self.field_box(Field::Author, cx),
                true,
                cx,
            ))
            .child(pair_row(
                Self::labeled(t!("Year"), year, true, cx),
                second(venue_label, venue, cx),
            ));
        let record = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .pt(px(16.))
            .border_t_1()
            .border_color(palette.line)
            .child(pair_row(
                Self::labeled("DOI", self.field_box(Field::Doi, cx), true, cx).flex_1(),
                second("URL", self.field_box(Field::Url, cx), cx),
            ))
            .child(pair_row(
                Self::labeled(t!("Type"), self.type_menu(cx), true, cx).flex_1(),
                second(t!("Citation key"), self.field_box(Field::Key, cx), cx),
            ));
        div()
            .id("bib-entry-fields")
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(work)
            .child(record)
            .into_any_element()
    }

    /// How the retrieved record was matched; once a field differs, the
    /// match describes the record, not the entry, so it dims and says so.
    pub(super) fn record_evidence(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let evidence = self.evidence.clone()?;
        let palette = cx.palette().clone();
        if !self.edited && self.retrieved.as_ref() != Some(&self.draft(cx)) {
            self.edited = true;
        }
        let authors = !self.value(Field::Author, cx).trim().is_empty();
        let ink = if self.edited {
            palette.text_secondary.opacity(0.6)
        } else {
            palette.text_secondary
        };
        Some(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .text_role(TextRole::Caption, cx)
                .line_height(px(18.))
                .child(evidence_line(
                    "bib-record-source".into(),
                    Some(&evidence),
                    authors,
                    ink,
                    window,
                    cx,
                ))
                .when(self.edited, |line| {
                    line.child(
                        div()
                            .h(px(18.))
                            .px(px(6.))
                            .flex()
                            .items_center()
                            .rounded(px(4.))
                            .bg(palette.text.opacity(0.06))
                            .text_role(TextRole::Micro, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text_secondary)
                            .child(t!("Edited")),
                    )
                })
                .into_any_element(),
        )
    }

    /// The records a lookup could not tell apart (`CitationCandidates`), and
    /// Keep my fields once the fields show.
    pub(super) fn candidates(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let focused = self.candidates_focus.is_focused(window) && window.last_input_was_keyboard();
        let view = cx.entity().downgrade();
        let list = candidate_list(
            "bib-candidates",
            &self.candidates,
            self.chosen,
            focused,
            move |at, take, window, cx| {
                view.update(cx, |this, cx| {
                    this.chosen = at;
                    if take {
                        this.use_candidate(at, window, cx);
                    }
                    cx.notify();
                })
                .ok();
            },
            window,
            cx,
        );
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .id("bib-candidates-keys")
                    .track_focus(&self.candidates_focus)
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                        this.candidates_key(event, window, cx)
                    }))
                    .child(list),
            )
            // Fields already shown keep what was typed there.
            .when(self.show_fields, |section| {
                section.child(
                    div().flex().justify_end().child(
                        Button::new("bib-keep-fields", t!("Keep my fields"))
                            .compact()
                            .ghost()
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.abandon(cx))),
                    ),
                )
            })
            .into_any_element()
    }

    fn candidates_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let count = self.candidates.len();
        if count == 0 {
            return;
        }
        match event.keystroke.key.as_str() {
            "down" | "right" => self.chosen = (self.chosen + 1) % count,
            "up" | "left" => self.chosen = (self.chosen + count - 1) % count,
            "enter" => {
                self.use_candidate(self.chosen, window, cx);
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    pub(super) fn use_candidate(&mut self, at: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(record) = self.candidates.get(at).cloned() else {
            return;
        };
        self.apply_with_window(record, window, cx);
        self.input(Field::Title)
            .clone()
            .update(cx, |input, cx| input.focus(window, cx));
    }

    /// The BibTeX the form will write, a click away rather than a block of
    /// empty braces under it (`.bib-entry-preview-disclosure`).
    pub(super) fn preview(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let open = self.preview_open;
        let (interaction, pointer) = use_interaction("bib-preview-summary", window, cx);
        let turn = fade("bib-preview-chevron", open, Motion::Fast, window, cx);
        let summary = track_pointer(div().id("bib-preview-summary"), pointer)
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(4.))
            .cursor_pointer()
            .text_role(TextRole::Micro, cx)
            .font_weight(FONT_WEIGHT_SEMIBOLD)
            .text_color(mix(palette.text_secondary, palette.text, interaction.hover))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                this.preview_open = !this.preview_open;
                cx.notify();
            }))
            .child(
                gpui::svg()
                    .path(Icon::CHEVRON_RIGHT.path())
                    .size(px(13.))
                    .text_color(mix(palette.text_secondary, palette.text, interaction.hover))
                    .with_transformation(gpui::Transformation::rotate(gpui::radians(
                        turn * std::f32::consts::FRAC_PI_2,
                    ))),
            )
            .child(t!("BibTeX preview"));
        div()
            .flex_none()
            .flex()
            .flex_col()
            .items_start()
            .child(summary)
            .when(open, |disclosure| {
                disclosure.child(
                    div()
                        .id("bib-entry-preview")
                        .mt(px(8.))
                        .w_full()
                        .min_h(px(96.))
                        .max_h(px(200.))
                        .overflow_y_scroll()
                        .p(px(10.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(palette.line)
                        .bg(palette.window)
                        .font_family(cx.lattice().fonts.editor.clone())
                        .text_role(TextRole::Caption, cx)
                        .line_height(gpui::relative(1.45))
                        .text_color(palette.text_secondary)
                        .child(self.draft(cx).format()),
                )
            })
            .into_any_element()
    }

    /// Insert cite at cursor after saving, at the footer's start.
    pub(super) fn cite_choice(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .mr_auto()
            .self_center()
            .child(
                Checkbox::new(
                    "bib-entry-cite",
                    if self.insert_cite {
                        CheckState::On
                    } else {
                        CheckState::Off
                    },
                )
                .label(t!("Insert cite at cursor after saving"))
                .on_toggle(cx.listener(|this, on: &bool, _, cx| {
                    this.insert_cite = *on;
                    cx.notify();
                })),
            )
            .into_any_element()
    }
}

/// The form as a scenario drives it.
#[cfg(any(target_os = "macos", target_os = "windows"))]
impl AddReference {
    /// Enter manually, then type `title`, `author` and `year`.
    pub fn fill_for_scenario(
        &mut self,
        (title, author, year): (&str, &str, &str),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.enter_manually(window, cx);
        for (field, value) in [
            (Field::Title, title),
            (Field::Author, author),
            (Field::Year, year),
        ] {
            self.input(field).clone().update(cx, |input, cx| {
                input.set_value(value.to_string(), window, cx)
            });
        }
        cx.notify();
    }

    /// The year stepper's up (`1`) or down (`-1`) button.
    pub fn step_year_for_scenario(&mut self, by: i64, window: &mut Window, cx: &mut Context<Self>) {
        self.step_year(by, window, cx);
    }

    /// Open the BibTeX preview; what it shows, and whether the fields are
    /// shown and the entry will be cited at the caret.
    pub fn preview_for_scenario(&mut self, cx: &mut Context<Self>) -> (String, bool, bool, String) {
        self.preview_open = true;
        cx.notify();
        (
            self.draft(cx).format(),
            self.show_fields,
            self.insert_cite,
            self.value(Field::Year, cx),
        )
    }
}
