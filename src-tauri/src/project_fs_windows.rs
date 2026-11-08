//! Capability-relative project writes on Windows. Directory handles remain
//! anchored to the selected root even when another process renames a parent.
use crate::util::err;
use cap_std::fs::{Dir, OpenOptions};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Component, Path};

const REFUSED: &str = "Symbolic links cannot be used for project file operations.";

pub struct ProjectDir {
    root: Dir,
}

impl ProjectDir {
    pub fn open(root: &Path) -> Result<Self, String> {
        Ok(Self {
            root: Dir::open_ambient_dir(
                root.canonicalize().map_err(err)?,
                cap_std::ambient_authority(),
            )
            .map_err(err)?,
        })
    }

    fn parent(&self, relative: &str, create: bool) -> Result<(Dir, OsString), String> {
        let path = Path::new(relative);
        if path.as_os_str().is_empty() || !path.components().all(|part| matches!(part, Component::Normal(name) if crate::platform_windows::valid_name(name))) {
            return Err("The requested path is outside the project.".into());
        }
        let mut parts: Vec<_> =
            path.components().map(|part| part.as_os_str().to_os_string()).collect();
        let name = parts.pop().ok_or("Choose a file name.")?;
        let mut parent = self.root.try_clone().map_err(err)?;
        for part in parts {
            if create {
                match parent.create_dir(&part) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(err(error)),
                }
            }
            Self::reject_link(&parent, &part)?;
            parent = parent.open_dir(&part).map_err(err)?;
        }
        Ok((parent, name))
    }

    fn reject_link(parent: &Dir, name: &std::ffi::OsStr) -> Result<(), String> {
        match parent.symlink_metadata(name) {
            Ok(meta) if meta.file_type().is_symlink() => Err(REFUSED.into()),
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(err(error)),
        }
    }

    pub fn atomic_write(&self, relative: &str, bytes: &[u8]) -> Result<(), String> {
        let (parent, name) = self.parent(relative, true)?;
        Self::reject_link(&parent, &name)?;
        let temporary = format!(".lattice-{}.tmp", uuid::Uuid::new_v4());
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            let mut file = parent.open_with(&temporary, &options).map_err(err)?;
            file.write_all(bytes).map_err(err)?;
            file.sync_all().map_err(err)?;
            drop(file);
            Self::reject_link(&parent, &name)?;
            parent.rename(&temporary, &parent, &name).map_err(err)
        })();
        if result.is_err() {
            let _ = parent.remove_file(&temporary);
        }
        result
    }

    pub fn rename(&self, source: &str, destination: &str) -> Result<(), String> {
        let (from, source) = self.parent(source, false)?;
        let (to, destination) = self.parent(destination, false)?;
        Self::reject_link(&from, &source)?;
        match to.symlink_metadata(&destination) {
            Ok(_) => return Err("A file or folder already exists with that name.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(err(error)),
        }
        from.rename(source, &to, destination).map_err(err)
    }

    pub fn remove(&self, relative: &str) -> Result<(), String> {
        let (parent, name) = self.parent(relative, false)?;
        let metadata = parent.symlink_metadata(&name).map_err(err)?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            parent.remove_dir_all(name).map_err(err)
        } else {
            parent.remove_file(name).map_err(err)
        }
    }

    pub fn prune_json_files(&self, relative: &str, limit: usize) -> Result<(), String> {
        let (directory, _) = self.parent(&format!("{relative}/entry"), false)?;
        let mut names = directory
            .entries()
            .map_err(err)?
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .filter(|name| Path::new(name).extension().is_some_and(|ext| ext == "json"))
            .collect::<Vec<_>>();
        names.sort();
        let remove = names.len().saturating_sub(limit);
        for name in names.into_iter().take(remove) {
            directory.remove_file(name).map_err(err)?;
        }
        Ok(())
    }
}
