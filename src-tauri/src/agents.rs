use crate::commands;
use crate::models::{
    AgentResult, AgentSettings, AgentStreamEvent, SubscriptionLoginEvent, SubscriptionStatus,
};
use crate::project;
use crate::skill_store;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const AGENT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
#[derive(Clone)]
pub struct AgentRuntime {
    pub executable: PathBuf,
    pub assets: PathBuf,
    pub config: PathBuf,
}

pub struct AgentRequest<'a> {
    pub settings: &'a AgentSettings,
    pub message: &'a str,
    pub active_file: Option<&'a str>,
    pub selection: Option<&'a str>,
    pub session_id: &'a str,
    pub session_title: &'a str,
    pub system_prompt: &'a str,
}

pub struct ForkedSession {
    pub session_id: String,
    pub source_timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OmpSessionRef {
    session_id: String,
    file_name: String,
}

struct OmpAuth {
    provider: &'static str,
    environment: Option<(&'static str, String)>,
}

pub fn run(
    root: &Path,
    runtime: &AgentRuntime,
    request: AgentRequest<'_>,
    on_event: &dyn Fn(AgentStreamEvent),
) -> Result<AgentResult, String> {
    if request.message.trim().is_empty() {
        return Err("Write a message first.".to_string());
    }
    if request.settings.model.trim().is_empty()
        || request.settings.reasoning_effort.trim().is_empty()
    {
        return Err("Choose a model and reasoning effort.".to_string());
    }

    let before = project::snapshot_text_files(root)?;
    on_event(AgentStreamEvent::Status {
        message: "Starting agent…".to_string(),
    });
    let outcome = run_omp(root, runtime, &request, on_event);
    let transaction = project::record_external_changes(
        root,
        &before,
        &format!("Agent: {}", compact_label(request.message)),
    )?;
    let changed_files = transaction
        .as_ref()
        .map(|record| {
            record
                .changes
                .iter()
                .map(|change| change.path.clone())
                .collect()
        })
        .unwrap_or_default();

    match outcome {
        Ok(summary) => Ok(AgentResult {
            summary,
            changed_files,
            transaction_id: transaction.map(|record| record.id),
            skills_used: Vec::new(),
        }),
        Err(error) if transaction.is_some() => Ok(AgentResult {
            summary: format!(
                "The agent stopped before it could finish its response, but its file changes were preserved in Project History.\n\n{error}"
            ),
            changed_files,
            transaction_id: transaction.map(|record| record.id),
            skills_used: Vec::new(),
        }),
        Err(error) => Err(error),
    }
}

fn run_omp(
    root: &Path,
    runtime: &AgentRuntime,
    request: &AgentRequest<'_>,
    on_event: &dyn Fn(AgentStreamEvent),
) -> Result<String, String> {
    let command = omp_command(
        root,
        runtime,
        request.settings,
        request.session_id,
        request.session_title,
        request.system_prompt,
    )?;

    let mut process = JsonLineProcess::spawn(command, "Lattice agent")?;
    let state = process.request("lattice-session-state", "get_state", json!({}))?;
    persist_session_from_state(root, request.session_id, &state)?;
    if !request.session_title.trim().is_empty() {
        process.request(
            "lattice-session-name",
            "set_session_name",
            json!({ "name": request.session_title.trim() }),
        )?;
    }
    let prompt = editor_prompt(request.message, request.active_file, request.selection);
    process.send(&json!({
        "id": "lattice-prompt",
        "type": "prompt",
        "message": prompt
    }))?;

    on_event(AgentStreamEvent::Status {
        message: "Thinking…".to_string(),
    });
    let mut visible = String::new();
    let mut accepted = false;
    let mut completed = false;
    let mut failure = None;
    loop {
        let Some(value) = process.next_value()? else {
            let (_, stderr) = process.finish(false)?;
            return Err(format!(
                "The agent stopped before completing the response.{}",
                stderr_suffix(&stderr)
            ));
        };
        if value.get("type").and_then(Value::as_str) == Some("response")
            && value.get("id").and_then(Value::as_str) == Some("lattice-prompt")
        {
            accepted = value
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !accepted {
                failure = Some(
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("The agent rejected the prompt.")
                        .to_string(),
                );
            }
        }
        match value.get("type").and_then(Value::as_str) {
            Some("message_update") => {
                let event = value.get("assistantMessageEvent").unwrap_or(&Value::Null);
                match event.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                            visible.push_str(delta);
                            on_event(AgentStreamEvent::Text {
                                text: visible.clone(),
                            });
                        }
                    }
                    Some("error") => {
                        failure = Some(
                            event
                                .get("error")
                                .and_then(Value::as_str)
                                .or_else(|| event.get("reason").and_then(Value::as_str))
                                .unwrap_or("The model stopped with an error.")
                                .to_string(),
                        );
                    }
                    _ => {}
                }
            }
            Some("message_end") if visible.trim().is_empty() => {
                if let Some(text) = assistant_text(value.get("message").unwrap_or(&Value::Null)) {
                    visible = text;
                    on_event(AgentStreamEvent::Text {
                        text: visible.clone(),
                    });
                }
            }
            Some("tool_execution_start") => {
                on_event(AgentStreamEvent::Status {
                    message: tool_status(&value),
                });
            }
            Some("extension_error") => {
                failure = Some(
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("A Lattice agent extension failed.")
                        .to_string(),
                );
            }
            Some("agent_end") => completed = true,
            Some("prompt_result")
                if value.get("id").and_then(Value::as_str) == Some("lattice-prompt")
                    && value.get("agentInvoked").and_then(Value::as_bool) == Some(false) =>
            {
                completed = true;
            }
            _ => {}
        }
        if completed && accepted {
            break;
        }
        if failure.is_some() && !accepted {
            break;
        }
    }
    let (_, stderr) = process.finish(false)?;
    if let Some(error) = failure {
        return Err(format!("{error}{}", stderr_suffix(&stderr)));
    }
    if !accepted {
        return Err(format!(
            "The agent did not accept the prompt.{}",
            stderr_suffix(&stderr)
        ));
    }
    Ok(if visible.trim().is_empty() {
        "Finished working on the project.".to_string()
    } else {
        visible.trim().to_string()
    })
}

pub fn fork_session(
    root: &Path,
    runtime: &AgentRuntime,
    settings: &AgentSettings,
    source_session_id: &str,
    session_title: &str,
    user_message_index: usize,
    system_prompt: &str,
) -> Result<ForkedSession, String> {
    let command = omp_command(
        root,
        runtime,
        settings,
        source_session_id,
        session_title,
        system_prompt,
    )?;
    let mut process = JsonLineProcess::spawn(command, "Lattice agent")?;
    let fork_messages = process.request("lattice-fork-messages", "get_branch_messages", json!({}))?;
    let messages = fork_messages
        .pointer("/data/messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "OMP did not return the conversation branch points.".to_string())?;
    let entry_id = messages
        .get(user_message_index)
        .and_then(|message| message.get("entryId"))
        .and_then(Value::as_str)
        .ok_or_else(|| "This conversation cannot be branched because its OMP history is incomplete.".to_string())?;
    let source_timestamp = session_entry_timestamp(root, source_session_id, entry_id)?;
    let branch = process.request(
        "lattice-fork",
        "branch",
        json!({ "entryId": entry_id }),
    )?;
    if branch.pointer("/data/cancelled").and_then(Value::as_bool) == Some(true) {
        return Err("An OMP extension cancelled the conversation branch.".to_string());
    }
    let state = process.request("lattice-fork-state", "get_state", json!({}))?;
    let session_id = state
        .pointer("/data/sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "OMP did not create a conversation branch.".to_string())?
        .to_string();
    persist_session_from_state(root, &session_id, &state)?;
    if !session_title.trim().is_empty() {
        process.request(
            "lattice-fork-name",
            "set_session_name",
            json!({ "name": session_title.trim() }),
        )?;
    }
    let _ = process.finish(false)?;
    Ok(ForkedSession {
        session_id,
        source_timestamp,
    })
}

fn omp_command(
    root: &Path,
    runtime: &AgentRuntime,
    settings: &AgentSettings,
    session_id: &str,
    _session_title: &str,
    system_prompt: &str,
) -> Result<Command, String> {
    if !runtime.executable.is_file() {
        return Err(format!(
            "The bundled agent runtime is missing at {}.",
            runtime.executable.display()
        ));
    }
    if !runtime.assets.is_dir() {
        return Err(format!(
            "The bundled OMP resources are missing at {}.",
            runtime.assets.display()
        ));
    }
    let auth = prepare_auth(runtime, &settings.provider)?;
    let session_dir = root.join(".research/omp-sessions");
    fs::create_dir_all(&session_dir).map_err(err)?;
    fs::create_dir_all(&runtime.config).map_err(err)?;
    let overlay = prepare_omp_overlay(root, runtime)?;
    let executable = runtime
        .executable
        .to_str()
        .ok_or_else(|| "The bundled agent path is not valid UTF-8.".to_string())?;
    let mut command = commands::command(executable);
    command
        .current_dir(root)
        .env("PI_CODING_AGENT_DIR", &runtime.config)
        .arg("--mode")
        .arg("rpc")
        .arg("--model")
        .arg(format!("{}/{}", auth.provider, settings.model))
        .arg("--thinking")
        .arg(omp_thinking_level(&settings.reasoning_effort))
        .arg("--session-dir")
        .arg(&session_dir)
        .arg("--config")
        .arg(overlay)
        .arg("--no-extensions")
        .arg("--no-rules")
        .arg("--no-title")
        .arg("--auto-approve")
        .arg("--extension")
        .arg(runtime.assets.join("lattice.ts"));
    if let Some((name, value)) = auth.environment {
        command.env(name, value);
    }
    if let Some(session_file) = omp_session_file(root, session_id)? {
        command.arg("--resume").arg(session_file);
    }
    if !system_prompt.trim().is_empty() {
        command.arg("--system-prompt").arg(system_prompt.trim());
    }
    Ok(command)
}

fn prepare_omp_overlay(root: &Path, runtime: &AgentRuntime) -> Result<PathBuf, String> {
    let runtime_root = root.join(".research/omp-runtime");
    let skills_root = runtime_root.join("skills");
    if skills_root.is_dir() {
        fs::remove_dir_all(&skills_root).map_err(err)?;
    }
    fs::create_dir_all(&skills_root).map_err(err)?;
    for skill_file in skill_store::enabled_paths(root, runtime)? {
        let source = skill_file
            .parent()
            .ok_or_else(|| format!("Invalid skill path: {}", skill_file.display()))?;
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("Invalid skill path: {}", source.display()))?;
        copy_directory(source, &skills_root.join(name))?;
    }

    let skills_path = skills_root
        .to_str()
        .ok_or_else(|| "The OMP skill directory is not valid UTF-8.".to_string())?;
    let quoted_skills_path = serde_json::to_string(skills_path).map_err(err)?;
    let overlay = runtime_root.join("config.yml");
    let contents = format!(
        concat!(
            "disabledProviders:\n",
            "  - native\n",
            "  - claude\n",
            "  - codex\n",
            "  - gemini\n",
            "  - opencode\n",
            "  - github\n",
            "  - agents\n",
            "  - agents-md\n",
            "skills:\n",
            "  enabled: true\n",
            "  enableCodexUser: false\n",
            "  enableClaudeUser: false\n",
            "  enableClaudeProject: false\n",
            "  enablePiUser: false\n",
            "  enablePiProject: false\n",
            "  enableAgentsUser: false\n",
            "  enableAgentsProject: false\n",
            "  customDirectories: [{}]\n",
        ),
        quoted_skills_path,
    );
    fs::write(&overlay, contents).map_err(err)?;
    Ok(overlay)
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(err)?;
    for entry in fs::read_dir(source).map_err(err)? {
        let entry = entry.map_err(err)?;
        let target = destination.join(entry.file_name());
        if entry.file_type().map_err(err)?.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(err)?;
        }
    }
    Ok(())
}

fn omp_thinking_level(level: &str) -> &str {
    match level {
        "none" => "off",
        "ultra" => "max",
        other => other,
    }
}

fn session_map_path(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(session_id)
        .map_err(|_| "Invalid conversation id for the OMP session.".to_string())?;
    Ok(root
        .join(".research/omp-session-map")
        .join(format!("{session_id}.json")))
}

fn omp_session_file(root: &Path, session_id: &str) -> Result<Option<PathBuf>, String> {
    let map_path = session_map_path(root, session_id)?;
    if !map_path.is_file() {
        let suffix = format!("_{session_id}.jsonl");
        let session_dir = root.join(".research/omp-sessions");
        if session_dir.is_dir() {
            if let Some(path) = fs::read_dir(&session_dir)
                .map_err(err)?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.ends_with(&suffix))
                })
            {
                return Ok(Some(path));
            }
        }
        return migrate_legacy_pi_session(root, session_id, &suffix);
    }
    let session: OmpSessionRef =
        serde_json::from_str(&fs::read_to_string(&map_path).map_err(err)?).map_err(err)?;
    uuid::Uuid::parse_str(&session.session_id)
        .map_err(|_| "The saved OMP session id is invalid.".to_string())?;
    let file_name = Path::new(&session.file_name);
    if file_name.file_name().and_then(|name| name.to_str()) != Some(&session.file_name)
        || file_name.extension().and_then(|value| value.to_str()) != Some("jsonl")
    {
        return Err("The saved OMP session path is invalid.".to_string());
    }
    let path = root.join(".research/omp-sessions").join(file_name);
    if !path.is_file() {
        return Err(format!(
            "The OMP conversation history is missing at {}.",
            path.display()
        ));
    }
    Ok(Some(path))
}

fn migrate_legacy_pi_session(
    root: &Path,
    session_id: &str,
    suffix: &str,
) -> Result<Option<PathBuf>, String> {
    let legacy_dir = root.join(".research/pi-sessions");
    if !legacy_dir.is_dir() {
        return Ok(None);
    }
    let mut candidates = fs::read_dir(&legacy_dir)
        .map_err(err)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(suffix))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    let Some(source) = candidates.pop() else {
        return Ok(None);
    };
    let raw = fs::read_to_string(&source).map_err(err)?;
    let header = raw
        .lines()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "The legacy Pi conversation is empty.".to_string())?;
    let header: Value = serde_json::from_str(header).map_err(err)?;
    if header.get("type").and_then(Value::as_str) != Some("session")
        || header.get("id").and_then(Value::as_str) != Some(session_id)
    {
        return Err("The legacy Pi conversation does not match this conversation.".to_string());
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "The legacy Pi conversation has no file name.".to_string())?;
    let session_dir = root.join(".research/omp-sessions");
    fs::create_dir_all(&session_dir).map_err(err)?;
    let destination = session_dir.join(file_name);
    let migrated = sanitize_legacy_pi_jsonl(&raw)?;
    fs::write(&destination, migrated).map_err(err)?;
    Ok(Some(destination))
}

fn sanitize_legacy_pi_jsonl(raw: &str) -> Result<String, String> {
    let mut lines = Vec::new();
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        let mut value: Value = serde_json::from_str(line).map_err(err)?;
        if value.pointer("/message/role").and_then(Value::as_str) == Some("user") {
            if let Some(content) = value
                .pointer_mut("/message/content")
                .and_then(Value::as_array_mut)
            {
                for part in content {
                    if let Some(clean) = part
                        .get("text")
                        .and_then(Value::as_str)
                        .and_then(without_legacy_editor_context)
                    {
                        part["text"] = Value::String(clean.to_string());
                    }
                }
            }
        }
        lines.push(serde_json::to_string(&value).map_err(err)?);
    }
    Ok(format!("{}\n", lines.join("\n")))
}

fn without_legacy_editor_context(text: &str) -> Option<&str> {
    const START: &str = "\n\n<lattice_editor_context>";
    const END: &str = "</lattice_editor_context>";
    if !text.ends_with(END) {
        return None;
    }
    text.find(START).map(|index| &text[..index])
}

fn persist_session_from_state(
    root: &Path,
    lattice_session_id: &str,
    state: &Value,
) -> Result<(), String> {
    let omp_session_id = state
        .pointer("/data/sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "OMP did not provide a session id.".to_string())?;
    uuid::Uuid::parse_str(omp_session_id)
        .map_err(|_| "OMP returned an invalid session id.".to_string())?;
    let session_file = state
        .pointer("/data/sessionFile")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "OMP did not provide a persistent session file.".to_string())?;
    let file_name = session_file
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| value.ends_with(".jsonl"))
        .ok_or_else(|| "OMP returned an invalid session file.".to_string())?;
    let expected_parent = root.join(".research/omp-sessions");
    if session_file.parent() != Some(expected_parent.as_path()) {
        return Err("OMP tried to place conversation history outside this project.".to_string());
    }
    let reference = OmpSessionRef {
        session_id: omp_session_id.to_string(),
        file_name: file_name.to_string(),
    };
    let path = session_map_path(root, lattice_session_id)?;
    fs::create_dir_all(path.parent().expect("OMP map path has a parent")).map_err(err)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        format!("{}\n", serde_json::to_string_pretty(&reference).map_err(err)?),
    )
    .map_err(err)?;
    fs::rename(temporary, path).map_err(err)
}

fn session_entry_timestamp(
    root: &Path,
    session_id: &str,
    entry_id: &str,
) -> Result<Option<String>, String> {
    let Some(path) = omp_session_file(root, session_id)? else {
        return Ok(None);
    };
    for line in fs::read_to_string(path).map_err(err)?.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry.get("id").and_then(Value::as_str) == Some(entry_id) {
            return Ok(entry
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_string));
        }
    }
    Ok(None)
}

fn editor_prompt(message: &str, active_file: Option<&str>, selection: Option<&str>) -> String {
    let Some(selection) = selection.filter(|text| !text.is_empty()) else {
        return message.to_string();
    };
    let active_file = active_file
        .filter(|path| !path.trim().is_empty())
        .unwrap_or("the active editor");
    format!(
        "{message}\n\n--- Lattice editor selection from {active_file} ---\n{selection}\n--- End Lattice editor selection ---"
    )
}

fn assistant_text(message: &Value) -> Option<String> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let text = message
        .get("content")?
        .as_array()?
        .iter()
        .filter(|content| content.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

fn tool_status(value: &Value) -> String {
    let name = value
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let args = value.get("args").unwrap_or(&Value::Null);
    let target = args
        .get("path")
        .or_else(|| args.get("file_path"))
        .and_then(Value::as_str);
    match (name, target) {
        ("read", Some(path)) => format!("Reading {path}…"),
        ("edit" | "write", Some(path)) => format!("Editing {path}…"),
        ("bash", _) => "Running a project command…".to_string(),
        (_, Some(path)) => format!("Using {name} on {path}…"),
        _ => format!("Using {name}…"),
    }
}

fn compact_label(message: &str) -> String {
    let compact = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut value = compact.chars().take(64).collect::<String>();
    if compact.chars().count() > 64 {
        value.push('…');
    }
    value
}

fn prepare_auth(runtime: &AgentRuntime, provider: &str) -> Result<OmpAuth, String> {
    match provider {
        "codex" => Ok(OmpAuth {
            provider: "openai-codex",
            environment: legacy_subscription_environment(runtime, "codex"),
        }),
        "claude" => Ok(OmpAuth {
            provider: "anthropic",
            environment: legacy_subscription_environment(runtime, "claude"),
        }),
        "openai-api" => Ok(OmpAuth {
            provider: "openai",
            environment: Some(("OPENAI_API_KEY", load_api_key("openai")?)),
        }),
        "anthropic-api" => Ok(OmpAuth {
            provider: "anthropic",
            environment: Some(("ANTHROPIC_API_KEY", load_api_key("anthropic")?)),
        }),
        _ => Err("Choose Codex, Claude, OpenAI API, or Anthropic API.".to_string()),
    }
}

fn legacy_subscription_environment(
    runtime: &AgentRuntime,
    provider: &str,
) -> Option<(&'static str, String)> {
    if omp_auth_marker(runtime, provider).is_file() {
        return None;
    }
    match provider {
        "codex" => codex_access_token()
            .ok()
            .map(|token| ("OPENAI_CODEX_OAUTH_TOKEN", token)),
        "claude" => claude_access_token()
            .ok()
            .map(|token| ("ANTHROPIC_OAUTH_TOKEN", token)),
        _ => None,
    }
}

fn omp_auth_marker(runtime: &AgentRuntime, provider: &str) -> PathBuf {
    runtime.config.join(format!("lattice-{provider}-auth"))
}

fn codex_access_token() -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Could not find the current user folder.".to_string())?;
    let raw = fs::read_to_string(home.join(".codex/auth.json"))
        .map_err(|_| "Sign in to Codex before using the Codex subscription.".to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(err)?;
    let access = value
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "The Codex sign-in does not contain an access token.".to_string())?;
    let _expires = jwt_expiry_ms(access).ok_or_else(|| {
        "The Codex access token has an unreadable expiration time. Sign in again.".to_string()
    })?;
    Ok(access.to_string())
}

fn claude_access_token() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
            .map_err(|error| format!("Could not read the Claude sign-in: {error}"))?;
        if !output.status.success() {
            return Err("Sign in to Claude Code before using the Claude subscription.".to_string());
        }
        let value: Value = serde_json::from_slice(&output.stdout).map_err(err)?;
        let oauth = value.get("claudeAiOauth").ok_or_else(|| {
            "The Claude Code sign-in does not contain OAuth credentials.".to_string()
        })?;
        let access = oauth
            .get("accessToken")
            .and_then(Value::as_str)
            .ok_or_else(|| "The Claude sign-in does not contain an access token.".to_string())?;
        let _expires = oauth
            .get("expiresAt")
            .and_then(Value::as_u64)
            .ok_or_else(|| "The Claude sign-in has an unreadable expiration time.".to_string())?;
        Ok(access.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Err("Claude subscription sign-in is currently supported on macOS.".to_string())
}

fn jwt_expiry_ms(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    value.get("exp")?.as_u64()?.checked_mul(1000)
}

fn stderr_suffix(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("\n{trimmed}")
    }
}

struct JsonLineProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Result<Option<String>, String>>,
    stderr: Option<JoinHandle<Result<String, String>>>,
    deadline: Instant,
    label: &'static str,
    finished: bool,
}

impl JsonLineProcess {
    fn spawn(mut command: Command, label: &'static str) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start {label}: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("Could not open {label} input."))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("Could not capture {label} output."))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("Could not capture {label} errors."))?;
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender
                    .send(line.map(Some).map_err(|error| error.to_string()))
                    .is_err()
                {
                    return;
                }
            }
            let _ = sender.send(Ok(None));
        });
        let stderr = thread::spawn(move || {
            let mut output = String::new();
            stderr
                .read_to_string(&mut output)
                .map_err(|error| error.to_string())?;
            Ok(output)
        });
        Ok(Self {
            child,
            stdin: Some(stdin),
            lines,
            stderr: Some(stderr),
            deadline: Instant::now() + AGENT_TIMEOUT,
            label,
            finished: false,
        })
    }

    fn send(&mut self, value: &Value) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| format!("{} input is closed.", self.label))?;
        serde_json::to_writer(&mut *stdin, value).map_err(err)?;
        stdin.write_all(b"\n").map_err(err)?;
        stdin.flush().map_err(err)
    }

    fn next_value(&self) -> Result<Option<Value>, String> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!("{} did not respond within 10 minutes.", self.label));
        }
        match self.lines.recv_timeout(remaining) {
            Ok(Ok(Some(line))) => serde_json::from_str(&line)
                .map(Some)
                .map_err(|error| format!("Could not parse {} output: {error}", self.label)),
            Ok(Ok(None)) => Ok(None),
            Ok(Err(error)) => Err(format!("Could not read {} output: {error}", self.label)),
            Err(RecvTimeoutError::Timeout) => {
                Err(format!("{} did not respond within 10 minutes.", self.label))
            }
            Err(RecvTimeoutError::Disconnected) => Ok(None),
        }
    }

    fn request(&mut self, id: &str, command: &str, fields: Value) -> Result<Value, String> {
        let mut value = fields.as_object().cloned().unwrap_or_default();
        value.insert("id".to_string(), Value::String(id.to_string()));
        value.insert("type".to_string(), Value::String(command.to_string()));
        self.send(&Value::Object(value))?;
        loop {
            let response = self
                .next_value()?
                .ok_or_else(|| format!("{} stopped before responding to {command}.", self.label))?;
            if response.get("type").and_then(Value::as_str) != Some("response")
                || response.get("id").and_then(Value::as_str) != Some(id)
            {
                continue;
            }
            if response.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("OMP rejected the request.")
                    .to_string());
            }
            return Ok(response);
        }
    }

    fn finish(&mut self, terminate: bool) -> Result<(ExitStatus, String), String> {
        self.stdin.take();
        if terminate {
            let _ = self.child.kill();
        }
        let status = self
            .child
            .wait()
            .map_err(|error| format!("Could not stop {}: {error}", self.label))?;
        self.finished = true;
        let stderr = self
            .stderr
            .take()
            .ok_or_else(|| format!("Could not read {} errors.", self.label))?
            .join()
            .map_err(|_| format!("Could not read {} errors.", self.label))??;
        Ok((status, stderr))
    }
}

impl Drop for JsonLineProcess {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

pub fn save_api_key(provider: &str, key: &str) -> Result<(), String> {
    let provider = keychain_provider(provider)?;
    if key.trim().is_empty() {
        return Err("Enter an API key.".to_string());
    }
    keyring::Entry::new("app.leo1oel.researchwriter", provider)
        .map_err(err)?
        .set_password(key.trim())
        .map_err(|error| format!("Could not save the key in macOS Keychain: {error}"))
}

pub fn delete_api_key(provider: &str) -> Result<(), String> {
    let provider = keychain_provider(provider)?;
    let entry = keyring::Entry::new("app.leo1oel.researchwriter", provider).map_err(err)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Could not remove the key from macOS Keychain: {error}"
        )),
    }
}

pub fn api_key_status() -> Vec<(String, bool)> {
    ["openai", "anthropic"]
        .into_iter()
        .map(|provider| (provider.to_string(), load_api_key(provider).is_ok()))
        .collect()
}

fn load_api_key(provider: &str) -> Result<String, String> {
    let provider = keychain_provider(provider)?;
    keyring::Entry::new("app.leo1oel.researchwriter", provider)
        .map_err(err)?
        .get_password()
        .map_err(|_| {
            format!("No {provider} API key is configured. Open agent settings to add one.")
        })
}

fn keychain_provider(provider: &str) -> Result<&str, String> {
    match provider {
        "openai" | "anthropic" => Ok(provider),
        _ => Err("Unknown API key provider.".to_string()),
    }
}

pub fn subscription_status(runtime: &AgentRuntime) -> Result<Vec<SubscriptionStatus>, String> {
    let mut process = JsonLineProcess::spawn(omp_account_command(runtime)?, "OMP accounts")?;
    let response = process.request("lattice-login-providers", "get_login_providers", json!({}))?;
    let _ = process.finish(false)?;
    let providers = response
        .pointer("/data/providers")
        .and_then(Value::as_array)
        .ok_or_else(|| "OMP did not return its login providers.".to_string())?;
    [
        ("codex", "openai-codex", "ChatGPT Codex subscription"),
        ("claude", "anthropic", "Claude Pro or Max subscription"),
    ]
    .into_iter()
    .map(|(provider, omp_id, fallback_name)| {
        let account = providers
            .iter()
            .find(|account| account.get("id").and_then(Value::as_str) == Some(omp_id));
        let installed = account
            .and_then(|account| account.get("available"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let logged_in = account
            .and_then(|account| account.get("authenticated"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if logged_in {
            fs::write(omp_auth_marker(runtime, provider), "OMP\n").map_err(err)?;
        }
        let name = account
            .and_then(|account| account.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(fallback_name);
        Ok(SubscriptionStatus {
            provider: provider.to_string(),
            installed,
            logged_in,
            detail: if logged_in {
                format!("Connected through OMP · {name}")
            } else if installed {
                format!("Sign in through OMP · {name}")
            } else {
                format!("This OMP build does not provide {name}.")
            },
        })
    })
    .collect()
}

pub fn begin_subscription_login(
    runtime: &AgentRuntime,
    provider: &str,
    on_event: &dyn Fn(SubscriptionLoginEvent),
) -> Result<(), String> {
    let provider_id = match provider {
        "codex" => "openai-codex",
        "claude" => "anthropic",
        _ => return Err("Unknown OMP subscription provider.".to_string()),
    };
    let mut process = JsonLineProcess::spawn(omp_account_command(runtime)?, "OMP sign-in")?;
    process.send(&json!({
        "id": "lattice-login",
        "type": "login",
        "providerId": provider_id,
    }))?;
    let mut opened_browser = false;
    loop {
        let value = process
            .next_value()?
            .ok_or_else(|| "OMP stopped before sign-in completed.".to_string())?;
        if value.get("type").and_then(Value::as_str) == Some("extension_ui_request") {
            match value.get("method").and_then(Value::as_str) {
                Some("open_url") => {
                    let url = value
                        .get("launchUrl")
                        .or_else(|| value.get("url"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| "OMP returned an invalid sign-in URL.".to_string())?;
                    open_browser(url)?;
                    opened_browser = true;
                    let message = value
                        .get("instructions")
                        .and_then(Value::as_str)
                        .unwrap_or("Complete sign-in in your browser.");
                    on_event(SubscriptionLoginEvent {
                        message: message.to_string(),
                    });
                }
                Some("notify") => {
                    if let Some(message) = value.get("message").and_then(Value::as_str) {
                        on_event(SubscriptionLoginEvent {
                            message: message.to_string(),
                        });
                    }
                }
                Some("input") if opened_browser => {
                    on_event(SubscriptionLoginEvent {
                        message: "Waiting for the browser to return the authorization to OMP…"
                            .to_string(),
                    });
                }
                _ => {}
            }
            continue;
        }
        if value.get("type").and_then(Value::as_str) != Some("response")
            || value.get("id").and_then(Value::as_str) != Some("lattice-login")
        {
            continue;
        }
        if value.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("OMP sign-in failed.")
                .to_string());
        }
        fs::write(omp_auth_marker(runtime, provider), "OMP\n").map_err(err)?;
        on_event(SubscriptionLoginEvent {
            message: "Connected. OMP will manage and refresh this subscription."
                .to_string(),
        });
        let _ = process.finish(false)?;
        return Ok(());
    }
}

fn omp_account_command(runtime: &AgentRuntime) -> Result<Command, String> {
    if !runtime.executable.is_file() {
        return Err(format!(
            "The bundled OMP executable is missing at {}.",
            runtime.executable.display()
        ));
    }
    fs::create_dir_all(&runtime.config).map_err(err)?;
    let executable = runtime
        .executable
        .to_str()
        .ok_or_else(|| "The OMP executable path is not valid UTF-8.".to_string())?;
    let mut command = commands::command(executable);
    command
        .current_dir(&runtime.config)
        .env("PI_CODING_AGENT_DIR", &runtime.config)
        .arg("--mode")
        .arg("rpc")
        .arg("--no-session")
        .arg("--no-tools")
        .arg("--no-extensions")
        .arg("--no-skills")
        .arg("--no-rules")
        .arg("--no-title")
        .arg("--model")
        .arg("openai-codex/gpt-5.6-sol");
    Ok(command)
}

fn open_browser(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("OMP returned a sign-in URL with an unsupported scheme.".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.arg("/C").arg("start").arg("");
        command
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = Command::new("xdg-open");
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the OMP sign-in page: {error}"))
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_only_an_explicit_editor_selection_without_hidden_xml() {
        let prompt = editor_prompt(
            "Revise this.",
            Some("sections/method.tex"),
            Some("old text"),
        );
        assert!(prompt.starts_with("Revise this."));
        assert!(prompt.contains("sections/method.tex"));
        assert!(prompt.contains("old text"));
        assert!(!prompt.contains("<lattice_editor_context>"));
    }

    #[test]
    fn leaves_messages_untouched_without_editor_context() {
        assert_eq!(editor_prompt("Hello", None, None), "Hello");
        assert_eq!(
            editor_prompt("Hello", Some("main.tex"), None),
            "Hello"
        );
    }

    #[test]
    fn never_renders_a_user_message_as_assistant_text() {
        let user = json!({
            "role": "user",
            "content": [{"type": "text", "text": "Why repeat this?"}]
        });
        let assistant = json!({
            "role": "assistant",
            "content": [{"type": "text", "text": "I will not."}]
        });
        assert_eq!(assistant_text(&user), None);
        assert_eq!(assistant_text(&assistant).as_deref(), Some("I will not."));
    }

    #[test]
    fn creates_short_history_labels() {
        assert!(compact_label(&"word ".repeat(30)).chars().count() <= 65);
    }

    #[test]
    fn maps_lattice_effort_names_to_omp() {
        assert_eq!(omp_thinking_level("none"), "off");
        assert_eq!(omp_thinking_level("high"), "high");
        assert_eq!(omp_thinking_level("ultra"), "max");
    }

    #[test]
    fn persists_an_omp_session_reference_inside_the_project() {
        let root = std::env::temp_dir().join(format!("lattice-omp-session-{}", uuid::Uuid::new_v4()));
        let session_dir = root.join(".research/omp-sessions");
        fs::create_dir_all(&session_dir).unwrap();
        let lattice_id = uuid::Uuid::new_v4().to_string();
        let omp_id = uuid::Uuid::new_v4().to_string();
        let file_name = format!("2026-07-18_{omp_id}.jsonl");
        let session_file = session_dir.join(&file_name);
        fs::write(&session_file, "{}\n").unwrap();
        let state = json!({
            "data": { "sessionId": omp_id, "sessionFile": session_file }
        });
        persist_session_from_state(&root, &lattice_id, &state).unwrap();
        assert_eq!(omp_session_file(&root, &lattice_id).unwrap(), Some(session_file));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_a_legacy_pi_conversation_before_omp_resumes_it() {
        let root = std::env::temp_dir().join(format!("lattice-omp-migration-{}", uuid::Uuid::new_v4()));
        let session_id = uuid::Uuid::new_v4().to_string();
        let legacy_dir = root.join(".research/pi-sessions");
        fs::create_dir_all(&legacy_dir).unwrap();
        let file_name = format!("2026-07-18T12-00-00_{session_id}.jsonl");
        fs::write(
            legacy_dir.join(&file_name),
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{session_id}\",\"timestamp\":\"2026-07-18T12:00:00Z\",\"cwd\":\"{}\"}}\n{{\"type\":\"message\",\"id\":\"message-1\",\"parentId\":null,\"timestamp\":\"2026-07-18T12:00:01Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"Hello\\n\\n<lattice_editor_context><active_file>main.tex</active_file></lattice_editor_context>\"}}]}}}}\n",
                root.display()
            ),
        )
        .unwrap();
        let migrated = omp_session_file(&root, &session_id).unwrap().unwrap();
        assert_eq!(migrated, root.join(".research/omp-sessions").join(file_name));
        assert!(migrated.is_file());
        let migrated_content = fs::read_to_string(migrated).unwrap();
        assert!(migrated_content.contains("Hello"));
        assert!(!migrated_content.contains("lattice_editor_context"));
        assert!(legacy_dir.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "uses the local Codex subscription and bundled OMP sidecar"]
    fn omp_edits_a_project_and_records_the_change() {
        let parent = std::env::temp_dir().join(format!("lattice-omp-e2e-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "paper").unwrap();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let runtime = AgentRuntime {
            executable: manifest
                .join("binaries")
                .join("lattice-agent-aarch64-apple-darwin"),
            assets: manifest.join("omp-assets"),
            config: parent.join("omp-config"),
        };
        let settings = AgentSettings {
            provider: "codex".to_string(),
            model: "gpt-5.6-sol".to_string(),
            reasoning_effort: "low".to_string(),
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        let message_id = uuid::Uuid::new_v4().to_string();
        project::save_conversation_checkpoint(&root, &session_id, &message_id).unwrap();
        let result = run(
            &root,
            &runtime,
            AgentRequest {
                settings: &settings,
                message: "Edit main.tex and replace 'Motivate the problem and state the paper's main contribution.' with 'State the research problem and central hypothesis clearly.' Then briefly report what you changed.",
                active_file: Some("main.tex"),
                selection: None,
                session_id: &session_id,
                session_title: "E2E",
                system_prompt: "",
            },
            &|_| {},
        )
        .unwrap();
        assert!(result.changed_files.contains(&"main.tex".to_string()));
        assert!(fs::read_to_string(root.join("main.tex"))
            .unwrap()
            .contains("State the research problem and central hypothesis clearly."));
        assert!(result.transaction_id.is_some());
        let branch = fork_session(
            &root,
            &runtime,
            &settings,
            &session_id,
            "E2E",
            0,
            "",
        )
        .unwrap();
        assert_ne!(branch.session_id, session_id);
        assert!(branch.source_timestamp.is_some());
        project::restore_conversation_checkpoint(
            &root,
            &session_id,
            &message_id,
            branch.source_timestamp.as_deref(),
        )
        .unwrap();
        assert!(fs::read_to_string(root.join("main.tex"))
            .unwrap()
            .contains("Motivate the problem and state the paper's main contribution."));
        assert!(root
            .join(".research/omp-session-map")
            .join(format!("{session_id}.json"))
            .is_file());
        fs::remove_dir_all(parent).unwrap();
    }
}
