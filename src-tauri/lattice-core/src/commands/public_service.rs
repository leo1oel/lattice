//! When to route bibcite through Lattice's public literature service, and
//! what to do once that service refuses.
//!
//! The service (`literature_service::ENDPOINT`, `literature-worker/`) is one
//! budget shared by every installation: 5,000 upstream requests per provider
//! per UTC day, and 60 requests per minute per IP at the edge. bibcite only
//! uses it for a provider the writer has no personal access to (for Crossref,
//! no contact email in Settings). Once it answers `daily_quota`, every lookup
//! through it fails the same way until the next UTC day, and a DOI cite fails
//! outright, because bibcite resolves DOIs from Crossref alone.
//!
//! So a refusal pauses the routing for the process — until the next UTC
//! midnight for the daily budget, two minutes for a rate limit — and the run
//! that saw it is repeated once with bibcite talking to Crossref and OpenAlex
//! directly. Both are free public APIs that need no credential; direct access
//! is how bibcite works without Lattice, and how Lattice worked before the
//! service existed.

use super::bibcite_output_cancellable;
use std::process::{Command, Output};
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// The service spent its shared daily budget for the provider.
    DailyQuota,
    /// The edge rate limit, a busy queue or a provider rate limit.
    RateLimited,
}

const RATE_LIMIT_PAUSE: Duration = Duration::from_secs(120);

/// Until when bibcite talks to the providers directly, and why.
static PAUSE: Mutex<Option<(SystemTime, Refusal)>> = Mutex::new(None);

/// The refusal bibcite reported, from its diagnostics. bibcite 0.6.11 raises
/// `SourceUnavailable("public literature service <code>")` for the service's
/// 429 codes and "... rate-limited (429)" for an uncoded 429.
pub(crate) fn refusal_in(text: &str) -> Option<Refusal> {
    if text.contains("public literature service daily_quota") {
        Some(Refusal::DailyQuota)
    } else if [
        "public literature service upstream_rate_limit",
        "public literature service queue_busy",
        "public literature service rate-limited",
    ]
    .iter()
    .any(|marker| text.contains(marker))
    {
        Some(Refusal::RateLimited)
    } else {
        None
    }
}

fn pause_until(refusal: Refusal, now: SystemTime) -> SystemTime {
    match refusal {
        // The service counts requests per UTC date; Unix days are exactly
        // 86,400 seconds, so the next multiple is the next UTC midnight.
        Refusal::DailyQuota => {
            let seconds = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            UNIX_EPOCH + Duration::from_secs((seconds / 86_400 + 1) * 86_400)
        }
        Refusal::RateLimited => now + RATE_LIMIT_PAUSE,
    }
}

pub(crate) fn record(refusal: Refusal) {
    let now = SystemTime::now();
    let until = pause_until(refusal, now);
    let mut pause = PAUSE.lock().unwrap_or_else(PoisonError::into_inner);
    // A rate limit never shortens a daily-budget pause.
    if pause.is_none_or(|(current, _)| current < until) {
        *pause = Some((until, refusal));
    }
}

/// The refusal still in force, if any.
pub(crate) fn paused() -> Option<Refusal> {
    let mut pause = PAUSE.lock().unwrap_or_else(PoisonError::into_inner);
    match *pause {
        Some((until, refusal)) if until > SystemTime::now() => Some(refusal),
        Some(_) => {
            *pause = None;
            None
        }
        None => None,
    }
}

#[cfg(all(test, unix))]
pub(crate) fn reset() {
    *PAUSE.lock().unwrap_or_else(PoisonError::into_inner) = None;
}

/// For the Agent and the writer: why lookups are going straight to the
/// providers today, and what makes that unnecessary.
pub(crate) fn note() -> Option<String> {
    let reason = match paused()? {
        Refusal::DailyQuota => "has used up today's quota",
        Refusal::RateLimited => "is rate-limiting requests right now",
    };
    Some(format!(
        "Lattice's shared literature service {reason}, so Lattice is querying Crossref and \
         OpenAlex directly. If those also fail, retry later, or add a Crossref contact email \
         under Settings → Literature services to use Crossref's own pool."
    ))
}

/// Run the bibcite command `build` makes, and if Lattice's public literature
/// service refused it, pause the routing and run it once more, now direct,
/// within what is left of `timeout`.
pub(crate) fn bibcite_output_routed(
    build: &dyn Fn() -> Result<Command, String>, timeout: Duration, cancel: &AtomicBool,
) -> Result<Output, String> {
    let started = Instant::now();
    let routed = paused().is_none();
    let output = bibcite_output_cancellable(&mut build()?, timeout, cancel)?;
    if !routed {
        return Ok(output);
    }
    let text = [&output.stdout, &output.stderr].map(|stream| String::from_utf8_lossy(stream));
    let Some(refusal) = text.iter().find_map(|stream| refusal_in(stream)) else {
        return Ok(output);
    };
    record(refusal);
    let left = timeout.saturating_sub(started.elapsed());
    if left < Duration::from_secs(1) {
        return Ok(output);
    }
    log::info!(target: "lattice::literature", "public literature service refused ({refusal:?}); retrying bibcite directly");
    bibcite_output_cancellable(&mut build()?, left, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_are_read_from_bibcite_diagnostics_and_pause_until_they_clear() {
        let stderr =
            "[bibcite] internal error: SourceUnavailable: public literature service daily_quota\n";
        assert_eq!(refusal_in(stderr), Some(Refusal::DailyQuota));
        for limited in [
            "public literature service upstream_rate_limit",
            "public literature service queue_busy",
            "public literature service rate-limited (429)",
        ] {
            assert_eq!(refusal_in(limited), Some(Refusal::RateLimited), "{limited}");
        }
        assert_eq!(refusal_in("CrossRef rate-limited (429)"), None);

        // 2026-11-16T13:20:00Z → the next UTC midnight, 2026-11-17T00:00:00Z.
        let now = UNIX_EPOCH + Duration::from_secs(1_794_787_200 + 13 * 3600 + 1200);
        let midnight = UNIX_EPOCH + Duration::from_secs(1_794_873_600);
        assert_eq!(pause_until(Refusal::DailyQuota, now), midnight);
        assert_eq!(pause_until(Refusal::RateLimited, now), now + RATE_LIMIT_PAUSE);
    }
}
