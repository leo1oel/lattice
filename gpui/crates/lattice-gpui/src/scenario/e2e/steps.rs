//! The e2e scenario's record of its steps.

use std::{cell::RefCell, rc::Rc};

use serde_json::{Value, json};

use crate::scenario::Run;

/// Each step's name, whether it passed, and what it saw; and the last step's
/// name, for the input lock to name where the app became active outside a
/// foreground section.
pub(super) struct Steps(pub(super) Vec<Value>, Rc<RefCell<String>>);

impl Steps {
    pub(super) fn new(run: &Run) -> Self {
        Self(Vec::new(), run.input.last_step())
    }

    pub(super) fn check(&mut self, name: &str, passed: bool, detail: Value) -> bool {
        self.0
            .push(json!({ "step": name, "passed": passed, "detail": detail }));
        *self.1.borrow_mut() = name.to_string();
        passed
    }

    /// The input lock's own step: no step activated the app outside a
    /// foreground section, where it would have taken the key window from a
    /// run in its section elsewhere on the machine.
    pub(super) fn check_foreground(&mut self, run: &Run) {
        let outside = run.input.activations_outside();
        self.check(
            "no step activates the app outside a foreground section (input_lock.rs)",
            outside.is_empty(),
            json!({ "after_steps": outside }),
        );
    }
}
