//! Free-text queries the title resolvers cannot take: a single word, which
//! names no one work, and a reference written out with its authors and year
//! ("Fiser & Aslin 2002 Statistical learning of …", or a whole formatted
//! reference), which no title index matches because the authors and year
//! are read as part of the title.
//!
//! A written-out reference is looked up with Crossref's bibliographic search,
//! which ranks a citation string against whole records, and a candidate is
//! accepted only when the query contains its complete title and agrees with
//! its year and first author; the work is then cited by its DOI, so the
//! entry is the publisher's record. Anything less certain stays an error
//! that says what to supply instead.

use crate::papers::is_web_url;
use crate::project;
use serde_json::Value;
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

/// What to give instead, appended to every refusal.
const SUPPLY_INSTEAD: &str = "Give the work's full title (its authors and year help), its DOI, or its arXiv id or URL; for a dataset, model or code release without a paper, give its web page or GitHub URL.";

/// Whether `query` is free text: no URL, DOI, arXiv id or BibTeX.
pub(super) fn is_free_text(query: &str) -> bool {
    let query = query.trim();
    !is_web_url(query)
        && !query.starts_with('@')
        && project::normalize_doi(query).is_none()
        && super::ids::explicit_arxiv_id(query).is_none()
        && super::ids::parse_arxiv_id(query).as_deref() != Some(query)
}

/// Refuse a free-text query of one word before any lookup: an acronym or a
/// name ("SPAR", "RealWorldQA") is not a title, and an exact one-word title
/// match is as likely another work (a lookup of "SPAR" returned a 2003 poem
/// of that title).
pub(super) fn refuse_single_word(query: &str) -> Result<(), String> {
    if is_free_text(query) && query.split_whitespace().count() < 2 {
        return Err(format!(
            "\"{}\" is a single word, which cannot identify one work: unrelated works share one-word titles, and an acronym or a dataset's name is not a title. {SUPPLY_INSTEAD}",
            query.trim()
        ));
    }
    Ok(())
}

/// The error for a free-text query nothing resolved, leading with what to
/// do; the resolvers' log follows for diagnosis.
pub(super) fn not_found(query: &str, log: &str) -> String {
    format!(
        "No publication matching \"{}\" was found (searched by title in OpenAlex, DBLP and Crossref, and as a reference in Crossref). {SUPPLY_INSTEAD}\n{log}",
        query.trim()
    )
}

/// The DOI of the one work a written-out reference describes, when Crossref's
/// bibliographic search finds a record that `query` matches (see
/// [`accepts`]). `None` when nothing matches with certainty.
pub(super) fn find_reference_doi(query: &str) -> Result<Option<String>, String> {
    if !is_free_text(query) || query.split_whitespace().count() < 4 {
        return Ok(None);
    }
    let client = crate::http::blocking_as("Lattice reference lookup", Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let report: Value = client
        .get("https://api.crossref.org/works")
        .query(&[
            ("query.bibliographic", query),
            ("rows", "5"),
            ("select", "DOI,title,author,issued,type"),
        ])
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.json())
        .map_err(|error| format!("Crossref's reference search failed: {error}"))?;
    let items = report["message"]["items"].as_array().cloned().unwrap_or_default();
    Ok(items
        .iter()
        .find(|item| accepts(query, item))
        .and_then(|item| item["DOI"].as_str().map(str::to_string)))
}

/// Lowercase ASCII words, accents folded ("József" → "jozsef").
fn words(value: &str) -> String {
    value
        .nfkd()
        .filter(char::is_ascii)
        .collect::<String>()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

/// A Crossref record is the work `query` describes only when the query holds
/// its whole title (of three words or more, so a short title cannot match by
/// accident), its first author's family name when it has authors, and its
/// year (or the next, for a print date after the online one) when the query
/// names a year.
pub(super) fn accepts(query: &str, item: &Value) -> bool {
    let haystack = format!(" {} ", words(query));
    let Some(title) = item["title"][0].as_str().map(words) else { return false };
    if title.split(' ').count() < 3 || !haystack.contains(&format!(" {title} ")) {
        return false;
    }
    let first_author = item["author"][0]["family"].as_str().map(words);
    if first_author
        .is_some_and(|family| !family.is_empty() && !haystack.contains(&format!(" {family} ")))
    {
        return false;
    }
    let years: Vec<i64> = haystack
        .split(' ')
        .filter(|word| word.len() == 4 && (word.starts_with("19") || word.starts_with("20")))
        .filter_map(|word| word.parse().ok())
        .collect();
    let issued = item["issued"]["date-parts"][0][0].as_i64();
    years.is_empty()
        || issued.is_some_and(|year| years.iter().any(|named| year == *named || year == named + 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(title: &str, family: &str, year: i64) -> Value {
        json!({"DOI": "10.1073/pnas.232472899", "title": [title], "author": [{"family": family}], "issued": {"date-parts": [[year]]}})
    }

    #[test]
    fn a_written_out_reference_matches_only_its_own_record() {
        let pnas = record(
            "Statistical learning of new visual feature combinations by infants",
            "Fiser",
            2002,
        );
        for query in [
            "Fiser Aslin 2002 Statistical learning of new visual feature combinations by infants",
            "Fiser, J., & Aslin, R. N. (2002). Statistical learning of new visual feature combinations by infants. PNAS, 99(24), 15822-15826.",
            "Statistical learning of new visual feature combinations by infants (Fiser and Aslin)",
        ] {
            assert!(accepts(query, &pnas), "{query}");
        }
        // Another year, another first author, or a title the query does not hold.
        let query =
            "Fiser Aslin 2002 Statistical learning of new visual feature combinations by infants";
        assert!(!accepts(
            query,
            &record(
                "Statistical learning of new visual feature combinations by infants",
                "Fiser",
                2005
            )
        ));
        assert!(!accepts(
            query,
            &record(
                "Statistical learning of new visual feature combinations by infants",
                "Kirkham",
                2002
            )
        ));
        assert!(!accepts(
            query,
            &record("Statistical learning of visual feature combinations", "Fiser", 2002)
        ));
        assert!(!accepts(query, &record("Statistical learning", "Fiser", 2002)));
        // Accents fold: Crossref's "Fisér" is the query's "Fiser".
        assert!(accepts(
            query,
            &record(
                "Statistical learning of new visual feature combinations by infants",
                "Fisér",
                2002
            )
        ));
    }

    #[test]
    fn a_single_word_is_refused_but_identifiers_are_not() {
        for query in ["SPAR", "  RealWorldQA "] {
            let error = refuse_single_word(query).unwrap_err();
            assert!(error.contains("single word") && error.contains("GitHub URL"), "{error}");
        }
        for query in [
            "Mask R-CNN",
            "10.1073/pnas.232472899",
            "2503.22976",
            "https://x.ai/news/grok-1.5v",
            "@misc{a, title={A}}",
        ] {
            assert!(refuse_single_word(query).is_ok(), "{query}");
        }
    }
}
