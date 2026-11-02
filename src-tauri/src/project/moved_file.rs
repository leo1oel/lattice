//! Where an open file went when it left its path behind the editor's back.
//!
//! A shell `mv` or `git mv` renames the file, so it keeps its identity (see
//! [`tree::file_identity`](super::tree)) at the new path. Lattice's own saves
//! replace the file atomically, so for a moment after one the editor may still
//! hold the identity of the version before it: the one file holding exactly
//! the saved text stands in for it then. A branch switch or an `rm` leaves
//! neither, and the editor treats the file as deleted.

use super::tree::{file_identity, project_tree_path_visible};
use crate::util::err;
use std::fs;
use std::path::Path;

/// The project path, among the files the Project pane shows, of the file
/// whose identity is `file_id`, else of the only file whose text is `text`;
/// `None` when neither is left. Empty text identifies nothing.
pub fn find_moved_file(
    root: &Path, file_id: &str, text: Option<&str>,
) -> Result<Option<String>, String> {
    let text = text.filter(|text| !text.is_empty());
    let mut search = Search { root, file_id, text, same_text: Vec::new() };
    if let Some(found) = search.walk(root)? {
        return Ok(Some(found));
    }
    Ok(match search.same_text.as_slice() {
        [only] => Some(only.clone()),
        _ => None,
    })
}

struct Search<'a> {
    root: &'a Path,
    file_id: &'a str,
    text: Option<&'a str>,
    /// Every file holding exactly `text`; a copy makes the match ambiguous.
    same_text: Vec<String>,
}

impl Search<'_> {
    /// The file with the identity, collecting the files with the text on the way.
    fn walk(&mut self, directory: &Path) -> Result<Option<String>, String> {
        for entry in fs::read_dir(directory).map_err(err)? {
            let path = entry.map_err(err)?.path();
            let Ok(relative) = path.strip_prefix(self.root) else { continue };
            if !project_tree_path_visible(self.root, relative) {
                continue;
            }
            // A directory may vanish under the walk, as the move that sent us
            // looking is often one of several.
            let Ok(metadata) = fs::symlink_metadata(&path) else { continue };
            if metadata.is_dir() {
                if let Some(found) = self.walk(&path)? {
                    return Ok(Some(found));
                }
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let relative = relative.to_string_lossy().replace('\\', "/");
            if !self.file_id.is_empty() && file_identity(&metadata) == self.file_id {
                return Ok(Some(relative));
            }
            // Only a file of the same length is read.
            let same_text = self.text.is_some_and(|text| {
                metadata.len() == text.len() as u64
                    && fs::read(&path).is_ok_and(|bytes| bytes == text.as_bytes())
            });
            if same_text {
                self.same_text.push(relative);
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::stat_file;
    use crate::project::test_support::Fixture;

    #[test]
    fn follows_a_renamed_file_and_finds_nothing_for_a_deleted_one() {
        let fixture = Fixture::empty("moved-file");
        fs::write(fixture.path("chapter.tex"), "Chapter").unwrap();
        fs::write(fixture.path("other.tex"), "Chapter").unwrap();
        let identity = stat_file(&fixture.root, "chapter.tex").unwrap().file_id;

        fs::create_dir_all(fixture.path("sections")).unwrap();
        fs::rename(fixture.path("chapter.tex"), fixture.path("sections/chapter.tex")).unwrap();
        // The identity wins over another file with the same text.
        assert_eq!(
            find_moved_file(&fixture.root, &identity, Some("Chapter")).unwrap().as_deref(),
            Some("sections/chapter.tex")
        );

        // Deleted: nothing has the identity, and two files share the text.
        fs::write(fixture.path("sections/copy.tex"), "Chapter").unwrap();
        fs::remove_file(fixture.path("sections/chapter.tex")).unwrap();
        assert_eq!(find_moved_file(&fixture.root, &identity, Some("Chapter")).unwrap(), None);
        assert_eq!(find_moved_file(&fixture.root, &identity, None).unwrap(), None);
    }

    #[test]
    fn falls_back_to_the_one_file_holding_the_saved_text() {
        let fixture = Fixture::empty("moved-file-text");
        fs::create_dir_all(fixture.path("sections")).unwrap();
        fs::write(fixture.path("sections/intro.tex"), "Saved intro").unwrap();
        fs::write(fixture.path("main.tex"), "Saved intro, longer").unwrap();
        // The identity of a version an atomic save already replaced.
        assert_eq!(
            find_moved_file(&fixture.root, "0:0", Some("Saved intro")).unwrap().as_deref(),
            Some("sections/intro.tex")
        );
        assert_eq!(find_moved_file(&fixture.root, "", Some("Nowhere")).unwrap(), None);
        fs::write(fixture.path("empty.tex"), "").unwrap();
        assert_eq!(find_moved_file(&fixture.root, "", Some("")).unwrap(), None);
    }

    #[test]
    fn a_restored_older_version_reads_as_a_different_version() {
        let fixture = Fixture::empty("older-version");
        fs::write(fixture.path("main.tex"), "Newer text").unwrap();
        let newer = stat_file(&fixture.root, "main.tex").unwrap();
        // `mv main.tex.bak main.tex`: another file, an older mtime.
        fs::write(fixture.path("main.tex.bak"), "Backup").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(fixture.path("main.tex.bak"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        fs::rename(fixture.path("main.tex.bak"), fixture.path("main.tex")).unwrap();
        let restored = stat_file(&fixture.root, "main.tex").unwrap();
        assert!(restored.mtime_ms < newer.mtime_ms);
        assert_ne!(restored.file_id, newer.file_id);
        assert_ne!(restored.size, newer.size);
    }
}
