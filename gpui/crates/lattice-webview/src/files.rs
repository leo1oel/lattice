//! The file bridge: what an island may read and write in its project.
//!
//! Islands name project files by their project-relative path, as the Tauri
//! app's frontend does (`read_project_file`, `write_project_file`). A path is
//! resolved inside the project root or refused: no absolute paths, no `..`
//! that climbs out, and no symlink that leads out once followed, so a page
//! cannot reach the rest of the disk through its bridge or the asset protocol.
//!
//! Writes are atomic (a sibling temporary file renamed over the target), so
//! the project watcher and the editor's disk check never see half a file.

use std::{
    io::Write as _,
    path::{Component, Path, PathBuf},
};

use anyhow::{Context as _, Result, anyhow, bail};

/// The largest file an island reads through the bridge, as lattice-core's
/// text reads cap theirs; a page has no business pulling a disk image in.
pub const MAX_READ: u64 = 64 * 1024 * 1024;

/// A project root that bridge paths resolve in.
#[derive(Clone, Debug)]
pub struct FileScope {
    root: PathBuf,
}

impl FileScope {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = root
            .as_ref()
            .canonicalize()
            .with_context(|| format!("project root {}", root.as_ref().display()))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The absolute path of `relative`, which must stay in the project.
    /// A file that does not exist yet resolves through its parent folder.
    pub fn resolve(&self, relative: &str) -> Result<PathBuf> {
        let relative = relative.replace('\\', "/");
        let path = Path::new(&relative);
        let mut joined = self.root.clone();
        for component in path.components() {
            match component {
                Component::Normal(part) => joined.push(part),
                Component::CurDir => {}
                Component::ParentDir => bail!("{relative} leaves the project"),
                Component::RootDir | Component::Prefix(_) => {
                    bail!("{relative} is not a project-relative path")
                }
            }
        }
        if joined == self.root {
            bail!("{relative} names the project folder itself");
        }
        // Follow symlinks: the target, or for a new file its folder, must
        // still be under the root.
        let checked = if joined.exists() {
            joined.canonicalize()?
        } else {
            let parent = joined
                .parent()
                .ok_or_else(|| anyhow!("{relative} has no folder"))?
                .canonicalize()
                .with_context(|| format!("the folder of {relative}"))?;
            parent.join(joined.file_name().unwrap_or_default())
        };
        if !checked.starts_with(&self.root) {
            bail!("{relative} leads outside the project");
        }
        Ok(checked)
    }

    pub fn read_bytes(&self, relative: &str) -> Result<Vec<u8>> {
        let path = self.resolve(relative)?;
        let metadata = std::fs::metadata(&path)?;
        if !metadata.is_file() {
            bail!("{relative} is not a file");
        }
        if metadata.len() > MAX_READ {
            bail!("{relative} is larger than {} MB", MAX_READ / 1024 / 1024);
        }
        Ok(std::fs::read(path)?)
    }

    pub fn read_text(&self, relative: &str) -> Result<String> {
        String::from_utf8(self.read_bytes(relative)?)
            .map_err(|_| anyhow!("{relative} is not UTF-8 text"))
    }

    /// Write `contents` to `relative` atomically, creating it if needed (its
    /// folder must exist).
    pub fn write(&self, relative: &str, contents: &[u8]) -> Result<()> {
        let path = self.resolve(relative)?;
        if path.is_dir() {
            bail!("{relative} is a folder");
        }
        let folder = path
            .parent()
            .ok_or_else(|| anyhow!("{relative} has no folder"))?;
        let mut temporary = tempfile_in(folder)?;
        temporary.1.write_all(contents)?;
        temporary.1.sync_all()?;
        drop(temporary.1);
        std::fs::rename(&temporary.0, &path).inspect_err(|_| {
            std::fs::remove_file(&temporary.0).ok();
        })?;
        Ok(())
    }
}

/// A new hidden file beside the target, for an atomic write.
fn tempfile_in(folder: &Path) -> Result<(PathBuf, std::fs::File)> {
    for attempt in 0..16u32 {
        let name = format!(
            ".lattice-island-{}-{}-{attempt}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.subsec_nanos())
                .unwrap_or_default()
        );
        let path = folder.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    bail!("no temporary file name was free in {}", folder.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> (tempfile::TempDir, FileScope) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/a.txt"), "alpha").unwrap();
        let scope = FileScope::new(dir.path()).unwrap();
        (dir, scope)
    }

    #[test]
    fn reads_inside_the_project() {
        let (_dir, scope) = project();
        assert_eq!(scope.read_text("sub/a.txt").unwrap(), "alpha");
        assert_eq!(scope.read_text("./sub//a.txt").unwrap(), "alpha");
        assert_eq!(scope.read_text("sub\\a.txt").unwrap(), "alpha");
    }

    #[test]
    fn refuses_paths_that_leave_the_project() {
        let (dir, scope) = project();
        std::fs::write(dir.path().parent().unwrap().join("x"), "").ok();
        for path in ["../x", "sub/../../x", "/etc/hosts", "", "."] {
            assert!(scope.resolve(path).is_err(), "{path} resolved");
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_out_of_the_project() {
        let (dir, scope) = project();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        assert!(scope.read_text("link/secret").is_err());
        assert!(scope.write("link/new", b"x").is_err());
    }

    #[test]
    fn writes_atomically_and_creates_files() {
        let (dir, scope) = project();
        scope.write("sub/a.txt", b"beta").unwrap();
        scope.write("sub/new.txt", b"gamma").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("sub/a.txt")).unwrap(),
            "beta"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("sub/new.txt")).unwrap(),
            "gamma"
        );
        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("sub"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        assert!(scope.write("missing/x.txt", b"x").is_err());
        assert!(scope.write("sub", b"x").is_err());
    }
}
