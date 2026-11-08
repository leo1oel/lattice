//! The last step of a sync: sending what it has for Overleaf.
//!
//! Each file Overleaf holds as a document takes its edit over the live
//! channel, as operations Overleaf transforms against anything a co-author
//! types meanwhile (see `doc_push`). The rest are uploaded: new files, binary
//! files, and everything when the live channel cannot be reached.

use super::super::api::{folders_above, Remote};
use super::super::doc_push::{LiveDocs, LivePush};
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
    let (live_files, mut uploads): (BTreeMap<_, _>, BTreeMap<_, _>) =
        files.into_iter().partition(|(path, _)| live.as_ref().is_some_and(|live| live.takes(path)));

    // An upload replaces the whole file, so it may only go while Overleaf
    // holds still: had someone typed in the web editor since the copy we
    // planned against, it would replace what they just wrote (and make
    // Overleaf warn them their recent changes may have been overwritten).
    // Standing down leaves each a local edit, so the next sync merges their
    // work first and sends the combined result. The project's history
    // version is all there is to tell by, and anyone's edit anywhere moves
    // it. A document going over the live channel needs none of this: it is
    // checked against the copy planned against on its own, and what lands
    // after that is transformed, not replaced.
    if !uploads.is_empty() && version_before.is_some() && linked.version(client) != version_before {
        wide_event::record("stood_down", uploads.len());
        outcome.stood_down.extend(std::mem::take(&mut uploads).into_keys());
    }
    if !uploads.is_empty() {
        let csrf = csrf.ok_or("Overleaf's upload token was not fetched.")?;
        // Overleaf has every folder that holds a file of its copy.
        let folders = (held.keys()).flat_map(|path| folders_above(path)).map(str::to_string);
        linked.uploader(client, csrf)?.upload_all(&uploads, &folders.collect())?;
        outcome.sent.append(&mut uploads);
    }
    if let Some(live) = live {
        let LivePush { sent, stale } = live.push(&live_files, held)?;
        outcome.stood_down.extend(stale);
        outcome.sent.extend(live_files.into_iter().filter(|(path, _)| sent.contains(path)));
    }
    drop(step);
    Ok(outcome)
}
