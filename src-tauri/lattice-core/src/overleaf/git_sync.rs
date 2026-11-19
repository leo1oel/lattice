//! Syncing a linked project through Overleaf's git bridge rather than its web
//! API: the project's own repository is fetched, merged and pushed (see
//! `git::bridge`), and the writer commits their own work.
//!
//! The live channel, the sync base copies and the REST table in
//! `.research/overleaf.json` are not touched, so switching back to the web
//! sync resumes from where it left off. No Overleaf web session is needed: the
//! git token is the credential.

use super::account::normalize_host;
use super::files::has_conflict_markers;
use super::link::{load_state, now_iso, save_state, SyncState, SyncVia, PAUSED};
use super::sync::{OverleafConflict, OverleafProbe, OverleafSyncResult};
use crate::git::bridge;
use std::path::Path;

pub const MISSING_TOKEN: &str =
    "Add your Overleaf git token in Settings → Overleaf to sync through git.";

/// Overleaf's git bridge for the linked project: `git.overleaf.com` for
/// overleaf.com, `<host>/git/<id>` for a self-hosted instance.
fn bridge_url(state: &SyncState) -> Result<String, String> {
    let id = state.project_id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("This project's Overleaf id is not valid for git.".to_string());
    }
    let host = normalize_host(&state.host);
    let hosted = reqwest::Url::parse(&host)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|name| name == "www.overleaf.com" || name == "overleaf.com");
    Ok(if hosted { format!("https://git.overleaf.com/{id}") } else { format!("{host}/git/{id}") })
}

/// The linked project's state when it syncs through git and may sync now.
fn ready(root: &Path, token: Option<String>) -> Result<(SyncState, String, String), String> {
    let state = load_state(root)?;
    if state.paused {
        return Err(PAUSED.to_string());
    }
    if state.sync_via != SyncVia::Git {
        return Err("This project is not set to sync through git.".to_string());
    }
    let token = token.filter(|token| !token.trim().is_empty()).ok_or(MISSING_TOKEN)?;
    let url = bridge_url(&state)?;
    Ok((state, url, token))
}

/// Fetch, merge and push the project's repository. Reported in the same shape
/// as the web sync's result, so everything that reads one reads this too.
pub fn git_sync(root: &Path, token: Option<String>) -> Result<OverleafSyncResult, String> {
    let (mut state, url, token) = ready(root, token)?;
    let outcome = bridge::sync(root, &url, &token)?;
    state.last_sync = Some(now_iso());
    save_state(root, &state)?;
    Ok(OverleafSyncResult {
        pulled: outcome.pulled,
        pushed: outcome.pushed,
        conflicts: outcome.conflicts.into_iter().map(|path| conflict(root, path)).collect(),
        uncommitted: outcome.uncommitted,
        ..Default::default()
    })
}

/// A file the merge left in conflict. Git writes markers into text only: a
/// binary file stays as it was, with nothing in it to work through.
fn conflict(root: &Path, path: String) -> OverleafConflict {
    let markers = std::fs::read(root.join(&path)).is_ok_and(|bytes| has_conflict_markers(&bytes));
    OverleafConflict { local_copy: path.clone(), path, markers }
}

/// Whether Overleaf has commits this folder has not fetched.
pub fn git_probe(root: &Path, token: Option<String>) -> Result<OverleafProbe, String> {
    let (state, url, token) = ready(root, token)?;
    Ok(OverleafProbe {
        changed: bridge::remote_changed(root, &url, &token)?,
        local_changed: false,
        version_known: true,
        remote_version: None,
        last_sync: state.last_sync,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(host: &str, id: &str) -> SyncState {
        SyncState { host: host.into(), project_id: id.into(), ..Default::default() }
    }

    #[test]
    fn overleaf_com_uses_the_git_host_and_a_self_hosted_one_its_own_path() {
        for host in ["", "https://www.overleaf.com", "overleaf.com/", "HTTPS://WWW.OVERLEAF.COM"] {
            assert_eq!(
                bridge_url(&state(host, "64a1b2c3d4e5f60718293a4b")).unwrap(),
                "https://git.overleaf.com/64a1b2c3d4e5f60718293a4b",
                "{host:?}"
            );
        }
        assert_eq!(
            bridge_url(&state("https://latex.example.edu", "abc123")).unwrap(),
            "https://latex.example.edu/git/abc123"
        );
    }

    #[test]
    fn a_project_id_cannot_steer_the_url() {
        for id in ["", "../x", "a/b", "a b", "a?b", "a#b"] {
            assert!(bridge_url(&state("", id)).is_err(), "{id:?} should be refused");
        }
    }

    #[test]
    fn only_a_file_git_wrote_markers_into_offers_to_resolve_them() {
        let root = crate::test_support::TempDir::new("git-sync-conflict");
        root.write("main.tex", "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> overleaf\n");
        std::fs::write(root.join("fig.png"), b"\x89PNG\0binary").unwrap();

        assert!(conflict(&root, "main.tex".into()).markers);
        let binary = conflict(&root, "fig.png".into());
        assert!(!binary.markers);
        assert_eq!(binary.path, "fig.png");
        // A file that cannot be read has nothing to work through either.
        assert!(!conflict(&root, "gone.tex".into()).markers);
    }
}
