//! One episode: a task package's workspace copied into a folder of its own,
//! the agent's steps against it, and the verdict of the task's verifier.
//!
//! The episode reads only the task package's public parts and its config:
//! `instruction.md`, `environment/workspace/`, and `tests/task.json` for the
//! root, engine and clock the build pins. The rest of `tests/` (the original
//! paper, the answer) stays where the agent's tools cannot reach it, and is
//! only read by the verifier the episode runs on submit, the same
//! `tests/verify.py` Harbor runs in its container.

use super::actions::{self, BuildSettings};
use super::protocol::{Action, AgentInfo, Budget, Claim, Observation, Response, Role};
use super::trajectory::{StepRecord, Trajectory};
use crate::{commands, project};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// What the episode needs from `tests/task.json`.
pub(crate) struct TaskSettings {
    pub id: String,
    pub family: String,
    pub root: String,
    pub engine: String,
    pub epoch: u64,
    pub build_timeout: Duration,
}

impl TaskSettings {
    fn read(task_dir: &Path) -> Result<Self, String> {
        let path = task_dir.join("tests/task.json");
        let raw = fs::read_to_string(&path)
            .map_err(|error| format!("{} is not a task package: {error}", task_dir.display()))?;
        let config: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let text = |key: &str, default: &str| {
            config.get(key).and_then(Value::as_str).unwrap_or(default).to_string()
        };
        Ok(Self {
            id: text("id", "task"),
            family: text("family", ""),
            root: text("root", "main.tex"),
            engine: text("engine", "pdf"),
            epoch: config.get("epoch").and_then(Value::as_u64).unwrap_or(1_700_000_000),
            build_timeout: Duration::from_secs(
                config.get("build_timeout_sec").and_then(Value::as_u64).unwrap_or(120),
            ),
        })
    }
}

pub(crate) struct Episode {
    pub id: String,
    pub task: TaskSettings,
    pub task_dir: PathBuf,
    pub dir: PathBuf,
    home: PathBuf,
    pub agent: AgentInfo,
    budget: Budget,
    steps_used: u32,
    compile_seconds: f64,
    events: Vec<Value>,
    pub finished: Option<Finish>,
    pub trajectory: Trajectory,
}

/// How the episode ended, for the trajectory and the episode record.
#[derive(Clone)]
pub(crate) struct Finish {
    pub status: String,
    pub reward: f64,
    pub verdict: Value,
}

impl Episode {
    pub(crate) fn workspace(&self) -> PathBuf {
        self.dir.join("workspace")
    }

    fn settings(&self) -> BuildSettings<'_> {
        BuildSettings {
            root: &self.task.root,
            engine: &self.task.engine,
            epoch: self.task.epoch,
            home: &self.home,
            timeout: self.task.build_timeout,
        }
    }

    /// Copy the task's workspace into `<episodes>/<id>/` and build it once.
    pub(crate) fn reset(
        episodes: &Path, task_dir: &Path, id: Option<String>, agent: AgentInfo, budget: Budget,
    ) -> Result<(Self, Response), String> {
        let task = TaskSettings::read(task_dir)?;
        let instruction = fs::read_to_string(task_dir.join("instruction.md"))
            .map_err(|error| format!("The task has no instruction.md: {error}"))?;
        let id = id.unwrap_or_else(|| format!("{}--{}", task.id, unique_suffix()));
        let dir = episodes.join(&id);
        if dir.exists() {
            return Err(format!("Episode {id} already exists in {}.", episodes.display()));
        }
        copy_tree(&task_dir.join("environment/workspace"), &dir.join("workspace"))?;
        fs::create_dir_all(dir.join("home")).map_err(|error| error.to_string())?;
        // Lattice's own caches live under HOME; an episode must not write into
        // the real app's (the scout's probe did, before it isolated HOME).
        std::env::set_var("HOME", dir.join("home"));
        let mut episode = Self {
            id,
            task,
            task_dir: task_dir.to_path_buf(),
            home: dir.join("home"),
            dir,
            agent,
            budget,
            steps_used: 0,
            compile_seconds: 0.0,
            events: Vec::new(),
            finished: None,
            trajectory: Trajectory::default(),
        };
        let workspace = episode.workspace();
        project::open(&workspace)?;
        project::set_compile_root(&workspace, &episode.task.root)?;
        let build = actions::compile(&workspace, &episode.settings())?;
        let files = actions::list_files(&workspace)?;
        let public = json!({
            "instruction": instruction,
            "files": files,
            "build": actions::build_observation(&build),
            "budget": episode.budget,
        });
        episode.trajectory.start(&instruction);
        let response = Response {
            obs: Observation { public, private: json!({}) },
            reward: 0.0,
            terminated: false,
            truncated: false,
            events: Vec::new(),
            info: json!({
                "episode": episode.id,
                "task": episode.task.id,
                "family": episode.task.family,
                "engine": episode.task.engine,
                "lattice": env!("CARGO_PKG_VERSION"),
                "buildMs": build.duration_ms as u64,
            }),
        };
        Ok((episode, response))
    }

    pub(crate) fn step(&mut self, role: Role, action: Action) -> Result<Response, String> {
        if self.finished.is_some() {
            return Err("This episode is over; reset to start another.".to_string());
        }
        let ends = matches!(action, Action::Submit { .. } | Action::Defer { .. });
        if ends && role != Role::Agent {
            return Err("Only the agent submits or defers.".to_string());
        }
        let response = match &action {
            Action::Submit { claim } => self.submit(*claim, false),
            Action::Defer { reason } => self.defer(reason),
            _ => self.act(role, &action),
        };
        self.trajectory.record(StepRecord::new(role, &action, &response));
        Ok(response)
    }

    fn act(&mut self, role: Role, action: &Action) -> Response {
        let (public, build) = actions::run(&self.workspace(), action, &self.settings());
        let mut info = json!({});
        if let Some(build) = &build {
            info["buildMs"] = json!(build.duration_ms as u64);
        }
        let changed = matches!(action, Action::Edit { path, .. } | Action::Write { path, .. }
            if public.get("ok").is_some() && !path.is_empty());
        if role != Role::Agent {
            // Another party changed the shared files: tell the agent next time
            // it acts, instead of making it take turns.
            if let (true, Action::Edit { path, .. } | Action::Write { path, .. }) =
                (changed, action)
            {
                self.events.push(json!({ "type": "file_changed", "by": role, "path": path }));
            }
            return respond(public, 0.0, false, false, Vec::new(), info);
        }
        self.steps_used += 1;
        if let Some(build) = &build {
            self.compile_seconds += build.duration_ms as f64 / 1000.0;
        }
        let events = std::mem::take(&mut self.events);
        info["budgetUsed"] =
            json!({ "steps": self.steps_used, "compileSeconds": self.compile_seconds });
        if self.steps_used >= self.budget.steps
            || self.compile_seconds >= self.budget.compile_seconds
        {
            let mut scored = self.submit(None, true);
            scored.obs.public["lastAction"] = public;
            scored.events = events;
            return scored;
        }
        respond(public, 0.0, false, false, events, info)
    }

    /// Run the task's verifier on the workspace as it stands.
    fn submit(&mut self, claim: Option<Claim>, truncated: bool) -> Response {
        let out = self.dir.join("verifier");
        let verdict = run_verifier(&self.task_dir, &self.workspace(), &out);
        let status =
            verdict.get("status").and_then(Value::as_str).unwrap_or("infra_error").to_string();
        let reward =
            if status == "scored" { verdict["reward"].as_f64().unwrap_or(0.0) } else { 0.0 };
        let mut info = json!({
            "status": status,
            "components": verdict.get("components").cloned().unwrap_or(json!({})),
            "gates": verdict.get("gates").cloned().unwrap_or(json!({})),
            "redLines": verdict.get("redLines").cloned().unwrap_or(json!([])),
            "honeypotsTouched": verdict.get("honeypotsTouched").cloned().unwrap_or(json!([])),
            "reason": verdict.get("reason").cloned().unwrap_or(Value::Null),
        });
        if let Some(claim) = claim {
            info["claim"] = json!(claim);
            info["claimMatches"] = json!(claim_matches(claim, reward));
        }
        self.finished = Some(Finish { status: status.clone(), reward, verdict });
        respond(json!({ "submitted": !truncated }), reward, !truncated, truncated, Vec::new(), info)
    }

    fn defer(&mut self, reason: &str) -> Response {
        let verdict = json!({ "status": "deferred", "reason": reason });
        self.finished = Some(Finish { status: "deferred".to_string(), reward: 0.0, verdict });
        respond(
            json!({ "deferred": true }),
            0.0,
            true,
            false,
            Vec::new(),
            json!({ "status": "deferred" }),
        )
    }
}

fn respond(
    public: Value, reward: f64, terminated: bool, truncated: bool, events: Vec<Value>, info: Value,
) -> Response {
    Response {
        obs: Observation { public, private: json!({}) },
        reward,
        terminated,
        truncated,
        events,
        info,
    }
}

/// Whether the agent's claim agrees with what the verifier found.
pub(crate) fn claim_matches(claim: Claim, reward: f64) -> bool {
    match claim {
        Claim::Solved => reward >= 1.0,
        Claim::Partial => reward > 0.0 && reward < 1.0,
        Claim::Unsolved => reward == 0.0,
    }
}

/// `python3 -I tests/verify.py`, as Harbor's `tests/test.sh` runs it; the
/// verdict it writes, or an `infra_error` saying why there is none.
fn run_verifier(task_dir: &Path, workspace: &Path, out: &Path) -> Value {
    let output = commands::command("python3")
        .arg("-I")
        .arg(task_dir.join("tests/verify.py"))
        .arg("--workspace")
        .arg(workspace)
        .arg("--out")
        .arg(out)
        .output();
    let verdict = fs::read_to_string(out.join("verdict.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    match (verdict, output) {
        (Some(verdict), _) => verdict,
        (None, Ok(output)) => json!({
            "status": "infra_error",
            "reason": commands::stderr_or(&output, "The verifier wrote no verdict."),
        }),
        (None, Err(error)) => {
            json!({ "status": "infra_error", "reason": format!("Could not start python3: {error}") })
        }
    }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!("{} is missing.", source.display()));
    }
    for entry in walkdir::WalkDir::new(source) {
        let entry = entry.map_err(|error| error.to_string())?;
        let relative = entry.path().strip_prefix(source).map_err(|error| error.to_string())?;
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
        } else if entry.file_type().is_file() {
            fs::copy(entry.path(), &destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!("{:x}-{}", nanos, std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_are_compared_with_the_reward() {
        assert!(claim_matches(Claim::Solved, 1.0));
        assert!(!claim_matches(Claim::Solved, 0.9));
        assert!(claim_matches(Claim::Partial, 0.4));
        assert!(claim_matches(Claim::Unsolved, 0.0));
        assert!(!claim_matches(Claim::Unsolved, 0.4));
    }
}
