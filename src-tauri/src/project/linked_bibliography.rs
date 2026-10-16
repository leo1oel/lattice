//! A BibTeX file outside the project that the writer's reference manager
//! keeps (a Zotero or Paperpile export), linked to the project's
//! bibliography (`.research/cache/linked-bibliography.json`).
//!
//! The record keeps where the file is, which project `.bib` it updates, and
//! the file's text as it was when its changes were last taken in: the base
//! the renderer (`src/papers/linked-library.ts`) compares the file's current
//! text and the project's own `.bib` against, so a field the writer edited
//! here is never mistaken for one the library changed. What changes reach
//! the project `.bib` is the renderer's to decide, and goes through the
//! ordinary undoable file write; this side only reads the outside file and
//! keeps the record.
//!
//! The record names a file on this machine and copies a whole library, so it
//! lives in the git-ignored cache, which no export ships either.

use super::paths::safe_path;
use crate::project_fs::ProjectDir;
use crate::util::err;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const RECORD: &str = ".research/cache/linked-bibliography.json";
/// Far past any reference manager's export of a working library.
const MAX_BIB_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedBibliography {
    /// The outside file, as an absolute path.
    pub source: String,
    /// The project `.bib` it updates, relative to the project.
    pub target: String,
    /// When its changes were last taken in, in milliseconds since the epoch.
    pub updated_at: u64,
    /// The outside file's text as it was then.
    pub baseline: String,
}

/// Only an absolute path to a `.bib` file: the one thing this reads outside the project.
fn check_source(source: &str) -> Result<&Path, String> {
    let path = Path::new(source);
    if !path.is_absolute() {
        return Err("Choose the library's .bib file by its full path.".into());
    }
    if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("bib")) {
        return Err("A linked library must be a .bib file.".into());
    }
    Ok(path)
}

/// The linked library's text now. A reference manager rewrites its export
/// in place, so the file is read whole on every update.
pub fn read_bibliography_source(source: &str) -> Result<String, String> {
    let path = check_source(source)?;
    let metadata = fs::metadata(path).map_err(err)?;
    if !metadata.is_file() {
        return Err("The linked library is not a file.".into());
    }
    if metadata.len() > MAX_BIB_BYTES {
        return Err("The linked library is larger than 16 MB.".into());
    }
    let bytes = fs::read(path).map_err(err)?;
    String::from_utf8(bytes).map_err(|_| "The linked library is not UTF-8 text.".to_string())
}

/// The project's link, or none. A record a crash cut short or an edit by hand broke reads as no link.
pub fn read_linked_bibliography(root: &Path) -> Result<Option<LinkedBibliography>, String> {
    let Ok(raw) = fs::read_to_string(root.join(RECORD)) else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&raw).ok())
}

/// Link `source` to `target`, or record that its changes up to `baseline` were taken in.
pub fn save_linked_bibliography(
    root: &Path, source: &str, target: &str, baseline: String,
) -> Result<LinkedBibliography, String> {
    check_source(source)?;
    safe_path(root, target)?;
    if baseline.len() as u64 > MAX_BIB_BYTES {
        return Err("The linked library is larger than 16 MB.".into());
    }
    let updated_at = SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?.as_millis() as u64;
    let link = LinkedBibliography {
        source: source.to_string(),
        target: target.to_string(),
        updated_at,
        baseline,
    };
    let raw = serde_json::to_string_pretty(&link).map_err(err)?;
    ProjectDir::open(root)?.atomic_write(RECORD, format!("{raw}\n").as_bytes())?;
    Ok(link)
}

/// Forget the link. The project's `.bib` stays as it is, an ordinary file.
pub fn unlink_bibliography(root: &Path) -> Result<(), String> {
    if !root.join(RECORD).exists() {
        return Ok(());
    }
    ProjectDir::open(root)?.remove(RECORD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    #[test]
    fn keeps_the_link_and_its_base_and_forgets_it() {
        let fixture = Fixture::empty("linked-bib-round-trip");
        assert_eq!(read_linked_bibliography(&fixture.root).unwrap(), None);
        let library = fixture.path("library/My Library.bib");
        fixture.write("library/My Library.bib", "@article{a, year = {2024}}\n");
        let source = library.to_string_lossy().to_string();
        let text = read_bibliography_source(&source).unwrap();
        let saved =
            save_linked_bibliography(&fixture.root, &source, "references.bib", text.clone())
                .unwrap();
        assert!(saved.updated_at > 0);
        // Kept out of git with the rest of the cache: it names a path on this machine.
        assert!(fixture.path(".research/cache/linked-bibliography.json").is_file());
        assert_eq!(read_linked_bibliography(&fixture.root).unwrap(), Some(saved));
        unlink_bibliography(&fixture.root).unwrap();
        assert_eq!(read_linked_bibliography(&fixture.root).unwrap(), None);
        // Unlinking twice is no error.
        unlink_bibliography(&fixture.root).unwrap();
    }

    #[test]
    fn reads_only_bib_files_by_full_path() {
        let fixture = Fixture::empty("linked-bib-refused");
        fixture.write("notes.txt", "secret");
        fixture.write("folder.bib/x", "");
        fixture.write("latin1.bib", [0xe9u8]);
        for source in [
            "references.bib".to_string(),
            fixture.path("notes.txt").to_string_lossy().to_string(),
            fixture.path("folder.bib").to_string_lossy().to_string(),
            fixture.path("missing.bib").to_string_lossy().to_string(),
            fixture.path("latin1.bib").to_string_lossy().to_string(),
        ] {
            assert!(read_bibliography_source(&source).is_err(), "{source}");
        }
        fixture.write("Upper.BIB", "@misc{a}");
        assert_eq!(
            read_bibliography_source(&fixture.path("Upper.BIB").to_string_lossy()).unwrap(),
            "@misc{a}"
        );
    }

    #[test]
    fn refuses_a_target_outside_the_project_and_reads_a_broken_record_as_none() {
        let fixture = Fixture::empty("linked-bib-target");
        let source = fixture.path("lib.bib").to_string_lossy().to_string();
        assert!(
            save_linked_bibliography(&fixture.root, &source, "../x.bib", String::new()).is_err()
        );
        assert!(!fixture.path(RECORD).exists());
        fixture.write(RECORD, "{ \"source\": ");
        assert_eq!(read_linked_bibliography(&fixture.root).unwrap(), None);
    }
}
