//! Clone repository, as the Tauri app asks for one
//! (`src/project/clone-repository-dialog.tsx`, `clone-repository.ts` and
//! `clone-repository-dialog.css`): a 460px dialog with the repository's URL
//! and where it goes (the URL's name inside the parent of the project opened
//! last, else Documents; typed over, or chosen with Choose…), a progress bar
//! while git runs, and what went wrong in the writer's words with git's own
//! under it. git signs in as it does in a terminal and never stops to ask;
//! Cancel stops it. lattice-core runs the clone (`git::clone`).

use std::path::{Path, PathBuf};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ParentElement as _,
    PathPromptOptions, Render, Styled as _, Subscription, Task, Window, div, px, relative,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::git::clone::{self as git_clone, CloneError, CloneProgress};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Field, rise_in},
    tokens::FONT_WEIGHT_MEDIUM,
};

pub enum CloneEvent {
    Dismiss,
    /// The clone finished: the folder it made.
    Cloned(PathBuf),
}

pub struct CloneDialog {
    url: Entity<InputState>,
    destination: Entity<InputState>,
    /// The folder the clone goes in, unless a destination was typed.
    parent: PathBuf,
    /// The destination was typed or chosen, rather than following the URL.
    typed: bool,
    /// What following the URL last wrote in the destination.
    followed: String,
    progress: Option<CloneProgress>,
    error: Option<CloneError>,
    /// The name lattice-core knows this dialog's clone by, for Cancel.
    label: String,
    focus: FocusHandle,
    task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<CloneEvent> for CloneDialog {}

/// The folder name git would pick for `url`: its last path part less
/// `.git`; empty while the URL names none.
pub fn repository_name(url: &str) -> String {
    let trimmed = url.trim();
    let path = match trimmed.find("://") {
        Some(at) => {
            let rest = &trimmed[at + 3..];
            let rest = rest.split(['?', '#']).next().unwrap_or_default();
            rest.find('/').map_or("", |slash| &rest[slash..])
        }
        None => trimmed.split_once(':').map_or(trimmed, |(_, path)| path),
    };
    let last = path
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or_default();
    let name = last.strip_suffix(".git").unwrap_or(last).trim();
    if name == "." || name == ".." {
        String::new()
    } else {
        name.to_string()
    }
}

/// Where the clone goes while the destination follows `url`: its name
/// inside `parent`, or nothing while either is missing.
fn followed_destination(parent: &Path, url: &str) -> String {
    let name = repository_name(url);
    if name.is_empty() || parent.as_os_str().is_empty() {
        String::new()
    } else {
        parent.join(name).to_string_lossy().into_owned()
    }
}

/// A destination `shown` was typed when it is neither empty nor what
/// following the URL last wrote.
fn is_typed(shown: &str, followed: &str) -> bool {
    !shown.is_empty() && shown != followed
}

impl CloneDialog {
    /// `recent`: the project opened last, whose folder's parent is the first
    /// place offered.
    pub fn new(recent: Option<&Path>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let parent = recent
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .or_else(dirs::document_dir)
            .unwrap_or_default();
        let url = cx.new(|cx| {
            InputState::new(window, cx).placeholder("https://github.com/owner/paper.git")
        });
        let destination = cx.new(|cx| InputState::new(window, cx));
        let subscriptions = vec![
            cx.subscribe_in(&url, window, |this, _, event, window, cx| match event {
                InputEvent::Change => {
                    this.error = None;
                    this.follow_url(window, cx);
                }
                InputEvent::PressEnter { .. } => this.clone_now(cx),
                _ => {}
            }),
            cx.subscribe(&destination, |this, _, event, cx| match event {
                InputEvent::Change => {
                    this.error = None;
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => this.clone_now(cx),
                _ => {}
            }),
        ];
        Self {
            url,
            destination,
            parent,
            typed: false,
            followed: String::new(),
            progress: None,
            error: None,
            label: format!("gpui-clone-{}", cx.entity_id()),
            focus: cx.focus_handle(),
            task: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn focus_input(&self, window: &mut Window, cx: &mut App) {
        self.url.update(cx, |input, cx| input.focus(window, cx));
    }

    /// The destination follows the URL's name inside the parent until one
    /// is typed.
    fn follow_url(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.typed_destination(cx) {
            return;
        }
        let destination = followed_destination(&self.parent, &self.url.read(cx).value());
        self.followed = destination.clone();
        self.destination
            .update(cx, |input, cx| input.set_value(destination, window, cx));
        cx.notify();
    }

    /// Whether the destination field holds something other than what
    /// following the URL last wrote there.
    fn typed_destination(&self, cx: &App) -> bool {
        self.typed || is_typed(&self.destination.read(cx).value(), &self.followed)
    }

    fn choose_parent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose where to clone the repository".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else {
                return;
            };
            let Some(parent) = paths.into_iter().next() else {
                return;
            };
            this.update_in(cx, |this, window, cx| {
                this.parent = parent;
                this.typed = false;
                this.destination
                    .update(cx, |input, cx| input.set_value("", window, cx));
                this.error = None;
                this.follow_url(window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn cloning(&self) -> bool {
        self.progress.is_some()
    }

    fn clone_now(&mut self, cx: &mut Context<Self>) {
        let url = self.url.read(cx).value().trim().to_string();
        let destination = self.destination.read(cx).value().trim().to_string();
        if self.cloning() || url.is_empty() || destination.is_empty() {
            return;
        }
        self.typed = self.typed_destination(cx);
        self.progress = Some(CloneProgress {
            stage: "connecting",
            progress: 0.,
        });
        self.error = None;
        let label = self.label.clone();
        let (sender, mut receiver) = mpsc::unbounded::<CloneProgress>();
        let destination = PathBuf::from(destination);
        let target = destination.clone();
        let run = cx.background_executor().spawn(async move {
            git_clone::clone(&label, &url, &target, move |progress| {
                sender.unbounded_send(progress).ok();
            })
        });
        self.task = Some(cx.spawn(async move |this, cx| {
            let updates = cx.spawn({
                let this = this.clone();
                async move |cx| {
                    while let Some(progress) = receiver.next().await {
                        let landed = this.update(cx, |this, cx| {
                            // A report that lands after the clone stopped
                            // is dropped.
                            if this.progress.is_some() {
                                this.progress = Some(progress);
                                cx.notify();
                            }
                        });
                        if landed.is_err() {
                            break;
                        }
                    }
                }
            });
            let result = run.await;
            drop(updates);
            this.update(cx, |this, cx| {
                this.progress = None;
                match result {
                    Ok(()) => cx.emit(CloneEvent::Cloned(destination)),
                    // A cancel goes back to the form as it was.
                    Err(CloneError::Cancelled) => {}
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn cancel(&mut self, cx: &mut Context<Self>) {
        if self.cloning() {
            git_clone::cancel(&self.label);
        } else {
            cx.emit(CloneEvent::Dismiss);
        }
    }

    fn error_copy(&self, error: &CloneError, cx: &App) -> (String, Option<String>) {
        let destination = self.destination.read(cx).value().to_string();
        let name = destination
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string();
        match error {
            CloneError::InvalidUrl => ("That isn’t a Git repository URL".into(), None),
            CloneError::FolderExists => (
                format!("“{name}” already exists there. Choose another location"),
                None,
            ),
            CloneError::NoParent => ("The folder to clone into doesn’t exist".into(), None),
            CloneError::GitMissing => (
                "Git isn’t installed. Install the Xcode Command Line Tools, then try again".into(),
                None,
            ),
            CloneError::Auth(detail) => (
                "Git couldn’t sign in to this repository".into(),
                Some(detail.clone()),
            ),
            CloneError::NotFound(detail) => (
                "Couldn’t find this repository, or your account can’t access it".into(),
                Some(detail.clone()),
            ),
            CloneError::Network(detail) => {
                ("Couldn’t reach the server".into(), Some(detail.clone()))
            }
            CloneError::Cancelled => (String::new(), None),
            CloneError::Failed(detail) => ("The clone didn’t finish".into(), Some(detail.clone())),
        }
    }
}

impl Drop for CloneDialog {
    /// A clone still running when the dialog goes stops.
    fn drop(&mut self) {
        if self.progress.is_some() {
            git_clone::cancel(&self.label);
        }
    }
}

fn stage_copy(progress: &CloneProgress) -> String {
    let percent = (progress.progress * 100.).round();
    match progress.stage {
        "connecting" => "Connecting…".into(),
        "receiving" => format!("Downloading… {percent}%"),
        "resolving" => format!("Resolving changes… {percent}%"),
        _ => format!("Checking out files… {percent}%"),
    }
}

impl Focusable for CloneDialog {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.url.focus_handle(cx)
    }
}

impl Render for CloneDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let width = px(460.).min(viewport.width - px(40.));
        let cloning = self.cloning();
        let ready = !self.url.read(cx).value().trim().is_empty()
            && !self.destination.read(cx).value().trim().is_empty();
        let invalid_url = matches!(self.error, Some(CloneError::InvalidUrl));
        let invalid_place = matches!(
            self.error,
            Some(CloneError::FolderExists | CloneError::NoParent)
        );
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
        let progress = self.progress.as_ref().map(|progress| {
            let fill = progress.progress.clamp(0., 1.) as f32;
            div()
                .mt(px(16.))
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .h(px(6.))
                        .rounded(px(999.))
                        .overflow_hidden()
                        .bg(palette.line)
                        .child(
                            div()
                                .h_full()
                                .w(relative(fill))
                                .rounded(px(999.))
                                .bg(palette.accent),
                        ),
                )
                .child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(stage_copy(progress)),
                )
        });
        let error = self
            .error
            .as_ref()
            .map(|error| self.error_copy(error, cx))
            .filter(|(copy, _)| !copy.is_empty())
            .map(|(copy, detail)| {
                div()
                    .mt(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap(px(6.))
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text)
                            .child(
                                div()
                                    .flex_none()
                                    .pt(px(1.5))
                                    .child(Icon::CIRCLE_ALERT.element(px(13.), palette.danger)),
                            )
                            .child(div().min_w_0().child(copy)),
                    )
                    .children(detail.filter(|detail| !detail.is_empty()).map(|detail| {
                        div()
                            .text_role(TextRole::Micro, cx)
                            .line_height(px(16.))
                            .font_family(cx.lattice().fonts.editor.clone())
                            .text_color(palette.text_secondary)
                            .child(detail)
                    }))
            });
        let card = div()
            .id("clone-repository")
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
                    .child("Clone a Git repository"),
            )
            .child(
                div()
                    .pt(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(label(
                        "Repository URL",
                        Field::new(&self.url)
                            .invalid(invalid_url)
                            .disabled(cloning)
                            .into_any_element(),
                        cx,
                    ))
                    .child(label(
                        "Location",
                        div()
                            .flex()
                            .gap(px(6.))
                            .min_w_0()
                            .child(
                                div().flex_1().min_w_0().child(
                                    Field::new(&self.destination)
                                        .invalid(invalid_place)
                                        .disabled(cloning),
                                ),
                            )
                            .child(
                                Button::new("clone-choose", "Choose…")
                                    .disabled(cloning)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.choose_parent(window, cx)
                                    })),
                            )
                            .into_any_element(),
                        cx,
                    )),
            )
            .children(progress)
            .children(error)
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .pt(px(24.))
                    .child(
                        Button::new("clone-cancel", "Cancel")
                            .ghost()
                            .on_click(cx.listener(|this, _, _, cx| this.cancel(cx))),
                    )
                    .child(
                        Button::new("clone-run", if cloning { "Cloning…" } else { "Clone" })
                            .primary()
                            .disabled(cloning || !ready)
                            .on_click(cx.listener(|this, _, _, cx| this.clone_now(cx))),
                    ),
            );
        div()
            .id("clone-repository-scrim")
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
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                // While git runs the dialog stays: Cancel stops the clone.
                if event.keystroke.key == "escape" && !this.cloning() {
                    cx.stop_propagation();
                    cx.emit(CloneEvent::Dismiss);
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    if !this.cloning() {
                        cx.emit(CloneEvent::Dismiss)
                    }
                }),
            )
            .child(rise_in("clone-repository-in", card))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{followed_destination, is_typed, repository_name};

    /// The destination after typing `url` one character at a time into the
    /// URL field, starting from `shown`, as `follow_url` updates it.
    fn type_url(parent: &Path, url: &str, mut shown: String) -> String {
        let mut followed = String::new();
        for end in 1..=url.len() {
            if !is_typed(&shown, &followed) {
                followed = followed_destination(parent, &url[..end]);
                shown = followed.clone();
            }
        }
        shown
    }

    #[test]
    fn the_destination_follows_a_url_typed_key_by_key() {
        let parent = Path::new("/Users/writer/Documents");
        assert_eq!(
            type_url(parent, "https://github.com/owner/paper.git", String::new()),
            "/Users/writer/Documents/paper"
        );
        assert_eq!(
            type_url(
                parent,
                "https://github.com/owner/paper.git",
                "/tmp/mine".into()
            ),
            "/tmp/mine"
        );
    }

    #[test]
    fn the_folder_is_the_repositorys_name() {
        assert_eq!(
            repository_name("https://github.com/owner/paper.git"),
            "paper"
        );
        assert_eq!(repository_name("git@github.com:owner/thesis.git"), "thesis");
        assert_eq!(repository_name("https://example.org/a/b/?x=1"), "b");
        assert_eq!(repository_name("https://github.com"), "");
        assert_eq!(repository_name(""), "");
    }
}
