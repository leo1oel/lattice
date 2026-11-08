//! The last step of a sync: sending what it has for Overleaf.
//!
//! Each file Overleaf holds as a document takes its edit over the live
//! channel, as operations Overleaf transforms against anything a co-author
//! types meanwhile (see `doc_push`). The rest are uploaded: new files, binary
//! files, and everything when the live channel cannot be reached.

use super::super::api::{folders_above, HistoryVersion, Remote};
use super::super::doc_push::{LiveDocs, LivePush};
use super::super::upload::Uploader;
use crate::util::sha256_hex;
use crate::wide_event;
use reqwest::blocking::Client;
use std::collections::{BTreeMap, BTreeSet};

/// What became of the files a sync had for Overleaf.
#[derive(Default)]
pub(super) struct Sent {
    /// Now on Overleaf, with what went up for each.
    pub sent: BTreeMap<String, Vec<u8>>,
    /// Held back because Overleaf moved on after the copy the sync planned
    /// against. Each stays a local edit for the next sync to merge and send.
    pub stood_down: BTreeSet<String>,
    /// Of `sent`, documents uploaded whole while someone else's edit reached
    /// the project, so the upload may have replaced what they had just typed.
    pub over_edits: Vec<String>,
}

impl Sent {
    /// Record each file that stood down as a local edit on the copy it was
    /// planned against (a merge's, the copy it merged with), so the next sync
    /// merges in only what Overleaf did since. A new file has no such copy.
    pub fn keep_planned_copies(
        &self, held: &BTreeMap<String, Vec<u8>>, files: &mut BTreeMap<String, String>,
    ) {
        for path in &self.stood_down {
            match held.get(path) {
                Some(bytes) => files.insert(path.clone(), sha256_hex(bytes)),
                None => files.remove(path),
            };
        }
    }
}

/// Send `files` to Overleaf. `held` is Overleaf's copy the sync planned
/// against, read at history version `version_before` when that is known.
pub(super) fn send(
    linked: &Remote, client: &Client, csrf: Option<&str>, held: &BTreeMap<String, Vec<u8>>,
    files: BTreeMap<String, Vec<u8>>, version_before: Option<i64>,
) -> Result<Sent, String> {
    let mut outcome = Sent::default();
    if files.is_empty() {
        return Ok(outcome);
    }
    wide_event::record("upload_bytes", files.values().map(Vec::len).sum::<usize>());
    let step = wide_event::step("upload");
    let live = LiveDocs::open(linked, &files, held);
    let (live_files, uploads): (BTreeMap<_, _>, BTreeMap<_, _>) =
        files.into_iter().partition(|(path, _)| live.as_ref().is_some_and(|live| live.takes(path)));
    // Documents Overleaf already holds that still go up whole: all of them
    // when the live channel cannot be reached (a network or proxy that blocks
    // WebSockets), and the odd edit the channel would not carry exactly.
    let (documents, mut uploads): (BTreeMap<_, _>, BTreeMap<_, _>) =
        uploads.into_iter().partition(|(path, bytes)| is_document(held, path, bytes));

    let mut history = History { linked, client, base: version_before, own: 0 };
    if !documents.is_empty() {
        let csrf = csrf.ok_or("Overleaf's upload token was not fetched.")?;
        let uploader = linked.uploader(client, csrf)?;
        history.upload_each(&uploader, documents, &mut outcome)?;
    }

    // A new or binary file nobody can be typing in, but the project's
    // history version is all there is to tell by whether Overleaf moved past
    // the copy we planned against, and anyone's edit anywhere moves it; so
    // these too go only while it holds still. A document going over the live
    // channel needs none of this: it is checked against the copy planned
    // against on its own, and what lands after that is transformed, not
    // replaced.
    if !uploads.is_empty()
        && history.base.is_some()
        && !history.holds_at(linked.history_version(client))
    {
        outcome.stood_down.extend(std::mem::take(&mut uploads).into_keys());
    }
    if !uploads.is_empty() {
        let csrf = csrf.ok_or("Overleaf's upload token was not fetched.")?;
        // Overleaf has every folder that holds a file of its copy.
        let folders = (held.keys()).flat_map(|path| folders_above(path)).map(str::to_string);
        linked.uploader(client, csrf)?.upload_all(&uploads, &folders.collect())?;
        outcome.sent.append(&mut uploads);
    }
    if !outcome.stood_down.is_empty() {
        wide_event::record("stood_down", outcome.stood_down.len());
    }
    if let Some(live) = live {
        let LivePush { sent, stale } = live.push(&live_files, held)?;
        outcome.stood_down.extend(stale);
        outcome.sent.extend(live_files.into_iter().filter(|(path, _)| sent.contains(path)));
    }
    drop(step);
    Ok(outcome)
}

/// Whether `path` is text Overleaf holds already, so a co-author may be
/// typing in it in the web editor while it goes up.
fn is_document(held: &BTreeMap<String, Vec<u8>>, path: &str, bytes: &[u8]) -> bool {
    let text = |bytes: &[u8]| std::str::from_utf8(bytes).is_ok();
    text(bytes) && held.get(path).is_some_and(|theirs| text(theirs))
}

/// Where the project's history version may stand while only this sync
/// writes to it.
struct History<'a> {
    linked: &'a Remote,
    client: &'a Client,
    /// The version of the copy the sync planned against.
    base: Option<i64>,
    /// Uploads this sync has made so far.
    own: i64,
}

impl History<'_> {
    /// Whether `seen` could be the project with nothing in it but the copy
    /// planned against and our own uploads since.
    ///
    /// Each upload moves a counted version by one. Overleaf may report that
    /// a little late, so seeing fewer of our uploads than we made is fine;
    /// seeing more than we made is someone else's edit. A timestamp moves
    /// for our upload as for anyone's, so it tells only until our first
    /// upload; after that it holds, as no read can say otherwise. An
    /// unreadable version tells nothing, so it never counts as holding still.
    fn holds_at(&self, seen: Option<HistoryVersion>) -> bool {
        match (self.base, seen) {
            (Some(base), Some(HistoryVersion::Counted(seen))) => {
                (base..=base + self.own).contains(&seen)
            }
            (Some(base), Some(HistoryVersion::Stamped(seen))) => self.own > 0 || seen == base,
            _ => false,
        }
    }

    /// Upload each of `documents` on its own, between two reads of the
    /// project's version.
    ///
    /// An upload replaces the whole document, so whatever a co-author typed
    /// since the copy we planned against would be gone from it (Overleaf's
    /// history still has it) and Overleaf would warn them their document was
    /// "updated externally". So each goes only while the version still holds:
    /// once it has moved, this and every later document stands down, a local
    /// edit the next sync merges with their work before sending. That
    /// narrows the window to the upload itself. A version that moved during
    /// an upload cannot be undone; the document is named in `over_edits` so
    /// the writer can check it against Overleaf's history.
    ///
    /// This is the upload only for want of the live channel, where a failure
    /// to send one document fails the sync rather than uploading it (see
    /// `LiveDocs::push`). Standing documents down here until the channel
    /// returns would keep anyone behind a network that blocks it from ever
    /// sending an edit; checking each one keeps the window to one request.
    /// A failed upload still fails the sync, as there.
    fn upload_each(
        &mut self, uploader: &Uploader, documents: BTreeMap<String, Vec<u8>>, outcome: &mut Sent,
    ) -> Result<(), String> {
        let mut seen = self.linked.history_version(self.client);
        // Not knowing where the planned copy stood, the first read is the
        // best line to hold to: it at least catches edits from here on.
        self.base = self.base.or(seen.map(HistoryVersion::value));
        let mut documents = documents.into_iter();
        for (path, bytes) in documents.by_ref() {
            if self.base.is_some() && !self.holds_at(seen) {
                outcome.stood_down.insert(path);
                break;
            }
            uploader.upload(&path, bytes.clone())?;
            self.own += 1;
            seen = self.linked.history_version(self.client);
            if self.base.is_some() && seen.is_some() && !self.holds_at(seen) {
                outcome.over_edits.push(path.clone());
            }
            outcome.sent.insert(path, bytes);
        }
        outcome.stood_down.extend(documents.map(|(path, _)| path));
        Ok(())
    }
}
