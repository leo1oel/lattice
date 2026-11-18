//! Installed plugins: `<app data>/plugins/`.
//!
//! - `registry.json`: each plugin's source, whether it is enabled, the
//!   permissions the writer granted, and the manifest as last read;
//! - `packages/<id>/<version>/`: a plugin installed from a URL, unpacked
//!   once and never changed (an update unpacks a new version beside it);
//! - `data/<id>/`: the only folder the plugin may write.
//!
//! A URL install records the archive's SHA-256, which the writer supplies
//! (from the plugin's release page) and which must match before anything is
//! unpacked. A folder install is for developing a plugin: it runs from the
//! folder in place, so edits apply on the next run.
//!
//! Nothing in a project folder installs, enables or configures a plugin:
//! projects arrive from collaborators, Overleaf and arXiv, and a project's
//! own files are untrusted (Obsidian's PHANTOMPULSE came through exactly
//! that door).

use super::manifest::{self, Manifest};
use super::protocol::Permissions;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

static LOCK: Mutex<()> = Mutex::new(());
const MAX_ARCHIVE: u64 = 50 << 20;
const MAX_UNPACKED: u64 = 200 << 20;
const MAX_FILES: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    Folder { path: PathBuf },
    Url { url: String, sha256: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    pub(crate) id: String,
    pub(crate) source: Source,
    /// The folder the plugin runs from.
    pub(crate) dir: PathBuf,
    pub(crate) enabled: bool,
    /// What the writer approved when enabling; `None` until then.
    pub(crate) granted: Option<Permissions>,
    pub(crate) manifest: Manifest,
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    version: u32,
    plugins: Vec<Record>,
}

pub(crate) struct Store {
    pub(crate) root: PathBuf,
}

impl Store {
    fn registry_path(&self) -> PathBuf {
        self.root.join("registry.json")
    }

    pub(crate) fn data_dir(&self, id: &str) -> PathBuf {
        self.root.join("data").join(id)
    }

    fn read(&self) -> Result<Registry, String> {
        match std::fs::read(self.registry_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("Cannot read the plugin registry: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(Registry { version: 1, plugins: Vec::new() })
            }
            Err(e) => Err(format!("Cannot read the plugin registry: {e}")),
        }
    }

    fn write(&self, registry: &Registry) -> Result<(), String> {
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let temp = self.root.join(format!(".registry-{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(registry).map_err(|e| e.to_string())?;
        std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, self.registry_path()).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            e.to_string()
        })
    }

    fn update<T>(
        &self, change: impl FnOnce(&mut Vec<Record>) -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = LOCK.lock().map_err(|_| "The plugin registry is busy.".to_string())?;
        let mut registry = self.read()?;
        let value = change(&mut registry.plugins)?;
        registry.version = 1;
        self.write(&registry)?;
        Ok(value)
    }

    pub(crate) fn records(&self) -> Result<Vec<Record>, String> {
        let _guard = LOCK.lock().map_err(|_| "The plugin registry is busy.".to_string())?;
        Ok(self.read()?.plugins)
    }

    pub(crate) fn record(&self, id: &str) -> Result<Record, String> {
        self.records()?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or_else(|| "This plugin is not installed.".into())
    }

    /// Install (or re-read) the plugin in `folder`, disabled until enabled.
    pub(crate) fn install_folder(&self, folder: &Path) -> Result<Record, String> {
        let dir =
            folder.canonicalize().map_err(|e| format!("Cannot open the plugin folder: {e}"))?;
        let manifest = manifest::read(&dir)?;
        self.update(|plugins| {
            if let Some(existing) = plugins.iter().find(|r| r.id == manifest.id) {
                if existing.dir != dir {
                    return Err(format!(
                        "A plugin with the id {} is already installed. Remove it first.",
                        manifest.id
                    ));
                }
            }
            Ok(upsert(plugins, manifest, Source::Folder { path: dir.clone() }, dir))
        })
    }

    /// Download the archive at `url`, check it against `sha256`, unpack it
    /// and install it. An update keeps the plugin enabled only when it asks
    /// for nothing it was not already granted.
    pub(crate) fn install_url(&self, url: &str, sha256: &str) -> Result<Record, String> {
        let expected = sha256.trim().to_ascii_lowercase();
        if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("The SHA-256 must be 64 hexadecimal characters.".into());
        }
        let bytes = download(url)?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != expected {
            return Err(format!(
                "The download's SHA-256 is {actual}, not the one given. Nothing was installed."
            ));
        }
        let staging = self.root.join("staging").join(uuid::Uuid::new_v4().to_string());
        let result = (|| {
            unpack(&bytes, &staging)?;
            let package = package_root(&staging)?;
            let manifest = manifest::read(&package)?;
            if !manifest::ACCEPTED_LICENSES.contains(&manifest.license.as_str()) {
                return Err(format!(
                    "The plugin's licence ({}) is not one Lattice accepts for installed plugins.",
                    manifest.license
                ));
            }
            let dir = self.root.join("packages").join(&manifest.id).join(&manifest.version);
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
            std::fs::create_dir_all(dir.parent().expect("has parent"))
                .map_err(|e| e.to_string())?;
            std::fs::rename(&package, &dir).map_err(|e| e.to_string())?;
            let dir = dir.canonicalize().map_err(|e| e.to_string())?;
            let source = Source::Url { url: url.to_string(), sha256: expected.clone() };
            self.update(|plugins| Ok(upsert(plugins, manifest, source, dir)))
        })();
        let _ = std::fs::remove_dir_all(&staging);
        result
    }

    /// Enable with the manifest's current permissions as the grant (the
    /// shell showed them first), or disable keeping the grant.
    pub(crate) fn set_enabled(&self, id: &str, enabled: bool) -> Result<Record, String> {
        self.update(|plugins| {
            let record =
                plugins.iter_mut().find(|r| r.id == id).ok_or("This plugin is not installed.")?;
            if enabled {
                let manifest = manifest::read(&record.dir)?;
                if manifest.id != record.id {
                    return Err("The plugin's id changed. Remove it and install it again.".into());
                }
                record.granted = Some(manifest.permissions());
                record.manifest = manifest;
            }
            record.enabled = enabled;
            Ok(record.clone())
        })
    }

    /// Remove the record, its unpacked versions and its data folder.
    pub(crate) fn remove(&self, id: &str) -> Result<Record, String> {
        let record = self.update(|plugins| {
            let index =
                plugins.iter().position(|r| r.id == id).ok_or("This plugin is not installed.")?;
            Ok(plugins.remove(index))
        })?;
        if matches!(record.source, Source::Url { .. }) {
            let _ = std::fs::remove_dir_all(self.root.join("packages").join(id));
        }
        let _ = std::fs::remove_dir_all(self.data_dir(id));
        Ok(record)
    }

    /// The manifest as it is on disk now, refreshed in the registry.
    pub(crate) fn refresh(&self, id: &str) -> Result<Record, String> {
        let record = self.record(id)?;
        let manifest = manifest::read(&record.dir)?;
        if manifest == record.manifest {
            return Ok(record);
        }
        self.update(|plugins| {
            let record =
                plugins.iter_mut().find(|r| r.id == id).ok_or("This plugin is not installed.")?;
            record.manifest = manifest;
            Ok(record.clone())
        })
    }
}

fn upsert(plugins: &mut Vec<Record>, manifest: Manifest, source: Source, dir: PathBuf) -> Record {
    let permissions = manifest.permissions();
    match plugins.iter_mut().find(|r| r.id == manifest.id) {
        Some(record) => {
            let still_granted = record.granted.as_ref().is_some_and(|g| permissions.within(g));
            record.enabled &= still_granted;
            record.source = source;
            record.dir = dir;
            record.manifest = manifest;
            record.clone()
        }
        None => {
            let record = Record {
                id: manifest.id.clone(),
                source,
                dir,
                enabled: false,
                granted: None,
                manifest,
            };
            plugins.push(record.clone());
            record
        }
    }
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let parsed = url::Url::parse(url)
        .map_err(|_| "Enter the URL of the plugin's .zip release.".to_string())?;
    let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err("Plugins install only over https.".into());
    }
    let client =
        crate::http::blocking_as(&format!("Lattice/{}", crate::VERSION), Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
    let response = client.get(parsed).send().map_err(|e| format!("The download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The download failed: HTTP {}.", response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_ARCHIVE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("The download failed: {e}"))?;
    if bytes.len() as u64 > MAX_ARCHIVE {
        return Err("The plugin archive is larger than 50 MiB.".into());
    }
    Ok(bytes)
}

/// Unpack a zip into `into`, refusing links, absolute paths and `..`, and
/// keeping only the executable bit of each file's mode.
pub(crate) fn unpack(bytes: &[u8], into: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("Not a zip archive: {e}"))?;
    if archive.len() > MAX_FILES {
        return Err("The plugin archive has too many files.".into());
    }
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = file.name().map(|n| n.into_owned()).unwrap_or_default();
        let relative =
            file.enclosed_name().ok_or_else(|| format!("Unsafe path in the archive: {name}"))?;
        if file.is_symlink() {
            return Err(format!("The archive holds a link ({name}); plugins may not."));
        }
        let path = into.join(&relative);
        if file.is_dir() {
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            continue;
        }
        std::fs::create_dir_all(path.parent().expect("has parent")).map_err(|e| e.to_string())?;
        let mut out = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        let budget = MAX_UNPACKED.saturating_sub(total);
        let written = std::io::copy(&mut (&mut file).take(budget + 1), &mut out)
            .map_err(|e| e.to_string())?;
        total += written;
        if total > MAX_UNPACKED {
            return Err("The plugin archive unpacks to more than 200 MiB.".into());
        }
        #[cfg(unix)]
        if file.unix_mode().is_some_and(|mode| mode & 0o111 != 0) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The folder holding the manifest: the archive's root, or its one folder
/// (GitHub's source archives wrap everything in `<repo>-<tag>/`).
fn package_root(staging: &Path) -> Result<PathBuf, String> {
    if staging.join(manifest::FILE_NAME).is_file() {
        return Ok(staging.to_path_buf());
    }
    let entries: Vec<_> = std::fs::read_dir(staging)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| e.file_name() != "__MACOSX")
        .collect();
    match entries.as_slice() {
        [only] if only.path().join(manifest::FILE_NAME).is_file() => Ok(only.path()),
        _ => Err(format!("The archive has no {} at its root.", manifest::FILE_NAME)),
    }
}
