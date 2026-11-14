//! One read-only text task on the agent service, as the Tauri app runs it
//! (`runAgentTextTask` in `src/agent/agent-proofread.ts`, over lattice-core's
//! `task_relay_request` on the `text-task` route): no tools and no thread,
//! a prompt in and the agent's final message out. Started, then polled
//! every 700 ms until it settles. Proofread, Polish and Rewrite run through
//! it.
//!
//! Dropping a [`TextTask`] stops the polling and asks the service to cancel
//! the task, as aborting the Tauri app's signal does: a proofread replaced
//! or dismissed while the agent works costs nothing more.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use gpui::{App, BackgroundExecutor, Task};
use lattice_core::synara::{self, SynaraRuntime, TEXT_TASK_ROUTE};
use serde_json::{Value, json};

use super::runtime::AgentRuntime;

const POLL: Duration = Duration::from_millis(700);

/// Why a text task gave no answer, for the surface to word.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The running agent service predates the text-task route: asking again
    /// cannot help.
    Unavailable,
    /// The service could not start or finish it; its own message, if any.
    Failed(String),
}

/// The agent's final message, and the model that wrote it when the runtime
/// says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub text: String,
    pub model: Option<String>,
}

/// A text task under way. Await [`TextTask::answer`]; drop it to cancel.
pub struct TextTask {
    answer: Option<Task<Result<Answer, Failure>>>,
    started: Arc<Mutex<Option<String>>>,
    root: PathBuf,
    runtime: Arc<SynaraRuntime>,
    executor: BackgroundExecutor,
}

impl TextTask {
    /// Start `prompt` as a task in the project at `root`.
    pub fn start(root: PathBuf, prompt: String, cx: &mut App) -> Self {
        let runtime = AgentRuntime::get(cx).supervisor().clone();
        let started = Arc::new(Mutex::new(None));
        let executor = cx.background_executor().clone();
        let answer = {
            let runtime = runtime.clone();
            let started = started.clone();
            let root = root.clone();
            let timer = executor.clone();
            executor.spawn(async move {
                let payload = json!({ "workspaceRoot": root, "prompt": prompt });
                let begun = synara::task_relay_request(&runtime, TEXT_TASK_ROUTE, "start", None, payload)
                    .map_err(|error| {
                        if error == synara::ROUTE_UNAVAILABLE {
                            Failure::Unavailable
                        } else {
                            Failure::Failed(error)
                        }
                    })?;
                let id = begun
                    .get("taskId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| Failure::Failed(String::new()))?
                    .to_string();
                *started.lock().unwrap() = Some(id.clone());
                loop {
                    timer.timer(POLL).await;
                    let progress = synara::task_relay_request(
                        &runtime,
                        TEXT_TASK_ROUTE,
                        "status",
                        Some(&id),
                        json!({ "workspaceRoot": root }),
                    )
                    .map_err(Failure::Failed)?;
                    match progress.get("status").and_then(Value::as_str) {
                        Some("failed") => {
                            let message = progress.get("message").and_then(Value::as_str);
                            return Err(Failure::Failed(message.unwrap_or_default().to_string()));
                        }
                        Some("completed") => {
                            // Settled: nothing left for a drop to cancel.
                            started.lock().unwrap().take();
                            let text = progress.get("text").and_then(Value::as_str);
                            let model = progress
                                .get("model")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|model| !model.is_empty());
                            return Ok(Answer {
                                text: text.unwrap_or_default().to_string(),
                                model: model.map(str::to_string),
                            });
                        }
                        _ => {}
                    }
                }
            })
        };
        Self {
            answer: Some(answer),
            started,
            root,
            runtime,
            executor,
        }
    }

    /// The task's answer, once it settles.
    pub fn answer(&mut self) -> Task<Result<Answer, Failure>> {
        self.answer
            .take()
            .unwrap_or_else(|| Task::ready(Err(Failure::Failed(String::new()))))
    }
}

impl Drop for TextTask {
    fn drop(&mut self) {
        let Some(id) = self.started.lock().unwrap().take() else {
            return;
        };
        let runtime = self.runtime.clone();
        let root = self.root.clone();
        self.executor
            .spawn(async move {
                // A task the service already finished or lost has nothing to
                // stop.
                synara::task_relay_request(
                    &runtime,
                    TEXT_TASK_ROUTE,
                    "cancel",
                    Some(&id),
                    json!({ "workspaceRoot": root }),
                )
                .ok();
            })
            .detach();
    }
}
