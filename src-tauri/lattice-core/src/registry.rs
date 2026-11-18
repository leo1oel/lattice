//! The theme marketplace's client: the signed list of themes that
//! leo1oel/lattice-plugins publishes, kept in `<app data>/registry/`, and
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

use lattice_theme::{Appearance, ThemeFile, MAX_THEME_BYTES};
use minisign_verify::PublicKey;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::themes::{ThemeInfo, ThemeStore};

/// Where the registry's GitHub Pages site serves the signed files.
pub const BASE_URL: &str = "https://leo1oel.github.io/lattice-plugins";
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub format: u32,
    pub serial: u64,
    /// When the registry built it (ISO 8601), for display.
    pub generated: String,
    pub themes: Vec<IndexTheme>,
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
    /// When the shown list was fetched and verified (RFC 3339).
    pub fetched_at: Option<String>,
    pub status: Status,
    pub installed: Vec<InstalledTheme>,
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
    base_url: String,
    keys: Vec<PublicKey>,
}

impl Registry {
    /// The registry client caching under the app's data folder.
    pub fn new(app_data_dir: &Path) -> Self {
        let keys = verify::PUBLIC_KEYS
            .iter()
            .map(|key| PublicKey::from_base64(key).expect("the embedded registry keys parse"))
            .collect();
        Self::with(app_data_dir.join("registry"), BASE_URL, keys)
    }

    fn with(root: PathBuf, base_url: &str, keys: Vec<PublicKey>) -> Self {
        Registry { root, base_url: base_url.trim_end_matches('/').to_string(), keys }
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
        Listing {
            index: verified.as_ref().map(|verified| verified.index.clone()),
            blocked: verified.as_ref().map(|verified| verified.blocked.clone()).unwrap_or_default(),
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

    fn refresh(&self) -> Result<Verified, Status> {
        let offline = |message| Status::Offline { message };
        let get = |file: &str, limit| self.get(&format!("{}/{file}", self.base_url), limit);
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
    /// version), with its update and block state.
    fn installed(&self, store: &ThemeStore, verified: &Verified) -> Vec<InstalledTheme> {
        self.records()
            .into_iter()
            .filter(|(id, record)| {
                store.get(id).is_some_and(|theme| theme.version == record.version)
            })
            .map(|(id, record)| InstalledTheme {
                update: verified
                    .index
                    .themes
                    .iter()
                    .find(|theme| theme.id == id && verify::newer(&theme.version, &record.version))
                    .map(|theme| theme.version.clone()),
                blocked: blocking(&verified.blocked, &id, &record.version).cloned(),
                id,
                version: record.version,
            })
            .collect()
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
