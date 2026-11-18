// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Editor actions: the element logic of Excalidraw `packages/excalidraw/actions/*`
//! @ 3a317b5, one function per action. The app wires menus, shortcuts and the
//! properties panel to them (`shortcuts.ts`, `manager.tsx`, the panel
//! components are the app's).
//!
//! Each action takes the scene's elements (deleted included, z-order) and the
//! app state, and returns an `ActionResult` (upstream's `ActionResult`):
//! the next elements, the next app state, and how history captures it
//! (`captureUpdate`). `None` keeps what was there. Submodules group them by
//! the upstream file; everything is re-exported here.

use super::app_state::AppState;
use super::history::CaptureUpdateAction;
use super::types::Element;

/// `ActionResult`.
#[derive(Clone, Debug)]
pub struct ActionResult {
    pub elements: Option<Vec<Element>>,
    pub app_state: Option<AppState>,
    pub capture_update: CaptureUpdateAction,
}

impl ActionResult {
    pub fn new(
        elements: Option<Vec<Element>>,
        app_state: Option<AppState>,
        capture_update: CaptureUpdateAction,
    ) -> Self {
        ActionResult {
            elements,
            app_state,
            capture_update,
        }
    }
    /// Nothing changed (`{ captureUpdate: EVENTUALLY }` / `false` upstream).
    pub fn none() -> Self {
        ActionResult {
            elements: None,
            app_state: None,
            capture_update: CaptureUpdateAction::Eventually,
        }
    }
}

/// `updateActiveTool(appState, { type })`: switch tools, keeping the lock
/// and the tool to go back to.
pub fn update_active_tool(
    a: &AppState,
    ty: super::app_state::ToolType,
) -> super::app_state::ActiveTool {
    super::app_state::ActiveTool {
        ty,
        from_selection: false,
        ..a.active_tool.clone()
    }
}

mod align;
mod canvas;
mod delete;
mod duplicate;
mod flip;
mod frame;
mod group;
mod lock;
mod properties;
mod select;
mod styles;
mod text;
mod zindex;
pub use align::*;
pub use canvas::*;
pub use delete::*;
pub use duplicate::*;
pub use flip::*;
pub use frame::*;
pub use group::*;
pub use lock::*;
pub use properties::*;
pub use select::*;
pub use styles::*;
pub use text::*;
pub use zindex::*;
