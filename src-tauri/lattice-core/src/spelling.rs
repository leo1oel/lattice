//! Spell checking for documents written in a language other than English.
//!
//! Harper (`harper.rs`) checks English spelling and grammar. A LaTeX
//! document whose babel or polyglossia main language is another one
//! (`language.rs`) is checked for spelling only, against that language's
//! Hunspell dictionary (`checker.rs`), and Harper does not run on it. The
//! dictionaries are not bundled: each is downloaded the first time a document
//! needs it, from the revision `catalog.rs` pins, and verified before it is
//! stored in the app's data folder (`install.rs`).

mod catalog;
mod checker;
mod install;
mod language;

use crate::harper::HarperLintOut;
use language::DocumentLanguage;
use serde::Serialize;
use std::fs;
use std::path::Path;

pub use install::HttpFetch;

/// A document's language when it is not English, as the editor needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellingLanguage {
    /// The BCP 47 tag of a language with a dictionary ("fr", "de-CH"), or
    /// the option as the document wrote it ("finnish") when it has none.
    pub code: String,
    pub dictionary: DictionaryState,
    /// The dictionary's licence (SPDX), shown before it is downloaded.
    pub license: Option<String>,
    pub size_kib: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DictionaryState {
    Installed,
    /// Downloadable, not downloaded yet.
    Missing,
    /// No dictionary for this language: its spelling is not checked.
    Unavailable,
}

/// One downloadable dictionary, for Settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryInfo {
    pub code: String,
    pub license: String,
    pub installed: bool,
}

/// The language `open_path` is written in, or `None` for English (and for a
/// document that declares none), which Harper checks.
pub fn document_language(store: &Path, root: &Path, open_path: &str) -> Option<SpellingLanguage> {
    let document = language::compile_root_for(root, open_path);
    match language::document_language(root, &document) {
        DocumentLanguage::English => None,
        DocumentLanguage::Known(code) => {
            let entry = catalog::entry(code)?;
            Some(SpellingLanguage {
                code: code.to_string(),
                dictionary: if install::is_installed(store, entry) {
                    DictionaryState::Installed
                } else {
                    DictionaryState::Missing
                },
                license: Some(entry.license.clone()),
                size_kib: Some(entry.size_kib),
            })
        }
        DocumentLanguage::Unknown(name) => Some(SpellingLanguage {
            code: name,
            dictionary: DictionaryState::Unavailable,
            license: None,
            size_kib: None,
        }),
    }
}

pub fn install_dictionary(
    store: &Path, code: &str, fetch: &dyn install::Fetch,
) -> Result<(), String> {
    let entry = catalog::entry(code).ok_or_else(|| format!("No spelling dictionary for {code}"))?;
    install::install(store, entry, fetch)
}

pub fn dictionaries(store: &Path) -> Vec<DictionaryInfo> {
    catalog::CATALOG
        .dictionaries
        .iter()
        .map(|entry| DictionaryInfo {
            code: entry.code.clone(),
            license: entry.license.clone(),
            installed: install::is_installed(store, entry),
        })
        .collect()
}

/// Spelling lints for `text` in the language `code`, whose dictionary must
/// be installed.
pub fn lint(
    store: &Path, code: &str, text: &str, project_words: &[String],
) -> Result<Vec<HarperLintOut>, String> {
    let entry = catalog::entry(code).ok_or_else(|| format!("No spelling dictionary for {code}"))?;
    checker::lint(
        code,
        || {
            let dir = install::dictionary_dir(store, entry);
            let read =
                |file: &str| fs::read_to_string(dir.join(file)).map_err(|error| error.to_string());
            Ok((read("index.aff")?, read("index.dic")?))
        },
        text,
        project_words,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn a_french_document_asks_for_its_dictionary_and_an_english_one_for_harper() {
        let store = TempDir::new("spelling-store");
        let project = TempDir::new("spelling-project");
        project.write("fr.tex", "\\documentclass{article}\n\\usepackage[french]{babel}\n");
        project.write("en.tex", "\\documentclass{article}\n\\usepackage[english]{babel}\n");
        project.write("fi.tex", "\\documentclass{article}\n\\usepackage[finnish]{babel}\n");
        let french = document_language(&store, &project, "fr.tex").unwrap();
        assert_eq!(french.code, "fr");
        assert_eq!(french.dictionary, DictionaryState::Missing);
        assert_eq!(french.license.as_deref(), Some("MPL-2.0"));
        assert_eq!(document_language(&store, &project, "en.tex"), None);
        let finnish = document_language(&store, &project, "fi.tex").unwrap();
        assert_eq!(
            (finnish.code.as_str(), finnish.dictionary),
            ("finnish", DictionaryState::Unavailable)
        );
        assert!(lint(&store, "fr", "bonjour", &[]).is_err());
        assert!(dictionaries(&store).iter().all(|dictionary| !dictionary.installed));
    }

    /// Downloads the real French and German dictionaries, so it needs the
    /// network: `cargo test --lib spelling -- --ignored`.
    #[test]
    #[ignore = "downloads dictionaries"]
    fn french_and_german_download_verify_and_check() {
        let store = TempDir::new("spelling-download");
        let cases = [
            ("fr", "L'apprentissage automatique des réseaux neuronaux, c'est-à-dire aujourd’hui, est une méthdoe.", "méthdoe"),
            ("de", "Die Forschungsergebnisse der Rechtschreibprüfung zeigen, dass neuronale Netzwerke z.B. gut lernen, aber Fehlr machen.", "Fehlr"),
        ];
        for (code, text, misspelled) in cases {
            install_dictionary(&store, code, &HttpFetch).unwrap();
            let units: Vec<u16> = text.encode_utf16().collect();
            let flagged: Vec<String> = lint(&store, code, text, &[])
                .unwrap()
                .into_iter()
                .map(|lint| {
                    String::from_utf16_lossy(&units[lint.start as usize..lint.end as usize])
                })
                .collect();
            assert_eq!(flagged, [misspelled], "{code}");
        }
    }
}
