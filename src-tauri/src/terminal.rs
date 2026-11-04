//! The Terminal panel's shells: one login shell per terminal tab, on a
//! pseudo-terminal of its own, owned by the window that opened it.
//!
//! Lifetime is the point of this module. A shell lives exactly as long as its
//! tab: closing the tab, the window's project changing, the window closing or
//! reloading, and Lattice quitting each end it (`terminal_close`,
//! `AppState::retire_unused_projects`, `on_page_load` and
//! `shutdown_child_runtimes`). Ending one hangs up its session, the shell and
//! whatever runs in its foreground, and kills what is still there after a
//! grace period, so a build or a watcher started from a terminal never
//! outlives it. Opening the panel starts nothing but the shell: the Synara
//! sidecar stays down.
//!
//! The parts: `caller` decides which pages may reach a shell at all; `pty` opens the pseudo-terminal and starts the shell in it;
//! `session` streams its output to the window in batches, writes the
//! writer's keys to it, and ends it.

pub(crate) mod caller;
mod pty;
mod session;

pub(crate) use pty::login_shell;
pub(crate) use session::Session;

mod registry;
pub(crate) use registry::Terminals;

#[cfg(test)]
mod tests;
