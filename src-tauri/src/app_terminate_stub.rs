//! AppKit terminate: is macOS-only; Linux uses the normal window close path.

use tauri::{AppHandle, Runtime};

pub fn install(_app: &AppHandle) {}

pub fn reply<R: Runtime>(_app: &AppHandle<R>, _proceed: bool) {}
