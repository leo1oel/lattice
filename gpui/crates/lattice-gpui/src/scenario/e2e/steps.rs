//! The e2e scenario's record of its steps.

use serde_json::{Value, json};

/// Each step's name, whether it passed, and what it saw.
pub(super) struct Steps(pub(super) Vec<Value>);

impl Steps {
    pub(super) fn check(&mut self, name: &str, passed: bool, detail: Value) -> bool {
        self.0
            .push(json!({ "step": name, "passed": passed, "detail": detail }));
        passed
    }
}
