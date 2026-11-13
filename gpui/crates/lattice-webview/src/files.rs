//! The file bridge: what an island may read in its project.
//!
//! Islands name project files by their project-relative path, as the Tauri
//! app's frontend does (`read_project_file`). A path is
//! resolved inside the project root or refused: no absolute paths, no `..`
//! that climbs out, and no symlink that leads out once followed, so a page
//! cannot reach the rest of the disk through its bridge or the asset protocol.

use std::path::{Component, Path, PathBuf};

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
    }
}
