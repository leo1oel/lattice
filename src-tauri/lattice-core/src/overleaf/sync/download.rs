//! Overleaf's project download as the sync's remote snapshot: every file
//! the ZIP holds, minus everything that never syncs.

use super::RemoteFiles;
use crate::overleaf::api::{
    download_project_zip, read_zip_entries, DownloadGate, DownloadProgress, Remote,
};
use crate::overleaf::files::*;
use crate::wide_event;
use reqwest::blocking::Client;
use std::collections::BTreeSet;

/// The project download, once past `gate`, timed and counted on the sync's
/// wide event.
pub(super) fn download(
    remote: &Remote, client: &Client, gate: DownloadGate, progress: DownloadProgress,
) -> Result<RemoteFiles, String> {
    gate();
    let step = wide_event::step("download");
    let downloaded = fetch_remote_files(remote, client, progress)?;
    drop(step);
    wide_event::record("download", "full");
    let bytes: usize = downloaded.files.values().map(Vec::len).sum();
    wide_event::record("remote_files", downloaded.files.len());
    wide_event::record("remote_bytes", bytes);
    Ok(downloaded)
}

fn fetch_remote_files(
    remote: &Remote, client: &Client, progress: DownloadProgress,
) -> Result<RemoteFiles, String> {
    let Remote { host, session, state, .. } = remote;
    let zip_bytes =
        download_project_zip(client, host, &session.cookie, &state.project_id, progress)?;
    let entries = read_zip_entries(&zip_bytes)?;
    // The realtime tree owns entity ids, so the sync cannot delete these
    // itself. Return app-owned leftovers for the frontend to remove; collapse
    // PDF renders to their stable parent folder so cleanup takes one request.
    // Until deletion succeeds, filtering below also prevents a pull.
    let mut automatic_remote_deletes: Vec<String> =
        entries.keys().filter(|path| is_latex_save_error_path(path)).cloned().collect();
    if entries.keys().any(|path| is_transient_pdf_render_path(path)) {
        automatic_remote_deletes.push(TRANSIENT_PDF_RENDER_DIRECTORY.to_string());
    }
    automatic_remote_deletes.sort();
    let mut files = syncable(entries);
    files.retain(|path, _| !remote.build_pdf.is(path));
    Ok(RemoteFiles { files, automatic_remote_deletes, unsettled: BTreeSet::new() })
}
