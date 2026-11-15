//! The compile repair's state, as the Tauri app's `use-compile-repair.ts`
//! keeps it, and the relay's status lines in the interface language
//! (`compile-repair-messages.ts`).
//!
//! Fix all (or Ask the agent, for one error) starts an Agent task of its
//! own, separate from the visible conversation: lattice-core's relay posts
//! the build's diagnostics to the Synara service's compile-repair route,
//! the window polls the task to a terminal status, and once it completes,
//! builds again. The editor is read-only while it runs, so the writer and
//! the Agent never edit one file at once.

use std::time::Duration;

use lattice_core::models::Diagnostic;
use lattice_i18n::{fill_named, n, t, tr};
use serde::Deserialize;

/// How long after Cancel a task that has not stopped is left to the
/// writer's Unlock anyway: a transport failure or a slow Cancel does not
/// prove the provider stopped writing.
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(10);
/// How often a running task is asked how it is.
pub(crate) const POLL: Duration = Duration::from_secs(1);
/// How long a failed poll waits before the next.
pub(crate) const POLL_RETRY: Duration = Duration::from_secs(2);

/// Where a repair is.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RepairStatus {
    Starting,
    Running,
    AwaitingApproval,
    /// The task completed; the build after it runs.
    Compiling,
    Completed,
    Failed,
}

/// The repair the card shows.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RepairState {
    pub status: RepairStatus,
    /// The Agent thread the task runs in, once it started.
    pub thread_id: Option<String>,
    /// The relay's last word, or why it failed.
    pub message: Option<String>,
    /// Cancel was asked for `STOP_GRACE` ago and the task has not ended.
    pub stopping: bool,
}

impl RepairState {
    pub(crate) fn new(status: RepairStatus) -> Self {
        Self {
            status,
            thread_id: None,
            message: None,
            stopping: false,
        }
    }

    /// Whether it still runs: the editor stays read-only and Fix all waits.
    pub(crate) fn busy(&self) -> bool {
        !matches!(self.status, RepairStatus::Completed | RepairStatus::Failed)
    }

    /// The progress line beside its spinner.
    pub(crate) fn progress(&self) -> &'static str {
        if self.stopping {
            t!("Stopping…")
        } else {
            match self.status {
                RepairStatus::Compiling => t!("Recompiling…"),
                RepairStatus::AwaitingApproval => t!("Needs approval"),
                _ => t!("Repairing…"),
            }
        }
    }
}

/// What the relay's `status` answers.
#[derive(Debug, Deserialize)]
pub(crate) struct Progress {
    pub status: RepairStatus,
    #[serde(default)]
    pub message: Option<String>,
}

/// The diagnostics a repair is asked about: errors and warnings.
pub(crate) fn repairable(diagnostics: &[Diagnostic]) -> Vec<&Diagnostic> {
    diagnostics
        .iter()
        .filter(|diagnostic| {
            super::diagnostics::severity(&diagnostic.level) != super::diagnostics::Severity::Info
        })
        .collect()
}

/// Why a start was refused, in the writer's words, for the two refusals the
/// relay reports as plain strings; any other failure as reported.
pub(crate) fn start_refusal(detail: &str) -> Option<&'static str> {
    match detail {
        "The workspace already has an active writer." => Some(t!(
            "Repair has not started because another Agent task in this project is running or waiting for your response. Open Agent to finish or stop that task, then try Fix all again."
        )),
        "A compile repair is already running." => Some(t!(
            "Another compile repair is already starting for this project. Wait for it to finish before trying Fix all again."
        )),
        _ => None,
    }
}

/// The relay's status lines Lattice knows (`compile-repair-messages.ts`).
const RELAY_LINES: &[&str] = &[
    n!("The repair agent needs an answer. Open the repair thread to respond."),
    n!("Cancellation requested; waiting for the provider to stop."),
    n!("Repair has no active turn."),
    n!("The agent service is unavailable."),
    n!(
        "The built-in agent is off on this platform until Lattice can keep it from editing bibliography (.bib) files directly."
    ),
    n!("The repair request failed."),
];

/// A status line from the relay (the Synara compile-repair route, or
/// lattice-core's relay) in the interface language; text Lattice does not
/// know (a provider's own error) as reported.
pub(crate) fn relay_message(message: &str) -> String {
    relay_message_in(message, tr)
}

/// [`relay_message`], with `tr` giving each message's translation.
fn relay_message_in(message: &str, tr: impl Fn(&'static str) -> &'static str) -> String {
    let body = message.strip_prefix("Error: ").unwrap_or(message);
    if let Some(known) = RELAY_LINES.iter().find(|line| **line == body) {
        return tr(known).to_string();
    }
    let word = |prefix: &str| {
        body.strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix('.'))
            .filter(|word| !word.is_empty() && !word.contains(char::is_whitespace))
    };
    if let Some(turn) = word("Repair turn ") {
        return fill_named(tr(n!("Repair turn {turn}.")), &[("turn", &turn)]);
    }
    if let Some(provider) = word("Repair provider ") {
        return fill_named(
            tr(n!("Repair provider {provider}.")),
            &[("provider", &provider)],
        );
    }
    if let Some(status) = body
        .strip_prefix("Repair service returned ")
        .and_then(|rest| rest.strip_suffix('.'))
        .filter(|status| !status.is_empty())
    {
        return fill_named(
            tr(n!("Repair service returned {status}.")),
            &[("status", &status)],
        );
    }
    message.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The zh-CN catalog's words for the relay's lines
    /// (`src/locales/zh-CN/messages.po`), whatever the interface language.
    fn chinese(msgid: &'static str) -> &'static str {
        lattice_i18n::chinese(None, msgid).unwrap_or(msgid)
    }

    #[test]
    fn relay_lines_read_in_the_catalog_language() {
        assert_eq!(
            relay_message_in("Error: Repair has no active turn.", chinese),
            "修正当前没有进行中的轮次。"
        );
        assert_eq!(
            relay_message_in("The agent service is unavailable.", chinese),
            "AI 助手暂不可用"
        );
        assert_eq!(
            relay_message_in("Repair turn interrupted.", chinese),
            "修正轮次：interrupted。"
        );
        assert_eq!(
            relay_message_in("Codex quota exceeded", chinese),
            "Codex quota exceeded"
        );
        assert_eq!(
            relay_message("Repair turn interrupted."),
            "Repair turn interrupted."
        );
    }

    #[test]
    fn the_progress_line_follows_the_task() {
        let mut state = RepairState::new(RepairStatus::Running);
        assert!(state.busy());
        assert_eq!(state.progress(), "Repairing…");
        state.status = RepairStatus::AwaitingApproval;
        assert_eq!(state.progress(), "Needs approval");
        state.stopping = true;
        assert_eq!(state.progress(), "Stopping…");
        state.status = RepairStatus::Completed;
        assert!(!state.busy());
    }

    #[test]
    fn a_status_answer_reads() {
        let progress: Progress =
            serde_json::from_str(r#"{"status":"awaiting-approval","message":"x"}"#).unwrap();
        assert_eq!(progress.status, RepairStatus::AwaitingApproval);
    }
}
