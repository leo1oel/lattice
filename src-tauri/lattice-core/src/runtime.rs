//! The async runtime the core spawns on and blocks on.
//!
//! A shell that already runs a tokio runtime hands it over with [`install`]
//! before anything here runs, so the core's tasks share its threads and
//! blocking pool (the Tauri shell installs `tauri::async_runtime`'s). Without
//! one, as in the core's own unit tests, the first use starts a multi-thread
//! runtime that lives for the process.

use std::future::Future;
use std::sync::OnceLock;
use tokio::runtime::{Handle, Runtime};
use tokio::task::JoinHandle;

pub use tokio::sync::mpsc::{channel, Receiver, Sender};

enum Global {
    Installed(Handle),
    Owned(Runtime),
}

static RUNTIME: OnceLock<Global> = OnceLock::new();

/// Run the core on `handle`'s runtime. Only the first call has an effect, and
/// only before anything here has started the fallback runtime.
pub fn install(handle: Handle) {
    let _ = RUNTIME.set(Global::Installed(handle));
}

fn handle() -> &'static Handle {
    let global = RUNTIME
        .get_or_init(|| Global::Owned(Runtime::new().expect("the async runtime could start")));
    match global {
        Global::Installed(handle) => handle,
        Global::Owned(runtime) => runtime.handle(),
    }
}

/// Run `task` to completion on the calling thread.
#[track_caller]
pub fn block_on<F: Future>(task: F) -> F::Output {
    handle().block_on(task)
}

/// Spawn `task` onto the runtime.
#[track_caller]
pub fn spawn<F>(task: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(task)
}

/// Run `work` on the runtime's blocking pool.
#[track_caller]
pub fn spawn_blocking<F, R>(work: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    handle().spawn_blocking(work)
}
