// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Z-order. Port of Excalidraw `packages/element/src/zindex.ts` @ 3a317b5:
//! moving the selection one step or all the way back / forward, keeping
//! groups (and the edited group), frames with their children and containers
//! with their bound text together, and the moved elements' fractional
//! indices in sync.
//!
//! Elements are the scene's, deleted included, in z-order; the functions
//! return the reordered copy (or the same order when nothing can move).
//! Upstream looks containers and bound text up in the scene; here in the
//! elements given, which are the scene's. `moveArrowAboveBindable` takes the
//! arrow and hovered element ids and returns the new order, or None.

use super::app_state::AppState;
use super::fractional_index::sync_moved_indices;
use super::groups::get_elements_in_group;
use super::selection::{SelectedOpts, get_selected_elements};
use super::types::{BoundType, Element};
use rustc_hash::FxHashSet;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Dir {
    Left,
    Right,
}

fn is_of_target_frame(e: &Element, frame_id: &str) -> bool {
    e.frame_id.as_deref() == Some(frame_id) || e.id == frame_id
}

fn pos(elements: &[Element], id: &str) -> isize {
    elements
        .iter()
        .position(|e| e.id == id)
        .map_or(-1, |i| i as isize)
}

/// `findIndex(array, cb, fromIndex)`.
fn find_index(elements: &[Element], from: isize, f: impl Fn(&Element) -> bool) -> isize {
    let n = elements.len() as isize;
    let from = if from < 0 { n + from } else { from }.clamp(0, n);
    (from..n).find(|&i| f(&elements[i as usize])).unwrap_or(-1)
}

/// `findLastIndex(array, cb, fromIndex)`.
fn find_last_index(elements: &[Element], from: isize, f: impl Fn(&Element) -> bool) -> isize {
    let n = elements.len() as isize;
    let from = if from < 0 { n + from } else { from }.min(n - 1).max(0);
    (0..=from)
        .rev()
        .find(|&i| i < n && f(&elements[i as usize]))
        .unwrap_or(-1)
}

fn selected_to_move(elements: &[Element], a: &AppState) -> Vec<String> {
    get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            include_elements_in_frames: true,
        },
    )
    .into_iter()
    .map(|e| e.id.clone())
    .collect()
}

/// `getIndicesToMove`: the indices of the elements to move, with runs of
/// deleted elements between two of them.
fn get_indices_to_move(elements: &[Element], ids: &FxHashSet<String>) -> Vec<usize> {
    let (mut selected, mut deleted) = (vec![], vec![]);
    let mut include_deleted: Option<usize> = None;
    for (i, e) in elements.iter().enumerate() {
        if ids.contains(&e.id) {
            selected.append(&mut deleted);
            selected.push(i);
            include_deleted = Some(i + 1);
        } else if e.is_deleted && include_deleted == Some(i) {
            include_deleted = Some(i + 1);
            deleted.push(i);
        } else {
            deleted.clear();
        }
    }
    selected
}

fn to_contiguous_groups(a: &[usize]) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = vec![];
    for (i, &v) in a.iter().enumerate() {
        if i == 0 || a[i - 1] + 1 != v {
            out.push(vec![]);
        }
        out.last_mut().unwrap().push(v);
    }
    out
}

/// `getTargetIndexAccountingForBinding`: a container and its bound text move
/// as one.
fn target_index_accounting_for_binding(
    next: &Element,
    elements: &[Element],
    dir: Dir,
) -> Option<isize> {
    let other = match next.container_id() {
        Some(c) => c,
        None => next
            .bound_elements
            .as_ref()?
            .iter()
            .find(|b| b.kind != BoundType::Arrow)
            .map(|b| b.id.as_str())?,
    };
    // upstream: `scene.getElement`; the elements are the scene's
    let o = pos(elements, other);
    if o < 0 {
        return None;
    }
    let n = pos(elements, &next.id);
    Some(if dir == Dir::Left { o.min(n) } else { o.max(n) })
}

/// `getContiguousFrameRangeElements`: the first and last index of the frame
/// and its children.
fn contiguous_frame_range(elements: &[Element], frame_id: &str) -> Option<(usize, usize)> {
    let first = elements
        .iter()
        .position(|e| is_of_target_frame(e, frame_id))?;
    let last = elements
        .iter()
        .rposition(|e| is_of_target_frame(e, frame_id))?;
    Some((first, last))
}

/// `getTargetIndex`: where the run at `boundary` moves to: the next
/// non-deleted element (within the edited group or the containing frame),
/// widened to its group, frame or bound text. -1: can't move.
fn get_target_index(
    a: &AppState,
    elements: &[Element],
    boundary: usize,
    dir: Dir,
    containing_frame: Option<&str>,
) -> isize {
    let source = elements.get(boundary);
    let editing = a.editing_group_id.as_deref();
    let filter = |e: &Element| {
        if e.is_deleted {
            return false;
        }
        if let Some(f) = containing_frame {
            return e.frame_id.as_deref() == Some(f);
        }
        // editing a group: the closest sibling, whatever lies between
        if let Some(g) = editing {
            return e.group_ids.iter().any(|x| x == g);
        }
        true
    };
    let candidate = match dir {
        Dir::Left => find_last_index(elements, (boundary as isize - 1).max(0), filter),
        Dir::Right => find_index(elements, boundary as isize + 1, filter),
    };
    let Some(next) = (candidate >= 0).then(|| &elements[candidate as usize]) else {
        return -1;
    };
    if let Some(g) = editing {
        if source.is_some_and(|s| s.group_ids.concat() == next.group_ids.concat()) {
            return target_index_accounting_for_binding(next, elements, dir).unwrap_or(candidate);
        } else if !next.group_ids.iter().any(|x| x == g) {
            return -1;
        }
    }
    if containing_frame.is_none() && (next.frame_id.is_some() || next.is_frame_like()) {
        let fid = next.frame_id.as_deref().unwrap_or(&next.id);
        return match contiguous_frame_range(elements, fid) {
            Some((s, e)) => {
                if dir == Dir::Left {
                    s as isize
                } else {
                    e as isize
                }
            }
            None => -1,
        };
    }
    if next.group_ids.is_empty() {
        return target_index_accounting_for_binding(next, elements, dir).unwrap_or(candidate);
    }
    let sibling = match editing {
        Some(g) => next
            .group_ids
            .iter()
            .position(|x| x == g)
            .and_then(|i| i.checked_sub(1))
            .map(|i| next.group_ids[i].as_str()),
        None => next.group_ids.last().map(|g| g.as_str()),
    };
    let in_sibling = sibling
        .map(|g| get_elements_in_group(elements, g))
        .unwrap_or_default();
    match (in_sibling.first(), in_sibling.last()) {
        (Some(f), Some(l)) => pos(elements, if dir == Dir::Left { &f.id } else { &l.id }),
        _ => candidate,
    }
}

/// `hasSameElementIds`.
fn has_same_element_ids(prev: &[Element], next: &[Element]) -> bool {
    if prev.len() != next.len() {
        return false;
    }
    let mut counts: rustc_hash::FxHashMap<&str, usize> = Default::default();
    for e in prev {
        *counts.entry(&e.id).or_default() += 1;
    }
    for e in next {
        match counts.get_mut(e.id.as_str()) {
            Some(c) if *c > 0 => *c -= 1,
            _ => return false,
        }
    }
    true
}

/// `shiftElementsByOne`.
fn shift_elements_by_one(original: &[Element], a: &AppState, dir: Dir) -> Vec<Element> {
    let ids: FxHashSet<String> = selected_to_move(original, a).into_iter().collect();
    let indices = get_indices_to_move(original, &ids);
    let moved: FxHashSet<String> = indices.iter().map(|&i| original[i].id.clone()).collect();
    let mut grouped = to_contiguous_groups(&indices);
    if dir == Dir::Right {
        grouped.reverse();
    }
    let selected_frames: FxHashSet<&str> = indices
        .iter()
        .filter(|&&i| original[i].is_frame_like())
        .map(|&i| original[i].id.as_str())
        .collect();
    let mut elements: Vec<Element> = original.to_vec();
    for run in grouped {
        let (lead, trail) = (run[0], run[run.len() - 1]);
        let boundary = if dir == Dir::Left { lead } else { trail };
        // indices are into the original order; upstream reads them from the
        // reordered array as well
        let containing = if run.iter().any(|&i| {
            elements[i]
                .frame_id
                .as_deref()
                .is_some_and(|f| selected_frames.contains(f))
        }) {
            None
        } else {
            elements.get(boundary).and_then(|e| e.frame_id.clone())
        };
        let target = get_target_index(a, &elements, boundary, dir, containing.as_deref());
        if target == -1 || boundary as isize == target {
            continue;
        }
        let t = target as usize;
        let mut next = Vec::with_capacity(elements.len());
        match dir {
            Dir::Left => {
                next.extend_from_slice(&elements[..t.min(elements.len())]);
                next.extend_from_slice(&elements[lead..=trail]);
                next.extend_from_slice(&elements[t.min(lead)..lead]);
                next.extend_from_slice(&elements[trail + 1..]);
            }
            Dir::Right => {
                next.extend_from_slice(&elements[..lead]);
                next.extend_from_slice(&elements[(trail + 1).min(t + 1)..t + 1]);
                next.extend_from_slice(&elements[lead..=trail]);
                next.extend_from_slice(&elements[(t + 1).min(elements.len())..]);
            }
        }
        elements = next;
    }
    if !has_same_element_ids(original, &elements) {
        return original.to_vec();
    }
    sync_moved_indices(&mut elements, &moved);
    elements
}

/// `shiftElementsToEnd`: moves `to_move` (or the selection) to the back /
/// front of the containing frame, the edited group or everything.
fn shift_elements_to_end(
    elements: &[Element],
    a: &AppState,
    dir: Dir,
    containing_frame: Option<&str>,
    to_move: Option<&[String]>,
) -> Vec<Element> {
    let ids: FxHashSet<String> = match to_move {
        Some(t) => t.iter().cloned().collect(),
        None => selected_to_move(elements, a).into_iter().collect(),
    };
    let indices = get_indices_to_move(elements, &ids);
    // nothing to move (all handled in a prior frame pass)
    if indices.is_empty() {
        return elements.to_vec();
    }
    let editing_range = |first: bool| -> Option<isize> {
        let g = get_elements_in_group(elements, a.editing_group_id.as_deref()?);
        let e = if first { g.first()? } else { g.last()? };
        Some(pos(elements, &e.id))
    };
    let (mut lead, trail): (isize, isize);
    match dir {
        Dir::Left => {
            lead = if let Some(f) = containing_frame {
                find_index(elements, 0, |e| is_of_target_frame(e, f))
            } else if a.editing_group_id.is_some() {
                match editing_range(true) {
                    Some(i) => i,
                    None => return elements.to_vec(),
                }
            } else {
                0
            };
            trail = indices[indices.len() - 1] as isize;
        }
        Dir::Right => {
            trail = if let Some(f) = containing_frame {
                find_last_index(elements, elements.len() as isize - 1, |e| {
                    is_of_target_frame(e, f)
                })
            } else if a.editing_group_id.is_some() {
                match editing_range(false) {
                    Some(i) => i,
                    None => return elements.to_vec(),
                }
            } else {
                elements.len() as isize - 1
            };
            lead = indices[0] as isize;
        }
    }
    if lead == -1 {
        lead = 0;
    }
    if lead < 0
        || trail < 0
        || lead > trail
        || indices
            .iter()
            .any(|&i| (i as isize) < lead || i as isize > trail)
    {
        return elements.to_vec();
    }
    let (lead, trail) = (lead as usize, trail as usize);
    let set: FxHashSet<usize> = indices.iter().copied().collect();
    let displaced: Vec<Element> = (lead..=trail)
        .filter(|i| !set.contains(i))
        .map(|i| elements[i].clone())
        .collect();
    let targets: Vec<Element> = indices.iter().map(|&i| elements[i].clone()).collect();
    let moved: FxHashSet<String> = targets.iter().map(|e| e.id.clone()).collect();
    let mut next: Vec<Element> = elements[..lead].to_vec();
    if dir == Dir::Left {
        next.extend(targets);
        next.extend(displaced);
    } else {
        next.extend(displaced);
        next.extend(targets);
    }
    next.extend_from_slice(&elements[trail + 1..]);
    if !has_same_element_ids(elements, &next) {
        return elements.to_vec();
    }
    sync_moved_indices(&mut next, &moved);
    next
}

/// `shiftElementsAccountingForFrames`: children of frames that aren't moved
/// themselves move within their frame, first; then the rest.
fn shift_elements_accounting_for_frames(all: &[Element], a: &AppState, dir: Dir) -> Vec<Element> {
    let to_move: FxHashSet<String> = selected_to_move(all, a).into_iter().collect();
    let full_frames: FxHashSet<&str> = all
        .iter()
        .filter(|e| to_move.contains(&e.id) && e.is_frame_like())
        .map(|e| e.id.as_str())
        .collect();
    let mut regular: Vec<String> = vec![];
    let mut children: Vec<(String, Vec<String>)> = vec![];
    for e in all.iter().filter(|e| to_move.contains(&e.id)) {
        match &e.frame_id {
            Some(f) if !e.is_frame_like() && !full_frames.contains(f.as_str()) => {
                match children.iter_mut().find(|(k, _)| k == f) {
                    Some((_, v)) => v.push(e.id.clone()),
                    None => children.push((f.clone(), vec![e.id.clone()])),
                }
            }
            _ => regular.push(e.id.clone()),
        }
    }
    let mut next = all.to_vec();
    for (f, ids) in &children {
        next = shift_elements_to_end(&next, a, dir, Some(f), Some(ids));
    }
    shift_elements_to_end(&next, a, dir, None, Some(&regular))
}

/// `moveOneLeft`: send the selection one step back.
pub fn move_one_left(elements: &[Element], a: &AppState) -> Vec<Element> {
    shift_elements_by_one(elements, a, Dir::Left)
}
/// `moveOneRight`: bring the selection one step forward.
pub fn move_one_right(elements: &[Element], a: &AppState) -> Vec<Element> {
    shift_elements_by_one(elements, a, Dir::Right)
}
/// `moveAllLeft`: send the selection to the back.
pub fn move_all_left(elements: &[Element], a: &AppState) -> Vec<Element> {
    shift_elements_accounting_for_frames(elements, a, Dir::Left)
}
/// `moveAllRight`: bring the selection to the front.
pub fn move_all_right(elements: &[Element], a: &AppState) -> Vec<Element> {
    shift_elements_accounting_for_frames(elements, a, Dir::Right)
}

/// `moveArrowAboveBindable`: puts the arrow right above the hovered element
/// (or its container / bound text) if it is below it. None: no change.
pub fn move_arrow_above_bindable(
    elements: &[Element],
    arrow_id: &str,
    hovered_id: &str,
) -> Option<Vec<Element>> {
    let hovered = elements.iter().find(|e| e.id == hovered_id)?;
    let mut ids = vec![hovered.id.as_str()];
    if let Some(t) = hovered.bound_text_id() {
        ids.push(t);
    }
    if let Some(c) = hovered.container_id() {
        ids.push(c);
    }
    let bindable = elements.iter().position(|e| ids.contains(&e.id.as_str()))?;
    let arrow = elements.iter().position(|e| e.id == arrow_id)?;
    if arrow >= bindable {
        return None;
    }
    let mut next = elements.to_vec();
    let a = next.remove(arrow);
    next.insert(bindable, a);
    // upstream: `scene.replaceAllElements`, which fixes invalid indices
    super::fractional_index::sync_invalid_indices(&mut next);
    Some(next)
}
