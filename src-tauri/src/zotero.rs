//! Reading the writer's Zotero library with no setup in Zotero: from a copy of
//! its database, so a collection comes into Papers without re-adding each
//! paper.
//!
//! Zotero's local API answers only once the writer turns on a setting (its
//! authorization prompt sits behind the same setting), and its connector
//! endpoints list collections but no items. The database itself is always
//! there: `zotero.sqlite` in the data directory, which Zotero holds under an
//! exclusive lock while it runs. Lattice copies the file and its write-ahead
//! log into a scratch directory and reads the copy, so this works whether or
//! not Zotero is open and never touches the live file. Only the personal
//! library is read.
//!
//! Each item becomes a BibTeX entry (`zotero/bibtex.rs`) under the key the
//! writer cites it by, and the import runs through the ordinary Add papers
//! path, which skips what Papers already holds. A PDF attachment is named to
//! the frontend by its Zotero key only; the path behind it stays here, so the
//! frontend never names a file on disk.

mod bibtex;
mod schema;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub use schema::{ZoteroCollection, ZoteroItem};

const NOT_FOUND: &str = "Lattice couldn't find a Zotero library on this Mac.";
const UNREADABLE: &str = "Lattice couldn't read the Zotero library: {}";

/// The Zotero library Lattice found, as the browser shows it: one read of one
/// snapshot, which the browser filters by folder itself.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroLibrary {
    /// The data directory, which holds zotero.sqlite and storage/.
    pub data_dir: String,
    pub collections: Vec<ZoteroCollection>,
    /// Every top-level regular item, as BibTeX under its citation key.
    pub items: Vec<ZoteroItem>,
}

/// The PDFs the last read named, by attachment key, so `attachment_path`
/// hands back only a file Lattice itself found in Zotero.
fn known_pdfs() -> &'static Mutex<HashMap<String, PathBuf>> {
    static PDFS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    PDFS.get_or_init(Default::default)
}

fn unreadable(error: impl std::fmt::Display) -> String {
    UNREADABLE.replace("{}", &error.to_string())
}

/// Zotero's application support folder, which holds profiles.ini.
fn support_dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support/Zotero"))
}

/// Zotero's data directory: `chosen` when the writer picked one, else the
/// one the default Zotero profile names (`extensions.zotero.dataDir`), else
/// `~/Zotero`; whichever holds a zotero.sqlite.
pub fn data_dir(chosen: Option<&str>) -> Result<PathBuf, String> {
    let candidates: Vec<PathBuf> = match chosen {
        Some(dir) => vec![PathBuf::from(dir)],
        None => {
            let home =
                PathBuf::from(std::env::var_os("HOME").ok_or_else(|| NOT_FOUND.to_string())?);
            support_dir()
                .and_then(|support| profile_data_dir(&support))
                .into_iter()
                .chain([home.join("Zotero")])
                .collect()
        }
    };
    candidates
        .into_iter()
        .find(|dir| dir.join("zotero.sqlite").is_file())
        .ok_or_else(|| NOT_FOUND.to_string())
}

/// The prefs.js of the default profile in `support` (Zotero's application
/// support folder): the one marked `Default=1`, else the first listed.
fn default_profile_prefs(support: &Path) -> Option<String> {
    let ini = fs::read_to_string(support.join("profiles.ini")).ok()?;
    let mut profiles: Vec<(bool, bool, String)> = Vec::new();
    for section in ini.split('[').filter(|section| section.starts_with("Profile")) {
        let value = |name: &str| {
            section
                .lines()
                .find_map(|line| line.trim().strip_prefix(name)?.strip_prefix('='))
                .map(str::trim)
        };
        let Some(path) = value("Path") else { continue };
        profiles.push((
            value("Default") == Some("1"),
            value("IsRelative") != Some("0"),
            path.to_string(),
        ));
    }
    profiles.sort_by_key(|(default, _, _)| !default);
    let (_, relative, path) = profiles.into_iter().next()?;
    let profile = if relative { support.join(path) } else { PathBuf::from(path) };
    fs::read_to_string(profile.join("prefs.js")).ok()
}

/// The value `prefs` sets for `name`, as written (a JSON literal).
fn pref(prefs: &str, name: &str) -> Option<String> {
    prefs.lines().find_map(|line| {
        let rest = line.trim().strip_prefix(&format!("user_pref(\"{name}\","))?;
        Some(rest.trim().trim_end_matches(';').trim_end_matches(')').trim().to_string())
    })
}

/// The data directory the default profile in `support` points at, when it
/// chose one.
fn profile_data_dir(support: &Path) -> Option<PathBuf> {
    let prefs = default_profile_prefs(support)?;
    if pref(&prefs, "extensions.zotero.useDataDir").as_deref() != Some("true") {
        return None;
    }
    serde_json::from_str::<String>(&pref(&prefs, "extensions.zotero.dataDir")?)
        .ok()
        .map(PathBuf::from)
}

/// The base directory the default profile in `support` resolves linked
/// `attachments:` files against.
fn attachment_base(support: &Path) -> Option<PathBuf> {
    let prefs = default_profile_prefs(support)?;
    serde_json::from_str::<String>(&pref(&prefs, "extensions.zotero.baseAttachmentPath")?)
        .ok()
        .map(PathBuf::from)
}

/// A private copy of one of the library's databases, removed when dropped.
struct Snapshot {
    dir: PathBuf,
    connection: Connection,
}

impl Snapshot {
    /// Copy `name` (and its write-ahead log, which holds what Zotero has not
    /// checkpointed yet) out of `data_dir` and open the copy.
    fn take(data_dir: &Path, name: &str) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!("lattice-zotero-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).map_err(unreadable)?;
        let copy = || -> Result<Connection, String> {
            fs::copy(data_dir.join(name), dir.join(name)).map_err(|error| error.to_string())?;
            let wal = format!("{name}-wal");
            let _ = fs::remove_file(dir.join(&wal));
            if data_dir.join(&wal).is_file() {
                fs::copy(data_dir.join(&wal), dir.join(&wal)).map_err(|error| error.to_string())?;
            }
            let connection = Connection::open_with_flags(
                dir.join(name),
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| error.to_string())?;
            connection
                .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())
                .and_then(|check| if check == "ok" { Ok(()) } else { Err(check) })?;
            Ok(connection)
        };
        // Zotero may write between copying the file and its log; a second copy
        // almost always lands between writes.
        match copy().or_else(|_| copy()) {
            Ok(connection) => Ok(Self { dir, connection }),
            Err(error) => {
                let _ = fs::remove_dir_all(&dir);
                Err(unreadable(error))
            }
        }
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// The library: its collections and its items, each item as BibTeX under its
/// citation key.
pub fn library(chosen: Option<&str>) -> Result<ZoteroLibrary, String> {
    let data_dir = data_dir(chosen)?;
    let snapshot = Snapshot::take(&data_dir, "zotero.sqlite")?;
    let collections = schema::collections(&snapshot.connection).map_err(unreadable)?;
    // Better BibTeX keeps its keys in a database of its own beside Zotero's.
    let better_bibtex = data_dir
        .join("better-bibtex.sqlite")
        .is_file()
        .then(|| Snapshot::take(&data_dir, "better-bibtex.sqlite").ok())
        .flatten();
    let read = schema::items(
        &snapshot.connection,
        better_bibtex.as_ref().map(|snapshot| &snapshot.connection),
        &data_dir,
        support_dir().and_then(|support| attachment_base(&support)).as_deref(),
    )
    .map_err(unreadable)?;
    let mut pdfs = known_pdfs().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let items = read
        .into_iter()
        .map(|(item, pdf)| {
            if let (Some(key), Some(path)) = (&item.pdf, pdf) {
                pdfs.insert(key.clone(), path);
            }
            item
        })
        .collect();
    Ok(ZoteroLibrary { data_dir: data_dir.to_string_lossy().into_owned(), collections, items })
}

/// Where the PDF attachment `key`, named by an earlier read, is on this Mac.
pub fn attachment_path(key: &str) -> Result<PathBuf, String> {
    known_pdfs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(key)
        .cloned()
        .ok_or_else(|| "Zotero has no file on this Mac for this attachment.".to_string())
}

#[cfg(test)]
mod tests;
