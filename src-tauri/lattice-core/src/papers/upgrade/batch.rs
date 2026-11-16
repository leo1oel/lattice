//! Checking the bibliography's preprints one entry at a time, a few at once,
//! within the request's deadline.
//!
//! bibcite's `upgrade` walks a whole file serially, sleeping a second between
//! preprints to be polite to the APIs, and each preprint asks several sources
//! (DBLP, OpenAlex, Crossref). A dozen preprints took 37 s, while the Agent's
//! bibliography requests are abandoned after 30 s (Synara's
//! `LATTICE_BIBLIOGRAPHY_TOOL_TIMEOUT_MS`): every upgrade the Agent asked for
//! timed out while its run went on unseen, and each retry started the whole
//! batch again beside it, multiplying lookups against the shared literature
//! service until its daily budget ran out.
//!
//! So Lattice picks the preprints itself, by bibcite's own rule
//! (`is_preprint`), and runs bibcite on each alone in a scratch file,
//! `WORKERS` at a time. The deadline bounds the batch: a preprint not checked
//! by then is reported pending, and calling again continues with it, because
//! every answer is remembered (`CHECKED`) for the exact entry text it was
//! about.

use super::super::bibliography::{parse_report, ScratchBibliography};
use super::{merge_upgrade, validate_bibliography_upgrade};
use crate::commands;
use crate::project;
use crate::ttl_cache::TtlCache;
use crate::util::sha256_hex;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// bibcite runs at once. Each lookup spends the shared literature service's
/// per-IP budget (60 requests a minute) and DBLP's rate limit, so more
/// workers mostly buy rate-limited, inconclusive answers.
const WORKERS: usize = 3;

/// The longest one preprint's check may take, deadline or not.
const ENTRY_TIMEOUT: Duration = Duration::from_secs(45);

/// A check is not started with less time than this left before the
/// deadline; it would only be stopped halfway.
const MIN_CHECK_TIME: Duration = Duration::from_secs(5);

/// One preprint the upgrade checks.
pub(super) struct Candidate {
    pub(super) key: String,
    pub(super) title: String,
    /// The entry's exact text, from `@` through its closing delimiter.
    pub(super) text: String,
    /// Another entry has the same key, so neither can be replaced safely.
    duplicate: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Outcome {
    /// The entry with its publication merged in, and the fields kept that
    /// bibcite would have dropped.
    Upgraded { entry: String, retained: Vec<String>, venue: String, source: String },
    /// bibcite matched a publication the entry already reflects.
    Current,
    /// Every source answered and none knows a publication.
    NoPublishedVersion,
    /// A source was unreachable or rate-limited; worth retrying later.
    Unavailable(String),
    /// The proposed upgrade failed a safety check and was not applied.
    Rejected(String),
}

impl Outcome {
    /// How long the answer is replayed for the same entry text. A refused
    /// or failed source is retried soon; a settled answer is not asked again
    /// the same day.
    fn ttl(&self) -> Duration {
        match self {
            Self::Unavailable(_) => Duration::from_secs(5 * 60),
            Self::Upgraded { .. } => Duration::from_secs(3600),
            _ => Duration::from_secs(12 * 3600),
        }
    }
}

/// Answers by entry text and mode (a preview skips the DOI confirmation).
static CHECKED: LazyLock<TtlCache<Outcome>> = LazyLock::new(|| TtlCache::new(2048));

#[cfg(test)]
pub(crate) fn forget_checks() {
    CHECKED.clear();
}

/// Whether an entry still cites a preprint: bibcite 0.6.11's `is_preprint`
/// (a venue field says arXiv or preprint, or there is no venue; eprint and
/// url do not count, since published entries keep their arXiv pointers),
/// except that a journal or booktitle naming a published venue settles it.
/// bibcite drops the arXiv `journal` when it upgrades; Lattice keeps every
/// field the writer had, so an entry it upgraded has both, and bibcite's rule
/// alone would check it again on every later call.
pub(crate) fn is_preprint(fields: &BTreeMap<String, String>) -> bool {
    let field = |name: &str| fields.get(name).map(|value| value.to_lowercase()).unwrap_or_default();
    let preprint_venue = |venue: &str| {
        venue.contains("arxiv")
            || venue.contains("preprint")
            || venue.split_whitespace().any(|word| word == "corr")
    };
    let (journal, booktitle) = (field("journal"), field("booktitle"));
    if [&journal, &booktitle].iter().any(|venue| !venue.trim().is_empty() && !preprint_venue(venue))
    {
        return false;
    }
    [&journal, &booktitle, &field("howpublished")].iter().any(|venue| preprint_venue(venue))
        || (journal.trim().is_empty() && booktitle.trim().is_empty())
}

/// The raw fields of the first entry in `bibtex`, names lowercased.
pub(crate) fn entry_fields(bibtex: &str) -> Option<BTreeMap<String, String>> {
    let (_, start, end) = project::bibliography_entry_spans(bibtex).into_iter().next()?;
    let entry = &bibtex[start..end];
    let (_, body) = super::entry_parts(entry)?;
    Some(project::parse_bibliography_fields_raw(&entry[body]))
}

/// Whether `record` reads as the publication of the preprint `entry`: it is
/// not a preprint, and it appeared the same year or up to three years later.
/// The caller has already matched title and authors.
pub(crate) fn publishes(entry: &str, record: &str) -> bool {
    let (Some(preprint), Some(publication)) = (entry_fields(entry), entry_fields(record)) else {
        return false;
    };
    let year = |fields: &BTreeMap<String, String>| {
        let digits: String =
            fields.get("year")?.chars().filter(char::is_ascii_digit).take(4).collect();
        digits.parse::<i32>().ok()
    };
    let gap = year(&publication).zip(year(&preprint)).map(|(published, posted)| published - posted);
    is_preprint(&preprint)
        && !is_preprint(&publication)
        && gap.is_some_and(|gap| (0..=3).contains(&gap))
}

/// The preprints bibcite would try to upgrade, in file order: not muted as
/// `pubstate = preprint`, and with a title to search for.
pub(super) fn candidates(bibliography: &str) -> Vec<Candidate> {
    let spans = project::bibliography_entry_spans(bibliography);
    let count = |key: &str| spans.iter().filter(|(other, _, _)| other == key).count();
    spans
        .iter()
        .filter_map(|(key, start, end)| {
            let text = &bibliography[*start..*end];
            let (_, body) = super::entry_parts(text)?;
            let fields = project::parse_bibliography_fields_raw(&text[body]);
            let bare = |name: &str| fields.get(name).map(|v| v.replace(['{', '}'], ""));
            let title = bare("title").unwrap_or_default().trim().to_string();
            if !is_preprint(&fields)
                || bare("pubstate").as_deref() == Some("preprint")
                || title.is_empty()
            {
                return None;
            }
            Some(Candidate {
                key: key.clone(),
                title,
                text: text.to_string(),
                duplicate: count(key) > 1,
            })
        })
        .collect()
}

/// Check every candidate, `WORKERS` at a time; `None` marks one the deadline
/// left unchecked.
pub(super) fn check_all(
    candidates: &[Candidate], dry_run: bool, deadline: Option<Instant>,
) -> Vec<Option<Outcome>> {
    let results = Mutex::new(vec![None; candidates.len()]);
    let next = AtomicUsize::new(0);
    let work = || loop {
        let index = next.fetch_add(1, Ordering::Relaxed);
        let Some(candidate) = candidates.get(index) else { break };
        let outcome = check_remembered(candidate, dry_run, deadline);
        results.lock().unwrap_or_else(PoisonError::into_inner)[index] = outcome;
    };
    std::thread::scope(|scope| {
        for _ in 0..WORKERS.min(candidates.len()) {
            scope.spawn(work);
        }
    });
    results.into_inner().unwrap_or_else(PoisonError::into_inner)
}

fn check_remembered(
    candidate: &Candidate, dry_run: bool, deadline: Option<Instant>,
) -> Option<Outcome> {
    if candidate.duplicate {
        return Some(Outcome::Rejected(format!(
            "Another entry has the key '{}'. Resolve the duplicate first.",
            candidate.key
        )));
    }
    let memo =
        format!("{}:{}", if dry_run { "preview" } else { "apply" }, sha256_hex(&candidate.text));
    if let Some(outcome) = CHECKED.get(&memo) {
        return Some(outcome);
    }
    let timeout = match deadline {
        Some(deadline) => deadline.saturating_duration_since(Instant::now()).min(ENTRY_TIMEOUT),
        None => ENTRY_TIMEOUT,
    };
    if deadline.is_some() && timeout < MIN_CHECK_TIME {
        return None;
    }
    let started = Instant::now();
    let outcome = check(candidate, dry_run, timeout);
    // Stopped by the deadline rather than by its own limit: not an answer.
    if deadline.is_some_and(|deadline| Instant::now() >= deadline)
        && matches!(outcome, Outcome::Unavailable(_))
        && started.elapsed() < ENTRY_TIMEOUT
    {
        return None;
    }
    CHECKED.insert(memo, outcome.clone(), outcome.ttl());
    Some(outcome)
}

/// Run bibcite on the entry alone and decide what its proposal means.
fn check(candidate: &Candidate, dry_run: bool, timeout: Duration) -> Outcome {
    let started = Instant::now();
    let proposal = match propose(candidate, timeout) {
        Ok(proposal) => proposal,
        Err(Ok(outcome)) => return outcome,
        Err(Err(reason)) => return Outcome::Unavailable(reason),
    };
    let (report, proposed) = proposal;
    let (entry, retained) = match merge_upgrade(&candidate.text, &proposed) {
        Ok((entry, retained)) => {
            (entry, retained.into_iter().flat_map(|kept| kept.fields).collect())
        }
        Err(reason) => return Outcome::Rejected(reason),
    };
    if entry == candidate.text {
        return Outcome::Current;
    }
    if let Err(reason) = validate_bibliography_upgrade(&candidate.text, &entry) {
        return Outcome::Rejected(reason);
    }
    if !dry_run {
        if let Err(outcome) =
            confirm_at_doi(candidate, &entry, timeout.saturating_sub(started.elapsed()))
        {
            return outcome;
        }
    }
    let text = |name: &str| report.get(name).and_then(Value::as_str).unwrap_or("").to_string();
    Outcome::Upgraded { entry, retained, venue: text("venue"), source: text("source") }
}

/// bibcite's report for the entry and its rewritten text, or the outcome
/// that ends the check (`Err(Ok)`) or why it could not run (`Err(Err)`).
fn propose(
    candidate: &Candidate, timeout: Duration,
) -> Result<(Value, String), Result<Outcome, String>> {
    let scratch =
        ScratchBibliography::new("lattice-upgrade", Some(&candidate.text)).map_err(Err)?;
    let build = || {
        let mut command = commands::BIBCITE.command()?;
        command.arg("upgrade").arg("--no-tidy").arg(&scratch.path);
        Ok(command)
    };
    let output =
        commands::bibcite_output_routed(&build, timeout, &AtomicBool::new(false)).map_err(Err)?;
    super::super::ensure_success("bibcite", &output).map_err(Err)?;
    let report = parse_report(&output.stdout).map_err(Err)?;
    let Some(entry) = report["entries"].as_array().and_then(|entries| entries.first()).cloned()
    else {
        return Err(Err("bibcite could not read this entry.".into()));
    };
    if entry["matched"] != Value::Bool(true) {
        return Err(Ok(match entry["reason"].as_str() {
            Some("no_published_version") => Outcome::NoPublishedVersion,
            reason => Outcome::Unavailable(reason.unwrap_or("sources_unavailable").to_string()),
        }));
    }
    Ok((entry, scratch.read().map_err(Err)?))
}

/// An upgrade keeps old author fields, so agreeing with bibcite's output is
/// not independent evidence: an entry whose identity fields changed must
/// match the record at its DOI.
fn confirm_at_doi(candidate: &Candidate, entry: &str, timeout: Duration) -> Result<(), Outcome> {
    let parse = |text: &str| project::parse_bibliography(text).into_iter().next();
    let (Some(previous), Some(current)) = (parse(&candidate.text), parse(entry)) else {
        return Err(Outcome::Rejected("The upgraded entry could not be read.".into()));
    };
    if previous.doi == current.doi
        && previous.title == current.title
        && previous.year == current.year
        && previous.venue == current.venue
        && previous.authors == current.authors
    {
        return Ok(());
    }
    let Some(doi) = current.doi else {
        return Err(Outcome::Rejected(
            "An automatic publication upgrade requires an independently verifiable DOI. Use citation review instead.".into(),
        ));
    };
    let verified =
        project::resolve_doi(&doi, timeout.max(Duration::from_secs(1)), &AtomicBool::new(false))
            .map_err(|error| {
                Outcome::Unavailable(format!(
                    "Could not confirm the publication at its DOI: {error}"
                ))
            })?;
    if !crate::citation_audit::metadata_identity_matches(entry, verified.bibtex.trim()) {
        return Err(Outcome::Rejected(format!(
            "Publication metadata for '{}' could not be independently confirmed.",
            candidate.key
        )));
    }
    Ok(())
}
