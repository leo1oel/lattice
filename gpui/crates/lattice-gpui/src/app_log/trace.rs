//! One operation's entries in the log (`logAction` in
//! `src/telemetry/app-notify.ts`): "▶ Build" when it starts, then one
//! terminal entry saying how it ended, all under one operation id, so
//! Settings › Logs shows them as one row. Every entry carries the stable
//! operation name the safe export allows, the trigger, the counts gathered
//! on the way and, at the end, the outcome and how long it took. The entries
//! are the log's alone: the notices an operation shows stay its caller's.

use std::time::Instant;

use gpui::App;
use lattice_i18n::t;
use serde_json::{Map, Value};

use super::{Level, NewEntry, OperationContext};

pub struct Trace {
    id: String,
    source: String,
    action: String,
    operation: &'static str,
    trigger: Option<String>,
    metrics: Map<String, Value>,
    started: Instant,
    done: bool,
}

/// The id's short tag that ends an operation's detail (`withTraceTag`),
/// which the log keeps and a notice's text leaves out.
fn tagged(id: &str, detail: Option<&str>) -> String {
    let tag: String = id.chars().filter(|c| *c != '-').take(6).collect();
    [
        detail.map(str::trim).unwrap_or_default().to_string(),
        format!("#{tag}"),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

impl Trace {
    /// Open the trace of `action` (translated, shown) under `operation` (a
    /// stable id the export may name), and log its start.
    pub fn start(
        source: impl Into<String>,
        action: impl Into<String>,
        trigger: Option<String>,
        operation: &'static str,
        cx: &mut App,
    ) -> Self {
        let trace = Self {
            id: uuid::Uuid::new_v4().to_string(),
            source: source.into(),
            action: action.into(),
            operation,
            trigger,
            metrics: Map::new(),
            started: Instant::now(),
            done: false,
        };
        trace.log(
            Level::Info,
            format!("▶ {}", trace.action),
            tagged(&trace.id, trace.trigger.as_deref()),
            trace.context("started"),
            cx,
        );
        trace
    }

    /// Counts and flags for the terminal entry, never a document's text.
    pub fn enrich(&mut self, metrics: impl IntoIterator<Item = (&'static str, Value)>) {
        for (key, value) in metrics {
            self.metrics.insert(key.into(), value);
        }
    }

    fn context(&self, phase: &str) -> OperationContext {
        OperationContext {
            operation_id: self.id.clone(),
            operation: self.operation.into(),
            phase: phase.into(),
            trigger: self.trigger.clone(),
            metrics: (!self.metrics.is_empty()).then(|| self.metrics.clone()),
            ..OperationContext::default()
        }
    }

    fn terminal(&self, outcome: &str) -> OperationContext {
        OperationContext {
            outcome: Some(outcome.into()),
            duration_ms: Some(self.started.elapsed().as_millis() as u64),
            ..self.context("completed")
        }
    }

    fn log(
        &self,
        level: Level,
        title: String,
        detail: String,
        context: OperationContext,
        cx: &mut App,
    ) {
        let entry = NewEntry {
            level,
            source: self.source.clone(),
            title,
            detail,
            context: Some(context),
        };
        super::global(cx).update(cx, |log, cx| {
            log.add(entry, None, false, cx);
        });
    }

    /// End it as `outcome` (`success`, `error` or `cancelled`), under
    /// `title` or the action's own wording; only the first ending counts.
    pub fn finish(&mut self, outcome: &str, title: Option<String>, cx: &mut App) {
        if std::mem::replace(&mut self.done, true) {
            return;
        }
        let (level, fallback) = match outcome {
            "error" => (Level::Error, t!("{action} error", action = self.action)),
            "success" => (Level::Success, t!("{action} success", action = self.action)),
            _ => (Level::Info, t!("{action} cancelled", action = self.action)),
        };
        self.log(
            level,
            title.unwrap_or(fallback),
            tagged(&self.id, None),
            self.terminal(outcome),
            cx,
        );
    }

    /// End it as failed, saying why.
    pub fn fail(&mut self, title: String, detail: &str, cx: &mut App) {
        if std::mem::replace(&mut self.done, true) {
            return;
        }
        let context = OperationContext {
            error_type: Some("Error".into()),
            ..self.terminal("error")
        };
        self.log(
            Level::Error,
            title,
            tagged(&self.id, Some(detail)),
            context,
            cx,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::tagged;

    #[test]
    fn the_tag_is_the_ids_first_six_hex_digits_after_the_detail() {
        let id = "1a2b-3c4d-5e6f";
        assert_eq!(tagged(id, None), "#1a2b3c");
        assert_eq!(
            tagged(id, Some(" clean rebuild ")),
            "clean rebuild\n#1a2b3c"
        );
    }
}
