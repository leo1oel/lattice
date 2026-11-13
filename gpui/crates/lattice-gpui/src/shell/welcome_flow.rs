//! A window without a project, and the ways into one
//! (`src/app/use-project-lifecycle.ts`): the welcome screen, a launch that
//! reopens the project used last (or, on a first launch with nothing to
//! reopen, the guided tutorial), New project, the tutorial and Import ZIP.
//!
//! A launch reopens the newest recent project; when it cannot, the welcome
//! screen says why, and lists the others. Every project a window shows goes
//! to the front of the recent projects.

use std::path::PathBuf;

use gpui::{AppContext as _, Context, Entity, Focusable as _, PathPromptOptions, Window};

use super::{InstallLatexTools, OpenFolder, Shell};
use crate::{
    notices,
    recents::RecentProjects,
    welcome::{
        Unopened, Welcome, WelcomeEvent,
        new_project::{NewProjectDialog, NewProjectEvent, create_project},
    },
};

/// Where the tutorial is made, under the Documents folder, as the Tauri app
/// makes it.
const TUTORIALS: &str = "Lattice Tutorials";

/// The welcome screen and the New project dialog, while they are up.
#[derive(Default)]
pub(crate) struct Lobby {
    welcome: Option<Entity<Welcome>>,
    new_project: Option<Entity<NewProjectDialog>>,
}

impl Shell {
    /// A launch without a project named: reopen the one used last, else the
    /// tutorial on a first launch, else the welcome screen.
    pub fn launch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match RecentProjects::list(cx).first().cloned() {
            Some(last) => {
                // The empty Main window while it opens, rather than the
                // welcome screen flashing first.
                self.lobby.welcome = None;
                cx.spawn_in(window, async move |this, cx| {
                    let opened = crate::project::open(last.path.clone(), cx).await;
                    this.update_in(cx, |this, window, cx| match opened {
                        Ok(project) => this.set_project(project, window, cx),
                        Err(reason) => this.show_welcome(
                            Some(Unopened {
                                project: last,
                                reason,
                            }),
                            window,
                            cx,
                        ),
                    })
                    .ok();
                })
                .detach();
            }
            None => self.open_tutorial(window, cx),
        }
    }

    /// Show the welcome screen in place of the workspace.
    pub(crate) fn show_welcome(
        &mut self,
        unopened: Option<Unopened>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let welcome = cx.new(|cx| Welcome::new(unopened, cx));
        cx.subscribe_in(&welcome, window, Self::on_welcome_event)
            .detach();
        window.focus(&welcome.focus_handle(cx), cx);
        window.set_window_title("Lattice (GPUI preview)");
        self.lobby.welcome = Some(welcome);
        cx.notify();
    }

    /// The welcome screen, while the window has no project.
    pub(crate) fn welcome(&self) -> Option<&Entity<Welcome>> {
        self.lobby.welcome.as_ref()
    }

    /// The window shows a project now: the welcome screen goes, and the
    /// project goes to the front of the recent ones.
    pub(super) fn entered_project(&mut self, name: &str, cx: &mut Context<Self>) {
        self.lobby.welcome = None;
        self.lobby.new_project = None;
        if let Some(root) = self.root(cx) {
            RecentProjects::record(&root, name, cx);
        }
    }

    fn on_welcome_event(
        &mut self,
        _: &Entity<Welcome>,
        event: &WelcomeEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            WelcomeEvent::NewProject => self.open_new_project(window, cx),
            WelcomeEvent::OpenFolder => self.open_folder(&OpenFolder, window, cx),
            WelcomeEvent::Tutorial => self.open_tutorial(window, cx),
            WelcomeEvent::OpenRecent(path) => self.open_project(path.clone(), window, cx),
            WelcomeEvent::ImportZip => self.import_zip(window, cx),
            WelcomeEvent::InstallLatexTools => {
                self.install_latex_tools(&InstallLatexTools, window, cx)
            }
            WelcomeEvent::CloneRepository => notices::info(
                "Cloning comes to the GPUI preview later",
                "Clone the repository with Git, then open its folder here.",
                cx,
            ),
            WelcomeEvent::Settings => notices::info(
                "Settings come to the GPUI preview later",
                "The appearance commands are in the command palette (⌘K).",
                cx,
            ),
        }
    }

    /// Say what the window is doing on the welcome screen, if it shows.
    fn set_busy(&self, busy: Option<&str>, cx: &mut Context<Self>) {
        if let Some(welcome) = &self.lobby.welcome {
            welcome.update(cx, |welcome, cx| {
                welcome.set_busy(busy.map(str::to_string), cx)
            });
        }
    }

    /// ⌘⇧N: the New project dialog.
    pub(crate) fn open_new_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.lobby.new_project.is_some() {
            return;
        }
        let dialog = cx.new(|cx| NewProjectDialog::new(window, cx));
        cx.subscribe_in(
            &dialog,
            window,
            |this, dialog, event, window, cx| match event {
                NewProjectEvent::Dismiss => this.dismiss_new_project(window, cx),
                NewProjectEvent::Create { name, venue } => {
                    this.create_project(dialog.clone(), name.clone(), venue, window, cx)
                }
            },
        )
        .detach();
        dialog.update(cx, |dialog, cx| dialog.focus_input(window, cx));
        self.lobby.new_project = Some(dialog);
        cx.notify();
    }

    pub(crate) fn dismiss_new_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.lobby.new_project = None;
        match &self.lobby.welcome {
            Some(welcome) => window.focus(&welcome.focus_handle(cx), cx),
            None => self.focus_front(window, cx),
        }
        cx.notify();
    }

    /// The New project dialog, while it is up.
    pub(crate) fn new_project_dialog(&self) -> Option<&Entity<NewProjectDialog>> {
        self.lobby.new_project.as_ref()
    }

    /// Ask where, then make the project there and open it; an error stays
    /// in the dialog.
    fn create_project(
        &mut self,
        dialog: Entity<NewProjectDialog>,
        name: String,
        venue: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let parent = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose where to create the project".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = parent.await else {
                return;
            };
            let Some(parent) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| this.set_busy(Some("Creating project…"), cx))
                .ok();
            let created = cx
                .background_executor()
                .spawn(async move { create_project(parent, name, venue) })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.set_busy(None, cx);
                match created {
                    Ok(root) => this.open_project(root, window, cx),
                    Err(error) => dialog.update(cx, |dialog, cx| dialog.set_error(Some(error), cx)),
                }
            })
            .ok();
        })
        .detach();
    }

    /// The guided tutorial: the sample project in Documents › Lattice
    /// Tutorials, made the first time and reopened after.
    pub(crate) fn open_tutorial(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(documents) =
            dirs::document_dir().or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        else {
            notices::error(
                "Could not open the tutorial",
                "No Documents folder was found.",
                cx,
            );
            return;
        };
        self.set_busy(Some("Preparing tutorial…"), cx);
        let parent = documents.join(TUTORIALS);
        cx.spawn_in(window, async move |this, cx| {
            let made = cx
                .background_executor()
                .spawn(async move {
                    std::fs::create_dir_all(&parent).map_err(|error| {
                        format!("Could not create {}: {error}", parent.display())
                    })?;
                    lattice_core::project::create_tutorial(&parent)
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.set_busy(None, cx);
                match made {
                    Ok(root) => this.open_project(root, window, cx),
                    Err(error) => {
                        if this.project.is_none() && this.lobby.welcome.is_none() {
                            this.show_welcome(None, window, cx);
                        }
                        notices::error("Could not open the tutorial", error, cx);
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Import ZIP: a ZIP of a project (an Overleaf download), extracted
    /// where the writer says and opened.
    fn import_zip(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let zip = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Import Overleaf ZIP".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = zip.await else {
                return;
            };
            let Some(zip) = paths.into_iter().next() else {
                return;
            };
            let Ok(parent) = this.update(cx, |_, cx| {
                cx.prompt_for_paths(PathPromptOptions {
                    files: false,
                    directories: true,
                    multiple: false,
                    prompt: Some("Choose where to extract the project".into()),
                })
            }) else {
                return;
            };
            let Ok(Ok(Some(parents))) = parent.await else {
                return;
            };
            let Some(parent) = parents.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| this.set_busy(Some("Importing ZIP…"), cx))
                .ok();
            let imported = cx
                .background_executor()
                .spawn(async move {
                    lattice_core::project::import_project_zip(&zip, &parent)
                        .map(|snapshot| PathBuf::from(snapshot.root))
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.set_busy(None, cx);
                match imported {
                    Ok(root) => this.open_project(root, window, cx),
                    Err(error) => notices::error("Could not import the ZIP", error, cx),
                }
            })
            .ok();
        })
        .detach();
    }
}
