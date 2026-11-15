//! Settings › Agent › Model endpoint (`model-endpoint-settings.tsx`, issue
//! #825): the writer's own API, which Synara's Pi provider drives with no
//! CLI installed. The key goes to the keychain from here and is never read
//! back; Lattice writes Pi's configuration and restarts the agent so it
//! takes effect.
//!
//! Everything crosses lattice-core as the Tauri app's commands carry it
//! (`get_model_endpoint`, `save_model_endpoint`, `remove_model_endpoint`,
//! `test_model_endpoint`), in the same JSON, so the two apps read and write
//! one `models.json` shape and one keychain entry. The agent reads Pi's
//! configuration when it starts: a restart stops every window's running
//! turns, so while one runs it is offered, not made.

use gpui::{
    AppContext as _, Context, Entity, SharedString, Subscription, Task, WeakEntity, Window,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::t;
use serde_json::{Value, json};

mod protocol;
mod view;

use protocol::{Protocol, host_of};

use super::{
    controls::{self, Level},
    dialog::SettingsDialog,
};
use crate::agent::{agent_home, commands::agent_turns, runtime::AgentRuntime};

/// Pi's own defaults for a model that does not say.
const DEFAULT_CONTEXT: &str = "128000";
const DEFAULT_MAX_TOKENS: &str = "16384";
/// Pi takes at most this many models (`MAX_MODELS`).
pub(super) const MAX_MODELS: usize = 16;

/// One model's row; typed numbers stay text until saved, so a half-typed
/// field is not reset.
struct ModelDraft {
    id: Entity<InputState>,
    context_window: Entity<InputState>,
    max_tokens: Entity<InputState>,
    images: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Busy {
    Load,
    Save,
    Test,
    Remove,
    Restart,
}

struct Notice {
    level: Level,
    text: String,
    /// Offers the restart a running turn held back.
    restart: bool,
}

/// Settings › Model endpoint, its form made the first time it is drawn.
pub fn render(
    dialog: &mut SettingsDialog,
    width: controls::PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> gpui::AnyElement {
    let handle = cx.entity().downgrade();
    let marks = super::pages::marks(dialog);
    let pane = dialog
        .pages
        .model_endpoint
        .get_or_insert_with(|| cx.new(|cx| ModelEndpointPane::new(handle, window, cx)))
        .clone();
    pane.update(cx, |pane, cx| pane.render_page(width, &marks, window, cx))
}

pub struct ModelEndpointPane {
    dialog: WeakEntity<SettingsDialog>,
    /// `get_model_endpoint`'s answer: the endpoint and whether a key is saved.
    saved: Option<Value>,
    protocol: Protocol,
    /// Shows the Responses and Gemini protocols.
    advanced: bool,
    base_url: Entity<InputState>,
    key: Entity<InputState>,
    models: Vec<ModelDraft>,
    busy: Option<Busy>,
    notice: Option<Notice>,
    report: Option<Value>,
    _task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl ModelEndpointPane {
    pub fn new(
        dialog: WeakEntity<SettingsDialog>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let base_url = cx.new(|cx| InputState::new(window, cx));
        let key = cx.new(|cx| InputState::new(window, cx).masked(true));
        let mut pane = Self {
            dialog,
            saved: None,
            protocol: Protocol::OpenAiCompletions,
            advanced: false,
            base_url,
            key,
            models: Vec::new(),
            busy: Some(Busy::Load),
            notice: None,
            report: None,
            _task: None,
            _subscriptions: Vec::new(),
        };
        pane.watch(&pane.base_url.clone(), cx);
        pane.watch(&pane.key.clone(), cx);
        pane.add_model(window, cx);
        pane.load(window, cx);
        pane
    }

    /// An edit takes the last outcome away, as the reducer's `edit` does.
    fn watch(&mut self, input: &Entity<InputState>, cx: &mut Context<Self>) {
        self._subscriptions
            .push(cx.subscribe(input, |this, _, event: &InputEvent, cx| {
                if let InputEvent::Change = event {
                    this.notice = None;
                    this.report = None;
                    cx.notify();
                }
            }));
    }

    fn input(
        value: &str,
        placeholder: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<InputState> {
        let value = value.to_string();
        let placeholder = placeholder.into();
        cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder(placeholder);
            state.set_value(value, window, cx);
            state
        })
    }

    fn model_draft(
        &mut self,
        id: &str,
        context_window: &str,
        max_tokens: &str,
        images: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ModelDraft {
        let draft = ModelDraft {
            id: Self::input(id, t!("model-name"), window, cx),
            context_window: Self::input(context_window, "", window, cx),
            max_tokens: Self::input(max_tokens, "", window, cx),
            images,
        };
        for input in [&draft.id, &draft.context_window, &draft.max_tokens] {
            self.watch(&input.clone(), cx);
        }
        draft
    }

    fn add_model(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.models.len() >= MAX_MODELS {
            return;
        }
        let draft = self.model_draft("", DEFAULT_CONTEXT, DEFAULT_MAX_TOKENS, false, window, cx);
        self.models.push(draft);
        cx.notify();
    }

    /// The fields as `status` has them (`draftOf`); the key field empties.
    fn adopt(&mut self, status: Value, window: &mut Window, cx: &mut Context<Self>) {
        let endpoint = status
            .get("endpoint")
            .filter(|endpoint| !endpoint.is_null());
        self.protocol = Protocol::from_tag(
            endpoint
                .and_then(|endpoint| endpoint.get("protocol"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        let base_url = endpoint
            .and_then(|endpoint| endpoint.get("baseUrl"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.base_url
            .update(cx, |input, cx| input.set_value(base_url, window, cx));
        self.key
            .update(cx, |input, cx| input.set_value("", window, cx));
        let models: Vec<Value> = endpoint
            .and_then(|endpoint| endpoint.get("models"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.models.clear();
        for model in &models {
            let number = |key: &str| {
                model
                    .get(key)
                    .and_then(Value::as_u64)
                    .map(|n| n.to_string())
                    .unwrap_or_default()
            };
            let draft = self.model_draft(
                model.get("id").and_then(Value::as_str).unwrap_or_default(),
                &number("contextWindow"),
                &number("maxTokens"),
                model
                    .get("images")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                window,
                cx,
            );
            self.models.push(draft);
        }
        if self.models.is_empty() {
            self.add_model(window, cx);
        }
        self.saved = Some(status);
    }

    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let read = cx.background_spawn(async move {
            lattice_core::runtime::block_on(lattice_core::model_endpoint::get_model_endpoint(
                agent_home(),
            ))
            .and_then(|status| serde_json::to_value(status).map_err(|error| error.to_string()))
        });
        let window_handle = window.window_handle();
        self._task = Some(cx.spawn(async move |this, cx| {
            let status = read.await;
            cx.update_window(window_handle, |_, window, cx| {
                this.update(cx, |this, cx| {
                    this.busy = None;
                    match status {
                        Ok(status) => {
                            this.advanced = this.protocol_of(&status).advanced();
                            this.adopt(status, window, cx);
                        }
                        Err(_) => {
                            this.saved = Some(json!({ "endpoint": null, "keySaved": false }));
                            this.notice = Some(Notice {
                                level: Level::Error,
                                text: t!(
                                    "Couldn’t read the endpoint settings. Reopen Settings to retry"
                                )
                                .into(),
                                restart: false,
                            });
                        }
                    }
                    cx.notify();
                })
                .ok();
            })
            .ok();
        }));
    }

    fn protocol_of(&self, status: &Value) -> Protocol {
        Protocol::from_tag(
            status
                .get("endpoint")
                .and_then(|endpoint| endpoint.get("protocol"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
    }

    /// The draft as `save_model_endpoint` takes it (`endpointOf`), or none
    /// when a limit is not a whole number.
    fn endpoint(&self, cx: &gpui::App) -> Option<Value> {
        let mut models = Vec::new();
        for model in &self.models {
            let number = |input: &Entity<InputState>| -> Option<u64> {
                input.read(cx).value().trim().parse::<u64>().ok()
            };
            let context_window = number(&model.context_window)?;
            let max_tokens = number(&model.max_tokens)?;
            models.push(json!({
                "id": model.id.read(cx).value().to_string(),
                "contextWindow": context_window,
                "maxTokens": max_tokens,
                "images": model.images,
            }));
        }
        Some(json!({
            "protocol": self.protocol.tag(),
            "baseUrl": self.base_url.read(cx).value().to_string(),
            "models": models,
        }))
    }

    fn key_saved(&self) -> bool {
        self.saved
            .as_ref()
            .and_then(|saved| saved.get("keySaved"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    fn has_saved_endpoint(&self) -> bool {
        self.saved
            .as_ref()
            .and_then(|saved| saved.get("endpoint"))
            .is_some_and(|endpoint| !endpoint.is_null())
    }

    fn fail(&mut self, text: String, cx: &mut Context<Self>) {
        self.busy = None;
        self.notice = Some(Notice {
            level: Level::Error,
            text,
            restart: false,
        });
        cx.notify();
    }

    /// Run one action, unless another is under way.
    fn start(&mut self, busy: Busy, cx: &mut Context<Self>) -> bool {
        if self.busy.is_some() {
            return false;
        }
        self.busy = Some(busy);
        self.notice = None;
        if busy == Busy::Test {
            self.report = None;
        }
        cx.notify();
        true
    }

    /// Saved or removed: the agent takes it at its next start, which is now
    /// unless a turn is running.
    fn applied(
        &mut self,
        status: Value,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.adopt(status, window, cx);
        if agent_turns() > 0 {
            let restart =
                t!("The agent uses it after a restart, which would stop the turn running now.");
            self.busy = None;
            self.notice = Some(Notice {
                level: Level::Warning,
                text: format!("{text} {restart}"),
                restart: true,
            });
            cx.notify();
            return;
        }
        let restart = AgentRuntime::get(cx).restart(cx);
        self._task = Some(cx.spawn(async move |this, cx| {
            restart.await;
            this.update(cx, |this, cx| {
                this.busy = None;
                this.notice = Some(Notice {
                    level: Level::Success,
                    text,
                    restart: false,
                });
                cx.notify();
            })
            .ok();
        }));
    }

    /// Run a lattice-core endpoint call off the main thread, then hand its
    /// answer to `done` on this window.
    fn call(
        &mut self,
        work: impl FnOnce() -> Result<Value, String> + Send + 'static,
        done: impl FnOnce(&mut Self, Value, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let work = cx.background_spawn(async move { work() });
        let window_handle = window.window_handle();
        self._task = Some(cx.spawn(async move |this, cx| {
            let result = work.await;
            cx.update_window(window_handle, |_, window, cx| {
                this.update(cx, |this, cx| match result {
                    // The host's own messages: validation or the keychain,
                    // never the key.
                    Err(error) => this.fail(error, cx),
                    Ok(value) => done(this, value, window, cx),
                })
                .ok();
            })
            .ok();
        }));
    }

    fn save(&mut self, key: Value, window: &mut Window, cx: &mut Context<Self>) {
        if !self.start(Busy::Save, cx) {
            return;
        }
        let Some(endpoint) = self.endpoint(cx) else {
            return self.fail(t!("Token limits must be whole numbers.").into(), cx);
        };
        self.call(
            move || {
                let endpoint = serde_json::from_value(endpoint).map_err(|error| error.to_string())?;
                let key = serde_json::from_value(key).map_err(|error| error.to_string())?;
                lattice_core::runtime::block_on(lattice_core::model_endpoint::save_model_endpoint(
                    agent_home(),
                    endpoint,
                    key,
                ))
                .and_then(|status| serde_json::to_value(status).map_err(|error| error.to_string()))
            },
            |this, status, window, cx| {
                // The picker lists the models under Pi, grouped by the
                // address's host.
                let host = host_of(
                    status
                        .get("endpoint")
                        .and_then(|endpoint| endpoint.get("baseUrl"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                let text = t!(
                    "Saved. In the Agent panel’s model menu, open Pi and choose a model under {host}.",
                    host = &host
                )
                .to_string();
                this.applied(status, text, window, cx);
            },
            window,
            cx,
        );
    }

    fn save_typed_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let typed = self.key.read(cx).value().trim().to_string();
        let key = if typed.is_empty() {
            json!({ "action": "keep" })
        } else {
            json!({ "action": "replace", "value": typed })
        };
        self.save(key, window, cx);
    }

    fn remove(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.start(Busy::Remove, cx) {
            return;
        }
        self.call(
            || {
                lattice_core::runtime::block_on(
                    lattice_core::model_endpoint::remove_model_endpoint(agent_home()),
                )
                .and_then(|status| serde_json::to_value(status).map_err(|error| error.to_string()))
            },
            |this, status, window, cx| {
                this.applied(status, t!("Endpoint removed.").into(), window, cx)
            },
            window,
            cx,
        );
    }

    fn test(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.start(Busy::Test, cx) {
            return;
        }
        let Some(endpoint) = self.endpoint(cx) else {
            return self.fail(t!("Token limits must be whole numbers.").into(), cx);
        };
        let typed = self.key.read(cx).value().trim().to_string();
        let key = (!typed.is_empty()).then_some(typed);
        self.call(
            move || {
                let endpoint =
                    serde_json::from_value(endpoint).map_err(|error| error.to_string())?;
                lattice_core::runtime::block_on(lattice_core::model_endpoint::test_model_endpoint(
                    endpoint, key,
                ))
                .and_then(|report| serde_json::to_value(report).map_err(|error| error.to_string()))
            },
            |this, report, _, cx| {
                this.busy = None;
                this.report = Some(report);
                cx.notify();
            },
            window,
            cx,
        );
    }

    fn restart(&mut self, cx: &mut Context<Self>) {
        if !self.start(Busy::Restart, cx) {
            return;
        }
        let restart = AgentRuntime::get(cx).restart(cx);
        self._task = Some(cx.spawn(async move |this, cx| {
            restart.await;
            this.update(cx, |this, cx| {
                this.busy = None;
                this.notice = Some(Notice {
                    level: Level::Success,
                    text: t!("The agent restarted with the endpoint.").into(),
                    restart: false,
                });
                cx.notify();
            })
            .ok();
        }));
    }
}
