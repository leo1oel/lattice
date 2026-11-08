//! Saving a copy of a project PDF, exactly the version the preview checked,
//! without its bytes passing through the webview.

use super::assets::{asset_mime_type, file_version, open_resolved, FILE_CHANGED};
use super::paths::{safe_path, NOT_FOUND};
use crate::util::err;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io;

use std::path::Path;

/// Save the project PDF `relative`, at the `version` [`read_asset`] reported,
/// to `destination` without its bytes passing through the webview.
pub fn save_asset_copy(
    root: &Path, relative: &str, version: &str, destination: &Path,
) -> Result<String, String> {
    copy_checked_version(root, relative, version, destination, |source, output| {
        io::copy(source, output)
    })
}

/// [`save_asset_copy`], with the byte copy itself as a seam for tests.
///
/// The copy is staged in a temporary file beside the destination and renamed
/// over it only once the source still has the checked version and every
/// checked byte arrived. A writer that rewrites or truncates the source
/// meanwhile (pdfTeX writes in place), or a failed write, therefore leaves
/// any existing export as it was instead of a mixed or partial PDF.
fn copy_checked_version(
    root: &Path, relative: &str, version: &str, destination: &Path,
    copy: impl FnOnce(&mut File, &mut File) -> io::Result<u64>,
) -> Result<String, String> {
    let path = safe_path(root, relative)?;
    if asset_mime_type(&path) != Some("application/pdf") {
        return Err("Only project PDFs are saved as copies.".to_string());
    }
    let destination = crate::export::destination(destination, &crate::export::PDF)?;
    let saved_to = Ok(destination.to_string_lossy().to_string());
    // Replace what a link points at, as writing through it did, not the link.
    let destination = match fs::canonicalize(&destination) {
        Ok(resolved) => resolved,
        Err(error) if error.kind() == io::ErrorKind::NotFound => destination,
        Err(error) => return Err(err(error)),
    };
    let mut file = match open_resolved(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(NOT_FOUND.into()),
        Err(error) => return Err(err(error)),
    };
    let checked = |file: &File| -> Result<Metadata, String> {
        let metadata = file.metadata().map_err(err)?;
        if !metadata.is_file() || file_version(file, &metadata).map_err(err)? != version {
            return Err(FILE_CHANGED.to_string());
        }
        Ok(metadata)
    };
    let metadata = checked(&file)?;
    let existing = match fs::metadata(&destination) {
        Ok(existing) => Some(existing),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(err(error)),
    };
    if let Some(existing) = &existing {
        // Saved over itself, it already holds this version.
        if crate::platform_fs::path_identity(&destination).map_err(err)?
            == crate::platform_fs::identity(&file).map_err(err)?
        {
            return saved_to;
        }
        if !existing.is_file() {
            return Err("Choose a file to save the PDF to.".to_string());
        }
    }

    let staged = StagedFile::create(&destination)?;
    let mut output = staged.file.try_clone().map_err(err)?;
    if let Some(existing) = &existing {
        output.set_permissions(existing.permissions()).map_err(err)?;
    }
    let copied = copy(&mut file, &mut output).map_err(err)?;
    if copied != metadata.len() {
        return Err(FILE_CHANGED.to_string());
    }
    checked(&file)?;
    output.sync_all().map_err(err)?;
    staged.commit(&destination)?;
    saved_to
}

/// A temporary file beside a destination, removed unless committed.
struct StagedFile {
    path: std::path::PathBuf,
    file: File,
    committed: bool,
}

impl StagedFile {
    fn create(destination: &Path) -> Result<Self, String> {
        let directory = destination.parent().unwrap_or_else(|| Path::new("."));
        let name =
            destination.file_name().map_or_else(Default::default, |name| name.to_string_lossy());
        let path = directory.join(format!(".{name}.{}.lattice-tmp", uuid::Uuid::new_v4().simple()));
        let file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(err)?;
        Ok(Self { path, file, committed: false })
    }

    /// Atomically replace `destination` with the staged bytes.
    fn commit(mut self, destination: &Path) -> Result<(), String> {
        fs::rename(&self.path, destination).map_err(err)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::assets::{read_asset, AssetContent, AssetPreview};
    use crate::project::test_support::Fixture;
    use std::io::Read;

    /// The length and version `read_asset` reports for the project PDF `relative`.
    fn ranges(root: &Path, relative: &str) -> (u64, String) {
        match read_asset(root, relative) {
            Ok(AssetPreview { content: AssetContent::Ranges { length, version }, .. }) => {
                (length, version)
            }
            other => panic!("{relative} should be read in ranges: {:?}", other.map(|_| ())),
        }
    }

    #[test]
    fn saves_a_copy_of_only_the_checked_version_of_a_project_pdf() {
        let fixture = Fixture::project("pdf-save");
        let root = &fixture.root;
        let saved = &fixture.parent;
        fixture.write("paper.pdf", b"%PDF-1.4 the checked version");
        fixture.write("notes.md", b"# not a PDF");
        let (_, version) = ranges(root, "paper.pdf");

        let destination =
            save_asset_copy(root, "paper.pdf", &version, &saved.join("copy")).unwrap();
        assert_eq!(destination, saved.join("copy.pdf").to_string_lossy());
        assert_eq!(fs::read(&destination).unwrap(), b"%PDF-1.4 the checked version");
        assert!(save_asset_copy(root, "paper.pdf", &version, &saved.join("copy.txt")).is_err());

        // Outside the project, through a link, or not a PDF.
        let outside = saved.join("outside.pdf");
        fs::write(&outside, b"%PDF-1.4 outside").unwrap();
        std::os::unix::fs::symlink(&outside, fixture.path("linked.pdf")).unwrap();
        for path in ["../outside.pdf", outside.to_str().unwrap(), "linked.pdf", "notes.md"] {
            assert!(
                save_asset_copy(root, path, &version, &saved.join("refused.pdf")).is_err(),
                "{path} must be refused"
            );
        }
        assert!(!saved.join("refused.pdf").exists());

        // Rewritten since it was checked: nothing is written.
        fixture.write("paper.pdf", b"%PDF-1.4 a later version, longer");
        let stale = save_asset_copy(root, "paper.pdf", &version, &saved.join("stale.pdf"));
        assert_eq!(stale.err().unwrap(), FILE_CHANGED);
        assert!(!saved.join("stale.pdf").exists());

        // Saved over itself, the file is left whole.
        let (_, current) = ranges(root, "paper.pdf");
        save_asset_copy(root, "paper.pdf", &current, &fixture.path("paper.pdf")).unwrap();
        assert_eq!(
            fs::read(fixture.path("paper.pdf")).unwrap(),
            b"%PDF-1.4 a later version, longer"
        );

        fs::remove_file(fixture.path("paper.pdf")).unwrap();
        let gone = save_asset_copy(root, "paper.pdf", &current, &saved.join("gone.pdf"));
        assert_eq!(gone.err().unwrap(), NOT_FOUND);
    }

    #[test]
    fn a_pdf_changed_or_a_copy_failed_midway_leaves_the_existing_export_whole() {
        use std::io::{Seek, Write};
        let fixture = Fixture::project("pdf-save-race");
        let root = &fixture.root;
        let exports = fixture.parent.join("exports");
        fs::create_dir_all(&exports).unwrap();
        let export = exports.join("paper.pdf");
        let source = fixture.path("paper.pdf");
        let original = b"%PDF-1.4 the checked version";
        let previous = b"%PDF-1.4 last week's export";
        let save = |copy: &dyn Fn(&mut File, &mut File) -> io::Result<u64>| {
            fixture.write("paper.pdf", original);
            fs::write(&export, previous).unwrap();
            let (_, version) = ranges(root, "paper.pdf");
            copy_checked_version(root, "paper.pdf", &version, &export, copy)
        };
        let exported = || {
            let mut names = fs::read_dir(&exports)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>();
            names.sort();
            (names, fs::read(&export).unwrap())
        };
        let untouched = (vec!["paper.pdf".to_string()], previous.to_vec());

        // Rewritten in place, as pdfTeX does, while the copy runs: the same
        // length, so only the version check after copying can tell. Linux
        // stamps mtime from a coarse clock (a scheduler tick), so a rewrite
        // within the same tick as the check would carry its version; a real
        // build comes long after the preview checked the file.
        let rewritten = save(&|source_file, output| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            fs::write(&source, b"%PDF-1.4 the changed version").unwrap();
            io::copy(source_file, output)
        });
        assert_eq!(rewritten.err().unwrap(), FILE_CHANGED);
        assert_eq!(exported(), untouched);

        // Truncated while the copy runs.
        let truncated = save(&|source_file, output| {
            OpenOptions::new().write(true).open(&source).unwrap().set_len(9).unwrap();
            io::copy(source_file, output)
        });
        assert_eq!(truncated.err().unwrap(), FILE_CHANGED);
        assert_eq!(exported(), untouched);

        // The disk fills up after part of the copy was written.
        let failed = save(&|source_file, output| {
            let mut head = [0; 8];
            source_file.read_exact(&mut head)?;
            output.write_all(&head)?;
            Err(io::Error::other("No space left on device"))
        });
        assert!(failed.err().unwrap().contains("No space left on device"));
        assert_eq!(exported(), untouched);

        // A copy of the checked version replaces the export.
        let replaced = save(&|source_file, output| {
            source_file.rewind()?;
            io::copy(source_file, output)
        });
        assert_eq!(replaced.unwrap(), export.to_string_lossy());
        assert_eq!(exported(), (vec!["paper.pdf".to_string()], original.to_vec()));
    }

    #[test]
    fn a_pdf_is_saved_only_to_a_regular_file() {
        let fixture = Fixture::project("pdf-save-target");
        let root = &fixture.root;
        fixture.write("paper.pdf", b"%PDF-1.4 the checked version");
        let (_, version) = ranges(root, "paper.pdf");

        let folder = fixture.parent.join("folder.pdf");
        fs::create_dir(&folder).unwrap();
        let fifo = fixture.parent.join("pipe.pdf");
        let fifo_path = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
        for target in [&folder, &fifo] {
            let refused = save_asset_copy(root, "paper.pdf", &version, target);
            assert_eq!(refused.err().unwrap(), "Choose a file to save the PDF to.", "{target:?}");
        }

        // Through a link, the file it points at is replaced and the link kept.
        let target = fixture.parent.join("target.pdf");
        fs::write(&target, b"%PDF-1.4 old").unwrap();
        let link = fixture.parent.join("link.pdf");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        save_asset_copy(root, "paper.pdf", &version, &link).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"%PDF-1.4 the checked version");
    }
}
