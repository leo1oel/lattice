// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Element updates that keep `version`, `versionNonce` and `updated` honest.
//! Port of Excalidraw `packages/element/src/mutateElement.ts` @ 3a317b5.
//!
//! Upstream passes a partial object of updates; here the update is a closure
//! over the element, and "did anything change" is decided by comparing the
//! element before and after. Differences that follow from that:
//! - setting a field to its current value never bumps the version (upstream
//!   bumps when the value is a non-null object such as `boundElements`, even
//!   if equal); call `bump_version` to force one;
//! - when `points` change and the closure leaves `width`/`height` alone, they
//!   are recomputed from the points (upstream: whenever `points` is passed);
//! - upstream compares points from the last one down to the second, so a
//!   change to only the first point is dropped; here every point counts.
//! - elbow arrows: upstream reroutes them inside `mutateElement`
//!   (`updateElbowArrowPoints`) when `points` or `fixedSegments` change;
//!   routing needs the scene, so that is `binding::mutate_elbow_arrow`
//!   (routed by elbow.rs), which callers use for elbow arrows instead.
//!
//! Shape caches key on `version`, so there's no `ShapeCache.delete`.

use super::random::random_integer;
use super::types::Element;
use super::utils::get_size_from_points;
use std::cell::Cell;

thread_local! {
    static FIXED_TIME: Cell<Option<i64>> = const { Cell::new(None) };
}

/// Test hook: makes `get_updated_timestamp` return `t` on this thread
/// (upstream returns 1 in its test environment). `None` goes back to the clock.
pub fn fix_timestamp(t: Option<i64>) {
    FIXED_TIME.with(|c| c.set(t))
}

/// Runs `f` with `get_updated_timestamp` read once (moving thousands of
/// elements in one step would otherwise read the clock for each).
pub fn with_one_timestamp<R>(f: impl FnOnce() -> R) -> R {
    let prev = FIXED_TIME.with(|c| c.get());
    if prev.is_none() {
        let now = get_updated_timestamp();
        FIXED_TIME.with(|c| c.set(Some(now)));
    }
    let r = f();
    FIXED_TIME.with(|c| c.set(prev));
    r
}

/// `getUpdatedTimestamp`: epoch milliseconds.
pub fn get_updated_timestamp() -> i64 {
    FIXED_TIME.with(|c| c.get()).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    })
}

/// Whether `a` and `b` differ, ignoring the bookkeeping fields.
fn differs(a: &mut Element, b: &Element) -> bool {
    let saved = (a.version, a.version_nonce, a.updated);
    (a.version, a.version_nonce, a.updated) = (b.version, b.version_nonce, b.updated);
    let differ = *a != *b;
    (a.version, a.version_nonce, a.updated) = saved;
    differ
}

/// Applies `f` and fixes up what follows from it: size from points, then the
/// version bump. `version`/`versionNonce` set by `f` are kept. `id` and
/// `created` are not part of an update.
fn apply(el: &mut Element, before: &Element, f: impl FnOnce(&mut Element)) -> bool {
    f(el);
    debug_assert!(
        el.id == before.id && el.created == before.created,
        "id and created are not updatable"
    );
    if let (Some(a), Some(b)) = (before.points(), el.points())
        && a != b
        && el.width == before.width
        && el.height == before.height
        && !el.is_elbow_arrow()
    {
        (el.width, el.height) = get_size_from_points(b);
    }
    if !differs(el, before) {
        return false;
    }
    if el.version == before.version {
        el.version = before.version + 1;
    }
    if el.version_nonce == before.version_nonce {
        el.version_nonce = random_integer();
    }
    el.updated = get_updated_timestamp();
    true
}

/// `mutateElement`: updates `el` in place. Returns whether anything changed
/// (and so whether the version was bumped).
pub fn mutate_element(el: &mut Element, f: impl FnOnce(&mut Element)) -> bool {
    let before = el.clone();
    apply(el, &before, f)
}

/// `newElementWith`: a copy of `el` with `f` applied, bumped if anything
/// changed or `force` is set; otherwise an unchanged copy.
pub fn new_element_with(el: &Element, f: impl FnOnce(&mut Element), force: bool) -> Element {
    let mut next = el.clone();
    if !apply(&mut next, el, f) && force {
        bump_version(&mut next, None);
    }
    next
}

/// `bumpVersion`: `version` becomes `version.unwrap_or(el.version) + 1`, with
/// a new nonce and timestamp.
pub fn bump_version(el: &mut Element, version: Option<i64>) {
    el.version = version.unwrap_or(el.version) + 1;
    el.version_nonce = random_integer();
    el.updated = get_updated_timestamp();
}
