//! Temporary folders for tests of the project area and its search index.

use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(crate) fn temp_root(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("research-writer-{label}-{}", Uuid::new_v4()));
    fs::create_dir_all(&path).unwrap();
    path
}

/// A project `root` inside a scratch `parent` that is deleted on drop.
pub(crate) struct Fixture {
    pub parent: PathBuf,
    pub root: PathBuf,
}

impl Fixture {
    /// A new NeurIPS project named `paper`.
    pub fn project(label: &str) -> Self {
        let parent = temp_root(label);
        let root = crate::project::create(&parent, "paper").unwrap();
        Self { parent, root }
    }

    /// An empty folder `name` that Lattice has not opened yet.
    pub fn folder(label: &str, name: &str) -> Self {
        let parent = temp_root(label);
        let root = parent.join(name);
        fs::create_dir_all(&root).unwrap();
        Self { parent, root }
    }

    /// An empty scratch folder used directly as the root.
    pub fn empty(label: &str) -> Self {
        let root = temp_root(label);
        Self { parent: root.clone(), root }
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    /// Write a file under the root, creating its folders.
    pub fn write(&self, relative: &str, contents: impl AsRef<[u8]>) {
        write_file(&self.path(relative), contents);
    }

    /// Write a file beside the project (under `parent`), as a drop source.
    pub fn outside(&self, relative: &str, contents: impl AsRef<[u8]>) -> PathBuf {
        let path = self.parent.join(relative);
        write_file(&path, contents);
        path
    }

    pub fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.path(relative)).unwrap()
    }
}

fn write_file(path: &Path, contents: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.parent);
    }
}
