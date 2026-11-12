//! What a failed sync means for whoever reads the log: the kind of failure
//! the wide event records, and the fix to try.

use super::super::link::PAUSED;
use crate::overleaf_rt::{NOT_CONNECTED, SESSION_EXPIRED, SESSION_STILL_VALID};
use crate::wide_event::Failure;

/// What a failed sync means for whoever reads the log.
pub fn classify_sync_error(error: &str) -> Failure {
    let error = error
        .strip_prefix("Failed to upload ")
        .and_then(|rest| rest.split_once(" to Overleaf: "))
        .map_or(error, |(_, cause)| cause);
    if error == SESSION_EXPIRED || error == NOT_CONNECTED {
        Failure {
            kind: "session_expired",
            fix: "Reconnect in Settings → Overleaf, then sync again.",
        }
    } else if error == SESSION_STILL_VALID {
        Failure {
            kind: "server_refused",
            fix: "Check the project still opens on Overleaf, then sync again.",
        }
    } else if error == PAUSED {
        Failure { kind: "paused", fix: "Resume syncing in Settings → Overleaf." }
    } else if error.starts_with("Could not reach Overleaf") {
        Failure { kind: "network", fix: "Check the connection (and any proxy), then sync again." }
    } else if error.starts_with("Overleaf returned") || error.starts_with("Overleaf rejected") {
        Failure {
            kind: "server_refused",
            fix: "Wait a minute and sync again; Overleaf may be busy.",
        }
    } else if error.contains("not linked") {
        Failure { kind: "not_linked", fix: "Link the project to Overleaf again." }
    } else if error.starts_with("Could not") && !error.contains("Overleaf") {
        Failure {
            kind: "local_io",
            fix: "Check the project folder is writable and the disk is not full.",
        }
    } else {
        Failure { kind: "sync_error", fix: "Sync again; if it repeats, report it with the log." }
    }
}
