//! `lattice-plugin.toml`: who a plugin is, how it runs, what it may touch
//! and which commands it adds.
//!
//! Three version axes stay apart: `schema` (this file's format), `api`
//! (the lowest host API level the plugin needs) and `version` (the
//! plugin's own). There is deliberately no maximum: Zotero's
//! `strict_max_version` turned off plugins that still worked.
//!
//! Unknown top-level keys are ignored, so a newer manifest still loads, but
//! an unknown key under `[permissions]` is refused: it asks for something
//! this host cannot enforce, and running without it would be a silent grant.

use super::protocol::{Permissions, ProjectRead, API_LEVEL};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};

pub const FILE_NAME: &str = "lattice-plugin.toml";
/// The manifest format this host reads.
pub const SCHEMA: u32 = 1;
const MAX_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Runtime {
    /// A JavaScript file run by the Node that ships with Lattice.
    Node,
    /// A native executable per target triple.
    Exec,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum InputKind {
    /// The command runs as soon as it is chosen.
    #[default]
    None,
    /// The palette asks for one line of text first.
    Text,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub struct CommandInput {
    #[serde(default)]
    pub kind: InputKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub struct CommandSpec {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub input: CommandInput,
}

/// `[permissions]` as written: kebab-case, every key known.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct ManifestPermissions {
    /// `"context"` and/or `"bibliography"`.
    #[serde(default)]
    pub project_read: Vec<String>,
    #[serde(default)]
    pub network_local: Vec<u16>,
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub secrets: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub struct Manifest {
    pub schema: u32,
    /// Reverse-domain and unique: `dev.knightnemo.zotero-search`.
    pub id: String,
    pub name: String,
    pub version: String,
    /// The lowest host API level the plugin needs.
    pub api: u32,
    /// An SPDX identifier.
    pub license: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub runtime: Runtime,
    /// `node`: the JavaScript entry point, relative to the plugin folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main: Option<String>,
    /// `exec`: the executable per Rust target triple
    /// (`aarch64-apple-darwin`), relative to the plugin folder.
    #[serde(default)]
    pub targets: BTreeMap<String, String>,
    #[serde(default)]
    pub permissions: ManifestPermissions,
    pub commands: Vec<CommandSpec>,
}

/// SPDX identifiers accepted for a plugin installed from a URL, after Zed's
/// extension licence list. A folder installed while developing a plugin may
/// carry any licence.
pub const ACCEPTED_LICENSES: &[&str] = &[
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSL-1.0",
    "GPL-3.0",
    "GPL-3.0-only",
    "GPL-3.0-or-later",
    "ISC",
    "LGPL-3.0",
    "LGPL-3.0-only",
    "LGPL-3.0-or-later",
    "MIT",
    "MPL-2.0",
    "Unlicense",
    "Zlib",
];

impl Manifest {
    /// The permissions in the protocol's shape; only valid after [`read`].
    pub fn permissions(&self) -> Permissions {
        let p = &self.permissions;
        let read = |name: &String| match name.as_str() {
            "context" => Some(ProjectRead::Context),
            "bibliography" => Some(ProjectRead::Bibliography),
            _ => None,
        };
        let mut project_read: Vec<_> = p.project_read.iter().filter_map(read).collect();
        project_read.sort();
        project_read.dedup();
        Permissions {
            project_read,
            network_local: sorted(&p.network_local),
            network: sorted(
                &p.network
                    .iter()
                    .map(|o| normalize_origin(o).unwrap_or_default())
                    .collect::<Vec<_>>(),
            ),
            secrets: sorted(&p.secrets),
        }
    }

    pub fn command(&self, id: &str) -> Option<&CommandSpec> {
        self.commands.iter().find(|c| c.id == id)
    }

    /// The file the runtime starts: the entry script for `node`, the
    /// executable for `exec` on this machine.
    pub fn entry(&self, root: &Path) -> Result<PathBuf, String> {
        let relative = match self.runtime {
            Runtime::Node => self.main.as_deref().ok_or("The manifest has no `main`.")?,
            Runtime::Exec => {
                self.targets.get(current_target()).map(String::as_str).ok_or_else(|| {
                    format!("This plugin has no executable for {}.", current_target())
                })?
            }
        };
        inside(root, relative)
    }
}

fn sorted<T: Ord + Clone>(values: &[T]) -> Vec<T> {
    let mut values = values.to_vec();
    values.sort();
    values.dedup();
    values
}

/// The Rust target triple Lattice was built for.
pub fn current_target() -> &'static str {
    match (std::env::consts::ARCH, std::env::consts::OS) {
        ("aarch64", "macos") => "aarch64-apple-darwin",
        ("x86_64", "macos") => "x86_64-apple-darwin",
        ("x86_64", "linux") => "x86_64-unknown-linux-gnu",
        ("aarch64", "linux") => "aarch64-unknown-linux-gnu",
        ("x86_64", "windows") => "x86_64-pc-windows-msvc",
        ("aarch64", "windows") => "aarch64-pc-windows-msvc",
        _ => "unknown",
    }
}

/// Read and check the manifest in the plugin folder `root`.
pub fn read(root: &Path) -> Result<Manifest, String> {
    let path = root.join(FILE_NAME);
    let size = std::fs::metadata(&path).map_err(|e| format!("Cannot read {FILE_NAME}: {e}"))?.len();
    if size > MAX_BYTES {
        return Err(format!("{FILE_NAME} is larger than 64 KiB."));
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("Cannot read {FILE_NAME}: {e}"))?;
    let manifest = parse(&text)?;
    manifest.entry(root)?;
    Ok(manifest)
}

/// Parse and check a manifest's text, without looking at the folder.
pub fn parse(text: &str) -> Result<Manifest, String> {
    let manifest: Manifest =
        toml::from_str(text).map_err(|e| format!("Invalid {FILE_NAME}: {e}"))?;
    validate(&manifest)?;
    Ok(manifest)
}

fn validate(m: &Manifest) -> Result<(), String> {
    if m.schema != SCHEMA {
        return Err(format!("This plugin's manifest format ({}) needs a newer Lattice.", m.schema));
    }
    if m.api == 0 || m.api > API_LEVEL {
        return Err(format!(
            "This plugin needs plugin API level {}; this Lattice has {API_LEVEL}.",
            m.api
        ));
    }
    if !valid_plugin_id(&m.id) {
        return Err("The plugin id must be reverse-domain, like dev.example.my-plugin.".into());
    }
    text_field("name", &m.name, 80)?;
    text_field("version", &m.version, 40)?;
    text_field("license", &m.license, 80)?;
    if let Some(description) = &m.description {
        text_field("description", description, 500)?;
    }
    if let Some(repository) = &m.repository {
        if !repository.starts_with("https://") {
            return Err("`repository` must be an https URL.".into());
        }
    }
    match m.runtime {
        Runtime::Node if m.main.is_none() => return Err("A node plugin needs `main`.".into()),
        Runtime::Exec if m.targets.is_empty() => {
            return Err("An exec plugin needs `[targets]`.".into())
        }
        _ => {}
    }
    validate_permissions(&m.permissions)?;
    if m.commands.is_empty() || m.commands.len() > 32 {
        return Err("A plugin declares between 1 and 32 commands.".into());
    }
    let mut ids = HashSet::new();
    for command in &m.commands {
        if !valid_name(&command.id, 40) || !ids.insert(command.id.as_str()) {
            return Err(format!("Invalid or repeated command id `{}`.", command.id));
        }
        text_field("command title", &command.title, 80)?;
    }
    Ok(())
}

fn validate_permissions(p: &ManifestPermissions) -> Result<(), String> {
    for read in &p.project_read {
        match read.as_str() {
            "context" | "bibliography" => {}
            "files" => {
                return Err("`project-read = files` is not available yet: plugin API level 1 grants `context` and `bibliography`.".into())
            }
            other => return Err(format!("Unknown `project-read` value `{other}`.")),
        }
    }
    if p.network_local.len() > 8 || p.network_local.contains(&0) {
        return Err("`network-local` lists at most 8 ports, each 1 to 65535.".into());
    }
    if p.network.len() > 16 {
        return Err("`network` lists at most 16 origins.".into());
    }
    for origin in &p.network {
        normalize_origin(origin).ok_or_else(|| {
            format!("`{origin}` is not an origin like https://api.example.org (http only for localhost).")
        })?;
    }
    if p.secrets.len() > 8 || !p.secrets.iter().all(|s| valid_name(s, 40)) {
        return Err(
            "`secrets` lists at most 8 names of lowercase letters, digits and dashes.".into()
        );
    }
    Ok(())
}

/// `origin` as `scheme://host[:port]`: https, or http to a loopback host.
pub(crate) fn normalize_origin(origin: &str) -> Option<String> {
    let url = url::Url::parse(origin).ok()?;
    let bare = url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty();
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    (bare && scheme_ok && url.host().is_some()).then(|| url.origin().ascii_serialization())
}

fn text_field(name: &str, value: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > max || value.chars().any(char::is_control)
    {
        return Err(format!("`{name}` must be 1 to {max} characters of text."));
    }
    Ok(())
}

pub fn valid_plugin_id(id: &str) -> bool {
    id.len() <= 100
        && id.split('.').count() >= 2
        && id.split('.').all(|part| valid_name(part, 63) && !part.starts_with('-'))
}

fn valid_name(name: &str, max: usize) -> bool {
    !name.is_empty()
        && name.len() <= max
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `relative` under `root`, which must exist and stay inside it after
/// symlinks are resolved.
pub(crate) fn inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("`{relative}` must be a path inside the plugin folder."));
    }
    let root = root.canonicalize().map_err(|e| format!("Cannot open the plugin folder: {e}"))?;
    let resolved = root
        .join(path)
        .canonicalize()
        .map_err(|_| format!("The plugin has no file `{relative}`."))?;
    if !resolved.starts_with(&root) || !resolved.is_file() {
        return Err(format!("`{relative}` must be a file inside the plugin folder."));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const HELLO: &str = r#"
        schema = 1
        id = "dev.lattice.hello"
        name = "Hello"
        version = "0.1.0"
        api = 1
        license = "MIT"
        runtime = "node"
        main = "main.js"
        future-key = "ignored"

        [permissions]
        project-read = ["bibliography", "context"]
        network-local = [23119]
        network = ["https://api.crossref.org/"]

        [[commands]]
        id = "greet"
        title = "Say hello"
        input = { kind = "text", placeholder = "Name" }
    "#;

    #[test]
    fn reads_a_manifest_and_normalizes_its_permissions() {
        let manifest = parse(HELLO).unwrap();
        assert_eq!(manifest.commands[0].input.kind, InputKind::Text);
        let permissions = manifest.permissions();
        assert_eq!(permissions.project_read, [ProjectRead::Context, ProjectRead::Bibliography]);
        assert_eq!(permissions.network, ["https://api.crossref.org"]);
    }

    #[test]
    fn refuses_what_level_one_cannot_enforce() {
        let with = |from: &str, to: &str| parse(&HELLO.replace(from, to)).unwrap_err();
        assert!(with("\"context\"]", "\"files\"]").contains("not available yet"));
        assert!(
            with("network-local", "camera = true\n        network-local").contains("unknown field")
        );
        assert!(
            with("https://api.crossref.org/", "http://api.crossref.org").contains("not an origin")
        );
        assert!(with("https://api.crossref.org/", "https://api.crossref.org/v1")
            .contains("not an origin"));
        assert!(with("api = 1", "api = 2").contains("API level 2"));
        assert!(with("schema = 1", "schema = 2").contains("newer Lattice"));
        assert!(with("dev.lattice.hello", "hello").contains("reverse-domain"));
        assert!(with("id = \"greet\"", "id = \"Greet\"").contains("command id"));
    }

    #[test]
    fn loopback_http_is_an_origin_but_remote_http_is_not() {
        assert_eq!(
            normalize_origin("http://127.0.0.1:23119").as_deref(),
            Some("http://127.0.0.1:23119")
        );
        assert_eq!(normalize_origin("http://example.org"), None);
    }

    #[test]
    fn the_entry_point_stays_inside_the_plugin_folder() {
        let root = crate::test_support::TempDir::new("plugin-manifest");
        root.write(FILE_NAME, HELLO.replace("main.js", "../main.js"));
        root.write("main.js", "");
        assert!(read(&root).unwrap_err().contains("inside the plugin folder"));
        root.write(FILE_NAME, HELLO);
        assert!(read(&root).is_ok());
        #[cfg(unix)]
        {
            let outside = crate::test_support::TempDir::new("plugin-outside");
            let target = outside.write("evil.js", "");
            std::fs::remove_file(root.join("main.js")).unwrap();
            crate::test_support::symlink(&target, root.join("main.js")).unwrap();
            assert!(read(&root).unwrap_err().contains("inside the plugin folder"));
        }
    }
}
