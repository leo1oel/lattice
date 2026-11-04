//! Async execution for domain code that also runs without the desktop shell.
//!
//! Desktop commands and the server enter a Tokio runtime before calling the
//! domain. Synchronous command-line consumers use a lazily owned runtime.
use std::future::Future;
use std::sync::OnceLock;
use tokio::runtime::{Handle, Runtime};
pub(crate) use tokio::sync::mpsc::{channel, Receiver, Sender};

fn handle() -> Handle {
    Handle::try_current().unwrap_or_else(|_| {
        static RUNTIME: OnceLock<Runtime> = OnceLock::new();
        RUNTIME
            .get_or_init(|| Runtime::new().expect("Could not start domain async runtime"))
            .handle()
            .clone()
    })
}
pub(crate) fn block_on<F: Future>(future: F) -> F::Output {
    handle().block_on(future)
}
pub(crate) fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(future)
}
pub(crate) fn spawn_blocking<F, R>(work: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    handle().spawn_blocking(work)
}
