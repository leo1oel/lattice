// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Frames: membership, children, clipping. Port of Excalidraw
//! `packages/element/src/frame.ts` @ 3a317b5. Magic frames are frames here
//! (`is_frame_like`). Geometry shared with bounds lives in `bounds.rs`
//! (`is_element_intersecting_frame`, `element_overlaps_with_frame`,
//! `get_containing_frame`, `is_frame_clippable`).
//!
//! Element lists are slices of the scene's elements, deleted ones included,
//! as in `groups.rs`. Functions that scan the scene and look elements up take
//! both the slice and a map (a `Scene`, or `array_to_map` of the slice).
//! Upstream mutates element objects in place: here functions that only set
//! `frameId` take a `BindingStore` and elements by id; those that also reorder
//! take the `Vec`. What upstream reads from `appState` (plus the drag
//! transient `selectedElementsAreBeingDragged`) comes in a `FrameState`.

use super::app_state::AppState;
use super::binding::BindingStore;
use super::bounds::{
    BBoxMode, Bounds, OverlapQuery, bounds_contain_bounds, do_bounds_intersect,
    element_overlaps_with_frame, elements_overlapping_bbox, get_bound_text_element,
    get_common_bounds, get_container_element, get_containing_frame, get_element_absolute_coords,
    get_element_bounds, get_point_at_index_global_coordinates, is_element_intersecting_frame,
    is_frame_clippable,
};
use super::fractional_index::sync_moved_indices;
use super::groups::{GroupSelection, get_elements_in_group, select_groups_from_given_elements};
use super::math::{PRECISION, is_point_within_bounds};
use super::mutate::mutate_element;
use super::selection::{SelectedOpts, get_selected_elements, should_ignore_element_from_selection};
use super::types::{BoundType, Element, StartOrEnd};
use super::utils::ElementsMap;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BTreeSet;

/// What frame membership reads from `appState`, with the drag transient.
#[derive(Clone, Copy, Debug)]
pub struct FrameState<'a> {
    pub selected_element_ids: &'a BTreeSet<String>,
    pub editing_group_id: Option<&'a str>,
    pub frame_to_highlight: Option<&'a str>,
    /// `selectedElementsAreBeingDragged`.
    pub being_dragged: bool,
    /// `frameRendering.clip`.
    pub clip: bool,
}

impl<'a> FrameState<'a> {
    pub fn new(a: &'a AppState, being_dragged: bool) -> Self {
        FrameState {
            selected_element_ids: &a.selected_element_ids,
            editing_group_id: a.editing_group_id.as_deref(),
            frame_to_highlight: a.frame_to_highlight.as_deref(),
            being_dragged,
            clip: a.frame_rendering.clip,
        }
    }
    fn selected(&self, id: &str) -> bool {
        self.selected_element_ids.contains(id)
    }
}

/// `bindElementsToFramesAfterDuplication`: duplicates of elements in a frame
/// go into the frame's duplicate, or out of frames if it wasn't duplicated.
pub fn bind_elements_to_frames_after_duplication(
    next: &mut [Element],
    orig: &[Element],
    orig_to_dup: &FxHashMap<String, String>,
) {
    let pos: FxHashMap<String, usize> = next
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.clone(), i))
        .collect();
    for e in orig {
        let Some(fid) = &e.frame_id else { continue };
        let next_frame = orig_to_dup.get(fid).cloned();
        if let Some(&i) = orig_to_dup.get(&e.id).and_then(|id| pos.get(id)) {
            mutate_element(&mut next[i], |n| n.frame_id = next_frame);
        }
    }
}

/// What's in the frame: to a hair beyond its edges.
fn frame_inner_bounds(frame: &Element, map: &dyn ElementsMap) -> Bounds {
    let [a, b, c, d] = get_element_bounds(frame, map, false);
    [a - PRECISION, b - PRECISION, c + PRECISION, d + PRECISION]
}

/// `getElementsCompletelyInFrame`: by their outlines, without groups holding
/// frames; frame-less elements or the frame's own children.
pub fn get_elements_completely_in_frame<'a>(
    elements: &'a [Element],
    frame: &Element,
    map: &dyn ElementsMap,
) -> Vec<&'a Element> {
    let ignore = should_ignore_element_from_selection;
    let q = OverlapQuery {
        bounds: frame_inner_bounds(frame, map),
        mode: BBoxMode::Contain,
        exclude_elements_in_frames: false,
        ignore: Some(&ignore),
        include_stroke: false,
    };
    let picked = elements_overlapping_bbox(elements, map, &q);
    omit_groups_impl(&picked, &picked)
        .into_iter()
        .filter(|e| {
            (!e.is_frame_like() && e.frame_id.is_none())
                || e.frame_id.as_deref() == Some(frame.id.as_str())
        })
        .collect()
}

/// `isElementContainingFrame`.
pub fn is_element_containing_frame(e: &Element, frame: &Element, map: &dyn ElementsMap) -> bool {
    bounds_contain_bounds(
        get_element_bounds(e, map, false),
        get_element_bounds(frame, map, false),
    )
}

/// `getElementsIntersectingFrame`.
pub fn get_elements_intersecting_frame<'a>(
    elements: &'a [Element],
    frame: &Element,
    map: &dyn ElementsMap,
) -> Vec<&'a Element> {
    elements
        .iter()
        .filter(|e| is_element_intersecting_frame(e, frame, map))
        .collect()
}

/// `elementsAreInFrameBounds`.
pub fn elements_are_in_frame_bounds(
    elements: &[&Element],
    frame: &Element,
    map: &dyn ElementsMap,
) -> bool {
    let [fx1, fy1, fx2, fy2] = frame_inner_bounds(frame, map);
    let [x1, y1, x2, y2] = get_common_bounds(elements.iter().copied(), map);
    fx1 <= x1 && fy1 <= y1 && fx2 >= x2 && fy2 >= y2
}

/// `isCursorInFrame`.
pub fn is_cursor_in_frame(x: f64, y: f64, frame: &Element, map: &dyn ElementsMap) -> bool {
    let [fx1, fy1, fx2, fy2, ..] = get_element_absolute_coords(frame, map, false);
    is_point_within_bounds([fx1, fy1], [x, y], [fx2, fy2])
}

fn group_members<'a>(elements: &'a [Element], group_ids: &[String]) -> Vec<&'a Element> {
    group_ids
        .iter()
        .flat_map(|g| get_elements_in_group(elements, g))
        .collect()
}

/// `groupsAreAtLeastIntersectingTheFrame`.
pub fn groups_are_at_least_intersecting_the_frame(
    elements: &[Element],
    group_ids: &[String],
    frame: &Element,
    map: &dyn ElementsMap,
) -> bool {
    let members = group_members(elements, group_ids);
    members.is_empty()
        || members.iter().any(|e| {
            elements_are_in_frame_bounds(&[e], frame, map)
                || is_element_intersecting_frame(e, frame, map)
        })
}

/// `groupsAreCompletelyOutOfFrame`.
pub fn groups_are_completely_out_of_frame(
    elements: &[Element],
    group_ids: &[String],
    frame: &Element,
    map: &dyn ElementsMap,
) -> bool {
    let members = group_members(elements, group_ids);
    members.is_empty()
        || !members.iter().any(|e| {
            elements_are_in_frame_bounds(&[e], frame, map)
                || is_element_intersecting_frame(e, frame, map)
        })
}

// --------------------------- Frame Utils ------------------------------------

/// `groupByFrameLikes`: frame id → its children, empty frames included, in
/// first-seen order.
pub fn group_by_frame_likes(elements: &[Element]) -> Vec<(String, Vec<&Element>)> {
    let mut out: Vec<(String, Vec<&Element>)> = vec![];
    for e in elements {
        let Some(fid) = (if e.is_frame_like() {
            Some(&e.id)
        } else {
            e.frame_id.as_ref()
        }) else {
            continue;
        };
        if !out.iter().any(|(k, _)| k == fid) {
            out.push((fid.clone(), get_frame_children(elements, fid)));
        }
    }
    out
}

/// `getFrameChildren` (deleted ones included, as given).
pub fn get_frame_children<'a>(elements: &'a [Element], frame_id: &str) -> Vec<&'a Element> {
    elements
        .iter()
        .filter(|e| e.frame_id.as_deref() == Some(frame_id))
        .collect()
}

/// `getFrameLikeElements`.
pub fn get_frame_like_elements(elements: &[Element]) -> Vec<&Element> {
    elements.iter().filter(|e| e.is_frame_like()).collect()
}

/// `getRootElements`: frames and elements not in a frame of the set.
pub fn get_root_elements(elements: &[Element]) -> Vec<&Element> {
    let frames: FxHashSet<&str> = elements
        .iter()
        .filter(|e| e.is_frame_like())
        .map(|e| e.id.as_str())
        .collect();
    elements
        .iter()
        .filter(|e| {
            frames.contains(e.id.as_str())
                || e.frame_id.as_deref().is_none_or(|f| !frames.contains(f))
        })
        .collect()
}

/// An insertion-ordered set of elements, by id.
#[derive(Default)]
struct ElSet<'a> {
    items: Vec<&'a Element>,
    ids: FxHashSet<&'a str>,
}
impl<'a> ElSet<'a> {
    fn add(&mut self, e: &'a Element) {
        if self.ids.insert(&e.id) {
            self.items.push(e);
        }
    }
    fn delete(&mut self, e: &Element) {
        if self.ids.remove(e.id.as_str()) {
            self.items.retain(|x| x.id != e.id);
        }
    }
    fn has(&self, e: &Element) -> bool {
        self.ids.contains(e.id.as_str())
    }
}

/// `getElementsInResizingFrame`: the frame's children once it's resized.
pub fn get_elements_in_resizing_frame<'a>(
    elements: &'a [Element],
    frame: &Element,
    groups: &GroupSelection,
    map: &dyn ElementsMap,
) -> Vec<&'a Element> {
    let prev = get_frame_children(elements, &frame.id);
    let mut next = ElSet::default();
    for &e in &prev {
        next.add(e);
    }
    let mut complete = ElSet::default();
    for e in get_elements_completely_in_frame(elements, frame, map) {
        complete.add(e);
    }
    for &e in prev
        .iter()
        .filter(|e| is_element_containing_frame(e, frame, map))
    {
        complete.add(e);
    }
    let not_complete: Vec<&Element> = prev.iter().filter(|e| !complete.has(e)).copied().collect();
    let mut keep: FxHashSet<&str> = complete
        .items
        .iter()
        .flat_map(|e| e.group_ids.iter().map(|g| g.as_str()))
        .collect();
    for &e in &not_complete {
        if !is_element_intersecting_frame(e, frame, map) {
            if e.group_ids.is_empty() {
                next.delete(e);
            }
        } else {
            keep.extend(e.group_ids.iter().map(|g| g.as_str()));
        }
    }
    for &e in &not_complete {
        if !e.group_ids.is_empty() && !e.group_ids.iter().any(|g| keep.contains(g.as_str())) {
            next.delete(e);
        }
    }
    for &e in complete.items.iter().filter(|e| e.group_ids.is_empty()) {
        next.add(e);
    }
    let grouped: Vec<Element> = complete
        .items
        .iter()
        .filter(|e| !e.group_ids.is_empty() && !e.is_deleted)
        .map(|&e| e.clone())
        .collect();
    for (g, sel) in select_groups_from_given_elements(&grouped, groups) {
        if !sel {
            continue;
        }
        let members = get_elements_in_group(elements, &g);
        if elements_are_in_frame_bounds(&members, frame, map) {
            for e in members {
                next.add(e);
            }
        }
    }
    next.items
        .into_iter()
        .filter(|e| !(e.is_text() && e.container_id().is_some()))
        .collect()
}

/// `getElementsInNewFrame`.
pub fn get_elements_in_new_frame<'a>(
    elements: &'a [Element],
    frame: &Element,
    map: &dyn ElementsMap,
) -> Vec<&'a Element> {
    let all: Vec<&Element> = elements.iter().collect();
    let inside = get_elements_completely_in_frame(elements, frame, map);
    omit_partial_groups(&omit_groups_impl(&all, &inside), frame, elements, map)
}

/// `omitPartialGroups`: drops groups that aren't all in the frame.
pub fn omit_partial_groups<'a>(
    elements: &[&'a Element],
    frame: &Element,
    all: &[Element],
    map: &dyn ElementsMap,
) -> Vec<&'a Element> {
    let mut checked: FxHashMap<&str, bool> = FxHashMap::default();
    let mut out = vec![];
    for &e in elements {
        let mut omit = false;
        if !e.group_ids.is_empty() {
            if e.group_ids
                .iter()
                .any(|g| checked.get(g.as_str()).copied().unwrap_or(false))
            {
                omit = true;
            } else {
                let mut set = ElSet::default();
                for m in group_members(all, &e.group_ids) {
                    set.add(m);
                }
                omit = !elements_are_in_frame_bounds(&set.items, frame, map);
            }
            for g in &e.group_ids {
                checked.insert(g, omit);
            }
        }
        if !omit {
            out.push(e);
        }
    }
    out
}

// --------------------------- Frame Operations -------------------------------

/// `filterElementsEligibleAsFrameChildren`.
pub fn filter_elements_eligible_as_frame_children<'a>(
    elements: &'a [Element],
    frame: &Element,
    map: &dyn ElementsMap,
) -> Vec<&'a Element> {
    let all: Vec<&Element> = elements.iter().collect();
    let elements = omit_groups_impl(&all, &all);
    let others: FxHashSet<&str> = elements
        .iter()
        .filter(|e| e.is_frame_like() && e.id != frame.id)
        .map(|e| e.id.as_str())
        .collect();
    let mut processed: FxHashSet<&str> = FxHashSet::default();
    let mut out = vec![];
    for &e in &elements {
        if e.is_frame_like() || e.frame_id.as_deref().is_some_and(|f| others.contains(f)) {
            continue;
        }
        if let Some(g) = e.group_ids.last() {
            if processed.insert(g) {
                let members: Vec<&Element> = elements
                    .iter()
                    .filter(|x| x.group_ids.contains(g))
                    .copied()
                    .collect();
                if members
                    .iter()
                    .any(|m| element_overlaps_with_frame(m, frame, map))
                {
                    out.extend(members);
                }
            }
        } else if element_overlaps_with_frame(e, frame, map) {
            out.push(e);
        }
    }
    out
}

/// `getCommonFrameId`: the frame all of them are in (frames: none).
pub fn get_common_frame_id(elements: &[&Element]) -> Option<String> {
    let mut common: Option<&str> = None;
    for e in elements {
        let f = e.frame_id.as_deref().filter(|_| !e.is_frame_like())?;
        match common {
            None => common = Some(f),
            Some(c) if c != f => return None,
            _ => {}
        }
    }
    common.map(String::from)
}

/// `getFrameChildrenInsertionIndex`: just below the frame, or above its
/// highest (non-deleted) child.
pub fn get_frame_children_insertion_index(elements: &[&Element], frame_id: &str) -> Option<usize> {
    for (i, e) in elements.iter().enumerate().rev() {
        if e.id == frame_id {
            return Some(i);
        }
        if e.frame_id.as_deref() == Some(frame_id) && !e.is_deleted {
            return Some(i + 1);
        }
    }
    None
}

/// `addElementsToFrame`: puts the elements (and their bound text) into the
/// frame, reordering them just below it or above its highest child.
pub fn add_elements_to_frame(all: &mut Vec<Element>, to_add: &[String], frame_id: &str) {
    let (final_ids, common) = {
        let map: FxHashMap<&str, &Element> = all.iter().map(|e| (e.id.as_str(), e)).collect();
        let adding: Vec<&Element> = to_add
            .iter()
            .filter_map(|id| map.get(id.as_str()).copied())
            .collect();
        let common = get_common_frame_id(&adding);
        let others: FxHashSet<&str> = adding
            .iter()
            .filter(|e| e.is_frame_like() && e.id != frame_id)
            .map(|e| e.id.as_str())
            .collect();
        let every: Vec<&Element> = all.iter().collect();
        let mut fin: Vec<String> = vec![];
        let mut seen: FxHashSet<&str> = FxHashSet::default();
        for e in omit_groups_impl(&every, &adding) {
            if e.is_frame_like() || e.frame_id.as_deref().is_some_and(|f| others.contains(f)) {
                continue;
            }
            if seen.insert(&e.id) {
                fin.push(e.id.clone());
            }
            if let Some(t) = get_bound_text_element(e, &map)
                && seen.insert(&t.id)
            {
                fin.push(t.id.clone());
            }
        }
        (fin, common)
    };
    let set: FxHashSet<String> = final_ids.iter().cloned().collect();
    for e in all.iter_mut().filter(|e| set.contains(&e.id)) {
        if e.frame_id.as_deref() != Some(frame_id) {
            mutate_element(e, |e| e.frame_id = Some(frame_id.into()));
        }
    }
    // already all in the frame (dragging children within it): keep the order
    if set.is_empty() || common.as_deref() == Some(frame_id) {
        return;
    }
    let (mut moved, others): (Vec<Element>, Vec<Element>) = std::mem::take(all)
        .into_iter()
        .partition(|e| set.contains(&e.id));
    let refs: Vec<&Element> = others.iter().collect();
    let Some(at) = get_frame_children_insertion_index(&refs, frame_id) else {
        // put back as it was
        let mut back = others;
        back.append(&mut moved);
        *all = back;
        return;
    };
    let order: FxHashMap<&str, usize> = final_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    moved.sort_by_key(|e| order[e.id.as_str()]);
    let mut next = others;
    next.splice(at..at, moved);
    sync_moved_indices(&mut next, &set);
    *all = next;
}

/// `removeElementsFromFrame`: out of their frames, with their bound text.
pub fn remove_elements_from_frame(ids: &[String], store: &mut dyn BindingStore) {
    let mut out: Vec<String> = vec![];
    for id in ids {
        let Some(e) = store.get_element(id) else {
            continue;
        };
        if e.frame_id.is_none() {
            continue;
        }
        out.push(e.id.clone());
        if let Some(t) = get_bound_text_element(e, &*store) {
            out.push(t.id.clone());
        }
    }
    for id in out {
        store.update(&id, &mut |e| e.frame_id = None);
    }
}

/// `isArrowEndInFrame`: an end bound to an element in the frame, or unbound
/// and inside it.
pub fn is_arrow_end_in_frame(arrow: &Element, frame: &Element, map: &dyn ElementsMap) -> bool {
    let [x1, y1, x2, y2, ..] = get_element_absolute_coords(frame, map, false);
    let Some(l) = arrow.linear() else {
        return false;
    };
    [
        (&l.start_binding, StartOrEnd::Start),
        (&l.end_binding, StartOrEnd::End),
    ]
    .iter()
    .any(|(b, s)| match b {
        Some(b) => map
            .get_element(&b.element_id)
            .is_some_and(|e| e.frame_id.as_deref() == Some(frame.id.as_str())),
        None => is_point_within_bounds(
            [x1, y1],
            get_point_at_index_global_coordinates(
                arrow,
                if *s == StartOrEnd::End { -1 } else { 0 },
                map,
            ),
            [x2, y2],
        ),
    })
}

/// `removeArrowsWithoutEndInFrame`: the arrows among `ids` (and bound to
/// them) with no end in their frame leave it; grouped ones stay.
pub fn remove_arrows_without_end_in_frame(ids: &[String], store: &mut dyn BindingStore) {
    let mut arrows: Vec<String> = vec![];
    for id in ids {
        let Some(e) = store.get_element(id) else {
            continue;
        };
        if e.is_arrow() && !arrows.contains(&e.id) {
            arrows.push(e.id.clone());
        }
        for b in e
            .bound_elements
            .iter()
            .flatten()
            .filter(|b| b.kind == BoundType::Arrow)
        {
            if store.get_element(&b.id).is_some_and(|a| a.is_arrow()) && !arrows.contains(&b.id) {
                arrows.push(b.id.clone());
            }
        }
    }
    let remove: Vec<String> = arrows
        .into_iter()
        .filter(|id| {
            let Some(a) = store.get_element(id) else {
                return false;
            };
            let frame = a
                .frame_id
                .as_deref()
                .and_then(|f| store.get_element(f))
                .filter(|f| f.is_frame_like());
            !a.is_deleted
                && a.group_ids.is_empty()
                && frame.is_some_and(|f| !is_arrow_end_in_frame(a, f, &*store))
        })
        .collect();
    remove_elements_from_frame(&remove, store);
}

/// `removeAllElementsFromFrame`.
pub fn remove_all_elements_from_frame(all: &mut Vec<Element>, frame_id: &str) {
    let ids: Vec<String> = get_frame_children(all, frame_id)
        .into_iter()
        .map(|e| e.id.clone())
        .collect();
    remove_elements_from_frame(&ids, all);
}

/// `replaceAllElementsInFrame`.
pub fn replace_all_elements_in_frame(
    all: &mut Vec<Element>,
    next_in_frame: &[String],
    frame_id: &str,
) {
    remove_all_elements_from_frame(all, frame_id);
    add_elements_to_frame(all, next_in_frame, frame_id);
    remove_arrows_without_end_in_frame(next_in_frame, all);
}

/// `updateFrameMembershipOfSelectedElements`: selected elements (and, when
/// editing a group, their groups) no longer in their frame leave it.
pub fn update_frame_membership_of_selected_elements(all: &mut Vec<Element>, fs: &FrameState) {
    let remove: Vec<String> = {
        let selected = get_selected_elements(all, fs.selected_element_ids, SelectedOpts::default());
        let mut filter = ElSet::default();
        for &e in &selected {
            filter.add(e);
        }
        if fs.editing_group_id.is_some() {
            for &e in &selected {
                if e.group_ids.is_empty() {
                    filter.add(e);
                } else {
                    for m in group_members(all, &e.group_ids) {
                        filter.add(m);
                    }
                }
            }
        }
        let map: FxHashMap<&str, &Element> = all.iter().map(|e| (e.id.as_str(), e)).collect();
        filter
            .items
            .iter()
            .filter(|e| {
                e.frame_id.is_some()
                    && !e.is_frame_like()
                    && !is_element_in_frame(e, all, &map, fs, None, None)
            })
            .map(|e| e.id.clone())
            .collect()
    };
    if !remove.is_empty() {
        remove_elements_from_frame(&remove, all);
    }
}

fn omit_groups_impl<'a>(all: &[&'a Element], subset: &[&'a Element]) -> Vec<&'a Element> {
    let groups: FxHashSet<&str> = subset
        .iter()
        .filter_map(|e| e.group_ids.last())
        .map(|g| g.as_str())
        .collect();
    let rejected: FxHashSet<&str> = groups
        .into_iter()
        .filter(|g| {
            all.iter()
                .any(|e| e.is_frame_like() && e.group_ids.iter().any(|x| x == g))
        })
        .collect();
    subset
        .iter()
        .filter(|e| {
            e.group_ids
                .last()
                .is_none_or(|g| !rejected.contains(g.as_str()))
        })
        .copied()
        .collect()
}

/// `omitGroupsContainingFrameLikes`: drops elements whose outermost group
/// holds a frame. `subset`: only filter these.
pub fn omit_groups_containing_frame_likes<'a>(
    all: &'a [Element],
    subset: Option<&[&'a Element]>,
) -> Vec<&'a Element> {
    let every: Vec<&Element> = all.iter().collect();
    omit_groups_impl(&every, subset.unwrap_or(&every))
}

/// `getTargetFrame`: the frame the element is going to be in.
pub fn get_target_frame<'a>(
    e: &'a Element,
    map: &'a dyn ElementsMap,
    fs: &FrameState,
) -> Option<&'a Element> {
    let e = if e.is_text() {
        get_container_element(e, map).unwrap_or(e)
    } else {
        e
    };
    if let Some(f) = &e.frame_id
        && fs.selected(&e.id)
        && fs.selected(f)
    {
        return get_containing_frame(e, map);
    }
    if fs.selected(&e.id) && fs.being_dragged {
        fs.frame_to_highlight.and_then(|id| map.get_element(id))
    } else {
        get_containing_frame(e, map)
    }
}

/// `isElementInFrame`: whether the element is (going to be) in its target
/// frame. `checked_groups` caches per group across calls.
pub fn is_element_in_frame(
    e: &Element,
    elements: &[Element],
    map: &dyn ElementsMap,
    fs: &FrameState,
    target_frame: Option<&Element>,
    mut checked_groups: Option<&mut FxHashMap<String, bool>>,
) -> bool {
    let Some(frame) = target_frame.or_else(|| get_target_frame(e, map, fs)) else {
        return false;
    };
    let el = if e.is_text() {
        get_container_element(e, map).unwrap_or(e)
    } else {
        e
    };
    let set_groups = |v: bool, cg: &mut Option<&mut FxHashMap<String, bool>>| {
        if let Some(c) = cg {
            for g in &el.group_ids {
                c.insert(g.clone(), v);
            }
        }
    };
    if !fs.selected(&el.id) || !fs.being_dragged || fs.selected(&frame.id) {
        return true;
    }
    if el.group_ids.is_empty() {
        return element_overlaps_with_frame(el, frame, map);
    }
    if let Some(c) = &checked_groups {
        for g in &el.group_ids {
            if let Some(&v) = c.get(g) {
                return v;
            }
        }
    }
    let mut members = ElSet::default();
    for g in el
        .group_ids
        .iter()
        .filter(|g| checked_groups.as_ref().is_none_or(|c| !c.contains_key(*g)))
    {
        for m in get_elements_in_group(elements, g) {
            members.add(m);
        }
    }
    if fs.editing_group_id.is_some() && fs.being_dragged {
        if fs.frame_to_highlight.is_some() {
            return true;
        }
        for s in get_selected_elements(elements, fs.selected_element_ids, SelectedOpts::default()) {
            members.delete(s);
        }
    }
    if members.items.iter().any(|m| m.is_frame_like()) {
        set_groups(false, &mut checked_groups);
        return false;
    }
    if members
        .items
        .iter()
        .any(|m| element_overlaps_with_frame(m, frame, map))
    {
        set_groups(true, &mut checked_groups);
        return true;
    }
    false
}

/// `shouldApplyFrameClip`: whether rendering clips the element to `frame`.
pub fn should_apply_frame_clip(
    e: &Element,
    frame: &Element,
    fs: &FrameState,
    elements: &[Element],
    map: &dyn ElementsMap,
    mut checked_groups: Option<&mut FxHashMap<String, bool>>,
) -> bool {
    if !fs.clip || !is_frame_clippable(e, map) {
        return false;
    }
    let record = |v: bool, cg: &mut Option<&mut FxHashMap<String, bool>>| {
        if let Some(c) = cg {
            for g in &e.group_ids {
                c.insert(g.clone(), v);
            }
        }
        v
    };
    if e.frame_id.as_deref() == Some(frame.id.as_str()) {
        let v = is_element_in_frame(
            e,
            elements,
            map,
            fs,
            Some(frame),
            checked_groups.as_deref_mut(),
        );
        return record(v, &mut checked_groups);
    }
    if is_element_intersecting_frame(e, frame, map) || is_element_containing_frame(e, frame, map) {
        return record(true, &mut checked_groups);
    }
    if fs.being_dragged
        && !e.group_ids.is_empty()
        && !elements_are_in_frame_bounds(&[e], frame, map)
    {
        let v = is_element_in_frame(
            e,
            elements,
            map,
            fs,
            Some(frame),
            checked_groups.as_deref_mut(),
        );
        return record(v, &mut checked_groups);
    }
    false
}

pub const DEFAULT_FRAME_NAME: &str = "Frame";
pub const DEFAULT_AI_FRAME_NAME: &str = "AI Frame";

/// `getDefaultFrameName`.
pub fn get_default_frame_name(frame: &Element) -> &'static str {
    if frame.is_frame() {
        DEFAULT_FRAME_NAME
    } else {
        DEFAULT_AI_FRAME_NAME
    }
}

/// `getFrameLikeTitle`.
pub fn get_frame_like_title(frame: &Element) -> &str {
    frame
        .frame_name()
        .unwrap_or_else(|| get_default_frame_name(frame))
}

/// `getElementsOverlappingFrame`: what shows in the frame's area (arrow
/// labels go with their arrow; elements clipped by another frame don't).
pub fn get_elements_overlapping_frame<'a>(
    elements: &'a [Element],
    frame: &Element,
    map: &dyn ElementsMap,
) -> Vec<&'a Element> {
    let fb = get_element_bounds(frame, map, false);
    elements
        .iter()
        .filter(|el| {
            let container = el
                .container_id()
                .and_then(|c| map.get_element(c))
                .filter(|c| c.is_arrow());
            let t: &Element = container.unwrap_or(el);
            (t.frame_id.is_none()
                || t.frame_id.as_deref() == Some(frame.id.as_str())
                || !is_frame_clippable(t, map))
                && do_bounds_intersect(Some(get_element_bounds(t, map, false)), Some(fb))
        })
        .collect()
}

/// `frameAndChildrenSelectedTogether`.
pub fn frame_and_children_selected_together(selected: &[&Element]) -> bool {
    let ids: FxHashSet<&str> = selected.iter().map(|e| e.id.as_str()).collect();
    selected.len() > 1
        && selected
            .iter()
            .any(|e| e.frame_id.as_deref().is_some_and(|f| ids.contains(f)))
}

/// The frame part of the selection tool's pointer up after a drag
/// (`handleSelectionDragOnPointerUp`, App.selectionTool.ts): the dragged
/// elements join `top_layer_frame` (the frame under the pointer, the app's
/// hit test) or leave theirs, and the edited group if they leave it; arrows
/// without an end in their frame leave it. `fs` is the state while dragging
/// (`being_dragged`, `frame_to_highlight` = `top_layer_frame`). Returns
/// whether the edited group ends (`editingGroupId: null`).
pub fn drop_selection_into_frame(
    all: &mut Vec<Element>,
    top_layer_frame: Option<&str>,
    fs: &FrameState,
) -> bool {
    let selected: Vec<String> =
        get_selected_elements(all, fs.selected_element_ids, SelectedOpts::default())
            .into_iter()
            .map(|e| e.id.clone())
            .collect();
    let in_frame = |all: &Vec<Element>, id: &str| {
        let map: FxHashMap<&str, &Element> = all.iter().map(|e| (e.id.as_str(), e)).collect();
        map.get(id)
            .is_some_and(|e| is_element_in_frame(e, all, &map, fs, None, None))
    };
    let mut ends_group = false;
    let mut leave_group = |all: &mut Vec<Element>, ids: &[String]| {
        let (Some(g), false) = (fs.editing_group_id, ids.is_empty()) else {
            return;
        };
        for e in all.iter_mut().filter(|e| ids.contains(&e.id)) {
            let i = e.group_ids.iter().position(|x| x == g);
            mutate_element(e, |e| {
                e.group_ids
                    .truncate(i.unwrap_or(e.group_ids.len().wrapping_sub(1)))
            });
        }
        let lone: Vec<String> = all
            .iter()
            .filter(|e| {
                e.group_ids
                    .last()
                    .is_some_and(|g| all.iter().filter(|x| x.group_ids.contains(g)).count() < 2)
            })
            .map(|e| e.id.clone())
            .collect();
        for e in all.iter_mut().filter(|e| lone.contains(&e.id)) {
            mutate_element(e, |e| e.group_ids.clear());
        }
        ends_group = true;
    };
    match top_layer_frame {
        Some(f) if !fs.selected(f) => {
            let add: Vec<String> = selected
                .iter()
                .filter(|id| in_frame(all, id))
                .cloned()
                .collect();
            leave_group(all, &add);
            add_elements_to_frame(all, &add, f);
        }
        None => {
            let remove: Vec<String> = selected
                .iter()
                .filter(|id| {
                    all.iter().any(|e| &&e.id == id && e.frame_id.is_some()) && !in_frame(all, id)
                })
                .cloned()
                .collect();
            leave_group(all, &remove);
        }
        _ => {}
    }
    update_frame_membership_of_selected_elements(all, fs);
    remove_arrows_without_end_in_frame(&selected, all);
    ends_group
}
