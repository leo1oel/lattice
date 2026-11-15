//! A check's result message in the interface language, when it is one
//! lattice-core wrote (`audit-messages.ts` `auditResultMessage`): keyed by
//! the exact English the checks write, which is also the catalog's msgid.

use lattice_i18n::{n, t, tr};

const RESULT_MESSAGES: [&str; 20] = [
    n!("The bibliography entry changed after the scan."),
    n!("The bibliography entry no longer exists."),
    n!("Kept as a preprint because pubstate is explicitly preprint."),
    n!("No upgrade check was performed for this entry."),
    n!("Preprint check returned an incomplete or ambiguous result."),
    n!("bibcite returned invalid upgrade JSON."),
    n!("No published version was found."),
    n!("The published version could not be confirmed."),
    n!("Verified publication metadata is available."),
    n!("Publication metadata was verified, but the citation-health check was incomplete."),
    n!("Metadata may be available, but the citation-health check was incomplete."),
    n!("Could not safely preserve this entry's BibTeX expressions."),
    n!("DOI metadata corrections are available."),
    n!(
        "Bibliography cleanup is available. Only the proposed changes will be applied; rejected source metadata is not used."
    ),
    n!("The inline reference agrees with the verified record."),
    n!("A published version of this preprint exists. Inline references are edited by hand."),
    n!(
        "The verified record differs from this inline reference. Inline references are edited by hand."
    ),
    n!("A published version is available."),
    n!("Reference changed since the last check. Check this reference again."),
    n!("The check's answer could not be read."),
];

const METADATA_INCOMPLETE: &str = "Metadata check incomplete: ";
const PREPRINT_INCOMPLETE: &str = "Preprint check incomplete: ";

pub fn result_message(message: &str) -> String {
    if message == "No update found." {
        return t!("No update found").to_string();
    }
    if let Some(known) = RESULT_MESSAGES.iter().find(|known| **known == message) {
        return tr(known).to_string();
    }
    // The detail after the prefix is the lookup tool's own error text.
    if let Some(error) = message.strip_prefix(METADATA_INCOMPLETE) {
        return t!("Metadata check incomplete: {error}", error = error);
    }
    if let Some(error) = message.strip_prefix(PREPRINT_INCOMPLETE) {
        return t!("Preprint check incomplete: {error}", error = error);
    }
    message.to_string()
}

/// What the expanded row says of a check (`publicationMessage`): its
/// publication lookup's reason, else its message; none when the sources
/// that did not answer, listed under it, say it all.
pub fn publication_message(message: &str, reason: Option<&str>) -> Option<String> {
    let Some(reason) = reason else {
        return Some(result_message(message));
    };
    Some(match reason {
        "identity_conflict" => t!("A possible record conflicts with this reference"),
        "metadata_unavailable" => t!("No independent metadata to verify a possible record"),
        "missing_identity" => t!(
            "Add a title, full authors, and year, or add a DOI or arXiv identifier, before checking this reference."
        ),
        "no_match" | "no_published_version" => {
            t!("No matching publication was found in the sources checked.")
        }
        "sources_unavailable" => return None,
        "official_unavailable" => {
            t!("An index matched, but the official proceedings could not be reached")
        }
        "ambiguous" => t!("No unique matching publication"),
        _ => t!("The publication lookup could not be completed. Try again later."),
    }
    .to_string())
}

/// What a source answered about a reference, as the report says it.
const SOURCE_OUTCOMES: [(&str, &str); 30] = [
    ("matched", n!("Verified publication match")),
    ("selected", n!("Metadata source")),
    ("selected_cached", n!("Metadata source (cached)")),
    ("candidate", n!("Candidate record considered, not verified")),
    (
        "candidate_cached",
        n!("Candidate record considered, not verified (cached record)"),
    ),
    (
        "not_configured",
        n!("Not enabled. Add your own API key in Settings"),
    ),
    ("no_match", n!("No published version found")),
    ("rate_limited", n!("Rate limited")),
    ("batch_reused", n!("Batch result reused")),
    ("queue_busy", n!("Request queue busy")),
    ("daily_quota", n!("Public daily quota exhausted")),
    (
        "batch_rate_limited",
        n!("Rate limited; subsequent Semantic Scholar queries skipped"),
    ),
    (
        "batch_queue_busy",
        n!("Request queue busy; subsequent Semantic Scholar queries skipped"),
    ),
    (
        "batch_daily_quota",
        n!("Public daily quota exhausted; subsequent Semantic Scholar queries skipped"),
    ),
    (
        "batch_upstream_rate_limit",
        n!("Semantic Scholar rate limited the service; subsequent queries skipped"),
    ),
    (
        "batch_unauthorized",
        n!("Semantic Scholar authorization failed; subsequent queries skipped"),
    ),
    (
        "batch_network",
        n!("Semantic Scholar connection failed; subsequent queries skipped"),
    ),
    (
        "batch_malformed",
        n!("Semantic Scholar returned an invalid response; subsequent queries skipped"),
    ),
    (
        "batch_timeout",
        n!("Semantic Scholar request timed out; subsequent queries skipped"),
    ),
    (
        "batch_unavailable",
        n!("Semantic Scholar unavailable; subsequent queries skipped"),
    ),
    ("blocked", n!("Requests blocked")),
    ("timeout", n!("Request timed out")),
    ("connection_failed", n!("Connection failed")),
    ("network", n!("Network connection failed")),
    ("unauthorized", n!("Authorization failed")),
    ("malformed", n!("Invalid response from source")),
    ("forbidden", n!("Access forbidden by provider")),
    ("upstream_rate_limit", n!("Source rate limit reached")),
    ("server_error", n!("Source service error")),
    ("unavailable", n!("Source temporarily unavailable")),
];

/// A source's answer in the interface language (`auditSourceOutcome`);
/// `status` is the whole finding's. A report saved before candidate
/// outcomes existed may call a source selected on a result that is
/// unavailable, which does not read as verified.
pub fn source_outcome(status: &str, outcome: &str) -> String {
    match (status, outcome) {
        ("unavailable", "selected") => t!("Source record considered, not verified").to_string(),
        ("unavailable", "selected_cached") => {
            t!("Source record considered, not verified (cached record)").to_string()
        }
        _ => SOURCE_OUTCOMES
            .iter()
            .find(|(code, _)| *code == outcome)
            .map_or_else(
                || t!("Unknown source response").to_string(),
                |(_, message)| tr(message).to_string(),
            ),
    }
}

/// A check's time as the report keeps it (seconds since the epoch, or the
/// RFC 3339 the health check and the Tauri app write), in local time.
pub fn checked_time(at: &str) -> Option<String> {
    let at = match at.parse::<i64>() {
        Ok(seconds) => chrono::DateTime::from_timestamp(seconds, 0)?.fixed_offset(),
        Err(_) => chrono::DateTime::parse_from_rfc3339(at).ok()?,
    };
    Some(
        at.with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M")
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// bibliography-audit.tsx `publicationMessage`'s branches.
    #[test]
    fn a_reason_says_what_the_lookup_found() {
        assert_eq!(
            publication_message("x", Some("no_match")).as_deref(),
            Some("No matching publication was found in the sources checked.")
        );
        assert_eq!(publication_message("x", Some("sources_unavailable")), None);
        assert_eq!(
            publication_message("x", Some("something_new")).as_deref(),
            Some("The publication lookup could not be completed. Try again later.")
        );
        assert_eq!(
            publication_message("No update found.", None).as_deref(),
            Some("No update found")
        );
    }

    // `auditSourceOutcome` (src/papers/audit-messages.ts): an unknown code
    // reads as an unknown response, and a "selected" source on an
    // unavailable result is only considered.
    #[test]
    fn a_source_outcome_reads_as_the_tauri_report_says() {
        assert_eq!(
            source_outcome("verified", "matched"),
            "Verified publication match"
        );
        assert_eq!(
            source_outcome("unavailable", "batch_timeout"),
            "Semantic Scholar request timed out; subsequent queries skipped"
        );
        assert_eq!(
            source_outcome("unavailable", "selected"),
            "Source record considered, not verified"
        );
        assert_eq!(source_outcome("verified", "selected"), "Metadata source");
        assert_eq!(source_outcome("verified", ""), "Unknown source response");
        assert_eq!(
            source_outcome("verified", "made_up"),
            "Unknown source response"
        );
    }

    #[test]
    fn a_check_time_reads_from_seconds_or_rfc3339() {
        assert_eq!(checked_time("0"), checked_time("1970-01-01T00:00:00Z"));
        assert!(checked_time("2026-11-14T09:05:07Z").is_some());
        assert_eq!(checked_time("yesterday"), None);
    }
}
