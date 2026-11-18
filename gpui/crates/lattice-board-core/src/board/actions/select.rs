// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionSelectAll.ts` and
//! `actionDeselect.ts` @ 3a317b5. Escape's key test (what's mid-gesture) is
//! the app's; cursor and popups too.

use super::{ActionResult, update_active_tool};
use crate::board::app_state::{ActiveTool, AppState, SelectedLinearElement, ToolType};
use crate::board::groups::{get_elements_in_group, select_groups_for_selected_elements};
use crate::board::history::CaptureUpdateAction;
use crate::board::selection::{SelectedOpts, get_selected_elements};
use crate::board::types::Element;
use std::collections::{BTreeMap, BTreeSet};

/// `actionSelectAll` (Cmd+A): everything but bound text and locked elements,
/// with their groups; nothing while a line is being edited.
pub fn action_select_all(elements: &[Element], a: &AppState) -> ActionResult {
    if a.selected_linear_element
        .as_ref()
        .is_some_and(|s| s.is_editing)
    {
        return ActionResult::none();
    }
    let ids: BTreeSet<String> = elements
        .iter()
        .filter(|e| !e.is_deleted && !e.is_bound_to_container() && !e.locked)
        .map(|e| e.id.clone())
        .collect();
    let mut app = a.clone();
    select_groups_for_selected_elements(&ids, None, elements).apply(&mut app);
    // a lone linear element gets its editor (upstream checks the first element)
    app.selected_linear_element = (ids.len() == 1
        && elements.first().is_some_and(|e| e.is_linear()))
    .then(|| SelectedLinearElement {
        element_id: elements[0].id.clone(),
        is_editing: false,
    });
    ActionResult::new(None, Some(app), CaptureUpdateAction::Immediately)
}

/// `getNextActiveTool`: from a toggle tool (hand, eraser) back to the last
/// one, else the preferred selection tool.
fn next_active_tool(a: &AppState) -> ActiveTool {
    if matches!(a.active_tool.ty, ToolType::Hand | ToolType::Eraser) {
        let ty = a
            .active_tool
            .last_active_tool
            .unwrap_or(a.preferred_selection_tool.ty);
        return ActiveTool {
            last_active_tool: None,
            ..update_active_tool(a, ty)
        };
    }
    update_active_tool(a, a.preferred_selection_tool.ty)
}

/// `getParentEditingGroupId`: the group around the edited one.
fn parent_editing_group_id(
    elements: &[Element],
    a: &AppState,
    selected_ids: &BTreeSet<String>,
) -> Option<String> {
    let ed = a.editing_group_id.as_deref()?;
    let sel = get_selected_elements(elements, selected_ids, SelectedOpts::default());
    let candidates = if sel.is_empty() {
        get_elements_in_group(elements, ed)
            .into_iter()
            .filter(|e| !e.is_deleted)
            .collect()
    } else {
        sel
    };
    candidates.iter().find_map(|e| {
        e.group_ids
            .iter()
            .position(|g| g == ed)
            .and_then(|i| e.group_ids.get(i + 1))
            .cloned()
    })
}

/// `actionDeselect` (Escape): leaves the edited group (selecting it within
/// its parent), else clears the selection; back to the selection tool.
pub fn action_deselect(elements: &[Element], a: &AppState) -> ActionResult {
    let mut app = a.clone();
    app.active_tool = next_active_tool(a);
    app.selected_linear_element = None;
    app.frame_to_highlight = None;
    if let Some(ed) = a.editing_group_id.as_deref() {
        let ids = if !a.selected_element_ids.is_empty() {
            a.selected_element_ids.clone()
        } else {
            get_elements_in_group(elements, ed)
                .iter()
                .filter(|e| !e.is_deleted)
                .map(|e| e.id.clone())
                .collect()
        };
        let parent = parent_editing_group_id(elements, a, &ids);
        select_groups_for_selected_elements(&ids, parent.as_deref(), elements).apply(&mut app);
    } else {
        app.editing_group_id = None;
        app.selected_element_ids = BTreeSet::new();
        app.selected_group_ids = BTreeMap::new();
    }
    ActionResult::new(None, Some(app), CaptureUpdateAction::Immediately)
}
