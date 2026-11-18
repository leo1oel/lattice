// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionElementLock.ts`
//! @ 3a317b5: lock / unlock the selection (Cmd+Shift+L) and unlock all.
//! Several elements locked together get a temporary group, remembered in
//! `lockedMultiSelections`, so they unlock as one.

use super::ActionResult;
use crate::board::app_state::AppState;
use crate::board::groups::{
    GroupSelection, elements_are_in_same_group, select_groups_from_given_elements,
};
use crate::board::history::CaptureUpdateAction;
use crate::board::mutate::new_element_with;
use crate::board::random::random_id;
use crate::board::selection::{SelectedOpts, get_selected_elements};
use crate::board::types::Element;
use rustc_hash::FxHashSet;
use std::collections::{BTreeMap, BTreeSet};

/// `shouldLock`: none of them is locked.
pub fn should_lock(elements: &[&Element]) -> bool {
    elements.iter().all(|e| !e.locked)
}

/// `actionToggleElementLock`'s predicate: something selected, nothing locked
/// in a frame.
pub fn can_toggle_element_lock(elements: &[Element], a: &AppState) -> bool {
    let sel = get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default());
    !sel.is_empty() && !sel.iter().any(|e| e.locked && e.frame_id.is_some())
}

fn without_temp_groups(e: &Element, a: &AppState) -> Vec<String> {
    e.group_ids
        .iter()
        .filter(|g| !a.locked_multi_selections.contains(*g))
        .cloned()
        .collect()
}

/// `actionToggleElementLock`.
pub fn action_toggle_element_lock(elements: &[Element], a: &AppState) -> ActionResult {
    let selected = get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            include_elements_in_frames: true,
        },
    );
    if selected.is_empty() {
        return ActionResult::none();
    }
    let lock = should_lock(&selected);
    let ids: FxHashSet<&str> = selected.iter().map(|e| e.id.as_str()).collect();
    let is_group = selected.len() > 1 && elements_are_in_same_group(&selected);
    let new_group = (!(selected.len() == 1 || is_group)).then(random_id);
    let mut multi = a.locked_multi_selections.clone();
    if lock {
        if let Some(g) = &new_group {
            multi.insert(g.clone());
        }
    } else if is_group && let Some(g) = selected[0].group_ids.last() {
        multi.remove(g);
    }
    let next: Vec<Element> = elements
        .iter()
        .map(|e| {
            if !ids.contains(e.id.as_str()) {
                return e.clone();
            }
            let mut g = e.group_ids.clone();
            if lock {
                if let Some(n) = &new_group {
                    g.push(n.clone());
                }
            } else {
                g = without_temp_groups(e, a);
            }
            new_element_with(
                e,
                |n| {
                    n.locked = lock;
                    n.group_ids = g;
                },
                false,
            )
        })
        .collect();
    let mut app = a.clone();
    if lock {
        app.selected_element_ids = BTreeSet::new();
        app.selected_group_ids = BTreeMap::new();
        app.selected_linear_element = None;
        app.active_locked_id = Some(match &new_group {
            Some(g) => g.clone(),
            None if is_group => selected[0].group_ids.last().unwrap().clone(),
            None => selected[0].id.clone(),
        });
    } else {
        app.selected_element_ids = selected.iter().map(|e| e.id.clone()).collect();
        let unlocked: Vec<Element> = next
            .iter()
            .filter(|e| ids.contains(e.id.as_str()) && !e.is_deleted)
            .cloned()
            .collect();
        app.selected_group_ids =
            select_groups_from_given_elements(&unlocked, &GroupSelection::of(a));
        app.active_locked_id = None;
    }
    app.locked_multi_selections = multi;
    ActionResult::new(Some(next), Some(app), CaptureUpdateAction::Immediately)
}

/// `actionUnlockAllElements`' predicate: nothing selected, something locked.
pub fn can_unlock_all_elements(elements: &[Element], a: &AppState) -> bool {
    get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default()).is_empty()
        && elements.iter().any(|e| e.locked)
}

/// `actionUnlockAllElements`: unlocks everything and selects it.
pub fn action_unlock_all_elements(elements: &[Element], a: &AppState) -> ActionResult {
    let next: Vec<Element> = elements
        .iter()
        .map(|e| {
            if e.locked {
                let g = without_temp_groups(e, a);
                new_element_with(
                    e,
                    |n| {
                        n.locked = false;
                        n.group_ids = g;
                    },
                    false,
                )
            } else {
                e.clone()
            }
        })
        .collect();
    let unlocked: Vec<Element> = next
        .iter()
        .zip(elements)
        .filter(|(n, o)| o.locked && !n.is_deleted)
        .map(|(n, _)| n.clone())
        .collect();
    let mut app = a.clone();
    app.selected_element_ids = unlocked.iter().map(|e| e.id.clone()).collect();
    app.selected_group_ids = select_groups_from_given_elements(&unlocked, &GroupSelection::of(a));
    app.locked_multi_selections = BTreeSet::new();
    app.active_locked_id = None;
    ActionResult::new(Some(next), Some(app), CaptureUpdateAction::Immediately)
}
