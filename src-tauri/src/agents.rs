use crate::commands;
use crate::models::{AgentResult, AgentSettings, AgentStreamEvent, SubscriptionStatus};
use crate::project;
use crate::skill_store;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Map, Value};
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
    let outcome = run_pi(root, runtime, &request, on_event);
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

fn run_pi(
    root: &Path,
    runtime: &AgentRuntime,
    request: &AgentRequest<'_>,
    on_event: &dyn Fn(AgentStreamEvent),
) -> Result<String, String> {
    let command = pi_command(
        root,
        runtime,
        request.settings,
        request.session_id,
        request.session_title,
        request.system_prompt,
    )?;

    let mut process = JsonLineProcess::spawn(command, "Lattice agent")?;
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
            Some("agent_settled") => break,
            _ => {}
        }
    }
    let (_, stderr) = process.finish(true)?;
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
) -> Result<String, String> {
    let command = pi_command(
        root,
        runtime,
        settings,
        source_session_id,
        session_title,
        system_prompt,
    )?;
    let mut process = JsonLineProcess::spawn(command, "Lattice agent")?;
    let fork_messages = process.request("lattice-fork-messages", "get_fork_messages", json!({}))?;
    let messages = fork_messages
        .pointer("/data/messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Pi did not return the conversation branch points.".to_string())?;
    let entry_id = messages
        .get(user_message_index)
        .and_then(|message| message.get("entryId"))
        .and_then(Value::as_str)
        .ok_or_else(|| "This conversation cannot be branched because its Pi history is incomplete.".to_string())?;
    process.request(
        "lattice-fork",
        "fork",
        json!({ "entryId": entry_id }),
    )?;
    let state = process.request("lattice-fork-state", "get_state", json!({}))?;
    let session_id = state
        .pointer("/data/sessionId")
        .and_then(Value::as_str)
        .filter(|id| *id != source_session_id)
        .ok_or_else(|| "Pi did not create a distinct conversation branch.".to_string())?
        .to_string();
    let _ = process.finish(true)?;
    Ok(session_id)
}

fn pi_command(
    root: &Path,
    runtime: &AgentRuntime,
    settings: &AgentSettings,
    session_id: &str,
    session_title: &str,
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
            "The bundled agent resources are missing at {}.",
            runtime.assets.display()
        ));
    }
    let (provider, agent_dir) = prepare_auth(runtime, &settings.provider)?;
    let session_dir = root.join(".research/pi-sessions");
    fs::create_dir_all(&session_dir).map_err(err)?;
    sanitize_legacy_session(&session_dir, session_id)?;
    let executable = runtime
        .executable
        .to_str()
        .ok_or_else(|| "The bundled agent path is not valid UTF-8.".to_string())?;
    let mut command = commands::command(executable);
    command
        .current_dir(root)
        .env("PI_PACKAGE_DIR", &runtime.assets)
        .env("PI_CODING_AGENT_DIR", &agent_dir)
        .arg("--mode")
        .arg("rpc")
        .arg("--provider")
        .arg(provider)
        .arg("--model")
        .arg(&settings.model)
        .arg("--thinking")
        .arg(&settings.reasoning_effort)
        .arg("--session-dir")
        .arg(&session_dir)
        .arg("--session-id")
        .arg(session_id)
        .arg("--name")
        .arg(session_title)
        .arg("--no-context-files")
        .arg("--no-extensions")
        .arg("--no-skills")
        .arg("--approve")
        .arg("--extension")
        .arg(runtime.assets.join("lattice.ts"));
    for skill in skill_store::enabled_paths(root, runtime)? {
        command.arg("--skill").arg(skill);
    }
    if !system_prompt.trim().is_empty() {
        command.arg("--system-prompt").arg(system_prompt.trim());
    }
    Ok(command)
}

fn sanitize_legacy_session(session_dir: &Path, session_id: &str) -> Result<(), String> {
    if !session_dir.is_dir() {
        return Ok(());
    }
    let suffix = format!("_{session_id}.jsonl");
    for entry in fs::read_dir(session_dir).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(&suffix))
        {
            continue;
        }
        let raw = fs::read_to_string(&path).map_err(err)?;
        let mut changed = false;
        let mut lines = Vec::new();
        for line in raw.lines() {
            let mut value: Value = serde_json::from_str(line).map_err(err)?;
            if value.pointer("/message/role").and_then(Value::as_str) == Some("user") {
                if let Some(content) = value
                    .pointer_mut("/message/content")
                    .and_then(Value::as_array_mut)
                {
                    for part in content {
                        let clean = part
                            .get("text")
                            .and_then(Value::as_str)
                            .and_then(without_legacy_editor_context)
                            .map(str::to_string);
                        if let Some(clean) = clean {
                            part["text"] = Value::String(clean);
                            changed = true;
                        }
                    }
                }
            }
            lines.push(serde_json::to_string(&value).map_err(err)?);
        }
        if changed {
            let temporary = path.with_extension("jsonl.tmp");
            fs::write(&temporary, format!("{}\n", lines.join("\n"))).map_err(err)?;
            fs::rename(temporary, path).map_err(err)?;
        }
    }
    Ok(())
}

fn without_legacy_editor_context(text: &str) -> Option<&str> {
    const START: &str = "\n\n<lattice_editor_context>";
    const END: &str = "</lattice_editor_context>";
    if !text.ends_with(END) {
        return None;
    }
    text.find(START).map(|index| &text[..index])
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

fn prepare_auth(runtime: &AgentRuntime, provider: &str) -> Result<(&'static str, PathBuf), String> {
    let (pi_provider, mut auth, subscription) = match provider {
        "codex" => ("openai-codex", codex_auth()?, true),
        "claude" => ("anthropic", claude_auth()?, true),
        "openai-api" => {
            let key = load_api_key("openai")?;
            (
                "openai",
                json!({"openai": {"type": "api_key", "key": key}}),
                false,
            )
        }
        "anthropic-api" => {
            let key = load_api_key("anthropic")?;
            (
                "anthropic",
                json!({"anthropic": {"type": "api_key", "key": key}}),
                false,
            )
        }
        _ => return Err("Choose Codex, Claude, OpenAI API, or Anthropic API.".to_string()),
    };
    let agent_dir = runtime.config.join(provider);
    fs::create_dir_all(&agent_dir).map_err(err)?;
    let auth_path = agent_dir.join("auth.json");
    if subscription {
        auth = prefer_newer_credential(&auth_path, pi_provider, auth);
    }
    write_private_json(&auth_path, &auth)?;
    Ok((pi_provider, agent_dir))
}

fn prefer_newer_credential(path: &Path, provider: &str, incoming: Value) -> Value {
    let incoming_expiry = incoming
        .get(provider)
        .and_then(|credential| credential.get("expires"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let existing = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let Some(credential) = existing
        .as_ref()
        .and_then(|value| value.get(provider))
        .filter(|credential| {
            credential
                .get("expires")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > incoming_expiry
        })
    else {
        return incoming;
    };
    let mut auth = Map::new();
    auth.insert(provider.to_string(), credential.clone());
    Value::Object(auth)
}

fn codex_auth() -> Result<Value, String> {
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
    let refresh = value
        .pointer("/tokens/refresh_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "The Codex sign-in does not contain a refresh token.".to_string())?;
    let account_id = value
        .pointer("/tokens/account_id")
        .and_then(Value::as_str)
        .or_else(|| value.get("account_id").and_then(Value::as_str));
    let expires = jwt_expiry_ms(access).ok_or_else(|| {
        "The Codex access token has an unreadable expiration time. Sign in again.".to_string()
    })?;
    let mut credential = Map::from_iter([
        ("type".to_string(), Value::String("oauth".to_string())),
        ("access".to_string(), Value::String(access.to_string())),
        ("refresh".to_string(), Value::String(refresh.to_string())),
        ("expires".to_string(), Value::Number(expires.into())),
    ]);
    if let Some(account_id) = account_id {
        credential.insert(
            "accountId".to_string(),
            Value::String(account_id.to_string()),
        );
    }
    Ok(json!({"openai-codex": Value::Object(credential)}))
}

fn claude_auth() -> Result<Value, String> {
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
        let refresh = oauth
            .get("refreshToken")
            .and_then(Value::as_str)
            .ok_or_else(|| "The Claude sign-in does not contain a refresh token.".to_string())?;
        let expires = oauth
            .get("expiresAt")
            .and_then(Value::as_u64)
            .ok_or_else(|| "The Claude sign-in has an unreadable expiration time.".to_string())?;
        Ok(json!({
            "anthropic": {
                "type": "oauth",
                "access": access,
                "refresh": refresh,
                "expires": expires
            }
        }))
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

fn write_private_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The agent configuration path has no parent folder.".to_string())?;
    fs::create_dir_all(parent).map_err(err)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        format!("{}\n", serde_json::to_string_pretty(value).map_err(err)?),
    )
    .map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)).map_err(err)?;
    }
    fs::rename(temporary, path).map_err(err)
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
                    .unwrap_or("Pi rejected the request.")
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

pub fn provider_status() -> Vec<(String, bool)> {
    ["codex", "claude"]
        .into_iter()
        .map(|name| (name.to_string(), commands::available(name)))
        .collect()
}

pub fn subscription_status() -> Vec<SubscriptionStatus> {
    vec![codex_subscription_status(), claude_subscription_status()]
}

pub fn begin_subscription_login(provider: &str) -> Result<(), String> {
    let mut command = match provider {
        "codex" => commands::command("codex"),
        "claude" => {
            let mut command = commands::command("claude");
            command.arg("auth").arg("login");
            command
        }
        _ => return Err("Unknown subscription provider.".to_string()),
    };
    if provider == "codex" {
        command.arg("login");
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not start {provider} sign-in: {error}"))
}

fn codex_subscription_status() -> SubscriptionStatus {
    if !commands::available("codex") {
        return SubscriptionStatus {
            provider: "codex".to_string(),
            installed: false,
            logged_in: false,
            detail: "Codex CLI is not installed.".to_string(),
        };
    }
    let mut command = commands::command("codex");
    command.arg("login").arg("status");
    match commands::output_with_timeout(command, Duration::from_secs(10), "Codex login status") {
        Ok(output) => {
            let detail = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .trim()
            .to_string();
            SubscriptionStatus {
                provider: "codex".to_string(),
                installed: true,
                logged_in: output.status.success() && detail.to_lowercase().contains("logged in"),
                detail: if detail.is_empty() {
                    "Codex login status is unavailable.".to_string()
                } else {
                    detail
                },
            }
        }
        Err(error) => SubscriptionStatus {
            provider: "codex".to_string(),
            installed: true,
            logged_in: false,
            detail: error,
        },
    }
}

fn claude_subscription_status() -> SubscriptionStatus {
    if !commands::available("claude") {
        return SubscriptionStatus {
            provider: "claude".to_string(),
            installed: false,
            logged_in: false,
            detail: "Claude Code CLI is not installed.".to_string(),
        };
    }
    let mut command = commands::command("claude");
    command.arg("auth").arg("status");
    match commands::output_with_timeout(command, Duration::from_secs(10), "Claude login status") {
        Ok(output) => {
            let value = serde_json::from_slice::<Value>(&output.stdout).unwrap_or(Value::Null);
            let logged_in = value
                .get("loggedIn")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let subscription = value
                .get("subscriptionType")
                .and_then(Value::as_str)
                .map(|name| format!("{} subscription", title_case(name)));
            let email = value
                .get("email")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let detail = [subscription, email]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
            SubscriptionStatus {
                provider: "claude".to_string(),
                installed: true,
                logged_in,
                detail: if detail.is_empty() {
                    if logged_in {
                        "Signed in to Claude.".to_string()
                    } else {
                        "Claude is not signed in.".to_string()
                    }
                } else {
                    detail
                },
            }
        }
        Err(error) => SubscriptionStatus {
            provider: "claude".to_string(),
            installed: true,
            logged_in: false,
            detail: error,
        },
    }
}

fn title_case(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
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
    fn removes_legacy_editor_context_from_pi_history() {
        let root = std::env::temp_dir().join(format!("lattice-pi-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();
        let path = root.join(format!("2026-07-17_{session_id}.jsonl"));
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session\",\"id\":\"session\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Hello\\n\\n<lattice_editor_context><active_file>main.tex</active_file></lattice_editor_context>\"}]}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Keep me\"}]}}\n"
            ),
        )
        .unwrap();
        sanitize_legacy_session(&root, &session_id).unwrap();
        let migrated = fs::read_to_string(&path).unwrap();
        assert!(migrated.contains("\"text\":\"Hello\""));
        assert!(migrated.contains("Keep me"));
        assert!(!migrated.contains("lattice_editor_context"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_short_history_labels() {
        assert!(compact_label(&"word ".repeat(30)).chars().count() <= 65);
    }

    #[test]
    fn keeps_a_newer_pi_subscription_refresh() {
        let root = std::env::temp_dir().join(format!("lattice-auth-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("auth.json");
        fs::write(
            &path,
            r#"{"openai-codex":{"type":"oauth","access":"new","refresh":"new","expires":2000}}"#,
        )
        .unwrap();
        let incoming = json!({
            "openai-codex": {"type": "oauth", "access": "old", "refresh": "old", "expires": 1000}
        });
        let selected = prefer_newer_credential(&path, "openai-codex", incoming);
        assert_eq!(
            selected
                .pointer("/openai-codex/access")
                .and_then(Value::as_str),
            Some("new")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "uses the local Codex subscription and bundled Pi sidecar"]
    fn pi_edits_a_project_and_records_the_change() {
        let parent = std::env::temp_dir().join(format!("lattice-pi-e2e-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "paper").unwrap();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let runtime = AgentRuntime {
            executable: manifest
                .join("binaries")
                .join("lattice-agent-aarch64-apple-darwin"),
            assets: manifest.join("pi-assets"),
            config: parent.join("pi-config"),
        };
        let settings = AgentSettings {
            provider: "codex".to_string(),
            model: "gpt-5.6-sol".to_string(),
            reasoning_effort: "low".to_string(),
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        let result = run(
            &root,
            &runtime,
            AgentRequest {
                settings: &settings,
                message: "Edit main.tex and replace 'State the problem, why it matters, and the central hypothesis.' with 'State the research problem and central hypothesis clearly.' Then briefly report what you changed.",
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
        let branch_id = fork_session(
            &root,
            &runtime,
            &settings,
            &session_id,
            "E2E",
            0,
            "",
        )
        .unwrap();
        assert_ne!(branch_id, session_id);
        let source_suffix = format!("_{session_id}.jsonl");
        assert!(fs::read_dir(root.join(".research/pi-sessions"))
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(&source_suffix)));
        fs::remove_dir_all(parent).unwrap();
    }
}
