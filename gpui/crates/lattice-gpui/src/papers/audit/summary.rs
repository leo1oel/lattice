//! The line under a row's title that says what its finding is about before
//! it is opened (`bibliography-audit.tsx` `summaryOf`), and the status names
//! it falls back on (`audit-messages.ts` `auditStatusLabel`).

use lattice_i18n::{join_list, t};

use super::{Bucket, Finding};

const BIBITEM: &str = "\\bibitem";

fn field_label(field: &str) -> String {
    match field {
        "title" => t!("Title"),
        "author" => t!("Authors"),
        "year" => t!("Year"),
        "journal" => t!("Journal"),
        "booktitle" => t!("Booktitle"),
        "publisher" => t!("Publisher"),
        "volume" => t!("Volume"),
        "number" => t!("Number"),
        "pages" => t!("Pages"),
        "doi" => "DOI",
        "url" => t!("URL"),
        "ENTRYTYPE" => t!("Entry type"),
        "venue" => t!("Venue"),
        other => other,
    }
    .to_string()
}

fn reason_label(reason: &str) -> String {
    match reason {
        "insufficient_identity" => t!("Insufficient identifying metadata").to_string(),
        "record" => t!("Record identity").to_string(),
        "arxiv" => t!("arXiv identifier").to_string(),
        other => field_label(other),
    }
}

fn source_name(source: &str) -> &str {
    match source {
        "dblp" => t!("DBLP"),
        "semanticscholar" => t!("Semantic Scholar"),
        "googlescholar" => t!("Google Scholar"),
        "crossref" => t!("Crossref"),
        "unpaywall" => t!("Unpaywall"),
        "openalex" => t!("OpenAlex"),
        "Crossref / official proceedings" => t!("Crossref / official proceedings"),
        "ICLR Proceedings" => t!("ICLR Proceedings"),
        "NeurIPS Proceedings" => t!("NeurIPS Proceedings"),
        other => other,
    }
}

/// A source that never answered, rather than answered "no".
fn is_silent(outcome: &str) -> bool {
    matches!(
        outcome,
        "rate_limited"
            | "queue_busy"
            | "daily_quota"
            | "blocked"
            | "timeout"
            | "connection_failed"
            | "network"
            | "unauthorized"
            | "malformed"
            | "forbidden"
            | "upstream_rate_limit"
            | "server_error"
            | "unavailable"
    ) || (outcome.starts_with("batch_") && outcome != "batch_reused")
}

fn status_label(result: &Finding, inline: bool) -> &'static str {
    let reason = result.publication_reason.as_deref();
    if result.status == "update" {
        return if inline {
            t!("Differs from the verified record")
        } else {
            t!("Update available")
        };
    }
    match reason {
        Some("missing_identity") => return t!("Reference lacks identifying metadata"),
        Some("no_match") => return t!("No matching publication found"),
        _ => {}
    }
    match result.status.as_str() {
        "unavailable" => match reason {
            Some("identity_conflict") => t!("Candidate does not match reference"),
            Some("metadata_unavailable") => t!("Independent metadata unavailable"),
            Some("sources_unavailable") => t!("Some sources unavailable"),
            Some("official_unavailable") => t!("Official verification incomplete"),
            _ => t!("Check incomplete"),
        },
        "skipped" => t!("Not verified"),
        "conflict" => t!("Entry changed"),
        _ => t!("No update found"),
    }
}

pub fn summary(result: Option<&Finding>, bucket: Bucket, inline: bool) -> String {
    let Some(result) = result else {
        return String::new();
    };
    match bucket {
        Bucket::Verified | Bucket::Unchecked => String::new(),
        Bucket::Kept if result.candidate.is_some() => {
            t!("You kept your entry over an unverified record").to_string()
        }
        Bucket::Kept => t!("You read the publisher's notice and kept citing it").to_string(),
        Bucket::Review => match &result.candidate {
            None => String::new(),
            Some(candidate) if !candidate.reasons.is_empty() => {
                let reasons: Vec<String> = candidate
                    .reasons
                    .iter()
                    .map(|reason| reason_label(reason))
                    .collect();
                t!("{0} differ from a source's record", join_list(&reasons))
            }
            Some(_) => status_label(result, inline).to_string(),
        },
        Bucket::Fix => fix_summary(result, inline),
        Bucket::Incomplete => {
            if result.status == "conflict" {
                return t!("Changed since the last check").to_string();
            }
            let mut silent: Vec<&str> = Vec::new();
            for source in result
                .sources
                .iter()
                .filter(|source| is_silent(&source.outcome))
            {
                let name = source_name(&source.source);
                if !silent.contains(&name) {
                    silent.push(name);
                }
            }
            if silent.is_empty() {
                status_label(result, inline).to_string()
            } else {
                t!("No answer from {0}", join_list(&silent))
            }
        }
    }
}

fn fix_summary(result: &Finding, inline: bool) -> String {
    let fields: Vec<String> = result
        .changes
        .iter()
        .map(|change| field_label(&change.field).to_lowercase())
        .collect();
    let fields = join_list(&fields);
    if inline {
        return t!(
            "Your {BIBITEM} differs: {fields}",
            BIBITEM = BIBITEM,
            fields = fields
        );
    }
    let venue = result.changes.iter().find(|change| {
        matches!(change.field.as_str(), "booktitle" | "journal") && !change.after.is_empty()
    });
    if let Some(venue) = venue
        && result
            .changes
            .iter()
            .any(|change| change.field == "ENTRYTYPE")
    {
        let published = venue.after.replace(['{', '}'], "");
        return t!("Published version: {published}", published = published);
    }
    if let [change] = result.changes.as_slice() {
        let shown = |value: &str| {
            if value.is_empty() {
                "—".to_string()
            } else {
                value.replace("--", "–")
            }
        };
        return format!(
            "{} {} → {}",
            field_label(&change.field),
            shown(&change.before),
            shown(&change.after)
        );
    }
    t!("Updates {fields}", fields = fields)
}

#[cfg(test)]
mod tests {
    use super::super::{Candidate, Change, Source};
    use super::*;

    fn finding(status: &str) -> Finding {
        Finding {
            status: status.into(),
            message: "Verified publication metadata is available.".into(),
            ..Default::default()
        }
    }

    fn change(field: &str, before: &str, after: &str) -> Change {
        Change {
            field: field.into(),
            before: before.into(),
            after: after.into(),
        }
    }

    // Expected lines are `summaryOf`'s, in bibliography-audit.tsx.
    #[test]
    fn verified_and_unchecked_rows_say_nothing_more() {
        let result = finding("checked");
        assert_eq!(summary(Some(&result), Bucket::Verified, false), "");
        assert_eq!(summary(None, Bucket::Unchecked, false), "");
    }

    #[test]
    fn an_inconclusive_row_names_the_sources_that_never_answered() {
        let mut result = finding("unavailable");
        result.publication_reason = Some("sources_unavailable".into());
        result.sources = vec![
            Source {
                source: "dblp".into(),
                outcome: "timeout".into(),
            },
            Source {
                source: "crossref".into(),
                outcome: "rate_limited".into(),
            },
            Source {
                source: "openalex".into(),
                outcome: "no_match".into(),
            },
            Source {
                source: "dblp".into(),
                outcome: "network".into(),
            },
        ];
        assert_eq!(
            summary(Some(&result), Bucket::Incomplete, false),
            "No answer from DBLP, Crossref"
        );
        result.sources.clear();
        assert_eq!(
            summary(Some(&result), Bucket::Incomplete, false),
            "Some sources unavailable"
        );
        let mut no_match = finding("checked");
        no_match.publication_reason = Some("no_match".into());
        assert_eq!(
            summary(Some(&no_match), Bucket::Incomplete, false),
            "No matching publication found"
        );
    }

    #[test]
    fn a_changed_reference_says_so() {
        let result = finding("conflict");
        assert_eq!(
            summary(Some(&result), Bucket::Incomplete, false),
            "Changed since the last check"
        );
    }

    #[test]
    fn a_fix_says_what_it_changes() {
        let mut result = finding("update");
        result.changes = vec![change("pages", "1--9", "")];
        assert_eq!(summary(Some(&result), Bucket::Fix, false), "Pages 1–9 → —");
        result.changes = vec![
            change("ENTRYTYPE", "misc", "inproceedings"),
            change("booktitle", "", "{NeurIPS}"),
        ];
        assert_eq!(
            summary(Some(&result), Bucket::Fix, false),
            "Published version: NeurIPS"
        );
        result.changes = vec![change("year", "2019", "2020"), change("doi", "", "10.1/x")];
        assert_eq!(
            summary(Some(&result), Bucket::Fix, false),
            "Updates year, doi"
        );
        assert_eq!(
            summary(Some(&result), Bucket::Fix, true),
            "Your \\bibitem differs: year, doi"
        );
    }

    #[test]
    fn a_candidate_names_the_fields_that_differ() {
        let mut result = finding("unavailable");
        result.candidate = Some(Candidate {
            reasons: vec!["title".into(), "arxiv".into()],
            ..Default::default()
        });
        assert_eq!(
            summary(Some(&result), Bucket::Review, false),
            "Title, arXiv identifier differ from a source's record"
        );
        assert_eq!(
            summary(Some(&result), Bucket::Kept, false),
            "You kept your entry over an unverified record"
        );
        result.candidate = None;
        assert_eq!(summary(Some(&result), Bucket::Review, false), "");
    }
}
