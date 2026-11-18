//! The words plugins show that depend on what a plugin declares or returns:
//! the permissions in plain language (Settings › Plugins' cards and the
//! question that turns a plugin on), an error by its code, an action's
//! label. The Tauri app words them the same (`src/plugins/plugin-text.ts`),
//! from the same catalog entries.

use lattice_core::plugins::{Action, ActionKind, Permissions, PluginError, ProjectRead};
use lattice_i18n::t;

/// Each permission as a sentence a writer can judge, in the order
/// docs/plugins.md lists them; a plugin that asks for nothing says so.
pub fn permission_lines(permissions: &Permissions) -> Vec<String> {
    let mut lines = Vec::new();
    if permissions.project_read.contains(&ProjectRead::Context) {
        lines.push(t!("Read the open file, selection and cursor").to_string());
    }
    if permissions
        .project_read
        .contains(&ProjectRead::Bibliography)
    {
        lines.push(t!("Read the project’s bibliography").to_string());
    }
    for port in &permissions.network_local {
        lines.push(t!("Connect to localhost:{port}", port = port).to_string());
    }
    for origin in &permissions.network {
        lines.push(t!("Send requests to {origin}", origin = origin).to_string());
    }
    for secret in &permissions.secrets {
        lines.push(t!("Use the saved secret “{name}”", name = secret).to_string());
    }
    if lines.is_empty() {
        lines.push(t!("No access beyond the project’s name").to_string());
    }
    lines
}

/// A failed run as the palette shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ErrorText {
    pub text: String,
    /// A crashed plugin's standard error, under the message.
    pub stderr: Option<String>,
    /// Settings › Plugins can fix it: the palette offers to open it.
    pub settings: bool,
}

/// `error` in the interface language, by its code, with the host's words
/// (in the interface language too) or the plugin's own where only they
/// know what happened.
pub fn error_text(error: &PluginError) -> ErrorText {
    let settings = matches!(error, PluginError::Disabled | PluginError::NeedsReview);
    let detail = |message: &str| crate::host_errors::text(message.trim());
    let text = match error {
        PluginError::Unavailable => t!("Plugins run only on macOS for now.").to_string(),
        PluginError::NotInstalled => t!("This plugin is no longer installed.").to_string(),
        PluginError::Disabled => {
            t!("This plugin is turned off. Turn it on in Settings › Plugins.").to_string()
        }
        PluginError::NeedsReview => {
            t!("This plugin asks for new permissions. Review them in Settings › Plugins.")
                .to_string()
        }
        PluginError::UnknownCommand => t!("This plugin no longer has this command.").to_string(),
        PluginError::Broken { message } => {
            t!("The plugin is broken: {detail}", detail = detail(message)).to_string()
        }
        PluginError::Launch { message } => t!(
            "Couldn’t start the plugin: {detail}",
            detail = detail(message)
        )
        .to_string(),
        PluginError::Timeout => t!("The plugin didn’t finish within 2 minutes.").to_string(),
        PluginError::Cancelled => t!("Cancelled.").to_string(),
        PluginError::Crashed { .. } => t!("The plugin stopped without an answer.").to_string(),
        PluginError::Protocol { message } => t!(
            "The plugin sent something Lattice couldn’t read: {detail}",
            detail = detail(message)
        )
        .to_string(),
        PluginError::UnsupportedApi { level } => t!(
            "This plugin needs plugin API level {level}, which this Lattice doesn’t support.",
            level = level
        )
        .to_string(),
        PluginError::Plugin { message } if !message.trim().is_empty() => detail(message),
        PluginError::Plugin { .. } => t!("The plugin failed.").to_string(),
    };
    let stderr = match error {
        PluginError::Crashed { stderr } if !stderr.trim().is_empty() => {
            Some(stderr.trim().to_string())
        }
        _ => None,
    };
    ErrorText {
        text,
        stderr,
        settings,
    }
}

/// An action's button: the plugin's title, else Lattice's word for the verb.
pub fn action_label(action: &Action) -> String {
    if let Some(title) = action
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        return title.to_string();
    }
    match &action.kind {
        ActionKind::InsertCitation { .. } => t!("Insert citation"),
        ActionKind::AddBibEntry { .. } => t!("Add to bibliography"),
        ActionKind::ReplaceBibEntry { .. } => t!("Update entry"),
        ActionKind::Reveal { .. } => t!("Open"),
        ActionKind::OpenUrl { .. } => t!("Open in browser"),
        ActionKind::Copy { .. } => t!("Copy"),
    }
    .to_string()
}

/// A command's palette row: "<Plugin>: <Command>".
pub fn command_label(plugin: &str, title: &str) -> String {
    format!("{plugin}: {title}")
}

/// The progress row before the plugin says what it is doing.
pub fn running(title: &str) -> String {
    t!("Running {title}…", title = title).to_string()
}

/// A diagnostic's place under its message: "line N · code".
pub fn place(line: Option<u32>, code: Option<&str>) -> String {
    line.map(|line| t!("line {line}", line = line).to_string())
        .into_iter()
        .chain(code.map(str::to_string))
        .collect::<Vec<_>>()
        .join(" · ")
}
