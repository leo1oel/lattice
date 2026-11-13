//! New project (⌘⇧N), as the Tauri app asks for one (`CreateProjectDialog`
//! in `src/project/project-dialogs.tsx`, `.create-project-modal` in
//! `src/styles/dialogs.css`): a 440px dialog with its title in the serif,
//! the project's name (Untitled research when left empty) and its venue
//! template (NeurIPS by default), then Cancel and Choose location, which
//! asks where to create the folder. Enter in the name chooses too.
//!
//! The project is made by lattice-core (`create_with_venue`, as the Tauri
//! app's `create_project`), and an error lands under the fields.

use std::path::PathBuf;

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ParentElement as _, Render,
    Styled as _, Subscription, Window, div, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::{Button, Field, Select, rise_in},
    tokens::{CONTAINER_DIALOG_CREATE, FONT_WEIGHT_MEDIUM},
};

/// The templates a new project starts from, in the order the app lists
/// them, each with its name as the select shows it
/// (`src/project/project-venues.ts`).
pub const VENUES: [(&str, &str); 14] = [
    ("blank", "Blank article"),
    ("chinese-article", "Chinese article (ctexart)"),
    ("neurips", "NeurIPS 2026 (preprint)"),
    ("icml", "ICML 2026 (preprint)"),
    ("iclr", "ICLR 2026"),
    ("acl", "ACL / ARR (preprint)"),
    ("cvpr", "CVPR 2027"),
    ("cvpr-rebuttal", "CVPR 2027 Rebuttal"),
    ("aaai", "AAAI 2027 (preprint)"),
    ("ieee-conference", "IEEE conference paper (IEEEtran)"),
    ("ieee-journal", "IEEE journal article (IEEEtran)"),
    ("acm", "ACM paper (acmart)"),
    ("thuthesis", "Tsinghua University thesis (ThuThesis)"),
    ("ustcthesis", "USTC thesis (ustcthesis)"),
];
const DEFAULT_VENUE: usize = 2;
pub const UNTITLED: &str = "Untitled research";

pub enum NewProjectEvent {
    Dismiss,
    /// Create a project named `name` from `venue`; the window asks where.
    Create {
        name: String,
        venue: &'static str,
    },
}

pub struct NewProjectDialog {
    name: Entity<InputState>,
    venue: usize,
    error: Option<String>,
    focus: FocusHandle,
    _subscription: Subscription,
}

impl EventEmitter<NewProjectEvent> for NewProjectDialog {}

impl NewProjectDialog {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = cx.new(|cx| InputState::new(window, cx).placeholder(UNTITLED));
        let subscription = cx.subscribe(&name, |this, _, event, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.create(cx);
            }
        });
        Self {
            name,
            venue: DEFAULT_VENUE,
            error: None,
            focus: cx.focus_handle(),
            _subscription: subscription,
        }
    }

    pub fn focus_input(&self, window: &mut Window, cx: &mut App) {
        self.name.update(cx, |input, cx| input.focus(window, cx));
    }

    pub fn set_error(&mut self, error: Option<String>, cx: &mut Context<Self>) {
        self.error = error;
        cx.notify();
    }

    fn create(&mut self, cx: &mut Context<Self>) {
        let name = self.name.read(cx).value().trim().to_string();
        cx.emit(NewProjectEvent::Create {
            name: if name.is_empty() {
                UNTITLED.to_string()
            } else {
                name
            },
            venue: VENUES[self.venue].0,
        });
    }
}

/// Create the project in `parent` from the venue, with lattice-core.
pub fn create_project(parent: PathBuf, name: String, venue: &str) -> Result<PathBuf, String> {
    let venue = lattice_core::project::Venue::parse(venue)?;
    lattice_core::project::create_with_venue(&parent, &name, venue)
}

impl Focusable for NewProjectDialog {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.name.focus_handle(cx)
    }
}

impl Render for NewProjectDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let width = CONTAINER_DIALOG_CREATE
            .to_pixels(window.rem_size())
            .min(viewport.width - px(40.));
        let label = |text: &'static str, control: gpui::AnyElement, cx: &App| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text)
                .child(text)
                .child(control)
        };
        let venue = Select::new(
            "new-project-venue",
            VENUES.iter().map(|(_, label)| *label),
            Some(self.venue),
        )
        .placeholder("Choose a built-in template")
        .on_change(cx.listener(|this, ix: &usize, _, cx| {
            this.venue = *ix;
            cx.notify();
        }));
        let card = div()
            .id("new-project")
            .w(width)
            .flex()
            .flex_col()
            .pt(px(20.))
            .px(px(20.))
            .pb(px(16.))
            .rounded(px(14.))
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child("Create a research project"),
            )
            .child(
                div()
                    .pt(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(label(
                        "Project name",
                        Field::new(&self.name).into_any_element(),
                        cx,
                    ))
                    .child(label("Venue template", venue.into_any_element(), cx)),
            )
            .children(self.error.clone().map(|error| {
                div()
                    .pt(px(6.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.danger)
                    .child(error)
            }))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .pt(px(if self.error.is_some() { 16. } else { 24. }))
                    .child(
                        Button::new("new-project-cancel", "Cancel")
                            .ghost()
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(NewProjectEvent::Dismiss))),
                    )
                    .child(
                        Button::new("new-project-create", "Choose location")
                            .primary()
                            .on_click(cx.listener(|this, _, _, cx| this.create(cx))),
                    ),
            );
        div()
            .id("new-project-scrim")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .pt(viewport.height * 0.18)
            .bg(palette.scrim)
            .occlude()
            .track_focus(&self.focus)
            // Bubbling, so an open venue list takes its own Escape first.
            .on_key_down(cx.listener(|_, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    cx.emit(NewProjectEvent::Dismiss);
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.emit(NewProjectEvent::Dismiss)),
            )
            .child(rise_in("new-project-in", card))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_venue_is_one_lattice_core_knows() {
        for (id, _) in VENUES {
            assert!(lattice_core::project::Venue::parse(id).is_ok(), "{id}");
        }
        assert_eq!(VENUES[DEFAULT_VENUE].0, "neurips");
    }
}
