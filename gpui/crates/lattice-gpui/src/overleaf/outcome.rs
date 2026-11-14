//! What a finished sync means to the writer, as the Tauri app words it: the
//! line it ends on (`overleaf-sync-summary.ts`), the warnings for what it
//! left undone (`overleaf-sync-warnings.ts`), the conflicts it left on disk
//! (`overleaf-sync-outcome.ts`), and how a failure reads
//! (`overleaf-sync-failures.ts`, `overleaf-realtime-model.ts`).

use lattice_core::overleaf::{OverleafConflict, OverleafSyncResult};
use lattice_i18n::t;

/// The line a finished sync ends on: what moved, or why nothing did. A file
/// held back still marked up is not synced, so it never reads as up to date.
pub fn summary(result: &OverleafSyncResult) -> String {
    let (pulled, pushed, merged) = (
        result.pulled.len(),
        result.pushed.len(),
        result.merged.len(),
    );
    if merged > 0 {
        return t!(
            "Overleaf: pulled {pulled}, pushed {pushed}, merged {merged}.",
            pulled = pulled,
            pushed = pushed,
            merged = merged
        )
        .into();
    }
    if pulled > 0 || pushed > 0 {
        return t!(
            "Overleaf: pulled {pulled}, pushed {pushed}.",
            pulled = pulled,
            pushed = pushed
        )
        .into();
    }
    if result.unresolved_conflicts.is_empty() {
        t!("Overleaf: already up to date.").into()
    } else {
        let files = result.unresolved_conflicts.join(", ");
        t!(
            "Overleaf: waiting on conflict resolution in {files}.",
            files = &files
        )
        .into()
    }
}

/// One warning for something a finished sync left undone that would
/// otherwise look synced, with the file to resolve when it offers that.
#[derive(Debug, PartialEq)]
pub struct Warning {
    pub message: String,
    pub resolve: Option<String>,
}

/// What a finished sync left undone that would otherwise look synced: one
/// warning each, so the absence is not first discovered from the other side.
pub fn warnings(result: &OverleafSyncResult) -> Vec<Warning> {
    let mut said: Vec<String> = Vec::new();
    let files = result.skipped_large.join(", ");
    if !files.is_empty() {
        said.push(
            t!(
                "Too large for Overleaf, so left on this machine: {files}.",
                files = &files
            )
            .into(),
        );
    }
    // A download that would have emptied or gutted files nobody changed on
    // Overleaf. Said once: the files simply stay, and the reason is that
    // Overleaf's own history does not confirm the change.
    let files = result.refused_incoming.join(", ");
    if !files.is_empty() {
        said.push(t!("Kept your copy of {files}. Overleaf sent these files empty or much smaller, but its history does not confirm the change. To take Overleaf's version anyway, delete the file here and sync again.", files = &files).into());
    }
    // Without the live channel a document goes up whole, and someone's edit
    // reached the project while one did.
    let files = result.uploaded_over_edits.join(", ");
    if !files.is_empty() {
        said.push(t!("Someone edited the Overleaf project while {files} uploaded. An upload replaces the whole file, so it may have overwritten their latest typing there. Check the file's history on Overleaf to bring back anything missing.", files = &files).into());
    }
    // Overleaf keeps names apart that this Mac's disk treats as one.
    if !result.case_collisions.is_empty() {
        let pairs = result
            .case_collisions
            .iter()
            .map(|pair| format!("{} / {}", pair.kept, pair.skipped))
            .collect::<Vec<_>>()
            .join(", ");
        said.push(t!("Overleaf has names that differ only in capitalization, which this Mac treats as the same name: {pairs}. Only the first of each pair syncs here. Rename one of them on Overleaf to sync both.", pairs = &pairs).into());
    }
    // Edited here and renamed or removed on Overleaf where the sync could
    // not follow: it waits, named on every sync while held.
    for file in &result.held_renames {
        said.push(t!("Overleaf renamed or removed {file} while it was edited here, and Lattice could not tell where the edit belongs, so it stays here unsent. Copy the edit into the right file, then delete {file} here.", file = file).into());
    }
    // A folder gone from Overleaf whose build outputs the sync cleared, kept
    // for the writer's own files in it.
    for kept in &result.kept_folders {
        let names = kept.files.join(", ");
        said.push(t!("Overleaf no longer has the folder {folder}. It stays here because it still holds files that never sync: {names}. Delete them here if you no longer need them.", folder = &kept.folder, names = &names).into());
    }
    let mut warnings: Vec<Warning> = said
        .into_iter()
        .map(|message| Warning {
            message,
            resolve: None,
        })
        .collect();
    // Held back while Overleaf moves on, named once when the hold starts.
    warnings.extend(result.newly_unresolved_conflicts.iter().map(|file| {
        Warning {
        message: t!(
            "{file} still has conflict markers. Resolve them to bring in Overleaf's newer edits.",
            file = file
        )
        .into(),
        resolve: Some(file.clone()),
    }
    }));
    warnings
}

/// What a sync's conflicts say: the files with spots to resolve (`marked`),
/// read back from disk by the caller, and the files that changed whole on
/// both sides; and the file the resolver opens on.
pub fn conflict_message(marked: &[&OverleafConflict], whole: &[&OverleafConflict]) -> String {
    let paths = |items: &[&OverleafConflict]| {
        items
            .iter()
            .map(|item| item.path.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut parts: Vec<String> = Vec::new();
    if !marked.is_empty() {
        let files = paths(marked);
        parts.push(t!("Couldn’t merge {markedFiles}. Both versions are kept; resolve each spot to finish. Nothing uploads until then.", markedFiles = &files).into());
    }
    if !whole.is_empty() {
        let files = paths(whole);
        parts.push(t!("{wholeFiles} changed on both sides. Overleaf’s version is in the project; yours is in the “(local conflict …)” file beside it.", wholeFiles = &files).into());
    }
    parts.join(" ")
}

/// Any files a sync brought in, merged, conflicted or deleted: the PDF and
/// the open editors follow them.
pub fn incoming(result: &OverleafSyncResult) -> bool {
    !result.pulled.is_empty()
        || !result.merged.is_empty()
        || !result.conflicts.is_empty()
        || !result.deleted_local.is_empty()
}

fn mentions_any(message: &str, phrases: &[&str]) -> bool {
    let lower = message.to_lowercase();
    phrases
        .iter()
        .any(|phrase| lower.contains(&phrase.to_lowercase()))
}

/// overleaf/api.rs's error for a request that never reached Overleaf, and
/// reqwest's own text for a body cut off mid-read.
pub fn is_transient_transport_failure(error: &str) -> bool {
    mentions_any(
        error,
        &["Could not reach Overleaf", "error decoding response body"],
    )
}

/// The backend's session-expired and not-connected errors, however a sync
/// step wraps them.
pub fn is_signed_out(error: &str) -> bool {
    mentions_any(
        error,
        &["Overleaf session expired", "Not connected to Overleaf"],
    )
}

/// A request Overleaf turned away while the session stayed valid
/// (`SESSION_STILL_VALID` in overleaf_rt.rs): often brief, but a lost share
/// persists.
pub fn is_project_refusal(error: &str) -> bool {
    mentions_any(error, &["session is still valid"])
}

/// How many refusals in a row are retried before one is reported.
pub const REFUSAL_RETRIES: u32 = 3;

/// Whether Overleaf asked us to slow down.
pub fn is_rate_limited(error: &str) -> bool {
    error.contains("429") || error.to_lowercase().contains("too many requests")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result() -> OverleafSyncResult {
        OverleafSyncResult::default()
    }

    #[test]
    fn the_summary_says_what_moved_or_why_nothing_did() {
        let mut synced = result();
        assert_eq!(summary(&synced), "Overleaf: already up to date.");
        synced.unresolved_conflicts = vec!["main.tex".into()];
        assert_eq!(
            summary(&synced),
            "Overleaf: waiting on conflict resolution in main.tex."
        );
        synced.pulled = vec!["a.tex".into()];
        assert_eq!(summary(&synced), "Overleaf: pulled 1, pushed 0.");
        synced.merged = vec!["b.tex".into()];
        assert_eq!(summary(&synced), "Overleaf: pulled 1, pushed 0, merged 1.");
    }

    #[test]
    fn each_thing_left_undone_is_one_warning_and_a_held_conflict_offers_the_resolver() {
        let mut synced = result();
        assert!(warnings(&synced).is_empty());
        synced.skipped_large = vec!["video.mp4".into()];
        synced.newly_unresolved_conflicts = vec!["main.tex".into()];
        let said = warnings(&synced);
        assert_eq!(said.len(), 2);
        assert!(said[0].message.contains("video.mp4") && said[0].resolve.is_none());
        assert_eq!(said[1].resolve.as_deref(), Some("main.tex"));
    }

    #[test]
    fn failures_are_told_apart_by_the_backends_words() {
        assert!(is_transient_transport_failure(
            "Could not reach Overleaf: connection reset"
        ));
        assert!(is_signed_out(
            "Overleaf session expired. Reconnect in Settings → Overleaf."
        ));
        assert!(is_project_refusal(
            "Overleaf turned this request away, though the session is still valid."
        ));
        assert!(is_rate_limited("HTTP 429 Too Many Requests"));
        assert!(!is_signed_out("Could not reach Overleaf"));
    }
}
