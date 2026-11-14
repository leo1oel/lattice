//! The view of the file system the agent gets on Linux: the host's own
//! files, except that nothing named `*.bib` can be changed through it.
//!
//! Linux has no unprivileged rule that denies writes by file name, which is
//! what the macOS Seatbelt profile does. This is a FUSE file system that
//! passes every operation through to the real file underneath and refuses
//! the ones that would change a bibliography: creating, removing, renaming,
//! linking or relinking a `*.bib` name, and writing, truncating or changing
//! the attributes of a file reached through one or renamed to one since. It
//! also refuses to make or move a symbolic link. The sandbox (`linux.rs`)
//! mounts it where the agent's writable files are, so the rule holds for
//! files and folders created later too, which read-only binds cannot do.
//!
//! It never follows a link itself. Every file is held by an `O_PATH`
//! descriptor opened one name at a time with `O_NOFOLLOW`, as libfuse's
//! `passthrough_hp` does, and the kernel resolves symbolic links inside the
//! sandbox, where they lead back here. So a link cannot walk this process
//! out to a path the agent could not open itself.
//!
//! This file is the operations the rule (`rule`) applies to. `nodes` keeps
//! the inodes the kernel has looked up, and `host` makes the calls on the
//! real files.

mod host;
mod nodes;
mod rule;

use fuser::{
    AccessFlags, BsdFileFlags, Config, CopyFileRangeFlags, Errno, FileAttr, FileHandle, Filesystem,
    FopenFlags, Generation, INodeNo, InitFlags, KernelConfig, LockOwner, MountOption, OpenFlags,
    RenameFlags, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry,
    ReplyLseek, ReplyOpen, ReplyStatfs, ReplyWrite, ReplyXattr, Request, SessionACL, TimeOrNow,
    WriteFlags,
};
use host::{
    attributes, cvt, cvt_long, is_link, last_error, open_child, open_folder, read_entries,
    status_of, timespec, EMPTY,
};
use nodes::{Node, Nodes};
use rule::{changes_content, is_bibliography, is_named_bibliography, may_change, DENIED};
use std::ffi::{CStr, CString, OsStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// Nothing the kernel looked up is reused without asking again, so a file or
/// folder that Lattice replaces by rename (its own saves, a sync pull) is
/// never written through its old, unlinked inode.
const NO_TTL: Duration = Duration::ZERO;
/// The kernel's request threads; each can block on one slow disk operation.
const THREADS: usize = 8;

pub(super) struct BibliographyFilter {
    nodes: Nodes,
    /// The folder this is mounted on, by its parent's key and its name: it
    /// is inside the tree it shows, and looking itself up would wait on its
    /// own answer.
    mountpoint: Option<((u64, u64), OsString)>,
}

/// Mount the filter over `source` at `mountpoint` and serve it on background
/// threads until the returned session is dropped.
pub(super) fn mount(source: &Path, mountpoint: &Path) -> io::Result<fuser::BackgroundSession> {
    let filter = BibliographyFilter::new(source, mountpoint)?;
    let mut config = Config::default();
    config.mount_options = vec![
        MountOption::FSName("lattice-bibliography-guard".to_string()),
        MountOption::NoSuid,
        MountOption::NoDev,
    ];
    // Only the user who runs Lattice, which the agent is too.
    config.acl = SessionACL::Owner;
    config.n_threads = Some(THREADS);
    config.clone_fd = true;
    fuser::spawn_mount(filter, mountpoint, &config)
}

impl BibliographyFilter {
    fn new(source: &Path, mountpoint: &Path) -> io::Result<Self> {
        let nodes = Nodes::new(open_folder(source)?)?;
        let mountpoint =
            mountpoint.parent().zip(mountpoint.file_name()).and_then(|(parent, name)| {
                let parent = std::fs::metadata(parent).ok()?;
                use std::os::unix::fs::MetadataExt;
                Some(((parent.dev(), parent.ino()), name.to_os_string()))
            });
        Ok(Self { nodes, mountpoint })
    }

    fn node(&self, id: INodeNo) -> Result<Arc<Node>, Errno> {
        self.nodes.get(id)
    }

    /// A folder to look `name` up in, create it in or remove it from.
    fn folder(&self, id: INodeNo, name: &OsStr) -> Result<(Arc<Node>, CString), Errno> {
        let node = self.node(id)?;
        let bytes = name.as_bytes();
        if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
            return Err(Errno::EINVAL);
        }
        if node.sealed {
            return Err(Errno::EACCES);
        }
        if self
            .mountpoint
            .as_ref()
            .is_some_and(|(key, mounted)| *key == node.key && mounted == name)
        {
            return Err(Errno::EACCES);
        }
        Ok((node, CString::new(bytes).map_err(|_| Errno::EINVAL)?))
    }

    /// The same, for a call that adds, removes or renames `name`.
    fn folder_to_change(&self, id: INodeNo, name: &OsStr) -> Result<(Arc<Node>, CString), Errno> {
        if is_bibliography(name) {
            return Err(DENIED);
        }
        self.folder(id, name)
    }

    /// Look `name` up in `parent` without following it.
    fn lookup_in(
        &self, parent: &Node, name: &OsStr, c_name: &CStr,
    ) -> Result<(INodeNo, FileAttr, Arc<Node>), Errno> {
        let fd = open_child(parent.fd.as_raw_fd(), c_name)?;
        self.nodes.remember(parent, name, fd)
    }

    fn entry(&self, parent: INodeNo, name: &OsStr) -> Result<FileAttr, Errno> {
        let (parent, c_name) = self.folder(parent, name)?;
        let (id, mut attr, _) = self.lookup_in(&parent, name, &c_name)?;
        attr.ino = id;
        Ok(attr)
    }

    /// Open the inode itself, through its `O_PATH` descriptor.
    fn reopen(node: &Node, flags: libc::c_int) -> Result<RawFd, Errno> {
        let path = node.path();
        // SAFETY: `path` is a NUL-terminated string that outlives the call.
        Ok(cvt(unsafe { libc::open(path.as_ptr(), flags | libc::O_CLOEXEC) })?)
    }

    fn set_attributes(
        &self, node: &Node, mode: Option<u32>, owner: (Option<u32>, Option<u32>),
        size: Option<u64>, times: (Option<TimeOrNow>, Option<TimeOrNow>), fh: Option<FileHandle>,
    ) -> Result<FileAttr, Errno> {
        may_change(node, fh)?;
        let fd = node.fd.as_raw_fd();
        let path = node.path();
        if let Some(mode) = mode {
            if node.is(libc::S_IFLNK) {
                return Err(Errno::EOPNOTSUPP);
            }
            // SAFETY: `path` is NUL-terminated and outlives the call.
            cvt(unsafe { libc::chmod(path.as_ptr(), mode as libc::mode_t) })?;
        }
        if owner.0.is_some() || owner.1.is_some() {
            let flags = libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW;
            let (uid, gid) = (owner.0.unwrap_or(u32::MAX), owner.1.unwrap_or(u32::MAX));
            // SAFETY: an empty path with AT_EMPTY_PATH names `fd` itself.
            cvt(unsafe { libc::fchownat(fd, EMPTY.as_ptr(), uid, gid, flags) })?;
        }
        if let Some(size) = size {
            let size = libc::off_t::try_from(size).map_err(|_| Errno::EFBIG)?;
            match fh {
                // SAFETY: the kernel hands back a descriptor `open` gave it.
                Some(fh) => cvt(unsafe { libc::ftruncate(fh.0 as RawFd, size) })?,
                // SAFETY: `path` is NUL-terminated and outlives the call.
                None => cvt(unsafe { libc::truncate(path.as_ptr(), size) })?,
            };
        }
        if times.0.is_some() || times.1.is_some() {
            let times = [timespec(times.0), timespec(times.1)];
            // SAFETY: `times` holds the two entries utimensat reads.
            let result = unsafe {
                if node.is(libc::S_IFLNK) {
                    libc::utimensat(fd, EMPTY.as_ptr(), times.as_ptr(), libc::AT_EMPTY_PATH)
                } else {
                    libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0)
                }
            };
            cvt(result)?;
        }
        Ok(attributes(&status_of(fd)?))
    }
}

/// Answer `$reply` with the error of a failed `$result`, or continue with
/// its value.
macro_rules! attempt {
    ($reply:expr, $result:expr) => {
        match $result {
            Ok(value) => value,
            Err(error) => return $reply.error(Errno::from(error)),
        }
    };
}

impl Filesystem for BibliographyFilter {
    fn init(&mut self, _req: &Request, config: &mut KernelConfig) -> io::Result<()> {
        // Reads see what Lattice wrote to the real file a moment ago, and
        // O_TRUNC arrives with the open it belongs to. Older kernels lack
        // some of these; the filter is correct without them.
        for flag in [
            InitFlags::FUSE_AUTO_INVAL_DATA,
            InitFlags::FUSE_ATOMIC_O_TRUNC,
            InitFlags::FUSE_PARALLEL_DIROPS,
        ] {
            let _ = config.add_capabilities(flag);
        }
        Ok(())
    }

    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let attr = attempt!(reply, self.entry(parent, name));
        reply.entry(&NO_TTL, &attr, Generation(0));
    }

    fn forget(&self, _req: &Request, ino: INodeNo, nlookup: u64) {
        self.nodes.forget(ino, nlookup);
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        let node = attempt!(reply, self.node(ino));
        let mut attr = attributes(&attempt!(reply, status_of(node.fd.as_raw_fd())));
        attr.ino = ino;
        reply.attr(&NO_TTL, &attr);
    }

    fn setattr(
        &self, _req: &Request, ino: INodeNo, mode: Option<u32>, uid: Option<u32>, gid: Option<u32>,
        size: Option<u64>, atime: Option<TimeOrNow>, mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>, fh: Option<FileHandle>, _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>, _bkuptime: Option<SystemTime>, _flags: Option<BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        let node = attempt!(reply, self.node(ino));
        let result = self.set_attributes(&node, mode, (uid, gid), size, (atime, mtime), fh);
        let mut attr = attempt!(reply, result);
        attr.ino = ino;
        reply.attr(&NO_TTL, &attr);
    }

    fn readlink(&self, _req: &Request, ino: INodeNo, reply: ReplyData) {
        let node = attempt!(reply, self.node(ino));
        let mut target = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: an empty path names the link `fd` holds; the buffer is
        // `target.len()` bytes long.
        let length = unsafe {
            libc::readlinkat(
                node.fd.as_raw_fd(),
                EMPTY.as_ptr(),
                target.as_mut_ptr().cast(),
                target.len(),
            )
        };
        if length < 0 {
            return reply.error(last_error());
        }
        reply.data(&target[..length as usize]);
    }

    fn mknod(
        &self, _req: &Request, parent: INodeNo, name: &OsStr, mode: u32, _umask: u32, rdev: u32,
        reply: ReplyEntry,
    ) {
        let (parent, c_name) = attempt!(reply, self.folder_to_change(parent, name));
        let kind = mode as libc::mode_t & libc::S_IFMT;
        // Files, pipes and sockets; the mount is `nodev` anyway.
        if ![libc::S_IFREG, libc::S_IFIFO, libc::S_IFSOCK].contains(&kind) {
            return reply.error(Errno::EPERM);
        }
        let fd = parent.fd.as_raw_fd();
        // SAFETY: `c_name` is NUL-terminated and `fd` is open.
        let made = unsafe {
            libc::mknodat(fd, c_name.as_ptr(), mode as libc::mode_t, libc::dev_t::from(rdev))
        };
        attempt!(reply, cvt(made));
        let (id, mut attr, _) = attempt!(reply, self.lookup_in(&parent, name, &c_name));
        attr.ino = id;
        reply.entry(&NO_TTL, &attr, Generation(0));
    }

    fn mkdir(
        &self, _req: &Request, parent: INodeNo, name: &OsStr, mode: u32, _umask: u32,
        reply: ReplyEntry,
    ) {
        let (parent, c_name) = attempt!(reply, self.folder_to_change(parent, name));
        // SAFETY: `c_name` is NUL-terminated and the descriptor is open.
        let made =
            unsafe { libc::mkdirat(parent.fd.as_raw_fd(), c_name.as_ptr(), mode as libc::mode_t) };
        attempt!(reply, cvt(made));
        let (id, mut attr, _) = attempt!(reply, self.lookup_in(&parent, name, &c_name));
        attr.ino = id;
        reply.entry(&NO_TTL, &attr, Generation(0));
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let (parent, c_name) = attempt!(reply, self.folder_to_change(parent, name));
        // SAFETY: `c_name` is NUL-terminated and the descriptor is open.
        let removed = unsafe { libc::unlinkat(parent.fd.as_raw_fd(), c_name.as_ptr(), 0) };
        attempt!(reply, cvt(removed));
        reply.ok();
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let (parent, c_name) = attempt!(reply, self.folder_to_change(parent, name));
        // SAFETY: `c_name` is NUL-terminated and the descriptor is open.
        let removed =
            unsafe { libc::unlinkat(parent.fd.as_raw_fd(), c_name.as_ptr(), libc::AT_REMOVEDIR) };
        attempt!(reply, cvt(removed));
        reply.ok();
    }

    fn symlink(
        &self, _req: &Request, _parent: INodeNo, _link_name: &OsStr, _target: &Path,
        reply: ReplyEntry,
    ) {
        // Lattice follows links outside the sandbox too: it resolves a
        // project's folder on every operation. A project folder moved aside
        // and replaced by a link to a copy in `/tmp`, where bibliographies are
        // not filtered, would have Lattice edit and build that copy. So no
        // link is made here; the host's own still lead where they did.
        reply.error(DENIED);
    }

    fn rename(
        &self, _req: &Request, parent: INodeNo, name: &OsStr, newparent: INodeNo, newname: &OsStr,
        flags: RenameFlags, reply: ReplyEmpty,
    ) {
        // Either side: moving a bibliography away removes it, and moving
        // anything onto its name replaces it.
        let (parent, c_name) = attempt!(reply, self.folder_to_change(parent, name));
        let (newparent, c_newname) = attempt!(reply, self.folder_to_change(newparent, newname));
        // Nor is a link moved, onto a project folder's name or away from it:
        // that is the same detour as making one (see `symlink`), and
        // `RENAME_EXCHANGE` moves the destination as well. No link can come
        // in meanwhile: the filter makes none, and a rename from a folder
        // outside it fails with EXDEV.
        let link = |folder: &Node, name: &CStr| is_link(folder.fd.as_raw_fd(), name);
        if attempt!(reply, link(&parent, &c_name)) || attempt!(reply, link(&newparent, &c_newname))
        {
            return reply.error(DENIED);
        }
        // SAFETY: both names are NUL-terminated and both descriptors open.
        let renamed = unsafe {
            libc::renameat2(
                parent.fd.as_raw_fd(),
                c_name.as_ptr(),
                newparent.fd.as_raw_fd(),
                c_newname.as_ptr(),
                flags.bits(),
            )
        };
        attempt!(reply, cvt(renamed));
        reply.ok();
    }

    fn link(
        &self, _req: &Request, ino: INodeNo, newparent: INodeNo, newname: &OsStr, reply: ReplyEntry,
    ) {
        let node = attempt!(reply, self.node(ino));
        // A second name for a bibliography would be a way to write it, and
        // one for a symbolic link a way to make a link (see `symlink`).
        if node.is(libc::S_IFLNK) || attempt!(reply, is_named_bibliography(&node, None)) {
            return reply.error(DENIED);
        }
        let (newparent, c_newname) = attempt!(reply, self.folder_to_change(newparent, newname));
        let path = node.path();
        // SAFETY: both strings are NUL-terminated and the descriptor is open.
        let linked = unsafe {
            libc::linkat(
                libc::AT_FDCWD,
                path.as_ptr(),
                newparent.fd.as_raw_fd(),
                c_newname.as_ptr(),
                libc::AT_SYMLINK_FOLLOW,
            )
        };
        attempt!(reply, cvt(linked));
        let (id, mut attr, _) = attempt!(reply, self.lookup_in(&newparent, newname, &c_newname));
        attr.ino = id;
        reply.entry(&NO_TTL, &attr, Generation(0));
    }

    fn open(&self, _req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let node = attempt!(reply, self.node(ino));
        if changes_content(flags.0) {
            attempt!(reply, may_change(&node, None));
        }
        // The descriptor's path is itself a link, and the kernel has already
        // decided what the caller's O_NOFOLLOW meant.
        let flags = flags.0 & !(libc::O_NOFOLLOW | libc::O_CREAT | libc::O_EXCL | libc::O_DIRECT);
        let fd = attempt!(reply, Self::reopen(&node, flags));
        reply.opened(FileHandle(fd as u64), FopenFlags::empty());
    }

    fn create(
        &self, _req: &Request, parent: INodeNo, name: &OsStr, mode: u32, _umask: u32, flags: i32,
        reply: ReplyCreate,
    ) {
        let (parent, c_name) = attempt!(reply, self.folder_to_change(parent, name));
        // The kernel asks for a name it saw nothing at. O_NOFOLLOW: a link
        // put there since would otherwise be followed here, outside the
        // sandbox, to whatever it names. O_NONBLOCK: nor does this wait on a
        // pipe put there, which no reader may ever open.
        let open_flags = (flags & !libc::O_DIRECT)
            | libc::O_CREAT
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | libc::O_CLOEXEC;
        // SAFETY: `c_name` is NUL-terminated and the descriptor is open.
        let fd = unsafe {
            libc::openat(parent.fd.as_raw_fd(), c_name.as_ptr(), open_flags, mode as libc::c_uint)
        };
        let fd = attempt!(reply, cvt(fd));
        // SAFETY: `openat` just returned this descriptor.
        let file = unsafe { OwnedFd::from_raw_fd(fd) };
        let (id, mut attr, node) = attempt!(reply, self.lookup_in(&parent, name, &c_name));
        // What appeared under this name meanwhile can be an existing
        // bibliography's other name, or no file at all: the kernel serves
        // pipes and sockets itself and asks again when told the name is stale.
        let same = node.is(libc::S_IFREG)
            && status_of(file.as_raw_fd()).is_ok_and(|s| (s.st_dev, s.st_ino) == node.key);
        let refused = || {
            let fh = FileHandle(file.as_raw_fd() as u64);
            changes_content(flags) && may_change(&node, Some(fh)).is_err()
        };
        if !same || refused() {
            self.nodes.forget(id, 1);
            return reply.error(if same { DENIED } else { Errno::ESTALE });
        }
        attr.ino = id;
        let fh = FileHandle(std::os::fd::IntoRawFd::into_raw_fd(file) as u64);
        reply.created(&NO_TTL, &attr, Generation(0), fh, FopenFlags::empty());
    }

    fn read(
        &self, _req: &Request, _ino: INodeNo, fh: FileHandle, offset: u64, size: u32,
        _flags: OpenFlags, _lock_owner: Option<LockOwner>, reply: ReplyData,
    ) {
        let mut data = vec![0u8; size as usize];
        // SAFETY: the kernel hands back a descriptor `open` gave it, and the
        // buffer is `data.len()` bytes long.
        let read = unsafe {
            libc::pread(fh.0 as RawFd, data.as_mut_ptr().cast(), data.len(), offset as libc::off_t)
        };
        if read < 0 {
            return reply.error(last_error());
        }
        reply.data(&data[..read as usize]);
    }

    fn write(
        &self, _req: &Request, ino: INodeNo, fh: FileHandle, offset: u64, data: &[u8],
        _write_flags: WriteFlags, _flags: OpenFlags, _lock_owner: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        // Checked again here: the name can have become a bibliography's
        // since the open, when Lattice renames a file onto one.
        let node = attempt!(reply, self.node(ino));
        attempt!(reply, may_change(&node, Some(fh)));
        let mut written = 0;
        while written < data.len() {
            let rest = &data[written..];
            let position = offset as libc::off_t + written as libc::off_t;
            // SAFETY: as in `read`; `rest` is `rest.len()` bytes long.
            let count =
                unsafe { libc::pwrite(fh.0 as RawFd, rest.as_ptr().cast(), rest.len(), position) };
            if count < 0 {
                return reply.error(last_error());
            }
            if count == 0 {
                break;
            }
            written += count as usize;
        }
        reply.written(written as u32);
    }

    fn flush(
        &self, _req: &Request, _ino: INodeNo, fh: FileHandle, _lock_owner: LockOwner,
        reply: ReplyEmpty,
    ) {
        // Closing a duplicate reports what the caller's own close would.
        // SAFETY: the kernel hands back a descriptor `open` gave it.
        let duplicate = attempt!(reply, cvt(unsafe { libc::dup(fh.0 as RawFd) }));
        // SAFETY: `dup` just returned this descriptor.
        attempt!(reply, cvt(unsafe { libc::close(duplicate) }));
        reply.ok();
    }

    fn release(
        &self, _req: &Request, _ino: INodeNo, fh: FileHandle, _flags: OpenFlags,
        _lock_owner: Option<LockOwner>, _flush: bool, reply: ReplyEmpty,
    ) {
        // SAFETY: the kernel releases each descriptor `open` gave it once.
        unsafe { libc::close(fh.0 as RawFd) };
        reply.ok();
    }

    fn fsync(
        &self, _req: &Request, _ino: INodeNo, fh: FileHandle, datasync: bool, reply: ReplyEmpty,
    ) {
        // SAFETY: the kernel hands back a descriptor `open` gave it.
        let synced = unsafe {
            if datasync {
                libc::fdatasync(fh.0 as RawFd)
            } else {
                libc::fsync(fh.0 as RawFd)
            }
        };
        attempt!(reply, cvt(synced));
        reply.ok();
    }

    fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let node = attempt!(reply, self.node(ino));
        let fd = attempt!(reply, Self::reopen(&node, libc::O_RDONLY | libc::O_DIRECTORY));
        reply.opened(FileHandle(fd as u64), FopenFlags::empty());
    }

    fn readdir(
        &self, _req: &Request, ino: INodeNo, fh: FileHandle, offset: u64, mut reply: ReplyDirectory,
    ) {
        if attempt!(reply, self.node(ino)).sealed {
            return reply.ok();
        }
        let listed = read_entries(fh.0 as RawFd, offset, |inode, next, kind, name| {
            reply.add(inode, next, kind, name)
        });
        attempt!(reply, listed);
        reply.ok();
    }

    fn releasedir(
        &self, _req: &Request, _ino: INodeNo, fh: FileHandle, _flags: OpenFlags, reply: ReplyEmpty,
    ) {
        // SAFETY: the kernel releases each descriptor `opendir` gave it once.
        unsafe { libc::close(fh.0 as RawFd) };
        reply.ok();
    }

    fn fsyncdir(
        &self, _req: &Request, _ino: INodeNo, fh: FileHandle, _datasync: bool, reply: ReplyEmpty,
    ) {
        // SAFETY: the kernel hands back a descriptor `opendir` gave it.
        attempt!(reply, cvt(unsafe { libc::fsync(fh.0 as RawFd) }));
        reply.ok();
    }

    fn statfs(&self, _req: &Request, ino: INodeNo, reply: ReplyStatfs) {
        let node = attempt!(reply, self.node(ino));
        // SAFETY: an all-zero statvfs is a valid value for the call to fill.
        let mut status: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `status` is a statvfs the call writes into.
        attempt!(reply, cvt(unsafe { libc::fstatvfs(node.fd.as_raw_fd(), &mut status) }));
        reply.statfs(
            status.f_blocks,
            status.f_bfree,
            status.f_bavail,
            status.f_files,
            status.f_ffree,
            status.f_bsize as u32,
            status.f_namemax as u32,
            status.f_frsize as u32,
        );
    }

    fn setxattr(
        &self, _req: &Request, ino: INodeNo, name: &OsStr, value: &[u8], flags: i32,
        _position: u32, reply: ReplyEmpty,
    ) {
        let (node, name) = attempt!(reply, self.attribute_target(ino, name, true));
        let path = node.path();
        // SAFETY: both strings are NUL-terminated; `value` is `value.len()`
        // bytes long.
        let set = unsafe {
            libc::setxattr(path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), flags)
        };
        attempt!(reply, cvt(set));
        reply.ok();
    }

    fn getxattr(&self, _req: &Request, ino: INodeNo, name: &OsStr, size: u32, reply: ReplyXattr) {
        let (node, name) = attempt!(reply, self.attribute_target(ino, name, false));
        let path = node.path();
        let mut value = vec![0u8; size as usize];
        // SAFETY: both strings are NUL-terminated; the buffer is
        // `value.len()` bytes long, and a zero length only asks for the size.
        let length = unsafe {
            libc::getxattr(path.as_ptr(), name.as_ptr(), value.as_mut_ptr().cast(), value.len())
        };
        let length = attempt!(reply, cvt_long(length as libc::c_long));
        if size == 0 {
            reply.size(length as u32);
        } else {
            reply.data(&value[..length as usize]);
        }
    }

    fn listxattr(&self, _req: &Request, ino: INodeNo, size: u32, reply: ReplyXattr) {
        let (node, _) = attempt!(reply, self.attribute_target(ino, OsStr::new("list"), false));
        let path = node.path();
        let mut names = vec![0u8; size as usize];
        // SAFETY: as in `getxattr`.
        let length =
            unsafe { libc::listxattr(path.as_ptr(), names.as_mut_ptr().cast(), names.len()) };
        let length = attempt!(reply, cvt_long(length as libc::c_long));
        if size == 0 {
            reply.size(length as u32);
        } else {
            reply.data(&names[..length as usize]);
        }
    }

    fn removexattr(&self, _req: &Request, ino: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let (node, name) = attempt!(reply, self.attribute_target(ino, name, true));
        let path = node.path();
        // SAFETY: both strings are NUL-terminated.
        let removed = unsafe { libc::removexattr(path.as_ptr(), name.as_ptr()) };
        attempt!(reply, cvt(removed));
        reply.ok();
    }

    fn access(&self, _req: &Request, ino: INodeNo, mask: AccessFlags, reply: ReplyEmpty) {
        let node = attempt!(reply, self.node(ino));
        let path = node.path();
        // SAFETY: `path` is NUL-terminated and outlives the call.
        let allowed = unsafe { libc::access(path.as_ptr(), mask.bits()) };
        attempt!(reply, cvt(allowed));
        reply.ok();
    }

    fn fallocate(
        &self, _req: &Request, ino: INodeNo, fh: FileHandle, offset: u64, length: u64, mode: i32,
        reply: ReplyEmpty,
    ) {
        let node = attempt!(reply, self.node(ino));
        attempt!(reply, may_change(&node, Some(fh)));
        // SAFETY: the kernel hands back a descriptor `open` gave it.
        let allocated = unsafe {
            libc::fallocate(fh.0 as RawFd, mode, offset as libc::off_t, length as libc::off_t)
        };
        attempt!(reply, cvt(allocated));
        reply.ok();
    }

    fn lseek(
        &self, _req: &Request, _ino: INodeNo, fh: FileHandle, offset: i64, whence: i32,
        reply: ReplyLseek,
    ) {
        // SAFETY: the kernel hands back a descriptor `open` gave it.
        let position = unsafe { libc::lseek(fh.0 as RawFd, offset, whence) };
        let position = attempt!(reply, cvt_long(position));
        reply.offset(position);
    }

    fn copy_file_range(
        &self, _req: &Request, _ino_in: INodeNo, fh_in: FileHandle, offset_in: u64,
        ino_out: INodeNo, fh_out: FileHandle, offset_out: u64, len: u64, flags: CopyFileRangeFlags,
        reply: ReplyWrite,
    ) {
        let node = attempt!(reply, self.node(ino_out));
        attempt!(reply, may_change(&node, Some(fh_out)));
        let (mut offset_in, mut offset_out) =
            (offset_in as libc::off64_t, offset_out as libc::off64_t);
        // SAFETY: both descriptors are ones `open` gave the kernel, and the
        // offsets are locals the call may advance.
        let copied = unsafe {
            libc::copy_file_range(
                fh_in.0 as RawFd,
                &mut offset_in,
                fh_out.0 as RawFd,
                &mut offset_out,
                len as usize,
                flags.bits() as libc::c_uint,
            )
        };
        let copied = attempt!(reply, cvt_long(copied as libc::c_long));
        reply.written(copied as u32);
    }
}

impl BibliographyFilter {
    /// The file an extended-attribute call is for. Links have none worth
    /// serving, and their descriptor path would be followed to the target.
    fn attribute_target(
        &self, id: INodeNo, name: &OsStr, changes: bool,
    ) -> Result<(Arc<Node>, CString), Errno> {
        let node = self.node(id)?;
        if node.is(libc::S_IFLNK) {
            return Err(Errno::EPERM);
        }
        if changes {
            may_change(&node, None)?;
        }
        let name = CString::new(name.as_bytes()).map_err(|_| Errno::EINVAL)?;
        Ok((node, name))
    }
}
