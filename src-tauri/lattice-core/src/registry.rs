//! The theme marketplace's client: the signed list of themes that
//! lattice-writer/lattice-plugins publishes, kept in `<app data>/registry/`, and
//! installs from it (`docs/themes.md`, Captain plan §2.2).
//!
//! Trust comes only from the signatures (`verify.rs`), never from where a
//! file was fetched: the index and the block list are each signed with a
//! comment naming the file and the serial, every theme's sha256 and size come
//! from the signed index, and a list with a lower serial than the one already
//! verified is refused, so an old signed list cannot be replayed to bring back
//! a blocked theme. The last verified pair is cached and served offline.

#[cfg(test)]
mod tests;
mod verify;

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use lattice_theme::{AccentChoice, Appearance, Resolved, ThemeFile, MAX_THEME_BYTES};
use minisign_verify::PublicKey;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::plugins::{manifest, protocol::API_LEVEL, Permissions, PluginHost, Runtime, Source};
use crate::themes::{ThemeInfo, ThemeStore};

/// Where the registry's GitHub Pages sites serve the signed files, tried in
/// order: the registry's home, then its address before it moved to the
/// lattice-writer organization, which mirrors it for older Lattice releases.
/// Both serve the same signed files, so either is as trusted as the other.
pub const BASE_URLS: [&str; 2] = [
    "https://lattice-writer.github.io/lattice-plugins",
    "https://leo1oel.github.io/lattice-plugins",
];
const INDEX: &str = "index.json";
const BLOCKED: &str = "blocked.json";
const FORMAT: u32 = 1;
/// Far above a list of a few thousand themes (about 2 KiB each).
const MAX_LIST_BYTES: u64 = 8 << 20;
const MAX_SIGNATURE_BYTES: u64 = 4 << 10;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexVariant {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub appearance: Appearance,
    #[serde(default)]
    pub colors: BTreeMap<String, String>,
}

/// One theme as the signed index lists it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexTheme {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub repository: String,
    pub tag: String,
    pub commit: String,
    pub path: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub variants: Vec<IndexVariant>,
}

/// A command a listed plugin adds, as its manifest names it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexCommand {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// One plugin version as the signed index lists it: the archive's address,
/// size and sha256, and a snapshot of its manifest (what Browse shows before
/// anything is downloaded, and what the download must match).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    /// The plugin API level the plugin needs.
    pub api: u32,
    pub runtime: Runtime,
    pub license: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub repository: String,
    pub commit: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub permissions: Permissions,
    #[serde(default)]
    pub commands: Vec<IndexCommand>,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// GitHub release downloads the registry counted (no app telemetry).
    #[serde(default)]
    pub downloads: Option<u64>,
    /// When this version was published (ISO 8601).
    #[serde(default)]
    pub updated: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub format: u32,
    pub serial: u64,
    /// When the registry built it (ISO 8601), for display.
    pub generated: String,
    pub themes: Vec<IndexTheme>,
    #[serde(default)]
    pub plugins: Vec<IndexPlugin>,
}

/// A kill-switch entry: `versions` of `id` that Lattice must not install,
/// and that an installed copy reports as blocked (`action` is `disable` or
/// `warn`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedEntry {
    pub id: String,
    pub versions: String,
    pub action: String,
    pub reason: String,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Blocked {
    format: u32,
    serial: u64,
    blocked: Vec<BlockedEntry>,
}

/// What the last refresh did.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Status {
    /// Not refreshed: the cached list as it was.
    Cached,
    /// A newer or equal list was fetched and verified.
    Fresh,
    /// The registry could not be reached; the cached list (if any) stands.
    Offline { message: String },
    /// What the registry sent failed verification or was older than the
    /// cached list; the cached list (if any) stands.
    Refused { message: String },
}

/// A theme installed from the registry, as the Installed list shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledTheme {
    pub id: String,
    pub version: String,
    /// The index's version when it is newer than the installed one.
    pub update: Option<String>,
    /// The block list entry the installed version falls under.
    pub blocked: Option<BlockedEntry>,
}

/// The theme list for Settings: what is verified, from when, and what the
/// refresh did.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub index: Option<Index>,
    pub blocked: Vec<BlockedEntry>,
    /// The entry each listed theme's own version falls under, by id: a row
    /// Browse shows as blocked.
    pub blocked_offers: BTreeMap<String, BlockedEntry>,
    /// When the shown list was fetched and verified (RFC 3339).
    pub fetched_at: Option<String>,
    pub status: Status,
    pub installed: Vec<InstalledTheme>,
}

/// A plugin installed from the registry or from a URL, as the Installed list
/// shows it against the index.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub version: String,
    /// The index's version when it is newer and this Lattice can run it.
    pub update: Option<String>,
    /// What that update asks for beyond the current grant (or, before the
    /// first grant, beyond what the installed version asks): empty when it
    /// applies with one click.
    pub update_asks: Permissions,
    /// The block list entry the installed version falls under.
    pub blocked: Option<BlockedEntry>,
}

/// The plugin list for Settings › Plugins › Browse.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListing {
    pub plugins: Vec<IndexPlugin>,
    /// Whether the shown list is a verified one (Browse can install from it).
    pub verified: bool,
    /// The entry each listed plugin's own version falls under, by id.
    pub blocked_offers: BTreeMap<String, BlockedEntry>,
    pub fetched_at: Option<String>,
    pub status: Status,
    pub installed: Vec<InstalledPlugin>,
}

/// The signed files as fetched, kept whole so they verify again on load.
#[derive(Serialize, Deserialize)]
struct Cache {
    index: String,
    index_signature: String,
    blocked: String,
    blocked_signature: String,
    fetched_at: String,
}

struct Verified {
    index: Index,
    blocked: Vec<BlockedEntry>,
    fetched_at: String,
}

/// What a registry install was, so an update can be offered for it.
#[derive(Serialize, Deserialize)]
struct Record {
    version: String,
}

pub struct Registry {
    root: PathBuf,
    base_urls: Vec<String>,
    keys: Vec<PublicKey>,
}

impl Registry {
    /// The registry client caching under the app's data folder.
    pub fn new(app_data_dir: &Path) -> Self {
        let keys = verify::PUBLIC_KEYS
            .iter()
            .map(|key| PublicKey::from_base64(key).expect("the embedded registry keys parse"))
            .collect();
        Self::with(app_data_dir.join("registry"), &BASE_URLS, keys)
    }

    fn with(root: PathBuf, base_urls: &[&str], keys: Vec<PublicKey>) -> Self {
        let base_urls = base_urls.iter().map(|url| url.trim_end_matches('/').to_string()).collect();
        Registry { root, base_urls, keys }
    }

    /// The verified list, refreshed from the registry first when `refresh`,
    /// with the state of every theme installed from it.
    pub fn listing(&self, store: &ThemeStore, refresh: bool) -> Listing {
        let (verified, status) = if refresh {
            match self.refresh() {
                Ok(verified) => (Some(verified), Status::Fresh),
                Err(status) => (self.cached(), status),
            }
        } else {
            (self.cached(), Status::Cached)
        };
        let installed = verified.as_ref().map(|verified| self.installed(store, verified));
        let blocked_offers = verified.as_ref().map(|verified| {
            let themes = verified.index.themes.iter();
            themes
                .filter_map(|theme| {
                    let entry = blocking(&verified.blocked, &theme.id, &theme.version)?;
                    Some((theme.id.clone(), entry.clone()))
                })
                .collect()
        });
        Listing {
            index: verified.as_ref().map(|verified| verified.index.clone()),
            blocked: verified.as_ref().map(|verified| verified.blocked.clone()).unwrap_or_default(),
            blocked_offers: blocked_offers.unwrap_or_default(),
            fetched_at: verified.map(|verified| verified.fetched_at),
            status,
            installed: installed.unwrap_or_default(),
        }
    }

    fn cache_path(&self) -> PathBuf {
        self.root.join("cache.json")
    }

    fn records_path(&self) -> PathBuf {
        self.root.join("installed.json")
    }

    /// The cached list, verified again (a file edited by hand is not trusted).
    fn cached(&self) -> Option<Verified> {
        let cache: Cache = serde_json::from_slice(&std::fs::read(self.cache_path()).ok()?).ok()?;
        self.verify(&cache).ok()
    }

    fn verify(&self, cache: &Cache) -> Result<Verified, String> {
        let index: Index = parse(INDEX, &cache.index)?;
        verify::verify(
            &self.keys,
            INDEX,
            cache.index.as_bytes(),
            &cache.index_signature,
            index.serial,
        )?;
        let blocked: Blocked = parse(BLOCKED, &cache.blocked)?;
        verify::verify(
            &self.keys,
            BLOCKED,
            cache.blocked.as_bytes(),
            &cache.blocked_signature,
            blocked.serial,
        )?;
        if index.format != FORMAT || blocked.format != FORMAT {
            return Err(
                "The registry's list is in a newer format. Update Lattice to use it.".into()
            );
        }
        // Published together with one serial; a pair from two publishes (a CDN
        // mid-update) could pair a new index with an older block list.
        if blocked.serial != index.serial {
            return Err("The registry is updating its list. Try again in a few minutes.".into());
        }
        Ok(Verified { index, blocked: blocked.blocked, fetched_at: cache.fetched_at.clone() })
    }

    /// The list from the first address that serves one that verifies and is
    /// not older than the cached one. When none does, a refusal is reported
    /// over an unreachable address, since it means a bad list was served.
    fn refresh(&self) -> Result<Verified, Status> {
        let mut failure = None;
        for base_url in &self.base_urls {
            match self.refresh_from(base_url) {
                Ok(verified) => return Ok(verified),
                Err(status) => {
                    let refused = matches!(status, Status::Refused { .. });
                    if failure.is_none()
                        || (refused && !matches!(failure, Some(Status::Refused { .. })))
                    {
                        failure = Some(status);
                    }
                }
            }
        }
        Err(failure.expect("the registry has an address"))
    }

    fn refresh_from(&self, base_url: &str) -> Result<Verified, Status> {
        let offline = |message| Status::Offline { message };
        let get = |file: &str, limit| self.get(&format!("{base_url}/{file}"), limit);
        let cache = Cache {
            index: text(get(INDEX, MAX_LIST_BYTES).map_err(offline)?),
            index_signature: text(
                get(&format!("{INDEX}.minisig"), MAX_SIGNATURE_BYTES).map_err(offline)?,
            ),
            blocked: text(get(BLOCKED, MAX_LIST_BYTES).map_err(offline)?),
            blocked_signature: text(
                get(&format!("{BLOCKED}.minisig"), MAX_SIGNATURE_BYTES).map_err(offline)?,
            ),
            fetched_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        };
        let refused = |message| Status::Refused { message };
        let verified = self.verify(&cache).map_err(refused)?;
        if let Some(known) = self.cached() {
            if verified.index.serial < known.index.serial {
                return Err(refused(format!(
                    "The registry sent an older list (serial {} after {}), so Lattice kept the one it has.",
                    verified.index.serial, known.index.serial
                )));
            }
        }
        let json = serde_json::to_vec(&cache).expect("the cache serializes");
        write_atomically(&self.root, "cache.json", &json).map_err(refused)?;
        Ok(verified)
    }

    fn get(&self, url: &str, limit: u64) -> Result<Vec<u8>, String> {
        download(url, limit).map_err(|err| format!("The registry could not be reached: {err}"))
    }

    fn records(&self) -> BTreeMap<String, Record> {
        std::fs::read(self.records_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Every theme installed from the registry that is still that install
    /// (not removed, nor replaced by a file under the same id and another
    /// version): its installed version, by id.
    fn registry_installs(&self, store: &ThemeStore) -> BTreeMap<String, String> {
        self.records()
            .into_iter()
            .filter(|(id, record)| {
                store.get(id).is_some_and(|theme| theme.version == record.version)
            })
            .map(|(id, record)| (id, record.version))
            .collect()
    }

    /// The registry installs with their update and block state.
    fn installed(&self, store: &ThemeStore, verified: &Verified) -> Vec<InstalledTheme> {
        self.registry_installs(store)
            .into_iter()
            .map(|(id, version)| InstalledTheme {
                update: verified
                    .index
                    .themes
                    .iter()
                    .find(|theme| theme.id == id && verify::newer(&theme.version, &version))
                    .map(|theme| theme.version.clone()),
                blocked: blocking(&verified.blocked, &id, &version).cloned(),
                id,
                version,
            })
            .collect()
    }

    /// The store's themes for the picker, each installed registry theme with
    /// the kill-switch entry its version falls under. Themes installed from a
    /// file are never matched: they are the writer's own.
    pub fn list_themes(&self, store: &ThemeStore) -> Vec<ThemeInfo> {
        let mut themes = store.list();
        let installs = self.registry_installs(store);
        let Some(verified) = (!installs.is_empty()).then(|| self.cached()).flatten() else {
            return themes;
        };
        for theme in &mut themes {
            if let Some(version) = installs.get(&theme.id) {
                theme.blocked = blocking(&verified.blocked, &theme.id, version).cloned();
            }
        }
        themes
    }

    /// `ThemeStore::resolve` with the kill switch: a registry theme whose
    /// installed version is blocked with any action but `warn` resolves as no
    /// theme, so Lattice's own colors show while the choice stays stored.
    pub fn resolve(
        &self, store: &ThemeStore, id: Option<&str>, appearance: Appearance, accent: AccentChoice,
    ) -> Resolved {
        let id = id.filter(|id| !self.turned_off(store, id));
        store.resolve(id, appearance, accent)
    }

    /// Whether the kill switch turns the installed theme `id` off: a shell
    /// that applies a `ThemeFile` itself (the GPUI palette) asks this first.
    pub fn turned_off(&self, store: &ThemeStore, id: &str) -> bool {
        let Some(version) = self.registry_installs(store).remove(id) else {
            return false;
        };
        self.cached().is_some_and(|verified| {
            blocking(&verified.blocked, id, &version).is_some_and(|entry| entry.action != "warn")
        })
    }

    /// Installs (or updates to) the theme the cached list names `id`, after
    /// checking the download's size and sha256 against the signed index.
    pub fn install_theme(&self, store: &ThemeStore, id: &str) -> Result<ThemeInfo, String> {
        let verified =
            self.cached().ok_or("Load the theme list before installing a theme from it.")?;
        let theme = verified
            .index
            .themes
            .iter()
            .find(|theme| theme.id == id)
            .ok_or_else(|| format!("\"{id}\" is not in the theme list."))?;
        if let Some(entry) = blocking(&verified.blocked, id, &theme.version) {
            return Err(format!("{} {} is blocked: {}", theme.name, theme.version, entry.reason));
        }
        let bytes = download(&theme.url, (MAX_THEME_BYTES as u64).min(theme.size))
            .map_err(|err| format!("The theme download failed: {err}"))?;
        if bytes.len() as u64 != theme.size {
            return Err("The downloaded theme is not the size the theme list gives.".into());
        }
        if format!("{:x}", Sha256::digest(&bytes)) != theme.sha256.to_ascii_lowercase() {
            return Err("The downloaded theme does not match the theme list's checksum.".into());
        }
        let text = String::from_utf8(bytes).map_err(|err| err.to_string())?;
        let file = ThemeFile::parse(&text).map_err(|err| err.to_string())?;
        if file.id != theme.id || file.version != theme.version {
            return Err(format!("The downloaded theme is not \"{id}\" {}.", theme.version));
        }
        let info = store.install_text(&text)?;
        let mut records = self.records();
        records.insert(id.to_string(), Record { version: theme.version.clone() });
        let json = serde_json::to_vec_pretty(&records).expect("the records serialize");
        write_atomically(&self.root, "installed.json", &json)?;
        Ok(info)
    }
}

impl Registry {
    /// The verified plugin list, refreshed first when `refresh`, with the
    /// state of every installed plugin the block list and updates apply to.
    pub fn plugin_listing(&self, host: &PluginHost, refresh: bool) -> PluginListing {
        let (verified, status) = if refresh {
            match self.refresh() {
                Ok(verified) => (Some(verified), Status::Fresh),
                Err(status) => (self.cached(), status),
            }
        } else {
            (self.cached(), Status::Cached)
        };
        let Some(verified) = verified else {
            return PluginListing {
                plugins: Vec::new(),
                verified: false,
                blocked_offers: BTreeMap::new(),
                fetched_at: None,
                status,
                installed: Vec::new(),
            };
        };
        let blocked_offers = verified
            .index
            .plugins
            .iter()
            .filter_map(|plugin| {
                let entry = blocking(&verified.blocked, &plugin.id, &plugin.version)?;
                Some((plugin.id.clone(), entry.clone()))
            })
            .collect();
        let records = host.store().records().unwrap_or_default();
        let installed = records
            .into_iter()
            .filter(|record| record.source.blockable())
            .map(|record| {
                let version = record.manifest.version.clone();
                let offer = verified.index.plugins.iter().find(|plugin| {
                    plugin.id == record.id
                        && runnable(plugin).is_ok()
                        && verify::newer(&plugin.version, &version)
                });
                let held = record.granted.clone().unwrap_or_else(|| record.manifest.permissions());
                InstalledPlugin {
                    update: offer.map(|plugin| plugin.version.clone()),
                    update_asks: offer
                        .map(|plugin| beyond(&plugin.permissions, &held))
                        .unwrap_or_default(),
                    blocked: blocking(&verified.blocked, &record.id, &version).cloned(),
                    id: record.id,
                    version,
                }
            })
            .collect();
        PluginListing {
            plugins: verified.index.plugins,
            verified: true,
            blocked_offers,
            fetched_at: Some(verified.fetched_at),
            status,
            installed,
        }
    }

    /// The block list entry an installed plugin's version falls under, from
    /// the cached list. A folder install is never matched.
    pub fn plugin_blocked(&self, id: &str, version: &str, source: &Source) -> Option<BlockedEntry> {
        if !source.blockable() {
            return None;
        }
        let verified = self.cached()?;
        blocking(&verified.blocked, id, version).cloned()
    }

    /// Installs (or updates to) the plugin the cached list names `id`: the
    /// download must have the index's size and sha256, and its manifest must
    /// be the one the index showed (id, version, runtime, API level and
    /// permissions), so what the writer read in Browse is what runs.
    pub(crate) fn install_plugin(
        &self, store: &crate::plugins::Store, id: &str,
    ) -> Result<crate::plugins::Record, String> {
        let verified =
            self.cached().ok_or("Load the plugin list before installing a plugin from it.")?;
        let plugin = verified
            .index
            .plugins
            .iter()
            .find(|plugin| plugin.id == id)
            .ok_or_else(|| format!("\"{id}\" is not in the plugin list."))?;
        if let Some(entry) = blocking(&verified.blocked, id, &plugin.version) {
            return Err(format!("{} {} is blocked: {}", plugin.name, plugin.version, entry.reason));
        }
        runnable(plugin)?;
        let bytes = download(&plugin.url, plugin.size.min(crate::plugins::MAX_ARCHIVE))
            .map_err(|err| format!("The plugin download failed: {err}"))?;
        if bytes.len() as u64 != plugin.size {
            return Err("The downloaded plugin is not the size the plugin list gives.".into());
        }
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        if sha256 != plugin.sha256.to_ascii_lowercase() {
            return Err("The downloaded plugin does not match the plugin list's checksum.".into());
        }
        let source = Source::Registry { url: plugin.url.clone(), sha256 };
        store.install_archive(&bytes, source, |found| {
            let matches = found.id == plugin.id
                && found.version == plugin.version
                && found.runtime == plugin.runtime
                && found.api == plugin.api
                && found.permissions() == plugin.permissions;
            if matches {
                Ok(())
            } else {
                Err(format!(
                    "The downloaded plugin is not the \"{id}\" {} the plugin list describes.",
                    plugin.version
                ))
            }
        })
    }
}

/// Whether this Lattice can install and run `plugin` from the registry:
/// node plugins only (native ones stay URL installs, Captain plan L4), at an
/// API level this build speaks, on a platform with the sandbox.
fn runnable(plugin: &IndexPlugin) -> Result<(), String> {
    if plugin.runtime != Runtime::Node {
        return Err("The plugin list offers only node plugins.".into());
    }
    if plugin.api == 0 || plugin.api > API_LEVEL {
        return Err(format!(
            "{} needs plugin API level {}; this Lattice has {API_LEVEL}.",
            plugin.name, plugin.api
        ));
    }
    if !crate::plugins::AVAILABLE {
        return Err(crate::plugins::sandbox::MISSING.into());
    }
    if !manifest::valid_plugin_id(&plugin.id) {
        return Err("The plugin's id is not valid.".into());
    }
    Ok(())
}

/// What `asks` holds that `held` does not.
fn beyond(asks: &Permissions, held: &Permissions) -> Permissions {
    Permissions {
        project_read: asks
            .project_read
            .iter()
            .filter(|p| !held.project_read.contains(p))
            .cloned()
            .collect(),
        network_local: asks
            .network_local
            .iter()
            .filter(|p| !held.network_local.contains(p))
            .copied()
            .collect(),
        network: asks.network.iter().filter(|o| !held.network.contains(o)).cloned().collect(),
        secrets: asks.secrets.iter().filter(|s| !held.secrets.contains(s)).cloned().collect(),
    }
}

fn blocking<'a>(blocked: &'a [BlockedEntry], id: &str, version: &str) -> Option<&'a BlockedEntry> {
    blocked.iter().find(|entry| entry.id == id && verify::version_in(&entry.versions, version))
}

fn parse<T: DeserializeOwned>(file: &str, text: &str) -> Result<T, String> {
    serde_json::from_str(text)
        .map_err(|err| format!("The registry's {file} could not be read: {err}"))
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `url` over https (or http to this machine, for tests), at most `limit`
/// bytes.
fn download(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let parsed = url::Url::parse(url).map_err(|err| err.to_string())?;
    let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err(format!("{url} is not an https address."));
    }
    let client =
        crate::http::blocking_as(&format!("Lattice/{}", crate::VERSION), Duration::from_secs(30))
            .build()
            .map_err(|err| err.to_string())?;
    let response = client.get(parsed).send().map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    response.take(limit + 1).read_to_end(&mut bytes).map_err(|err| err.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("{url} is larger than expected."));
    }
    Ok(bytes)
}

fn write_atomically(root: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let failed = |err: std::io::Error| format!("Could not save the theme list: {err}");
    std::fs::create_dir_all(root).map_err(failed)?;
    let partial = root.join(format!(".{name}.partial"));
    std::fs::write(&partial, bytes).map_err(failed)?;
    std::fs::rename(&partial, root.join(name)).map_err(failed)
}
