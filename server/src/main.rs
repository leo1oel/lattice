#![allow(dead_code, unused_imports)]
#[path = "../../src-tauri/src/headless_core.rs"]
mod domain;
pub(crate) use domain::*;
mod agent_broker;
mod agent_cli;
mod agent_control;
mod agent_listener;
mod agent_metadata;
mod agent_processes;
mod agent_runtime;
mod agent_sandbox;
mod agent_seccomp;
mod agent_transport;
mod agent_workspace;
mod dispatch;
mod literature_credentials;
mod project_locks;
mod server_session;
mod terminal;
mod terminal_transport;
mod transport;
fn main() {
    if agent_broker::cli() {
        return;
    }
    transport::main();
}
