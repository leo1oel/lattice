// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The tool state machines, split as upstream splits `App.tsx`:
//! `selection` (App.selectionTool / App.selection), `shape` (generic
//! shapes, frames, sticky notes: App.drawshape / App.toolDrag),
//! `linear` (lines and arrows, click by click or dragged), `freedraw`,
//! `text` (App.text / App.textTool), `eraser`, `lasso`, `image` (picker and
//! drops), `crop` (the image crop editor), `flowchart` (App.flowchart). Each takes the pointer in scene
//! coordinates; `canvas` routes events to the active tool.

pub mod crop;
pub mod eraser;
pub mod flowchart;
pub mod freedraw;
pub mod image;
pub mod lasso;
pub mod linear;
pub mod selection;
pub mod shape;
pub mod text;

use super::BoardView;
use super::app_state::ToolType;

/// After drawing: back to the selection tool unless the tool is locked.
pub(crate) fn tool_done(me: &mut BoardView) {
    if !me.app.active_tool.locked {
        me.app.active_tool =
            super::actions::update_active_tool(&me.app, me.app.preferred_selection_tool.ty);
        if me.app.active_tool.ty != ToolType::Selection {
            me.app.active_tool.ty = ToolType::Selection;
        }
    }
}
