//! Bibliography audit: scan the project's registered .bib files, check each
//! entry against publication sources, and apply a reviewed replacement.
//!
//! The stages, in the order an entry meets them:
//! - `scan`: parse every registered bibliography and run local schema checks.
//! - `batch`: the Semantic Scholar exact-ID fast path for up to 20 entries.
//! - `check`: the per-entry bibcite pipeline (DOI, title, or preprint upgrade).
//! - `publication`, `proceedings`: authoritative publisher and proceedings
//!   records that confirm or correct what the indexes returned.
//! - `apply`: the snapshot-checked write of one accepted replacement.
//!
//! Shared rules: `identity` decides whether two records describe the same
//! paper, `proposal` turns remote metadata and local repairs into a
//! replacement, `bibcite` runs the CLI, and `bibtex` reads one entry's text.
use crate::citation_health::{self, CitationHealth};
use crate::project::{self, normalize_doi};
use crate::project_fs::ProjectDir;
use crate::util::sha256_hex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

mod apply;
mod batch;
mod bibcite;
mod bibtex;
mod check;
mod identity;
mod proceedings;
mod proposal;
mod publication;
mod scan;

pub use apply::apply;
pub use batch::check_batch;
pub(crate) use bibtex::{fields as entry_fields, single_entry_key};
pub use check::check_entry;
pub(crate) use identity::metadata_identity_matches;
pub(crate) use proposal::{prepare_import, protect_bibtex};
pub use scan::scan;
// The stages share these through `use super::*`.
use apply::registered_entry;
use bibcite::*;
use bibtex::*;
use identity::*;
use proposal::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub path: String,
    pub key: String,
    pub title: String,
    pub bibtex: String,
    #[serde(default)]
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditIssue {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditScan {
    pub entries: Vec<AuditEntry>,
    pub issues: Vec<AuditIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchAudit {
    pub results: Vec<Option<AuditResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub s2_failure: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditCandidate {
    pub bibtex: String,
    pub changes: Vec<FieldChange>,
    pub reasons: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditResult {
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication_reason: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<SourceCheck>,
    pub before: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<AuditCandidate>,
    pub changes: Vec<FieldChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<CitationHealth>,
}

#[derive(Debug, Serialize)]
pub struct SourceCheck {
    pub source: String,
    pub outcome: String,
}

impl SourceCheck {
    fn new(source: impl Into<String>, outcome: impl Into<String>) -> Self {
        SourceCheck { source: source.into(), outcome: outcome.into() }
    }
}

/// Replace any earlier row for the same source.
fn upsert_source(sources: &mut Vec<SourceCheck>, source: SourceCheck) {
    sources.retain(|row| row.source != source.source);
    sources.push(source);
}

fn result(status: &str, message: &str, before: impl Into<String>) -> AuditResult {
    AuditResult {
        status: status.into(),
        message: message.into(),
        publication_reason: None,
        sources: vec![],
        before: before.into(),
        after: None,
        candidate: None,
        changes: vec![],
        health: None,
    }
}

impl AuditResult {
    /// The entry as this result would leave it: the proposal, else the original.
    fn current(&self) -> &str {
        self.after.as_deref().unwrap_or(&self.before)
    }

    /// Whether a source's record was accepted for this entry.
    fn verified(&self) -> bool {
        self.status == "checked" || self.status == "update"
    }

    fn because(mut self, reason: &str) -> Self {
        self.publication_reason = Some(reason.into());
        self
    }

    fn with_sources(mut self, sources: Vec<SourceCheck>) -> Self {
        self.sources = sources;
        self
    }

    /// A failed official request is not proof that publication is absent, so
    /// an entry without a proposal is left unverified rather than "checked".
    fn official_source_unavailable(&mut self) {
        if self.after.is_none() {
            self.status = "unavailable".into();
            self.publication_reason = Some("sources_unavailable".into());
        }
    }

    /// A DOI's citation health is part of its verdict: without a complete
    /// health check, available metadata is only reported as unavailable.
    fn record_health(&mut self, health: Option<CitationHealth>) {
        self.health = health;
        if self.health.as_ref().is_none_or(CitationHealth::is_incomplete) {
            self.status = "unavailable".into();
            self.message =
                "Metadata may be available, but the citation-health check was incomplete.".into();
        }
    }
}

const REPORT_DIRECTORY: &str = "bibliography-audits";

fn report_relative_path(root: &Path) -> Result<String, String> {
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let digest = sha256_hex(canonical.to_string_lossy().as_bytes());
    // Older proposals predate deposited-venue checks and case protection.
    Ok(format!("{REPORT_DIRECTORY}/v3-{digest}.json"))
}

/// An Overleaf sync that could not merge a bibliography leaves both versions in
/// it between conflict markers. Every entry then appears twice, so checking it
/// reported each one as a duplicate key instead of naming the real problem.
const UNRESOLVED_CONFLICT: &str = "This bibliography has an unresolved Overleaf sync conflict. Resolve it before checking or updating its references.";

fn has_conflict_markers(source: &str) -> bool {
    source.lines().any(|line| line.starts_with("<<<<<<<"))
}

/// The project's bibliographies, minus the "(local conflict …)" backups Overleaf
/// sync keeps beside a conflicted file: they are copies, not sources, and
/// auditing them flagged every key as duplicated across files.
fn audit_sources(root: &Path) -> Result<Vec<(String, String)>, String> {
    let mut sources = project::iter_bibliography_sources(root)?;
    sources.retain(|(path, _)| {
        !crate::overleaf::is_conflict_copy(path.rsplit('/').next().unwrap_or(path))
    });
    Ok(sources)
}

/// The frontend's saved report rows for this project, kept opaque here.
pub fn load_report(
    data_dir: &Path, root: &Path,
) -> Result<Option<Vec<(String, serde_json::Value)>>, String> {
    let path = data_dir.join(report_relative_path(root)?);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("The saved bibliography audit report is malformed: {error}"))
}

pub fn save_report(
    data_dir: &Path, root: &Path, report: Vec<(String, serde_json::Value)>,
) -> Result<(), String> {
    let relative = report_relative_path(root)?;
    let bytes = serde_json::to_vec(&report).map_err(|error| error.to_string())?;
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    ProjectDir::open(data_dir)?.atomic_write(&relative, &bytes)
}

/// A disposable blank project inside a temporary parent directory.
#[cfg(test)]
struct TestProject {
    parent: crate::test_support::TempDir,
    root: std::path::PathBuf,
}

#[cfg(test)]
impl TestProject {
    fn new() -> Self {
        let parent = crate::test_support::TempDir::new("audit-test");
        let root = project::create_blank(&parent, "Audit").unwrap();
        TestProject { parent, root }
    }

    /// A project whose `references.bib` holds `contents`.
    fn with_bib(contents: &str) -> Self {
        let project = Self::new();
        project.write_bib(contents);
        project
    }

    fn write_bib(&self, contents: &str) {
        fs::write(self.root.join("references.bib"), contents).unwrap();
    }

    fn read_bib(&self) -> String {
        fs::read_to_string(self.root.join("references.bib")).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_reports_are_project_scoped_and_preserve_unknown_fields() {
        let project = TestProject::new();
        let root = &project.root;
        let other_root = project::create_blank(&project.parent, "Other").unwrap();
        let data_dir = project.parent.join("app-data");
        let report = vec![(
            "citation-key".to_string(),
            serde_json::json!({
                "status": "checked",
                "checkedAt": "2026-09-07T12:00:00Z",
                "futureField": {"preserved": true}
            }),
        )];

        assert_eq!(load_report(&data_dir, root).unwrap(), None);
        save_report(&data_dir, root, report.clone()).unwrap();
        assert_eq!(load_report(&data_dir, root).unwrap(), Some(report));
        assert_eq!(
            load_report(&data_dir, &root.join(".")).unwrap().unwrap()[0].1["checkedAt"],
            "2026-09-07T12:00:00Z"
        );
        assert_eq!(load_report(&data_dir, &other_root).unwrap(), None);

        save_report(&data_dir, &other_root, Vec::new()).unwrap();
        assert_eq!(load_report(&data_dir, &other_root).unwrap(), Some(Vec::new()));
    }

    #[test]
    fn malformed_persisted_report_returns_an_error() {
        let project = TestProject::new();
        let data_dir = project.parent.join("app-data");
        fs::create_dir_all(data_dir.join(REPORT_DIRECTORY)).unwrap();
        let relative = report_relative_path(&project.root).unwrap();
        fs::write(data_dir.join(relative), b"{not a report").unwrap();

        let error = load_report(&data_dir, &project.root).unwrap_err();
        assert!(error.contains("malformed"), "{error}");
    }
}
