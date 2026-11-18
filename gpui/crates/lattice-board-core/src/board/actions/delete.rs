// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionDeleteSelected.tsx`
//! @ 3a317b5: deletes the selection with its bound text; a deleted frame
//! leaves its children (selected) or takes them along; selection moves to
//! what's left of the edited group.
//!
//! Left to the app: deleting the selected points while a line is being edited
//! (the linear editor's `delete_points`; this returns no change then), and the
//! tool transients (`multiElement`, `newElement`, `activeEmbeddable`).

use super::ActionResult;
use crate::board::app_state::AppState;
use crate::board::binding::fix_bindings_after_deletion;
use crate::board::frame::get_frame_children;
use crate::board::groups::{get_elements_in_group, select_groups_for_selected_elements};
use crate::board::history::CaptureUpdateAction;
use crate::board::mutate::new_element_with;
use crate::board::selection::{SelectedOpts, get_selected_elements, is_some_element_selected};
use crate::board::types::Element;
use crate::board::utils::ElementsMap;
use rustc_hash::FxHashSet;
use std::collections::BTreeSet;

struct Live<'a>(&'a [Element], rustc_hash::FxHashMap<&'a str, usize>);
impl ElementsMap for Live<'_> {
    fn get_element(&self, id: &str) -> Option<&Element> {
        self.1
            .get(id)
            .map(|&i| &self.0[i])
            .filter(|e| !e.is_deleted)
    }
}

fn live_group<'a>(elements: &'a [Element], g: &str) -> Vec<&'a Element> {
    get_elements_in_group(elements, g)
        .into_iter()
        .filter(|e| !e.is_deleted)
        .collect()
}

/// `deleteSelectedElements`.
fn delete_selected_elements(
    elements: &[Element],
    a: &AppState,
    with_frame_children: bool,
) -> (Vec<Element>, AppState) {
    let frames: Vec<&Element> = elements.iter().filter(|e| e.is_frame_like()).collect();
    let frames: FxHashSet<&str> = frames
        .iter()
        .filter(|e| !e.is_deleted && a.selected_element_ids.contains(&e.id))
        .map(|e| e.id.as_str())
        .collect();
    let child_of_deleted = |e: &Element| e.frame_id.as_deref().is_some_and(|f| frames.contains(f));
    let map = Live(
        elements,
        elements
            .iter()
            .enumerate()
            .map(|(i, e)| (e.id.as_str(), i))
            .collect(),
    );
    let mut selected: BTreeSet<String> = BTreeSet::new();
    let mut processed: FxHashSet<&str> = FxHashSet::default();
    if !with_frame_children {
        let mut ordered: Vec<&&str> = frames.iter().collect();
        ordered.sort();
        for f in ordered {
            for c in get_frame_children(elements, f) {
                if !processed.insert(&c.id) {
                    continue;
                }
                if c.is_bound_to_container() {
                    if let Some(k) = c.container_id().and_then(|id| map.get_element(id)) {
                        selected.insert(k.id.clone());
                    }
                } else {
                    selected.insert(c.id.clone());
                }
            }
        }
    }
    let mut select_editing_group = true;
    let mut unbind_elbows: Vec<(String, String)> = vec![];
    let mut next: Vec<Element> = elements
        .iter()
        .map(|e| {
            if a.selected_element_ids.contains(&e.id)
                || (with_frame_children && child_of_deleted(e))
            {
                let container = e.container_id().and_then(|id| map.get_element(id));
                if !with_frame_children && child_of_deleted(e) {
                    select_editing_group = false;
                    selected.insert(e.id.clone());
                    return e.clone();
                }
                if !with_frame_children && container.is_some_and(child_of_deleted) {
                    return e.clone();
                }
                for b in e.bound_elements.iter().flatten() {
                    if map.get_element(&b.id).is_some_and(|x| x.is_elbow_arrow()) {
                        unbind_elbows.push((b.id.clone(), e.id.clone()));
                    }
                }
                return new_element_with(e, |n| n.is_deleted = true, false);
            }
            // a deleted frame's children leave it, selected
            if child_of_deleted(e) {
                select_editing_group = false;
                if !e.is_bound_to_container() {
                    selected.insert(e.id.clone());
                }
                return new_element_with(e, |n| n.frame_id = None, false);
            }
            if e.container_id()
                .is_some_and(|c| a.selected_element_ids.contains(c))
            {
                return new_element_with(e, |n| n.is_deleted = true, false);
            }
            e.clone()
        })
        .collect();
    // elbow arrows lose the binding to what's deleted (upstream mutates the scene's copy)
    for (arrow, target) in unbind_elbows {
        if let Some(x) = next.iter_mut().find(|x| x.id == arrow) {
            crate::board::mutate::mutate_element(x, |x| {
                if let Some(l) = x.linear_mut() {
                    if l.start_binding
                        .as_ref()
                        .is_some_and(|b| b.element_id == target)
                    {
                        l.start_binding = None;
                    }
                    if l.end_binding
                        .as_ref()
                        .is_some_and(|b| b.element_id == target)
                    {
                        l.end_binding = None;
                    }
                }
            });
        }
    }
    let mut editing = a.editing_group_id.clone();
    // select the next element of the edited group, or of its super group
    if select_editing_group && let Some(g) = a.editing_group_id.as_deref() {
        let members = live_group(&next, g);
        if let Some(first) = members.first() {
            selected.insert(first.id.clone());
        }
        if members.len() <= 1 {
            editing = None;
            if let Some(last) = members.first() {
                let i = last
                    .group_ids
                    .iter()
                    .position(|x| x == g)
                    .map_or(0, |i| i + 1);
                if let Some(sup) = last.group_ids.get(i) {
                    let sup_members = live_group(&next, sup);
                    if sup_members.len() > 1 {
                        editing = Some(sup.clone());
                        selected.extend(sup_members.iter().map(|e| e.id.clone()));
                    }
                }
            }
        }
    }
    let mut app = a.clone();
    select_groups_for_selected_elements(&selected, editing.as_deref(), &next).apply(&mut app);
    (next, app)
}

/// `handleGroupEditingState`: within an edited group, select its first
/// remaining member.
fn handle_group_editing_state(mut a: AppState, elements: &[Element]) -> AppState {
    if let Some(g) = a.editing_group_id.as_deref()
        && let Some(first) = live_group(elements, g).first()
    {
        a.selected_element_ids = BTreeSet::from([first.id.clone()]);
    }
    a
}

/// `actionDeleteSelected` (Delete / Backspace). `with_frame_children`: a
/// deleted frame takes its children along.
pub fn action_delete_selected(
    elements: &[Element],
    a: &AppState,
    with_frame_children: bool,
) -> ActionResult {
    if a.selected_linear_element
        .as_ref()
        .is_some_and(|s| s.is_editing)
    {
        return ActionResult::none();
    }
    let (mut next, app) = delete_selected_elements(elements, a, with_frame_children);
    let deleted: Vec<Element> = next.iter().filter(|e| e.is_deleted).cloned().collect();
    fix_bindings_after_deletion(&mut next, &deleted);
    let mut app = handle_group_editing_state(app, &next);
    app.active_tool = super::update_active_tool(a, a.preferred_selection_tool.ty);
    app.selected_linear_element = None;
    let capture = if is_some_element_selected(elements, &a.selected_element_ids) {
        CaptureUpdateAction::Immediately
    } else {
        CaptureUpdateAction::Eventually
    };
    ActionResult::new(Some(next), Some(app), capture)
}

/// The delete button's `disabled`.
pub fn can_delete_selected(elements: &[Element], a: &AppState) -> bool {
    !get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default()).is_empty()
}
