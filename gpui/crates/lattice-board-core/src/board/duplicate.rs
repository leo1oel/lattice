// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Duplication. Port of Excalidraw `packages/element/src/duplicate.ts`
//! @ 3a317b5: `duplicateElement` (new id, timestamps, remapped groups below
//! the edited one) and `duplicateElements` (whole groups, frames with their
//! children, containers with their bound text, inserted after their
//! originals; bindings and frame membership pointed at the duplicates).
//!
//! Differences from upstream:
//! - `deepCopyElement` is `Clone`;
//! - upstream tags duplicates with their original's id (`ORIG_ID`) in its
//!   test environment; here `track_orig_ids(true)` records them per thread,
//!   read back with `get_orig_id`;
//! - `overrides` edits the duplicate in place instead of returning a partial;
//! - elbow arrows are rerouted through `BindingHooks`, as binding does;
//! - `reconcileDuplicatedElements` (the host's `onDuplicate` callback) isn't
//!   ported: we have no host API.

use super::binding::{BindingHooks, fix_duplicated_bindings_after_duplication};
use super::frame::{bind_elements_to_frames_after_duplication, get_frame_children};
use super::groups::{
    get_elements_in_group, get_new_group_ids_for_duplication, get_selected_group_for_element,
};
use super::mutate::{bump_version, get_updated_timestamp};
use super::random::{random_id, random_integer};
use super::scene::normalize_element_order;
use super::types::Element;
use super::utils::ElementsMap;
use rustc_hash::{FxHashMap, FxHashSet};
use std::cell::RefCell;
use std::collections::BTreeMap;

thread_local! {
    static ORIG_IDS: RefCell<Option<FxHashMap<String, String>>> = const { RefCell::new(None) };
}

/// Test hook: record each duplicate's original id on this thread (upstream's
/// `ORIG_ID` in its test environment). `false` stops and forgets.
pub fn track_orig_ids(on: bool) {
    ORIG_IDS.with(|m| *m.borrow_mut() = on.then(FxHashMap::default))
}
/// The original of the duplicate `id`, when tracking (`getCloneByOrigId`'s
/// other direction).
pub fn get_orig_id(id: &str) -> Option<String> {
    ORIG_IDS.with(|m| m.borrow().as_ref().and_then(|m| m.get(id).cloned()))
}

/// `duplicateElement`: a copy with a new id and timestamps whose groups below
/// `editing_group_id` are remapped through `group_id_map` (shared by all the
/// elements duplicated together). `randomize_seed`: a new seed and version.
pub fn duplicate_element(
    editing_group_id: Option<&str>,
    group_id_map: &mut FxHashMap<String, String>,
    e: &Element,
    randomize_seed: bool,
) -> Element {
    let mut copy = e.clone();
    copy.id = random_id();
    ORIG_IDS.with(|m| {
        if let Some(m) = m.borrow_mut().as_mut() {
            m.insert(copy.id.clone(), e.id.clone());
        }
    });
    copy.updated = get_updated_timestamp();
    copy.created = Some(copy.updated);
    if randomize_seed {
        copy.seed = random_integer();
        bump_version(&mut copy, None);
    }
    copy.group_ids = get_new_group_ids_for_duplication(&copy.group_ids, editing_group_id, |g| {
        group_id_map
            .entry(g.to_string())
            .or_insert_with(random_id)
            .clone()
    });
    copy
}

/// What `duplicateElements` duplicates.
#[derive(Clone, Copy, Debug)]
pub enum DuplicateMode<'a> {
    /// All the elements, programmatically.
    Everything { preserve_frame_children_order: bool },
    /// These elements (and whole selected groups), inserted back after their
    /// originals: the duplicate action, alt-drag.
    InPlace {
        ids: &'a FxHashSet<String>,
        editing_group_id: Option<&'a str>,
        selected_group_ids: &'a BTreeMap<String, bool>,
    },
}

/// `duplicateElements`' result.
#[derive(Clone, Debug, Default)]
pub struct Duplication {
    /// The duplicates, in the order they were made.
    pub duplicated_elements: Vec<Element>,
    /// The (normalized) elements with the duplicates inserted.
    pub elements_with_duplicates: Vec<Element>,
    pub orig_id_to_duplicate_id: FxHashMap<String, String>,
    pub duplicate_id_to_orig_id: FxHashMap<String, String>,
}

/// Overrides applied to each duplicate: (duplicate, original, orig → dup ids).
pub type DuplicateOverrides<'a> =
    &'a mut dyn FnMut(&mut Element, &Element, &FxHashMap<String, String>);

struct Copier<'a> {
    editing: Option<&'a str>,
    randomize_seed: bool,
    processed: FxHashSet<String>,
    group_map: FxHashMap<String, String>,
    origs: Vec<usize>,
    o2d: FxHashMap<String, String>,
    d2o: FxHashMap<String, String>,
}

impl Copier<'_> {
    /// `copyElements`: duplicates those not yet processed; returns their
    /// positions in `dups`.
    fn copy(&mut self, els: &[Element], list: &[usize], dups: &mut Vec<Element>) -> Vec<usize> {
        let mut out = vec![];
        for &i in list {
            let e = &els[i];
            if !self.processed.insert(e.id.clone()) {
                continue;
            }
            let n = duplicate_element(self.editing, &mut self.group_map, e, self.randomize_seed);
            self.processed.insert(n.id.clone());
            self.o2d.insert(e.id.clone(), n.id.clone());
            self.d2o.insert(n.id.clone(), e.id.clone());
            self.origs.push(i);
            out.push(dups.len());
            dups.push(n);
        }
        out
    }
}

#[derive(Clone, Copy)]
enum Slot {
    Orig(usize),
    Dup(usize),
}

/// `duplicateElements`.
pub fn duplicate_elements(
    elements: &[Element],
    mode: DuplicateMode,
    randomize_seed: bool,
    overrides: Option<DuplicateOverrides>,
    hooks: &dyn BindingHooks,
) -> Duplication {
    let empty = BTreeMap::new();
    let (editing, selected_groups) = match mode {
        DuplicateMode::InPlace {
            editing_group_id,
            selected_group_ids,
            ..
        } => (editing_group_id, selected_group_ids),
        _ => (None, &empty),
    };
    let preserve = matches!(
        mode,
        DuplicateMode::Everything {
            preserve_frame_children_order: true
        }
    );
    let mut to_dup: FxHashSet<String> = match mode {
        DuplicateMode::InPlace { ids, .. } => ids.clone(),
        _ => elements.iter().map(|e| e.id.clone()).collect(),
    };
    if let DuplicateMode::InPlace {
        selected_group_ids, ..
    } = mode
    {
        // for sanity: every member of a listed group
        for g in selected_group_ids.keys() {
            to_dup.extend(
                elements
                    .iter()
                    .filter(|e| e.group_ids.contains(g))
                    .map(|e| e.id.clone()),
            );
        }
    }
    let els = normalize_element_order(elements.to_vec());
    let idx: FxHashMap<&str, usize> = els
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.as_str(), i))
        .collect();
    let mut st = Copier {
        editing,
        randomize_seed,
        processed: FxHashSet::default(),
        group_map: FxHashMap::default(),
        origs: vec![],
        o2d: FxHashMap::default(),
        d2o: FxHashMap::default(),
    };
    let mut dups: Vec<Element> = vec![];
    let mut with: Vec<Slot> = (0..els.len()).map(Slot::Orig).collect();
    fn get<'a>(s: Slot, els: &'a [Element], dups: &'a [Element]) -> &'a Element {
        match s {
            Slot::Orig(i) => &els[i],
            Slot::Dup(i) => &dups[i],
        }
    }
    fn last(
        with: &[Slot],
        els: &[Element],
        dups: &[Element],
        f: impl Fn(&Element) -> bool,
    ) -> isize {
        with.iter()
            .rposition(|&s| f(get(s, els, dups)))
            .map_or(-1, |i| i as isize)
    }
    fn insert(with: &mut Vec<Slot>, at: isize, new: Vec<usize>) {
        let new = new.into_iter().map(Slot::Dup);
        if at > with.len() as isize - 1 {
            with.extend(new);
        } else {
            let k = (at + 1) as usize;
            with.splice(k..k, new);
        }
    }
    let frames_to_dup: FxHashSet<&str> = els
        .iter()
        .filter(|e| to_dup.contains(&e.id) && e.is_frame_like())
        .map(|e| e.id.as_str())
        .collect();
    let ids =
        |v: Vec<&Element>| -> Vec<usize> { v.into_iter().map(|e| idx[e.id.as_str()]).collect() };

    for (i, e) in els.iter().enumerate() {
        if st.processed.contains(&e.id) || !to_dup.contains(&e.id) {
            continue;
        }
        // groups
        if let Some(g) = get_selected_group_for_element(selected_groups, editing, e) {
            let members: Vec<&Element> = get_elements_in_group(&els, g)
                .into_iter()
                .flat_map(|m| {
                    if m.is_frame_like() && !preserve {
                        let mut c = get_frame_children(&els, &m.id);
                        c.push(m);
                        c
                    } else {
                        vec![m]
                    }
                })
                .collect();
            let at = last(&with, &els, &dups, |x| x.group_ids.iter().any(|y| y == g));
            let new = st.copy(&els, &ids(members), &mut dups);
            insert(&mut with, at, new);
            continue;
        }
        // frames
        if !preserve
            && e.frame_id
                .as_deref()
                .is_some_and(|f| frames_to_dup.contains(f))
        {
            continue;
        }
        if e.is_frame_like() {
            if preserve {
                let at = last(&with, &els, &dups, |x| x.id == e.id);
                let new = st.copy(&els, &[i], &mut dups);
                insert(&mut with, at, new);
                continue;
            }
            let mut list = ids(get_frame_children(&els, &e.id));
            list.push(i);
            let at = last(&with, &els, &dups, |x| {
                x.frame_id.as_deref() == Some(&e.id) || x.id == e.id
            });
            let new = st.copy(&els, &list, &mut dups);
            insert(&mut with, at, new);
            continue;
        }
        // text containers
        if e.has_bound_text() {
            let at = last(&with, &els, &dups, |x| {
                x.id == e.id || x.container_id() == Some(&e.id)
            });
            let t = e.bound_text_id().and_then(|t| idx.get(t).copied());
            let new = st.copy(
                &els,
                &[Some(i), t].into_iter().flatten().collect::<Vec<_>>(),
                &mut dups,
            );
            insert(&mut with, at, new);
            continue;
        }
        if let Some(c) = e.container_id() {
            let ci = idx.get(c).copied();
            let at = last(&with, &els, &dups, |x| {
                x.id == e.id || ci.is_some() && x.id == c
            });
            let new = st.copy(
                &els,
                &[ci, Some(i)].into_iter().flatten().collect::<Vec<_>>(),
                &mut dups,
            );
            insert(&mut with, at, new);
            continue;
        }
        // regular elements
        let at = last(&with, &els, &dups, |x| x.id == e.id);
        let new = st.copy(&els, &[i], &mut dups);
        insert(&mut with, at, new);
    }

    let Copier {
        origs, o2d, d2o, ..
    } = st;
    let dup_map: FxHashMap<String, Element> =
        dups.iter().map(|d| (d.id.clone(), d.clone())).collect();
    fix_duplicated_bindings_after_duplication(&mut dups, &o2d, &dup_map as &dyn ElementsMap, hooks);
    let orig_elements: Vec<Element> = origs.iter().map(|&i| els[i].clone()).collect();
    bind_elements_to_frames_after_duplication(&mut dups, &orig_elements, &o2d);
    if let Some(f) = overrides {
        for (d, &o) in dups.iter_mut().zip(&origs) {
            f(d, &els[o], &o2d);
        }
    }
    let elements_with_duplicates = with.iter().map(|&s| get(s, &els, &dups).clone()).collect();
    Duplication {
        duplicated_elements: dups,
        elements_with_duplicates,
        orig_id_to_duplicate_id: o2d,
        duplicate_id_to_orig_id: d2o,
    }
}
