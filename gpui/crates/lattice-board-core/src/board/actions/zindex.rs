// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionZindex.tsx`
//! @ 3a317b5: send backward / bring forward one step, send to back / bring
//! to front (zindex.rs does the work).

use super::ActionResult;
use crate::board::app_state::AppState;
use crate::board::history::CaptureUpdateAction;
use crate::board::types::Element;
use crate::board::zindex::{move_all_left, move_all_right, move_one_left, move_one_right};

fn done(next: Vec<Element>, a: &AppState) -> ActionResult {
    ActionResult::new(
        Some(next),
        Some(a.clone()),
        CaptureUpdateAction::Immediately,
    )
}

/// `actionSendBackward` (Cmd+[).
pub fn action_send_backward(elements: &[Element], a: &AppState) -> ActionResult {
    done(move_one_left(elements, a), a)
}
/// `actionBringForward` (Cmd+]).
pub fn action_bring_forward(elements: &[Element], a: &AppState) -> ActionResult {
    done(move_one_right(elements, a), a)
}
/// `actionSendToBack` (Cmd+Shift+[; Cmd+Alt+[ on macOS).
pub fn action_send_to_back(elements: &[Element], a: &AppState) -> ActionResult {
    done(move_all_left(elements, a), a)
}
/// `actionBringToFront` (Cmd+Shift+]; Cmd+Alt+] on macOS).
pub fn action_bring_to_front(elements: &[Element], a: &AppState) -> ActionResult {
    done(move_all_right(elements, a), a)
}
