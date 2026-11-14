//! The log as Settings › Logs › Export and Help ▸ Report a Problem… hand it
//! over (`src/telemetry/app-log-export.ts`): a new object built field by
//! field from an allowlist, never a copy of a kept entry, so nothing an
//! entry carries reaches the file unless it is a level, a well-formed id or
//! time, a known operation, phase or outcome, a bounded duration, or one of
//! the named counts. The writer's own text (source, title, detail, trigger,
//! error type) is in it only when they ask for the raw diagnostic text.

use serde_json::{Map, Value, json};

use super::Entry;

const PHASES: [&str; 3] = ["started", "progress", "completed"];
const OUTCOMES: [&str; 3] = ["success", "error", "cancelled"];
const SAFE_METRICS: [&str; 15] = [
    "automatic",
    "pulled",
    "pushed",
    "merged",
    "conflicts",
    "deleted_local",
    "read_only",
    "retry_scheduled",
    "force",
    "compiler_duration_ms",
    "diagnostics",
    "has_pdf",
    "status_code",
    "dropped_overflow",
    "dropped_failed",
];
/// The operations whose names may leave the Mac: stable ids, independent of
/// the translated action names.
const SAFE_OPERATIONS: [&str; 5] = [
    "Build",
    "Sync",
    "logging.delivery",
    "build_project",
    "overleaf_sync",
];
const MAX_DURATION_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_COUNT: f64 = 1_000_000_000.;

/// A version 4-style UUID, as `crypto.randomUUID` makes them.
fn is_uuid(text: &str) -> bool {
    uuid::Uuid::parse_str(text).is_ok_and(|id| {
        text.len() == 36
            && (1..=8).contains(&id.get_version_num())
            && matches!(text.as_bytes()[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
    })
}

/// A time in the canonical form, or none: anything else could carry text.
fn canonical_time(text: &str) -> Option<String> {
    let time = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    Some(
        time.with_timezone(&chrono::Utc)
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
    )
}

fn safe_metrics(metrics: &Map<String, Value>) -> Option<Map<String, Value>> {
    let safe: Map<String, Value> = metrics
        .iter()
        .filter(|(key, _)| SAFE_METRICS.contains(&key.as_str()))
        .filter_map(|(key, value)| match value {
            Value::Bool(_) => Some((key.clone(), value.clone())),
            Value::Number(number) => number
                .as_f64()
                .filter(|count| count.is_finite() && (0.0..=MAX_COUNT).contains(count))
                .map(|_| (key.clone(), value.clone())),
            _ => None,
        })
        .collect();
    (!safe.is_empty()).then_some(safe)
}

/// The export of `entries`, with the raw diagnostic text when asked.
pub fn create(entries: &[Entry], include_raw: bool, version: &str, exported_at: &str) -> Value {
    let entries: Vec<Value> = entries
        .iter()
        .map(|entry| {
            let mut out = Map::new();
            if is_uuid(&entry.id) {
                out.insert("id".into(), json!(entry.id));
            }
            if let Some(time) = canonical_time(&entry.timestamp) {
                out.insert("timestamp".into(), json!(time));
            }
            out.insert("level".into(), json!(entry.level.tag()));
            if let Some(context) = &entry.context {
                let mut safe = Map::new();
                if SAFE_OPERATIONS.contains(&context.operation.as_str()) {
                    safe.insert("operation".into(), json!(context.operation));
                }
                if is_uuid(&context.operation_id) {
                    safe.insert("operation_id".into(), json!(context.operation_id));
                }
                for (key, value) in [
                    ("request_id", &context.request_id),
                    ("parent_request_id", &context.parent_request_id),
                ] {
                    if let Some(id) = value.as_deref().filter(|id| is_uuid(id)) {
                        safe.insert(key.into(), json!(id));
                    }
                }
                if PHASES.contains(&context.phase.as_str()) {
                    safe.insert("phase".into(), json!(context.phase));
                }
                if let Some(outcome) = context
                    .outcome
                    .as_deref()
                    .filter(|outcome| OUTCOMES.contains(outcome))
                {
                    safe.insert("outcome".into(), json!(outcome));
                }
                if let Some(duration) = context.duration_ms.filter(|ms| *ms <= MAX_DURATION_MS) {
                    safe.insert("duration_ms".into(), json!(duration));
                }
                if let Some(metrics) = context.metrics.as_ref().and_then(safe_metrics) {
                    safe.insert("metrics".into(), Value::Object(metrics));
                }
                if !safe.is_empty() {
                    out.insert("context".into(), Value::Object(safe));
                }
            }
            if include_raw {
                let mut raw = Map::new();
                raw.insert("source".into(), json!(entry.source));
                raw.insert("title".into(), json!(entry.title));
                raw.insert("detail".into(), json!(entry.detail));
                if let Some(context) = &entry.context {
                    if let Some(trigger) = &context.trigger {
                        raw.insert("trigger".into(), json!(trigger));
                    }
                    if let Some(kind) = &context.error_type {
                        raw.insert("error_type".into(), json!(kind));
                    }
                }
                out.insert("raw_diagnostic".into(), Value::Object(raw));
            }
            Value::Object(out)
        })
        .collect();
    json!({
        "schema_version": 1,
        "app_version": version,
        "exported_at": exported_at,
        "includes_raw_diagnostic": include_raw,
        "entries": entries,
    })
}

/// The export as now, pretty-printed, as the dialog shows it.
pub fn create_now(entries: &[Entry], include_raw: bool) -> Value {
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    create(entries, include_raw, lattice_core::VERSION, &now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_log::{Level, OperationContext};

    // The cases of the Tauri app's `app-log-export.test.ts`.
    const ID: &str = "123e4567-e89b-42d3-a456-426614174000";

    fn entry() -> Entry {
        let metrics = json!({
            "diagnostics": 2, "has_pdf": false, "/home/alice": 3, "secret": true, "conflicts": -4,
        });
        Entry {
            id: ID.into(),
            timestamp: "2026-09-08T10:00:00.000Z".into(),
            level: Level::Error,
            source: "/Users/alice/secret.tex".into(),
            title: "token=secret".into(),
            detail: "document text".into(),
            context: Some(OperationContext {
                operation_id: ID.into(),
                operation: "/private/project".into(),
                phase: "completed".into(),
                outcome: Some("error".into()),
                duration_ms: Some(2100),
                trigger: Some("password=hunter2".into()),
                error_type: Some("/private/Error".into()),
                metrics: metrics.as_object().cloned(),
                ..OperationContext::default()
            }),
        }
    }

    #[test]
    fn only_allowlisted_fields_and_counts_leave_the_mac() {
        let dated = Entry {
            id: ID.into(),
            timestamp: "2026-01-01 (private document)".into(),
            level: Level::Info,
            source: "App".into(),
            title: "test".into(),
            detail: String::new(),
            context: Some(OperationContext {
                operation_id: ID.into(),
                operation: "logging.delivery".into(),
                phase: "progress".into(),
                metrics: json!({ "dropped_failed": 3 }).as_object().cloned(),
                ..OperationContext::default()
            }),
        };
        let exported = create(&[entry(), dated], false, "0.16.17", "now");
        let text = exported.to_string();
        for private in [
            "private document",
            "alice",
            "secret",
            "hunter2",
            "document text",
        ] {
            assert!(!text.contains(private), "{private} leaked: {text}");
        }
        assert_eq!(
            exported["entries"][0],
            json!({
                "id": ID, "timestamp": "2026-09-08T10:00:00.000Z", "level": "error",
                "context": {
                    "operation_id": ID, "phase": "completed", "outcome": "error", "duration_ms": 2100,
                    "metrics": { "diagnostics": 2, "has_pdf": false },
                },
            })
        );
        assert_eq!(
            exported["entries"][1]["context"]["operation"],
            json!("logging.delivery")
        );
        assert_eq!(
            exported["entries"][1]["context"]["metrics"],
            json!({ "dropped_failed": 3 })
        );
        assert_eq!(exported["includes_raw_diagnostic"], json!(false));
    }

    #[test]
    fn raw_text_needs_asking_for_and_malformed_values_are_dropped() {
        let malformed = Entry {
            id: "not-an-id".into(),
            timestamp: "bad".into(),
            context: Some(OperationContext {
                operation_id: "bad".into(),
                operation: "bad".into(),
                phase: "future".into(),
                duration_ms: Some(MAX_DURATION_MS + 1),
                ..OperationContext::default()
            }),
            ..entry()
        };
        assert_eq!(
            create(&[malformed.clone()], false, "v", "now")["entries"][0],
            json!({ "level": "error" })
        );
        let raw = create(&[malformed], true, "v", "now");
        assert_eq!(
            raw["entries"][0]["raw_diagnostic"]["detail"],
            json!("document text")
        );
        assert_eq!(raw["includes_raw_diagnostic"], json!(true));
    }
}
