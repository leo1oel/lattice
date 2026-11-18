// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Selection. Port of Excalidraw `packages/element/src/selection.ts` and
//! `showSelectedShapeActions.ts` @ 3a317b5, with the selection-state
//! functions of `excalidraw/components/App.selection.ts`
//! (`getSelectionStateForElements`, `…AddingElements`, `…RemovingElements`).
//!
//! Element lists are slices of the scene's elements, deleted ones included
//! (see `groups.rs`). `isSomeElementSelected` has no cache. The "line editor"
//! these give a lone selected line or arrow is `SelectedLinearElement`
//! (the linear editor's own state is the app's).

use super::app_state::{AppState, SelectedLinearElement, ToolType};
use super::bounds::{
    BBoxMode, OverlapQuery, elements_overlapping_bbox, get_element_absolute_coords,
};
use super::frame::get_frame_children;
use super::groups::{
    GroupSelection, get_selected_group_for_element, select_groups_for_selected_elements,
};
use super::size_helpers::{ViewTransform, is_element_in_viewport};
use super::types::Element;
use super::utils::ElementsMap;
use rustc_hash::FxHashSet;
use std::collections::{BTreeMap, BTreeSet};

/// `shouldIgnoreElementFromSelection`: locked elements and bound text.
pub fn should_ignore_element_from_selection(e: &Element) -> bool {
    e.locked || e.is_bound_to_container()
}

/// `excludeElementsInFramesFromSelection`: frames win over their children.
pub fn exclude_elements_in_frames_from_selection<'a>(selected: &[&'a Element]) -> Vec<&'a Element> {
    let frames: FxHashSet<&str> = selected
        .iter()
        .filter(|e| e.is_frame_like())
        .map(|e| e.id.as_str())
        .collect();
    selected
        .iter()
        .filter(|e| !e.frame_id.as_deref().is_some_and(|f| frames.contains(f)))
        .copied()
        .collect()
}

/// `getElementsWithinSelection`: what the selection box `selection` picks.
pub fn get_elements_within_selection<'e>(
    elements: &'e [Element],
    selection: &Element,
    map: &dyn ElementsMap,
    exclude_elements_in_frames: bool,
    mode: BBoxMode,
) -> Vec<&'e Element> {
    let [x1, y1, x2, y2, ..] = get_element_absolute_coords(selection, map, false);
    let ignore = should_ignore_element_from_selection;
    let q = OverlapQuery {
        bounds: [x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)],
        mode,
        exclude_elements_in_frames,
        ignore: Some(&ignore),
        include_stroke: true,
    };
    elements_overlapping_bbox(elements, map, &q)
}

/// `getVisibleAndNonSelectedElements`. `width`/`height`: the viewport's.
pub fn get_visible_and_non_selected_elements<'a>(
    elements: &'a [Element],
    selected: &[&Element],
    a: &AppState,
    width: f64,
    height: f64,
    map: &dyn ElementsMap,
) -> Vec<&'a Element> {
    let sel: FxHashSet<&str> = selected.iter().map(|e| e.id.as_str()).collect();
    let v = ViewTransform {
        zoom: a.zoom,
        offset_left: 0.,
        offset_top: 0.,
        scroll_x: a.scroll_x,
        scroll_y: a.scroll_y,
    };
    elements
        .iter()
        .filter(|e| {
            !e.is_deleted
                && !sel.contains(e.id.as_str())
                && is_element_in_viewport(e, width, height, &v, map)
        })
        .collect()
}

/// `isSomeElementSelected`.
pub fn is_some_element_selected(
    elements: &[Element],
    selected_element_ids: &BTreeSet<String>,
) -> bool {
    elements
        .iter()
        .any(|e| !e.is_deleted && selected_element_ids.contains(&e.id))
}

/// `getSelectedElements` options.
#[derive(Clone, Copy, Debug, Default)]
pub struct SelectedOpts {
    pub include_bound_text_element: bool,
    pub include_elements_in_frames: bool,
}

/// `getSelectedElements`: the selected non-deleted elements in order;
/// optionally with the bound text of selected containers, and with the
/// children of selected frames (before the frame).
pub fn get_selected_elements<'a>(
    elements: &'a [Element],
    selected_element_ids: &BTreeSet<String>,
    opts: SelectedOpts,
) -> Vec<&'a Element> {
    let mut added: FxHashSet<&str> = FxHashSet::default();
    let mut out: Vec<&'a Element> = vec![];
    for e in elements {
        if selected_element_ids.contains(&e.id) {
            // selection can only hold non-deleted elements
            if !e.is_deleted {
                out.push(e);
                added.insert(&e.id);
            }
            continue;
        }
        if opts.include_bound_text_element
            && !e.is_deleted
            && e.container_id()
                .is_some_and(|c| selected_element_ids.contains(c))
        {
            out.push(e);
            added.insert(&e.id);
        }
    }
    if !opts.include_elements_in_frames {
        return out;
    }
    let mut with_children = vec![];
    for e in out {
        if e.is_frame_like() {
            with_children.extend(
                get_frame_children(elements, &e.id)
                    .into_iter()
                    .filter(|c| !added.contains(c.id.as_str())),
            );
        }
        with_children.push(e);
    }
    with_children
}

/// `getTargetElements`: the edited text, else the selection with bound text.
/// (`newElement` is a tool transient; the tool passes it as `editing`.)
pub fn get_target_elements<'a>(elements: &'a [Element], a: &AppState) -> Vec<&'a Element> {
    if let Some(t) = a
        .editing_text_element
        .as_deref()
        .and_then(|id| elements.iter().find(|e| e.id == id))
    {
        return vec![t];
    }
    get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            ..Default::default()
        },
    )
}

/// `getActiveTextElement`: the edited text, or a lone selected text.
pub fn get_active_text_element<'a>(
    selected: &[&'a Element],
    elements: &'a [Element],
    a: &AppState,
) -> Option<&'a Element> {
    if let Some(t) = a
        .editing_text_element
        .as_deref()
        .and_then(|id| elements.iter().find(|e| e.id == id))
    {
        return Some(t);
    }
    (selected.len() == 1 && selected[0].is_text()).then(|| selected[0])
}

/// `showSelectedShapeActions`: whether the properties panel shows (view mode,
/// custom tools and the link selector dialog aren't ours).
pub fn show_selected_shape_actions(a: &AppState, elements: &[Element]) -> bool {
    a.editing_text_element.is_some()
        || !matches!(
            a.active_tool.ty,
            ToolType::Selection
                | ToolType::Lasso
                | ToolType::Eraser
                | ToolType::Hand
                | ToolType::Laser
        )
        || !get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default())
            .is_empty()
}

// ---------------------------------------------------------------------------
// App.selection.ts
// ---------------------------------------------------------------------------

/// A selection with the line editor of what it selects.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SelectionState {
    pub groups: GroupSelection,
    pub selected_linear_element: Option<SelectedLinearElement>,
}

impl SelectionState {
    pub fn apply(self, a: &mut AppState) {
        self.groups.apply(a);
        a.selected_linear_element = self.selected_linear_element;
    }
}

/// `getLinearElementEditor`: of a lone selected line or arrow (with its
/// labels); the current one if it's already that element's.
fn linear_editor_for(targets: &[&Element], a: &AppState) -> Option<SelectedLinearElement> {
    let linears: Vec<&&Element> = targets.iter().filter(|e| e.is_linear()).collect();
    let [linear] = linears.as_slice() else {
        return None;
    };
    let bound: Vec<&str> = linear
        .bound_elements
        .iter()
        .flatten()
        .map(|b| b.id.as_str())
        .collect();
    if !targets
        .iter()
        .all(|e| e.id == linear.id || bound.contains(&e.id.as_str()))
    {
        return None;
    }
    if let Some(s) = a
        .selected_linear_element
        .as_ref()
        .filter(|s| s.element_id == linear.id)
    {
        return Some(s.clone());
    }
    Some(SelectedLinearElement {
        element_id: linear.id.clone(),
        is_editing: false,
    })
}

fn with_linear_editor(
    groups: GroupSelection,
    elements: &[Element],
    a: &AppState,
) -> SelectionState {
    let selected = get_selected_elements(
        elements,
        &groups.selected_element_ids,
        SelectedOpts::default(),
    );
    let selected_linear_element = linear_editor_for(&selected, a);
    SelectionState {
        groups,
        selected_linear_element,
    }
}

/// `getFramesSelectedViaGroups`: frames grouped with the (frame-less)
/// elements, within the edited group.
fn frames_selected_via_groups(
    targets: &[&Element],
    elements: &[Element],
    editing_group_id: Option<&str>,
) -> FxHashSet<String> {
    let mut groups: FxHashSet<&str> = FxHashSet::default();
    for e in targets {
        if e.is_frame_like() || e.frame_id.is_some() {
            continue;
        }
        let g = match editing_group_id.and_then(|ed| e.group_ids.iter().position(|x| x == ed)) {
            Some(i) => &e.group_ids[..i],
            None => &e.group_ids[..],
        };
        if let Some(last) = g.last() {
            groups.insert(last);
        }
    }
    if groups.is_empty() {
        return FxHashSet::default();
    }
    elements
        .iter()
        .filter(|e| {
            !e.is_deleted
                && e.is_frame_like()
                && e.group_ids.iter().any(|g| groups.contains(g.as_str()))
        })
        .map(|e| e.id.clone())
        .collect()
}

/// `getSelectionStateForElements`: the selection of `targets` alone, with
/// their groups; a frame wins over its children, bound text is left to its
/// container. `deep`: the elements themselves, editing their shared
/// innermost group (Ctrl+click).
pub fn get_selection_state_for_elements(
    targets: &[&Element],
    elements: &[Element],
    a: &AppState,
    deep: bool,
) -> SelectionState {
    let targets: Vec<&Element> = targets
        .iter()
        .filter(|e| !e.is_bound_to_container())
        .copied()
        .collect();
    let mut editing = a.editing_group_id.clone();
    if deep {
        let inner: FxHashSet<Option<&String>> =
            targets.iter().map(|e| e.group_ids.first()).collect();
        editing = if inner.len() == 1 {
            inner.into_iter().next().unwrap().cloned()
        } else {
            None
        };
    }
    let mut frames = if deep {
        FxHashSet::default()
    } else {
        frames_selected_via_groups(&targets, elements, editing.as_deref())
    };
    frames.extend(
        targets
            .iter()
            .filter(|e| e.is_frame_like())
            .map(|e| e.id.clone()),
    );
    let ids: BTreeSet<String> = targets
        .iter()
        .filter(|e| !e.frame_id.as_ref().is_some_and(|f| frames.contains(f)))
        .map(|e| e.id.clone())
        .collect();
    let groups = if deep {
        GroupSelection {
            selected_element_ids: ids,
            selected_group_ids: BTreeMap::new(),
            editing_group_id: editing,
        }
    } else {
        select_groups_for_selected_elements(&ids, editing.as_deref(), elements)
    };
    with_linear_editor(groups, elements, a)
}

/// `getSelectionStateAddingElements` (the element-link selector dialog isn't
/// ours).
pub fn get_selection_state_adding_elements(
    targets: &[&Element],
    elements: &[Element],
    a: &AppState,
) -> SelectionState {
    let targets: Vec<&Element> = targets
        .iter()
        .filter(|e| !e.is_bound_to_container())
        .copied()
        .collect();
    let mut next = a.selected_element_ids.clone();
    next.extend(targets.iter().map(|e| e.id.clone()));
    let added_frames: FxHashSet<&str> = targets
        .iter()
        .filter(|e| e.is_frame_like())
        .map(|e| e.id.as_str())
        .collect();
    let in_groups = frames_selected_via_groups(&targets, elements, a.editing_group_id.as_deref());
    for e in &targets {
        if !e.is_frame_like()
            && let Some(f) = &e.frame_id
            && (next.contains(f) || in_groups.contains(f))
        {
            next.remove(&e.id);
        }
    }
    if !added_frames.is_empty() || !in_groups.is_empty() {
        let mut deselected: FxHashSet<&str> = FxHashSet::default();
        for e in elements.iter().filter(|e| !e.is_deleted) {
            let Some(f) = &e.frame_id else { continue };
            if !a.selected_element_ids.contains(&e.id) {
                continue;
            }
            if added_frames.contains(f.as_str()) {
                next.remove(&e.id);
            }
            if in_groups.contains(f) {
                next.remove(&e.id);
                deselected.extend(e.group_ids.iter().map(|g| g.as_str()));
            }
        }
        if !deselected.is_empty() {
            for e in elements.iter().filter(|e| !e.is_deleted) {
                if e.group_ids.iter().any(|g| deselected.contains(g.as_str())) {
                    next.remove(&e.id);
                }
            }
        }
    }
    with_linear_editor(
        select_groups_for_selected_elements(&next, a.editing_group_id.as_deref(), elements),
        elements,
        a,
    )
}

/// `getSelectionStateRemovingElements`: with the group they're selected via.
pub fn get_selection_state_removing_elements(
    targets: &[&Element],
    elements: &[Element],
    a: &AppState,
) -> SelectionState {
    let mut next = a.selected_element_ids.clone();
    let mut removed: FxHashSet<&str> = FxHashSet::default();
    for e in targets {
        next.remove(&e.id);
        if let Some(g) =
            get_selected_group_for_element(&a.selected_group_ids, a.editing_group_id.as_deref(), e)
        {
            removed.insert(g);
        }
    }
    if !removed.is_empty() {
        for e in elements.iter().filter(|e| !e.is_deleted) {
            if e.group_ids.iter().any(|g| removed.contains(g.as_str())) {
                next.remove(&e.id);
            }
        }
    }
    with_linear_editor(
        select_groups_for_selected_elements(&next, a.editing_group_id.as_deref(), elements),
        elements,
        a,
    )
}
