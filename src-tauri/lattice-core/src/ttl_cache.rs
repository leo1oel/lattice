//! A small in-process cache whose entries expire, for literature answers that
//! are safe to replay: a DOI's record (a DOI names exactly one work) and an
//! upgrade check of one exact entry text. Title lookups are never cached here
//! — a title does not identify a work, which is why bibcite's own cache stays
//! off (`BIBCITE_NO_CACHE`).
//!
//! Every lookup it saves is one request less against the shared public
//! literature service's daily budget, so an Agent that retries a call, or a
//! batch it continues over several calls, does not pay for the same answer
//! twice.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How long a DOI's resolved record is replayed. Publishers rarely change a
/// registered record within a day, and a writer's correction goes through the
/// citation review, which edits the entry, not the record.
pub(crate) const DOI_RECORD_TTL: Duration = Duration::from_secs(24 * 3600);

pub(crate) struct TtlCache<V> {
    entries: Mutex<HashMap<String, (Instant, V)>>,
    limit: usize,
}

impl<V: Clone> TtlCache<V> {
    pub(crate) fn new(limit: usize) -> Self {
        Self { entries: Mutex::new(HashMap::new()), limit: limit.max(1) }
    }

    /// The live value under `key`; an expired one is dropped.
    pub(crate) fn get(&self, key: &str) -> Option<V> {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        match entries.get(key) {
            Some((expires, value)) if *expires > Instant::now() => Some(value.clone()),
            Some(_) => {
                entries.remove(key);
                None
            }
            None => None,
        }
    }

    /// Keep `value` for `ttl`. At the limit, expired entries go first, then
    /// the one closest to expiring.
    pub(crate) fn insert(&self, key: String, value: V, ttl: Duration) {
        let now = Instant::now();
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if entries.len() >= self.limit && !entries.contains_key(&key) {
            entries.retain(|_, (expires, _)| *expires > now);
            if entries.len() >= self.limit {
                let soonest = entries
                    .iter()
                    .min_by_key(|(_, (expires, _))| *expires)
                    .map(|(key, _)| key.clone());
                if let Some(soonest) = soonest {
                    entries.remove(&soonest);
                }
            }
        }
        entries.insert(key, (now + ttl, value));
    }

    #[cfg(all(test, unix))]
    pub(crate) fn clear(&self) {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_expire_and_the_limit_evicts_the_soonest_to_expire() {
        let cache = TtlCache::new(2);
        cache.insert("gone".into(), 1, Duration::ZERO);
        assert_eq!(cache.get("gone"), None);
        cache.insert("short".into(), 2, Duration::from_secs(60));
        cache.insert("long".into(), 3, Duration::from_secs(3600));
        cache.insert("new".into(), 4, Duration::from_secs(600));
        assert_eq!(cache.get("short"), None);
        assert_eq!((cache.get("long"), cache.get("new")), (Some(3), Some(4)));
        // Replacing a present key never evicts another.
        cache.insert("new".into(), 5, Duration::from_secs(600));
        assert_eq!((cache.get("long"), cache.get("new")), (Some(3), Some(5)));
    }
}
