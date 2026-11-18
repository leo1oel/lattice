//! Plugins: separate processes that add commands to Lattice, speak a
//! versioned JSON-RPC protocol over stdio, and return typed results the
//! shells render natively.
//!
//! The host lives here so the Tauri and GPUI shells share it: each shell
//! only lists [`PluginHost::commands`] in its palette, asks for a command's
//! input, renders the [`CommandResult`] and performs its actions through its
//! own confirmed paths, and offers install, enable and remove in Settings.
//!
//! - `protocol`: the API's types, the single source of the JSON Schema;
//! - `manifest`: `lattice-plugin.toml`;
//! - `store`: installed plugins, URL installs with SHA-256;
//! - `sandbox`: the Seatbelt profile and clean environment (macOS only;
//!   plugins do not run elsewhere);
//! - `run`: one command's process and conversation;
//! - `broker`: the host calls, each checked against the grant;
//! - `results`: lenient, checked parsing of what a plugin returns.
//!
//! See docs/plugins.md for the author-facing contract.

mod broker;
pub mod manifest;
pub mod protocol;
pub mod results;
mod run;
pub mod sandbox;
pub mod schema;
mod store;

pub use broker::{KeyringSecrets, SecretStore};
pub use manifest::{CommandSpec, InputKind, Manifest, Runtime};
pub use protocol::{
    Action, ActionKind, CommandResult, Diagnostic, Item, LogLevel, Permissions, Position,
    ProjectRead, Severity,
};
pub use run::CancelToken;
pub use sandbox::AVAILABLE;
pub use store::Source;

use protocol::{
    CommandContext, Cursor, InitializeParams, PluginIdentity, ProjectContext, RunParams, Selection,
};
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a command may run before it is stopped.
pub const RUN_TIMEOUT: Duration = Duration::from_secs(120);

/// Something that happened while a command ran, for the shell's progress row.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RunEvent {
    Progress { message: String, fraction: Option<f64> },
    Log { level: LogLevel, message: String },
}

/// Why a command did not return a result. `code` is what a shell
/// localizes; `message` is English, for logs and copied reports.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum PluginError {
    /// Not on this platform (`sandbox::MISSING`).
    Unavailable,
    NotInstalled,
    Disabled,
    /// The plugin now asks for permissions the writer has not granted.
    NeedsReview,
    UnknownCommand,
    /// The manifest or entry point is missing or invalid.
    Broken {
        message: String,
    },
    Launch {
        message: String,
    },
    Timeout,
    Cancelled,
    /// The process exited without answering; the tail of its stderr.
    Crashed {
        stderr: String,
    },
    Protocol {
        message: String,
    },
    UnsupportedApi {
        level: u32,
    },
    /// The plugin answered with an error of its own.
    Plugin {
        message: String,
    },
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => f.write_str(sandbox::MISSING),
            Self::NotInstalled => f.write_str("This plugin is not installed."),
            Self::Disabled => f.write_str("This plugin is turned off."),
            Self::NeedsReview => f.write_str(
                "This plugin asks for new permissions. Review them in Settings › Plugins.",
            ),
            Self::UnknownCommand => f.write_str("This plugin has no such command."),
            Self::Broken { message } | Self::Launch { message } | Self::Protocol { message } => {
                f.write_str(message)
            }
            Self::Timeout => {
                write!(f, "The plugin did not finish within {} seconds.", RUN_TIMEOUT.as_secs())
            }
            Self::Cancelled => f.write_str("Cancelled."),
            Self::Crashed { stderr } if stderr.is_empty() => {
                f.write_str("The plugin stopped without an answer.")
            }
            Self::Crashed { stderr } => {
                write!(f, "The plugin stopped without an answer:\n{stderr}")
            }
            Self::UnsupportedApi { level } => write!(
                f,
                "The plugin speaks plugin API level {level}, which this Lattice does not."
            ),
            Self::Plugin { message } => f.write_str(message),
        }
    }
}

/// An installed plugin as Settings shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub license: String,
    pub repository: Option<String>,
    pub runtime: Runtime,
    pub source: Source,
    pub enabled: bool,
    /// What the manifest asks for now.
    pub permissions: Permissions,
    /// What the writer approved; `None` before the first enable.
    pub granted: Option<Permissions>,
    /// Enabled once, but the manifest now asks for more than was granted.
    pub needs_review: bool,
    pub commands: Vec<CommandSpec>,
    /// Each declared secret and whether one is saved.
    pub secrets: Vec<SecretState>,
    /// Why the plugin cannot run (its folder is gone, its manifest broke).
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretState {
    pub name: String,
    pub saved: bool,
}

/// One palette row: an enabled plugin's command.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommand {
    pub plugin_id: String,
    pub plugin_name: String,
    pub command_id: String,
    pub title: String,
    pub description: Option<String>,
    pub input: manifest::CommandInput,
}

/// The project a command runs in, as the shell knows it. Paths other than
/// `root` are project-relative; anything absolute or escaping is dropped.
#[derive(Clone, Debug, Default)]
pub struct ProjectInput {
    pub root: PathBuf,
    pub name: String,
    pub main_document: Option<String>,
    pub active_file: Option<String>,
    pub selection: Option<Selection>,
    pub cursor: Option<Cursor>,
}

#[derive(Clone, Debug, Default)]
pub struct RunRequest {
    pub plugin_id: String,
    pub command_id: String,
    pub input: Option<String>,
    pub project: Option<ProjectInput>,
    /// The interface language (`en`, `zh-CN`).
    pub locale: String,
}

/// The plugin host one app process shares across its windows.
pub struct PluginHost {
    store: store::Store,
    /// The Node `runtime = "node"` plugins run on.
    node: PathBuf,
    /// Folders that Node needs to read (none for the standalone Node
    /// Lattice ships; a test's Node may need its install prefix).
    node_reads: Vec<PathBuf>,
    secrets: Box<dyn SecretStore>,
    timeout: Duration,
}

impl PluginHost {
    /// The app's host: plugins under `<app data>/plugins`, Node from the
    /// bundled Synara runtime, secrets in the Keychain.
    pub fn new(resources: &crate::host::Resources) -> Self {
        let node = crate::sidecar::NodeRuntime::resolve(
            &resources.bundle_dir.join("synara-runtime").join("bin"),
        );
        Self::with(
            resources.app_data_dir.join("plugins"),
            node.executable,
            Vec::new(),
            Box::new(KeyringSecrets),
        )
    }

    pub fn with(
        root: PathBuf, node: PathBuf, node_reads: Vec<PathBuf>, secrets: Box<dyn SecretStore>,
    ) -> Self {
        Self { store: store::Store { root }, node, node_reads, secrets, timeout: RUN_TIMEOUT }
    }

    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    pub fn list(&self) -> Result<Vec<PluginInfo>, String> {
        Ok(self.store.records()?.into_iter().map(|r| self.info(r)).collect())
    }

    /// The palette's plugin rows: enabled plugins whose grant still covers
    /// what they ask. Empty where plugins cannot run.
    pub fn commands(&self) -> Vec<PluginCommand> {
        if !AVAILABLE {
            return Vec::new();
        }
        let records = self.store.records().unwrap_or_default();
        records
            .into_iter()
            .filter(|r| {
                r.enabled && r.granted.as_ref().is_some_and(|g| r.manifest.permissions().within(g))
            })
            .flat_map(|r| {
                let name = r.manifest.name.clone();
                r.manifest.commands.into_iter().map(move |c| PluginCommand {
                    plugin_id: r.id.clone(),
                    plugin_name: name.clone(),
                    command_id: c.id,
                    title: c.title,
                    description: c.description,
                    input: c.input,
                })
            })
            .collect()
    }

    pub fn install_folder(&self, folder: &Path) -> Result<PluginInfo, String> {
        self.store.install_folder(folder).map(|r| self.info(r))
    }

    pub fn install_url(&self, url: &str, sha256: &str) -> Result<PluginInfo, String> {
        self.store.install_url(url, sha256).map(|r| self.info(r))
    }

    /// Turn a plugin on, granting what its manifest asks for now (show those
    /// permissions to the writer first), or off.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<PluginInfo, String> {
        self.store.set_enabled(id, enabled).map(|r| self.info(r))
    }

    /// Remove a plugin, its data and its saved secrets.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let record = self.store.remove(id)?;
        for name in &record.manifest.permissions.secrets {
            let _ = self.secrets.set(id, name, None);
        }
        Ok(())
    }

    /// Save (`Some`) or forget (`None`) a secret the plugin declares.
    pub fn set_secret(
        &self, id: &str, name: &str, value: Option<&str>,
    ) -> Result<PluginInfo, String> {
        let record = self.store.record(id)?;
        if !record.manifest.permissions.secrets.iter().any(|s| s == name) {
            return Err("This plugin does not declare that secret.".into());
        }
        self.secrets.set(id, name, value.filter(|v| !v.is_empty()))?;
        Ok(self.info(record))
    }

    fn info(&self, record: store::Record) -> PluginInfo {
        let error = manifest::read(&record.dir).err();
        let m = &record.manifest;
        let permissions = m.permissions();
        PluginInfo {
            needs_review: record.granted.as_ref().is_some_and(|g| !permissions.within(g)),
            secrets: m
                .permissions
                .secrets
                .iter()
                .map(|name| SecretState {
                    name: name.clone(),
                    saved: self.secrets.get(&record.id, name).ok().flatten().is_some(),
                })
                .collect(),
            id: record.id,
            name: m.name.clone(),
            version: m.version.clone(),
            description: m.description.clone(),
            license: m.license.clone(),
            repository: m.repository.clone(),
            runtime: m.runtime,
            source: record.source,
            enabled: record.enabled,
            permissions,
            granted: record.granted,
            commands: m.commands.clone(),
            error,
        }
    }

    /// Run one command to its result. Blocking: call it off the UI thread.
    pub fn run(
        &self, request: RunRequest, events: &dyn crate::host::Sink<RunEvent>, cancel: &CancelToken,
    ) -> Result<CommandResult, PluginError> {
        if !AVAILABLE {
            return Err(PluginError::Unavailable);
        }
        let command = self.prepare(&request)?;
        self.run_with(command, request, events, cancel)
    }

    /// The sandboxed command and the record it runs, after every check.
    fn prepare(
        &self, request: &RunRequest,
    ) -> Result<(std::process::Command, store::Record), PluginError> {
        let record = match self.store.refresh(&request.plugin_id) {
            Ok(record) => record,
            Err(_) if self.store.record(&request.plugin_id).is_err() => {
                return Err(PluginError::NotInstalled)
            }
            Err(message) => return Err(PluginError::Broken { message }),
        };
        let granted = match (&record.granted, record.enabled) {
            (Some(granted), true) => granted.clone(),
            _ => return Err(PluginError::Disabled),
        };
        if !record.manifest.permissions().within(&granted) {
            return Err(PluginError::NeedsReview);
        }
        if record.manifest.command(&request.command_id).is_none() {
            return Err(PluginError::UnknownCommand);
        }
        let entry = record
            .manifest
            .entry(&record.dir)
            .map_err(|message| PluginError::Broken { message })?;
        let (program, args, reads) = match record.manifest.runtime {
            Runtime::Node => {
                (self.node.clone(), vec![OsString::from(&entry)], self.node_reads.clone())
            }
            Runtime::Exec => (entry, Vec::new(), Vec::new()),
        };
        let data_dir = self.store.data_dir(&record.id);
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| PluginError::Launch { message: e.to_string() })?;
        let launch = sandbox::Launch {
            plugin_id: &record.id,
            program: &program,
            args,
            plugin_dir: &record.dir,
            data_dir: &data_dir,
            runtime_reads: &reads,
            exec_in_plugin_dir: record.manifest.runtime == Runtime::Exec,
            network_local: &granted.network_local,
            locale: &request.locale,
        };
        let command =
            sandbox::command(&launch).map_err(|message| PluginError::Launch { message })?;
        Ok((command, record))
    }

    fn run_with(
        &self, (command, record): (std::process::Command, store::Record), request: RunRequest,
        events: &dyn crate::host::Sink<RunEvent>, cancel: &CancelToken,
    ) -> Result<CommandResult, PluginError> {
        let granted = record.granted.clone().unwrap_or_default();
        let init = InitializeParams {
            host_api_level: protocol::API_LEVEL,
            host_api_compat: protocol::API_COMPAT,
            host_version: crate::VERSION.to_string(),
            plugin: PluginIdentity {
                id: record.id.clone(),
                version: record.manifest.version.clone(),
            },
            granted: granted.clone(),
            locale: request.locale.clone(),
            platform: std::env::consts::OS.to_string(),
        };
        let context = context(request.project.as_ref(), &granted);
        let input = request.input.map(|i| i.chars().take(4000).collect());
        let params = RunParams { command: request.command_id, input, context };
        let broker = broker::Broker {
            plugin_id: &record.id,
            granted: &granted,
            project_root: request.project.as_ref().map(|p| p.root.as_path()),
            secrets: self.secrets.as_ref(),
        };
        let session = run::Session {
            broker: &broker,
            events,
            cancel,
            timeout: self.timeout,
            min_api: record.manifest.api,
        };
        let started = std::time::Instant::now();
        let outcome = session.run(command, init, params);
        log::info!(
            target: "lattice::plugins",
            "{} {} finished in {} ms: {}",
            record.id,
            outcome_kind(&outcome),
            started.elapsed().as_millis(),
            outcome.as_ref().map_or_else(ToString::to_string, |_| "ok".into())
        );
        outcome
    }
}

fn outcome_kind(outcome: &Result<CommandResult, PluginError>) -> &'static str {
    match outcome {
        Ok(CommandResult::Message { .. }) => "message",
        Ok(CommandResult::Items { .. }) => "items",
        Ok(CommandResult::Diagnostics { .. }) => "diagnostics",
        Err(_) => "error",
    }
}

/// What the plugin learns about the project: its name always, the rest only
/// with the `context` grant, every path project-relative.
fn context(project: Option<&ProjectInput>, granted: &Permissions) -> CommandContext {
    let Some(project) = project else { return CommandContext::default() };
    let name = project.name.chars().take(200).collect();
    if !granted.reads(ProjectRead::Context) {
        return CommandContext {
            project: ProjectContext { name, ..Default::default() },
            ..Default::default()
        };
    }
    let relative = |p: &Option<String>| p.clone().filter(|p| results::relative_path(p));
    let bibliographies = crate::project::iter_bibliography_sources(&project.root)
        .map(|sources| sources.into_iter().map(|(path, _)| path).collect())
        .unwrap_or_default();
    let selection =
        project.selection.clone().filter(|s| results::relative_path(&s.file)).map(|mut s| {
            s.text = s.text.chars().take(protocol::MAX_SELECTION_CHARS).collect();
            s
        });
    CommandContext {
        project: ProjectContext {
            name,
            main_document: relative(&project.main_document),
            active_file: relative(&project.active_file),
            bibliographies,
        },
        selection,
        cursor: project.cursor.clone().filter(|c| results::relative_path(&c.file)),
    }
}

#[cfg(test)]
mod tests;
