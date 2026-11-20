//! A mock Overleaf that holds one copy of the project for every client, as
//! the real one does: what one Lattice uploads or types over the live channel
//! lands in that copy, moves its version and is recorded in its history (with
//! the time it was made), so the next client to read it, by download, fetch
//! or live channel, sees it. A co-author in the web editor is a change made
//! straight to that copy, recorded the same way.
//!
//! What the real Overleaf does that this does not: transform two live
//! channels' operations against each other in real time (each sync's channel
//! here joins documents fresh), group updates the way its history does, or
//! compile anything.

use super::*;
use crate::overleaf_rt::mock_server::{doc_texts, realtime_state};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Every document edited over the live channel since the copy was last read
/// becomes part of it, as one update.
pub(super) fn fold_live_edits(shared: &Arc<Mutex<SharedProject>>, live: &Arc<Mutex<MockState>>) {
    let texts = doc_texts(live);
    let mut shared = shared.lock().unwrap();
    let mut changed = Vec::new();
    for (id, text) in texts {
        let path =
            (shared.files.keys()).find(|path| is_doc(path) && entity_id(path) == id).cloned();
        let Some(path) = path else { continue };
        if shared.files[&path] != text.as_bytes() {
            shared.files.insert(path.clone(), text.into_bytes());
            changed.push(path);
        }
    }
    if !changed.is_empty() {
        let names: Vec<&str> = changed.iter().map(String::as_str).collect();
        shared.update_at(&names, serde_json::json!([]), now_ms());
    }
}

/// A file uploaded over REST replaces Overleaf's copy of it.
pub(super) fn land_upload(shared: &Arc<Mutex<SharedProject>>, body: &[u8]) {
    let find = |from: usize, needle: &[u8]| {
        body[from..].windows(needle.len()).position(|w| w == needle).map(|at| from + at)
    };
    let Some(field) = find(0, b"name=\"relativePath\"") else { return };
    let Some(start) = find(field, b"\r\n\r\n").map(|at| at + 4) else { return };
    let Some(end) = find(start, b"\r\n--") else { return };
    let path = String::from_utf8_lossy(&body[start..end]).into_owned();
    let Some(part) = find(0, b"filename=\"") else { return };
    let Some(start) = find(part, b"\r\n\r\n").map(|at| at + 4) else { return };
    let end = (body.windows(4).rposition(|w| w == b"\r\n--")).unwrap_or(body.len());
    let mut shared = shared.lock().unwrap();
    shared.files.insert(path.clone(), body[start..end].to_vec());
    shared.update_at(&[&path], serde_json::json!([]), now_ms());
}

/// One Overleaf project, and the clients linked to it.
pub(in crate::overleaf) struct Overleaf {
    pub shared: Arc<Mutex<SharedProject>>,
    pub server: MockServer,
}

/// One Lattice on one Mac, with its own copy of the project.
pub(in crate::overleaf) struct Client {
    pub config: TempDir,
    pub root: TempDir,
}

impl Overleaf {
    /// A project holding `files` at version 40.
    pub fn new(files: Files) -> Self {
        let owned: Vec<(String, Vec<u8>)> =
            files.iter().map(|(path, bytes)| (path.to_string(), bytes.to_vec())).collect();
        let shared = SharedProject::new(&owned, 40);
        let live = realtime_state(serde_json::json!({}), &[]);
        let mock = Mock {
            realtime: Some(live),
            shared: Some(Arc::clone(&shared)),
            coherent: true,
            ..Default::default()
        };
        Overleaf { shared, server: mock.serve() }
    }

    /// A Lattice that has just synced the project as it stands.
    pub fn client(&self) -> Client {
        let (files, version) = {
            let shared = self.shared.lock().unwrap();
            (shared.files.clone(), shared.version)
        };
        let files: Vec<(&str, &[u8])> =
            files.iter().map(|(path, bytes)| (path.as_str(), bytes.as_slice())).collect();
        let (config, root) = linked(&self.server, &files, &files);
        edit_state(&root, |state| {
            state.remote_version = Some(version);
            state.agreed_version = Some(version);
            state.unsettled = Some([].into());
        });
        Client { config, root }
    }

    /// A co-author in Overleaf's web editor changes `path` to `bytes`.
    pub fn web_edit(&self, path: &str, bytes: &[u8]) {
        let mut shared = self.shared.lock().unwrap();
        shared.files.insert(path.to_string(), bytes.to_vec());
        shared.update_at(&[path], serde_json::json!([]), now_ms());
    }

    /// A co-author renames `from` to `to` on Overleaf.
    pub fn web_rename(&self, from: &str, to: &str) {
        let mut shared = self.shared.lock().unwrap();
        let bytes = shared.files.remove(from).unwrap();
        shared.files.insert(to.to_string(), bytes);
        let at = shared.version;
        let op =
            serde_json::json!([{ "atV": at, "rename": { "pathname": from, "newPathname": to } }]);
        shared.update_at(&[to], op, now_ms());
    }

    /// A co-author deletes `path` on Overleaf.
    pub fn web_delete(&self, path: &str) {
        let mut shared = self.shared.lock().unwrap();
        shared.files.remove(path);
        let at = shared.version;
        let op = serde_json::json!([{ "atV": at, "remove": { "pathname": path } }]);
        shared.update_at(&[], op, now_ms());
    }

    /// Overleaf's copy of `path`.
    pub fn file(&self, path: &str) -> Option<Vec<u8>> {
        self.shared.lock().unwrap().files.get(path).cloned()
    }
}

impl Client {
    pub fn sync(&self) -> OverleafSyncResult {
        sync(&self.config, &self.root, &BTreeSet::new(), None).unwrap()
    }

    pub fn write(&self, path: &str, bytes: &[u8]) {
        let at = disk_path(&self.root, path);
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(at, bytes).unwrap();
    }

    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        read_local(&self.root, path)
    }

    pub fn text(&self, path: &str) -> String {
        String::from_utf8(self.read(path).unwrap()).unwrap()
    }
}
