//! The host's own file calls, which the filter passes operations through to,
//! and their results in the types FUSE answers with.

use fuser::{Errno, FileAttr, FileType, INodeNo, TimeOrNow};
use std::ffi::{CStr, CString, OsStr};
use std::io;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROC_SUPER_MAGIC: libc::c_long = 0x9fa0;
/// The path that, with `AT_EMPTY_PATH`, names the descriptor itself.
pub(super) const EMPTY: &CStr = c"";

/// Open the folder at `source` to name it, not to read it.
pub(super) fn open_folder(source: &Path) -> io::Result<OwnedFd> {
    let source = CString::new(source.as_os_str().as_bytes())?;
    let flags = libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC;
    // SAFETY: `source` is a NUL-terminated path that outlives the call.
    let fd = cvt(unsafe { libc::open(source.as_ptr(), flags) })?;
    // SAFETY: `open` just returned this descriptor, owned by nothing else.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Open `name` in the folder `parent` to name it, without following it when
/// it is a link.
pub(super) fn open_child(parent: RawFd, name: &CStr) -> io::Result<OwnedFd> {
    let flags = libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: `name` is NUL-terminated and `parent` is an open descriptor.
    let fd = cvt(unsafe { libc::openat(parent, name.as_ptr(), flags) })?;
    // SAFETY: `openat` just returned this descriptor, owned by nothing else.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Hand `add` the entries of the open folder `fd` from `offset` on, each
/// with its inode number and the offset of the entry after it, until `add`
/// answers that it is full or the folder ends. An entry's offset is the
/// kernel's own cookie for the one after it, so a later call can resume from
/// any offset this one handed out.
pub(super) fn read_entries(
    fd: RawFd, offset: u64, mut add: impl FnMut(INodeNo, u64, FileType, &OsStr) -> bool,
) -> io::Result<()> {
    // SAFETY: `lseek` takes a descriptor and two integers.
    cvt_long(unsafe { libc::lseek(fd, offset as libc::off_t, libc::SEEK_SET) })?;
    let mut buffer = vec![0u8; 32 * 1024];
    loop {
        // SAFETY: the buffer is `buffer.len()` bytes long.
        let length =
            unsafe { libc::syscall(libc::SYS_getdents64, fd, buffer.as_mut_ptr(), buffer.len()) };
        let length = cvt_long(length)? as usize;
        if length == 0 {
            return Ok(());
        }
        let mut position = 0;
        while position < length {
            // SAFETY: getdents64 wrote whole `dirent64` records into the
            // first `length` bytes, each `d_reclen` long with a
            // NUL-terminated name.
            let (inode, next, kind, name, record) = unsafe {
                let entry = buffer.as_ptr().add(position).cast::<libc::dirent64>();
                let name = CStr::from_ptr((&raw const (*entry).d_name).cast());
                (
                    (&raw const (*entry).d_ino).read_unaligned(),
                    (&raw const (*entry).d_off).read_unaligned(),
                    (&raw const (*entry).d_type).read_unaligned(),
                    name,
                    usize::from((&raw const (*entry).d_reclen).read_unaligned()),
                )
            };
            position += record;
            let name = OsStr::from_bytes(name.to_bytes());
            if add(INodeNo(inode), next as u64, entry_kind(kind), name) {
                return Ok(());
            }
        }
    }
}

pub(super) fn descriptor_path(fd: RawFd) -> CString {
    CString::new(format!("/proc/self/fd/{fd}")).unwrap_or_default()
}

pub(super) fn last_error() -> Errno {
    Errno::from(io::Error::last_os_error())
}

pub(super) fn cvt(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

pub(super) fn cvt_long(result: libc::c_long) -> io::Result<libc::c_long> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

pub(super) fn status_of(fd: RawFd) -> io::Result<libc::stat> {
    // SAFETY: an all-zero stat is a valid value for the call to fill.
    let mut status: libc::stat = unsafe { std::mem::zeroed() };
    let flags = libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW;
    // SAFETY: an empty path with AT_EMPTY_PATH names `fd` itself, and
    // `status` is a stat the call writes into.
    cvt(unsafe { libc::fstatat(fd, EMPTY.as_ptr(), &mut status, flags) })?;
    Ok(status)
}

pub(super) fn is_procfs(fd: RawFd) -> io::Result<bool> {
    // SAFETY: an all-zero statfs is a valid value for the call to fill.
    let mut status: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: `status` is a statfs the call writes into.
    cvt(unsafe { libc::fstatfs(fd, &mut status) })?;
    Ok(status.f_type as libc::c_long == PROC_SUPER_MAGIC)
}

pub(super) fn timespec(time: Option<TimeOrNow>) -> libc::timespec {
    match time {
        None => libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT },
        Some(TimeOrNow::Now) => libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_NOW },
        Some(TimeOrNow::SpecificTime(time)) => {
            let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
            libc::timespec {
                tv_sec: since.as_secs() as libc::time_t,
                tv_nsec: libc::c_long::from(since.subsec_nanos()),
            }
        }
    }
}

fn time(seconds: libc::time_t, nanoseconds: libc::c_long) -> SystemTime {
    match u64::try_from(seconds) {
        Ok(seconds) => UNIX_EPOCH + Duration::new(seconds, nanoseconds as u32),
        Err(_) => UNIX_EPOCH,
    }
}

pub(super) fn attributes(status: &libc::stat) -> FileAttr {
    FileAttr {
        ino: INodeNo(status.st_ino),
        size: status.st_size as u64,
        blocks: status.st_blocks as u64,
        atime: time(status.st_atime, status.st_atime_nsec),
        mtime: time(status.st_mtime, status.st_mtime_nsec),
        ctime: time(status.st_ctime, status.st_ctime_nsec),
        crtime: UNIX_EPOCH,
        kind: file_kind(status.st_mode & libc::S_IFMT),
        perm: (status.st_mode & 0o7777) as u16,
        nlink: status.st_nlink as u32,
        uid: status.st_uid,
        gid: status.st_gid,
        rdev: status.st_rdev as u32,
        blksize: status.st_blksize as u32,
        flags: 0,
    }
}

fn file_kind(kind: libc::mode_t) -> FileType {
    match kind {
        libc::S_IFDIR => FileType::Directory,
        libc::S_IFLNK => FileType::Symlink,
        libc::S_IFIFO => FileType::NamedPipe,
        libc::S_IFSOCK => FileType::Socket,
        libc::S_IFCHR => FileType::CharDevice,
        libc::S_IFBLK => FileType::BlockDevice,
        _ => FileType::RegularFile,
    }
}

pub(super) fn entry_kind(kind: u8) -> FileType {
    match kind {
        libc::DT_DIR => FileType::Directory,
        libc::DT_LNK => FileType::Symlink,
        libc::DT_FIFO => FileType::NamedPipe,
        libc::DT_SOCK => FileType::Socket,
        libc::DT_CHR => FileType::CharDevice,
        libc::DT_BLK => FileType::BlockDevice,
        _ => FileType::RegularFile,
    }
}
