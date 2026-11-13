//! What a finding asks of the writer, which orders the report
//! (`bibliography-audit.tsx` `bucketOf`), and what kind of change a fix is,
//! which decides whether Apply all may take it unread (`audit-groups.ts`):
//!
//! - "published": the entry becomes its published version or gains fields it
//!   left blank (a preprint's venue, DOI, pages); nothing the writer typed is
//!   overwritten except preprint markers (`howpublished = {arXiv preprint …}`,
//!   an arXiv link, the preprint's year);
//! - "cosmetic": the same words, braced or cased differently;
//! - "disputed": a value the entry states is replaced by a different one.
//!   Both may be right, so it waits for the writer.

use lattice_i18n::t;
use std::sync::LazyLock;

use regex::Regex;

use super::{Change, Finding};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Bucket {
    Fix,
    Review,
    Incomplete,
    Unchecked,
    Kept,
    Verified,
}

impl Bucket {
    pub const ORDER: [Bucket; 6] = [
        Bucket::Fix,
        Bucket::Review,
        Bucket::Incomplete,
        Bucket::Unchecked,
        Bucket::Kept,
        Bucket::Verified,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Bucket::Fix => t!("Fixes to review"),
            Bucket::Review => t!("Need your eyes"),
            Bucket::Incomplete => t!("Inconclusive"),
            Bucket::Unchecked => t!("Not checked yet"),
            Bucket::Kept => t!("Kept as written"),
            Bucket::Verified => t!("Verified"),
        }
    }
}

pub fn bucket(result: Option<&Finding>, applied: bool, kept: bool) -> Bucket {
    if applied {
        return Bucket::Verified;
    }
    let Some(result) = result else {
        return Bucket::Unchecked;
    };
    // An unverified candidate, or a verified work under a publisher's
    // notice, is the writer's call.
    if result.candidate.is_some() || (result.status == "checked" && result.has_notice()) {
        return if kept { Bucket::Kept } else { Bucket::Review };
    }
    if result.status == "update" && result.after.is_some() {
        return Bucket::Fix;
    }
    // A search that found no such publication finished, but verified nothing.
    if result.status == "checked" && result.publication_reason.as_deref() != Some("no_match") {
        return Bucket::Verified;
    }
    Bucket::Incomplete
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FixGroup {
    Published,
    Cosmetic,
    Disputed,
}

/// Entry types a preprint or unpublished record is filed under.
const PREPRINT_TYPES: [&str; 6] = [
    "misc",
    "unpublished",
    "online",
    "techreport",
    "preprint",
    "report",
];

fn words(value: &str) -> String {
    value
        .replace(['{', '}'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn is_preprint_venue(value: &str) -> bool {
    static PREPRINT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)arxiv|corr\b|preprint|biorxiv|medrxiv").unwrap());
    PREPRINT.is_match(value)
}

fn is_arxiv_link(value: &str) -> bool {
    static LINK: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)arxiv\.org/|doi\.org/10\.48550/").unwrap());
    LINK.is_match(value)
}

fn preprint_type(value: &str) -> bool {
    PREPRINT_TYPES.contains(&value.to_lowercase().as_str())
}

/// Whether `changes` move a preprint to its publication rather than edit a
/// published record.
fn becomes_published(changes: &[Change]) -> bool {
    changes.iter().any(|change| {
        (change.field == "ENTRYTYPE"
            && preprint_type(&change.before)
            && !preprint_type(&change.after))
            || (["howpublished", "journal", "booktitle"].contains(&change.field.as_str())
                && is_preprint_venue(&change.before)
                && !is_preprint_venue(&change.after))
    })
}

pub fn fix_group(changes: &[Change]) -> FixGroup {
    let published = becomes_published(changes);
    let mut cosmetic = true;
    for change in changes {
        if change.field != "ENTRYTYPE"
            && !change.before.is_empty()
            && words(&change.before) == words(&change.after)
        {
            continue;
        }
        cosmetic = false;
        let filled = change.before.trim().is_empty();
        let preprint_dropped = is_preprint_venue(&change.before)
            && (change.after.trim().is_empty() || !is_preprint_venue(&change.after));
        let link_published =
            change.field == "url" && is_arxiv_link(&change.before) && !is_arxiv_link(&change.after);
        // A preprint's type and year are the arXiv record's, not the
        // writer's call.
        let upgraded = published && (change.field == "ENTRYTYPE" || change.field == "year");
        if !(filled || preprint_dropped || link_published || upgraded) {
            return FixGroup::Disputed;
        }
    }
    if cosmetic {
        FixGroup::Cosmetic
    } else {
        FixGroup::Published
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(field: &str, before: &str, after: &str) -> Change {
        Change {
            field: field.into(),
            before: before.into(),
            after: after.into(),
        }
    }

    #[test]
    fn a_fix_is_published_cosmetic_or_disputed() {
        assert_eq!(
            fix_group(&[
                change("ENTRYTYPE", "misc", "inproceedings"),
                change("howpublished", "arXiv preprint arXiv:1706.03762", ""),
                change("booktitle", "", "NeurIPS"),
                change("year", "2017", "2018"),
            ]),
            FixGroup::Published
        );
        assert_eq!(
            fix_group(&[change("title", "{ARC} dataset", "ARC dataset")]),
            FixGroup::Cosmetic
        );
        assert_eq!(
            fix_group(&[change("publisher", "ACM", "IEEE")]),
            FixGroup::Disputed
        );
        assert_eq!(
            fix_group(&[change(
                "url",
                "https://arxiv.org/abs/1",
                "https://doi.org/10.1/x"
            )]),
            FixGroup::Published
        );
    }

    #[test]
    fn a_finding_lands_in_the_bucket_it_asks_for() {
        let finding = |status: &str| Finding {
            status: status.into(),
            ..Default::default()
        };
        assert_eq!(bucket(None, false, false), Bucket::Unchecked);
        assert_eq!(
            bucket(Some(&finding("checked")), false, false),
            Bucket::Verified
        );
        let update = Finding {
            after: Some("@misc{x}".into()),
            ..finding("update")
        };
        assert_eq!(bucket(Some(&update), false, false), Bucket::Fix);
        assert_eq!(bucket(Some(&update), true, false), Bucket::Verified);
        let candidate = Finding {
            candidate: Some(Default::default()),
            ..finding("checked")
        };
        assert_eq!(bucket(Some(&candidate), false, false), Bucket::Review);
        assert_eq!(bucket(Some(&candidate), false, true), Bucket::Kept);
        let none = Finding {
            publication_reason: Some("no_match".into()),
            ..finding("checked")
        };
        assert_eq!(bucket(Some(&none), false, false), Bucket::Incomplete);
        assert_eq!(
            bucket(Some(&finding("unavailable")), false, false),
            Bucket::Incomplete
        );
    }
}
