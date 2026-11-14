//! The compile repair in the window, as the Tauri app runs it
//! (`use-compile-repair.ts`, `compile-repair-run.ts`): the card's Fix all
//! (every error and warning) and an explained error's Ask the agent (that
//! one) save the project, start a repair task through lattice-core's relay
//! to the Agent's service, follow it to a terminal status once a second,
//! and build again when it completes. While it runs the editors are
//! read-only, so the writer and the Agent never write one file at once;
//! Cancel asks the task to stop, and a task that has not stopped ten
//! seconds later is left to the writer's Unlock anyway. View repair opens
//! the task's thread in the Agent.
//!
//! The state the card draws is the build panel's (`BuildPanel::repair`);
//! the operation behind it is this part's.

use std::path::PathBuf;

use gpui::{AppContext as _, Context, Task, Window};
use lattice_core::{models::Diagnostic, synara};
use lattice_i18n::t;
use serde_json::{Value, json};

use super::{
    Shell,
    build::BuildRequest,
    parts::{self, Part},
};
use crate::{
    agent::runtime::AgentRuntime,
    build::repair::{
        POLL, POLL_RETRY, Progress, RepairState, RepairStatus, STOP_GRACE,
        repairable, start_refusal,
    },
};

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(Repair::default()),
    views: &[],
    actions: |element, _| element,
    commands: parts::no_commands,
};

/// The repair the window follows.
struct Operation {
    /// Which start this is: a later one, or the project's leaving, ends it.
    id: u64,
    root: PathBuf,
    thread_id: Option<String>,
    cancel_requested: bool,
    stopping: bool,
    /// The task completed: only the build after it is left, and nothing can
    /// lose the task any more.
    task_done: bool,
}

#[derive(Default)]
pub(crate) struct Repair {
    operation: Option<Operation>,
    starts: u64,
    _run: Option<Task<()>>,
    _grace: Option<Task<()>>,
}

/// The relay's answer to one action, off the main thread.
fn relay(action: &'static str, thread_id: Option<String>, payload: Value, cx: &mut gpui::App) -> Task<Result<Value, String>> {
    let runtime = AgentRuntime::get(cx).supervisor().clone();
    cx.background_spawn(async move {
        synara::task_relay_request(
            &runtime,
            synara::COMPILE_REPAIR_ROUTE,
            action,
            thread_id.as_deref(),
            payload,
        )
    })
}

impl Shell {
    fn repair(&mut self) -> &mut Repair {
        self.parts.get_mut::<Repair>()
    }

    /// Whether the operation `id` still owns the window's repair.
    fn owns_repair(&self, id: u64, cx: &gpui::App) -> bool {
        let repair = self.parts.get::<Repair>();
        repair.operation.as_ref().is_some_and(|operation| {
            operation.id == id && Some(operation.root.as_path()) == self.root(cx).as_deref()
        })
    }

    /// What the card shows, and the editors locked while it runs.
    fn show_repair(&mut self, state: Option<RepairState>, cx: &mut Context<Self>) {
        let busy = state.as_ref().is_some_and(RepairState::busy);
        let stopping = self
            .parts
            .get::<Repair>()
            .operation
            .as_ref()
            .is_some_and(|operation| operation.stopping);
        let state = state.map(|state| RepairState {
            stopping: stopping && state.busy() && state.status != RepairStatus::Compiling,
            ..state
        });
        self.build_panel
            .update(cx, |panel, cx| panel.set_repair(state, cx));
        for editor in self.open_editors() {
            let zed = editor.read(cx).editor().clone();
            zed.update(cx, |zed, cx| {
                if zed.read_only(cx) != busy {
                    zed.set_read_only(busy);
                    cx.notify();
                }
            });
        }
    }

    /// Keep the current phase: a transport error says nothing about the
    /// task's life.
    fn note_repair_error(&mut self, error: String, cx: &mut Context<Self>) {
        let state = self.build_panel.read(cx).repair().cloned();
        if let Some(state) = state {
            self.show_repair(
                Some(RepairState {
                    message: Some(error),
                    ..state
                }),
                cx,
            );
        }
    }

    /// Whether the Agent may write the project: it is not linked to
    /// Overleaf, or linked with write access (`repairWritable`).
    fn repair_writable(&self, cx: &gpui::App) -> bool {
        let overleaf = self.overleaf.read(cx);
        !overleaf.linked() || overleaf.can_review()
    }

    /// The card's Fix all follows whether the project may be written, as of
    /// the build it shows.
    pub(super) fn note_repair_writable(&mut self, cx: &mut Context<Self>) {
        let writable = self.repair_writable(cx);
        self.build_panel
            .update(cx, |panel, cx| panel.set_repair_writable(writable, cx));
    }

    /// Fix all, or Ask the agent about one error: repair `diagnostics`.
    pub(super) fn start_repair(
        &mut self,
        diagnostics: Vec<Diagnostic>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let repairable: Vec<Value> = repairable(&diagnostics)
            .into_iter()
            .map(|diagnostic| {
                json!({
                    "level": diagnostic.level,
                    "message": diagnostic.message,
                    "file": diagnostic.file,
                    "line": diagnostic.line,
                })
            })
            .collect();
        if repairable.is_empty()
            || !self.repair_writable(cx)
            || self.building()
            || self.parts.get::<Repair>().operation.is_some()
        {
            return;
        }
        let root_document = self
            .build_panel
            .read(cx)
            .last()
            .map(|last| last.root_document.clone());
        let repair = self.repair();
        repair.starts += 1;
        let id = repair.starts;
        repair.operation = Some(Operation {
            id,
            root: root.clone(),
            thread_id: None,
            cancel_requested: false,
            stopping: false,
            task_done: false,
        });
        repair._grace = None;
        self.show_repair(Some(RepairState::new(RepairStatus::Starting)), cx);
        let editors = self.open_editors();
        let saves = Self::save_dirty(&editors, cx);
        let run = cx.spawn_in(window, async move |this, cx| {
            let mut saved = true;
            for save in saves {
                saved &= save.await.unwrap_or(false);
            }
            let started = this.update(cx, |this, cx| {
                if !this.owns_repair(id, cx) {
                    return None;
                }
                if !saved {
                    return Some(Err(t!("Save the project before repairing.").to_string()));
                }
                if this
                    .parts
                    .get::<Repair>()
                    .operation
                    .as_ref()
                    .is_some_and(|operation| operation.cancel_requested)
                {
                    return Some(Err(t!("Repair cancelled.").to_string()));
                }
                let payload = json!({
                    "workspaceRoot": root.to_string_lossy(),
                    "diagnostics": repairable,
                    "rootDocument": root_document,
                    // The Tauri app's default permission mode for the Agent.
                    "runtimeMode": "full-access",
                });
                Some(Ok(relay("start", None, payload, cx)))
            });
            let started = match started {
                Ok(Some(Ok(start))) => start.await,
                Ok(Some(Err(message))) => Err(message),
                _ => return,
            };
            let thread_id = match started {
                Ok(answer) => answer["threadId"].as_str().map(str::to_string),
                Err(detail) => {
                    let message = start_refusal(&detail)
                        .map(str::to_string)
                        .unwrap_or(detail);
                    this.update(cx, |this, cx| this.fail_repair(id, message, cx)).ok();
                    return;
                }
            };
            let Some(thread_id) = thread_id else {
                let message = t!("The repair service did not return a task.").to_string();
                this.update(cx, |this, cx| this.fail_repair(id, message, cx)).ok();
                return;
            };
            let cancel_now = this.update(cx, |this, cx| {
                if !this.owns_repair(id, cx) {
                    return None;
                }
                let operation = this.repair().operation.as_mut()?;
                operation.thread_id = Some(thread_id.clone());
                let cancel = operation.cancel_requested;
                let state = RepairState {
                    thread_id: Some(thread_id.clone()),
                    ..RepairState::new(RepairStatus::Running)
                };
                this.show_repair(Some(state), cx);
                Some(cancel)
            });
            match cancel_now {
                Ok(Some(true)) => {
                    this.update(cx, |this, cx| this.request_repair_cancel(cx)).ok();
                }
                Ok(Some(false)) => {}
                // The window moved on before the task started: stop it.
                _ => {
                    let cancel = cx.update(|_, cx| relay("cancel", Some(thread_id), json!({ "workspaceRoot": root.to_string_lossy() }), cx));
                    if let Ok(cancel) = cancel {
                        cancel.await.ok();
                    }
                    return;
                }
            }
            loop {
                let status = this.update(cx, |this, cx| {
                    this.owns_repair(id, cx)
                        .then(|| relay("status", Some(thread_id.clone()), Value::Null, cx))
                });
                let Ok(Some(status)) = status else {
                    return;
                };
                let answer = status.await;
                let next = this.update_in(cx, |this, window, cx| {
                    if !this.owns_repair(id, cx) {
                        return None;
                    }
                    match answer {
                        // The service does not know the task: it went with the
                        // service that ran it.
                        Err(error) if error == synara::TASK_UNKNOWN => {
                            this.abandon_repair(None, cx);
                            None
                        }
                        Err(error) => {
                            this.note_repair_error(error, cx);
                            Some(POLL_RETRY)
                        }
                        Ok(answer) => {
                            let progress: Progress = match serde_json::from_value(answer) {
                                Ok(progress) => progress,
                                Err(error) => {
                                    this.note_repair_error(error.to_string(), cx);
                                    return Some(POLL_RETRY);
                                }
                            };
                            match progress.status {
                                RepairStatus::Failed => {
                                    let message = progress
                                        .message
                                        .unwrap_or_else(|| t!("Repair failed.").to_string());
                                    this.fail_repair(id, message, cx);
                                    None
                                }
                                RepairStatus::Completed => {
                                    this.repair_completed(id, thread_id.clone(), window, cx);
                                    None
                                }
                                status => {
                                    let state = RepairState {
                                        status,
                                        thread_id: Some(thread_id.clone()),
                                        message: progress.message,
                                        stopping: false,
                                    };
                                    this.show_repair(Some(state), cx);
                                    Some(POLL)
                                }
                            }
                        }
                    }
                });
                match next {
                    Ok(Some(wait)) => cx.background_executor().timer(wait).await,
                    _ => return,
                }
            }
        });
        self.repair()._run = Some(run);
    }

    /// The task completed: build again, and say so once that build is in.
    fn repair_completed(
        &mut self,
        id: u64,
        thread_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(operation) = self.repair().operation.as_mut() {
            operation.task_done = true;
        }
        let compiling = RepairState {
            thread_id: Some(thread_id.clone()),
            ..RepairState::new(RepairStatus::Compiling)
        };
        self.show_repair(Some(compiling), cx);
        self.run_build(BuildRequest::requested(), window, cx);
        let settled = self.builds_settled(cx);
        cx.spawn(async move |this, cx| {
            settled.await.ok();
            this.update(cx, |this, cx| {
                if !this.owns_repair(id, cx) {
                    return;
                }
                let repair = this.repair();
                repair.operation = None;
                repair._grace = None;
                let done = RepairState {
                    thread_id: Some(thread_id),
                    ..RepairState::new(RepairStatus::Completed)
                };
                this.show_repair(Some(done), cx);
            })
            .ok();
        })
        .detach();
    }

    fn fail_repair(&mut self, id: u64, message: String, cx: &mut Context<Self>) {
        if !self.owns_repair(id, cx) {
            return;
        }
        let repair = self.repair();
        let thread_id = repair
            .operation
            .take()
            .and_then(|operation| operation.thread_id);
        repair._grace = None;
        let state = RepairState {
            thread_id,
            message: Some(message),
            ..RepairState::new(RepairStatus::Failed)
        };
        self.show_repair(Some(state), cx);
    }

    /// Stop following the repair: the editors are writable again, and the
    /// task is asked to stop in case it still runs. `message` says why; by
    /// default Lattice lost the task.
    fn abandon_repair(&mut self, message: Option<String>, cx: &mut Context<Self>) {
        let repair = self.repair();
        let Some(operation) = repair.operation.take_if(|operation| !operation.task_done) else {
            return;
        };
        repair._run = None;
        repair._grace = None;
        if let Some(thread_id) = operation.thread_id.clone() {
            let payload = json!({ "workspaceRoot": operation.root.to_string_lossy() });
            relay("cancel", Some(thread_id), payload, cx).detach();
        }
        let message = message.unwrap_or_else(|| {
            t!("Lattice lost track of the repair task, so the editor is writable again. Open Agent to see how far the repair got.").to_string()
        });
        let state = RepairState {
            thread_id: operation.thread_id,
            message: Some(message),
            ..RepairState::new(RepairStatus::Failed)
        };
        self.show_repair(Some(state), cx);
    }

    /// Ask the task to stop. A service that no longer knows it has lost it.
    fn request_repair_cancel(&mut self, cx: &mut Context<Self>) {
        let Some(operation) = self.parts.get::<Repair>().operation.as_ref() else {
            return;
        };
        let (Some(thread_id), id) = (operation.thread_id.clone(), operation.id) else {
            return;
        };
        let payload = json!({ "workspaceRoot": operation.root.to_string_lossy() });
        let cancel = relay("cancel", Some(thread_id), payload, cx);
        cx.spawn(async move |this, cx| {
            if let Err(error) = cancel.await {
                this.update(cx, |this, cx| {
                    if !this.owns_repair(id, cx) {
                        return;
                    }
                    if error == synara::TASK_UNKNOWN {
                        this.abandon_repair(None, cx);
                    } else {
                        this.note_repair_error(error, cx);
                    }
                })
                .ok();
            }
        })
        .detach();
    }

    /// The card's Cancel repair. The service takes the ask before the
    /// provider has necessarily stopped, so the task is followed until a
    /// terminal status; one that does not get there in `STOP_GRACE` is left
    /// to the writer's Unlock anyway.
    pub(super) fn cancel_repair(&mut self, cx: &mut Context<Self>) {
        let Some(operation) = self.repair().operation.as_mut() else {
            return;
        };
        if !operation.cancel_requested {
            operation.cancel_requested = true;
            let id = operation.id;
            let grace = cx.spawn(async move |this, cx| {
                cx.background_executor().timer(STOP_GRACE).await;
                this.update(cx, |this, cx| {
                    if !this.owns_repair(id, cx) {
                        return;
                    }
                    if let Some(operation) = this.repair().operation.as_mut() {
                        operation.stopping = true;
                    }
                    let state = this.build_panel.read(cx).repair().cloned();
                    this.show_repair(state, cx);
                })
                .ok();
            });
            self.repair()._grace = Some(grace);
        }
        self.request_repair_cancel(cx);
    }

    /// The writer's own release of a task that has not stopped since Cancel.
    pub(super) fn unlock_repair(&mut self, cx: &mut Context<Self>) {
        self.abandon_repair(
            Some(t!("Editor unlocked while the repair may still be running. Open Agent to see how far it got.").to_string()),
            cx,
        );
    }

    /// View repair: the task's thread, in the Agent.
    pub(super) fn view_repair(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(thread_id) = self
            .build_panel
            .read(cx)
            .repair()
            .and_then(|state| state.thread_id.clone())
        else {
            return;
        };
        self.show_view("agent", true, window, cx);
        let surface = self.agent.panel.read(cx).surface().clone();
        surface.update(cx, |surface, cx| surface.show_thread(&thread_id, cx));
    }

    /// The project is left: its repair goes with it, asked to stop.
    pub(super) fn repair_left_project(&mut self, cx: &mut Context<Self>) {
        let repair = self.repair();
        repair._run = None;
        repair._grace = None;
        if let Some(operation) = repair.operation.take()
            && let Some(thread_id) = operation.thread_id
        {
            let payload = json!({ "workspaceRoot": operation.root.to_string_lossy() });
            relay("cancel", Some(thread_id), payload, cx).detach();
        }
        self.show_repair(None, cx);
    }
}
