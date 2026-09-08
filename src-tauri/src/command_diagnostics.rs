use serde::Deserialize;
use serde_json::Value;
use std::time::Instant;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize)]
pub struct DiagnosticContext {
    pub operation_id: String,
    pub request_id: String,
}

impl DiagnosticContext {
    pub fn validate(&self) -> Result<(), String> {
        self.validated().map(|_| ())
    }

    fn validated(&self) -> Result<ValidatedDiagnosticContext, String> {
        let operation_id = Uuid::parse_str(&self.operation_id)
            .map_err(|_| "Invalid diagnostic operation id".to_string())?;
        let request_id = Uuid::parse_str(&self.request_id)
            .map_err(|_| "Invalid diagnostic request id".to_string())?;
        Ok(ValidatedDiagnosticContext {
            operation_id,
            request_id,
        })
    }
}

struct ValidatedDiagnosticContext {
    operation_id: Uuid,
    request_id: Uuid,
}

pub struct CommandDiagnostic {
    context: Option<ValidatedDiagnosticContext>,
    command: &'static str,
    started: Instant,
}

impl CommandDiagnostic {
    pub fn new(command: &'static str, context: Option<DiagnosticContext>) -> Self {
        Self {
            context: context.map(|context| {
                // Invalid caller-controlled values must never reach logs. Keep a
                // terminal event for the rejected command under fresh safe IDs.
                context
                    .validated()
                    .unwrap_or_else(|_| ValidatedDiagnosticContext {
                        operation_id: Uuid::new_v4(),
                        request_id: Uuid::new_v4(),
                    })
            }),
            command,
            started: Instant::now(),
        }
    }

    pub fn complete<T>(&self, result: &Result<T, String>) {
        if let Some(event) = self.completion_event(result) {
            log::info!("{event}");
        }
    }

    fn completion_event<T>(&self, result: &Result<T, String>) -> Option<Value> {
        let context = self.context.as_ref()?;
        Some(serde_json::json!({
            "schema_version": 1,
            "event": "command_completed",
            "component": "lattice.rust",
            "version": env!("CARGO_PKG_VERSION"),
            "command": self.command,
            "operation_id": context.operation_id.to_string(),
            "request_id": context.request_id.to_string(),
            "duration_ms": self.started.elapsed().as_millis(),
            "outcome": if result.is_ok() { "success" } else { "error" },
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_both_correlation_ids() {
        let valid = DiagnosticContext {
            operation_id: Uuid::new_v4().to_string(),
            request_id: Uuid::new_v4().to_string(),
        };
        assert!(valid.validate().is_ok());
        assert!(DiagnosticContext {
            request_id: "bad".into(),
            ..valid
        }
        .validate()
        .is_err());
    }

    #[test]
    fn completion_event_never_contains_malformed_identifiers() {
        let diagnostic = CommandDiagnostic::new(
            "test_command",
            Some(DiagnosticContext {
                operation_id: "credential=secret".into(),
                request_id: "also malformed".into(),
            }),
        );

        let event = diagnostic
            .completion_event(&Err::<(), _>("rejected".into()))
            .unwrap();
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
        let diagnostic = CommandDiagnostic::new(
            "test_command",
            Some(DiagnosticContext {
                operation_id: operation_id.hyphenated().to_string().to_uppercase(),
                request_id: request_id.simple().to_string(),
            }),
        );

        let success = diagnostic.completion_event(&Ok::<_, String>(())).unwrap();
        assert_eq!(success["operation_id"], operation_id.to_string());
        assert_eq!(success["request_id"], request_id.to_string());
        assert_eq!(success["outcome"], "success");

        let early_error = diagnostic
            .completion_event(&Err::<(), _>("failed before work started".into()))
            .unwrap();
        assert_eq!(early_error["outcome"], "error");
        assert_eq!(early_error["event"], "command_completed");
    }
}
