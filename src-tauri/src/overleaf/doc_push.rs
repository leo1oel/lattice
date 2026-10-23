//! Sending an edit to a file Overleaf holds as a document.
//!
//! An upload replaces whatever is at its path with what the upload endpoint
//! makes of the bytes, and the endpoint decides that from the file name alone,
//! not from what is already there. A document made with New file in the
//! browser, say a `data.csv` for pgfplots, comes back from an upload as a
//! binary file: no longer editable in the browser, and its comments and
//! tracked changes gone with it. Overleaf's own editor never uploads a
//! document; it edits it over the live channel. So does this, for each
//! document whose name the upload might not read as text: join it, send the
//! difference as one operation, leave.
//!
//! The operation is tracked when the project's track-changes setting is on
//! for this account, as Overleaf does with an upload into a document.

use super::api::Remote;
use crate::overleaf_rt::{OtOp, RealtimeClient, RealtimeConfig, Submission};
use crate::wide_event;
use std::collections::{BTreeMap, BTreeSet};
use tauri::async_runtime as rt;

/// Extensions an upload reads as text on any Overleaf, so uploading one keeps
/// a document a document. Deliberately short: a document missing from it only
/// costs a trip over the live channel, which is right for every document.
const UPLOADED_AS_TEXT: &[&str] = &["tex", "latex", "ltx", "sty", "cls", "bib", "bst", "txt", "md"];

/// Whether uploading `path` could turn a document there into a binary file.
pub(super) fn may_become_a_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => {
            !UPLOADED_AS_TEXT.contains(&extension.to_ascii_lowercase().as_str())
        }
        _ => true,
    }
}

/// The edit that turns `before` into `after`, positioned the way Overleaf
/// counts: in UTF-16 code units.
pub(super) fn edit_ops(before: &str, after: &str) -> Vec<OtOp> {
    let common = |a: &mut dyn Iterator<Item = char>, b: &mut dyn Iterator<Item = char>| -> usize {
        a.zip(b).take_while(|(x, y)| x == y).map(|(c, _)| c.len_utf8()).sum()
    };
    let prefix = common(&mut before.chars(), &mut after.chars());
    let (before_rest, after_rest) = (&before[prefix..], &after[prefix..]);
    let suffix = common(&mut before_rest.chars().rev(), &mut after_rest.chars().rev());
    let removed = &before_rest[..before_rest.len() - suffix];
    let inserted = &after_rest[..after_rest.len() - suffix];
    let p = before[..prefix].encode_utf16().count();
    let op = |i: Option<&str>, d: Option<&str>| OtOp {
        p,
        i: i.map(str::to_string),
        d: d.map(str::to_string),
        u: None,
    };
    let mut ops = Vec::new();
    if !removed.is_empty() {
        ops.push(op(None, Some(removed)));
    }
    if !inserted.is_empty() {
        ops.push(op(Some(inserted), None));
    }
    ops
}

/// Send each of `files` that Overleaf holds as a document an upload might
/// turn into a file over the live channel instead, and answer with the paths
/// sent; the rest are left for the upload.
///
/// When the live channel cannot be reached, nothing goes this way and every
/// file is uploaded as it always was. Once it is reached, a document that
/// fails to take its edit fails the sync, like a failed upload: falling back
/// to the upload is exactly what loses the document.
pub(super) fn push_docs(
    remote: &Remote, files: &BTreeMap<String, Vec<u8>>,
) -> Result<BTreeSet<String>, String> {
    // A document only ever holds text.
    let candidates: Vec<(&String, &str)> = (files.iter())
        .filter(|(path, _)| may_become_a_file(path))
        .filter_map(|(path, bytes)| Some((path, std::str::from_utf8(bytes).ok()?)))
        .collect();
    if candidates.is_empty() {
        return Ok(BTreeSet::new());
    }
    let config = RealtimeConfig {
        user_id: remote.session.user_id.clone(),
        host: remote.host.clone(),
        cookie: remote.session.cookie.clone(),
        project_id: remote.state.project_id.clone(),
    };
    let client = match rt::block_on(RealtimeClient::connect(config, |_| {})) {
        Ok(client) => client,
        Err(_) => {
            wide_event::record("doc_push_unreachable", true);
            return Ok(BTreeSet::new());
        }
    };
    let sent = rt::block_on(send_all(&client, &candidates));
    client.shutdown();
    sent
}

async fn send_all(
    client: &RealtimeClient, candidates: &[(&String, &str)],
) -> Result<BTreeSet<String>, String> {
    let project = client.project();
    let mut sent = BTreeSet::new();
    for (path, text) in candidates {
        // A path that is a binary file on Overleaf, or not there at all, is
        // the upload's.
        let Some(doc) = project.docs.iter().find(|doc| doc.path == **path) else { continue };
        let failed = |error: String| format!("Failed to send \"{path}\" to Overleaf: {error}");
        let joined = client.join_doc(&doc.id, None).await.map_err(failed)?;
        let ops = edit_ops(&joined.text, text);
        (client.send_ops(
            &doc.id,
            joined.version,
            ops,
            project.track_changes,
            Submission::default(),
        ))
        .await
        .map_err(failed)?;
        client.leave_doc(&doc.id).await.map_err(failed)?;
        sent.insert((*path).clone());
    }
    wide_event::record("docs_pushed_live", sent.len());
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overleaf::account::{load_session, save_session, SessionFile};
    use crate::overleaf::api::http_client;
    use crate::overleaf::link::{save_state, SyncState};
    use crate::overleaf_rt::mock_server::{
        sent_updates as updates, serve_http, start_mock_serving, MOCK_USER_ID,
    };
    use crate::test_support::TempDir;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    fn remote(host: &str) -> Remote {
        Remote {
            session: SessionFile {
                host: host.into(),
                cookie: "overleaf_session2=test-cookie".into(),
                email: None,
                name: None,
                user_id: Some("user-1".into()),
                expired: false,
            },
            state: SyncState {
                host: host.into(),
                project_id: "proj-1".into(),
                root_folder_id: Some("root-1".into()),
                ..Default::default()
            },
            host: host.into(),
        }
    }

    /// The main text, a data file made with New file in the browser (so a
    /// document), and a figure description uploaded as a binary file.
    fn project(track_changes: Value) -> Value {
        json!({
            "_id": "proj-1",
            "name": "Paper",
            "trackChangesState": track_changes,
            "rootFolder": [{
                "_id": "root-1",
                "name": "rootFolder",
                "docs": [{"_id": "doc-main", "name": "main.tex"}, {"_id": "doc-data", "name": "data.csv"}],
                "fileRefs": [{"_id": "file-1", "name": "plot.json"}],
                "folders": []
            }]
        })
    }

    fn files(entries: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        entries.iter().map(|(path, text)| (path.to_string(), text.as_bytes().to_vec())).collect()
    }

    #[test]
    fn an_upload_is_trusted_with_a_document_only_when_its_name_reads_as_text() {
        for (path, risky) in [
            ("main.tex", false),
            ("sections/Intro.TEX", false),
            ("refs.bib", false),
            ("data.csv", true),
            ("results/table.dat", true),
            ("plot.json", true),
            ("latexmkrc", true),
            (".latexmkrc", true),
        ] {
            assert_eq!(may_become_a_file(path), risky, "{path}");
        }
    }

    #[test]
    fn the_edit_is_positioned_in_utf16_units_and_never_splits_a_character() {
        let op = |p: usize, i: Option<&str>, d: Option<&str>| OtOp {
            p,
            i: i.map(str::to_string),
            d: d.map(str::to_string),
            u: None,
        };
        // 😀 counts two units, so "b" starts at 3.
        assert_eq!(
            edit_ops("a😀b\nx", "a😀B\nx"),
            vec![op(3, None, Some("b")), op(3, Some("B"), None)]
        );
        // é and è share their first UTF-8 byte; the edit still takes the whole character.
        assert_eq!(edit_ops("café", "cafè"), vec![op(3, None, Some("é")), op(3, Some("è"), None)]);
        assert_eq!(edit_ops("x,y", "x,y\n1,2"), vec![op(3, Some("\n1,2"), None)]);
        assert_eq!(edit_ops("same", "same"), vec![]);
    }

    #[test]
    fn a_document_takes_its_edit_over_the_live_channel_and_everything_else_is_left_to_the_upload() {
        let (host, state) = start_mock_serving(project(json!(false)), &["x,y", "1,2"]);
        let files = files(&[
            ("data.csv", "x,y\n1,2\n3,4"),
            ("main.tex", "\\documentclass{article}"),
            ("plot.json", "{}"),
            ("new.dat", "1 2"),
        ]);
        let sent = push_docs(&remote(&host), &files).unwrap();
        assert_eq!(sent, BTreeSet::from(["data.csv".to_string()]));
        let updates = updates(&state);
        assert_eq!(updates.len(), 1, "{updates:?}");
        assert_eq!(updates[0]["doc"], "doc-data");
        assert_eq!(updates[0]["v"], 42);
        assert_eq!(updates[0]["op"], json!([{"p": 7, "i": "\n3,4"}]));
        assert!(updates[0].get("meta").is_none(), "{:?}", updates[0]);
    }

    #[test]
    fn the_edit_is_a_suggestion_when_the_project_tracks_this_accounts_changes() {
        let (host, state) = start_mock_serving(project(json!({"user-1": true})), &["x,y"]);
        push_docs(&remote(&host), &files(&[("data.csv", "x,z")])).unwrap();
        let updates = updates(&state);
        assert!(updates[0]["meta"]["tc"].is_string(), "{updates:?}");
    }

    #[test]
    fn a_session_stored_without_its_account_id_still_suggests_when_tracked() {
        let (host, state) = start_mock_serving(project(json!({MOCK_USER_ID: true})), &["x,y"]);
        let (config, root) = (TempDir::new("doc-push-config"), TempDir::new("doc-push-project"));
        let session = SessionFile { user_id: None, ..remote(&host).session };
        save_session(&config, &session).unwrap();
        save_state(&root, &remote(&host).state).unwrap();
        let linked = Remote::open_for_sync(&config, &root).unwrap();
        push_docs(&linked, &files(&[("data.csv", "x,z")])).unwrap();
        let updates = updates(&state);
        assert!(updates[0]["meta"]["tc"].is_string(), "{updates:?}");
        // Looked up once: the next sync reads it from the stored session.
        assert_eq!(load_session(&config).unwrap().user_id.as_deref(), Some(MOCK_USER_ID));
    }

    #[test]
    fn the_upload_skips_a_document_it_would_have_turned_into_a_file() {
        // Every request but the live channel's would be an upload here.
        let (host, state) = start_mock_serving(project(json!(false)), &["x,y"]);
        let (remote, client) = (remote(&host), http_client(10).unwrap());
        let uploader = remote.uploader(&client, "fixture-csrf").unwrap();
        uploader.upload_all(&files(&[("data.csv", "x,y\n1,2")]), &BTreeSet::new()).unwrap();
        let requests = state.lock().unwrap().requests.clone();
        assert!(requests.iter().all(|(url, _, _)| url.starts_with("/socket.io/")), "{requests:?}");
        assert_eq!(updates(&state).len(), 1);
    }

    #[test]
    fn without_the_live_channel_everything_is_left_to_the_upload_as_before() {
        let hits = Arc::new(Mutex::new(0));
        let seen = Arc::clone(&hits);
        let host = serve_http(move |request| {
            *seen.lock().unwrap() += 1;
            let _ = request.respond(tiny_http::Response::empty(404));
        });
        let remote = remote(&host);
        // Nothing that could be a document: the live channel is not even tried.
        let safe = files(&[("main.tex", "text")]);
        assert_eq!(push_docs(&remote, &safe).unwrap(), BTreeSet::new());
        assert_eq!(*hits.lock().unwrap(), 0);
        assert_eq!(push_docs(&remote, &files(&[("data.csv", "x,y")])).unwrap(), BTreeSet::new());
        assert!(*hits.lock().unwrap() > 0);
    }
}
