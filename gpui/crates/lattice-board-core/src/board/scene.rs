// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The scene: elements in z-order with an id index. Port of Excalidraw
//! `packages/element/src/Scene.ts` and `packages/element/src/sortElements.ts`
//! @ 3a317b5. A plain struct: no callbacks, no throttled validation, no
//! selection cache (selection lives with the selection module). Whoever
//! renders compares `scene_nonce` to know when to redraw.

use super::fractional_index::{sync_invalid_indices, sync_moved_indices};
use super::mutate::{bump_version, mutate_element};
use super::random::random_integer;
use super::types::{BoundType, Element};
use super::utils::ElementsMap;
use rustc_hash::{FxHashMap, FxHashSet};

#[derive(Clone, Debug, Default)]
pub struct Scene {
    /// All elements, deleted ones included, in z-order (fractional indices
    /// kept in sync with it).
    elements: Vec<Element>,
    /// id → position in `elements`.
    map: FxHashMap<String, usize>,
    /// Positions of the non-deleted elements, in order.
    non_deleted: Vec<usize>,
    /// Positions of frame-likes (deleted included), in order.
    frames: Vec<usize>,
    /// Regenerated on every update; a renderer cache nonce, unrelated to
    /// element versions. None before the first update.
    scene_nonce: Option<i64>,
    /// id → the run of moves `translate_element` made (not upstream).
    moves: FxHashMap<String, Translation>,
    /// Regenerated on every change but moves (`translate_element`): what
    /// doesn't depend on where elements are can be kept while it stays.
    content_nonce: i64,
    /// Regenerated on every change, uninformed ones and moves included.
    change_nonce: i64,
}

/// A run of moves and nothing else: the element went from state `from`
/// (version, nonce), at `at`, to state `to` changing only `x`/`y`. Renderers
/// shift what they drew for `from` instead of redrawing (upstream keeps its
/// shape cache across moves: `ShapeCache.delete` only on size and points).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Translation {
    pub from: (i64, i64),
    pub to: (i64, i64),
    pub at: [f64; 2],
}

impl ElementsMap for Scene {
    fn get_element(&self, id: &str) -> Option<&Element> {
        self.get_element(id)
    }
    fn element_list(&self) -> Option<std::borrow::Cow<'_, [Element]>> {
        Some(self.elements.as_slice().into())
    }
}

impl Scene {
    pub fn new(elements: Vec<Element>) -> Scene {
        let mut s = Scene::default();
        s.replace_all_elements(elements);
        s
    }

    pub fn scene_nonce(&self) -> Option<i64> {
        self.scene_nonce
    }
    pub fn content_nonce(&self) -> i64 {
        self.content_nonce
    }
    pub fn change_nonce(&self) -> i64 {
        self.change_nonce
    }
    pub fn elements_including_deleted(&self) -> &[Element] {
        &self.elements
    }
    pub fn non_deleted_elements(&self) -> impl DoubleEndedIterator<Item = &Element> + '_ {
        self.non_deleted.iter().map(|&i| &self.elements[i])
    }
    pub fn non_deleted_len(&self) -> usize {
        self.non_deleted.len()
    }
    pub fn frames_including_deleted(&self) -> impl Iterator<Item = &Element> + '_ {
        self.frames.iter().map(|&i| &self.elements[i])
    }
    pub fn non_deleted_frame_likes(&self) -> impl Iterator<Item = &Element> + '_ {
        self.frames_including_deleted().filter(|e| !e.is_deleted)
    }

    pub fn get_element(&self, id: &str) -> Option<&Element> {
        self.map.get(id).map(|&i| &self.elements[i])
    }
    pub fn get_non_deleted_element(&self, id: &str) -> Option<&Element> {
        self.get_element(id).filter(|e| !e.is_deleted)
    }
    /// `getElementIndex`: position in z-order, deleted elements counted.
    pub fn get_element_index(&self, id: &str) -> Option<usize> {
        self.map.get(id).copied()
    }

    /// `mapElements`: `f` returns Some(new element) to replace one; if any
    /// were replaced, the scene is rebuilt. Returns whether anything changed.
    pub fn map_elements(&mut self, mut f: impl FnMut(&Element) -> Option<Element>) -> bool {
        let mut changed = false;
        let next: Vec<Element> = self
            .elements
            .iter()
            .map(|e| match f(e) {
                Some(n) => {
                    changed = true;
                    n
                }
                None => e.clone(),
            })
            .collect();
        if changed {
            self.replace_all_elements(next);
        }
        changed
    }

    /// `replaceAllElements`: takes the elements in z-order, fixes invalid
    /// indices, rebuilds the views and bumps the nonce.
    pub fn replace_all_elements(&mut self, mut elements: Vec<Element>) {
        sync_invalid_indices(&mut elements);
        self.elements = elements;
        self.rebuild();
        self.content_nonce = random_integer();
        self.change_nonce = random_integer();
        self.trigger_update();
    }

    fn rebuild(&mut self) {
        self.map.clear();
        self.non_deleted.clear();
        self.frames.clear();
        for (i, e) in self.elements.iter().enumerate() {
            if e.is_frame_like() {
                self.frames.push(i);
            }
            if !e.is_deleted {
                self.non_deleted.push(i);
            }
            self.map.insert(e.id.clone(), i);
        }
    }

    /// `triggerUpdate`: a new nonce.
    pub fn trigger_update(&mut self) {
        self.scene_nonce = Some(random_integer());
    }

    /// `insertElementsAtIndex`: inserts at `index` (None: on top) and gives
    /// the new elements indices between their neighbours.
    pub fn insert_elements_at_index(&mut self, elements: Vec<Element>, index: Option<usize>) {
        if elements.is_empty() {
            return;
        }
        let index = index
            .unwrap_or(self.elements.len())
            .min(self.elements.len());
        let moved: FxHashSet<String> = elements.iter().map(|e| e.id.clone()).collect();
        let mut next = std::mem::take(&mut self.elements);
        next.splice(index..index, elements);
        sync_moved_indices(&mut next, &moved);
        self.replace_all_elements(next);
    }

    /// `insertElement`: on top.
    pub fn insert_element(&mut self, e: Element) {
        self.insert_elements_at_index(vec![e], None)
    }

    /// `getContainerElement`.
    pub fn get_container_element(&self, e: &Element) -> Option<&Element> {
        e.container_id().and_then(|id| self.get_element(id))
    }

    /// `getElementsFromId`: the element with that id, or the members of the
    /// group with that id (non-deleted only).
    pub fn get_elements_from_id(&self, id: &str) -> Vec<&Element> {
        if let Some(e) = self.get_non_deleted_element(id) {
            return vec![e];
        }
        self.non_deleted_elements()
            .filter(|e| e.group_ids.iter().any(|g| g == id))
            .collect()
    }

    /// `Scene.mutateElement`: mutates the element with `id`; when its version
    /// changed and `inform` is set, bumps the scene nonce. Returns whether it
    /// changed. Changing `isDeleted` or the frame-ness goes through here too,
    /// so the views are rebuilt when needed.
    pub fn mutate_element(&mut self, id: &str, inform: bool, f: impl FnOnce(&mut Element)) -> bool {
        let Some(&i) = self.map.get(id) else {
            return false;
        };
        let (was_deleted, was_frame) = (
            self.elements[i].is_deleted,
            self.elements[i].is_frame_like(),
        );
        let changed = mutate_element(&mut self.elements[i], f);
        let e = &self.elements[i];
        debug_assert_eq!(e.id, id, "ids are not updatable");
        if e.is_deleted != was_deleted || e.is_frame_like() != was_frame {
            self.rebuild();
        }
        if changed {
            (self.content_nonce, self.change_nonce) = (random_integer(), random_integer());
        }
        if changed && inform {
            self.trigger_update();
        }
        changed
    }

    /// `mutate_element` for a move alone (`x`/`y` to `x`, `y`), without the
    /// copy and compare, recorded for `translation`. Returns whether it moved.
    pub fn translate_element(&mut self, id: &str, x: f64, y: f64, inform: bool) -> bool {
        let Some(&i) = self.map.get(id) else {
            return false;
        };
        let e = &mut self.elements[i];
        if e.x == x && e.y == y {
            return false;
        }
        let (from, at) = ((e.version, e.version_nonce), [e.x, e.y]);
        (e.x, e.y) = (x, y);
        bump_version(e, None);
        self.change_nonce = random_integer();
        let to = (e.version, e.version_nonce);
        match self.moves.get_mut(id) {
            Some(t) if t.to == from => t.to = to,
            _ => {
                if self.moves.len() > self.elements.len() * 2 + 64 {
                    self.moves.clear();
                }
                self.moves
                    .insert(id.to_string(), Translation { from, to, at });
            }
        }
        if inform {
            self.trigger_update();
        }
        true
    }

    /// The moves since the element was last changed otherwise, if its
    /// current state is the end of them (`to`).
    pub fn translation(&self, id: &str) -> Option<&Translation> {
        let t = self.moves.get(id)?;
        self.get_element(id)
            .filter(|e| (e.version, e.version_nonce) == t.to)
            .map(|_| t)
    }

    /// Takes the elements out, leaving the scene empty (`destroy`).
    pub fn into_elements(self) -> Vec<Element> {
        self.elements
    }
}

// sortElements.ts

/// Gathers group members together at each nesting level, keeping the first
/// occurrence's slot.
fn defragment_groups(elements: Vec<Element>) -> Vec<Element> {
    fn order_level(items: Vec<usize>, level: usize, elements: &[Element], out: &mut Vec<usize>) {
        let group_at = |i: usize| {
            let g = &elements[i].group_ids;
            g.len().checked_sub(level + 1).map(|k| g[k].as_str())
        };
        enum Slot<'a> {
            One(usize),
            Group(&'a str),
        }
        let mut buckets: FxHashMap<&str, Vec<usize>> = FxHashMap::default();
        let mut slots = vec![];
        for i in items {
            match group_at(i) {
                None => slots.push(Slot::One(i)),
                Some(g) => {
                    let bucket = buckets.entry(g).or_insert_with(|| {
                        slots.push(Slot::Group(g));
                        vec![]
                    });
                    bucket.push(i);
                }
            }
        }
        for s in slots {
            match s {
                Slot::One(i) => out.push(i),
                Slot::Group(g) => order_level(
                    buckets.remove(g).unwrap_or_default(),
                    level + 1,
                    elements,
                    out,
                ),
            }
        }
    }
    let mut order = Vec::with_capacity(elements.len());
    order_level((0..elements.len()).collect(), 0, &elements, &mut order);
    // losing elements would be a bug; better keep the original
    if order.len() != elements.len() {
        return elements;
    }
    reorder(elements, &order)
}

fn reorder(elements: Vec<Element>, order: &[usize]) -> Vec<Element> {
    let mut slots: Vec<Option<Element>> = elements.into_iter().map(Some).collect();
    order.iter().map(|&i| slots[i].take().unwrap()).collect()
}

/// `normalizeBoundElementsOrder`: bound text right after its container,
/// keeping the container's place. Text whose container doesn't list it stays
/// where it is.
pub fn normalize_bound_elements_order(elements: Vec<Element>) -> Vec<Element> {
    let map: FxHashMap<&str, usize> = elements
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.as_str(), i))
        .collect();
    let mut seen = vec![false; elements.len()];
    let mut order = Vec::with_capacity(elements.len());
    fn add(i: usize, seen: &mut [bool], order: &mut Vec<usize>) {
        if !seen[i] {
            seen[i] = true;
            order.push(i);
        }
    }
    for (i, e) in elements.iter().enumerate() {
        if seen[i] {
            continue;
        }
        if let Some(bound) = e.bound_elements.as_ref().filter(|b| !b.is_empty()) {
            add(i, &mut seen, &mut order);
            for b in bound {
                if b.kind == BoundType::Text
                    && let Some(&c) = map.get(b.id.as_str())
                {
                    add(c, &mut seen, &mut order);
                }
            }
            continue;
        }
        // listed by its container: the container places it
        if let Some(cid) = e.container_id()
            && map
                .get(cid)
                .and_then(|&c| elements[c].bound_elements.as_ref())
                .is_some_and(|b| b.iter().any(|b| b.id == e.id))
        {
            continue;
        }
        add(i, &mut seen, &mut order);
    }
    if order.len() != elements.len() {
        return elements;
    }
    reorder(elements, &order)
}

/// `normalizeElementOrder`: groups defragmented, bound text after containers.
pub fn normalize_element_order(elements: Vec<Element>) -> Vec<Element> {
    normalize_bound_elements_order(defragment_groups(elements))
}
