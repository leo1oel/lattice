//! Settings › Agent › Model endpoint: the writer's own OpenAI-, Anthropic-
//! or Gemini-compatible API, given as an address, a key and model names
//! (issue #825). Synara runs it through Pi, the coding agent it hosts in
//! process, so no provider CLI is installed; Pi itself is an on-demand
//! download from Settings › Providers.
//!
//! Lattice owns Pi's configuration for it, `<agent home>/pi-agent/`, and
//! starts the sidecar with `PI_CODING_AGENT_DIR` there once an endpoint is
//! saved (`configure_sidecar`). The writer's own `~/.pi/agent` is never read
//! or written. Its `models.json` holds one provider, `lattice`, and is the
//! only record of the endpoint: the pane reads it back, and fields Lattice
//! does not set (a hand-added `compat` or `headers`) survive a save.
//!
//! The key stays in the system keychain (`keychain`). `models.json` names a
//! command instead, this executable's `agent-endpoint-key` mode, which Pi runs
//! for each request (`run_cli`). So the key never reaches a log, a file, the
//! sidecar's environment or the web UI after it is saved; an agent shell can
//! still run the helper, as it can read any provider CLI's own credentials.

mod keychain;
mod probe;
pub use probe::ProbeReport;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Under the agent home (`<app data>/synara`).
const AGENT_DIR: &str = "pi-agent";
const MODELS_FILE: &str = "models.json";
/// Pi's provider id: the model picker lists `lattice/<model id>`.
const PROVIDER: &str = "lattice";
/// `<executable> agent-endpoint-key` prints the saved key (`run_cli`).
const KEY_HELPER: &str = "agent-endpoint-key";
/// What Pi sends to an endpoint that needs no key, a local server: Pi lists
/// a model only once it has some key for it.
const NO_KEY: &str = "no-key";
const MAX_MODELS: usize = 16;
const MAX_MODEL_ID: usize = 200;

/// Pi's own API names, which `models.json` and the pane share.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Protocol {
    #[serde(rename = "openai-completions")]
    OpenAiCompletions,
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    #[serde(rename = "google-generative-ai")]
    Google,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointModel {
    id: String,
    context_window: u32,
    max_tokens: u32,
    images: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    protocol: Protocol,
    base_url: String,
    models: Vec<EndpointModel>,
}

/// What the pane shows: never the key, only whether one is saved.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStatus {
    endpoint: Option<Endpoint>,
    key_saved: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", content = "value", rename_all = "lowercase")]
pub enum KeyUpdate {
    Keep,
    Replace(String),
    Remove,
}

impl Endpoint {
    /// Trims what the writer typed and refuses what Pi could not use.
    fn normalized(mut self) -> Result<Self, String> {
        self.base_url = normalized_base_url(self.protocol, &self.base_url)?;
        if self.models.is_empty() || self.models.len() > MAX_MODELS {
            return Err(format!("Give between 1 and {MAX_MODELS} models."));
        }
        let mut seen = Vec::new();
        for model in &mut self.models {
            model.id = model.id.trim().to_string();
            if model.id.is_empty()
                || model.id.len() > MAX_MODEL_ID
                || model.id.chars().any(|c| c.is_control() || c.is_whitespace())
            {
                return Err("A model name is empty or has spaces in it.".into());
            }
            if seen.contains(&model.id) {
                return Err(format!("The model {} is listed twice.", model.id));
            }
            if !(1_024..=100_000_000).contains(&model.context_window)
                || !(1..=model.context_window).contains(&model.max_tokens)
            {
                return Err(format!("The token limits of {} are out of range.", model.id));
            }
            seen.push(model.id.clone());
        }
        Ok(self)
    }
}

/// The address Pi's SDKs append their own paths to. A pasted request URL
/// (`…/chat/completions`) loses that path, and an Anthropic address its
/// `/v1`, which the Anthropic SDK adds itself.
fn normalized_base_url(protocol: Protocol, input: &str) -> Result<String, String> {
    let invalid = || "Enter the endpoint’s address, starting with https:// or http://.".to_string();
    let url = reqwest::Url::parse(input.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(str::is_empty)
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    let mut base = url.as_str().trim_end_matches('/').to_string();
    let suffixes: &[&str] = match protocol {
        Protocol::OpenAiCompletions => &["/chat/completions"],
        Protocol::OpenAiResponses => &["/responses"],
        Protocol::AnthropicMessages => &["/v1/messages", "/messages", "/v1"],
        Protocol::Google => &["/models"],
    };
    if protocol == Protocol::Google {
        if let Some(index) = base.find("/models/") {
            base.truncate(index);
        }
    }
    for suffix in suffixes {
        if let Some(stripped) = base.strip_suffix(suffix) {
            base = stripped.to_string();
            break;
        }
    }
    Ok(base)
}

/// The command Pi runs for the key: this executable, quoted for `/bin/sh`.
fn key_command(executable: &Path) -> String {
    let path = executable.to_string_lossy().replace('\'', r"'\''");
    format!("!'{path}' {KEY_HELPER}")
}

fn agent_dir(home_dir: &Path) -> PathBuf {
    home_dir.join(AGENT_DIR)
}

fn read_models(home_dir: &Path) -> Result<Option<Value>, String> {
    match std::fs::read(agent_dir(home_dir).join(MODELS_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "The endpoint settings file is not valid JSON.".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read the endpoint settings: {error}")),
    }
}

fn write_models(home_dir: &Path, document: &Value) -> Result<(), String> {
    let dir = agent_dir(home_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the endpoint settings folder: {error}"))?;
    let bytes = serde_json::to_vec_pretty(document).map_err(|error| error.to_string())?;
    crate::project_fs::ProjectDir::open(&dir)?.atomic_write(MODELS_FILE, &bytes)
}

fn provider(document: &Value) -> Option<&Map<String, Value>> {
    document.get("providers")?.get(PROVIDER)?.as_object()
}

/// The saved endpoint, read back from `models.json`.
fn status_of(document: Option<&Value>) -> EndpointStatus {
    let Some(entry) = document.and_then(provider) else {
        return EndpointStatus { endpoint: None, key_saved: false };
    };
    let text =
        |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let number = |value: &Value, key: &str, default: u32| {
        value
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(default)
    };
    let entry = Value::Object(entry.clone());
    let protocol = entry.get("api").cloned().and_then(|api| serde_json::from_value(api).ok());
    let models = entry.get("models").and_then(Value::as_array).map(|models| {
        models
            .iter()
            .filter_map(|model| {
                Some(EndpointModel {
                    id: text(model, "id")?,
                    context_window: number(model, "contextWindow", 128_000),
                    max_tokens: number(model, "maxTokens", 16_384),
                    images: model
                        .get("input")
                        .and_then(Value::as_array)
                        .is_some_and(|input| input.iter().any(|kind| kind == "image")),
                })
            })
            .collect::<Vec<_>>()
    });
    let endpoint = match (protocol, text(&entry, "baseUrl"), models) {
        (Some(protocol), Some(base_url), Some(models)) => {
            Some(Endpoint { protocol, base_url, models })
        }
        _ => None,
    };
    let key_saved = text(&entry, "apiKey").is_some_and(|key| key.starts_with('!'));
    EndpointStatus { endpoint, key_saved }
}

/// `document` with the provider set to `endpoint`, keeping the fields Lattice
/// does not own, on the provider and on each model it still lists.
fn with_endpoint(document: Option<Value>, endpoint: &Endpoint, api_key: &str) -> Value {
    let mut document = document.filter(Value::is_object).unwrap_or_else(|| json!({}));
    let root = document.as_object_mut().expect("an object");
    if !root.get("providers").is_some_and(Value::is_object) {
        root.insert("providers".into(), json!({}));
    }
    let providers = root.get_mut("providers").and_then(Value::as_object_mut).expect("an object");
    let mut entry =
        providers.remove(PROVIDER).filter(Value::is_object).unwrap_or_else(|| json!({}));
    let previous_models =
        entry.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
    let models = endpoint
        .models
        .iter()
        .map(|model| {
            let mut value = previous_models
                .iter()
                .find(|previous| previous.get("id").and_then(Value::as_str) == Some(&model.id))
                .filter(|previous| previous.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let fields = value.as_object_mut().expect("an object");
            fields.insert("id".into(), json!(model.id));
            fields.insert("contextWindow".into(), json!(model.context_window));
            fields.insert("maxTokens".into(), json!(model.max_tokens));
            let input = if model.images { json!(["text", "image"]) } else { json!(["text"]) };
            fields.insert("input".into(), input);
            value
        })
        .collect::<Vec<_>>();
    let name = reqwest::Url::parse(&endpoint.base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| PROVIDER.to_string());
    let fields = entry.as_object_mut().expect("an object");
    fields.insert("name".into(), json!(name));
    fields.insert("baseUrl".into(), json!(endpoint.base_url));
    fields.insert("api".into(), json!(endpoint.protocol));
    fields.insert("apiKey".into(), json!(api_key));
    fields.insert("models".into(), Value::Array(models));
    providers.insert(PROVIDER.into(), entry);
    document
}

/// Point a sidecar about to start at Lattice's Pi configuration, when an
/// endpoint is saved. The key command names this executable's path, which
/// moves with the app (a reinstall elsewhere, a development build), so it is
/// written again here when it differs. A broken file starts the sidecar
/// without the endpoint rather than not at all.
pub(crate) fn configure_sidecar(command: &mut Command, home_dir: &Path, executable: &Path) {
    let Ok(Some(document)) = read_models(home_dir) else { return };
    let Some(entry) = provider(&document) else { return };
    let saved_key = entry.get("apiKey").and_then(Value::as_str).unwrap_or_default();
    let key = key_command(executable);
    if saved_key.starts_with('!') && saved_key != key {
        let mut document = document.clone();
        document["providers"][PROVIDER]["apiKey"] = json!(key);
        if let Err(error) = write_models(home_dir, &document) {
            log::warn!(target: "lattice::model_endpoint", "could not update the key command: {error}");
        }
    }
    command.env("PI_CODING_AGENT_DIR", agent_dir(home_dir));
}

/// `status_of`, with the key reported only while the keychain still holds it:
/// a keychain reset leaves `models.json` naming the helper with nothing to
/// print. A keychain that cannot be read is taken at the file's word.
fn checked_status(document: Option<&Value>) -> EndpointStatus {
    let mut status = status_of(document);
    if status.key_saved && matches!(keychain::read(), Ok(None)) {
        status.key_saved = false;
    }
    status
}

fn save(
    home_dir: &Path, executable: &Path, endpoint: Endpoint, key: KeyUpdate,
) -> Result<EndpointStatus, String> {
    let endpoint = endpoint.normalized()?;
    let document = read_models(home_dir).unwrap_or(None);
    let had_key = checked_status(document.as_ref()).key_saved;
    let has_key = match key {
        KeyUpdate::Keep => had_key,
        KeyUpdate::Replace(key) => {
            let key = keychain::normalized(&key).ok_or("That API key is not valid.")?;
            keychain::save(&key)?;
            true
        }
        KeyUpdate::Remove => {
            keychain::remove()?;
            false
        }
    };
    let api_key = if has_key { key_command(executable) } else { NO_KEY.to_string() };
    let document = with_endpoint(document, &endpoint, &api_key);
    write_models(home_dir, &document)?;
    Ok(status_of(Some(&document)))
}

/// Forget the endpoint: its provider and the key. Other providers someone
/// added to the file by hand stay; an empty file goes, so the sidecar stops
/// receiving `PI_CODING_AGENT_DIR`.
fn remove(home_dir: &Path) -> Result<EndpointStatus, String> {
    keychain::remove()?;
    if let Some(mut document) = read_models(home_dir)? {
        if let Some(providers) = document.get_mut("providers").and_then(Value::as_object_mut) {
            providers.remove(PROVIDER);
        }
        let empty = document["providers"].as_object().is_none_or(Map::is_empty);
        if empty {
            let _ = std::fs::remove_file(agent_dir(home_dir).join(MODELS_FILE));
        } else {
            write_models(home_dir, &document)?;
        }
    }
    Ok(status_of(None))
}

/// Keychain reads and network requests block, so each command runs off the
/// async runtime.
async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    crate::runtime::spawn_blocking(work)
        .await
        .map_err(|_| "The endpoint settings worker stopped.".to_string())?
}

/// `home_dir` is the agent's home, `synara/` under the app data folder.
pub async fn get_model_endpoint(home_dir: PathBuf) -> Result<EndpointStatus, String> {
    off_thread(move || Ok(checked_status(read_models(&home_dir)?.as_ref()))).await
}

pub async fn save_model_endpoint(
    home_dir: PathBuf, endpoint: Endpoint, key: KeyUpdate,
) -> Result<EndpointStatus, String> {
    off_thread(move || {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Could not locate the app executable: {error}"))?;
        save(&home_dir, &executable, endpoint, key)
    })
    .await
}

pub async fn remove_model_endpoint(home_dir: PathBuf) -> Result<EndpointStatus, String> {
    off_thread(move || remove(&home_dir)).await
}

/// Try `endpoint`'s first model as the agent would use it. `key` is a draft
/// typed in the pane; without one, the saved key. Testing saves nothing.
pub async fn test_model_endpoint(
    endpoint: Endpoint, key: Option<String>,
) -> Result<probe::ProbeReport, String> {
    off_thread(move || {
        let endpoint = endpoint.normalized()?;
        let key = match key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
            Some(draft) => Some(keychain::normalized(draft).ok_or("That API key is not valid.")?),
            None => keychain::read()?,
        };
        Ok(probe::run(
            endpoint.protocol,
            &endpoint.base_url,
            &endpoint.models[0].id,
            key.as_deref(),
        ))
    })
    .await
}

/// Serve `<executable> agent-endpoint-key`: print the saved key for Pi and
/// exit. Returns false for an ordinary launch; runs before Tauri or AppKit.
pub fn run_cli() -> bool {
    if std::env::args().nth(1).as_deref() != Some(KEY_HELPER) {
        return false;
    }
    match keychain::read() {
        Ok(Some(key)) => {
            println!("{key}");
            std::process::exit(0)
        }
        // Pi reports a key it could not resolve; never say why on stdout.
        Ok(None) | Err(_) => std::process::exit(1),
    }
}

#[cfg(test)]
mod tests;
