//! Durable, non-secret UI choices for WebKit's ephemeral cross-site agent frame.
//! The wire shape deliberately cannot carry settings envelopes or chat drafts.

use super::{SynaraRuntime, SynaraRuntimeInfo};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

const FILE: &str = "synara-host-preferences.json";
const LIMIT: u64 = 64 * 1024;
const INVALID: &str = "Invalid agent UI preferences.";
const UNAVAILABLE: &str = "Agent UI preferences unavailable.";

pub(super) struct Bridge {
    nonce: String,
    writes: Mutex<()>,
}

impl Default for Bridge {
    fn default() -> Self {
        Self { nonce: uuid::Uuid::new_v4().to_string(), writes: Mutex::new(()) }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    composer: Option<Composer>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Composer {
    sticky_model_selection_by_provider: BTreeMap<String, Selection>,
    sticky_active_provider: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    provider: String,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    options: Option<Options>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fast_mode: Option<bool>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Patch {
    General {
        #[serde(rename = "defaultProvider")]
        default_provider: Option<String>,
    },
    Composer {
        composer: Composer,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Seed {
    nonce: String,
    origin: String,
    preferences: Preferences,
}

fn provider(value: &str) -> bool {
    matches!(
        value,
        "codex"
            | "claudeAgent"
            | "cursor"
            | "devin"
            | "antigravity"
            | "grok"
            | "droid"
            | "opencode"
            | "pi"
            | "omp"
    )
}

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:/@+ -".contains(&b))
}

fn effort(value: &str) -> bool {
    matches!(
        value,
        "none" | "minimal" | "off" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
}

impl Preferences {
    fn validate(&self) -> Result<(), String> {
        let valid = self.default_provider.as_deref().is_none_or(provider)
            && self.composer.as_ref().is_none_or(|composer| {
                composer.sticky_model_selection_by_provider.len() <= 32
                    && composer.sticky_active_provider.as_ref().is_none_or(|key| {
                        composer.sticky_model_selection_by_provider.contains_key(key)
                    })
                    && composer.sticky_model_selection_by_provider.iter().all(|(key, selection)| {
                        bounded(key, 128)
                            && provider(&selection.provider)
                            && bounded(&selection.model, 256)
                            && selection.instance_id.as_deref().is_none_or(|id| bounded(id, 128))
                            && key == selection.instance_id.as_ref().unwrap_or(&selection.provider)
                            && selection.options.as_ref().is_none_or(|options| {
                                [
                                    &options.reasoning_effort,
                                    &options.effort,
                                    &options.thinking_level,
                                ]
                                .iter()
                                .all(|value| value.as_deref().is_none_or(effort))
                            })
                    })
            });
        valid.then_some(()).ok_or_else(|| INVALID.into())
    }

    fn apply(&mut self, patch: Patch) -> Result<(), String> {
        let mut next = self.clone();
        match patch {
            Patch::General { default_provider } => next.default_provider = default_provider,
            Patch::Composer { composer } => next.composer = Some(composer),
        }
        next.validate()?;
        *self = next;
        Ok(())
    }
}

fn load(directory: &Path) -> Result<Preferences, String> {
    let file = match std::fs::File::open(directory.join(FILE)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Preferences::default())
        }
        Err(_) => return Err(UNAVAILABLE.into()),
    };
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|_| UNAVAILABLE)?;
    if bytes.len() as u64 > LIMIT {
        return Err(INVALID.into());
    }
    let preferences: Preferences = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    preferences.validate()?;
    Ok(preferences)
}

fn save(directory: &Path, patch: Patch) -> Result<(), String> {
    let mut preferences = load(directory)?;
    preferences.apply(patch)?;
    let bytes = serde_json::to_vec(&preferences).map_err(|_| INVALID)?;
    std::fs::create_dir_all(directory).map_err(|_| UNAVAILABLE)?;
    crate::project_fs::ProjectDir::open(directory)?.atomic_write(FILE, &bytes)
}

pub(super) fn runtime_info(
    app: &tauri::AppHandle, native_workspace: bool,
) -> Result<SynaraRuntimeInfo, String> {
    let runtime = app.state::<SynaraRuntime>();
    let mut info = runtime.ensure_ready()?;
    if native_workspace && runtime.external_origin.is_none() {
        let preferences = app
            .path()
            .app_config_dir()
            .map_err(|_| UNAVAILABLE.to_string())
            .and_then(|path| load(&path));
        match preferences {
            Ok(preferences) => {
                info.host_preferences = info.origin.as_ref().map(|origin| Seed {
                    nonce: runtime.host_preferences.nonce.clone(),
                    origin: origin.clone(),
                    preferences,
                })
            }
            Err(_) => log::warn!(target: "lattice::synara", "Agent UI preference restore failed"),
        }
    }
    Ok(info)
}

pub(crate) fn initialization_script(app: &tauri::AppHandle) -> String {
    let nonce = &app.state::<SynaraRuntime>().host_preferences.nonce;
    include_str!("host_preferences.js")
        .replace("__LATTICE_PREFS_NONCE__", &serde_json::to_string(nonce).unwrap())
}

#[tauri::command]
pub fn synara_save_host_preferences(
    app: tauri::AppHandle, window: tauri::WebviewWindow, origin: String, patch: Patch,
) -> Result<(), String> {
    let runtime = app.state::<SynaraRuntime>();
    if !crate::is_workspace_window(window.label()) || runtime.external_origin.is_some() {
        return Err(INVALID.into());
    }
    let managed = runtime
        .running
        .lock()
        .map_err(|_| UNAVAILABLE)?
        .as_ref()
        .and_then(|running| running.info.origin.clone());
    if managed.as_deref() != Some(origin.as_str()) {
        return Err(INVALID.into());
    }
    let _guard = runtime.host_preferences.writes.lock().map_err(|_| UNAVAILABLE)?;
    save(&app.path().app_config_dir().map_err(|_| UNAVAILABLE)?, patch)
}

#[cfg(test)]
mod tests;
