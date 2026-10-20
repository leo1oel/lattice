//! `research-writer env`: Lattice as a training and evaluation environment
//! for paper-writing agents, over JSON lines on stdin and stdout.
//!
//! Like `literature`, it runs from the app's own binary before Tauri or
//! AppKit start, so an agent works through the shipping domain code: the
//! same diagnostics, history-backed edits, SyncTeX and symbol checks a
//! writer gets. Tasks are the research environment's Harbor task packages
//! (`research-env/`), so one task runs both here, with Lattice's own tools
//! on macOS, and in Harbor's Linux container with a plain shell; both score
//! it with the package's own `tests/verify.py`.
//!
//! - `protocol` is the wire format: reset, step, info, close.
//! - `episode` copies a task's workspace into a folder of its own (with its
//!   own HOME, so nothing lands in the real app's caches), keeps the budget,
//!   and runs the verifier on submit.
//! - `actions` are the agent's tools; the build is `latex::build_pinned`.
//! - `trajectory` writes each episode in Harbor's trajectory format, plus
//!   the record the calibration tool reads.
//!
//! Every exchange is also kept in `transcript.jsonl`, and `--replay` runs a
//! transcript's requests again and compares the observations, which is how
//! a session is replayed (and how determinism is checked).

mod actions;
mod episode;
mod protocol;
mod trajectory;

use episode::Episode;
use protocol::{Request, Response};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

struct Environment {
    episodes: PathBuf,
    episode: Option<Episode>,
}

impl Environment {
    fn new(episodes: PathBuf) -> Self {
        Self { episodes, episode: None }
    }

    /// Answer one request line; protocol errors come back as `{"error": ...}`.
    fn handle(&mut self, line: &str) -> Value {
        let request: Request = match serde_json::from_str(line) {
            Ok(request) => request,
            Err(error) => return json!({ "error": format!("Invalid request: {error}") }),
        };
        let answer = match request {
            Request::Reset { task, episode, agent, budget } => {
                self.close();
                Episode::reset(
                    &self.episodes,
                    &task,
                    episode,
                    agent.unwrap_or_default(),
                    budget.unwrap_or_default(),
                )
                .map(|(episode, response)| {
                    self.episode = Some(episode);
                    to_value(&response)
                })
            }
            Request::Step { role, action } => match self.episode.as_mut() {
                Some(episode) => episode.step(role, action).map(|response| to_value(&response)),
                None => Err("No episode is running; send a reset first.".to_string()),
            },
            Request::Info {} => Ok(info()),
            Request::Close {} => Ok(json!({ "closed": self.close() })),
        };
        let answer = answer.unwrap_or_else(|error| json!({ "error": error }));
        if let Some(episode) = &self.episode {
            append_line(
                &episode.dir.join("transcript.jsonl"),
                &json!({ "request": raw(line), "response": answer }),
            );
        }
        answer
    }

    /// Write the running episode's trajectory and record; its id, if any.
    fn close(&mut self) -> Option<String> {
        let episode = self.episode.take()?;
        let atif = episode.trajectory.to_atif(&episode);
        let _ = fs::write(
            episode.dir.join("trajectory.json"),
            serde_json::to_vec_pretty(&atif).unwrap_or_default(),
        );
        append_line(
            &self.episodes.join("episodes.jsonl"),
            &trajectory::Trajectory::record_line(&episode),
        );
        Some(episode.id)
    }
}

fn to_value(response: &Response) -> Value {
    serde_json::to_value(response).unwrap_or_else(|error| json!({ "error": error.to_string() }))
}

fn raw(line: &str) -> Value {
    serde_json::from_str(line).unwrap_or(Value::String(line.to_string()))
}

fn append_line(path: &Path, value: &Value) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{value}");
    }
}

fn info() -> Value {
    json!({
        "environment": "research-writer env",
        "version": env!("CARGO_PKG_VERSION"),
        "ops": ["reset", "step", "info", "close"],
        "roles": ["agent", "human", "simulator", "system"],
        "actions": ["list_files", "read", "search", "edit", "write", "compile", "pdf_text", "synctex",
                    "synctex_inverse", "check", "submit", "defer"],
        "trajectory": trajectory::ATIF_VERSION,
    })
}

/// A response with what may differ between two runs of the same requests
/// (timings, episode ids and folders) left out: `info` and `error` paths.
fn comparable(response: &Value) -> Value {
    let mut response = response.clone();
    if let Some(object) = response.as_object_mut() {
        object.remove("info");
    }
    response
}

/// Run a transcript's requests again in a fresh folder; the mismatches.
fn replay(transcript: &Path, episodes: PathBuf) -> Result<Vec<Value>, String> {
    let raw = fs::read_to_string(transcript).map_err(|error| error.to_string())?;
    let mut environment = Environment::new(episodes);
    let mut mismatches = Vec::new();
    for (index, line) in raw.lines().filter(|line| !line.trim().is_empty()).enumerate() {
        let record: Value = serde_json::from_str(line).map_err(|error| error.to_string())?;
        let mut request = record["request"].clone();
        // A fresh id: the recorded episode's folder may still exist.
        if let Some(object) = request.as_object_mut() {
            object.remove("episode");
        }
        let answer = environment.handle(&request.to_string());
        if comparable(&answer) != comparable(&record["response"]) {
            mismatches.push(json!({ "line": index + 1, "request": request, "expected": comparable(&record["response"]), "got": comparable(&answer) }));
        }
    }
    environment.close();
    Ok(mismatches)
}

fn default_episodes() -> PathBuf {
    std::env::temp_dir().join(format!("lattice-env-{}", std::process::id()))
}

/// Serve `<executable> env [--episodes DIR] [--replay TRANSCRIPT]` and exit
/// the process; returns false when this is an ordinary app launch. Must run
/// before anything touches Tauri or AppKit.
pub(crate) fn run_cli() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("env") {
        return false;
    }
    let (mut episodes, mut transcript) = (None, None);
    while let Some(flag) = args.next() {
        match (flag.as_str(), args.next()) {
            ("--episodes", Some(value)) => episodes = Some(PathBuf::from(value)),
            ("--replay", Some(value)) => transcript = Some(PathBuf::from(value)),
            _ => {
                eprintln!("Usage: research-writer env [--episodes DIR] [--replay TRANSCRIPT]");
                std::process::exit(2);
            }
        }
    }
    let episodes = episodes.unwrap_or_else(default_episodes);
    if let Err(error) = fs::create_dir_all(&episodes) {
        eprintln!("Could not create {}: {error}", episodes.display());
        std::process::exit(2);
    }
    if let Some(transcript) = transcript {
        match replay(&transcript, episodes) {
            Ok(mismatches) => {
                println!("{}", json!({ "mismatches": mismatches.len(), "details": mismatches }));
                std::process::exit(if mismatches.is_empty() { 0 } else { 1 });
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
    }
    let mut environment = Environment::new(episodes);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = environment.handle(&line);
        let _ = writeln!(stdout, "{answer}");
        let _ = stdout.flush();
    }
    environment.close();
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// A task package whose verifier is a stub that scores the workspace 1
    /// when main.tex says "fixed": the environment's side of the contract
    /// with `tests/verify.py`, without needing the research environment.
    fn stub_task(dir: &TempDir) -> PathBuf {
        let task = dir.join("task");
        fs::create_dir_all(task.join("environment/workspace")).unwrap();
        fs::create_dir_all(task.join("tests")).unwrap();
        fs::write(task.join("instruction.md"), "Repair the paper.\n").unwrap();
        fs::write(task.join("environment/workspace/main.tex"), "broken\n").unwrap();
        fs::write(
            task.join("tests/task.json"),
            r#"{"id":"stub-task","root":"main.tex","engine":"pdf","epoch":1700000000}"#,
        )
        .unwrap();
        fs::write(
            task.join("tests/verify.py"),
            "import json, sys, pathlib\n\
             args = dict(zip(sys.argv[1::2], sys.argv[2::2]))\n\
             fixed = 'fixed' in pathlib.Path(args['--workspace'], 'main.tex').read_text()\n\
             out = pathlib.Path(args['--out']); out.mkdir(parents=True, exist_ok=True)\n\
             verdict = {'status': 'scored', 'reward': 1.0 if fixed else 0.0, 'components': {}, 'redLines': [], 'honeypotsTouched': []}\n\
             (out / 'verdict.json').write_text(json.dumps(verdict))\n",
        )
        .unwrap();
        task
    }

    /// The preference exporter (`research-env/lattice_env/preferences.py`)
    /// is tested on this fixture; reading it with the app's own parser keeps
    /// the two in step when the annotation schema changes.
    #[test]
    fn the_preference_exporters_fixture_is_what_lattice_reads() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../research-env/tests/fixtures/annotated-paper");
        let annotations = crate::project::read_annotations(&root).unwrap();
        assert_eq!(annotations.annotations.len(), 5);
        assert_eq!(annotations.rounds.len(), 2);
        let accepted = &annotations.annotations[0];
        let revision = accepted.revision.as_ref().unwrap();
        assert_eq!((revision.round, revision.state.as_str()), (1, "accepted"));
        assert_eq!(accepted.intent.as_deref(), Some("shorten"));
        let files = crate::project::read_annotation_round(&root, 1).unwrap();
        assert_eq!(files[0].path, "main.tex");
        assert!(files[0].before.as_deref().unwrap().contains("Large language models"));
        assert!(files[0].after.as_deref().unwrap().contains("Researchers increasingly"));
    }

    #[test]
    fn protocol_errors_are_answers_not_crashes() {
        let dir = TempDir::new("env");
        let mut environment = Environment::new(dir.join("episodes"));
        assert!(environment.handle("not json")["error"]
            .as_str()
            .unwrap()
            .starts_with("Invalid request"));
        let step = environment.handle(r#"{"op":"step","action":{"type":"compile"}}"#);
        assert!(step["error"].as_str().unwrap().contains("reset first"));
        assert_eq!(environment.handle(r#"{"op":"info"}"#)["trajectory"], trajectory::ATIF_VERSION);
    }

    #[test]
    #[ignore = "requires latexmk and python3"]
    fn an_episode_edits_submits_and_leaves_a_trajectory_and_a_record() {
        let dir = TempDir::new("env");
        let task = stub_task(&dir);
        let episodes = dir.join("episodes");
        fs::create_dir_all(&episodes).unwrap();
        let mut environment = Environment::new(episodes.clone());
        let reset = environment
            .handle(&json!({ "op": "reset", "task": task, "episode": "e1" }).to_string());
        assert_eq!(reset["obs"]["public"]["instruction"], "Repair the paper.\n", "{reset}");
        assert_eq!(reset["obs"]["public"]["build"]["success"], false);
        let human = environment.handle(r#"{"op":"step","role":"human","action":{"type":"write","path":"notes.tex","text":"x"}}"#);
        assert_eq!(human["obs"]["public"]["ok"], true, "{human}");
        let edit = environment.handle(r#"{"op":"step","action":{"type":"edit","path":"main.tex","old":"broken","new":"fixed"}}"#);
        assert_eq!(
            edit["events"][0]["by"], "human",
            "the agent hears about the writer's edit: {edit}"
        );
        let submit =
            environment.handle(r#"{"op":"step","action":{"type":"submit","claim":"solved"}}"#);
        assert_eq!(
            (submit["reward"].as_f64(), submit["terminated"].as_bool()),
            (Some(1.0), Some(true)),
            "{submit}"
        );
        assert_eq!(submit["info"]["claimMatches"], true);
        assert!(
            environment.handle(r#"{"op":"step","action":{"type":"compile"}}"#)["error"].is_string()
        );
        environment.close();
        let atif: Value =
            serde_json::from_slice(&fs::read(episodes.join("e1/trajectory.json")).unwrap())
                .unwrap();
        assert_eq!(atif["schema_version"], trajectory::ATIF_VERSION);
        assert_eq!(atif["steps"][2]["source"], "agent");
        assert_eq!(atif["steps"][1]["source"], "user", "the writer's step");
        let record = fs::read_to_string(episodes.join("episodes.jsonl")).unwrap();
        assert!(
            record.contains(r#""reward":1.0"#) && record.contains(r#""task":"stub-task""#),
            "{record}"
        );
        // The same requests again, in a fresh folder, observe the same things.
        let mismatches = replay(&episodes.join("e1/transcript.jsonl"), dir.join("replay")).unwrap();
        assert!(mismatches.is_empty(), "{mismatches:?}");
    }
}
