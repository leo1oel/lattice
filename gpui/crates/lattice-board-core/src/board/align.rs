// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Aligning, distributing and laying out on a grid. Port of Excalidraw
//! `packages/element/src/align.ts`, `distribute.ts` and
//! `positionElementsOnGrid.ts` @ 3a317b5.
//!
//! Align and distribute move the selection (bucketed by selected group, see
//! `get_selected_elements_by_group`) in the store and re-place the arrows
//! bound to what moved (binding's `update_bound_elements`, arrows moving with
//! their group left alone); they return the moved elements as they are now.
//! The render environment upstream passes for arrow labels is `BindingHooks`.

use super::binding::{BindingHooks, BindingStore, UpdateBoundOpts, update_bound_elements};
use super::bounds::{BoundingBox, get_common_bounding_box, get_common_bounds};
use super::groups::get_selected_elements_by_group;
use super::mutate::new_element_with;
use super::types::Element;
use rustc_hash::FxHashSet;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    Start,
    Center,
    End,
}

/// `Alignment`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Alignment {
    pub position: Position,
    pub axis: Axis,
}

/// The selection bucketed by group, as clones, deleted ones left out.
fn groups_of(
    selected: &[&Element],
    store: &dyn BindingStore,
    selected_group_ids: &BTreeMap<String, bool>,
    editing_group_id: Option<&str>,
) -> Vec<Vec<Element>> {
    get_selected_elements_by_group(selected, store, selected_group_ids, editing_group_id)
        .into_iter()
        .map(|g| g.into_iter().filter(|e| !e.is_deleted).cloned().collect())
        .collect()
}

/// Moves the group by (dx, dy) and its bound arrows; returns it as moved.
fn translate_group(
    group: &[Element],
    dx: f64,
    dy: f64,
    store: &mut dyn BindingStore,
    hooks: &dyn BindingHooks,
) -> Vec<Element> {
    let ids: FxHashSet<String> = group.iter().map(|e| e.id.clone()).collect();
    group
        .iter()
        .filter_map(|e| {
            let (x, y) = (e.x + dx, e.y + dy);
            store.update(&e.id, &mut |m| {
                m.x = x;
                m.y = y;
            });
            update_bound_elements(
                &e.id,
                store,
                &UpdateBoundOpts {
                    simultaneously_updated: Some(&ids),
                    changed_elements: &[],
                },
                hooks,
            );
            store.get_element(&e.id).cloned()
        })
        .collect()
}

fn bb_min(b: &BoundingBox, axis: Axis) -> f64 {
    if axis == Axis::X { b.min_x } else { b.min_y }
}
fn bb_max(b: &BoundingBox, axis: Axis) -> f64 {
    if axis == Axis::X { b.max_x } else { b.max_y }
}
fn bb_mid(b: &BoundingBox, axis: Axis) -> f64 {
    if axis == Axis::X { b.mid_x } else { b.mid_y }
}
fn bb_extent(b: &BoundingBox, axis: Axis) -> f64 {
    if axis == Axis::X { b.width } else { b.height }
}
fn on_axis(axis: Axis, v: f64) -> (f64, f64) {
    if axis == Axis::X { (v, 0.) } else { (0., v) }
}

/// `alignElements`.
pub fn align_elements(
    selected: &[&Element],
    alignment: Alignment,
    store: &mut dyn BindingStore,
    selected_group_ids: &BTreeMap<String, bool>,
    editing_group_id: Option<&str>,
    hooks: &dyn BindingHooks,
) -> Vec<Element> {
    let groups = groups_of(selected, store, selected_group_ids, editing_group_id);
    let selection = get_common_bounding_box(selected.iter().copied(), store);
    let mut out = vec![];
    for g in groups {
        let gb = get_common_bounding_box(g.iter(), store);
        let Alignment { axis, position } = alignment;
        let v = match position {
            Position::Start => bb_min(&selection, axis) - bb_min(&gb, axis),
            Position::End => bb_max(&selection, axis) - bb_max(&gb, axis),
            Position::Center => {
                (bb_min(&selection, axis) + bb_max(&selection, axis)) / 2.
                    - (bb_min(&gb, axis) + bb_max(&gb, axis)) / 2.
            }
        };
        let (dx, dy) = on_axis(axis, v);
        out.extend(translate_group(&g, dx, dy, store, hooks));
    }
    out
}

/// `distributeElements`: equal gaps between the groups along `axis` (when
/// they overlap too much for that, equal steps between their centers).
pub fn distribute_elements(
    selected: &[&Element],
    axis: Axis,
    store: &mut dyn BindingStore,
    selected_group_ids: &BTreeMap<String, bool>,
    editing_group_id: Option<&str>,
    hooks: &dyn BindingHooks,
) -> Vec<Element> {
    let bounds = get_common_bounding_box(selected.iter().copied(), store);
    let mut groups: Vec<(Vec<Element>, BoundingBox)> =
        groups_of(selected, store, selected_group_ids, editing_group_id)
            .into_iter()
            .map(|g| {
                let b = get_common_bounding_box(g.iter(), store);
                (g, b)
            })
            .collect();
    groups.sort_by(|a, b| bb_mid(&a.1, axis).total_cmp(&bb_mid(&b.1, axis)));
    let span: f64 = groups.iter().map(|g| bb_extent(&g.1, axis)).sum();
    let n = groups.len() as f64;
    let step = (bb_extent(&bounds, axis) - span) / (n - 1.);
    let mut out = vec![];
    if step < 0. {
        // distribute from centers; the boxes at the ends stay
        let i0 = groups
            .iter()
            .position(|g| bb_min(&g.1, axis) == bb_min(&bounds, axis));
        let i1 = groups
            .iter()
            .position(|g| bb_max(&g.1, axis) == bb_max(&bounds, axis));
        let (Some(i0), Some(i1)) = (i0, i1) else {
            return out;
        };
        let step = (bb_mid(&groups[i1].1, axis) - bb_mid(&groups[i0].1, axis)) / (n - 1.);
        let mut pos = bb_mid(&groups[i0].1, axis);
        for (i, (g, b)) in groups.iter().enumerate() {
            let mut v = 0.;
            if i != i0 && i != i1 {
                pos += step;
                v = pos - bb_mid(b, axis);
            }
            let (dx, dy) = on_axis(axis, v);
            out.extend(translate_group(g, dx, dy, store, hooks));
        }
        return out;
    }
    let mut pos = bb_min(&bounds, axis);
    for (g, b) in &groups {
        let (dx, dy) = on_axis(axis, pos - bb_min(b, axis));
        pos += step + bb_extent(b, axis);
        out.extend(translate_group(g, dx, dy, store, hooks));
    }
    out
}

/// `positionElementsOnGrid`: lays the units (each a group of elements, or
/// one element each) out on a roughly square grid centered on
/// (`center_x`, `center_y`), `padding` apart (upstream default 50).
pub fn position_elements_on_grid(
    units: &[Vec<Element>],
    center_x: f64,
    center_y: f64,
    padding: f64,
) -> Vec<Element> {
    if units.is_empty() {
        return vec![];
    }
    let cols = ((units.len() as f64).sqrt().ceil() as usize).max(1);
    struct Unit<'a> {
        elements: &'a [Element],
        min: (f64, f64),
        w: f64,
        h: f64,
    }
    let rows: Vec<(Vec<Unit>, f64, f64)> = units
        .chunks(cols)
        .map(|row| {
            let us: Vec<Unit> = row
                .iter()
                .map(|u| {
                    let [x1, y1, x2, y2] = get_common_bounds(u.iter(), u);
                    Unit {
                        elements: u,
                        min: (x1, y1),
                        w: x2 - x1,
                        h: y2 - y1,
                    }
                })
                .collect();
            let width = us.iter().map(|u| u.w).sum::<f64>() + padding * (us.len() - 1) as f64;
            let height = us.iter().map(|u| u.h).fold(0., f64::max);
            (us, width, height)
        })
        .collect();
    let total = rows.iter().map(|r| r.2).sum::<f64>() + (rows.len() as f64 - 1.).max(0.) * padding;
    let mut y = center_y - total / 2.;
    let mut out = vec![];
    for (us, width, height) in &rows {
        let mut x = center_x - width / 2.;
        for u in us {
            let (ox, oy) = (x - u.min.0, y - u.min.1);
            out.extend(u.elements.iter().map(|e| {
                new_element_with(
                    e,
                    |n| {
                        n.x = e.x + ox;
                        n.y = e.y + oy;
                    },
                    false,
                )
            }));
            x += u.w + padding;
        }
        y += height + padding;
    }
    out
}

/// `positionElementsOnGrid` with a flat list: one element per unit.
pub fn position_each_element_on_grid(
    elements: &[Element],
    center_x: f64,
    center_y: f64,
    padding: f64,
) -> Vec<Element> {
    let units: Vec<Vec<Element>> = elements.iter().map(|e| vec![e.clone()]).collect();
    position_elements_on_grid(&units, center_x, center_y, padding)
}
