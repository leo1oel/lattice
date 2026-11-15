//! A check's finding as lattice-core's `AuditResult` serializes it and the
//! saved report keeps it (`AuditResult` in `bibliography-audit.tsx`), and
//! how a group's Semantic Scholar batch fills it in.

use lattice_core::{citation_audit, citation_health::CitationHealth};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Source {
    pub source: String,
    pub outcome: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub bibtex: String,
    #[serde(default)]
    pub changes: Vec<Change>,
    #[serde(default)]
    pub reasons: Vec<String>,
}

/// A check's finding, as lattice-core's `AuditResult` serializes it (and the
/// saved report keeps it).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub status: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<Source>,
    pub before: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default)]
    pub changes: Vec<Change>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<Candidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<CitationHealth>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disagreements: Vec<String>,
}

impl Finding {
    pub(crate) fn from_core(result: &impl Serialize) -> Option<Self> {
        let mut finding: Finding =
            serde_json::from_value(serde_json::to_value(result).ok()?).ok()?;
        finding.checked_at = Some(chrono_now());
        Some(finding)
    }

    pub(super) fn failed(message: String, before: &str) -> Self {
        Finding {
            status: "unavailable".into(),
            message,
            checked_at: Some(chrono_now()),
            before: before.to_string(),
            ..Default::default()
        }
    }

    /// A publisher's notice (a retraction, an expression of concern) on the
    /// work itself.
    pub fn has_notice(&self) -> bool {
        self.health
            .as_ref()
            .is_some_and(|health| !matches!(health.kind.as_str(), "unknown" | "unavailable"))
    }
}

/// A Semantic Scholar batch's answers, over the group's own checks, and
/// whether it failed, which the group's later checks and the rest of the
/// run are told.
pub(super) fn take_batch(
    batch: Result<citation_audit::BatchAudit, String>,
    answered: &mut [Option<Finding>],
    s2_failure: &mut Option<String>,
    s2_status: &mut Option<String>,
) {
    match batch {
        Ok(batch) if batch.results.len() == answered.len() => {
            for (slot, result) in answered.iter_mut().zip(&batch.results) {
                if let Some(finding) = result.as_ref().and_then(Finding::from_core) {
                    *slot = Some(finding);
                }
            }
            *s2_failure = batch.s2_failure;
            *s2_status = Some(s2_failure.clone().unwrap_or_else(|| "checked".into()));
        }
        _ => {
            *s2_failure = Some("unavailable".into());
            *s2_status = s2_failure.clone();
        }
    }
}

fn chrono_now() -> String {
    // Seconds since the epoch, as the report only orders and shows dates.
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    format!("{seconds}")
}
