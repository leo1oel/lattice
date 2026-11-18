// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionAlign.tsx` and
//! `actionDistribute.tsx` @ 3a317b5: align the selection's groups to its
//! edges or centers, distribute them evenly; then selected elements that left
//! their frame leave it. `hooks` lays out the moved arrows (elbow routing,
//! labels), as binding's.

use super::ActionResult;
use crate::board::align::{Alignment, Axis, Position, align_elements, distribute_elements};
use crate::board::app_state::AppState;
use crate::board::binding::BindingHooks;
use crate::board::frame::{FrameState, update_frame_membership_of_selected_elements};
use crate::board::groups::get_selected_elements_by_group;
use crate::board::history::CaptureUpdateAction;
use crate::board::selection::{SelectedOpts, get_selected_elements};
use crate::board::types::Element;

fn group_count(elements: &[Element], a: &AppState) -> Option<usize> {
    let selected =
        get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default());
    // TODO upstream: enable aligning / distributing frames
    if selected.iter().any(|e| e.is_frame_like()) {
        return None;
    }
    Some(
        get_selected_elements_by_group(
            &selected,
            &crate::board::utils::array_to_map(elements),
            &a.selected_group_ids,
            a.editing_group_id.as_deref(),
        )
        .len(),
    )
}

/// `alignActionsPredicate`: two or more groups selected, no frames.
pub fn align_actions_predicate(elements: &[Element], a: &AppState) -> bool {
    group_count(elements, a).is_some_and(|n| n > 1)
}
/// Distribute's `enableActionGroup`: three or more groups, no frames.
pub fn distribute_actions_predicate(elements: &[Element], a: &AppState) -> bool {
    group_count(elements, a).is_some_and(|n| n > 2)
}

fn finish(mut next: Vec<Element>, a: &AppState) -> ActionResult {
    update_frame_membership_of_selected_elements(&mut next, &FrameState::new(a, false));
    ActionResult::new(
        Some(next),
        Some(a.clone()),
        CaptureUpdateAction::Immediately,
    )
}

/// `alignSelectedElements`.
pub fn action_align(
    elements: &[Element],
    a: &AppState,
    alignment: Alignment,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let mut next = elements.to_vec();
    let selected: Vec<Element> =
        get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default())
            .into_iter()
            .cloned()
            .collect();
    let refs: Vec<&Element> = selected.iter().collect();
    align_elements(
        &refs,
        alignment,
        &mut next,
        &a.selected_group_ids,
        a.editing_group_id.as_deref(),
        hooks,
    );
    finish(next, a)
}

/// `distributeSelectedElements`.
pub fn action_distribute(
    elements: &[Element],
    a: &AppState,
    axis: Axis,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let mut next = elements.to_vec();
    let selected: Vec<Element> =
        get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default())
            .into_iter()
            .cloned()
            .collect();
    let refs: Vec<&Element> = selected.iter().collect();
    distribute_elements(
        &refs,
        axis,
        &mut next,
        &a.selected_group_ids,
        a.editing_group_id.as_deref(),
        hooks,
    );
    finish(next, a)
}

/// `actionAlignTop` (Cmd+Shift+Up).
pub fn action_align_top(
    elements: &[Element],
    a: &AppState,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    action_align(
        elements,
        a,
        Alignment {
            position: Position::Start,
            axis: Axis::Y,
        },
        hooks,
    )
}
/// `actionAlignBottom` (Cmd+Shift+Down).
pub fn action_align_bottom(
    elements: &[Element],
    a: &AppState,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    action_align(
        elements,
        a,
        Alignment {
            position: Position::End,
            axis: Axis::Y,
        },
        hooks,
    )
}
/// `actionAlignLeft` (Cmd+Shift+Left).
pub fn action_align_left(
    elements: &[Element],
    a: &AppState,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    action_align(
        elements,
        a,
        Alignment {
            position: Position::Start,
            axis: Axis::X,
        },
        hooks,
    )
}
/// `actionAlignRight` (Cmd+Shift+Right).
pub fn action_align_right(
    elements: &[Element],
    a: &AppState,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    action_align(
        elements,
        a,
        Alignment {
            position: Position::End,
            axis: Axis::X,
        },
        hooks,
    )
}
/// `actionAlignVerticallyCentered`.
pub fn action_align_vertically_centered(
    elements: &[Element],
    a: &AppState,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    action_align(
        elements,
        a,
        Alignment {
            position: Position::Center,
            axis: Axis::Y,
        },
        hooks,
    )
}
/// `actionAlignHorizontallyCentered`.
pub fn action_align_horizontally_centered(
    elements: &[Element],
    a: &AppState,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    action_align(
        elements,
        a,
        Alignment {
            position: Position::Center,
            axis: Axis::X,
        },
        hooks,
    )
}
/// `distributeHorizontally` (Alt+H).
pub fn action_distribute_horizontally(
    elements: &[Element],
    a: &AppState,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    action_distribute(elements, a, Axis::X, hooks)
}
/// `distributeVertically` (Alt+V).
pub fn action_distribute_vertically(
    elements: &[Element],
    a: &AppState,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    action_distribute(elements, a, Axis::Y, hooks)
}
