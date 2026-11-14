//! The writer's own items under the automatic checks, ported from the
//! Tauri app's `submission-items.tsx` (`.submission-*` in `dialogs.css`):
//! one hairline list, each row a status mark that ticks the item, its title
//! (which opens the item's fields in place) with its state at the end, and
//! the meta under it (who, which file, where the requirement came from and
//! when it was last checked against it); a last row adds an item. A file
//! gone or changed since sign-off takes the warning mark.
//!
//! Each edit builds on the list as last saved: the manifest is written off
//! the main thread and the project reads it again (`ChecklistPanel::save_items`).

use gpui::{
    AnyElement, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription,
    Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::models::SubmissionItem;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Field, Segmented},
    interaction::{track_pointer, use_interaction},
    tokens::FONT_WEIGHT_MEDIUM,
    typography::tabular_nums,
};

use super::{
    ChecklistEvent, ChecklistPanel,
    model::{FileStat, ItemCondition, item_condition, item_passes},
    view::{exclamation, mark_disc, rows_group, section_title},
};

pub(super) struct ItemsState {
    adding: Entity<InputState>,
    editing: Option<ItemForm>,
    /// The checklist template form's name field, while it is open
    /// (`templates`).
    pub(super) template_form: Option<(Entity<InputState>, Subscription)>,
    _adding: Subscription,
}

struct ItemForm {
    id: String,
    status: String,
    title: Entity<InputState>,
    owner: Entity<InputState>,
    file: Entity<InputState>,
    source: Entity<InputState>,
    checked: Entity<InputState>,
}

impl ItemsState {
    pub(super) fn new(window: &mut Window, cx: &mut Context<ChecklistPanel>) -> Self {
        let adding = cx.new(|cx| InputState::new(window, cx).placeholder(t!("Add an item")));
        let subscription = cx.subscribe_in(&adding, window, |this, field, event, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                let title = field.read(cx).value().trim().to_string();
                if !title.is_empty() {
                    this.add_item(title, cx);
                    field.update(cx, |field, cx| field.set_value("", window, cx));
                }
            }
        });
        Self {
            adding,
            editing: None,
            template_form: None,
            _adding: subscription,
        }
    }

    pub(super) fn reset(&mut self, window: &mut Window, cx: &mut Context<ChecklistPanel>) {
        self.editing = None;
        self.template_form = None;
        self.adding
            .update(cx, |field, cx| field.set_value("", window, cx));
    }
}

/// Signed off: confirmed, or confirmed with its file not read yet.
fn signed_off(condition: ItemCondition) -> bool {
    matches!(condition, ItemCondition::Confirmed | ItemCondition::Pending)
}

fn state_label(condition: ItemCondition) -> &'static str {
    match condition {
        ItemCondition::Todo => t!("To do"),
        ItemCondition::Review => t!("To check"),
        ItemCondition::Confirmed | ItemCondition::Pending => t!("Confirmed"),
        ItemCondition::Missing => t!("File missing"),
        ItemCondition::Changed => t!("Changed since confirmed"),
    }
}

fn is_url(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && !source.contains(char::is_whitespace)
}

fn host_of(source: &str) -> String {
    let rest = source.split_once("://").map_or(source, |(_, rest)| rest);
    rest.split(['/', '?', '#'])
        .next()
        .unwrap_or(rest)
        .to_string()
}

/// "YYYY-MM-DD" as `Intl` writes `{ month: short, day, year }`.
fn checked_day(day: &str) -> Option<String> {
    let date = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    use chrono::Datelike as _;
    Some(if lattice_i18n::locale().is_chinese() {
        format!("{}年{}月{}日", date.year(), date.month(), date.day())
    } else {
        const MONTHS: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        format!(
            "{} {}, {}",
            MONTHS[date.month0() as usize],
            date.day(),
            date.year()
        )
    })
}

impl ChecklistPanel {
    pub(super) fn items_list(&self, cx: &gpui::App) -> Vec<SubmissionItem> {
        self.manifest(cx)
            .map(|manifest| manifest.submission_items.clone())
            .unwrap_or_default()
    }

    fn stat_of(&self, item: &SubmissionItem) -> Option<FileStat> {
        item.file
            .as_ref()
            .and_then(|file| self.facts.stats.get(file).copied())
    }

    /// Each item's result, as the verdict counts it.
    pub(super) fn item_results(&self, cx: &gpui::App) -> Vec<Option<bool>> {
        self.items_list(cx)
            .iter()
            .map(|item| item_passes(item_condition(item, self.stat_of(item))))
            .collect()
    }

    fn add_item(&mut self, title: String, cx: &mut Context<Self>) {
        let mut items = self.items_list(cx);
        items.push(SubmissionItem {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            status: "todo".into(),
            file: None,
            source: None,
            source_checked: None,
            owner: None,
            confirmed_mtime_ms: None,
        });
        self.save_items(items, cx);
    }

    fn replace_item(&mut self, id: &str, next: Option<SubmissionItem>, cx: &mut Context<Self>) {
        let items: Vec<SubmissionItem> = self
            .items_list(cx)
            .into_iter()
            .filter_map(|item| {
                if item.id == id {
                    next.clone()
                } else {
                    Some(item)
                }
            })
            .collect();
        self.save_items(items, cx);
    }

    /// Tick or untick: confirming takes the file as it is now; a
    /// confirmation whose file is not read yet unticks too.
    fn toggle_item(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(item) = self.items_list(cx).into_iter().find(|item| item.id == id) else {
            return;
        };
        let condition = item_condition(&item, self.stat_of(&item));
        let status = if signed_off(condition) {
            "todo"
        } else {
            "confirmed"
        };
        let mut next = item;
        next.status = status.into();
        next.confirmed_mtime_ms = None;
        self.replace_item(&id, Some(next), cx);
    }

    fn edit_item(&mut self, item: SubmissionItem, window: &mut Window, cx: &mut Context<Self>) {
        let field = |value: Option<String>,
                     placeholder: &'static str,
                     window: &mut Window,
                     cx: &mut Context<Self>| {
            cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder(placeholder)
                    .default_value(value.unwrap_or_default())
            })
        };
        let title = field(Some(item.title.clone()), "", window, cx);
        title.update(cx, |field, cx| field.focus(window, cx));
        self.items.editing = Some(ItemForm {
            id: item.id.clone(),
            status: item.status.clone(),
            title,
            owner: field(item.owner.clone(), t!("e.g. all authors"), window, cx),
            file: field(item.file.clone(), t!("A file in this project"), window, cx),
            source: field(
                item.source.clone(),
                t!("Call for papers URL or note"),
                window,
                cx,
            ),
            checked: field(item.source_checked.clone(), "YYYY-MM-DD", window, cx),
        });
        cx.notify();
    }

    fn save_item_form(&mut self, cx: &mut Context<Self>) {
        let Some(form) = self.items.editing.as_ref() else {
            return;
        };
        let Some(before) = self
            .items_list(cx)
            .into_iter()
            .find(|item| item.id == form.id)
        else {
            return;
        };
        let read = |field: &Entity<InputState>| {
            let value = field.read(cx).value().trim().to_string();
            (!value.is_empty()).then_some(value)
        };
        let Some(title) = read(&form.title) else {
            return;
        };
        let file = read(&form.file);
        // A new status or file is confirmed against the file as it is now.
        let restamp = form.status != before.status || file != before.file;
        let next = SubmissionItem {
            id: before.id.clone(),
            title,
            status: form.status.clone(),
            owner: read(&form.owner),
            file,
            source: read(&form.source),
            source_checked: read(&form.checked),
            confirmed_mtime_ms: if restamp {
                None
            } else {
                before.confirmed_mtime_ms
            },
        };
        let id = form.id.clone();
        self.items.editing = None;
        self.replace_item(&id, Some(next), cx);
    }

    pub(super) fn render_items(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let items = self.items_list(cx);
        let total = items.len();
        let confirmed = items
            .iter()
            .filter(|item| item_condition(item, self.stat_of(item)) == ItemCondition::Confirmed)
            .count();
        let mut rows: Vec<AnyElement> = Vec::new();
        for item in &items {
            if self
                .items
                .editing
                .as_ref()
                .is_some_and(|form| form.id == item.id)
            {
                rows.push(self.render_item_form(cx));
            } else {
                rows.push(self.render_item_row(item, window, cx));
            }
        }
        rows.push(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(12.))
                .py(px(4.))
                .child(
                    div()
                        .w(px(18.))
                        .flex()
                        .justify_center()
                        .child(Icon::PLUS.element(px(13.), palette.text_secondary)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(Field::new(&self.items.adding).compact()),
                )
                .into_any_element(),
        );
        div()
            .mb(px(16.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_baseline()
                    .gap_x(px(6.))
                    .child(section_title(t!("Materials and sign-offs"), cx))
                    .when(total > 0, |head| {
                        head.child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .font_features(tabular_nums())
                                .child(t!(
                                    "{confirmedCount} of {total} confirmed",
                                    confirmedCount = confirmed,
                                    total = total
                                )),
                        )
                    })
                    .child(div().ml_auto().children(self.template_menu(total, cx))),
            )
            .children(self.render_template_form(cx))
            .child(div().mb(px(-16.)).child(rows_group(rows, cx)))
            .into_any_element()
    }

    fn render_item_row(
        &self,
        item: &SubmissionItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let condition = item_condition(item, self.stat_of(item));
        let warn = matches!(condition, ItemCondition::Missing | ItemCondition::Changed);
        let (ground, glyph) = match condition {
            ItemCondition::Confirmed => (
                palette.success_soft,
                Icon::CHECK
                    .element(px(12.), palette.success)
                    .into_any_element(),
            ),
            ItemCondition::Review => (
                palette.line,
                Icon::CIRCLE_DOT
                    .element(px(12.), palette.text_secondary)
                    .into_any_element(),
            ),
            ItemCondition::Todo | ItemCondition::Pending => (
                palette.line,
                Icon::CIRCLE
                    .element(px(10.), palette.text_secondary)
                    .into_any_element(),
            ),
            ItemCondition::Missing | ItemCondition::Changed => {
                (palette.warning_soft, exclamation(palette.warning))
            }
        };
        let id = item.id.clone();
        let toggle_id = SharedString::from(format!("submission-toggle-{}", item.id));
        let (toggle_state, toggle_pointer) = use_interaction(toggle_id.clone(), window, cx);
        let toggle = div()
            .id(toggle_id)
            .flex_none()
            .rounded(lattice_ui::tokens::RADIUS_PILL)
            .when(toggle_state.hover > 0.5, |toggle| {
                toggle
                    .border_1()
                    .border_color(palette.line_strong)
                    .m(px(-1.))
            })
            .cursor_pointer()
            .child(mark_disc(ground, glyph))
            .on_click(cx.listener(move |this, _, _, cx| this.toggle_item(id.clone(), cx)));
        let edit_item = item.clone();
        let title_id = SharedString::from(format!("submission-title-{}", item.id));
        let (title_state, title_pointer) = use_interaction(title_id.clone(), window, cx);
        let title = div()
            .id(title_id)
            .min_w_0()
            .flex()
            .flex_wrap()
            .items_baseline()
            .justify_between()
            .gap_x(px(10.))
            .cursor_pointer()
            .child(
                div()
                    .min_w_0()
                    .text_role(TextRole::Body, cx)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text)
                    .when(title_state.hover > 0.5, |title| title.underline())
                    .child(item.title.clone()),
            )
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(if warn {
                        palette.warning
                    } else {
                        palette.text_secondary
                    })
                    .when(warn, |state| state.font_weight(FONT_WEIGHT_MEDIUM))
                    .child(state_label(condition)),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.edit_item(edit_item.clone(), window, cx)
            }));
        let chip = |id: String, icon: Icon, label: String, event: ChecklistEvent, struck: bool| {
            let event = std::cell::Cell::new(Some(event));
            div()
                .id(SharedString::from(id))
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(2.))
                .text_color(if struck {
                    palette.text_secondary
                } else {
                    palette.accent
                })
                .when(struck, |chip| chip.line_through())
                .cursor_pointer()
                .child(icon.element(
                    px(12.),
                    if struck {
                        palette.text_secondary
                    } else {
                        palette.accent
                    },
                ))
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .child(label),
                )
                .on_click(cx.listener(move |_, _, _, cx| {
                    if let Some(event) = event.take() {
                        cx.emit(event);
                    }
                }))
        };
        let mut meta: Vec<AnyElement> = Vec::new();
        if let Some(owner) = &item.owner {
            meta.push(
                div()
                    .text_color(palette.text)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .child(owner.clone())
                    .into_any_element(),
            );
        }
        if let Some(file) = &item.file {
            let name = file.rsplit('/').next().unwrap_or(file).to_string();
            meta.push(
                chip(
                    format!("submission-file-{}", item.id),
                    Icon::FILE_TEXT,
                    name,
                    ChecklistEvent::Open {
                        path: file.clone(),
                        line: None,
                    },
                    condition == ItemCondition::Missing,
                )
                .into_any_element(),
            );
        }
        if let Some(source) = &item.source {
            meta.push(if is_url(source) {
                chip(
                    format!("submission-source-{}", item.id),
                    Icon::LINK_2,
                    host_of(source),
                    ChecklistEvent::OpenUrl(source.clone()),
                    false,
                )
                .into_any_element()
            } else {
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(source.clone())
                    .into_any_element()
            });
        }
        if let Some(day) = item.source_checked.as_deref().and_then(checked_day) {
            meta.push(
                div()
                    .child(t!("checked {checked}", checked = day))
                    .into_any_element(),
            );
        }
        div()
            .flex()
            .items_start()
            .gap(px(10.))
            .px(px(12.))
            .py(px(10.))
            .child(track_pointer(toggle, toggle_pointer))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(track_pointer(title, title_pointer))
                    .when(!meta.is_empty(), |column| {
                        column.child(
                            div()
                                .min_w_0()
                                .flex()
                                .flex_wrap()
                                .items_center()
                                .gap_x(px(8.))
                                .gap_y(px(2.))
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .children(meta),
                        )
                    }),
            )
            .into_any_element()
    }

    fn render_item_form(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let Some(form) = self.items.editing.as_ref() else {
            return div().into_any_element();
        };
        let labelled = |label: &'static str, field: &Entity<InputState>| {
            div()
                .min_w_0()
                .flex_grow(1.)
                .flex_basis(px(120.))
                .flex()
                .flex_col()
                .gap(px(4.))
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text_secondary)
                .child(label)
                .child(Field::new(field).compact())
        };
        let status = form.status.clone();
        let mut segmented = Segmented::new("submission-status").filled();
        for (value, label) in [
            ("todo", t!("To do")),
            ("review", t!("To check")),
            ("confirmed", t!("Confirmed")),
        ] {
            segmented = segmented.label(
                label,
                status == value,
                cx.listener(move |this, _, _, cx| {
                    if let Some(form) = this.items.editing.as_mut() {
                        form.status = value.into();
                        cx.notify();
                    }
                }),
            );
        }
        let titled = !form.title.read(cx).value().trim().is_empty();
        let id = form.id.clone();
        div()
            .id("submission-form")
            .flex()
            .flex_col()
            .gap(px(10.))
            .px(px(12.))
            .pt(px(10.))
            .pb(px(12.))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    this.items.editing = None;
                    cx.notify();
                }
            }))
            .child(labelled(t!("Item"), &form.title))
            .child(segmented)
            .child(labelled(t!("Who"), &form.owner))
            .child(labelled(t!("Material file"), &form.file))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .child(labelled(t!("Requirement source"), &form.source))
                    .child(labelled(t!("Checked against it on"), &form.checked)),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_end()
                    .gap(px(6.))
                    .child(
                        div().mr_auto().child(
                            Button::new("submission-remove", t!("Remove"))
                                .ghost()
                                .compact()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.items.editing = None;
                                    this.replace_item(&id, None, cx);
                                })),
                        ),
                    )
                    .child(
                        Button::new("submission-cancel", t!("Cancel"))
                            .ghost()
                            .compact()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.items.editing = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("submission-save", t!("Save item"))
                            .primary()
                            .compact()
                            .disabled(!titled)
                            .on_click(cx.listener(|this, _, _, cx| this.save_item_form(cx))),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_reads_as_its_host_when_it_is_a_link() {
        assert!(is_url("https://neurips.cc/Conferences/2027/CallForPapers"));
        assert!(!is_url("the call says 9 pages"));
        assert_eq!(
            host_of("https://neurips.cc/Conferences/2027?x=1"),
            "neurips.cc"
        );
        assert_eq!(checked_day("2027-03-04").as_deref(), Some("Mar 4, 2027"));
        assert!(checked_day("soon").is_none());
    }
}
