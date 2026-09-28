//! The arXiv identifier grammar, and the keys bundles are stored under.

use regex::Regex;
use std::sync::LazyLock;

/// A modern (`2401.12345v2`) or legacy (`math.GT/0211159`) arXiv id.
const ARXIV_ID: &str = r"\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?";

static WHOLE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)^(?:{ARXIV_ID})$")).unwrap());
/// The word boundaries matter now that anything else is a valid entry: without
/// them the digits inside a DOI like `10.1145/3292500.3330701` match the modern
/// shape, and the app would look for a paper that does not exist instead of
/// asking bibcite to resolve the DOI.
static ID_IN_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)\b({ARXIV_ID})\b")).unwrap());
/// A bare id or an arXiv abs/pdf/html URL, and nothing else.
static EXPLICIT_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)^(?:https?://(?:www\.|export\.)?arxiv\.org/(?:abs|pdf|html)/)?(?:{ARXIV_ID})(?:\.pdf)?(?:[?#].*)?$"
    ))
    .unwrap()
});
static WEB_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^web-[0-9a-f]{16}$").unwrap());

pub(crate) fn arxiv_base_id(arxiv_id: &str) -> &str {
    match arxiv_id.rsplit_once('v') {
        Some((base, version))
            if !base.is_empty() && version.chars().all(|c| c.is_ascii_digit()) =>
        {
            base
        }
        _ => arxiv_id,
    }
}

/// Two ids name the same work when they agree up to the version suffix.
pub(super) fn same_arxiv_work(left: &str, right: &str) -> bool {
    arxiv_base_id(left).eq_ignore_ascii_case(arxiv_base_id(right))
}

pub(super) fn validate_arxiv_id(arxiv_id: &str) -> Result<(), String> {
    if WHOLE_ID.is_match(arxiv_id) {
        Ok(())
    } else {
        Err("Invalid arXiv id.".to_string())
    }
}

/// A bundle key under `.research/papers`: an arXiv id, or the digest name of a
/// captured webpage. Everything that only reads bundles takes this; fetching
/// keeps the strict arXiv check because only arXiv is fetchable by id.
pub(super) fn validate_paper_key(key: &str) -> Result<(), String> {
    if WEB_KEY.is_match(key) {
        return Ok(());
    }
    validate_arxiv_id(key)
}

/// An arXiv id inside whatever was typed, if there is one.
pub(super) fn parse_arxiv_id(input: &str) -> Option<String> {
    ID_IN_TEXT.captures(input.trim()).map(|capture| capture[1].to_string())
}

/// The arXiv id of an input that names nothing but an arXiv work: a bare id,
/// an arXiv URL, or arXiv's own DOI. `parse_arxiv_id` also extracts ids from
/// arbitrary text, and this must not mistake a title or an unrelated publisher
/// URL for that paper.
pub(crate) fn explicit_arxiv_id(query: &str) -> Option<String> {
    if EXPLICIT_ID.is_match(query.trim()) {
        return parse_arxiv_id(query);
    }
    let doi = crate::project::normalize_doi(query)?;
    doi.strip_prefix("10.48550/arxiv.")
        .filter(|id| validate_arxiv_id(id).is_ok())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_arxiv_ids_but_not_the_digits_inside_dois_or_titles() {
        for (input, expected) in [
            ("https://arxiv.org/abs/2401.12345", Some("2401.12345")),
            ("2401.12345v2", Some("2401.12345v2")),
            ("not a paper", None),
            // Anything that is not an arXiv paper has to reach bibcite untouched.
            ("10.1145/3292500.3330701", None),
            ("https://doi.org/10.1038/s41586-021-03819-2", None),
            ("Attention Is All You Need", None),
            ("https://example.edu/blog/2024/some-post", None),
            // Longer than any arXiv id, so it is not one with the tail ignored.
            ("2401.123456789", None),
            // Still found inside a real URL, which is what people paste.
            ("see https://arxiv.org/pdf/2401.12345v3 for details", Some("2401.12345v3")),
            ("https://arxiv.org/abs/math.GT/0211159v2", Some("math.GT/0211159v2")),
        ] {
            assert_eq!(parse_arxiv_id(input).as_deref(), expected, "{input}");
        }
    }
}
