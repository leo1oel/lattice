//! The cheap "did anything change over there?" check live mode polls, and the
//! one HTTP client it keeps between polls.

use super::super::api::{expect_success, http_client, latest_update_version, send_as, Remote};
use super::super::files::local_files_changed;
use crate::util::err;
use reqwest::blocking::Client;
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// Result of the cheap remote-change check that live mode polls.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverleafProbe {
    /// True when Overleaf has moved on since our last sync.
    pub changed: bool,
    /// True when a requested local check found files that differ from the last
    /// sync. Ordinary polling leaves this false so it stays a cheap network
    /// version check rather than rereading the project every few seconds.
    pub local_changed: bool,
    /// False when this instance does not tell us a version, in which case
    /// `changed` is meaningless and polling cannot be used to drive syncing.
    pub version_known: bool,
    pub remote_version: Option<i64>,
    pub last_sync: Option<String>,
}

/// The probe's deadline.
const PROBE_TIMEOUT_SECS: u64 = 15;
/// How long the probe keeps one client. A client reads the system proxy when
/// it is built, so it is rebuilt now and then (and after any failure to reach
/// Overleaf) for a proxy switched on or off meanwhile to take effect.
const PROBE_CLIENT_TTL: Duration = Duration::from_secs(300);
/// The probe's client for each Overleaf host, with when it was built.
static PROBE_CLIENTS: Mutex<BTreeMap<String, (Instant, Client)>> = Mutex::new(BTreeMap::new());

/// One client per host for the probe, which live sync runs every few seconds
/// while its channel is down. A client per probe meant a new connection pool,
/// a runtime thread and a full TLS handshake every time; this one keeps its
/// connection open between probes.
fn probe_client(host: &str) -> Result<Client, String> {
    let mut clients = PROBE_CLIENTS.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((built, client)) = clients.get(host) {
        if built.elapsed() < PROBE_CLIENT_TTL {
            return Ok(client.clone());
        }
    }
    let client = http_client(PROBE_TIMEOUT_SECS)?;
    clients.insert(host.to_string(), (Instant::now(), client.clone()));
    #[cfg(test)]
    {
        *PROBE_CLIENT_BUILDS.lock().unwrap().entry(host.to_string()).or_default() += 1;
    }
    Ok(client)
}

/// How many probe clients were built for each host. A connection count would
/// say more, but a system proxy (whose bypass list covers the loopback test
/// server) keeps the pool from reusing loopback connections on some machines.
#[cfg(test)]
pub(in crate::overleaf) static PROBE_CLIENT_BUILDS: Mutex<BTreeMap<String, usize>> =
    Mutex::new(BTreeMap::new());

/// Cheap "did anything change over there?" check.
///
/// Overleaf's history API reports the project's newest version in a small JSON
/// payload, so this can run every few seconds — unlike a full sync, which
/// downloads the whole project as a zip. Live mode polls this and only syncs
/// for real when the version moved.
pub fn probe(
    config_dir: &Path, root: &Path, local_live_paths: Option<&BTreeSet<String>>,
) -> Result<OverleafProbe, String> {
    let remote = Remote::open(config_dir, root)?;
    let state = &remote.state;
    let local_changed = !state.pending_relocations.is_empty()
        || local_live_paths
            .map(|live| local_files_changed(root, state, live))
            .transpose()?
            .unwrap_or(false);
    let request =
        remote.request(&probe_client(&remote.host)?, Method::GET, "/updates?min_count=1", None);
    let response = send_as(request, |error| {
        PROBE_CLIENTS.lock().unwrap_or_else(PoisonError::into_inner).remove(&remote.host);
        format!("Could not reach Overleaf: {error}")
    })?;
    let body: Value = expect_success(response, "for the project history")?.json().map_err(err)?;
    let remote_version = latest_update_version(&body);
    Ok(OverleafProbe {
        changed: match (remote_version, state.remote_version) {
            (Some(remote), Some(known)) => remote != known,
            // First look with a usable version: sync once to set the baseline.
            (Some(_), None) => true,
            // No version to compare. Saying "changed" here would download the
            // whole project on every poll, which is what earned a 429.
            (None, _) => false,
        },
        local_changed,
        version_known: remote_version.is_some(),
        remote_version,
        last_sync: remote.state.last_sync,
    })
}
