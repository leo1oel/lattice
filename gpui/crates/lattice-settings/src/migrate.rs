//! The one-time move of the rest of the writer's state from the Tauri app,
//! beside the settings [`crate::import`] carries: the recent projects, the
//! palette's recent commands, the submission checklist templates and the
//! Get started progress (all localStorage), the Overleaf session, linked
//! folders and download folder (`app_config_dir`), and the installed
//! plugins, themes, project templates and Agent skills (`app_data_dir`).
//!
//! The Tauri app's files are only ever read: everything lands in the GPUI
//! app's own folders, and the localStorage database is read from a copy.
//! What the GPUI app already holds wins: a list is merged with its own
//! entries first, and a plugin, theme, template, skill or file it already
//! has is left as it is. Once every kind has been carried (or found to have
//! nothing to carry, a missing or unreadable Tauri store included), a marker
//! in the state folder says so and later launches skip the whole step; a
//! kind that could not be written leaves no marker, so the next launch tries
//! again, and the merges make a second pass add nothing twice.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use anyhow::Context as _;
use serde_json::{Value, json};

/// The marker's name in the GPUI app's state folder.
pub const MARKER: &str = "tauri-migration.json";
const MARKER_VERSION: u64 = 1;

const RECENT_PROJECTS: &str = "lattice.recent-projects.v1";
const RECENT_COMMANDS: &str = "lattice.recent-commands.v1";
const SUBMISSION_TEMPLATES: &str = "lattice.submission-templates.v1";
const GET_STARTED: &str = "lattice.get-started.v1";
const STORAGE_KEYS: &[&str] = &[
    RECENT_PROJECTS,
    RECENT_COMMANDS,
    SUBMISSION_TEMPLATES,
    GET_STARTED,
];

/// The most recent projects either app keeps (`RECENT_PROJECTS_MAX`).
const RECENT_PROJECTS_KEPT: usize = 8;
/// The most linked Overleaf folders lattice-core remembers (`MAX_FOLDERS`).
const LINKED_FOLDERS_KEPT: usize = 200;

/// Where the Tauri app keeps what is carried over. Read, never written.
pub struct Tauri {
    /// Its `app_data_dir`: `plugins/`, `themes/`, `templates/` and
    /// `synara/skills/`.
    pub data: PathBuf,
    /// Its `app_config_dir`: the Overleaf session and lists.
    pub config: PathBuf,
    /// Its WebKit `WebsiteData` folder, which holds its localStorage.
    pub website_data: Option<PathBuf>,
}

/// Where the GPUI app keeps each.
pub struct Gpui {
    /// The state folder: the lists from localStorage, `templates/` and the
    /// marker.
    pub state: PathBuf,
    /// The data folder: `plugins/`, `themes/` and `synara/skills/`.
    pub data: PathBuf,
    /// The Overleaf folder (`overleaf::config_dir`).
    pub overleaf: PathBuf,
}

/// What one run carried over.
#[derive(Debug, Default)]
pub struct Report {
    /// How many entries each kind added, for the kinds that added any.
    pub carried: BTreeMap<&'static str, usize>,
    /// The kinds that could not be written, and why.
    pub failed: Vec<(&'static str, String)>,
}

/// Carry the Tauri app's state into the GPUI app's folders, unless the
/// marker says an earlier launch already has: `None` then.
pub fn migrate(tauri: &Tauri, gpui: &Gpui) -> Option<Report> {
    let marker = gpui.state.join(MARKER);
    if marker.exists() {
        return None;
    }
    // Every write goes under the GPUI app's folders; one that sits inside
    // the Tauri app's (or holds it) would write into the Tauri app's data.
    let overlaps = |a: &Path, b: &Path| a.starts_with(b) || b.starts_with(a);
    if [&gpui.state, &gpui.data, &gpui.overleaf]
        .iter()
        .any(|own| overlaps(own, &tauri.data) || overlaps(own, &tauri.config))
    {
        log::warn!(
            "not carrying the Tauri app's state over: the GPUI app's folders overlap {}",
            tauri.data.display()
        );
        return None;
    }
    let storage = tauri
        .website_data
        .as_deref()
        .and_then(|dir| crate::import::read_storage(dir, STORAGE_KEYS))
        .map(|(_, items)| items)
        .unwrap_or_default();
    let stored = |key: &str| storage.get(key).map(String::as_str);
    let steps: [(&'static str, anyhow::Result<usize>); 11] = [
        (
            "recent projects",
            recent_projects(
                stored(RECENT_PROJECTS),
                &gpui.state.join("recent-projects.json"),
            ),
        ),
        (
            "recent commands",
            verbatim(
                stored(RECENT_COMMANDS),
                &gpui.state.join("recent-commands.json"),
                Value::is_array,
            ),
        ),
        (
            "submission templates",
            verbatim(
                stored(SUBMISSION_TEMPLATES),
                &gpui.state.join("submission-templates.json"),
                Value::is_array,
            ),
        ),
        (
            "get started",
            verbatim(
                stored(GET_STARTED),
                &gpui.state.join("get-started.json"),
                Value::is_object,
            ),
        ),
        (
            "overleaf session",
            overleaf_file(
                &tauri.config,
                &gpui.overleaf,
                "overleaf-session.json",
                "cookie",
            ),
        ),
        (
            "overleaf download folder",
            overleaf_file(
                &tauri.config,
                &gpui.overleaf,
                "overleaf-download-folder.json",
                "folder",
            ),
        ),
        (
            "overleaf linked folders",
            linked_folders(
                &tauri.config.join("overleaf-local-copies.json"),
                &gpui.overleaf.join("overleaf-local-copies.json"),
            ),
        ),
        (
            "plugins",
            plugins(&tauri.data.join("plugins"), &gpui.data.join("plugins")),
        ),
        (
            "themes",
            themes(&tauri.data.join("themes"), &gpui.data.join("themes")),
        ),
        (
            "templates",
            entries(&tauri.data.join("templates"), &gpui.state.join("templates")),
        ),
        (
            "skills",
            entries(
                &tauri.data.join("synara/skills"),
                &gpui.data.join("synara/skills"),
            ),
        ),
    ];
    let mut report = Report::default();
    for (kind, result) in steps {
        match result {
            Ok(0) => {}
            Ok(count) => {
                report.carried.insert(kind, count);
            }
            Err(error) => {
                log::warn!("could not carry the Tauri app's {kind} over: {error:#}");
                report.failed.push((kind, format!("{error:#}")));
            }
        }
    }
    if report.failed.is_empty() {
        let body = json!({
            "version": MARKER_VERSION,
            "from": tauri.data,
            "carried": report.carried,
        });
        if let Err(error) = write_atomic(&marker, &pretty(&body)) {
            log::warn!("could not write {}: {error:#}", marker.display());
        }
    }
    Some(report)
}

/// The Tauri app's recent projects after the GPUI app's own, each folder
/// once, as many as either keeps. An entry the Tauri app would not read
/// (`loadRecentProjects`: no string name or path) is dropped; a GPUI list
/// that does not read counts as empty, as `RecentProjects::load` reads it.
fn recent_projects(stored: Option<&str>, target: &Path) -> anyhow::Result<usize> {
    let Some(Value::Array(tauri)) = stored.and_then(|text| serde_json::from_str(text).ok()) else {
        return Ok(0);
    };
    let mut list: Vec<Value> = std::fs::read(target)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
        .unwrap_or_default();
    let own = list.len();
    for entry in tauri.iter().take(RECENT_PROJECTS_KEPT) {
        let (Some(name), Some(path)) = (
            entry.get("name").and_then(Value::as_str),
            entry.get("path").and_then(Value::as_str),
        ) else {
            continue;
        };
        if list.len() >= RECENT_PROJECTS_KEPT
            || list
                .iter()
                .any(|kept| kept.get("path").and_then(Value::as_str) == Some(path))
        {
            continue;
        }
        let mut project = json!({ "name": name, "path": path });
        if let Some(opened_at) = entry.get("openedAt").and_then(Value::as_u64) {
            project["openedAt"] = opened_at.into();
        }
        list.push(project);
    }
    let added = list.len() - own;
    if added > 0 {
        write_atomic(target, &pretty(&Value::Array(list)))?;
    }
    Ok(added)
}

/// A localStorage value the GPUI app keeps in the Tauri app's own shape,
/// written as stored when the GPUI app has no file of its own yet and the
/// value is JSON of the expected `shape`.
fn verbatim(
    stored: Option<&str>,
    target: &Path,
    shape: fn(&Value) -> bool,
) -> anyhow::Result<usize> {
    let Some(text) = stored else {
        return Ok(0);
    };
    if target.exists() || !serde_json::from_str::<Value>(text).is_ok_and(|value| shape(&value)) {
        return Ok(0);
    }
    write_atomic(target, text.trim())?;
    Ok(1)
}

/// One of the Overleaf folder's single-value files, copied when the GPUI
/// app has none and the Tauri app's is a JSON object holding `field`. The
/// session keeps the owner-only mode lattice-core gives it, as it is as good
/// as a browser login; signing out of either app afterwards deletes only
/// that app's copy (`overleaf::disconnect`).
fn overleaf_file(from: &Path, to: &Path, name: &str, field: &str) -> anyhow::Result<usize> {
    let target = to.join(name);
    if target.exists() {
        return Ok(0);
    }
    let Ok(text) = std::fs::read_to_string(from.join(name)) else {
        return Ok(0);
    };
    let readable = serde_json::from_str::<Value>(&text)
        .is_ok_and(|value| value.get(field).is_some_and(|value| !value.is_null()));
    if !readable {
        return Ok(0);
    }
    write_file(&target, &text, name == "overleaf-session.json")?;
    Ok(1)
}

/// The folders the Tauri app remembers linking to Overleaf projects, after
/// the GPUI app's own (`overleaf/local_copies.rs`). The link itself lives in
/// each folder (`.research/overleaf.json`), so it needs no carrying: this
/// list is how "Open from Overleaf" finds those folders.
fn linked_folders(from: &Path, to: &Path) -> anyhow::Result<usize> {
    let folders = |path: &Path| -> Option<Vec<Value>> {
        let text = std::fs::read_to_string(path).ok()?;
        match serde_json::from_str::<Value>(&text).ok()?.get("folders")? {
            Value::Array(folders) => Some(folders.clone()),
            _ => None,
        }
    };
    let Some(tauri) = folders(from) else {
        return Ok(0);
    };
    let mut list = folders(to).unwrap_or_default();
    let own = list.len();
    for folder in tauri.into_iter().filter(Value::is_string) {
        if list.len() < LINKED_FOLDERS_KEPT && !list.contains(&folder) {
            list.push(folder);
        }
    }
    let added = list.len() - own;
    if added > 0 {
        write_atomic(to, &(pretty(&json!({ "folders": list })) + "\n"))?;
    }
    Ok(added)
}

/// A plugin id as lattice-core's manifest allows it, so it is safe as a
/// folder name.
fn plain_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// The installed plugins (`plugins/store.rs`): each registry record the
/// GPUI app does not have yet, enabled or not and with the permissions
/// granted, as it was. A plugin installed from a URL runs from its unpacked
/// package, copied into the GPUI app's store with its record pointed there;
/// one installed from a folder keeps running from that folder. Each
/// plugin's own data folder comes along.
fn plugins(from: &Path, to: &Path) -> anyhow::Result<usize> {
    let read = |root: &Path| -> Option<Result<Value, serde_json::Error>> {
        let bytes = std::fs::read(root.join("registry.json")).ok()?;
        Some(serde_json::from_slice::<Value>(&bytes))
    };
    let tauri = match read(from) {
        None => return Ok(0),
        Some(Ok(registry)) => registry,
        Some(Err(error)) => {
            log::warn!("the Tauri app's plugin registry does not read: {error}");
            return Ok(0);
        }
    };
    let mut registry = match read(to) {
        None => json!({ "version": 1, "plugins": [] }),
        Some(Ok(registry)) if registry.get("plugins").is_some_and(Value::is_array) => registry,
        _ => {
            // lattice-core refuses it as well; writing over it would lose
            // whatever the writer installed here.
            log::warn!("the GPUI app's plugin registry does not read; leaving it");
            return Ok(0);
        }
    };
    let canonical_from = from.canonicalize().ok();
    let mut added = 0;
    for record in tauri
        .get("plugins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = record
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| plain_id(id))
        else {
            continue;
        };
        if registry["plugins"]
            .as_array()
            .is_some_and(|kept| kept.iter().any(|kept| kept["id"].as_str() == Some(id)))
        {
            continue;
        }
        let mut record = record.clone();
        if record.pointer("/source/kind").and_then(Value::as_str) == Some("url") {
            let Some(dir) = record.get("dir").and_then(Value::as_str).map(PathBuf::from) else {
                continue;
            };
            let inside = dir.strip_prefix(from).ok().or_else(|| {
                canonical_from
                    .as_deref()
                    .and_then(|canonical| dir.strip_prefix(canonical).ok())
            });
            let Some(inside) = inside.map(Path::to_path_buf) else {
                continue;
            };
            if !dir.is_dir() {
                log::warn!("plugin {id}'s package is gone from {}", dir.display());
                continue;
            }
            let package = to.join(&inside);
            if !package.exists() {
                copy_tree(&dir, &package)
                    .with_context(|| format!("copying plugin {id}'s package"))?;
            }
            record["dir"] = Value::String(package.to_string_lossy().into_owned());
        }
        let data = from.join("data").join(id);
        let own_data = to.join("data").join(id);
        if data.is_dir() && !own_data.exists() {
            copy_tree(&data, &own_data).with_context(|| format!("copying plugin {id}'s data"))?;
        }
        if let Some(plugins) = registry["plugins"].as_array_mut() {
            plugins.push(record);
        }
        added += 1;
    }
    if added > 0 {
        registry["version"] = 1.into();
        write_atomic(&to.join("registry.json"), &pretty(&registry))?;
    }
    Ok(added)
}

/// The installed themes (`themes.rs`): each `<id>.json` the GPUI app does
/// not have, copied as it is. A file whose `id` is not its name is not a
/// theme the store reads, so it stays behind.
fn themes(from: &Path, to: &Path) -> anyhow::Result<usize> {
    let mut added = 0;
    for path in children(from) {
        let (Some(stem), Some("json")) = (
            path.file_stem().and_then(|stem| stem.to_str()),
            path.extension().and_then(|ext| ext.to_str()),
        ) else {
            continue;
        };
        let target = to.join(format!("{stem}.json"));
        if target.exists() || !path.is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let id = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|theme| theme.get("id").and_then(Value::as_str).map(str::to_owned));
        if id.as_deref() != Some(stem) {
            continue;
        }
        write_atomic(&target, &text)?;
        added += 1;
    }
    Ok(added)
}

/// Every entry of a store of folders (the project templates, the Agent's
/// skills) the GPUI app does not have by that name, copied whole. Hidden
/// entries are a store's half-made ones and stay behind.
fn entries(from: &Path, to: &Path) -> anyhow::Result<usize> {
    let mut added = 0;
    for path in children(from) {
        let Some(name) = path.file_name() else {
            continue;
        };
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let target = to.join(name);
        if target.exists() {
            continue;
        }
        let kind = std::fs::symlink_metadata(&path)?.file_type();
        if kind.is_dir() {
            copy_tree(&path, &target)?;
        } else if kind.is_file() {
            std::fs::create_dir_all(to)?;
            std::fs::copy(&path, &target)?;
        } else {
            continue;
        }
        added += 1;
    }
    Ok(added)
}

/// The entries of `dir`, by name; none when it cannot be read.
fn children(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default();
    found.sort();
    found
}

/// Copy the folder `from` to `to`, which does not exist yet: into a hidden
/// folder beside it, moved into place once whole, so an interrupted copy
/// never reads as a finished one. Links are neither followed nor copied.
fn copy_tree(from: &Path, to: &Path) -> anyhow::Result<()> {
    fn copy(from: &Path, to: &Path) -> anyhow::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let target = to.join(entry.file_name());
            if kind.is_dir() {
                copy(&entry.path(), &target)?;
            } else if kind.is_file() {
                std::fs::copy(entry.path(), &target)?;
            }
        }
        Ok(())
    }
    let (Some(parent), Some(name)) = (to.parent(), to.file_name()) else {
        anyhow::bail!("{} is not a folder to copy into", to.display());
    };
    std::fs::create_dir_all(parent)?;
    let staging = parent.join(format!(
        ".{}.migrating-{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&staging);
    let result = copy(from, &staging).and_then(|()| Ok(std::fs::rename(&staging, to)?));
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result.with_context(|| format!("copying {} to {}", from.display(), to.display()))
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("JSON values serialise")
}

fn write_atomic(path: &Path, text: &str) -> anyhow::Result<()> {
    write_file(path, text, false)
}

/// Write `text` beside `path` and move it over, so a reader never sees half
/// a file; a `private` one is the owner's alone before it holds anything.
fn write_file(path: &Path, text: &str, private: bool) -> anyhow::Result<()> {
    let Some(parent) = path.parent() else {
        anyhow::bail!("{} has no folder", path.display());
    };
    std::fs::create_dir_all(parent)?;
    let mut partial = path.as_os_str().to_owned();
    partial.push(".migrating");
    let partial = PathBuf::from(partial);
    let _ = std::fs::remove_file(&partial);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    std::io::Write::write_all(&mut options.open(&partial)?, text.as_bytes())?;
    std::fs::rename(&partial, path).with_context(|| format!("writing {}", path.display()))
}

#[cfg(test)]
mod tests;
