//! Downloading a dictionary into the app's data folder, and finding one
//! there.
//!
//! Each dictionary lives in `<store>/<code>@<revision>/`, so moving the
//! pinned revision fetches fresh files instead of trusting old ones. Every
//! file is checked against the SHA-256 the catalog pins before anything is
//! written, and the folder appears only once all of them are in place (a
//! sibling `.partial` folder renamed at the end), so a failed or interrupted
//! download leaves no dictionary that looks installed.

use super::catalog::{Entry, CATALOG};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// The biggest file the catalog lists is under 20 MiB.
const MAX_BYTES: usize = 64 * 1024 * 1024;

/// Where the bytes of a URL come from: the network, or a test's table.
pub trait Fetch {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, String>;
}

pub struct HttpFetch;

impl Fetch for HttpFetch {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        let client = crate::http::blocking(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .get(url)
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|error| error.to_string())?;
        let bytes = response.bytes().map_err(|error| error.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Err(format!("{url} is larger than any dictionary"));
        }
        Ok(bytes.to_vec())
    }
}

pub fn dictionary_dir(store: &Path, entry: &Entry) -> PathBuf {
    store.join(format!("{}@{}", entry.code, &CATALOG.revision[..12]))
}

pub fn is_installed(store: &Path, entry: &Entry) -> bool {
    let dir = dictionary_dir(store, entry);
    entry.sha256.keys().all(|file| dir.join(file).is_file())
}

/// One download at a time: a second request for the same language waits and
/// then finds it installed.
static INSTALLING: Mutex<()> = Mutex::new(());

/// Fetch, verify and store `entry`'s files. Nothing is written unless every
/// file matches its pinned hash.
pub fn install(store: &Path, entry: &Entry, fetch: &dyn Fetch) -> Result<(), String> {
    let _guard = INSTALLING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if is_installed(store, entry) {
        return Ok(());
    }
    let mut files = Vec::new();
    for (file, expected) in &entry.sha256 {
        let url = CATALOG.url(entry, file);
        let bytes = fetch.fetch(&url)?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != *expected {
            return Err(format!("{url} does not match its pinned SHA-256 ({actual})"));
        }
        files.push((file, bytes));
    }
    let dir = dictionary_dir(store, entry);
    let partial = dir.with_extension("partial");
    let _ = fs::remove_dir_all(&partial);
    fs::create_dir_all(&partial).map_err(|error| error.to_string())?;
    for (file, bytes) in files {
        fs::write(partial.join(file), bytes).map_err(|error| error.to_string())?;
    }
    let _ = fs::remove_dir_all(&dir);
    fs::rename(&partial, &dir).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    /// Serves fixed bytes by URL and records what was asked for.
    struct Table {
        files: BTreeMap<String, Vec<u8>>,
        asked: RefCell<Vec<String>>,
    }

    impl Fetch for Table {
        fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
            self.asked.borrow_mut().push(url.to_string());
            self.files.get(url).cloned().ok_or_else(|| format!("offline: {url}"))
        }
    }

    fn fixture_entry(files: &[(&str, &[u8])]) -> Entry {
        Entry {
            code: "xx".into(),
            folder: "xx".into(),
            license: "MIT".into(),
            size_kib: 1,
            sha256: files
                .iter()
                .map(|(file, bytes)| (file.to_string(), format!("{:x}", Sha256::digest(bytes))))
                .collect(),
        }
    }

    fn table(entry: &Entry, files: &[(&str, &[u8])]) -> Table {
        Table {
            files: files
                .iter()
                .map(|(file, bytes)| (CATALOG.url(entry, file), bytes.to_vec()))
                .collect(),
            asked: RefCell::new(Vec::new()),
        }
    }

    const FILES: &[(&str, &[u8])] =
        &[("index.aff", b"SET UTF-8\n"), ("index.dic", b"1\nbonjour\n"), ("license", b"MIT\n")];

    #[test]
    fn verified_files_are_stored_once() {
        let store = TempDir::new("spelling-install");
        let entry = fixture_entry(FILES);
        let fetch = table(&entry, FILES);
        assert!(!is_installed(&store, &entry));
        install(&store, &entry, &fetch).unwrap();
        assert!(is_installed(&store, &entry));
        let dic = fs::read_to_string(dictionary_dir(&store, &entry).join("index.dic")).unwrap();
        assert_eq!(dic, "1\nbonjour\n");
        assert_eq!(fetch.asked.borrow().len(), 3);
        // Installed already: nothing is fetched again.
        install(&store, &entry, &fetch).unwrap();
        assert_eq!(fetch.asked.borrow().len(), 3);
    }

    #[test]
    fn a_tampered_or_missing_file_installs_nothing() {
        let store = TempDir::new("spelling-install");
        let entry = fixture_entry(FILES);
        let tampered: &[(&str, &[u8])] =
            &[("index.aff", b"SET UTF-8\n"), ("index.dic", b"1\nbonjuor\n"), ("license", b"MIT\n")];
        let error = install(&store, &entry, &table(&entry, tampered)).unwrap_err();
        assert!(error.contains("does not match its pinned SHA-256"), "{error}");
        assert!(!is_installed(&store, &entry));
        assert!(!dictionary_dir(&store, &entry).exists());

        let offline = Table { files: BTreeMap::new(), asked: RefCell::new(Vec::new()) };
        let error = install(&store, &entry, &offline).unwrap_err();
        assert!(error.starts_with("offline:"), "{error}");
        assert!(!is_installed(&store, &entry));
    }
}
