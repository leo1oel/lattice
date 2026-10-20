//! An episode in Harbor's trajectory format (ATIF), and the one-line record
//! the calibration tool reads.
//!
//! ATIF is what Harbor writes for every agent it runs, so an episode here
//! and a Harbor trial of the same task can be read by the same tools. Each
//! step's Lattice-specific fields (its role, reward and flags) go under
//! `extra`, which the format reserves for that. The task's instruction is
//! the first step, from the user.

use super::episode::Episode;
use super::protocol::{Action, Response, Role};
use serde_json::{json, Value};

pub(crate) const ATIF_VERSION: &str = "ATIF-v1.7";

#[derive(Default)]
pub(crate) struct Trajectory {
    instruction: String,
    steps: Vec<StepRecord>,
}

pub(crate) struct StepRecord {
    role: Role,
    action: Value,
    name: &'static str,
    observation: Value,
    reward: f64,
    terminated: bool,
    truncated: bool,
}

impl StepRecord {
    pub(crate) fn new(role: Role, action: &Action, response: &Response) -> Self {
        Self {
            role,
            action: serde_json::to_value(action).unwrap_or(Value::Null),
            name: action.name(),
            observation: response.obs.public.clone(),
            reward: response.reward,
            terminated: response.terminated,
            truncated: response.truncated,
        }
    }
}

impl Trajectory {
    pub(crate) fn start(&mut self, instruction: &str) {
        self.instruction = instruction.to_string();
    }

    pub(crate) fn record(&mut self, step: StepRecord) {
        self.steps.push(step);
    }

    pub(crate) fn to_atif(&self, episode: &Episode) -> Value {
        let mut steps =
            vec![json!({ "step_id": 1, "source": "user", "message": self.instruction })];
        for (index, step) in self.steps.iter().enumerate() {
            let call = format!("call-{}", index + 1);
            steps.push(json!({
                "step_id": index + 2,
                "source": match step.role {
                    Role::Agent => "agent",
                    Role::Human | Role::Simulator => "user",
                    Role::System => "system",
                },
                "message": step.name,
                "tool_calls": [{ "tool_call_id": call, "function_name": step.name, "arguments": step.action }],
                "observation": { "results": [{ "source_call_id": call, "content": step.observation.to_string() }] },
                "extra": {
                    "role": step.role,
                    "reward": step.reward,
                    "terminated": step.terminated,
                    "truncated": step.truncated,
                },
            }));
        }
        let finish = episode.finished.as_ref();
        json!({
            "schema_version": ATIF_VERSION,
            "session_id": episode.id,
            "agent": {
                "name": if episode.agent.name.is_empty() { "unknown" } else { &episode.agent.name },
                "version": "unknown",
                "model_name": episode.agent.model,
            },
            "steps": steps,
            "final_metrics": { "total_steps": steps.len() },
            "extra": {
                "lattice": {
                    "environment": format!("research-writer env {}", env!("CARGO_PKG_VERSION")),
                    "task": episode.task.id,
                    "status": finish.map(|f| f.status.as_str()).unwrap_or("unfinished"),
                    "reward": finish.map(|f| f.reward),
                    "verdict": finish.map(|f| f.verdict.clone()),
                }
            },
        })
    }

    /// The line `python3 -m lattice_env calibrate` reads for this episode.
    pub(crate) fn record_line(episode: &Episode) -> Value {
        let finish = episode.finished.as_ref();
        let verdict = finish.map(|f| f.verdict.clone()).unwrap_or(Value::Null);
        let codes: Vec<Value> = verdict["redLines"]
            .as_array()
            .map(|lines| lines.iter().map(|line| line["code"].clone()).collect())
            .unwrap_or_default();
        json!({
            "task": episode.task.id,
            "episode": episode.id,
            "agent": episode.agent.name,
            "model": episode.agent.model,
            "status": finish.map(|f| f.status.as_str()).unwrap_or("unfinished"),
            "reward": finish.filter(|f| f.status == "scored").map(|f| f.reward),
            "redLines": codes,
            "honeypotsTouched": verdict["honeypotsTouched"],
        })
    }
}
