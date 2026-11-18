// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Groups. Port of Excalidraw `packages/element/src/groups.ts` @ 3a317b5,
//! with `selectGroupsForSelectedElements` from
//! `excalidraw/components/App.selection.ts` (uncached: the cache only keeps
//! React identities stable).
//!
//! Element lists are slices of the scene's elements, deleted ones included
//! (`Scene::elements_including_deleted`); functions that upstream hands only
//! non-deleted elements skip deleted ones. The selection parts of `AppState`
//! that group selection changes travel as a `GroupSelection`. Upstream's
//! `selectedGroupIds` keeps insertion order; ours is sorted by id, which only
//! changes the order `get_selected_group_ids` lists them in.

use super::app_state::AppState;
use super::bounds::get_bound_text_element;
use super::types::Element;
use super::utils::ElementsMap;
use rustc_hash::FxHashSet;
use std::collections::{BTreeMap, BTreeSet};

/// `Pick<AppState, "selectedElementIds" | "selectedGroupIds" | "editingGroupId">`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GroupSelection {
    pub selected_element_ids: BTreeSet<String>,
    pub selected_group_ids: BTreeMap<String, bool>,
    pub editing_group_id: Option<String>,
}

impl GroupSelection {
    pub fn of(a: &AppState) -> Self {
        GroupSelection {
            selected_element_ids: a.selected_element_ids.clone(),
            selected_group_ids: a.selected_group_ids.clone(),
            editing_group_id: a.editing_group_id.clone(),
        }
    }
    pub fn apply(self, a: &mut AppState) {
        a.selected_element_ids = self.selected_element_ids;
        a.selected_group_ids = self.selected_group_ids;
        a.editing_group_id = self.editing_group_id;
    }
}

fn group_selected(sel: &BTreeMap<String, bool>, g: &str) -> bool {
    sel.get(g).copied().unwrap_or(false)
}

/// `selectGroup`: selects the group and its members, or (for a group of
/// fewer than two) unselects it if it was selected or edited.
pub fn select_group(group_id: &str, s: &GroupSelection, elements: &[Element]) -> GroupSelection {
    let members: Vec<&str> = elements
        .iter()
        .filter(|e| !e.is_deleted && e.group_ids.iter().any(|g| g == group_id))
        .map(|e| e.id.as_str())
        .collect();
    if members.len() < 2 {
        if group_selected(&s.selected_group_ids, group_id)
            || s.editing_group_id.as_deref() == Some(group_id)
        {
            let mut groups = s.selected_group_ids.clone();
            groups.insert(group_id.into(), false);
            return GroupSelection {
                selected_element_ids: s.selected_element_ids.clone(),
                selected_group_ids: groups,
                editing_group_id: None,
            };
        }
        return s.clone();
    }
    let mut next = s.clone();
    next.selected_group_ids.insert(group_id.into(), true);
    next.selected_element_ids
        .extend(members.into_iter().map(String::from));
    next
}

/// `isSelectedViaGroup`: the element's group is selected (no own selection
/// border).
pub fn is_selected_via_group(
    selected_group_ids: &BTreeMap<String, bool>,
    editing_group_id: Option<&str>,
    e: &Element,
) -> bool {
    get_selected_group_for_element(selected_group_ids, editing_group_id, e).is_some()
}

/// `getSelectedGroupForElement`.
pub fn get_selected_group_for_element<'a>(
    selected_group_ids: &BTreeMap<String, bool>,
    editing_group_id: Option<&str>,
    e: &'a Element,
) -> Option<&'a str> {
    e.group_ids
        .iter()
        .filter(|g| Some(g.as_str()) != editing_group_id)
        .find(|g| group_selected(selected_group_ids, g))
        .map(|g| g.as_str())
}

/// `getSelectedGroupIds`.
pub fn get_selected_group_ids(selected_group_ids: &BTreeMap<String, bool>) -> Vec<String> {
    selected_group_ids
        .iter()
        .filter(|(_, v)| **v)
        .map(|(k, _)| k.clone())
        .collect()
}

/// The groups (outermost below the edited group) of `e`.
fn groups_outside_editing<'a>(e: &'a Element, editing: Option<&str>) -> &'a [String] {
    let g = &e.group_ids;
    match editing.and_then(|ed| g.iter().position(|x| x == ed)) {
        Some(i) => &g[..i],
        None => g,
    }
}

/// `selectGroupsFromGivenElements`: the groups to select for `elements`.
pub fn select_groups_from_given_elements(
    elements: &[Element],
    s: &GroupSelection,
) -> BTreeMap<String, bool> {
    let mut next = GroupSelection {
        selected_group_ids: BTreeMap::new(),
        ..s.clone()
    };
    for e in elements.iter().filter(|e| !e.is_deleted) {
        if let Some(g) = groups_outside_editing(e, s.editing_group_id.as_deref()).last() {
            next = select_group(g, &next, elements);
        }
    }
    next.selected_group_ids
}

/// `selectGroupsForSelectedElements` (App.selection.ts): selecting an element
/// selects its outermost group (below the edited one) with all its members;
/// a group of fewer than two isn't selected.
pub fn select_groups_for_selected_elements(
    selected_element_ids: &BTreeSet<String>,
    editing_group_id: Option<&str>,
    elements: &[Element],
) -> GroupSelection {
    let selected: Vec<&Element> = elements
        .iter()
        .filter(|e| !e.is_deleted && selected_element_ids.contains(&e.id))
        .collect();
    if selected.is_empty() {
        return GroupSelection {
            selected_element_ids: selected_element_ids.clone(),
            selected_group_ids: BTreeMap::new(),
            editing_group_id: None,
        };
    }
    let mut groups: BTreeMap<String, bool> = BTreeMap::new();
    for e in &selected {
        if let Some(g) = groups_outside_editing(e, editing_group_id).last() {
            groups.insert(g.clone(), true);
        }
    }
    let mut ids = selected_element_ids.clone();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for e in elements.iter().filter(|e| !e.is_deleted) {
        if let Some(g) = e.group_ids.iter().find(|g| group_selected(&groups, g)) {
            ids.insert(e.id.clone());
            *counts.entry(g.clone()).or_default() += 1;
        }
    }
    for (g, n) in counts {
        if n < 2 && group_selected(&groups, &g) {
            groups.insert(g, false);
        }
    }
    GroupSelection {
        selected_element_ids: ids,
        selected_group_ids: groups,
        editing_group_id: editing_group_id.map(String::from),
    }
}

/// `editGroupForSelectedElement`: edit the element's innermost group, with
/// only it selected.
pub fn edit_group_for_selected_element(e: &Element) -> GroupSelection {
    GroupSelection {
        selected_element_ids: BTreeSet::from([e.id.clone()]),
        selected_group_ids: BTreeMap::new(),
        editing_group_id: e.group_ids.first().cloned(),
    }
}

/// `isElementInGroup`.
pub fn is_element_in_group(e: &Element, group_id: &str) -> bool {
    e.group_ids.iter().any(|g| g == group_id)
}

/// `getElementsInGroup` (deleted ones included, as given).
pub fn get_elements_in_group<'a>(elements: &'a [Element], group_id: &str) -> Vec<&'a Element> {
    elements
        .iter()
        .filter(|e| is_element_in_group(e, group_id))
        .collect()
}

/// `getSelectedGroupIdForElement`.
pub fn get_selected_group_id_for_element<'a>(
    e: &'a Element,
    selected_group_ids: &BTreeMap<String, bool>,
) -> Option<&'a str> {
    e.group_ids
        .iter()
        .find(|g| group_selected(selected_group_ids, g))
        .map(|g| g.as_str())
}

/// `addToGroup`: inserts `new_group_id` below the edited group (or outermost).
pub fn add_to_group(
    prev: &[String],
    new_group_id: &str,
    editing_group_id: Option<&str>,
) -> Vec<String> {
    let mut g = prev.to_vec();
    let at = editing_group_id
        .and_then(|ed| g.iter().position(|x| x == ed))
        .unwrap_or(g.len());
    g.insert(at, new_group_id.into());
    g
}

/// `removeFromSelectedGroups`.
pub fn remove_from_selected_groups(
    group_ids: &[String],
    selected_group_ids: &BTreeMap<String, bool>,
) -> Vec<String> {
    group_ids
        .iter()
        .filter(|g| !group_selected(selected_group_ids, g))
        .cloned()
        .collect()
}

/// `getMaximumGroups`: the elements bucketed by their outermost group (or
/// alone), bound text before its container, buckets in first-seen order.
pub fn get_maximum_groups<'a>(
    elements: &[&'a Element],
    map: &'a dyn ElementsMap,
) -> Vec<Vec<&'a Element>> {
    let mut order: Vec<&str> = vec![];
    let mut groups: rustc_hash::FxHashMap<&str, Vec<&'a Element>> = Default::default();
    for &e in elements {
        let key = e.group_ids.last().map_or(e.id.as_str(), |g| g.as_str());
        let bucket = groups.entry(key).or_insert_with(|| {
            order.push(key);
            vec![]
        });
        if let Some(t) = get_bound_text_element(e, map) {
            bucket.push(t);
        }
        bucket.push(e);
    }
    order
        .into_iter()
        .map(|k| groups.remove(k).unwrap())
        .collect()
}

/// `getNonDeletedGroupIds`.
pub fn get_non_deleted_group_ids(elements: &[Element]) -> FxHashSet<String> {
    elements
        .iter()
        .filter(|e| !e.is_deleted)
        .flat_map(|e| e.group_ids.iter().cloned())
        .collect()
}

/// `elementsAreInSameGroup`: some group holds all of them.
pub fn elements_are_in_same_group(elements: &[&Element]) -> bool {
    let mut count: rustc_hash::FxHashMap<&str, usize> = Default::default();
    let mut max = 0;
    for g in elements.iter().flat_map(|e| e.group_ids.iter()) {
        let c = count.entry(g).or_default();
        *c += 1;
        max = max.max(*c);
    }
    max == elements.len()
}

/// `isInGroup`.
pub fn is_in_group(e: &Element) -> bool {
    !e.group_ids.is_empty()
}

/// `getNewGroupIdsForDuplication`: maps the groups below the edited one.
pub fn get_new_group_ids_for_duplication(
    group_ids: &[String],
    editing_group_id: Option<&str>,
    mut mapper: impl FnMut(&str) -> String,
) -> Vec<String> {
    let end = editing_group_id
        .and_then(|ed| group_ids.iter().position(|x| x == ed))
        .unwrap_or(group_ids.len());
    group_ids
        .iter()
        .enumerate()
        .map(|(i, g)| if i < end { mapper(g) } else { g.clone() })
        .collect()
}

/// `getSelectedElementsByGroup`: the selected elements bucketed by their
/// selected group (by the next group inward when a single group is selected
/// and everything is selected through it); bound text follows its container.
pub fn get_selected_elements_by_group<'a>(
    selected: &[&'a Element],
    map: &'a dyn ElementsMap,
    selected_group_ids: &BTreeMap<String, bool>,
    editing_group_id: Option<&str>,
) -> Vec<Vec<&'a Element>> {
    let single = get_selected_group_ids(selected_group_ids).len() == 1
        && selected
            .iter()
            .all(|e| is_selected_via_group(selected_group_ids, editing_group_id, e));
    let mut order: Vec<String> = vec![];
    let mut buckets: rustc_hash::FxHashMap<String, Vec<&'a Element>> = Default::default();
    for &e in selected {
        if e.is_bound_to_container() {
            continue;
        }
        let key = match get_selected_group_id_for_element(e, selected_group_ids) {
            None => format!("{}_element", e.id),
            Some(g) => {
                let i = e.group_ids.iter().position(|x| x == g).unwrap() as isize - single as isize;
                if i < 0 {
                    format!("{}_element", e.id)
                } else {
                    format!("{}_group", e.group_ids[i as usize])
                }
            }
        };
        let bucket = buckets.entry(key.clone()).or_insert_with(|| {
            order.push(key);
            vec![]
        });
        bucket.push(e);
        if let Some(t) = get_bound_text_element(e, map) {
            bucket.push(t);
        }
    }
    order
        .into_iter()
        .map(|k| buckets.remove(&k).unwrap())
        .collect()
}
