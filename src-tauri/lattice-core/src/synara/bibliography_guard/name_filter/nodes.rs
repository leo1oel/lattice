//! The files and folders the kernel has looked up through the filter and
//! not yet forgotten, each held by a descriptor that names its inode.

use super::host::{attributes, descriptor_path, is_procfs, status_of};
use super::is_bibliography;
use fuser::{Errno, FileAttr, INodeNo};
use std::collections::HashMap;
use std::ffi::{CString, OsStr};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// One file or folder the kernel has looked up and not yet forgotten.
pub(super) struct Node {
    /// `O_PATH | O_NOFOLLOW`: names the inode whatever its path becomes.
    pub(super) fd: OwnedFd,
    /// The device and inode numbers, which the open descriptor keeps unique.
    pub(super) key: (u64, u64),
    kind: libc::mode_t,
    /// Reached through a `*.bib` name. A hard link gives the same inode
    /// another name, so the rule follows the inode.
    bibliography: AtomicBool,
    /// A procfs folder: nothing under it is served. Its files reach other
    /// processes' memory and roots, which the sandbox mounts its own `/proc`
    /// to keep out.
    pub(super) sealed: bool,
}

impl Node {
    pub(super) fn is(&self, kind: libc::mode_t) -> bool {
        self.kind == kind
    }

    pub(super) fn is_bibliography(&self) -> bool {
        self.bibliography.load(Ordering::Relaxed)
    }

    /// The descriptor's `/proc/self/fd` entry, which reopens the inode with
    /// real access or names it for a call that takes only a path.
    pub(super) fn path(&self) -> CString {
        descriptor_path(self.fd.as_raw_fd())
    }
}

#[derive(Default)]
struct Table {
    /// By the number the kernel knows it by, with how many lookups it holds.
    by_id: HashMap<u64, (Arc<Node>, u64)>,
    by_key: HashMap<(u64, u64), u64>,
    last_id: u64,
}

pub(super) struct Nodes(Mutex<Table>);

impl Nodes {
    /// A table whose root, the kernel's node 1, is the folder `root` names.
    pub(super) fn new(root: OwnedFd) -> io::Result<Self> {
        let status = status_of(root.as_raw_fd())?;
        let root = Node {
            fd: root,
            key: (status.st_dev, status.st_ino),
            kind: status.st_mode & libc::S_IFMT,
            bibliography: AtomicBool::new(false),
            sealed: false,
        };
        let mut table = Table::default();
        table.by_key.insert(root.key, INodeNo::ROOT.0);
        table.by_id.insert(INodeNo::ROOT.0, (Arc::new(root), 1));
        table.last_id = INodeNo::ROOT.0;
        Ok(Self(Mutex::new(table)))
    }

    fn table(&self) -> MutexGuard<'_, Table> {
        // A panic in one request must not take the mount, and the sandbox's
        // whole file system, with it.
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn get(&self, id: INodeNo) -> Result<Arc<Node>, Errno> {
        self.table().by_id.get(&id.0).map(|(node, _)| Arc::clone(node)).ok_or(Errno::ENOENT)
    }

    /// Record one more kernel lookup of the inode `fd` names, which was
    /// reached as `name` in `parent`, and answer its number and attributes.
    pub(super) fn remember(
        &self, parent: &Node, name: &OsStr, fd: OwnedFd,
    ) -> Result<(INodeNo, FileAttr, Arc<Node>), Errno> {
        let status = status_of(fd.as_raw_fd())?;
        let key = (status.st_dev, status.st_ino);
        let kind = status.st_mode & libc::S_IFMT;
        // Another file system starts here. Only a mount can put procfs in the
        // tree, so this is the one place to look for it.
        let sealed = kind == libc::S_IFDIR && key.0 != parent.key.0 && is_procfs(fd.as_raw_fd())?;
        let mut table = self.table();
        let (id, node) = match table.by_key.get(&key).copied() {
            Some(id) => {
                let (node, lookups) = table.by_id.get_mut(&id).ok_or(Errno::EIO)?;
                *lookups += 1;
                (id, Arc::clone(node))
            }
            None => {
                table.last_id += 1;
                let id = table.last_id;
                let node =
                    Arc::new(Node { fd, key, kind, bibliography: AtomicBool::new(false), sealed });
                table.by_key.insert(key, id);
                table.by_id.insert(id, (Arc::clone(&node), 1));
                (id, node)
            }
        };
        drop(table);
        // With one name the inode is a bibliography exactly when that name
        // is; with several, when any of them has been.
        if kind == libc::S_IFDIR || status.st_nlink <= 1 {
            node.bibliography.store(is_bibliography(name), Ordering::Relaxed);
        } else if is_bibliography(name) {
            node.bibliography.store(true, Ordering::Relaxed);
        }
        Ok((INodeNo(id), attributes(&status), node))
    }

    /// Drop `count` kernel lookups of a node, and the node with its last.
    pub(super) fn forget(&self, id: INodeNo, count: u64) {
        if id == INodeNo::ROOT {
            return;
        }
        let mut table = self.table();
        let Some((node, lookups)) = table.by_id.get_mut(&id.0) else { return };
        *lookups = lookups.saturating_sub(count);
        if *lookups == 0 {
            let key = node.key;
            table.by_id.remove(&id.0);
            table.by_key.remove(&key);
        }
    }
}
