//! The e2e scenario's record of its steps.

use std::{cell::RefCell, rc::Rc};

use serde_json::{Value, json};

use super::registry::{self, Registered};
use crate::scenario::Run;

/// Each step's name, whether it passed, and what it saw; and the last step's
/// name, for the input lock to name where the app became active outside a
/// foreground section.
pub(super) struct Steps(pub(super) Vec<Value>, Rc<RefCell<String>>);

/// The feature module `name` (`registry.rs`: the files under `scenario/e2e/`
/// that register themselves; `dock` runs `../shell_steps.rs`), each with the
/// modules it needs to have run before it. `--scenario e2e --only <list>`
/// runs the smoke flow and only those, with what they need; without `--only`
/// everything runs.
///
/// The smoke flow is what every module starts from and what every run keeps:
/// open the project through lattice-core, build and show the PDF, SyncTeX
/// both ways, autosave and outside edits, a broken build explained and
/// repaired, edits saved with ⌘S, Vim, a second window's PDF, and the text
/// typed before the quit that `script/e2e` checks was saved. It is the
/// pipeline's per-round check, with the modules a change touches
/// (`scripts/gpui-e2e-modules.mjs` maps paths to these names); the full run
/// is the post-merge main baseline's (`scripts/gpui-main-baseline.mjs`).
fn module(name: &str) -> Option<&'static Registered> {
    registry::ordered()
        .into_iter()
        .find(|registered| registered.name == name)
}

static ONLY: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();

/// Restrict the run to the smoke flow and `list` (comma-separated module
/// names, or `smoke` for none), with the modules they need. An unknown name
/// is an error, so a stale list fails rather than silently running less.
pub(in crate::scenario) fn set_only(list: &str) -> anyhow::Result<()> {
    let mut chosen: Vec<&'static str> = Vec::new();
    let mut queue: Vec<String> = list
        .split(',')
        .map(|name| name.trim().trim_end_matches(".rs").to_string())
        .filter(|name| !name.is_empty() && name != "smoke")
        .collect();
    while let Some(name) = queue.pop() {
        let Some(registered) = module(&name) else {
            let known: Vec<_> = registry::ordered()
                .iter()
                .map(|registered| registered.name)
                .collect();
            anyhow::bail!(
                "unknown e2e module {name:?}; the modules are {}",
                known.join(", ")
            );
        };
        if !chosen.contains(&registered.name) {
            chosen.push(registered.name);
            let needs = registered
                .module
                .map(|module| module.needs)
                .unwrap_or_default();
            queue.extend(needs.iter().map(|need| need.to_string()));
        }
    }
    // In the scenario's order, for the result.
    let order = registry::ordered();
    chosen.sort_by_key(|name| order.iter().position(|registered| registered.name == *name));
    ONLY.set(chosen)
        .map_err(|_| anyhow::anyhow!("--only was given twice"))
}

/// The modules an `--only` run runs, for its result; null for a full run.
pub(super) fn only() -> Option<Vec<&'static str>> {
    ONLY.get().cloned()
}

/// Whether the feature module `name` runs in this run.
pub(super) fn selected(name: &str) -> bool {
    debug_assert!(module(name).is_some(), "{name}");
    ONLY.get().is_none_or(|chosen| chosen.contains(&name))
}

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
