//! Correlated completion events for long-running commands. The frontend sends
//! an operation and request id; the backend logs one `command_completed` event
//! under them so both sides of a failure can be lined up in a support bundle.

use serde::Deserialize;
use serde_json::Value;
use std::future::Future;
use std::time::Instant;
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
}

struct CommandDiagnostic {
    /// `(operation_id, request_id)`, when the caller sent a context.
    ids: Option<(Uuid, Uuid)>,
    command: &'static str,
    started: Instant,
}

impl CommandDiagnostic {
    fn new(command: &'static str, context: Option<&DiagnosticContext>) -> Self {
        // Invalid caller-controlled values must never reach logs. Keep a
        // terminal event for the rejected command under fresh safe IDs.
        let ids = context.map(|context| {
            context.validated().unwrap_or_else(|_| (Uuid::new_v4(), Uuid::new_v4()))
        });
        Self { ids, command, started: Instant::now() }
    }

    fn completion_event<T>(&self, result: &Result<T, String>) -> Option<Value> {
        let (operation_id, request_id) = self.ids?;
        Some(serde_json::json!({
            "schema_version": 1,
            "event": "command_completed",
            "component": "lattice.rust",
            "version": env!("CARGO_PKG_VERSION"),
            "command": self.command,
            "operation_id": operation_id.to_string(),
            "request_id": request_id.to_string(),
            "duration_ms": self.started.elapsed().as_millis(),
            "outcome": if result.is_ok() { "success" } else { "error" },
        }))
    }
}

/// Run `work` as `command`: a malformed context fails the command before the
/// work starts, and every outcome logs one completion event when a context
/// was sent.
pub async fn traced<T>(
    command: &'static str, context: Option<DiagnosticContext>,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let diagnostic = CommandDiagnostic::new(command, context.as_ref());
    let result = match context.as_ref().map(DiagnosticContext::validated).transpose() {
        Ok(_) => work.await,
        Err(error) => Err(error),
    };
    if let Some(event) = diagnostic.completion_event(&result) {
        log::info!("{event}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_event_never_contains_malformed_identifiers() {
        let context = DiagnosticContext {
            operation_id: "credential=secret".into(),
            request_id: "also malformed".into(),
        };
        let diagnostic = CommandDiagnostic::new("test_command", Some(&context));

        let event = diagnostic.completion_event(&Err::<(), _>("rejected".into())).unwrap();
        assert!(Uuid::parse_str(event["operation_id"].as_str().unwrap()).is_ok());
        assert!(Uuid::parse_str(event["request_id"].as_str().unwrap()).is_ok());
        assert!(!event.to_string().contains("credential=secret"));
        assert!(!event.to_string().contains("also malformed"));
        assert_eq!(event["outcome"], "error");
        assert_eq!(event["event"], "command_completed");
    }

    #[test]
    fn completion_event_canonicalizes_valid_ids_and_records_outcome() {
        let operation_id = Uuid::new_v4();
        let request_id = Uuid::new_v4();
        let context = DiagnosticContext {
            operation_id: operation_id.hyphenated().to_string().to_uppercase(),
            request_id: request_id.simple().to_string(),
        };
        let diagnostic = CommandDiagnostic::new("test_command", Some(&context));
        assert!(DiagnosticContext { request_id: "bad".into(), ..context }.validated().is_err());

        let success = diagnostic.completion_event(&Ok::<_, String>(())).unwrap();
        assert_eq!(success["operation_id"], operation_id.to_string());
        assert_eq!(success["request_id"], request_id.to_string());
        assert_eq!(success["outcome"], "success");

        let failed = diagnostic.completion_event(&Err::<(), _>("failed".into())).unwrap();
        assert_eq!(failed["outcome"], "error");
    }
}
