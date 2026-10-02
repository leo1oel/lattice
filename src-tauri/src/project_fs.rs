//! Race-free mutations beneath an already selected project root.
//!
//! On Unix every pathname lookup after opening the root is relative to a
//! directory descriptor and uses `O_NOFOLLOW`.  Holding those descriptors
//! makes replacing a pathname with a symlink harmless: the operation remains
//! attached to the directory that was opened.

use crate::util::err;
use rustix::fd::{AsFd, OwnedFd};
use rustix::fs::{self, AtFlags, FileType, Mode, OFlags};
use rustix::io::Errno;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Component, Path};
use uuid::Uuid;

const OUTSIDE: &str = "The requested path is outside the project.";
const SYMLINK_REFUSED: &str = "Symbolic links cannot be used for project file operations.";

fn components(relative: &str) -> Result<Vec<OsString>, String> {
    let path = Path::new(relative);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(OUTSIDE.to_string());
    }
    path.components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name.to_os_string()),
            _ => Err(OUTSIDE.to_string()),
        })
        .collect()
}

/// Open the directory `name` beneath `parent` without following links.
fn open_directory(parent: impl AsFd, name: impl rustix::path::Arg) -> Result<OwnedFd, Errno> {
    fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
}

/// Type of `name` beneath `parent`, never following a final symlink.
fn file_type_at(parent: impl AsFd, name: impl rustix::path::Arg) -> Result<FileType, Errno> {
    fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
        .map(|stat| FileType::from_raw_mode(stat.st_mode))
}

pub struct ProjectDir {
    root: OwnedFd,
}

impl ProjectDir {
    pub fn open(root: &Path) -> Result<Self, String> {
        let root = root.canonicalize().map_err(err)?;
        Ok(Self { root: open_directory(fs::CWD, &root).map_err(err)? })
    }

    /// The (descriptor of the) folder holding `relative`, and its final name.
    fn open_parent(&self, relative: &str, create: bool) -> Result<(OwnedFd, OsString), String> {
        let mut parts = components(relative)?;
        let name = parts.pop().ok_or_else(|| OUTSIDE.to_string())?;
        let mut directory = open_directory(&self.root, ".").map_err(err)?;
        for part in parts {
            directory = match open_directory(&directory, &part) {
                Ok(fd) => fd,
                Err(Errno::NOENT) if create => {
                    match fs::mkdirat(&directory, &part, Mode::from_bits_truncate(0o755)) {
                        Ok(()) | Err(Errno::EXIST) => {}
                        Err(error) => return Err(err(error)),
                    }
                    open_directory(&directory, &part).map_err(err)?
                }
                Err(error) => return Err(err(error)),
            };
        }
        Ok((directory, name))
    }

    pub fn atomic_write(&self, relative: &str, bytes: &[u8]) -> Result<(), String> {
        let (parent, name) = self.open_parent(relative, true)?;
        let existing = fs::statat(&parent, &name, AtFlags::SYMLINK_NOFOLLOW).ok();
        if existing.is_some_and(|stat| FileType::from_raw_mode(stat.st_mode) == FileType::Symlink) {
            return Err(SYMLINK_REFUSED.into());
        }
        let mut temporary = None;
        for _ in 0..16 {
            let candidate = OsString::from(format!(".lattice-{}.tmp", Uuid::new_v4()));
            match fs::openat(
                &parent,
                &candidate,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_bits_truncate(0o600),
            ) {
                Ok(fd) => {
                    if let Some(stat) = existing {
                        fs::fchmod(&fd, Mode::from_raw_mode(stat.st_mode)).map_err(err)?;
                    }
                    temporary = Some((candidate, fd));
                    break;
                }
                Err(Errno::EXIST) => continue,
                Err(error) => return Err(err(error)),
            }
        }
        let (temporary_name, fd) =
            temporary.ok_or_else(|| "Could not allocate a temporary project file.".to_string())?;
        let result = (|| {
            let mut file = std::fs::File::from(fd);
            file.write_all(bytes).map_err(err)?;
            file.sync_all().map_err(err)?;
            drop(file);
            // Recheck the destination immediately before the descriptor-relative rename.
            if matches!(file_type_at(&parent, &name), Ok(FileType::Symlink)) {
                return Err(SYMLINK_REFUSED.into());
            }
            fs::renameat(&parent, &temporary_name, &parent, &name).map_err(err)
        })();
        if result.is_err() {
            let _ = fs::unlinkat(&parent, &temporary_name, AtFlags::empty());
        }
        result
    }

    pub fn rename(&self, source: &str, destination: &str) -> Result<(), String> {
        let (source_parent, source_name) = self.open_parent(source, false)?;
        let (destination_parent, destination_name) = self.open_parent(destination, false)?;
        if file_type_at(&source_parent, &source_name).map_err(err)? == FileType::Symlink {
            return Err("Symbolic links cannot be moved or renamed.".into());
        }
        match file_type_at(&destination_parent, &destination_name) {
            Ok(_) => return Err("A file or folder already exists with that name.".into()),
            Err(Errno::NOENT) => {}
            Err(error) => return Err(err(error)),
        }
        fs::renameat(&source_parent, &source_name, &destination_parent, &destination_name)
            .map_err(err)
    }

    pub fn remove(&self, relative: &str) -> Result<(), String> {
        let (parent, name) = self.open_parent(relative, false)?;
        remove_entry(&parent, &name)
    }

    pub fn prune_json_files(&self, relative: &str, limit: usize) -> Result<(), String> {
        let (directory, _) = self.open_parent(&format!("{relative}/entry"), false)?;
        let mut names = fs::Dir::read_from(open_directory(&directory, ".").map_err(err)?)
            .map_err(err)?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_bytes().ends_with(b".json"))
            .map(|entry| entry.file_name().to_owned())
            .collect::<Vec<_>>();
        names.sort();
        let remove_count = names.len().saturating_sub(limit);
        for name in names.into_iter().take(remove_count) {
            fs::unlinkat(&directory, name, AtFlags::empty()).map_err(err)?;
        }
        Ok(())
    }
}

/// Unlink `name` beneath `parent`; a real directory is emptied first, a
/// symlink is removed itself and never followed.
fn remove_entry(parent: &OwnedFd, name: impl rustix::path::Arg + Copy) -> Result<(), String> {
    if file_type_at(parent, name).map_err(err)? != FileType::Directory {
        return fs::unlinkat(parent, name, AtFlags::empty()).map_err(err);
    }
    let directory = open_directory(parent, name).map_err(err)?;
    for entry in fs::Dir::read_from(open_directory(&directory, ".").map_err(err)?).map_err(err)? {
        let entry = entry.map_err(err)?;
        if !matches!(entry.file_name().to_bytes(), b"." | b"..") {
            remove_entry(&directory, entry.file_name())?;
        }
    }
    fs::unlinkat(parent, name, AtFlags::REMOVEDIR).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;
    use std::fs;

    #[test]
    fn validates_paths_replaces_files_atomically_and_prunes_old_json() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::empty("capability-basic");
        let outside = Fixture::empty("capability-basic-outside");
        let project = ProjectDir::open(&fixture.root).unwrap();
        assert!(project.atomic_write("../escape", b"bad").is_err());
        assert!(project.atomic_write("/escape", b"bad").is_err());
        project.atomic_write("nested/file.txt", b"first").unwrap();
        project.atomic_write("nested/file.txt", b"second").unwrap();
        assert_eq!(fixture.read("nested/file.txt"), "second");

        symlink(outside.path("missing"), fixture.path("final-link")).unwrap();
        assert!(project.atomic_write("final-link", b"bad").is_err());
        symlink(&outside.root, fixture.path("directory-link")).unwrap();
        assert!(project.atomic_write("directory-link/file", b"bad").is_err());
        assert!(!outside.path("file").exists());
        assert!(!outside.path("missing").exists());

        // Pruning keeps the newest (last-sorting) JSON files and anything else.
        for index in 0..5 {
            fixture.write(&format!("history/{index:02}.json"), "{}\n");
        }
        fixture.write("history/notes.txt", "kept");
        project.prune_json_files("history", 3).unwrap();
        let mut names = fs::read_dir(fixture.path("history"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, ["02.json", "03.json", "04.json", "notes.txt"]);
    }

    #[test]
    fn raced_parent_swaps_never_mutate_outside() {
        use std::os::unix::fs::symlink;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let fixture = Fixture::empty("capability-race");
        let outside = Fixture::empty("capability-race-outside");
        outside.write("sentinel", b"safe");
        fs::create_dir(fixture.path("parent")).unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let swapper = {
            let running = Arc::clone(&running);
            let (parent, held, outside) =
                (fixture.path("parent"), fixture.path("held"), outside.root.clone());
            std::thread::spawn(move || {
                while running.load(Ordering::Relaxed) {
                    if fs::rename(&parent, &held).is_ok() {
                        if symlink(&outside, &parent).is_ok() {
                            std::thread::yield_now();
                            let _ = fs::remove_file(&parent);
                        }
                        let _ = fs::rename(&held, &parent);
                    }
                }
            })
        };

        for index in 0..500 {
            if let Ok(project) = ProjectDir::open(&fixture.root) {
                let _ = project.atomic_write("parent/sentinel", b"changed");
                let source = format!("parent/source-{index}");
                let destination = format!("parent/destination-{index}");
                let _ = project.atomic_write(&source, b"source");
                let _ = project.rename(&source, &destination);
                let _ = project.remove(&destination);
            }
        }
        running.store(false, Ordering::Relaxed);
        swapper.join().unwrap();
        assert_eq!(outside.read("sentinel"), "safe");
        assert_eq!(fs::read_dir(&outside.root).unwrap().count(), 1);
        let _ = fs::remove_file(fixture.path("parent"));
        let _ = fs::rename(fixture.path("held"), fixture.path("parent"));
    }
}
