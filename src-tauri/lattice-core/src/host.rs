//! What a shell hands the core: where events and streamed output go, and
//! where its bundled resources and app folders are.
//!
//! The core never names a window toolkit. A watcher or supervisor that
//! announces something takes an [`EventSink`]; an operation that streams
//! (a terminal's output, an install's progress) takes a [`Sink`]; a sidecar
//! supervisor is told its paths through [`Resources`]. Closures implement
//! both sink traits, which is what the core's own tests pass.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Broadcasts named events to every window; each window filters by its own
/// project.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

impl<F> EventSink for F
where
    F: Fn(&str, serde_json::Value) + Send + Sync,
{
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self(event, payload);
    }
}

/// The receiving end of a [`Sink`] is gone: the window reloaded or closed.
#[derive(Debug)]
pub struct Closed;

/// One stream of values to one window, in order.
pub trait Sink<T>: Send + Sync {
    fn send(&self, value: T) -> Result<(), Closed>;
}

impl<T, F> Sink<T> for F
where
    F: Fn(T) -> Result<(), Closed> + Send + Sync,
{
    fn send(&self, value: T) -> Result<(), Closed> {
        self(value)
    }
}

/// A message on a stream that mixes raw bytes with JSON, as a terminal's
/// output (bytes, then `{"exit": code}`) and a live preview's events do.
pub enum StreamBody {
    Raw(Vec<u8>),
    Json(String),
}

/// Paths only the shell can resolve.
pub struct Resources {
    /// The tree holding `synara-runtime/`, `presentation-runtime/` and
    /// `src/embedded_skills/`: the packaged app's resources, or the
    /// [`development_bundle`] while the shell runs from a checkout.
    pub bundle_dir: PathBuf,
    pub app_data_dir: PathBuf,
    pub app_cache_dir: PathBuf,
}

static DEVELOPMENT_BUNDLE: OnceLock<PathBuf> = OnceLock::new();

/// Record that the shell runs from a checkout (`tauri dev`), whose source
/// folder `dir` stands in for the packaged resources. A shell calls this
/// first thing, before anything resolves a tool; only the first call counts.
pub fn set_development_bundle(dir: PathBuf) {
    let _ = DEVELOPMENT_BUNDLE.set(dir);
}

/// The shell's source folder while it runs from a checkout; `None` in a
/// packaged app.
pub fn development_bundle() -> Option<&'static Path> {
    DEVELOPMENT_BUNDLE.get().map(PathBuf::as_path)
}
