//! Correlation for long-running commands. The frontend sends an operation and
//! request id; the backend puts them on the command's wide event (see
//! `wide_event`) so both sides of a failure can be lined up in a support
//! bundle.

use crate::wide_event;
use serde::Deserialize;
use std::future::Future;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct DiagnosticContext {
    pub operation_id: String,
    pub request_id: String,
}

impl DiagnosticContext {
    /// `(operation_id, request_id)` as UUIDs.
    fn validated(&self) -> Result<(Uuid, Uuid), String> {
        let parse = |id: &str, name: &str| {
            Uuid::parse_str(id).map_err(|_| format!("Invalid diagnostic {name} id"))
        };
        Ok((parse(&self.operation_id, "operation")?, parse(&self.request_id, "request")?))
    }

    /// The ids to log. Invalid caller-controlled values must never reach the
    /// log, so a malformed pair is replaced by fresh safe ids.
    fn logged_ids(&self) -> (Uuid, Uuid) {
        self.validated().unwrap_or_else(|_| (Uuid::new_v4(), Uuid::new_v4()))
    }
}

/// Run `work` inside the current operation, tagged with the caller's ids. A
/// malformed context fails the command before the work starts; the operation
/// still records it, under fresh ids.
pub async fn traced<T>(
    context: Option<DiagnosticContext>, work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if let Some(context) = &context {
        let (operation_id, request_id) = context.logged_ids();
        wide_event::record("operation_id", operation_id.to_string());
        wide_event::record("request_id", request_id.to_string());
        context.validated()?;
    }
    work.await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wide_event::{tests::capture, Failure, Operation};

    fn unclassified(_: &str) -> Failure {
        Failure { kind: "test", fix: "None." }
    }

    fn run(operation_id: &str, request_id: &str, result: Result<(), String>) -> serde_json::Value {
        let context =
            DiagnosticContext { operation_id: operation_id.into(), request_id: request_id.into() };
        let (_, capture) = capture(|| {
            tauri::async_runtime::block_on(
                Operation::start("test.command", unclassified)
                    .run(traced(Some(context), async { result })),
            )
        });
        capture.events().remove(0)
    }

    #[test]
    fn the_event_carries_canonical_ids_and_replaces_malformed_ones() {
        let (operation_id, request_id) = (Uuid::new_v4(), Uuid::new_v4());
        let valid =
            (operation_id.hyphenated().to_string().to_uppercase(), request_id.simple().to_string());
        let success = run(&valid.0, &valid.1, Ok(()));
        assert_eq!(success["operation_id"], operation_id.to_string());
        assert_eq!(success["request_id"], request_id.to_string());
        assert_eq!(success["outcome"], "success");
        assert_eq!(run(&valid.0, &valid.1, Err("failed".into()))["outcome"], "error");
        // One malformed id replaces both with fresh ones.
        assert_ne!(run(&valid.0, "bad", Ok(()))["operation_id"], operation_id.to_string());

        // Invalid caller-controlled values never reach the log, and the work
        // never starts.
        let rejected = run("credential=secret", "also malformed", Ok(()));
        for id in ["operation_id", "request_id"] {
            assert!(Uuid::parse_str(rejected[id].as_str().unwrap()).is_ok(), "{id}");
        }
        let logged = rejected.to_string();
        assert!(!logged.contains("credential=secret") && !logged.contains("also malformed"));
        assert_eq!(rejected["outcome"], "error");
    }
}
