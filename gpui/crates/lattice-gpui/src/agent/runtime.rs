//! The Agent's Synara service: lattice-core's supervisor
//! (`synara::SynaraRuntime`), the Tauri app's own, made once per process from
//! the resources the GPUI app runs with (`structured::resources`).
//!
//! Everything that makes the service safe to run is the supervisor's and is
//! not restated here: it starts the sidecar only inside the macOS
//! bibliography sandbox (`synara/bibliography_guard.rs`: no process in the
//! Agent's tree may write a `.bib` file; the three bibliography mutations it
//! may ask for are brokered by this app, `commands.rs`), with Lattice's own
//! `ps` replacement (the process inspector, which this binary serves,
//! `main.rs`), and anywhere else it does not start at all and says so
//! (`unsupported`), as the Tauri app keeps the Agent off there.
//!
//! The service is started by the first surface that asks for it and then
//! runs for the rest of the process, as the Tauri app's does: a hidden
//! surface may still own a turn or a terminal. It stops with the app.
//!
//! The supervisor's events (`synara-environment-changed` when the system
//! proxy moved under a running service, `synara-runtime-restarted` when it
//! restarted) go to every Synara surface's page, as the Tauri backend emits
//! them to every window, and the restart offer is the app's notice.

use std::sync::{Arc, Mutex};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{App, AppContext as _, Global, Task, WeakEntity};
use lattice_core::{
    host::{EventSink, Resources},
    synara::SynaraRuntime,
};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;
use serde_json::Value;

use super::surface::SynaraSurface;
use crate::{
    notices::{self, Notice, NoticeAction},
    structured::resources,
};

const ENVIRONMENT_CHANGED: &str = "synara-environment-changed";
const RESTARTED: &str = "synara-runtime-restarted";
/// The restart offer's notice, replaced or taken down by the next event.
const RESTART_OFFER: &str = "agent-environment-restart";

/// The process's Synara service.
#[derive(Clone)]
pub struct AgentRuntime {
    runtime: Arc<SynaraRuntime>,
}

struct RuntimeGlobal(AgentRuntime);

impl Global for RuntimeGlobal {}

/// The Synara surfaces open in any window, which hear the runtime's events.
#[derive(Default)]
struct Surfaces(Vec<WeakEntity<SynaraSurface>>);

impl Global for Surfaces {}

impl AgentRuntime {
    /// The process's runtime, made on first use.
    pub fn get(cx: &mut App) -> Self {
        if let Some(global) = cx.try_global::<RuntimeGlobal>() {
            return global.0.clone();
        }
        let (sender, mut events) = mpsc::unbounded::<(String, Value)>();
        // The supervisor reports from its own threads.
        let sender = Mutex::new(sender);
        let sink: Arc<dyn EventSink> = Arc::new(move |event: &str, payload: Value| {
            if let Ok(sender) = sender.lock() {
                sender.unbounded_send((event.to_string(), payload)).ok();
            }
        });
        let dirs = resources::app_dirs();
        let runtime = Arc::new(SynaraRuntime::new(
            &Resources {
                bundle_dir: resources::agent_bundle(),
                app_data_dir: dirs.data,
                app_cache_dir: dirs.cache,
            },
            sink,
        ));
        // Stop the service with the app, as the Tauri app does on exit.
        let stopping = runtime.clone();
        cx.on_app_quit(move |_| {
            let stopping = stopping.clone();
            async move { stopping.shutdown() }
        })
        .detach();
        cx.spawn(async move |cx| {
            while let Some((event, payload)) = events.next().await {
                cx.update(|cx| broadcast(&event, payload, cx));
            }
        })
        .detach();
        let agent = Self { runtime };
        cx.set_global(RuntimeGlobal(agent.clone()));
        agent
    }

    pub fn supervisor(&self) -> &Arc<SynaraRuntime> {
        &self.runtime
    }

    /// Start the service if it is not running, off the main thread (a start
    /// verifies the sandbox and polls the service's health for seconds).
    pub fn ensure_ready(&self, cx: &App) -> Task<Result<Value, String>> {
        let runtime = self.runtime.clone();
        cx.background_spawn(async move {
            runtime
                .ensure_ready()
                .and_then(|info| serde_json::to_value(info).map_err(|error| error.to_string()))
        })
    }

    /// Stop the service; every surface asks for the new one (`RESTARTED`).
    pub fn restart(&self, cx: &App) -> Task<()> {
        let runtime = self.runtime.clone();
        cx.background_spawn(async move { runtime.restart() })
    }
}

/// A surface hears the runtime's events from now on.
pub fn register(surface: WeakEntity<SynaraSurface>, cx: &mut App) {
    let surfaces = cx.default_global::<Surfaces>();
    surfaces.0.retain(|surface| surface.upgrade().is_some());
    surfaces.0.push(surface);
}

fn broadcast(event: &str, payload: Value, cx: &mut App) {
    match event {
        ENVIRONMENT_CHANGED => offer_restart(payload.get("stale") == Some(&Value::Bool(true)), cx),
        RESTARTED => notices::dismiss(RESTART_OFFER, cx),
        _ => {}
    }
    let surfaces: Vec<_> = cx
        .try_global::<Surfaces>()
        .map(|surfaces| surfaces.0.clone())
        .unwrap_or_default();
    for surface in surfaces {
        surface
            .update(cx, |surface, cx| surface.runtime_event(event, payload.clone(), cx))
            .ok();
    }
}

/// `agent-environment.ts`'s offer: the service still runs with the proxy it
/// started with; restarting it stops any running turns.
fn offer_restart(stale: bool, cx: &mut App) {
    if !stale {
        notices::dismiss(RESTART_OFFER, cx);
        return;
    }
    let notice = Notice::new(ToastLevel::Warning, t!("The system proxy changed"))
        .detail(t!(
            "The agent still uses the proxy it started with. Restarting it stops any running turns."
        ))
        .key(RESTART_OFFER)
        .persistent()
        .action(NoticeAction::new(t!("Restart agent"), |_, cx| {
            notices::dismiss(RESTART_OFFER, cx);
            AgentRuntime::get(cx).restart(cx).detach();
        }));
    notices::show(notice, cx);
}
