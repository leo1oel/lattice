//! The last step of a sync: sending what it has for Overleaf.
//!
//! Each file Overleaf holds as a document takes its edit over the live
//! channel, as operations Overleaf transforms against anything a co-author
//! types meanwhile (see `doc_push`). The rest are uploaded: new files, binary
//! files, and everything when the live channel cannot be reached.

use super::super::api::{folders_above, send as request, HistoryVersion, Remote};
use super::super::doc_push::{may_become_a_file, LiveDocs, LivePush};
use super::super::upload::Uploader;
use crate::util::{sha256_hex, url_encode};
use crate::wide_event;
use reqwest::blocking::Client;
use reqwest::Method;
use serde_json::Value;
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

    // Whatever is not checked file by file goes only while the project holds
    // still: the project's history version is all there is to tell by
    // whether Overleaf moved past the copy we planned against, and anyone's
    // edit anywhere moves it. It is read before anything of this sync goes
    // up, so our own uploads cannot move it. A document going over the live
    // channel needs none of this: it is checked against the copy planned
    // against on its own, and what lands after that is transformed, not
    // replaced.
    let unsent = !documents.is_empty() || !uploads.is_empty();
    let seen = version_before.filter(|_| unsent).and_then(|_| linked.history_version(client));
    let moved = version_before.is_some() && seen.map(HistoryVersion::value) != version_before;
    // Only a counted version names the steps a file's history is read by; a
    // timestamp leaves documents to that one check, as for everything else.
    match version_before.filter(|_| matches!(seen, Some(HistoryVersion::Counted(_)))) {
        Some(base) if !documents.is_empty() => {
            let csrf = csrf.ok_or("Overleaf's upload token was not fetched.")?;
            let uploader = linked.uploader(client, csrf)?;
            for (path, bytes) in documents {
                upload_checked(linked, client, &uploader, base, path, bytes, &mut outcome)?;
            }
        }
        _ => uploads.extend(documents),
    }
    if moved && !uploads.is_empty() {
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

/// Whether `path` is text Overleaf holds already, by its name one an upload
/// keeps as a document, so a co-author may be typing in it in the web editor
/// while it goes up.
fn is_document(held: &BTreeMap<String, Vec<u8>>, path: &str, bytes: &[u8]) -> bool {
    let text = |bytes: &[u8]| std::str::from_utf8(bytes).is_ok();
    !may_become_a_file(path) && text(bytes) && held.get(path).is_some_and(|theirs| text(theirs))
}

/// The most version steps one upload's after-check reads before it gives
/// up and names the document anyway, rather than walk a busy project's
/// history on every sync.
const MAX_STEPS: i64 = 10;

/// Upload document `path`, checked against its own history in Overleaf
/// just before and just after; `base` is the version of the copy planned
/// against.
///
/// An upload replaces the whole document, so whatever a co-author typed
/// since the copy we planned against would be gone from it (Overleaf's
/// history still has it) and Overleaf would warn them their document was
/// "updated externally". So it goes only while its history shows no edit
/// since `base`; otherwise it stands down, a local edit the next sync merges
/// with their work before sending. Edits elsewhere in the project do not
/// hold it back. That narrows the window to the upload itself. An edit that
/// landed during the upload cannot be undone; the document is named in
/// `over_edits` so the writer can check it against Overleaf's history.
///
/// This is the upload only for want of the live channel, where a failure to
/// send one document fails the sync rather than uploading it (see
/// `LiveDocs::push`). Standing documents down until the channel returns
/// would keep anyone behind a network that blocks it from ever sending an
/// edit; checking each one keeps the window to one request. A failed upload
/// still fails the sync, as there.
fn upload_checked(
    linked: &Remote, client: &Client, uploader: &Uploader, base: i64, path: String, bytes: Vec<u8>,
    outcome: &mut Sent,
) -> Result<(), String> {
    let version = || match linked.history_version(client) {
        Some(HistoryVersion::Counted(version)) => Some(version),
        _ => None,
    };
    // An unchanged version is a project nobody touched; an unreadable
    // version or history tells nothing, so the document waits.
    let before = version().filter(|&pre| {
        pre == base || edits(linked, client, &path, base, pre).is_some_and(|edits| !edits.any)
    });
    let Some(pre) = before else {
        outcome.stood_down.insert(path);
        return Ok(());
    };
    uploader.upload(&path, bytes.clone())?;
    // Text inserted and then deleted within one diff's range leaves no trace
    // in it (project-history DiffGenerator.js L171-240), and our upload
    // deletes whatever it replaced, so each step is read on its own.
    let by_others = match version() {
        Some(post) if post - pre <= MAX_STEPS => (pre..post).any(|step| {
            edits(linked, client, &path, step, step + 1).is_none_or(|edits| edits.by_others)
        }),
        _ => true,
    };
    if by_others {
        outcome.over_edits.push(path.clone());
    }
    outcome.sent.insert(path, bytes);
    Ok(())
}

/// Who changed a document's text between two history versions.
struct Edits {
    /// Anyone inserted or deleted text.
    any: bool,
    /// Someone other than this account did, or someone history cannot name.
    by_others: bool,
}

/// The edits to `path` from version `from` to `to`, from Overleaf's diff of
/// that one file; `None` when it could not be read.
///
/// `GET /project/{id}/diff?pathname=&from=&to=` (web HistoryRouter.mjs
/// L66-71) flushes the file's queued updates first (project-history
/// DiffManager.js L21-56) and answers `{"diff": parts}`, each part `{u}`
/// unchanged, `{i}` inserted or `{d}` deleted text, the last two with
/// `meta.users`; a file entity answers `{"diff": {"binary": true}}`, text no
/// one can type in. Parts by different users never merge (DiffGenerator.js
/// L44-55). The web layer swaps each user id for `{id, email, ...}`, and one
/// it cannot find for `null` (HistoryManager.mjs injectUserDetails).
fn edits(linked: &Remote, client: &Client, path: &str, from: i64, to: i64) -> Option<Edits> {
    let query = format!("/diff?pathname={}&from={from}&to={to}", url_encode(path));
    wide_event::add("http_requests", 1);
    let response = request(linked.request(client, Method::GET, &query, None)).ok()?;
    let body = response.error_for_status().ok()?.json::<Value>().ok()?;
    let diff = body.get("diff")?;
    if diff.get("binary").and_then(Value::as_bool) == Some(true) {
        return Some(Edits { any: false, by_others: false });
    }
    let me = linked.session.user_id.as_deref();
    fn user(user: &Value) -> Option<&str> {
        user.as_str().or_else(|| user.get("id")?.as_str())
    }
    let edited = (diff.as_array()?.iter()).filter(|part| part.get("i").or(part.get("d")).is_some());
    let mut edits = Edits { any: false, by_others: false };
    for part in edited {
        edits.any = true;
        let users = part.pointer("/meta/users").and_then(Value::as_array);
        let others = users.is_none_or(|users| {
            users.is_empty() || users.iter().any(|someone| me.is_none() || user(someone) != me)
        });
        edits.by_others |= others;
    }
    Some(edits)
}
