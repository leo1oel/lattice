//! The welcome screen: what a window shows with no project open, as the
//! Tauri app draws it (`Welcome` in `src/project/project-dialogs.tsx`,
//! `.welcome-*` in `src/styles/dialogs.css`).
//!
//! Over the lattice field (`field`), a 520px column centred in the window:
//! the mark weaving itself in a 50px frame, "Lattice" in the display serif
//! (36 to 48px with the window), then New project, Open folder and Guided
//! tutorial; the projects to go back to (why the last one could not reopen,
//! then the desk of up to three, `desk`); and quieter, the other ways in:
//! Clone repository, Import ZIP, Install LaTeX tools. Its 48px top strip
//! drags the window and holds Settings at the right. The column rises 6px
//! into place on the slow tier, the actions, the desk and the other ways in
//! 60 ms after the title. A window shorter than 620px drops the desk.
//!
//! ⌘1 to ⌘3 open the desk's projects, as in the app.

mod desk;
mod field;
mod mark;
pub mod new_project;

use std::path::{Path, PathBuf};

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, AppContext as _, Context, ElementId, Entity,
    EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _, Window,
    WindowControlArea, div, prelude::FluentBuilder as _, px, relative,
};
use gpui_kit::component::InteractiveElementExt as _;
use lattice_ui::{
    ActiveLattice as _, Icon, Motion, TextRole, TextRoleStyle as _,
    components::{Button, IconButton},
    icons::ICON_LARGE,
    tokens::FONT_WEIGHT_REGULAR,
};

use crate::{
    recents::{RecentProject, RecentProjects, now_ms},
    shell::commands::{SwitchWorkspace1, SwitchWorkspace2, SwitchWorkspace3},
};
use field::LatticeField;
use mark::LatticeMark;

/// What the welcome screen asks the window to do.
#[derive(Clone, Debug, PartialEq)]
pub enum WelcomeEvent {
    NewProject,
    OpenFolder,
    Tutorial,
    OpenRecent(PathBuf),
    CloneRepository,
    ImportZip,
    InstallLatexTools,
    Settings,
}

/// A recent project launch could not reopen, with lattice-core's reason.
#[derive(Clone, Debug)]
pub struct Unopened {
    pub project: RecentProject,
    pub reason: String,
}

pub struct Welcome {
    focus: FocusHandle,
    field: Entity<LatticeField>,
    mark: Entity<LatticeMark>,
    unopened: Option<Unopened>,
    /// What the window is doing meanwhile ("Creating project…").
    busy: Option<String>,
    /// When the desk's ages are read against: when it was laid out.
    now: u64,
}

impl EventEmitter<WelcomeEvent> for Welcome {}

impl Welcome {
    pub fn new(unopened: Option<Unopened>, cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            field: cx.new(LatticeField::new),
            mark: cx.new(|cx| LatticeMark::new(34., cx)),
            unopened,
            busy: None,
            now: now_ms(),
        }
    }

    pub fn set_busy(&mut self, busy: Option<String>, cx: &mut Context<Self>) {
        self.busy = busy;
        cx.notify();
    }

    /// The projects the desk lays out, in order: never the one launch could
    /// not reopen.
    fn desk_projects(&self, cx: &App) -> Vec<RecentProject> {
        let unopened = self
            .unopened
            .as_ref()
            .map(|unopened| &unopened.project.path);
        RecentProjects::list(cx)
            .iter()
            .filter(|project| Some(&project.path) != unopened)
            .take(desk::DESK_SIZE)
            .cloned()
            .collect()
    }

    fn open_at(&mut self, ix: usize, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        if let Some(project) = self.desk_projects(cx).get(ix) {
            cx.emit(WelcomeEvent::OpenRecent(project.path.clone()));
        }
    }

    /// The desk's projects' names, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn desk_names(&self, cx: &App) -> Vec<String> {
        self.desk_projects(cx)
            .into_iter()
            .map(|project| project.name)
            .collect()
    }
}

/// The folder is gone (lattice-core's not-found errors), or it failed for
/// another reason, which is quoted.
fn unopened_message(unopened: &Unopened) -> String {
    let reason = unopened.reason.to_lowercase();
    let name = &unopened.project.name;
    if reason.contains("no such file") || reason.contains("not a folder") {
        format!("Couldn’t reopen “{name}”. Its folder may have been moved or renamed")
    } else {
        format!("Couldn’t reopen “{name}”: {}", unopened.reason)
    }
}

/// Rise 6px into place and fade in on the slow tier, `delay_ms` late.
fn rise(id: impl Into<ElementId>, delay_ms: f32, content: impl IntoElement) -> AnyElement {
    let slow = Motion::Slow.duration().as_secs_f32() * 1000.;
    let total = slow + delay_ms;
    div()
        .relative()
        .child(content)
        .with_animation(
            id,
            Animation::new(std::time::Duration::from_secs_f32(total / 1000.)),
            move |this, t| {
                let local = ((t * total - delay_ms) / slow).clamp(0., 1.);
                let eased = Motion::Slow.sample(local);
                this.top(px(6. * (1. - eased))).opacity(local)
            },
        )
        .into_any_element()
}

/// One of the quieter ways in: 28px, caption, secondary ink, the hairline
/// wash under the pointer.
fn more_action(
    id: &'static str,
    icon: Icon,
    label: &'static str,
    cx: &mut Context<Welcome>,
    event: WelcomeEvent,
) -> impl IntoElement {
    let palette = cx.palette().clone();
    let (hover_ink, hover_wash) = (palette.text, palette.line);
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(6.))
        .h(px(28.))
        .px(px(10.))
        .rounded(px(6.))
        .text_role(TextRole::Caption, cx)
        .font_weight(FONT_WEIGHT_REGULAR)
        .text_color(palette.text_secondary)
        .whitespace_nowrap()
        .cursor_pointer()
        .hover(move |style| style.bg(hover_wash).text_color(hover_ink))
        .on_click(cx.listener(move |_, _, _, cx| cx.emit(event.clone())))
        .child(icon.element(px(15.), palette.text_secondary))
        .child(label)
}

impl Focusable for Welcome {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Welcome {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let busy = self.busy.is_some();
        let column = px(520.).min(viewport.width - px(48.));
        let recents_width = px(720.).min(viewport.width - px(64.));
        let title_size = (f32::from(viewport.width) * 0.044).clamp(36., 48.);
        let desk_projects = self.desk_projects(cx);
        let show_desk = !desk_projects.is_empty() && viewport.height >= px(620.);
        let weak = cx.entity().downgrade();
        let desk = show_desk.then(|| {
            desk::desk(
                &desk_projects,
                recents_width,
                self.now,
                busy,
                move |path: &Path, _, cx| {
                    let path = path.to_path_buf();
                    weak.update(cx, |_, cx| cx.emit(WelcomeEvent::OpenRecent(path)))
                        .ok();
                },
                window,
                cx,
            )
        });
        let unopened = self.unopened.as_ref().map(|unopened| {
            div()
                .flex()
                .items_start()
                .gap(px(6.))
                .px(px(2.))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(
                    div()
                        .flex_none()
                        .pt(px(1.5))
                        .child(Icon::TRIANGLE_ALERT.element(px(13.), palette.warning)),
                )
                .child(div().min_w_0().child(unopened_message(unopened)))
        });
        let has_recents = unopened.is_some() || desk.is_some();
        let actions = div()
            .mt(px(24.))
            .flex()
            .flex_wrap()
            .justify_center()
            .gap(px(8.))
            .child(
                Button::new("welcome-new-project", "New project")
                    .primary()
                    .icon(Icon::PLUS)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(WelcomeEvent::NewProject))),
            )
            .child(
                Button::new("welcome-open-folder", "Open folder")
                    .icon(Icon::FOLDER)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(WelcomeEvent::OpenFolder))),
            )
            .child(
                Button::new("welcome-tutorial", "Guided tutorial")
                    .ghost()
                    .icon(Icon::SPARKLES)
                    .disabled(busy)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(WelcomeEvent::Tutorial))),
            );
        let more = div()
            .mt(px(16.))
            .flex()
            .flex_wrap()
            .justify_center()
            .items_center()
            .gap(px(4.))
            .child(more_action(
                "welcome-clone",
                Icon::GIT_BRANCH,
                "Clone repository",
                cx,
                WelcomeEvent::CloneRepository,
            ))
            .child(more_action(
                "welcome-import-zip",
                Icon::FILE_ARCHIVE,
                "Import ZIP",
                cx,
                WelcomeEvent::ImportZip,
            ))
            .child(more_action(
                "welcome-install-tex",
                Icon::WRENCH,
                "Install LaTeX tools",
                cx,
                WelcomeEvent::InstallLatexTools,
            ));
        let content = div()
            .relative()
            .w(column)
            .h_full()
            .mx_auto()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .pb(px(20.))
            .child(rise(
                "welcome-mark-in",
                0.,
                div()
                    .size(px(50.))
                    .rounded(px(14.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(self.mark.clone()),
            ))
            .child(rise(
                "welcome-title-in",
                0.,
                div()
                    .mt(px(20.))
                    .font_family(cx.lattice().fonts.display.clone())
                    .text_size(px(title_size))
                    .line_height(relative(1.08))
                    .font_weight(FONT_WEIGHT_REGULAR)
                    .letter_spacing(relative(-0.02))
                    .text_color(palette.text)
                    .child("Lattice"),
            ))
            .child(rise("welcome-actions-in", 60., actions))
            .when(has_recents, |this| {
                this.child(rise(
                    "welcome-recents-in",
                    60.,
                    div()
                        .w(recents_width)
                        .mt(px(32.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(8.))
                        .children(unopened.map(|message| div().w_full().child(message)))
                        .children(desk),
                ))
            })
            .child(rise("welcome-more-in", 60., more))
            .children(self.busy.clone().map(|busy| {
                div()
                    .mt(px(16.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_role(TextRole::Micro, cx)
                    .text_color(palette.text_secondary)
                    .child(Icon::LOADER.element(px(15.), palette.text_secondary))
                    .child(busy)
            }));
        div()
            .id("welcome")
            .key_context("LatticeWelcome")
            .track_focus(&self.focus)
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(palette.window)
            .on_action(cx.listener(|this, _: &SwitchWorkspace1, _, cx| this.open_at(0, cx)))
            .on_action(cx.listener(|this, _: &SwitchWorkspace2, _, cx| this.open_at(1, cx)))
            .on_action(cx.listener(|this, _: &SwitchWorkspace3, _, cx| this.open_at(2, cx)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| this.focus.focus(window, cx)),
            )
            .child(self.field.clone())
            .child(content)
            .child(
                div()
                    .id("welcome-titlebar")
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(48.))
                    .flex()
                    .justify_end()
                    .items_center()
                    .px(px(14.))
                    .window_control_area(WindowControlArea::Drag)
                    .on_double_click(|_, window, _| window.titlebar_double_click())
                    .child(
                        IconButton::new("welcome-settings", Icon::SETTINGS)
                            .icon_size(ICON_LARGE)
                            .tooltip("Settings")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(WelcomeEvent::Settings))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unopened(reason: &str) -> Unopened {
        Unopened {
            project: RecentProject {
                name: "Thesis draft".into(),
                path: "/Users/writer/Moved/thesis-draft".into(),
                opened_at: None,
            },
            reason: reason.into(),
        }
    }

    #[test]
    fn a_vanished_folder_says_it_may_have_moved() {
        assert_eq!(
            unopened_message(&unopened("No such file or directory (os error 2)")),
            "Couldn’t reopen “Thesis draft”. Its folder may have been moved or renamed"
        );
        assert_eq!(
            unopened_message(&unopened("permission denied")),
            "Couldn’t reopen “Thesis draft”: permission denied"
        );
    }
}
