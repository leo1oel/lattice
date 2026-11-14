//! Checklist templates (`submission-items.tsx`'s template menu and
//! `TemplateForm`, `loadSubmissionTemplates` in `app-settings.ts`): the
//! writer's item lists saved by name for their other papers, the items'
//! names, files and sources but not their status. The menu beside
//! "Materials and sign-offs" adds a template's items (a line already on the
//! list by its title is not added twice) and opens the form that saves the
//! list as a template, replaces one of the same name, or removes it.
//!
//! They are the writer's, every window's and project's, kept as
//! `submission-templates.json` in the app's state folder in the Tauri app's
//! stored shape.

use std::path::PathBuf;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, Global, IntoElement, ParentElement as _,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::models::SubmissionItem;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Field, IconButton, MenuAction, MenuPopover},
    shape::RADIUS_SURFACE,
    tokens::FONT_WEIGHT_MEDIUM,
};
use serde_json::{Value, json};

use super::ChecklistPanel;

/// One saved line: an item's name, file and source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplateLine {
    pub title: String,
    pub file: Option<String>,
    pub source: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Template {
    pub name: String,
    pub items: Vec<TemplateLine>,
}

/// The stored list as the Tauri app reads it: a template needs a name and a
/// list; a line needs a title; an empty file or source is none.
pub fn parse(text: &str) -> Vec<Template> {
    let text_of = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let name = entry.get("name")?.as_str()?.to_string();
            let items = entry
                .get("items")?
                .as_array()?
                .iter()
                .filter_map(|line| {
                    Some(TemplateLine {
                        title: text_of(line.get("title"))?,
                        file: text_of(line.get("file")),
                        source: text_of(line.get("source")),
                    })
                })
                .collect();
            Some(Template { name, items })
        })
        .collect()
}

pub fn to_json(templates: &[Template]) -> String {
    let entries: Vec<Value> = templates
        .iter()
        .map(|template| {
            let items: Vec<Value> = template
                .items
                .iter()
                .map(|line| {
                    let mut item = json!({ "title": line.title });
                    if let Some(file) = &line.file {
                        item["file"] = json!(file);
                    }
                    if let Some(source) = &line.source {
                        item["source"] = json!(source);
                    }
                    item
                })
                .collect();
            json!({ "name": template.name, "items": items })
        })
        .collect();
    Value::Array(entries).to_string()
}

/// `latest` with `template`'s lines added as new items to do, but for a line
/// already on the list by its title.
pub fn with_template(latest: &[SubmissionItem], template: &Template) -> Vec<SubmissionItem> {
    let mut items = latest.to_vec();
    for line in &template.items {
        if items.iter().any(|item| item.title == line.title) {
            continue;
        }
        items.push(SubmissionItem {
            id: uuid::Uuid::new_v4().to_string(),
            title: line.title.clone(),
            status: "todo".into(),
            file: line.file.clone(),
            source: line.source.clone(),
            source_checked: None,
            owner: None,
            confirmed_mtime_ms: None,
        });
    }
    items
}

/// `templates` with `items` saved under `name`, in place of one so named,
/// at the end.
pub fn saved(templates: &[Template], name: &str, items: &[SubmissionItem]) -> Vec<Template> {
    let mut next: Vec<Template> = templates
        .iter()
        .filter(|template| template.name != name)
        .cloned()
        .collect();
    next.push(Template {
        name: name.into(),
        items: items
            .iter()
            .map(|item| TemplateLine {
                title: item.title.clone(),
                file: item.file.clone(),
                source: item.source.clone(),
            })
            .collect(),
    });
    next
}

/// A template's name is at most this long (`maxLength`).
const NAME_MAX: usize = 60;

/// The names of `templates` holding `typed`, as the form's datalist
/// suggests them: any case, and not the name already typed exactly.
pub fn suggestions<'a>(templates: &'a [Template], typed: &str) -> Vec<&'a str> {
    let lowered = typed.to_lowercase();
    templates
        .iter()
        .map(|template| template.name.as_str())
        .filter(|name| *name != typed && name.to_lowercase().contains(&lowered))
        .collect()
}

/// The writer's templates, shared by every window.
pub struct Templates {
    list: Vec<Template>,
    file: Option<PathBuf>,
}

struct TemplatesGlobal(Entity<Templates>);

impl Global for TemplatesGlobal {}

pub fn global(cx: &mut App) -> Entity<Templates> {
    if let Some(templates) = cx.try_global::<TemplatesGlobal>() {
        return templates.0.clone();
    }
    let scripted = std::env::args().any(|arg| arg == "--scenario");
    let file = crate::shell::workspaces::state_dir(scripted)
        .map(|folder| folder.join("submission-templates.json"));
    let list = file
        .as_ref()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .map(|text| parse(&text))
        .unwrap_or_default();
    let templates = cx.new(|_| Templates { list, file });
    cx.set_global(TemplatesGlobal(templates.clone()));
    templates
}

impl Templates {
    pub fn list(&self) -> &[Template] {
        &self.list
    }

    pub fn set(&mut self, list: Vec<Template>, cx: &mut Context<Self>) {
        self.list = list;
        cx.notify();
        let Some(file) = self.file.clone() else {
            return;
        };
        let text = to_json(&self.list);
        cx.background_spawn(async move {
            if let Some(folder) = file.parent() {
                std::fs::create_dir_all(folder).ok();
            }
            if let Err(error) = std::fs::write(&file, text) {
                log::warn!("checklist templates: could not keep them: {error}");
            }
        })
        .detach();
    }
}

impl ChecklistPanel {
    /// The menu beside the heading, when there is a list to save or a
    /// template to add from.
    pub(super) fn template_menu(&self, items: usize, cx: &mut Context<Self>) -> Option<AnyElement> {
        let templates = global(cx).read(cx).list().to_vec();
        if items == 0 && templates.is_empty() {
            return None;
        }
        let panel = cx.entity().downgrade();
        let trigger = IconButton::new("checklist-templates", Icon::LAYOUT_TEMPLATE)
            .frame(px(24.), px(24.))
            .icon_size(px(13.))
            .tooltip(t!("Checklist templates"));
        Some(
            MenuPopover::new("checklist-templates-menu", trigger, move |menu, _, _| {
                let mut menu = menu.min_w(px(220.));
                if !templates.is_empty() {
                    menu = menu.label(t!("Add items from"));
                }
                for template in &templates {
                    let panel = panel.clone();
                    let chosen = template.clone();
                    menu = menu.item(
                        MenuAction::new(template.name.clone(), move |_, cx| {
                            panel
                                .update(cx, |panel, cx| panel.add_from_template(&chosen, cx))
                                .ok();
                        })
                        .shortcut(template.items.len().to_string()),
                    );
                }
                if !templates.is_empty() {
                    menu = menu.separator();
                }
                let panel = panel.clone();
                menu.item(
                    MenuAction::new(
                        if templates.is_empty() {
                            t!("Save these items as a template…")
                        } else {
                            t!("Save or remove a template…")
                        },
                        move |window, cx| {
                            panel
                                .update(cx, |panel, cx| panel.open_template_form(window, cx))
                                .ok();
                        },
                    )
                    .disabled(items == 0),
                )
            })
            .anchor(gpui::Anchor::TopRight)
            .into_any_element(),
        )
    }

    fn open_template_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let field = cx.new(|cx| InputState::new(window, cx).placeholder(t!("e.g. Camera-ready")));
        window.focus(&gpui::Focusable::focus_handle(field.read(cx), cx), cx);
        // The name decides Save or Replace as it is typed; Enter saves.
        let watch = cx.subscribe_in(
            &field,
            window,
            |this, field, event, window, cx| match event {
                InputEvent::PressEnter { .. } => {
                    let name = field.read(cx).value().trim().to_string();
                    this.save_template(&name, cx);
                }
                InputEvent::Change => {
                    let value = field.read(cx).value().to_string();
                    if value.chars().count() > NAME_MAX {
                        let capped: String = value.chars().take(NAME_MAX).collect();
                        field.update(cx, |field, cx| field.set_value(capped, window, cx));
                    }
                    cx.notify();
                }
                _ => {}
            },
        );
        self.items.template_form = Some((field, watch));
        cx.notify();
    }

    /// The form (`.submission-template-form`, the deadline form's card):
    /// the name, where the template is kept, and Remove, Cancel and Save or
    /// Replace.
    pub(super) fn render_template_form(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let field = self.items.template_form.as_ref()?.0.clone();
        let palette = cx.palette().clone();
        let name = field.read(cx).value().trim().to_string();
        let templates = global(cx).read(cx).list().to_vec();
        let existing = templates.iter().any(|template| template.name == name);
        let suggested: Vec<String> = suggestions(&templates, &name)
            .into_iter()
            .map(str::to_string)
            .collect();
        let save_name = name.clone();
        let remove_name = name.clone();
        Some(
            div()
                .mb(px(8.))
                .flex()
                .flex_col()
                .gap(px(10.))
                .pt(px(10.))
                .px(px(12.))
                .pb(px(12.))
                .rounded(RADIUS_SURFACE)
                .border_1()
                .border_color(palette.line)
                .bg(palette.raised)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text_secondary)
                        .child(t!("Template name"))
                        .child(Field::new(&field).compact()),
                )
                .when(!suggested.is_empty(), |form| {
                    form.child(div().flex().flex_wrap().gap(px(4.)).children(
                        suggested.into_iter().enumerate().map(|(ix, suggestion)| {
                            let field = field.clone();
                            Button::new(("template-suggestion", ix), suggestion.clone())
                                .ghost()
                                .compact()
                                .on_click(move |_, window, cx| {
                                    field.update(cx, |field, cx| {
                                        field.set_value(suggestion.clone(), window, cx)
                                    });
                                })
                        }),
                    ))
                })
                .child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(t!(
                            "Saved on this Mac for your other papers: item names, files and sources, not their status."
                        )),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .justify_end()
                        .gap(px(6.))
                        .when(existing, |actions| {
                            actions.child(
                                div().mr_auto().child(
                                    Button::new("template-remove", t!("Remove template"))
                                        .ghost()
                                        .compact()
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            let templates = global(cx);
                                            templates.update(cx, |templates, cx| {
                                                let next = templates
                                                    .list()
                                                    .iter()
                                                    .filter(|template| template.name != remove_name)
                                                    .cloned()
                                                    .collect();
                                                templates.set(next, cx);
                                            });
                                            if let Some((field, _)) = &this.items.template_form {
                                                field.update(cx, |field, cx| {
                                                    field.set_value("", window, cx)
                                                });
                                            }
                                        })),
                                ),
                            )
                        })
                        .child(
                            Button::new("template-cancel", t!("Cancel"))
                                .ghost()
                                .compact()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.items.template_form = None;
                                    cx.notify();
                                })),
                        )
                        .child(
                            Button::new(
                                "template-save",
                                if existing {
                                    t!("Replace template")
                                } else {
                                    t!("Save template")
                                },
                            )
                            .primary()
                            .compact()
                            .disabled(name.is_empty())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.save_template(&save_name, cx);
                            })),
                        ),
                )
                .into_any_element(),
        )
    }

    /// The menu's "Add items from": `template`'s lines not yet on the list.
    pub(crate) fn add_from_template(&mut self, template: &Template, cx: &mut Context<Self>) {
        let items = with_template(&self.items_list(cx), template);
        self.save_items(items, cx);
    }

    /// Save the list as it stands under `name`, and close the form.
    pub(crate) fn save_template(&mut self, name: &str, cx: &mut Context<Self>) {
        if name.is_empty() {
            return;
        }
        let items = self.items_list(cx);
        let templates = global(cx);
        templates.update(cx, |templates, cx| {
            let next = saved(templates.list(), name, &items);
            templates.set(next, cx);
        });
        self.items.template_form = None;
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: &str, status: &str) -> SubmissionItem {
        SubmissionItem {
            id: title.into(),
            title: title.into(),
            status: status.into(),
            file: Some(format!("{title}.pdf")),
            source: None,
            source_checked: None,
            owner: Some("Ana".into()),
            confirmed_mtime_ms: Some(1),
        }
    }

    #[test]
    fn the_tauri_apps_stored_templates_read_back_and_bad_entries_drop() {
        let text = r#"[
            {"name":"Camera-ready","items":[{"title":"Copyright form","file":"copyright.pdf","source":""},{"title":""},{"file":"x"}]},
            {"name":3,"items":[]},
            {"name":"No list"}
        ]"#;
        let templates = parse(text);
        assert_eq!(
            templates,
            vec![Template {
                name: "Camera-ready".into(),
                items: vec![TemplateLine {
                    title: "Copyright form".into(),
                    file: Some("copyright.pdf".into()),
                    source: None,
                }],
            }]
        );
        assert_eq!(parse(&to_json(&templates)), templates);
        assert!(parse("{}").is_empty());
    }

    #[test]
    fn a_template_keeps_names_files_and_sources_not_status_or_owner() {
        let templates = saved(&[], "Camera-ready", &[item("Copyright form", "confirmed")]);
        let added = with_template(&[], &templates[0]);
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].status, "todo");
        assert_eq!(added[0].file.as_deref(), Some("Copyright form.pdf"));
        assert_eq!(added[0].owner, None);
        assert_eq!(added[0].confirmed_mtime_ms, None);
    }

    #[test]
    fn the_form_suggests_the_names_holding_what_is_typed_but_not_one_typed_in_full() {
        let templates = saved(&saved(&[], "Camera-ready", &[]), "Arxiv", &[]);
        assert_eq!(suggestions(&templates, ""), ["Camera-ready", "Arxiv"]);
        assert_eq!(suggestions(&templates, "CAMERA"), ["Camera-ready"]);
        assert_eq!(suggestions(&templates, "camera-ready"), ["Camera-ready"]);
        assert!(suggestions(&templates, "Camera-ready").is_empty());
        assert!(suggestions(&templates, "Workshop").is_empty());
    }

    #[test]
    fn a_line_already_listed_by_title_is_not_added_twice() {
        let templates = saved(&[], "T", &[item("A", "todo"), item("B", "todo")]);
        let added = with_template(&[item("A", "confirmed")], &templates[0]);
        let titles: Vec<_> = added.iter().map(|item| item.title.as_str()).collect();
        assert_eq!(titles, ["A", "B"]);
        assert_eq!(added[0].status, "confirmed");
    }

    #[test]
    fn saving_under_a_name_replaces_that_template_at_the_end() {
        let first = saved(&[], "A", &[item("x", "todo")]);
        let both = saved(&first, "B", &[item("y", "todo")]);
        let replaced = saved(&both, "A", &[item("z", "todo")]);
        let names: Vec<_> = replaced.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["B", "A"]);
        assert_eq!(replaced[1].items[0].title, "z");
    }
}
