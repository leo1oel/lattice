//! Reuse the desktop PTY, flow control, process-group teardown and registry.
#[path = "../../src-tauri/src/terminal/output.rs"]
mod output;
#[path = "../../src-tauri/src/terminal/pty.rs"]
mod pty;
#[path = "../../src-tauri/src/terminal/registry.rs"]
mod registry;
#[path = "../../src-tauri/src/terminal/session.rs"]
mod session;
pub(crate) use output::{Output, OutputMessage};
pub(crate) use registry::Terminals;
pub(crate) use session::Session;
