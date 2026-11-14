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
}
