//! The spelling dictionaries Lattice can download, pinned in
//! `dictionaries.json`: one revision of wooorm/dictionaries (Hunspell
//! dictionaries from LibreOffice and other projects, normalized to UTF-8)
//! and the SHA-256 of every file taken from it. None ships in the app; a
//! language's dictionary is fetched the first time a document needs it.
//!
//! To add a language or move the revision, fetch `index.aff`, `index.dic`
//! and `license` from `dictionaries/<folder>/` at the new revision, record
//! their hashes and the `license` field of that folder's `package.json`, and
//! check the dictionary loads in spellbook: some (Danish, Galician, Latin
//! and Turkish at this revision) use affix syntax it does not parse.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::LazyLock;

#[derive(Debug, Deserialize)]
pub struct Catalog {
    pub repository: String,
    pub revision: String,
    pub dictionaries: Vec<Entry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The BCP 47 tag the frontend names the language by.
    pub code: String,
    /// The folder under `dictionaries/` in the repository.
    pub folder: String,
    /// The dictionary's licence, an SPDX expression from its package.json.
    pub license: String,
    /// `index.aff` and `index.dic` together, for the download notice.
    pub size_kib: u32,
    /// Every file fetched, by name, and its SHA-256.
    pub sha256: BTreeMap<String, String>,
}

impl Catalog {
    pub fn url(&self, entry: &Entry, file: &str) -> String {
        let path = self.repository.trim_start_matches("https://github.com/");
        format!(
            "https://raw.githubusercontent.com/{path}/{}/dictionaries/{}/{file}",
            self.revision, entry.folder
        )
    }
}

pub static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("dictionaries.json")).expect("spelling/dictionaries.json")
});

pub fn entry(code: &str) -> Option<&'static Entry> {
    CATALOG.dictionaries.iter().find(|entry| entry.code == code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_dictionary_pins_its_three_files() {
        assert_eq!(CATALOG.revision.len(), 40, "pin a full commit, not a branch");
        for entry in &CATALOG.dictionaries {
            let files: Vec<&str> = entry.sha256.keys().map(String::as_str).collect();
            assert_eq!(files, ["index.aff", "index.dic", "license"], "{}", entry.code);
            for hash in entry.sha256.values() {
                assert!(hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
            }
            assert!(!entry.license.is_empty(), "{}", entry.code);
        }
        // Every language a document can be detected as has a dictionary.
        for (_, code) in super::super::language::LANGUAGE_NAMES {
            assert!(*code == "en" || entry(code).is_some(), "{code} has no dictionary");
        }
        let fr = entry("fr").unwrap();
        assert_eq!(
            CATALOG.url(fr, "index.aff"),
            "https://raw.githubusercontent.com/wooorm/dictionaries/8cfea406b505e4d7df52d5a19bce525df98c54ab/dictionaries/fr/index.aff"
        );
    }
}
