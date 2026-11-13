//! What the History panel does to the project, each behind a question when
//! it cannot be taken back: version tracking started, a version saved under
//! a name, a file or the whole project restored to a version, an agent's
//! edit reverted, an activity entry deleted, and the Save version field.

use std::{path::Path, rc::Rc};

use gpui::{AppContext as _, Context, Window};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;

use crate::{
    confirm::{self, Confirm},
    history::messages,
    notices::{self, Notice},
};

use super::HistoryPanel;

impl HistoryPanel {
    /// Ask `question`, and on OK run `then` on the panel.
    fn ask(
        &self,
        question: String,
        destructive: bool,
        then: impl Fn(&mut Self, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let (title, body) = match question.split_once("\n\n") {
            Some((title, body)) => (title.to_string(), Some(body.to_string())),
            None => (question, None),
        };
        let this = cx.entity().downgrade();
        let then = Rc::new(then);
        let mut confirm = Confirm::new(title).on_confirm(move |_, cx| {
            let then = then.clone();
            this.update(cx, |this, cx| then(this, cx)).ok();
        });
        if let Some(body) = body {
            confirm = confirm.body(body);
        }
        if destructive {
            confirm = confirm.destructive();
        }
        confirm::ask(confirm, cx);
    }

    /// Run one git action, then read the versions again (`runAction`).
    fn run_action(
        &mut self,
        work: impl FnOnce(&Path) -> Result<String, String> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root.clone() else {
            return;
        };
        self.versions.busy = true;
        cx.notify();
        let run = cx.background_executor().spawn(async move { work(&root) });
        cx.spawn(async move |this, cx| {
            let outcome = run.await;
            this.update(cx, |this, cx| {
                this.versions.busy = false;
                match outcome {
                    Ok(message) => notices::show(Notice::new(ToastLevel::Success, message), cx),
                    Err(error) => notices::error(t!("Versions"), error, cx),
                }
                this.reload(cx);
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn enable_tracking(&mut self, cx: &mut Context<Self>) {
        self.run_action(
            |root| {
                lattice_core::git::init(root)?;
                Ok(t!("Now tracking versions of this project.").into())
            },
            cx,
        );
    }

    /// Save the working tree as a version named `label` (or "Saved version").
    pub(crate) fn save_version(&mut self, label: String, cx: &mut Context<Self>) {
        let message = if label.trim().is_empty() {
            messages::SAVED.to_string()
        } else {
            label.trim().to_string()
        };
        self.run_action(
            move |root| {
                let hash = lattice_core::git::auto_commit(root, &message, None)?;
                Ok(match hash {
                    Some(_) => t!("Version saved.").into(),
                    None => t!("No changes since the last version.").into(),
                })
            },
            cx,
        );
    }

    pub(in crate::history) fn restore_file(
        &mut self,
        hash: String,
        path: String,
        cx: &mut Context<Self>,
    ) {
        let question = t!(
            "Restore {path} to this version? The current state is saved as a version first.",
            path = &path
        );
        self.ask(
            question,
            false,
            move |this, cx| {
                let (hash, path) = (hash.clone(), path.clone());
                this.run_action(
                    move |root| {
                        lattice_core::git::restore_file(root, &hash, &path)?;
                        Ok(t!("Restored {path}.", path = &path))
                    },
                    cx,
                );
            },
            cx,
        );
    }

    pub(crate) fn restore_project(&mut self, hash: String, cx: &mut Context<Self>) {
        let question = t!(
            "Restore the project to this version?\n\nNothing is lost: the current state is saved as a version first"
        )
        .to_string();
        self.ask(
            question,
            false,
            move |this, cx| {
                let hash = hash.clone();
                this.run_action(
                    move |root| {
                        lattice_core::git::restore_project(root, &hash)?;
                        Ok(t!("Project restored.").into())
                    },
                    cx,
                );
            },
            cx,
        );
    }

    /// Put back what an activity entry changed, as a new entry.
    pub(in crate::history) fn revert_entry(
        &mut self,
        id: String,
        only: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let question = match &only {
            Some(path) => t!(
                "Restore only “{path}” to the state before this change? The restore will be added as a new history entry.",
                path = path
            ),
            None => t!(
                "Restore the project to the state before this change? The restore will be added as a new history entry."
            )
            .to_string(),
        };
        self.ask(
            question,
            false,
            move |this, cx| {
                let Some(root) = this.root.clone() else {
                    return;
                };
                let (id, only) = (id.clone(), only.clone());
                let run = cx.background_executor().spawn(async move {
                    lattice_core::project::revert(&root, &id, only.as_deref()).map(|_| ())
                });
                cx.spawn(async move |this, cx| {
                    let outcome = run.await;
                    this.update(cx, |this, cx| {
                        if let Err(error) = outcome {
                            notices::error(t!("History"), error, cx);
                        }
                        this.reload(cx);
                    })
                    .ok();
                })
                .detach();
            },
            cx,
        );
    }

    pub(in crate::history) fn delete_entry(&mut self, id: String, cx: &mut Context<Self>) {
        self.ask(
            t!("Delete this history entry? This cannot be undone.").into(),
            true,
            move |this, cx| {
                let Some(root) = this.root.clone() else {
                    return;
                };
                let id = id.clone();
                let run = cx
                    .background_executor()
                    .spawn(async move { lattice_core::project::delete_history(&root, &id) });
                cx.spawn(async move |this, cx| {
                    let outcome = run.await;
                    this.update(cx, |this, cx| {
                        if let Err(error) = outcome {
                            notices::error(t!("History"), error, cx);
                        }
                        this.load_activity(cx);
                    })
                    .ok();
                })
                .detach();
            },
            cx,
        );
    }

    /// Open the field a version's name is typed in.
    pub(in crate::history) fn open_save_field(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let field = cx.new(|cx| InputState::new(window, cx).placeholder(t!("Name this version…")));
        let subscription = cx.subscribe(&field, |this, field, event, cx| {
            if let InputEvent::PressEnter { .. } = event {
                let label = field.read(cx).value().to_string();
                this.submit_save(label, cx);
            }
        });
        field.update(cx, |field, cx| field.focus(window, cx));
        self.save_field = Some((field, subscription));
        cx.notify();
    }

    pub(in crate::history) fn submit_save(&mut self, label: String, cx: &mut Context<Self>) {
        self.save_field = None;
        self.save_version(label, cx);
    }

    pub(in crate::history) fn close_save_field(&mut self, cx: &mut Context<Self>) {
        self.save_field = None;
        cx.notify();
    }
}
