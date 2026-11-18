// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Random ids and seeds. Port of Excalidraw `packages/common/src/random.ts`
//! @ 3a317b5, with roughjs's `Random` (the Park–Miller generator upstream
//! seeds with `Date.now()`) and nanoid's alphabet.
//!
//! State is per thread. Upstream tests run in a mode where ids are `id0`,
//! `id1`… and the generator is reseeded per test; `reseed` turns that mode on
//! for the calling thread (Rust tests run on parallel threads, so it can't be
//! global).

use std::cell::RefCell;
use std::hash::{BuildHasher, Hasher};

/// nanoid's url-safe alphabet.
const NANOID_ALPHABET: &[u8; 64] =
    b"useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const NANOID_SIZE: usize = 21;

struct State {
    /// roughjs `Random.seed`: an int32 after the first step.
    seed: i32,
    /// Some in test mode: the next `id{n}`.
    test_id: Option<u64>,
    /// Entropy for nanoid ids and for `Math.random()` (when seed is 0).
    entropy: u64,
}

fn entropy_seed() -> u64 {
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    h.finish() | 1
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new({
        let entropy = entropy_seed();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(1);
        State { seed: now as i32, test_id: None, entropy }
    });
}

/// splitmix64 step over the entropy word.
fn next_entropy(s: &mut State) -> u64 {
    s.entropy = s.entropy.wrapping_add(0x9e3779b97f4a7c15);
    let mut z = s.entropy;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

/// roughjs `Random.next()`: in [0, 1).
fn next(s: &mut State) -> f64 {
    if s.seed != 0 {
        s.seed = s.seed.wrapping_mul(48271);
        ((s.seed & 0x7fff_ffff) as f64) / 2f64.powi(31)
    } else {
        (next_entropy(s) >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// `randomInteger`: in [0, 2^31).
pub fn random_integer() -> i64 {
    STATE.with(|s| (next(&mut s.borrow_mut()) * 2f64.powi(31)).floor() as i64)
}

/// `reseed`: deterministic seeds from `seed`, and `id0`, `id1`… ids from
/// here on (upstream's test mode), on this thread.
pub fn reseed(seed: i64) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.seed = seed as i32;
        s.test_id = Some(0);
        s.entropy = seed as u64 | 1;
    })
}

/// Leaves test mode on this thread: nanoid ids and a time-seeded generator.
pub fn unseed() {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.test_id = None;
        s.entropy = entropy_seed();
        s.seed = (s.entropy >> 7) as i32;
    })
}

/// `randomId`: a 21-character nanoid, or `id{n}` in test mode.
pub fn random_id() -> String {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if let Some(n) = s.test_id {
            s.test_id = Some(n + 1);
            return format!("id{n}");
        }
        let mut out = String::with_capacity(NANOID_SIZE);
        let mut bits = 0u64;
        let mut left = 0;
        for _ in 0..NANOID_SIZE {
            if left < 6 {
                bits = next_entropy(&mut s);
                left = 64;
            }
            out.push(NANOID_ALPHABET[(bits & 63) as usize] as char);
            bits >>= 6;
            left -= 6;
        }
        out
    })
}

/// `seededRandom`: mulberry32 for a given seed, numbers in [0, 1). Used where
/// a render must be stable across frames (the sticky note's corner jitter).
pub fn seeded_random(seed: i64) -> impl FnMut() -> f64 {
    let mut value = seed as u32;
    move || {
        value = value.wrapping_add(0x6d2b79f5);
        let mut next = value;
        next = (next ^ (next >> 15)).wrapping_mul(next | 1);
        next ^= next.wrapping_add((next ^ (next >> 7)).wrapping_mul(next | 61));
        (next ^ (next >> 14)) as f64 / 4294967296.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn park_miller_matches_roughjs() {
        // roughjs: seed = Math.imul(48271, seed); ((2**31-1) & seed) / 2**31
        reseed(1);
        assert_eq!(random_integer(), 48271);
        assert_eq!(random_integer(), 182605793); // imul(48271, 48271) = 2330089441, & 0x7fffffff
        assert_eq!(random_id(), "id0");
        assert_eq!(random_id(), "id1");
        reseed(1);
        assert_eq!(random_id(), "id0");
        unseed();
        let id = random_id();
        assert_eq!(id.len(), 21);
        assert!(id.bytes().all(|b| NANOID_ALPHABET.contains(&b)));
    }

    #[test]
    fn mulberry32() {
        // reference values from the JS implementation
        assert_eq!(seeded_random(0)(), 0.26642920868471265);
    }
}
