//! The session where FlashTeX's host cannot run: it never starts, so the
//! window falls back to the normal build (see `session.rs` for the real one).

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Pdflatex,
    Xelatex,
}

#[derive(Debug, Deserialize)]
pub struct Buffer {}

#[derive(Debug, Serialize)]
pub struct CompileReport {}

#[derive(Clone)]
pub struct SessionHandle;

pub struct Session;

const UNSUPPORTED: &str = "The FlashTeX preview needs a Mac with Apple silicon.";

impl Session {
    pub fn start(_root: &Path, _main_file: &str, _engine: Engine) -> Result<Self, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn id(&self) -> u64 {
        0
    }

    pub fn handle(&self) -> SessionHandle {
        SessionHandle
    }

    pub fn stop(self) {}

    pub fn stop_and_wait(self) {}
}

impl SessionHandle {
    pub fn compile(&self, _buffers: Vec<Buffer>) -> Result<CompileReport, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn pdf(&self) -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn sync(&self, _paths: &[String]) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}
