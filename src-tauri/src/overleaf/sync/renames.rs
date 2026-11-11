//! Renames a co-author makes on Overleaf, carried here (audit F5).
//!
//! A sync compares files by path, so a file renamed on Overleaf reads as one
//! deleted there and one new. While the copy here is unchanged that comes out
//! right: the old name goes, the new one arrives. But with an edit here, an
//! agent's say, the old name read as "deleted there after edits here" and
//! went back up as a fresh upload, beside a renamed file without the edit:
//! one paper split across two files, with nothing said.
//!
//! So an edited file Overleaf no longer has is weighed against Overleaf's
//! history. Where that shows one plain rename of it, or of a folder above it,
//! to a path new on Overleaf and free here, and nothing else touching either
//! name, the file and its merge base move there and the plan merges the edit
//! into the renamed file exactly as it would at one path. Where it shows no
//! rename of it at all, the file was removed, and the edit goes back up as it
//! always has. Anything else, a history that cannot be read, a chain of
//! renames, a rename onto a name reused or spelled like another here, is not
//! guessed at: that file is held, neither sent nor deleted, on its agreed
//! copy, and the result names it, while everything else syncs.
//!
//! A rename in letter case only reads, on a disk that ignores case, as the
//! file deleted and the same file pulled, which would delete the only copy.
//! An unchanged file renamed so is carried without the history, through a
//! temporary name, folders included; the history is only needed to place an
//! edit, and an unchanged file takes Overleaf's text either way.

use super::history_evidence::agreed_copy;
use super::relocations::relocated_path;
use super::{since_read, OverleafSyncResult, SinceRead, SyncPlan, Unsettled};
use crate::overleaf::api::{json_str, Remote};
use crate::overleaf::files::{disk_path, read_base_copy, remove_base_copy, write_base_copy};
use crate::overleaf::link::SyncState;
use crate::overleaf::review::{history_since, HistoryFrom, HistoryUpdate};
use crate::project_fs::ProjectDir;
use crate::util::sha256_hex;
use crate::wide_event;
use reqwest::blocking::Client;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// What a sync does about renames on Overleaf (see [`remote_renames`]).
#[derive(Debug, Default)]
pub(super) struct Renames {
    /// Each new path a file is carried to, and the agreed path it left.
    pub carried: BTreeMap<String, String>,
    /// Edited files gone from Overleaf that this sync holds as they are, each
    /// with where the agreed copy stood when its hold began.
    pub held: BTreeMap<String, Option<HistoryFrom>>,
    /// Paths new on Overleaf left unpulled, so a held file can still be
    /// carried to one: pulled, it would be agreed and no longer new.
    pub waiting: BTreeSet<String>,
}

impl Renames {
    /// `SyncState::unsettled` for the paths where the table now differs from
    /// Overleaf's copy, given those the next sync fetches again anyway. A
    /// path left waiting is fetched again too, and a held file keeps where
    /// its hold began, so the next sync still reads the rename however far
    /// the agreed version moves. Anything else takes a download, which the
    /// record says by its absence unless a hold's window must be kept.
    pub fn unsettled(
        &self, differs: &BTreeSet<String>, fetched: impl Fn(&String) -> bool,
    ) -> Option<BTreeMap<String, Unsettled>> {
        let why = |path: &String| match self.held.get(path) {
            Some(since) => Unsettled::Held(*since),
            None if fetched(path) || self.waiting.contains(path) => Unsettled::Fetch,
            None => Unsettled::Download,
        };
        let record: BTreeMap<String, Unsettled> =
            differs.iter().map(|path| (path.clone(), why(path))).collect();
        let exact = record.values().all(|why| *why != Unsettled::Download);
        (exact || !self.held.is_empty()).then_some(record)
    }
}

/// One tree operation in Overleaf's history.
enum TreeOp {
    Rename(String, String),
    Add(String),
    Other(String),
}

/// Whether `named` is `path` or a folder above it.
fn covers(named: &str, path: &str) -> bool {
    !named.is_empty() && relocated_path(path, named, named).is_some()
}

impl TreeOp {
    /// Whether this operation touches `path`, at either end of a rename.
    fn names(&self, path: &str) -> bool {
        match self {
            TreeOp::Rename(from, to) => covers(from, path) || covers(to, path),
            TreeOp::Add(named) | TreeOp::Other(named) => covers(named, path),
        }
    }
}

/// One tree operation as Overleaf's history placed it.
struct Placed<'a> {
    op: TreeOp,
    /// The version it was made at, if Overleaf said.
    at: Option<i64>,
    update: &'a HistoryUpdate,
}

impl Placed<'_> {
    /// Whether this operation is missing from a copy taken at `from`.
    ///
    /// Overleaf groups a co-author's consecutive changes into one update,
    /// which can start before the copy's version and end after it: only the
    /// operations made from that version on count.
    fn after(&self, from: Option<HistoryFrom>) -> bool {
        match from {
            Some(HistoryFrom::Version(version)) => {
                self.update.ends_after(version) && self.at.is_none_or(|at| at >= version)
            }
            _ => self.update.after(from),
        }
    }
}

/// Overleaf's history back to the earliest of `windows`, as far as any of
/// them is missing an update.
fn history_from(
    remote: &Remote, client: &Client, windows: &[Option<HistoryFrom>],
) -> Result<Vec<HistoryUpdate>, String> {
    let reaches = |update: &HistoryUpdate, from: Option<HistoryFrom>| match from {
        Some(HistoryFrom::Version(version)) => update.ends_after(version),
        _ => update.after(from),
    };
    history_since(remote, client, |update| windows.iter().any(|from| reaches(update, *from)))
}

/// Every tree operation in `history`, oldest first. A folder's operation
/// names only the folder.
fn tree_ops(history: &[HistoryUpdate]) -> Vec<Placed<'_>> {
    let at = |op: &Value| op.get("atV").and_then(Value::as_i64);
    let mut ops = Vec::new();
    // Overleaf lists updates newest first; within one, each operation says
    // the version it was made at.
    for update in history.iter().rev() {
        let mut listed: Vec<&Value> = update.ops.iter().collect();
        listed.sort_by_key(|op| at(op));
        for op in listed {
            let field =
                |kind: &str, key: &str| op.get(kind).and_then(|body| json_str(body, &[key]));
            let tree = if let Some(path) = field("rename", "pathname") {
                TreeOp::Rename(path, field("rename", "newPathname").unwrap_or_default())
            } else if let Some(path) = field("add", "pathname") {
                TreeOp::Add(path)
            } else if let Some(path) = field("remove", "pathname") {
                TreeOp::Other(path)
            } else {
                continue;
            };
            ops.push(Placed { op: tree, at: at(op), update });
        }
    }
    ops
}

/// Where `ops` renamed `path`, when that is plain: exactly one operation
/// touches `path`, a rename of it or of a folder above it, and no other
/// touches where it went.
fn direct_rename(path: &str, ops: &[&TreeOp]) -> Option<String> {
    let mut naming = ops.iter().filter(|op| op.names(path));
    let (Some(TreeOp::Rename(from, to)), None) = (naming.next(), naming.next()) else {
        return None;
    };
    let target = relocated_path(path, from, to).filter(|_| !to.is_empty())?;
    (ops.iter().filter(|op| op.names(&target)).count() == 1).then_some(target)
}

/// The folders of `path`, without the file name.
fn folders(path: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = path.split('/').collect();
    parts.pop();
    parts
}

/// Whether `to` has a spelling of its own among `keys` besides `from`: no
/// other path is spelled like it but for letter case, and no folder on its
/// way is spelled like a different one here. A disk that ignores case takes
/// either for the same entry, so a move there would land elsewhere.
fn free_here<'a>(to: &str, from: &str, mut keys: impl Iterator<Item = &'a String>) -> bool {
    let (lower, to_folders) = (to.to_lowercase(), folders(to));
    keys.all(|key| {
        if key == from {
            return true;
        }
        if key.to_lowercase() == lower {
            return false;
        }
        for (ours, theirs) in to_folders.iter().zip(folders(key)) {
            if *ours != theirs {
                return ours.to_lowercase() != theirs.to_lowercase();
            }
        }
        true
    })
}

/// What this sync does about renames on Overleaf, given its copy of each side.
///
/// An unchanged file Overleaf no longer has is left to the path comparison,
/// which deletes it and pulls the new name, unless Overleaf has a new path
/// spelled like it but for letter case: then it moves there (see the module
/// note). An edited one the history shows renamed is carried only along a
/// [`direct_rename`] to a path new on Overleaf and [`free_here`], one file to
/// one path, and held otherwise; one it shows only removed is left to the
/// path comparison, which uploads it again. Each is weighed against the
/// history since its hold began, if it is held already, or the agreed copy,
/// leaving out Lattice's own last write to it. With no history every edited
/// one is held; when only a held file's longer window cannot be read, the
/// files just gone are still weighed from the agreed copy. When the history
/// cannot be read as a hold begins, every path new on Overleaf waits too,
/// since any may be a held file renamed; otherwise only one spelled like a
/// held file but for case, which a pull would write over it. A later sync
/// that still cannot read it pulls them, so the hold cannot keep Overleaf's
/// new files out for good.
pub(super) fn remote_renames(
    remote: &Remote, client: &Client, theirs: &BTreeMap<String, Vec<u8>>,
    local: &BTreeMap<String, Vec<u8>>,
) -> Renames {
    let state = &remote.state;
    let agreed = &state.files;
    let gone: Vec<&String> = agreed
        .keys()
        .filter(|path| !theirs.contains_key(*path) && local.contains_key(*path))
        .collect();
    let new_there = |path: &String| {
        theirs.contains_key(path) && !agreed.contains_key(path) && !local.contains_key(path)
    };
    let edited = |path: &String| local.get(path).map(sha256_hex).as_ref() != agreed.get(path);
    let mut renames = Renames::default();
    let mut by_case: BTreeMap<String, Vec<&String>> = BTreeMap::new();
    for path in theirs.keys().filter(|path| new_there(path)) {
        by_case.entry(path.to_lowercase()).or_default().push(path);
    }
    for from in gone.iter().filter(|path| !edited(path)) {
        if let Some([to]) = by_case.get(&from.to_lowercase()).map(Vec::as_slice) {
            renames.carried.insert((*to).clone(), (*from).clone());
        }
    }
    let pending: Vec<&String> = gone.into_iter().filter(|path| edited(path)).collect();
    if pending.is_empty() {
        return renames;
    }
    let prior = |path: &String| match state.unsettled.as_ref().and_then(|why| why.get(path)) {
        Some(Unsettled::Held(since)) => Some(*since),
        _ => None,
    };
    let window = |path: &String| prior(path).unwrap_or_else(|| agreed_copy(state));
    let windows: Vec<Option<HistoryFrom>> = pending.iter().map(|path| window(path)).collect();
    let (history, unread) = match history_from(remote, client, &windows) {
        Ok(history) => (history, Vec::new()),
        Err(error) => {
            log::warn!(target: "lattice::overleaf", "Could not read Overleaf's history for renames: {error}");
            let (held, fresh): (Vec<&String>, Vec<&String>) =
                pending.iter().partition(|path| prior(path).is_some());
            let fallback = (!held.is_empty() && !fresh.is_empty())
                .then(|| history_from(remote, client, &[agreed_copy(state)]));
            match fallback {
                Some(Ok(history)) => (history, held),
                _ => (Vec::new(), pending.clone()),
            }
        }
    };
    if unread.iter().any(|path| prior(path).is_none()) {
        let unpulled = theirs.keys().filter(|path| new_there(path));
        renames.waiting =
            unpulled.filter(|to| !renames.carried.contains_key(*to)).cloned().collect();
    }
    renames.held = unread.iter().map(|path| ((*path).clone(), window(path))).collect();
    let pending: Vec<&String> = pending.into_iter().filter(|path| !unread.contains(path)).collect();
    let ops = tree_ops(&history);
    // What happened to `path` since its window: Lattice's own upload of the
    // file, an add of that very path, is no other name for it.
    let seen = |path: &String| -> Vec<&TreeOp> {
        let (from, own) = (window(path), state.own_writes.get(path).copied());
        let own_upload = |placed: &&Placed| {
            matches!(&placed.op, TreeOp::Add(added) if added == path)
                && own.is_some_and(|own| placed.update.within(own))
        };
        (ops.iter())
            .filter(|placed| placed.after(from))
            .filter(|placed| !own_upload(placed))
            .map(|placed| &placed.op)
            .collect()
    };
    // Where each local file stands once the unchanged ones are carried.
    let mut keys: BTreeSet<String> = local.keys().cloned().collect();
    for (to, from) in &renames.carried {
        keys.remove(from);
        keys.insert(to.clone());
    }
    let renamed = |path: &str, ops: &[&TreeOp]| {
        let renaming = |op: &&TreeOp| matches!(op, TreeOp::Rename(from, to) if covers(from, path) && !to.is_empty());
        ops.iter().any(renaming)
    };
    let mut targets: BTreeMap<String, Vec<&String>> = BTreeMap::new();
    for from in pending {
        let ops = seen(from);
        if !renamed(from, &ops) {
            continue;
        }
        match direct_rename(from, &ops) {
            Some(to) if new_there(&to) && free_here(&to, from, keys.iter()) => {
                targets.entry(to).or_default().push(from)
            }
            _ => {
                renames.held.insert(from.clone(), window(from));
            }
        }
    }
    for (to, froms) in targets {
        match froms[..] {
            [from] if !renames.carried.contains_key(&to) => {
                renames.carried.insert(to, from.clone());
            }
            _ => renames.held.extend(froms.into_iter().map(|from| (from.clone(), window(from)))),
        }
    }
    wait_beside_held(renames, &by_case)
}

/// `renames` with each path new on Overleaf spelled like a held file but for
/// letter case left waiting, since a pull would write over the held file on
/// a disk that ignores case, and nothing carried to a waiting path.
fn wait_beside_held(mut renames: Renames, by_case: &BTreeMap<String, Vec<&String>>) -> Renames {
    for held in renames.held.keys() {
        let spelled_alike = by_case.get(&held.to_lowercase()).into_iter().flatten();
        renames.waiting.extend(spelled_alike.map(|path| (*path).clone()));
    }
    renames.carried.retain(|to, _| !renames.waiting.contains(to));
    renames
}

/// The sync's view with each file `renames` carries moved: its local copy,
/// its agreed hash and its merge base under the new path (the plan reads the
/// base from the old path until [`move_local`] moves it), and what was known
/// of the old path dropped.
pub(super) fn carry(
    state: &mut SyncState, local: &mut BTreeMap<String, Vec<u8>>, renames: &Renames,
) {
    wide_event::record("remote_renames", renames.carried.len());
    for (to, from) in &renames.carried {
        if let Some(bytes) = local.remove(from) {
            local.insert(to.clone(), bytes);
        }
        if let Some(hash) = state.files.remove(from) {
            state.files.insert(to.clone(), hash);
        }
        state.own_writes.remove(from);
        state.refused.remove(from);
    }
}

/// Hold each file `renames` holds: neither sent nor deleted, on its agreed
/// copy, so the next sync weighs it again; and leave each waiting path
/// unpulled and out of the agreed table, so it is still new to that sync.
/// The sync records where each hold began (see `sync_files`): the history
/// from there on is what shows the rename, and read only from the agreed
/// copy after it, it would read as no rename at all and send the edit up
/// under the old name.
pub(super) fn hold(plan: &mut SyncPlan, state: &SyncState, renames: &Renames) {
    for path in renames.held.keys() {
        plan.push.retain(|pushed| pushed != path);
        plan.delete_local.retain(|deleted| deleted != path);
        if let Some(hash) = state.files.get(path) {
            plan.files.insert(path.clone(), hash.clone());
        }
    }
    plan.pull.retain(|(path, _)| !renames.waiting.contains(path));
    plan.files.retain(|path, _| !renames.waiting.contains(path));
}

/// Move each carried file here, with its merge base, before the sync writes
/// anything, so whatever the plan lands at the new path, a merge, a pull or
/// an upload, lands on it. Returns the old paths it moved.
///
/// A file edited since the sync read it moves all the same, its newer text
/// with it, and the sync then leaves the new path for the next one, as it
/// leaves any file edited meanwhile. Something already at a new path stops
/// the sync before it writes, rather than overwrite it, unless it is the file
/// itself: a disk that ignores case finds it there after a rename in case
/// only, and the move then only changes the spelling, folders included.
pub(super) fn move_local(
    root: &Path, renames: &Renames, local: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<String>, String> {
    let one_file = |from: &str, to: &str| same_file(&disk_path(root, from), &disk_path(root, to));
    if let Some((to, from)) = renames.carried.iter().find(|(to, from)| {
        !one_file(from, to) && since_read(root, to, None) != SinceRead::Unchanged
    }) {
        return Err(format!(
            "{from} was renamed to {to} on Overleaf, and {to} was just created here. Sync again."
        ));
    }
    let project = ProjectDir::open(root)?;
    let at = |path: &str| disk_path(root, path).symlink_metadata().is_ok();
    let mut moved = Vec::new();
    for (to, from) in &renames.carried {
        if let Some(base) = read_base_copy(root, from) {
            write_base_copy(root, to, base.as_bytes())?;
        }
        // Deleted since it was read: the sync leaves the new path, and the
        // next one reads the deletion.
        if !local.contains_key(to) || !(at(from) || at(to)) {
            continue;
        }
        let moving = || {
            if at(from) && !one_file(from, to) {
                project.move_file(from, to)?;
            }
            project.respell(to)
        };
        moving().map_err(|e| format!("Could not move {from} to {to}: {e}"))?;
        moved.push(from.clone());
    }
    Ok(moved)
}

/// Whether `a` and `b` name one file on disk, as two spellings of a path do
/// on a disk that ignores letter case.
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (a.symlink_metadata(), b.symlink_metadata()) {
        (Ok(a), Ok(b)) => (a.dev(), a.ino()) == (b.dev(), b.ino()),
        _ => false,
    }
}

/// Drop the merge base kept at each carried file's old path, once the sync
/// has kept one at the new path, unless the two name one file on disk.
pub(super) fn forget_old_bases(root: &Path, renames: &Renames) {
    for (to, from) in &renames.carried {
        if !same_file(&disk_path(root, from), &disk_path(root, to)) {
            remove_base_copy(root, from);
        }
    }
}

/// The plan, unless it deletes a file here at a path spelled like one it
/// keeps but for letter case. On a disk that ignores case both name one file,
/// so the deletion would take the file just pulled or kept with it.
pub(super) fn refuse_case_aliases(plan: SyncPlan) -> Result<SyncPlan, String> {
    let kept: BTreeMap<String, &String> =
        plan.files.keys().map(|path| (path.to_lowercase(), path)).collect();
    for deleted in &plan.delete_local {
        if let Some(kept) = kept.get(&deleted.to_lowercase()) {
            return Err(format!(
                "Overleaf no longer has {deleted} but has {kept}, a name this disk may take for \
                 the same file, so deleting {deleted} here could delete {kept}. Move {deleted} \
                 out of the project, then sync again. No files were changed."
            ));
        }
    }
    Ok(plan)
}

/// Report each rename carried here as the sync's other changes are: the old
/// path deleted here, and the new one as arrived when nothing else the sync
/// did to it names it already; and each file held.
pub(super) fn report(result: &mut OverleafSyncResult, renames: &Renames, moved: &[String]) {
    result.held_renames = renames.held.keys().cloned().collect();
    for (to, from) in renames.carried.iter().filter(|(_, from)| moved.contains(from)) {
        result.deleted_local.push(from.clone());
        let lists = [&result.pulled, &result.merged, &result.pushed, &result.edited_during_sync];
        let named = lists.iter().any(|list| list.contains(to))
            || result.conflicts.iter().any(|conflict| &conflict.path == to);
        if !named {
            result.pulled.push(to.clone());
        }
    }
    result.deleted_local.sort();
    result.pulled.sort();
}
