//! New project's My templates (`src/project/local-templates.tsx`): the
//! templates the writer saved, listed under the venue template, each a
//! snapshot lattice-core keeps (`project::templates`) of the reusable files
//! a folder, a ZIP or the open project held. Choosing one makes the project
//! from it (`local:<id>`, as the Tauri app's `create_project` reads it);
//! choosing a built-in venue again leaves it. Its version, source URL,
//! compile root and engine read under it, and its files fold under Files.
//! Save a local template… opens the dialog that makes one
//! (`save_template.rs`); a template saved there joins the list chosen.
//!
//! The GPUI app keeps them in its own state folder (`templates/`), not the
//! Tauri app's data folder, as it keeps every other store apart.

use std::path::{Path, PathBuf};

use gpui::{
    AnyElement, App, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, px,
};
use lattice_core::project::templates::{self, LocalTemplate};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Select},
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::new_project::NewProjectDialog;

/// The venue a saved template is created from (`local:<id>`).
pub const LOCAL_PREFIX: &str = "local:";

/// The folder the templates live in: the app's state folder's `templates/`;
/// a scripted run without one (`LATTICE_GPUI_STATE_DIR`) keeps its own in
/// the temporary folder, so it never reads or writes the writer's.
pub fn store() -> PathBuf {
    let scripted = std::env::args().any(|arg| arg == "--scenario");
    crate::shell::workspaces::state_dir(scripted)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("lattice-gpui-{}", std::process::id())))
        .join("templates")
}

/// The saved templates, by name.
pub fn list(store: &Path) -> Result<Vec<LocalTemplate>, String> {
    templates::list(store)
}

/// A template's name in the list: its name and version (`templateLabel`).
pub fn label(item: &LocalTemplate) -> String {
    [item.name.as_str(), item.version.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The line under a chosen template: its version, source URL, compile root
/// and engine, the empty ones left out.
pub fn details(item: &LocalTemplate) -> String {
    [&item.version, &item.source_url, &item.root, &item.engine]
        .into_iter()
        .filter(|part| !part.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ")
}

/// What the section keeps.
#[derive(Default)]
pub struct MyTemplates {
    pub items: Vec<LocalTemplate>,
    /// Why the list could not be read, or a save's error once the dialog
    /// closed (`field-error`).
    pub error: Option<String>,
    /// The chosen template's Files are unfolded.
    pub files_open: bool,
}

impl MyTemplates {
    /// The list as lattice-core reads it, saved ones this dialog added kept
    /// after it (`[...value, ...previous.filter(...)]`).
    pub fn loaded(&mut self, result: Result<Vec<LocalTemplate>, String>) {
        match result {
            Ok(value) => {
                let previous = std::mem::take(&mut self.items);
                self.items = value;
                for item in previous {
                    if !self.items.iter().any(|saved| saved.id == item.id) {
                        self.items.push(item);
                    }
                }
            }
            Err(error) => self.error = Some(error),
        }
    }

    pub fn find(&self, id: &str) -> Option<&LocalTemplate> {
        self.items.iter().find(|item| item.id == id)
    }
}

/// The section under the venue template, for the dialog's `chosen` saved
/// template.
pub fn render(
    mine: &MyTemplates,
    chosen: Option<&str>,
    cx: &mut Context<NewProjectDialog>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let active = chosen.and_then(|id| mine.find(id));
    let head = div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.))
        .min_w_0()
        .child(
            div()
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text)
                .child(t!("My templates")),
        )
        .child(
            Button::new("my-templates-save", t!("Save a local template…"))
                .ghost()
                .compact()
                .on_click(cx.listener(|this, _, window, cx| this.open_save_template(window, cx))),
        );
    let mut section = div()
        .id("my-templates")
        .mt(px(12.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .min_w_0()
        .child(head);
    if !mine.items.is_empty() {
        let selected = active.and_then(|active| mine.items.iter().position(|item| item.id == active.id));
        section = section.child(
            Select::new("my-templates-select", mine.items.iter().map(label), selected)
                .placeholder(t!("Choose a saved template"))
                .on_change(cx.listener(|this, ix: &usize, _, cx| this.choose_local(*ix, cx))),
        );
    }
    if let Some(active) = active {
        let secondary = palette.text_secondary;
        section = section.child(
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(secondary)
                .child(details(active)),
        );
        let open = mine.files_open;
        section = section.child(
            div()
                .id("my-templates-files")
                .flex()
                .items_center()
                .gap(px(4.))
                .cursor_pointer()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text)
                .child(
                    if open { Icon::CHEVRON_DOWN } else { Icon::CHEVRON_RIGHT }
                        .element(px(12.), secondary),
                )
                .child(t!("Files"))
                .on_click(cx.listener(|this, _, _, cx| this.toggle_template_files(cx))),
        );
        if open {
            section = section.child(
                div()
                    .id("my-templates-file-list")
                    .max_h(px(180.))
                    .overflow_y_scroll()
                    .pl(px(16.))
                    .flex()
                    .flex_col()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text)
                    .children(active.files.iter().map(|file| div().child(format!("• {file}")))),
            );
        }
    }
    if let Some(error) = &mine.error {
        section = section.child(
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.danger)
                .child(crate::host_errors::text(error)),
        );
    }
    section.into_any_element()
}

/// Read the saved templates off the main thread.
pub fn load(cx: &mut App) -> gpui::Task<Result<Vec<LocalTemplate>, String>> {
    use gpui::AppContext as _;
    let store = store();
    cx.background_spawn(async move { list(&store) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, name: &str, version: &str) -> LocalTemplate {
        LocalTemplate {
            id: id.into(),
            name: name.into(),
            source_url: String::new(),
            version: version.into(),
            files: vec!["main.tex".into()],
            root: "main.tex".into(),
            engine: "pdf".into(),
            preview: None,
        }
    }

    #[test]
    fn a_template_reads_as_its_name_and_version_and_its_details_skip_empty_parts() {
        // templateLabel: [name, version].filter(Boolean).join(" ").
        assert_eq!(label(&item("a", "Lab paper", "2026")), "Lab paper 2026");
        assert_eq!(label(&item("a", "Lab paper", "")), "Lab paper");
        let mut with_url = item("a", "x", "");
        with_url.source_url = "https://example.org/t".into();
        assert_eq!(details(&with_url), "https://example.org/t, main.tex, pdf");
    }

    #[test]
    fn a_reload_keeps_a_template_saved_meanwhile_after_the_stored_ones() {
        let mut mine = MyTemplates::default();
        mine.items.push(item("new", "Saved here", ""));
        mine.loaded(Ok(vec![item("old", "Stored", "")]));
        let ids: Vec<_> = mine.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["old", "new"]);
        mine.loaded(Ok(vec![item("old", "Stored", ""), item("new", "Saved here", "")]));
        assert_eq!(mine.items.len(), 2);
    }
}
