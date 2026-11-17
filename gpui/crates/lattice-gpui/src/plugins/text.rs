//! The words plugins show that depend on what a plugin declares or returns:
//! the permissions in plain language (Settings › Plugins' cards and the
//! confirmation that turns a plugin on), an error by its code, an action's
//! label, the palette's row and result header. The Tauri app words them
//! the same (`src/plugins/plugin-text.ts`).

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
        lines.push(t!("Connect to localhost:{0}", port).to_string());
    }
    for origin in &permissions.network {
        lines.push(t!("Send requests to {0}", origin).to_string());
    }
    for secret in &permissions.secrets {
        lines.push(t!("Use the saved secret “{0}”", secret).to_string());
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
    /// Settings › Plugins can fix it: the palette offers to open it.
    pub settings: bool,
}

/// `error` in the interface language, by its code, with the host's or the
/// plugin's own words where only they know what happened.
pub fn error_text(error: &PluginError) -> ErrorText {
    let settings = matches!(error, PluginError::Disabled | PluginError::NeedsReview);
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
            t!("The plugin is broken: {0}", message.trim()).to_string()
        }
        PluginError::Launch { message } => {
            t!("Couldn’t start the plugin: {0}", message.trim()).to_string()
        }
        PluginError::Timeout => t!("The plugin didn’t finish within 2 minutes.").to_string(),
        PluginError::Cancelled => t!("Cancelled.").to_string(),
        PluginError::Crashed { .. } => t!("The plugin stopped without an answer.").to_string(),
        PluginError::Protocol { message } => t!(
            "The plugin sent something Lattice couldn’t read: {0}",
            message.trim()
        )
        .to_string(),
        PluginError::UnsupportedApi { level } => t!(
            "This plugin needs plugin API level {0}, which this Lattice doesn’t support.",
            level
        )
        .to_string(),
        PluginError::Plugin { message } if !message.trim().is_empty() => message.trim().to_string(),
        PluginError::Plugin { .. } => t!("The plugin failed.").to_string(),
    };
    ErrorText { text, settings }
}

/// An action's button: the plugin's title, else Lattice's word for the verb.
pub fn action_label(action: &Action) -> String {
    if let Some(title) = action
        .title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
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

/// The line over a result: the plugin's name, then its summary or the
/// command's title.
pub fn result_header(plugin: &str, summary: Option<&str>, title: &str) -> String {
    let what = summary
        .filter(|summary| !summary.trim().is_empty())
        .unwrap_or(title);
    format!("{plugin} · {what}")
}

/// The progress row before the plugin says what it is doing.
pub fn running(title: &str) -> String {
    t!("Running {0}…", title.trim_end_matches('…')).to_string()
}

/// A diagnostic's place: "line N".
pub fn line(line: u32) -> String {
    t!("line {0}", line).to_string()
}
