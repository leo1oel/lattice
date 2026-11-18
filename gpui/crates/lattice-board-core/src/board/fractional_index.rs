// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Fractional indices: z-order kept in each element as a string that sorts
//! between its neighbours. Port of Excalidraw `packages/element/src/fractionalIndex.ts`
//! and of the vendored `packages/fractional-indexing/src/index.ts` (CC0,
//! rocicorp/fractional-indexing after David Greenspan's observable notebook)
//! @ 3a317b5. Errors are `Err(String)` where upstream throws.
//!
//! Keys are ASCII, so byte order is JS string order. Invalid keys from files
//! can hold anything; they are only compared on the way to being replaced.

use super::mutate::{mutate_element, new_element_with};
use super::types::Element;
use rustc_hash::{FxHashMap, FxHashSet};

pub const BASE_62_DIGITS: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// ---------------------------------------------------------------------------
// fractional-indexing
// ---------------------------------------------------------------------------

fn digit_index(digits: &[u8], c: u8) -> Option<usize> {
    digits.iter().position(|&d| d == c)
}

/// `a` may be empty, `b` is None or non-empty, `a < b` if `b` is given; no
/// trailing zeros.
fn midpoint(a: &[u8], b: Option<&[u8]>, digits: &[u8]) -> Result<Vec<u8>, String> {
    let zero = digits[0];
    if let Some(b) = b
        && a >= b
    {
        return Err(format!(
            "{} >= {}",
            String::from_utf8_lossy(a),
            String::from_utf8_lossy(b)
        ));
    }
    if a.last() == Some(&zero) || b.and_then(|b| b.last()) == Some(&zero) {
        return Err("trailing zero".into());
    }
    if let Some(b) = b {
        // remove the longest common prefix, padding `a` with zeros as we go
        let mut n = 0;
        while n < b.len() && *a.get(n).unwrap_or(&zero) == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..]), digits)?);
            return Ok(out);
        }
    }
    // first digits (or lack of digit) are different
    let digit_a = if a.is_empty() {
        0
    } else {
        digit_index(digits, a[0]).ok_or("invalid digit")?
    };
    let digit_b = match b {
        Some(b) => digit_index(digits, b[0]).ok_or("invalid digit")?,
        None => digits.len(),
    };
    if digit_b - digit_a > 1 {
        // Math.round(0.5 * (a + b))
        return Ok(vec![digits[(digit_a + digit_b).div_ceil(2)]]);
    }
    // first digits are consecutive
    if let Some(b) = b
        && b.len() > 1
    {
        return Ok(b[..1].to_vec());
    }
    // `b` is None or a single digit: `a`'s first digit, then the midpoint of
    // its rest and the end (midpoint('49', '5') = '4' + midpoint('9', null))
    let mut out = vec![digits[digit_a]];
    out.extend(midpoint(a.get(1..).unwrap_or(&[]), None, digits)?);
    Ok(out)
}

fn get_integer_length(head: u8) -> Result<usize, String> {
    match head {
        b'a'..=b'z' => Ok((head - b'a') as usize + 2),
        b'A'..=b'Z' => Ok((b'Z' - head) as usize + 2),
        _ => Err(format!("invalid order key head: {}", head as char)),
    }
}

fn validate_integer(int: &[u8]) -> Result<(), String> {
    if int.is_empty() || int.len() != get_integer_length(int[0])? {
        return Err(format!(
            "invalid integer part of order key: {}",
            String::from_utf8_lossy(int)
        ));
    }
    Ok(())
}

fn get_integer_part(key: &[u8]) -> Result<&[u8], String> {
    let Some(&head) = key.first() else {
        return Err("invalid order key head: ".into());
    };
    let len = get_integer_length(head)?;
    if len > key.len() {
        return Err(format!(
            "invalid order key: {}",
            String::from_utf8_lossy(key)
        ));
    }
    Ok(&key[..len])
}

fn smallest_integer(digits: &[u8]) -> Vec<u8> {
    let mut v = vec![b'A'];
    v.extend(std::iter::repeat_n(digits[0], 26));
    v
}

/// `validateOrderKey` with explicit digits.
pub fn validate_order_key_with(key: &str, digits: &str) -> Result<(), String> {
    let (k, d) = (key.as_bytes(), digits.as_bytes());
    if k == smallest_integer(d).as_slice() || !k.iter().all(|c| d.contains(c)) {
        return Err(format!("invalid order key: {key}"));
    }
    // getIntegerPart rejects a bad head and a too-short key
    let i = get_integer_part(k)?;
    if k[i.len()..].last() == Some(&d[0]) {
        return Err(format!("invalid order key: {key}"));
    }
    Ok(())
}

/// `validateOrderKey`.
pub fn validate_order_key(key: &str) -> Result<(), String> {
    validate_order_key_with(key, BASE_62_DIGITS)
}

/// None past the largest integer.
fn increment_integer(x: &[u8], digits: &[u8]) -> Result<Option<Vec<u8>>, String> {
    validate_integer(x)?;
    let head = x[0];
    let mut digs = x[1..].to_vec();
    let mut carry = true;
    for i in (0..digs.len()).rev() {
        if !carry {
            break;
        }
        let d = digit_index(digits, digs[i]).ok_or("invalid digit")? + 1;
        if d == digits.len() {
            digs[i] = digits[0];
        } else {
            digs[i] = digits[d];
            carry = false;
        }
    }
    if carry {
        if head == b'Z' {
            return Ok(Some(vec![b'a', digits[0]]));
        }
        if head == b'z' {
            return Ok(None);
        }
        let h = head + 1;
        if h > b'a' {
            digs.push(digits[0]);
        } else {
            digs.pop();
        }
        let mut out = vec![h];
        out.extend(digs);
        return Ok(Some(out));
    }
    let mut out = vec![head];
    out.extend(digs);
    Ok(Some(out))
}

/// None below the smallest integer.
fn decrement_integer(x: &[u8], digits: &[u8]) -> Result<Option<Vec<u8>>, String> {
    validate_integer(x)?;
    let head = x[0];
    let last = *digits.last().unwrap();
    let mut digs = x[1..].to_vec();
    let mut borrow = true;
    for i in (0..digs.len()).rev() {
        if !borrow {
            break;
        }
        let d = digit_index(digits, digs[i]).ok_or("invalid digit")?;
        if d == 0 {
            digs[i] = last;
        } else {
            digs[i] = digits[d - 1];
            borrow = false;
        }
    }
    if borrow {
        if head == b'a' {
            return Ok(Some(vec![b'Z', last]));
        }
        if head == b'A' {
            return Ok(None);
        }
        let h = head - 1;
        if h < b'Z' {
            digs.push(last);
        } else {
            digs.pop();
        }
        let mut out = vec![h];
        out.extend(digs);
        return Ok(Some(out));
    }
    let mut out = vec![head];
    out.extend(digs);
    Ok(Some(out))
}

fn concat(a: &[u8], b: Vec<u8>) -> String {
    let mut v = a.to_vec();
    v.extend(b);
    String::from_utf8(v).unwrap_or_default()
}

/// `generateKeyBetween` with explicit digits. `a < b` when both are given;
/// None is the start / end.
pub fn generate_key_between_with(
    a: Option<&str>,
    b: Option<&str>,
    digits: &str,
) -> Result<String, String> {
    if let Some(a) = a {
        validate_order_key_with(a, digits)?;
    }
    if let Some(b) = b {
        validate_order_key_with(b, digits)?;
    }
    let d = digits.as_bytes();
    if let (Some(a), Some(b)) = (a, b)
        && a >= b
    {
        return Err(format!("{a} >= {b}"));
    }
    let Some(a) = a.map(str::as_bytes) else {
        let Some(b) = b.map(str::as_bytes) else {
            return Ok(format!("a{}", d[0] as char));
        };
        let ib = get_integer_part(b)?;
        let fb = &b[ib.len()..];
        if ib == smallest_integer(d).as_slice() {
            return Ok(concat(ib, midpoint(&[], Some(fb), d)?));
        }
        if ib < b {
            return Ok(String::from_utf8_lossy(ib).into_owned());
        }
        return match decrement_integer(ib, d)? {
            Some(r) => Ok(String::from_utf8(r).unwrap_or_default()),
            None => Err("cannot decrement any more".into()),
        };
    };
    let ia = get_integer_part(a)?;
    let fa = &a[ia.len()..];
    let Some(b) = b.map(str::as_bytes) else {
        return Ok(match increment_integer(ia, d)? {
            Some(i) => String::from_utf8(i).unwrap_or_default(),
            None => concat(ia, midpoint(fa, None, d)?),
        });
    };
    let ib = get_integer_part(b)?;
    let fb = &b[ib.len()..];
    if ia == ib {
        return Ok(concat(ia, midpoint(fa, Some(fb), d)?));
    }
    let Some(i) = increment_integer(ia, d)? else {
        return Err("cannot increment any more".into());
    };
    if i.as_slice() < b {
        return Ok(String::from_utf8(i).unwrap_or_default());
    }
    Ok(concat(ia, midpoint(fa, None, d)?))
}

/// `generateKeyBetween` in base 62.
pub fn generate_key_between(a: Option<&str>, b: Option<&str>) -> Result<String, String> {
    generate_key_between_with(a, b, BASE_62_DIGITS)
}

/// `generateNKeysBetween` with explicit digits: `n` distinct sorted keys.
/// Consecutive integer keys when one end is open; short keys between two.
pub fn generate_n_keys_between_with(
    a: Option<&str>,
    b: Option<&str>,
    n: usize,
    digits: &str,
) -> Result<Vec<String>, String> {
    if n == 0 {
        return Ok(vec![]);
    }
    if n == 1 {
        return Ok(vec![generate_key_between_with(a, b, digits)?]);
    }
    if b.is_none() {
        let mut c = generate_key_between_with(a, b, digits)?;
        let mut out = vec![c.clone()];
        for _ in 0..n - 1 {
            c = generate_key_between_with(Some(&c), b, digits)?;
            out.push(c.clone());
        }
        return Ok(out);
    }
    if a.is_none() {
        let mut c = generate_key_between_with(a, b, digits)?;
        let mut out = vec![c.clone()];
        for _ in 0..n - 1 {
            c = generate_key_between_with(a, Some(&c), digits)?;
            out.push(c.clone());
        }
        out.reverse();
        return Ok(out);
    }
    let mid = n / 2;
    let c = generate_key_between_with(a, b, digits)?;
    let mut out = generate_n_keys_between_with(a, Some(&c), mid, digits)?;
    out.push(c.clone());
    out.extend(generate_n_keys_between_with(
        Some(&c),
        b,
        n - mid - 1,
        digits,
    )?);
    Ok(out)
}

pub fn generate_n_keys_between(
    a: Option<&str>,
    b: Option<&str>,
    n: usize,
) -> Result<Vec<String>, String> {
    generate_n_keys_between_with(a, b, n, BASE_62_DIGITS)
}

// ---------------------------------------------------------------------------
// fractionalIndex.ts
// ---------------------------------------------------------------------------

/// `InvalidFractionalIndexError` (code `ELEMENT_HAS_INVALID_INDEX`), with the
/// messages upstream logs.
#[derive(Clone, Debug, PartialEq)]
pub struct InvalidFractionalIndexError {
    pub messages: Vec<String>,
}

impl std::fmt::Display for InvalidFractionalIndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.messages.join("\n\n"))
    }
}
impl std::error::Error for InvalidFractionalIndexError {}

fn stringify(e: Option<&Element>) -> String {
    match e {
        Some(e) => format!(
            "{}:{}:{}:{}:{}:{}",
            e.index.as_deref().unwrap_or("null"),
            e.id,
            e.ty().as_str(),
            e.is_deleted,
            e.version,
            e.version_nonce
        ),
        None => "undefined:undefined:undefined:undefined:undefined:undefined".into(),
    }
}

/// `validateFractionalIndices`: every index valid and increasing; with
/// `include_bound_text`, bound text also sorts after its container.
pub fn validate_fractional_indices(
    elements: &[Element],
    include_bound_text: bool,
) -> Result<(), InvalidFractionalIndexError> {
    let mut messages = vec![];
    let map: Option<FxHashMap<&str, &Element>> =
        include_bound_text.then(|| elements.iter().map(|e| (e.id.as_str(), e)).collect());
    for i in 0..elements.len() {
        let pred = i.checked_sub(1).and_then(|p| elements[p].index.as_deref());
        let succ = elements.get(i + 1).and_then(|e| e.index.as_deref());
        if !is_valid_fractional_index(elements[i].index.as_deref(), pred, succ) {
            messages.push(format!(
                "Fractional indices invariant has been compromised: \"{}\", \"{}\", \"{}\"",
                stringify(i.checked_sub(1).map(|p| &elements[p])),
                stringify(Some(&elements[i])),
                stringify(elements.get(i + 1))
            ));
        }
        let container = &elements[i];
        if let Some(map) = &map
            && container.has_bound_text()
            && !container.is_deleted
            && let Some(text) = container.bound_text_id().and_then(|id| map.get(id))
            && !text.is_deleted
            && text.index <= container.index
        {
            messages.push(format!("Fractional indices invariant for bound elements has been compromised: \"{}\", \"{}\"", stringify(Some(text)), stringify(Some(container))));
        }
    }
    if messages.is_empty() {
        Ok(())
    } else {
        Err(InvalidFractionalIndexError { messages })
    }
}

/// `orderByFractionalIndex`: sorts by index, ties broken by id. Upstream's
/// comparator keeps array order "defensively" when an index is missing, which
/// isn't a consistent order; here a missing index leaves the array as is.
pub fn order_by_fractional_index(elements: &mut [Element]) {
    if elements
        .iter()
        .any(|e| e.index.as_deref().is_none_or(str::is_empty))
    {
        return;
    }
    elements.sort_by(|a, b| a.index.cmp(&b.index).then_with(|| a.id.cmp(&b.id)));
}

/// `syncMovedIndices`: regenerates the indices of `moved` elements to fit the
/// array order; when that fails or leaves the array invalid, falls back to
/// `sync_invalid_indices`. Mutates (bumping versions).
pub fn sync_moved_indices(elements: &mut [Element], moved: &FxHashSet<String>) {
    let groups = get_moved_indices_groups(elements, moved);
    let updates = match generate_indices(elements, groups) {
        Ok(u) => u,
        Err(_) => return sync_invalid_indices(elements),
    };
    let mut candidates: Vec<Option<&str>> = elements.iter().map(|e| e.index.as_deref()).collect();
    for (i, index) in &updates {
        candidates[*i] = Some(index);
    }
    if !indices_valid(&candidates) {
        return sync_invalid_indices(elements);
    }
    for (i, index) in updates {
        mutate_element(&mut elements[i], |e| e.index = Some(index));
    }
}

/// `validateFractionalIndices` without bound text, over bare indices.
fn indices_valid(indices: &[Option<&str>]) -> bool {
    (0..indices.len()).all(|i| {
        is_valid_fractional_index(
            indices[i],
            i.checked_sub(1).and_then(|p| indices[p]),
            indices.get(i + 1).copied().flatten(),
        )
    })
}

/// `syncInvalidIndices`: regenerates every index that doesn't fit the array
/// order. Mutates (bumping versions). In edge cases it can touch elements
/// that weren't moved: the array alone can't tell which ones were.
pub fn sync_invalid_indices(elements: &mut [Element]) {
    let groups = get_invalid_indices_groups(elements);
    // the bounds of invalid groups are valid by construction
    let Ok(updates) = generate_indices(elements, groups) else {
        return;
    };
    for (i, index) in updates {
        mutate_element(&mut elements[i], |e| e.index = Some(index));
    }
}

/// `syncInvalidIndicesImmutable`: like `sync_invalid_indices`, returning new
/// element copies (bumped) instead of mutating.
pub fn sync_invalid_indices_immutable(elements: &[Element]) -> Vec<Element> {
    let groups = get_invalid_indices_groups(elements);
    let mut out = elements.to_vec();
    if let Ok(updates) = generate_indices(elements, groups) {
        for (i, index) in updates {
            out[i] = new_element_with(&elements[i], |e| e.index = Some(index), false);
        }
    }
    out
}

/// Contiguous groups of moved elements; each group starts with the lower
/// bound's position and ends with the upper bound's (`-1` / `len` past the ends).
fn get_moved_indices_groups(elements: &[Element], moved: &FxHashSet<String>) -> Vec<Vec<isize>> {
    let mut groups = vec![];
    let mut i = 0;
    while i < elements.len() {
        if moved.contains(&elements[i].id) {
            let mut group = vec![i as isize - 1, i as isize];
            i += 1;
            while i < elements.len() && moved.contains(&elements[i].id) {
                group.push(i as isize);
                i += 1;
            }
            group.push(i as isize);
            groups.push(group);
        } else {
            i += 1;
        }
    }
    groups
}

/// Groups of all invalid indices; first and last item of each are the found
/// lower and upper bounds (not necessarily adjacent).
fn get_invalid_indices_groups(elements: &[Element]) -> Vec<Vec<isize>> {
    let idx = |i: isize| -> Option<&str> {
        if i < 0 {
            None
        } else {
            elements.get(i as usize).and_then(|e| e.index.as_deref())
        }
    };
    let some = |s: Option<&str>| s.is_some_and(|s| !s.is_empty());
    let mut groups = vec![];
    // bounds only move forward, so cache them
    let mut lower_index: isize = -1;
    let mut upper_index: isize = 0;
    let get_lower = |i: isize, lower_index: isize| -> (Option<&str>, isize) {
        let lower = idx(lower_index);
        let candidate = idx(i - 1);
        if (!some(lower) && some(candidate))
            || (some(lower) && some(candidate) && candidate > lower)
        {
            return (candidate, i - 1);
        }
        (lower, lower_index)
    };
    let get_upper = |i: isize, upper_index: isize| -> (Option<&str>, isize) {
        let upper = idx(upper_index);
        if some(upper) && i < upper_index {
            return (upper, upper_index);
        }
        let mut j = upper_index;
        loop {
            j += 1;
            if j as usize >= elements.len() {
                break;
            }
            let candidate = idx(j);
            if (!some(upper) && some(candidate))
                || (some(upper) && some(candidate) && candidate > upper)
            {
                return (candidate, j);
            }
        }
        (None, j)
    };
    let n = elements.len() as isize;
    let mut i: isize = 0;
    while i < n {
        let (lower, li) = get_lower(i, lower_index);
        let (upper, ui) = get_upper(i, upper_index);
        (lower_index, upper_index) = (li, ui);
        if !is_valid_fractional_index(idx(i), lower, upper) {
            let mut group = vec![lower_index, i];
            loop {
                i += 1;
                if i >= n {
                    break;
                }
                let (nl, nli) = get_lower(i, lower_index);
                let (nu, nui) = get_upper(i, upper_index);
                if is_valid_fractional_index(idx(i), nl, nu) {
                    break;
                }
                // bounds move only for the elements in the group
                (lower_index, upper_index) = (nli, nui);
                group.push(i);
            }
            group.push(upper_index);
            groups.push(group);
        } else {
            i += 1;
        }
    }
    groups
}

fn is_valid_fractional_index(index: Option<&str>, pred: Option<&str>, succ: Option<&str>) -> bool {
    let Some(index) = index.filter(|s| !s.is_empty()) else {
        return false;
    };
    if validate_order_key(index).is_err() {
        return false;
    }
    let (pred, succ) = (
        pred.filter(|s| !s.is_empty()),
        succ.filter(|s| !s.is_empty()),
    );
    match (pred, succ) {
        (Some(p), Some(s)) => p < index && index < s,
        (None, Some(s)) => index < s,
        (Some(p), None) => p < index,
        (None, None) => true,
    }
}

/// New indices per element position, for each group (bounds first and last).
fn generate_indices(
    elements: &[Element],
    groups: Vec<Vec<isize>>,
) -> Result<Vec<(usize, String)>, String> {
    let at = |i: isize| -> Option<&str> {
        if i < 0 {
            None
        } else {
            elements
                .get(i as usize)
                .and_then(|e| e.index.as_deref())
                .filter(|s| !s.is_empty())
        }
    };
    // keyed by position: the last write wins, like the upstream Map
    let mut updates: FxHashMap<usize, String> = FxHashMap::default();
    for mut group in groups {
        let upper = group.pop().unwrap();
        let lower = group.remove(0);
        let keys = generate_n_keys_between(at(lower), at(upper), group.len())?;
        for (k, &i) in keys.into_iter().zip(&group) {
            updates.insert(i as usize, k);
        }
    }
    let mut updates: Vec<(usize, String)> = updates.into_iter().collect();
    updates.sort_unstable_by_key(|u| u.0);
    Ok(updates)
}
