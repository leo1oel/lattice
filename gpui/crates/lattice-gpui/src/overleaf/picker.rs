//! "Open from Overleaf" (`overleaf-project-picker.tsx`,
//! `overleaf-picker-state.ts`, `overleaf-connect.css`): connect if needed,
//! browse every project the account can open in Overleaf's own order (or
//! paste a project or share link), see invitations still waiting on
//! Overleaf, then download one as a local project; for a project already
//! linked to a folder on this Mac, open that folder rather than a second
//! copy. With an unlinked project open, it also offers to upload it as a new
//! Overleaf project.
//!
//! Every state (checking, signed out, loading, empty, failed, the list)
//! renders inside one list frame at one minimum height, so moving between
//! them never makes the dialog jump; signed out, the dialog is a small one
//! holding the sign-in alone.

use std::{
    collections::BTreeMap,
    path::PathBuf,
    time::{Duration, Instant},
};

use gpui::{
    AnimationExt as _, AnyElement, App, AppContext as _, ClickEvent, Context, Entity, EventEmitter,
    FocusHandle, Focusable, FontWeight, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement as _, Render, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, Window, div, prelude::FluentBuilder as _, px, relative,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::overleaf::{
    LocalCopy, OverleafInvite, OverleafProject, OverleafProjectList, OverleafStatus, PastedLink,
};
use lattice_i18n::{join_phrases, locale, t};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::{
        Badge, Button, ButtonSize, ButtonVariant, CheckState, Checkbox, Field, IconButton,
        LayerPlacement, ModalLayer, rise_in,
    },
    fluid_hover::{FluidHover, ItemKind},
    motion::Motion,
    parity,
    reveal::{Arrival, loading_opacity, reveal},
    scrollbar::FluidScrollbar,
    tokens::{FONT_WEIGHT_SEMIBOLD, RADIUS_CONTROL, RADIUS_DIALOG, RADIUS_PANEL, RADIUS_PILL},
};

use super::{
    account::{self, Login, LoginEvent},
    download::{DownloadTrack, summarize},
    parts::{self, Tone, glyph, stage_message, stage_text, wash},
    sync,
};
use crate::{
    build::chip_mark::infinity_loader,
    confirm::{self, Confirm},
    history::widgets::inline_message,
    notices,
};

mod list;
mod render;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod scenario;
mod stage;
mod transfer;

/// What the picker tells the window.
pub enum PickerEvent {
    Dismiss,
    /// A project is ready on disk (downloaded, or the folder already linked
    /// to it): open it, in this window when `here`.
    Open {
        root: PathBuf,
        here: bool,
    },
    /// Upload the open project as a new Overleaf project named so; the
    /// window saves first, then answers with [`OverleafPicker::published`].
    Publish(String),
    /// The account's session changed (signed in here, or found expired).
    ConnectionChanged,
}

/// What the window tells the picker about itself.
pub struct PickerSetup {
    /// A project is open here, so Open gives the chosen one a window of its
    /// own, and "Open in this window" beside it puts it in this one.
    pub can_open_here: bool,
    /// The open project, when it is not linked: it can become a new
    /// Overleaf project.
    pub current_project: Option<String>,
    /// Folders the app knows of (its recent projects), checked for a link.
    pub known_folders: Vec<PathBuf>,
}

/// A pasted link's lookup.
#[derive(Default)]
struct Pasted {
    /// The link looked up (or about to be).
    link: Option<String>,
    answer: Option<PastedLink>,
    error: Option<SharedString>,
    checking: bool,
    task: Option<Task<()>>,
}

pub struct OverleafPicker {
    setup: PickerSetup,
    status: Option<OverleafStatus>,
    status_loading: Option<Instant>,
    status_error: Option<SharedString>,
    list: Option<OverleafProjectList>,
    projects_loading: Option<Instant>,
    projects_error: Option<SharedString>,
    /// An invitation was opened in the browser, so the list may be stale.
    invitation_opened: bool,
    /// The folder on this Mac already linked to a listed project, by id.
    local_copies: BTreeMap<String, LocalCopy>,
    copies_task: Option<Task<()>>,
    copies_for: Vec<String>,
    search: Entity<InputState>,
    publish_name: Entity<InputState>,
    show_archived: bool,
    selected: Option<String>,
    /// Opening a project, until it is known whether it opens a local copy or
    /// downloads.
    opening: Option<OverleafProject>,
    cloning: Option<OverleafProject>,
    /// How much of the download in flight has arrived, and when it started.
    downloaded: Option<(DownloadTrack, Instant)>,
    publishing: bool,
    transfer_error: Option<SharedString>,
    pasted: Pasted,
    login: Entity<Login>,
    scroll: ScrollHandle,
    focus: FocusHandle,
    task: Option<Task<()>>,
    /// The once-a-second clock a download's elapsed time and a stalled
    /// speed move on.
    clock: Option<Task<()>>,
    status_task: Option<Task<()>>,
    projects_task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<PickerEvent> for OverleafPicker {}

/// Whether search text is a link to look up rather than words to filter by:
/// a URL, or a host with a path, as an address bar copies it.
pub fn looks_like_link(text: &str) -> bool {
    let value = text.trim();
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return false;
    }
    let lower = value.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www.") {
        return value.len() > 4 && !lower.ends_with("://");
    }
    match value.split_once('/') {
        Some((host, path)) => {
            host.contains('.') && !host.starts_with('.') && !host.ends_with('.') && !path.is_empty()
        }
        None => false,
    }
}

/// When a project was updated, as the list says it (`relativeTime`).
pub fn relative_time(timestamp: &str) -> String {
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(timestamp) else {
        return t!("just now").into();
    };
    let elapsed = chrono::Utc::now().signed_duration_since(at);
    let minutes = elapsed.num_minutes();
    if elapsed.num_seconds() < 60 {
        return t!("just now").into();
    }
    if minutes < 60 {
        return t!("{minutes}m ago", minutes = minutes).into();
    }
    if minutes < 24 * 60 {
        return t!("{hours}h ago", hours = minutes / 60).into();
    }
    let local = at.with_timezone(&chrono::Local);
    if locale().is_chinese() {
        local.format("%Y/%-m/%-d").to_string()
    } else {
        local.format("%-m/%-d/%Y").to_string()
    }
}

/// The projects shown, newest first whoever owns them: the order of
/// Overleaf's own dashboard.
fn ordered(projects: &[OverleafProject], query: &str, show_archived: bool) -> Vec<OverleafProject> {
    let query = query.trim().to_lowercase();
    let matches = |values: &[Option<&str>]| {
        query.is_empty()
            || values
                .iter()
                .flatten()
                .any(|value| value.to_lowercase().contains(&query))
    };
    let mut shown: Vec<OverleafProject> = projects
        .iter()
        .filter(|project| show_archived || (!project.archived && !project.trashed))
        .filter(|project| {
            matches(&[
                Some(project.name.as_str()),
                project.owner_name.as_deref(),
                project.owner_email.as_deref(),
            ])
        })
        .cloned()
        .collect();
    let updated = |project: &OverleafProject| {
        project
            .last_updated
            .as_deref()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .map(|at| at.timestamp_millis())
            .unwrap_or(0)
    };
    shown.sort_by(|a, b| {
        updated(b)
            .cmp(&updated(a))
            .then_with(|| a.name.cmp(&b.name))
    });
    shown
}

impl OverleafPicker {
    pub fn new(setup: PickerSetup, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(t!("Search by project or owner, or paste a link…"))
        });
        let publish_name = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_value(
                setup.current_project.clone().unwrap_or_default(),
                window,
                cx,
            );
            input
        });
        let login = cx.new(|_| Login::default());
        let subscriptions = vec![
            cx.subscribe(&search, |this, _, event, cx| match event {
                InputEvent::Change => this.searched(cx),
                InputEvent::PressEnter { .. } => this.open_current(false, cx),
                _ => {}
            }),
            cx.subscribe(&publish_name, |this, _, event, cx| match event {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => this.publish(cx),
                _ => {}
            }),
            cx.subscribe(&login, |this, _, event, cx| match event {
                LoginEvent::Connected(session) => {
                    this.status = Some(session.clone());
                    cx.emit(PickerEvent::ConnectionChanged);
                    this.load_projects(cx);
                    cx.notify();
                }
            }),
            cx.observe(&login, |_, _, cx| cx.notify()),
        ];
        let mut picker = Self {
            setup,
            status: None,
            status_loading: None,
            status_error: None,
            list: None,
            projects_loading: None,
            projects_error: None,
            invitation_opened: false,
            local_copies: BTreeMap::new(),
            copies_task: None,
            copies_for: Vec::new(),
            search,
            publish_name,
            show_archived: false,
            selected: None,
            opening: None,
            cloning: None,
            downloaded: None,
            publishing: false,
            transfer_error: None,
            pasted: Pasted::default(),
            login,
            scroll: ScrollHandle::new(),
            focus: cx.focus_handle(),
            task: None,
            clock: None,
            status_task: None,
            projects_task: None,
            _subscriptions: subscriptions,
        };
        picker.load_status(cx);
        picker
    }

    pub fn focus_search(&self, window: &mut Window, cx: &mut App) {
        self.search.update(cx, |input, cx| input.focus(window, cx));
    }

    /// A download, upload or open is under way.
    fn working(&self) -> bool {
        self.opening.is_some() || self.transferring()
    }

    /// A download or upload is under way: the dialog stays until it ends.
    pub fn transferring(&self) -> bool {
        self.cloning.is_some() || self.publishing
    }

    fn known(&self) -> Option<&OverleafStatus> {
        (self.status_loading.is_none() && self.status_error.is_none())
            .then_some(self.status.as_ref())
            .flatten()
    }

    fn load_status(&mut self, cx: &mut Context<Self>) {
        self.status_loading = Some(Instant::now());
        cx.notify();
        let read = cx.background_spawn(async move { account::status() });
        self.status_task = Some(cx.spawn(async move |this, cx| {
            let status = read.await;
            this.update(cx, |this, cx| {
                this.status_loading = None;
                match status {
                    Ok(status) => {
                        this.status_error = None;
                        let connected = status.connected;
                        this.status = Some(status);
                        if connected {
                            this.load_projects(cx);
                        }
                    }
                    Err(error) => this.status_error = Some(error.into()),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// A failed request: an expired session becomes the reconnect state,
    /// anything else is reported by `report`.
    fn failed(
        &mut self,
        error: String,
        expired: bool,
        cx: &mut Context<Self>,
        report: impl FnOnce(&mut Self, String, &mut Context<Self>),
    ) {
        if expired || error.contains("Overleaf session expired") {
            super::session_changed(cx);
            self.list = None;
            self.projects_error = None;
            self.projects_loading = None;
            cx.emit(PickerEvent::ConnectionChanged);
            self.load_status(cx);
            return;
        }
        report(self, error, cx);
        cx.notify();
    }

    fn load_projects(&mut self, cx: &mut Context<Self>) {
        self.projects_loading = Some(Instant::now());
        self.list = None;
        self.invitation_opened = false;
        cx.notify();
        let read = cx.background_spawn(async move { sync::list_projects() });
        self.projects_task = Some(cx.spawn(async move |this, cx| {
            let (list, expired) = read.await;
            this.update(cx, |this, cx| {
                this.projects_loading = None;
                match list {
                    Ok(list) => {
                        this.projects_error = None;
                        this.list = Some(list);
                        this.look_up_copies(cx);
                    }
                    Err(error) => this.failed(error, expired, cx, |this, error, _| {
                        this.projects_error = Some(error.into())
                    }),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Which listed projects already have a folder on this Mac, each read
    /// from that folder's own link.
    fn look_up_copies(&mut self, cx: &mut Context<Self>) {
        let mut names: Vec<String> = self
            .list
            .as_ref()
            .map(|list| list.projects.iter().map(|p| p.name.clone()).collect())
            .unwrap_or_default();
        if let Some(PastedLink::Project { project }) = &self.pasted.answer {
            names.push(project.name.clone());
        }
        if names.is_empty() || names == self.copies_for {
            return;
        }
        self.copies_for = names.clone();
        let known = self.setup.known_folders.clone();
        let read = cx.background_spawn(async move { sync::local_copies(&names, &known) });
        self.copies_task = Some(cx.spawn(async move |this, cx| {
            let copies = read.await;
            this.update(cx, |this, cx| {
                this.local_copies = copies;
                cx.notify();
            })
            .ok();
        }));
    }

    fn query(&self, cx: &App) -> String {
        self.search.read(cx).value().to_string()
    }

    /// The search text changed: a link is looked up after a short pause,
    /// so typing one out by hand asks once.
    fn searched(&mut self, cx: &mut Context<Self>) {
        let text = self.query(cx);
        let connected = self.known().is_some_and(|status| status.connected);
        let link = (connected && looks_like_link(&text)).then(|| text.trim().to_string());
        if link == self.pasted.link {
            cx.notify();
            return;
        }
        self.look_up(link, cx);
    }

    fn look_up(&mut self, link: Option<String>, cx: &mut Context<Self>) {
        self.pasted = Pasted {
            checking: link.is_some(),
            link: link.clone(),
            ..Pasted::default()
        };
        cx.notify();
        let Some(link) = link else {
            return;
        };
        self.pasted.task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(250))
                .await;
            let asked = link.clone();
            let (answer, expired) = cx
                .background_spawn(async move { sync::resolve_link(&asked) })
                .await;
            this.update(cx, |this, cx| {
                if this.pasted.link.as_deref() != Some(link.as_str()) {
                    return;
                }
                this.pasted.checking = false;
                match answer {
                    Ok(answer) => {
                        this.pasted.answer = Some(answer);
                        this.look_up_copies(cx);
                    }
                    Err(error) => this.failed(error, expired, cx, |this, error, _| {
                        this.pasted.error = Some(error.into())
                    }),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// The projects in the order the list shows them: the one a pasted link
    /// opens, or the account's, newest first.
    fn rows(&self, cx: &App) -> Vec<OverleafProject> {
        if self.pasted.link.is_some() {
            return match &self.pasted.answer {
                Some(PastedLink::Project { project }) => vec![(**project).clone()],
                _ => Vec::new(),
            };
        }
        self.list
            .as_ref()
            .map(|list| ordered(&list.projects, &self.query(cx), self.show_archived))
            .unwrap_or_default()
    }

    fn invites(&self, cx: &App) -> Vec<OverleafInvite> {
        if self.pasted.link.is_some() {
            return Vec::new();
        }
        let query = self.query(cx).trim().to_lowercase();
        self.list
            .as_ref()
            .map(|list| {
                list.invites
                    .iter()
                    .filter(|invite| {
                        query.is_empty()
                            || invite.project_name.to_lowercase().contains(&query)
                            || invite
                                .inviter_name
                                .as_deref()
                                .is_some_and(|name| name.to_lowercase().contains(&query))
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        self.selected = Some(id);
        cx.notify();
    }

    /// Step the selection by `delta` rows (Home and End to the ends).
    fn step(&mut self, delta: isize, to_end: Option<bool>, cx: &mut Context<Self>) {
        let rows = self.rows(cx);
        if self.working() || rows.is_empty() {
            return;
        }
        let current = self
            .selected
            .as_ref()
            .and_then(|id| rows.iter().position(|row| &row.id == id));
        let next = match to_end {
            Some(false) => 0,
            Some(true) => rows.len() - 1,
            None => match current {
                Some(at) => (at as isize + delta).clamp(0, rows.len() as isize - 1) as usize,
                None => 0,
            },
        };
        self.selected = Some(rows[next].id.clone());
        // The list's child for the row: the invitations' heading, their
        // rows and the projects' heading stand before the projects.
        let invites = self.invites(cx).len();
        let ahead = if invites == 0 { 0 } else { invites + 2 };
        self.scroll.scroll_to_item(ahead + next);
        cx.notify();
    }

    /// Enter: open the selected row, or the one project a pasted link opens.
    fn open_current(&mut self, here: bool, cx: &mut Context<Self>) {
        let rows = self.rows(cx);
        let chosen = if self.pasted.link.is_some() {
            rows.first().cloned()
        } else {
            self.selected
                .as_ref()
                .and_then(|id| rows.iter().find(|row| &row.id == id).cloned())
        };
        if let Some(project) = chosen {
            self.open_project(project, here, cx);
        }
    }

    fn dismiss(&mut self, cx: &mut Context<Self>) {
        if !self.transferring() {
            cx.emit(PickerEvent::Dismiss);
        }
    }
}

/// A question as the Tauri app's `confirmAction` shows one: its first
/// paragraph the title, the rest the body.
fn split_question(text: &str) -> (String, String) {
    match text.split_once("\n\n") {
        Some((title, body)) => (title.trim().to_string(), body.trim().to_string()),
        None => (text.trim().to_string(), String::new()),
    }
}

impl Focusable for OverleafPicker {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str, name: &str, updated: Option<&str>, archived: bool) -> OverleafProject {
        OverleafProject {
            id: id.into(),
            name: name.into(),
            last_updated: updated.map(Into::into),
            owner_email: Some("mina@example.edu".into()),
            owner_name: Some("Mina Park".into()),
            access_level: Some("owner".into()),
            archived,
            trashed: false,
        }
    }

    #[test]
    fn links_are_told_from_words() {
        assert!(looks_like_link("https://www.overleaf.com/project/64f1"));
        assert!(looks_like_link("www.overleaf.com/read/abc"));
        assert!(looks_like_link("overleaf.com/project/1"));
        assert!(!looks_like_link("attention paper"));
        assert!(!looks_like_link("thesis.tex"));
        assert!(!looks_like_link(""));
    }

    #[test]
    fn the_list_is_newest_first_and_hides_the_archived_unless_asked() {
        let projects = [
            project("a", "Old", Some("2026-01-01T00:00:00Z"), false),
            project("b", "New", Some("2026-11-01T00:00:00Z"), false),
            project("c", "Shelved", Some("2026-11-12T00:00:00Z"), true),
        ];
        let names =
            |shown: Vec<OverleafProject>| shown.into_iter().map(|p| p.name).collect::<Vec<_>>();
        assert_eq!(names(ordered(&projects, "", false)), ["New", "Old"]);
        assert_eq!(
            names(ordered(&projects, "", true)),
            ["Shelved", "New", "Old"]
        );
        assert_eq!(names(ordered(&projects, "mina", false)), ["New", "Old"]);
        assert_eq!(names(ordered(&projects, "old", false)), ["Old"]);
    }

    #[test]
    fn a_question_splits_into_its_title_and_body() {
        assert_eq!(
            split_question("Upload?\n\nLattice will create it."),
            ("Upload?".into(), "Lattice will create it.".into())
        );
        assert_eq!(
            split_question("Just this"),
            ("Just this".into(), String::new())
        );
    }
}
