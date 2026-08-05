//! Race-free mutations beneath an already selected project root.
//!
//! On Unix every pathname lookup after opening the root is relative to a
//! directory descriptor and uses `O_NOFOLLOW`.  Holding those descriptors
//! makes replacing a pathname with a symlink harmless: the operation remains
//! attached to the directory that was opened.

use std::path::{Component, Path};

#[cfg(unix)]
mod platform {
    use super::*;
    use rustix::fd::OwnedFd;
    use rustix::fs::{self, AtFlags, Mode, OFlags};
    use std::ffi::OsString;
    use std::io::Write;
    use uuid::Uuid;

    fn error(error: impl std::fmt::Display) -> String {
        error.to_string()
    }

    fn components(relative: &str) -> Result<Vec<OsString>, String> {
        let path = Path::new(relative);
        if path.as_os_str().is_empty() || path.is_absolute() {
            return Err("The requested path is outside the project.".to_string());
        }
        path.components()
            .map(|component| match component {
                Component::Normal(name) => Ok(name.to_os_string()),
                _ => Err("The requested path is outside the project.".to_string()),
            })
            .collect()
    }

    pub struct ProjectDir {
        root: OwnedFd,
    }

    impl ProjectDir {
        pub fn open(root: &Path) -> Result<Self, String> {
            let root = root.canonicalize().map_err(error)?;
            let fd = fs::open(
                &root,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(error)?;
            Ok(Self { root: fd })
        }

        fn open_parent(&self, relative: &str, create: bool) -> Result<(OwnedFd, OsString), String> {
            let mut parts = components(relative)?;
            let name = parts
                .pop()
                .ok_or_else(|| "The requested path is outside the project.".to_string())?;
            let mut directory = fs::openat(
                &self.root,
                ".",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(error)?;
            for part in parts {
                let opened = fs::openat(
                    &directory,
                    &part,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                );
                directory = match opened {
                    Ok(fd) => fd,
                    Err(rustix::io::Errno::NOENT) if create => {
                        match fs::mkdirat(&directory, &part, Mode::from_bits_truncate(0o755)) {
                            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                            Err(error_value) => return Err(error(error_value)),
                        }
                        fs::openat(
                            &directory,
                            &part,
                            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                            Mode::empty(),
                        )
                        .map_err(error)?
                    }
                    Err(error_value) => return Err(error(error_value)),
                };
            }
            Ok((directory, name))
        }

        pub fn atomic_write(&self, relative: &str, bytes: &[u8]) -> Result<(), String> {
            let (parent, name) = self.open_parent(relative, true)?;
            let existing = fs::statat(&parent, &name, AtFlags::SYMLINK_NOFOLLOW).ok();
            if let Some(stat) = existing {
                if rustix::fs::FileType::from_raw_mode(stat.st_mode)
                    == rustix::fs::FileType::Symlink
                {
                    return Err("Symbolic links cannot be used for project file operations.".into());
                }
            }
            let mut temporary = None;
            for _ in 0..16 {
                let candidate = OsString::from(format!(".lattice-{}.tmp", Uuid::new_v4()));
                match fs::openat(
                    &parent,
                    &candidate,
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::NOFOLLOW
                        | OFlags::CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                ) {
                    Ok(fd) => {
                        if let Some(stat) = existing {
                            fs::fchmod(&fd, Mode::from_raw_mode(stat.st_mode)).map_err(error)?;
                        }
                        temporary = Some((candidate, fd));
                        break;
                    }
                    Err(rustix::io::Errno::EXIST) => continue,
                    Err(error_value) => return Err(error(error_value)),
                }
            }
            let (temporary_name, fd) = temporary
                .ok_or_else(|| "Could not allocate a temporary project file.".to_string())?;
            let result = (|| {
                let mut file = std::fs::File::from(fd);
                file.write_all(bytes).map_err(error)?;
                file.sync_all().map_err(error)?;
                drop(file);
                // Recheck the destination immediately before the descriptor-relative rename.
                if let Ok(stat) = fs::statat(&parent, &name, AtFlags::SYMLINK_NOFOLLOW) {
                    if rustix::fs::FileType::from_raw_mode(stat.st_mode)
                        == rustix::fs::FileType::Symlink
                    {
                        return Err(
                            "Symbolic links cannot be used for project file operations.".into()
                        );
                    }
                }
                fs::renameat(&parent, &temporary_name, &parent, &name).map_err(error)
            })();
            if result.is_err() {
                let _ = fs::unlinkat(&parent, &temporary_name, AtFlags::empty());
            }
            result
        }

        pub fn rename(&self, source: &str, destination: &str) -> Result<(), String> {
            let (source_parent, source_name) = self.open_parent(source, false)?;
            let (destination_parent, destination_name) = self.open_parent(destination, false)?;
            let source_stat = fs::statat(&source_parent, &source_name, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(error)?;
            if rustix::fs::FileType::from_raw_mode(source_stat.st_mode)
                == rustix::fs::FileType::Symlink
            {
                return Err("Symbolic links cannot be moved or renamed.".into());
            }
            match fs::statat(
                &destination_parent,
                &destination_name,
                AtFlags::SYMLINK_NOFOLLOW,
            ) {
                Ok(_) => return Err("A file or folder already exists with that name.".into()),
                Err(rustix::io::Errno::NOENT) => {}
                Err(error_value) => return Err(error(error_value)),
            }
            fs::renameat(
                &source_parent,
                &source_name,
                &destination_parent,
                &destination_name,
            )
            .map_err(error)
        }

        pub fn remove(&self, relative: &str) -> Result<(), String> {
            let (parent, name) = self.open_parent(relative, false)?;
            let stat = fs::statat(&parent, &name, AtFlags::SYMLINK_NOFOLLOW).map_err(error)?;
            if rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::Symlink {
                return fs::unlinkat(&parent, &name, AtFlags::empty()).map_err(error);
            }
            if rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::Directory
            {
                let directory = fs::openat(
                    &parent,
                    &name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(error)?;
                remove_children(&directory)?;
                fs::unlinkat(&parent, &name, AtFlags::REMOVEDIR).map_err(error)
            } else {
                fs::unlinkat(&parent, &name, AtFlags::empty()).map_err(error)
            }
        }

        pub fn prune_json_files(&self, relative: &str, limit: usize) -> Result<(), String> {
            let (directory, _) = self.open_parent(&format!("{relative}/entry"), false)?;
            let iterator_fd = fs::openat(
                &directory,
                ".",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(error)?;
            let mut names = fs::Dir::read_from(iterator_fd)
                .map_err(error)?
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let bytes = entry.file_name().to_bytes();
                    bytes
                        .ends_with(b".json")
                        .then(|| entry.file_name().to_owned())
                })
                .collect::<Vec<_>>();
            names.sort();
            let remove_count = names.len().saturating_sub(limit);
            for name in names.into_iter().take(remove_count) {
                fs::unlinkat(&directory, name, AtFlags::empty()).map_err(error)?;
            }
            Ok(())
        }
    }

    fn remove_children(directory: &OwnedFd) -> Result<(), String> {
        let iterator_fd = fs::openat(
            directory,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(error)?;
        let entries = fs::Dir::read_from(iterator_fd).map_err(error)?;
        for entry in entries {
            let entry = entry.map_err(error)?;
            let name = entry.file_name();
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let stat = fs::statat(directory, name, AtFlags::SYMLINK_NOFOLLOW).map_err(error)?;
            if rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::Directory
            {
                let child = fs::openat(
                    directory,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(error)?;
                remove_children(&child)?;
                fs::unlinkat(directory, name, AtFlags::REMOVEDIR).map_err(error)?;
            } else {
                fs::unlinkat(directory, name, AtFlags::empty()).map_err(error)?;
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
pub use platform::ProjectDir;

// Windows keeps the existing strict component/symlink validation. The Unix
// implementation above is the production path on macOS and other Unix hosts.
#[cfg(not(unix))]
pub struct ProjectDir {
    root: std::path::PathBuf,
}

#[cfg(not(unix))]
impl ProjectDir {
    pub fn open(root: &Path) -> Result<Self, String> {
        Ok(Self {
            root: root.canonicalize().map_err(|error| error.to_string())?,
        })
    }
    pub fn atomic_write(&self, relative: &str, bytes: &[u8]) -> Result<(), String> {
        let path = crate::project::creation_path(&self.root, relative)?;
        std::fs::write(path, bytes).map_err(|error| error.to_string())
    }
    pub fn rename(&self, source: &str, destination: &str) -> Result<(), String> {
        let source = crate::project::safe_path(&self.root, source)?;
        let destination = crate::project::creation_path(&self.root, destination)?;
        std::fs::rename(source, destination).map_err(|error| error.to_string())
    }
    pub fn remove(&self, relative: &str) -> Result<(), String> {
        let path = crate::project::safe_path(&self.root, relative)?;
        if path.is_dir() {
            std::fs::remove_dir_all(path).map_err(|error| error.to_string())
        } else {
            std::fs::remove_file(path).map_err(|error| error.to_string())
        }
    }
    pub fn prune_json_files(&self, relative: &str, limit: usize) -> Result<(), String> {
        crate::project::prune_history(&self.root.join(relative), limit)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::ProjectDir;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use uuid::Uuid;

    fn temporary(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("lattice-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn validates_paths_and_atomically_replaces_regular_files() {
        let root = temporary("capability-basic");
        let outside = temporary("capability-basic-outside");
        let project = ProjectDir::open(&root).unwrap();
        assert!(project.atomic_write("../escape", b"bad").is_err());
        assert!(project.atomic_write("/escape", b"bad").is_err());
        project.atomic_write("nested/file.txt", b"first").unwrap();
        project.atomic_write("nested/file.txt", b"second").unwrap();
        assert_eq!(fs::read(root.join("nested/file.txt")).unwrap(), b"second");

        symlink(outside.join("missing"), root.join("final-link")).unwrap();
        assert!(project.atomic_write("final-link", b"bad").is_err());
        symlink(&outside, root.join("directory-link")).unwrap();
        assert!(project.atomic_write("directory-link/file", b"bad").is_err());
        assert!(!outside.join("file").exists());
        assert!(!outside.join("missing").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn raced_parent_swaps_never_mutate_outside() {
        let root = temporary("capability-race");
        let outside = temporary("capability-race-outside");
        fs::write(outside.join("sentinel"), b"safe").unwrap();
        fs::create_dir(root.join("parent")).unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let swap_running = Arc::clone(&running);
        let swap_root = root.clone();
        let swap_outside = outside.clone();
        let swapper = thread::spawn(move || {
            let parent = swap_root.join("parent");
            let held = swap_root.join("held");
            while swap_running.load(Ordering::Relaxed) {
                if fs::rename(&parent, &held).is_ok() {
                    if symlink(&swap_outside, &parent).is_ok() {
                        thread::yield_now();
                        let _ = fs::remove_file(&parent);
                    }
                    let _ = fs::rename(&held, &parent);
                }
            }
        });

        for index in 0..500 {
            if let Ok(project) = ProjectDir::open(&root) {
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
        assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"safe");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        let _ = fs::remove_file(root.join("parent"));
        let _ = fs::rename(root.join("held"), root.join("parent"));
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
