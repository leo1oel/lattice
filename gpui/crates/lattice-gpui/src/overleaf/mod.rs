//! Overleaf in the GPUI app, as the Tauri app has it (`src/overleaf/`,
//! `src/app/use-overleaf-workspace.ts` and `src-tauri/src/ipc/overleaf*.rs`),
//! on lattice-core's Overleaf bridge (`lattice_core::overleaf`, the REST
//! sync, and `overleaf_rt`, the Socket.IO channel):
//!
//! - [`account`]: the signed-in session, the sign-in window and signing out.
//! - [`picker`]: "Open from Overleaf": browse the account's projects (or
//!   paste a link), download one or open the folder already linked to it,
//!   or upload the open project as a new one.
//! - [`bridge`]: one window's link to Overleaf: syncing (by hand, and in
//!   live mode on its own), the channel that joins the project, the manual
//!   mode's badge, and the warnings and conflicts a sync leaves.
//! - [`review`]: manual mode's "Review changes" before a sync writes.
//! - [`download`] and [`outcome`]: what a download and a finished sync say.
//!
//! Nothing here talks to Overleaf except through lattice-core.

pub mod account;
pub mod bridge;
mod channel;
pub mod download;
pub mod outcome;
pub(crate) mod parts;
pub mod picker;
mod remote_deletes;
pub mod review;
pub(crate) mod sync;

use std::{
    path::PathBuf,
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};

use gpui::{App, Global};

pub use bridge::{ChannelStatus, OverleafBridge, OverleafBridgeEvent};

/// Where the GPUI app keeps its Overleaf session and the list of folders
/// linked to Overleaf projects: its own data folder, never the Tauri app's,
/// so signing in or out here leaves the Tauri app's session alone.
pub fn config_dir() -> PathBuf {
    std::env::var_os("LATTICE_GPUI_OVERLEAF_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::data_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join("lattice-gpui")
                .join("overleaf")
        })
}

/// The Overleaf server a sign-in goes to, when not overleaf.com: set only by
/// a scripted run, which signs in to its own stand-in.
static HOST: Mutex<Option<String>> = Mutex::new(None);

/// The Overleaf server new sign-ins go to.
pub fn host() -> String {
    HOST.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .unwrap_or_else(|| lattice_core::overleaf::normalize_host(""))
}

/// Sign in to `host` instead of overleaf.com, for the e2e scenario's
/// stand-in (`scenario::overleaf_mock`).
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn use_host_for_scenario(host: String) {
    *HOST.lock().unwrap_or_else(PoisonError::into_inner) = Some(host);
}

/// Where Overleaf projects are downloaded to, as the Tauri app puts them:
/// `Documents/Overleaf Projects`.
pub fn projects_dir() -> Result<PathBuf, String> {
    let documents = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or_else(|| "Could not resolve Documents folder".to_string())?;
    let folder = documents.join("Overleaf Projects");
    std::fs::create_dir_all(&folder)
        .map_err(|error| format!("Could not create the Overleaf Projects folder: {error}"))?;
    Ok(folder)
}

/// A request's result once the account has had its say: an answer that
/// looked signed out is checked against Overleaf's dashboard
/// (`settle_session_error`). Blocking; also says whether the session was
/// found dead, which the caller announces with [`session_changed`].
pub fn settled<T>(result: Result<T, String>) -> (Result<T, String>, bool) {
    match result {
        Err(error) if lattice_core::overleaf::is_session_rejection(&error) => {
            let (error, expired) =
                lattice_core::overleaf::settle_session_error(&config_dir(), error);
            (Err(error), expired)
        }
        other => (other, false),
    }
}

/// Bumped whenever the account's session changes (signed in, signed out, or
/// found expired by any request), so every window's Settings, picker and
/// link re-read where the account stands, as the Tauri app's
/// `overleaf-session` event has them.
#[derive(Default)]
pub struct SessionGeneration(pub u64);

impl Global for SessionGeneration {}

/// Tell every window the session changed.
pub fn session_changed(cx: &mut App) {
    let next = cx.try_global::<SessionGeneration>().map_or(1, |g| g.0 + 1);
    cx.set_global(SessionGeneration(next));
    cx.refresh_windows();
}

/// The session generation, which a window compares against the one it read.
pub fn session_generation(cx: &App) -> u64 {
    cx.try_global::<SessionGeneration>().map_or(0, |g| g.0)
}

/// At most one full project download per this interval, across every window
/// (Overleaf answers 429 past ten project downloads a minute).
const FULL_SYNC_MIN_GAP: Duration = Duration::from_secs(7);

static DOWNLOAD_STARTED: Mutex<Option<Instant>> = Mutex::new(None);

/// How long a download that starts at `now` waits after one that started at
/// `previous`.
fn full_sync_delay(previous: Option<Instant>, now: Instant) -> Duration {
    previous
        .map(|started| (started + FULL_SYNC_MIN_GAP).saturating_duration_since(now))
        .unwrap_or_default()
}

/// Wait out the account-wide cooldown since the previous project download,
/// then stamp this one's start: the gate a sync passes just before it
/// downloads the ZIP, and only then. Blocking, on the sync's own thread; the
/// stamp is not held while waiting, so downloads queued behind it start one
/// interval apart.
pub fn wait_for_download_gap() {
    loop {
        let delay = {
            let mut previous = DOWNLOAD_STARTED
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let now = Instant::now();
            let delay = full_sync_delay(*previous, now);
            if delay.is_zero() {
                *previous = Some(now);
                return;
            }
            delay
        };
        std::thread::sleep(delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_download_waits_out_the_gap_since_the_previous_one() {
        let now = Instant::now();
        assert_eq!(full_sync_delay(None, now), Duration::ZERO);
        assert_eq!(
            full_sync_delay(Some(now), now + Duration::from_secs(2)),
            Duration::from_secs(5)
        );
        assert_eq!(
            full_sync_delay(Some(now), now + Duration::from_secs(9)),
            Duration::ZERO
        );
    }
}
