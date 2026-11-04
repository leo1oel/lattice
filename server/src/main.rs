#![allow(dead_code, unused_imports)]
#[path = "../../src-tauri/src/headless_core.rs"]
mod domain;
pub(crate) use domain::*;
mod dispatch;
mod literature_credentials;
mod transport;
fn main() {
    transport::main();
}
