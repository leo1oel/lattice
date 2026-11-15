//! The review queue (`bibliography-audit.tsx`, `reference-check-keys.ts`):
//! the references in the order the list shows them, what the writer walks
//! with J and K, and where Skip, the "N of M" stepper, Apply and Keep mine
//! move on to. Wide (800px and more, `queueWidth`), the list stands beside
//! the finding it has open, which opens on the first finding to act on
//! unless nothing is left to act on; narrower, a finding unfolds under its
//! row and nothing is open until the writer opens one.
//!
//! The keys are bound in the sheet's own key context, so focus elsewhere
//! (another surface, a field) never reaches them: J and K walk the list, A
//! or ⌘↩ applies the open fix and moves to the next finding, S skips to it.

use gpui::{Context, KeyBinding, actions};

use super::{Audit, Bucket, FixGroup};

actions!(
    check_references,
    [
        /// The next reference in the list (J).
        NextReference,
        /// The previous reference in the list (K).
        PreviousReference,
        /// Apply the open fix and move to the next finding (A).
        ApplyFix,
        /// The same, on ⌘↩.
        ApplyFixChord,
        /// Skip to the next finding (S).
        SkipFinding,
    ]
);

/// The sheet's key context, which its keys are bound in.
pub const KEY_CONTEXT: &str = "CheckReferences";

/// The queue's keys (`REFERENCE_CHECK_SHORTCUTS`), where the sheet has the
/// keyboard.
pub fn bindings() -> Vec<KeyBinding> {
    let chord = if cfg!(target_os = "macos") {
        "cmd-enter"
    } else {
        "ctrl-enter"
    };
    vec![
        KeyBinding::new("j", NextReference, Some(KEY_CONTEXT)),
        KeyBinding::new("k", PreviousReference, Some(KEY_CONTEXT)),
        KeyBinding::new("a", ApplyFix, Some(KEY_CONTEXT)),
        KeyBinding::new(chord, ApplyFixChord, Some(KEY_CONTEXT)),
        KeyBinding::new("s", SkipFinding, Some(KEY_CONTEXT)),
    ]
}

/// The findings J, K and S walk through, and Apply or Keep mine finishes.
fn actionable(bucket: Bucket) -> bool {
    matches!(bucket, Bucket::Fix | Bucket::Review)
}

/// The references in the order the list shows them, and what each asks of
/// the writer.
#[derive(Clone, Debug, Default)]
pub struct Listing {
    /// Every reference's bucket, by index.
    pub buckets: Vec<Bucket>,
    /// How many references each bucket holds, in `Bucket::ORDER`.
    pub counts: Vec<(Bucket, usize)>,
    /// The filter shown: the writer's, unless its bucket emptied
    /// (`shownView`).
    pub view: Option<Bucket>,
    /// The references shown, bucket by bucket; fixes Apply all takes come
    /// first among the fixes, a disputed one last.
    pub shown: Vec<usize>,
}

impl Listing {
    pub fn new(
        buckets: Vec<Bucket>,
        group: impl Fn(usize) -> Option<FixGroup>,
        view: Option<Bucket>,
    ) -> Self {
        let counts: Vec<(Bucket, usize)> = Bucket::ORDER
            .iter()
            .map(|bucket| {
                (
                    *bucket,
                    buckets.iter().filter(|each| *each == bucket).count(),
                )
            })
            .collect();
        // A filter whose last finding was resolved falls back to everything;
        // the writer's choice stays, for when its findings come back.
        let view = view.filter(|view| {
            counts
                .iter()
                .any(|(bucket, count)| bucket == view && *count > 0)
        });
        let shown = Bucket::ORDER
            .iter()
            .filter(|bucket| view.is_none_or(|view| view == **bucket))
            .flat_map(|bucket| {
                let mut indexes: Vec<usize> = (0..buckets.len())
                    .filter(|index| buckets[*index] == *bucket)
                    .collect();
                if *bucket == Bucket::Fix {
                    indexes.sort_by_key(|index| group(*index));
                }
                indexes
            })
            .collect();
        Self {
            buckets,
            counts,
            view,
            shown,
        }
    }

    pub fn count(&self, bucket: Bucket) -> usize {
        self.counts
            .iter()
            .find(|(each, _)| *each == bucket)
            .map_or(0, |(_, count)| *count)
    }

    fn position(&self, index: usize) -> Option<usize> {
        self.shown.iter().position(|shown| *shown == index)
    }

    /// Nothing left to act on, with nothing running: the queue opens on the
    /// finished report, not a verified row.
    pub fn settled(&self, busy: bool) -> bool {
        !busy
            && !self.buckets.is_empty()
            && [
                Bucket::Fix,
                Bucket::Review,
                Bucket::Incomplete,
                Bucket::Unchecked,
            ]
            .iter()
            .all(|bucket| self.count(*bucket) == 0)
    }

    /// The finding open: the one the writer opened while it is shown, else
    /// in the queue the first to act on (or the first shown) unless the
    /// report is settled.
    pub fn current(&self, open: Option<usize>, queue: bool, busy: bool) -> Option<usize> {
        if let Some(open) = open.filter(|open| self.shown.contains(open)) {
            return Some(open);
        }
        if !queue || self.settled(busy) {
            return None;
        }
        self.shown
            .iter()
            .copied()
            .find(|index| actionable(self.buckets[*index]))
            .or_else(|| self.shown.first().copied())
    }

    /// The next finding to act on after `index`, in the list's order, else
    /// the first one left (`nextAfter`).
    pub fn next_after(&self, index: usize) -> Option<usize> {
        let position = self.position(index);
        let rest = || {
            self.shown
                .iter()
                .enumerate()
                .filter(|(_, other)| **other != index && actionable(self.buckets[**other]))
        };
        rest()
            .find(|(at, _)| position.is_some_and(|position| *at > position))
            .or_else(|| rest().next())
            .map(|(_, other)| *other)
    }

    /// Where `index` sits among the shown references like it, 1-based, and
    /// how many there are; none when it is the only one (`step`).
    pub fn step(&self, index: usize) -> Option<(usize, usize)> {
        let bucket = *self.buckets.get(index)?;
        let peers: Vec<usize> = self
            .shown
            .iter()
            .copied()
            .filter(|other| self.buckets[*other] == bucket)
            .collect();
        let position = peers.iter().position(|peer| *peer == index)? + 1;
        (peers.len() > 1).then_some((position, peers.len()))
    }

    /// J's or K's reference from `current`: the next or previous one shown,
    /// staying at the ends; the first (or, going back, still the first)
    /// when nothing is open.
    pub fn walk(&self, current: Option<usize>, forward: bool) -> Option<usize> {
        let last = self.shown.len().checked_sub(1)?;
        let at = match current.and_then(|current| self.position(current)) {
            Some(at) if forward => (at + 1).min(last),
            Some(at) => at.saturating_sub(1),
            None => 0,
        };
        self.shown.get(at).copied()
    }
}

impl Audit {
    /// The references as the list shows them now.
    pub(super) fn listing(&self) -> Listing {
        let buckets = (0..self.entries.len())
            .map(|index| self.bucket(index))
            .collect();
        Listing::new(
            buckets,
            |index| {
                self.results
                    .get(&index)
                    .map(|result| super::fix_group(&result.changes))
            },
            self.view,
        )
    }

    /// The finding open in the queue's pane or under its row.
    pub(super) fn current(&self, listing: &Listing) -> Option<usize> {
        listing.current(self.open, self.queue, self.busy)
    }

    /// Open `index` (or close the open finding), keeping its row in view
    /// (`openFinding`).
    pub(super) fn open_finding(&mut self, index: Option<usize>, cx: &mut Context<Self>) {
        // Another finding opening folds the last one's disclosures, as its
        // details unmount.
        if index != self.current(&self.listing()) {
            self.move_disclosed(None, None);
        }
        self.open = index;
        self.reveal = index;
        cx.notify();
    }

    /// Whether Apply can write `index`'s fix now (`canApply`).
    pub(super) fn can_apply(&self, index: usize) -> bool {
        self.bucket(index) == Bucket::Fix
            && self
                .entries
                .get(index)
                .is_some_and(|entry| entry.inline.is_none())
            && self
                .results
                .get(&index)
                .is_some_and(|result| result.after.is_some())
            && !self.busy
            && !self.applying
            && !self.loading
    }

    /// Apply one fix, then move on to the next finding
    /// (`applyAndAdvance`).
    pub(super) fn apply_and_advance(&mut self, index: usize, cx: &mut Context<Self>) {
        if !self.can_apply(index) {
            return;
        }
        let next = self.listing().next_after(index);
        self.apply_then(vec![index], Some(next), cx);
    }

    fn walk(&mut self, forward: bool, cx: &mut Context<Self>) {
        let listing = self.listing();
        if let Some(next) = listing.walk(self.current(&listing), forward) {
            self.open_finding(Some(next), cx);
        }
    }

    pub(super) fn next_reference(
        &mut self,
        _: &NextReference,
        _: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) {
        self.walk(true, cx);
    }

    pub(super) fn previous_reference(
        &mut self,
        _: &PreviousReference,
        _: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) {
        self.walk(false, cx);
    }

    pub(super) fn skip_finding(
        &mut self,
        _: &SkipFinding,
        _: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) {
        let listing = self.listing();
        if let Some(current) = self.current(&listing) {
            let next = listing.next_after(current);
            self.open_finding(next, cx);
        }
    }

    fn apply_open(&mut self, cx: &mut Context<Self>) {
        let listing = self.listing();
        if let Some(current) = self.current(&listing) {
            self.apply_and_advance(current, cx);
        }
    }

    pub(super) fn apply_fix(&mut self, _: &ApplyFix, _: &mut gpui::Window, cx: &mut Context<Self>) {
        self.apply_open(cx);
    }

    pub(super) fn apply_fix_chord(
        &mut self,
        _: &ApplyFixChord,
        _: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) {
        self.apply_open(cx);
    }
}

/// The queue as a scenario reads and fills it.
#[cfg(any(target_os = "macos", target_os = "windows"))]
impl Audit {
    /// Give each reference `finding` answers for the finding a check would
    /// have: the queue's steps run offline.
    pub fn seed(
        &mut self,
        finding: impl Fn(&lattice_core::citation_audit::AuditEntry) -> Option<super::Finding>,
        cx: &mut Context<Self>,
    ) {
        for (index, entry) in self.entries.iter().enumerate() {
            if let Some(found) = finding(entry) {
                self.results.insert(index, found);
            }
        }
        cx.notify();
    }

    /// The citation key of the finding open, and whether the list stands
    /// beside it as the queue.
    pub fn open_key(&self) -> (Option<String>, bool) {
        let current = self.current(&self.listing());
        (
            current.map(|index| self.entries[index].key.clone()),
            self.queue,
        )
    }
}

#[cfg(test)]
mod tests;
