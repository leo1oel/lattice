//! The plugin API: every message a plugin and Lattice exchange, as Rust types.
//!
//! These types are the single source of the protocol. `schema::document`
//! exports them as `plugin-api/schema/level-<API_LEVEL>.json`, which is
//! committed; `scripts/check-plugin-api-schema.mjs` fails CI when a change
//! removes or narrows anything an earlier schema had. The contract (only
//! additions, never a changed signature) is `docs/plugins.md` §"Compatibility",
//! adapted from Neovim's api-contract.
//!
//! The wire format is JSON-RPC 2.0, one message per line on the plugin's
//! stdin and stdout. Field names are camelCase on the wire.
//!
//! Everything a plugin sends is untrusted: the host parses results leniently
//! (`results::parse`), drops what it does not know, and caps every string.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The newest API level this host speaks. Bump it with every addition, and
/// freeze the previous schema file beside the new one.
pub const API_LEVEL: u32 = 1;
/// The oldest API level this host still serves. Only a deliberate, announced
/// removal (see the deprecation register in docs/plugins.md) raises it.
pub const API_COMPAT: u32 = 1;

/// What the project may hand a plugin, beyond the project's name.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum ProjectRead {
    /// The main document, the active file, the bibliography paths, the
    /// selection and the cursor, sent with each command.
    Context,
    /// Parsed entries of the project's .bib files, through
    /// `bibliography/entries`.
    Bibliography,
}

/// What a plugin was granted. The host enforces each one: the sandbox for
/// `networkLocal`, the broker for the rest.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    #[serde(default)]
    pub project_read: Vec<ProjectRead>,
    /// Loopback ports the plugin may connect to directly (Zotero's 23119).
    #[serde(default)]
    pub network_local: Vec<u16>,
    /// Origins (`https://api.crossref.org`) the plugin may reach through
    /// `http/fetch`. The plugin process itself has no network.
    #[serde(default)]
    pub network: Vec<String>,
    /// Names of secrets the writer stores for this plugin in Settings.
    #[serde(default)]
    pub secrets: Vec<String>,
}

impl Permissions {
    /// Whether every permission in `self` is also in `granted`.
    pub fn within(&self, granted: &Permissions) -> bool {
        self.project_read.iter().all(|p| granted.project_read.contains(p))
            && self.network_local.iter().all(|p| granted.network_local.contains(p))
            && self.network.iter().all(|o| granted.network.contains(o))
            && self.secrets.iter().all(|s| granted.secrets.contains(s))
    }

    pub fn reads(&self, what: ProjectRead) -> bool {
        self.project_read.contains(&what)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginIdentity {
    pub id: String,
    pub version: String,
}

/// Host → plugin, first message of every run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub host_api_level: u32,
    pub host_api_compat: u32,
    /// Lattice's own version, for logs; never branch on it, use the level.
    pub host_version: String,
    pub plugin: PluginIdentity,
    pub granted: Permissions,
    /// BCP 47 interface language, `en` or `zh-CN`.
    pub locale: String,
    /// `macos`, `linux` or `windows`.
    pub platform: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    /// The level the plugin speaks for this run, within
    /// `[hostApiCompat, hostApiLevel]`.
    pub api_level: u32,
}

/// A position in a project file: 1-based line, 1-based column in characters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    pub name: String,
    /// Project-relative paths, `/`-separated. Never absolute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_document: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_file: Option<String>,
    #[serde(default)]
    pub bibliographies: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    /// At most `MAX_SELECTION_CHARS` characters.
    pub text: String,
    pub file: String,
    pub from: Position,
    pub to: Position,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub file: String,
    pub position: Position,
}

/// Sent with each command. Without the `context` permission only
/// `project.name` is filled in.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandContext {
    pub project: ProjectContext,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<Selection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Cursor>,
}

/// The selection cap, the same as the agent's host context.
pub const MAX_SELECTION_CHARS: usize = 12_000;

/// Host → plugin: run one of the commands the manifest declares.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunParams {
    pub command: String,
    /// What the writer typed, for a command whose input kind is `text`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    pub context: CommandContext,
}

/// Host → plugin notification (`$/cancelRequest`): stop the request `id`.
/// The host ends the process shortly after either way.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub id: serde_json::Value,
}

/// Plugin → host: parsed entries of the project's bibliographies.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyEntriesParams {
    /// One project-relative `.bib` path from `context.project.bibliographies`;
    /// every bibliography when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyEntry {
    pub key: String,
    /// Lower-cased entry type (`article`).
    #[serde(rename = "type")]
    pub entry_type: String,
    /// Field values with `@string` macros expanded, as written otherwise.
    /// Names are lower-cased.
    pub fields: BTreeMap<String, String>,
    /// 1-based line of the entry's `@`.
    pub line: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyFile {
    pub path: String,
    pub entries: Vec<BibliographyEntry>,
    /// Why the file could not be parsed; `entries` is then empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyEntriesResult {
    pub files: Vec<BibliographyFile>,
}

/// Plugin → host: an HTTP request to an origin the manifest declares.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchParams {
    pub url: String,
    /// `GET` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// A UTF-8 body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchResult {
    pub status: u16,
    /// Header names lower-cased; repeated headers joined with `, `.
    pub headers: BTreeMap<String, String>,
    /// The body as UTF-8 (invalid sequences replaced), at most 4 MiB.
    pub body: String,
}

/// Plugin → host: a secret the writer saved for this plugin.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsGetParams {
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsGetResult {
    /// Absent when the writer has not saved it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

/// Plugin → host notification: a line for Lattice's log.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogParams {
    pub level: LogLevel,
    pub message: String,
}

/// Plugin → host notification: what the command is doing, shown while it runs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProgressParams {
    pub message: String,
    /// 0 to 1, when the plugin can tell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
}

/// A verb the host performs for the writer, with the plugin's arguments.
/// Writes go through Lattice's own confirmation and history; the plugin never
/// writes a file itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ActionKind {
    /// Insert `\cite{key}` (or add the key to the citation at the cursor).
    InsertCitation { key: String },
    /// Add an entry to a bibliography after the writer confirms it.
    AddBibEntry {
        bibtex: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file: Option<String>,
    },
    /// Replace the entry `key` after the writer confirms the change.
    ReplaceBibEntry {
        key: String,
        bibtex: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file: Option<String>,
    },
    /// Open a project file, at a line when given.
    Reveal {
        file: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
    },
    /// Open an http(s) URL in the browser.
    OpenUrl { url: String },
    /// Copy text to the clipboard.
    Copy { text: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// The button's label; the host's own label for the verb when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(flatten)]
    pub kind: ActionKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Stable within the result, so an agent or a test can name the item.
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Short labels shown beside the title (`In bibliography`).
    #[serde(default)]
    pub badges: Vec<String>,
    /// The first is the default, run by Return.
    #[serde(default)]
    pub actions: Vec<Action>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub id: String,
    /// Project-relative path.
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub severity: Severity,
    /// A stable, machine-readable rule name (`duplicate-key`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
    #[serde(default)]
    pub fixes: Vec<Action>,
}

/// What a command returns. The host renders it natively; a plugin ships no
/// UI. `summary` is plain text that stands for the whole result in a log,
/// a notification, or (later) an agent's tool output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommandResult {
    Message {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        /// CommonMark without raw HTML; links must be http(s).
        markdown: String,
    },
    Items {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        items: Vec<Item>,
    },
    Diagnostics {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        items: Vec<Diagnostic>,
    },
}

/// JSON-RPC error codes the host sends or understands, beyond the standard
/// -32700..-32600 range.
pub mod error_codes {
    /// The plugin asked for something its grant does not include.
    /// `data: { "permission": "<name>" }`.
    pub const PERMISSION_DENIED: i64 = -32001;
    /// `initialize`: the plugin cannot speak any level in the host's range.
    /// `data: { "supported": [lo, hi] }`.
    pub const UNSUPPORTED_API_LEVEL: i64 = -32002;
    /// A host call failed (a file vanished, a fetch timed out).
    pub const HOST_ERROR: i64 = -32003;
    /// The request was cancelled (LSP's code).
    pub const REQUEST_CANCELLED: i64 = -32800;
}
