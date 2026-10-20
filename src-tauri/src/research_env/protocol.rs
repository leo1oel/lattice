//! The environment's wire format: one JSON request per line in, one JSON
//! response per line out.
//!
//! Gymnasium's step result (`terminated`, `truncated`) with the reward on the
//! reply as OpenEnv puts it, and Collaborative Gym's shape for more than one
//! party: every step names the `role` that took it, observations split into
//! what everyone sees (`public`) and what only that role sees (`private`),
//! and `events` tell a party what the others did since it last looked, so
//! nobody has to take turns. Phase 1 has no second party yet; the fields are
//! here so a writer's logged session can be replayed through the same
//! protocol later.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    /// Start an episode on a task package (a Harbor task folder).
    Reset {
        task: PathBuf,
        #[serde(default)]
        episode: Option<String>,
        #[serde(default)]
        agent: Option<AgentInfo>,
        #[serde(default)]
        budget: Option<Budget>,
    },
    Step {
        #[serde(default)]
        role: Role,
        action: Action,
    },
    /// What this environment supports.
    Info {},
    /// End the episode, writing its trajectory; the process exits at EOF.
    Close {},
}

/// Who acts. Budgets charge only the agent (Co-Gym capped agents at 30
/// actions with messages included, and collaborative agents ran out first).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Role {
    #[default]
    Agent,
    Human,
    Simulator,
    System,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct AgentInfo {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub model: String,
}

/// What the agent may spend. Running out ends the episode as Gymnasium's
/// `truncated`, and the workspace is scored as it stands, the way Harbor
/// still verifies after an agent times out.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Budget {
    pub steps: u32,
    pub compile_seconds: f64,
}

impl Default for Budget {
    fn default() -> Self {
        Self { steps: 60, compile_seconds: 300.0 }
    }
}

/// What the agent claims at submission, compared with the verdict (a run
/// whose claim does not match its outcome is worth knowing about).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Claim {
    Solved,
    Partial,
    Unsolved,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Action {
    ListFiles {},
    /// A window of a file, 1-based and inclusive; the whole file by default.
    Read {
        path: String,
        #[serde(default)]
        from_line: Option<u32>,
        #[serde(default)]
        to_line: Option<u32>,
    },
    Search {
        query: String,
    },
    /// Replace the one occurrence of `old` with `new`.
    Edit {
        path: String,
        old: String,
        new: String,
    },
    Write {
        path: String,
        text: String,
    },
    Compile {},
    PdfText {
        #[serde(default)]
        page: Option<u32>,
    },
    /// Where a source line lands in the PDF.
    Synctex {
        path: String,
        line: u32,
    },
    /// Which source line a point on a PDF page came from.
    SynctexInverse {
        page: u32,
        x: f64,
        y: f64,
    },
    /// Unused labels and citations, and the word count.
    Check {},
    /// Hand the workspace to the task's verifier; ends the episode.
    Submit {
        #[serde(default)]
        claim: Option<Claim>,
    },
    /// Give up with a reason (PaperJury's "author-required"); ends the episode.
    Defer {
        reason: String,
    },
}

impl Action {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::ListFiles {} => "list_files",
            Self::Read { .. } => "read",
            Self::Search { .. } => "search",
            Self::Edit { .. } => "edit",
            Self::Write { .. } => "write",
            Self::Compile {} => "compile",
            Self::PdfText { .. } => "pdf_text",
            Self::Synctex { .. } => "synctex",
            Self::SynctexInverse { .. } => "synctex_inverse",
            Self::Check {} => "check",
            Self::Submit { .. } => "submit",
            Self::Defer { .. } => "defer",
        }
    }
}

/// One reply to `reset` or `step`. Timing lives in `info`, never in `obs`,
/// so replaying an episode can compare observations exactly.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct Response {
    pub obs: Observation,
    pub reward: f64,
    pub terminated: bool,
    pub truncated: bool,
    pub events: Vec<Value>,
    pub info: Value,
}

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct Observation {
    pub public: Value,
    pub private: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Result<Request, serde_json::Error> {
        serde_json::from_str(line)
    }

    #[test]
    fn reads_resets_and_steps_with_the_agent_as_the_default_role() {
        let reset = parse(r#"{"op":"reset","task":"/tasks/t1","agent":{"name":"claude-code"}}"#);
        assert!(matches!(reset, Ok(Request::Reset { episode: None, .. })));
        let step = parse(
            r#"{"op":"step","action":{"type":"edit","path":"main.tex","old":"a","new":"b"}}"#,
        );
        assert!(matches!(
            step,
            Ok(Request::Step { role: Role::Agent, action: Action::Edit { .. } })
        ));
        let human = parse(r#"{"op":"step","role":"human","action":{"type":"compile"}}"#);
        assert!(matches!(
            human,
            Ok(Request::Step { role: Role::Human, action: Action::Compile {} })
        ));
        let submit = parse(r#"{"op":"step","action":{"type":"submit","claim":"solved"}}"#);
        assert!(matches!(
            submit,
            Ok(Request::Step { action: Action::Submit { claim: Some(Claim::Solved) }, .. })
        ));
    }

    #[test]
    fn refuses_unknown_operations_actions_and_fields() {
        assert!(parse(r#"{"op":"exec","command":"rm -rf /"}"#).is_err());
        assert!(parse(r#"{"op":"step","action":{"type":"run","cmd":"ls"}}"#).is_err());
        assert!(parse(r#"{"op":"step","action":{"type":"compile","engine":"lualatex"}}"#).is_err());
        assert!(parse(r#"{"op":"step","role":"admin","action":{"type":"compile"}}"#).is_err());
    }
}
