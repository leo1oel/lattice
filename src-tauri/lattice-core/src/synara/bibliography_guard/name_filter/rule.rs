//! The rule: which changes are a bibliography's, and so refused.

use super::host::current_name;
use super::nodes::Node;
use fuser::{Errno, FileHandle, OpenAccMode, OpenFlags};
use std::ffi::OsStr;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;

/// What a refused bibliography change answers, as Seatbelt's deny does.
pub(super) const DENIED: Errno = Errno::EPERM;

/// Whether changing `name` is a bibliography change: the Seatbelt profile's
/// `.*[.][bB][iI][bB]$`, on the last component.
pub(super) fn is_bibliography(name: &OsStr) -> bool {
    let name = name.as_bytes();
    name.len() >= 4 && name[name.len() - 4..].eq_ignore_ascii_case(b".bib")
}

/// Whether an open with `flags` can change what the file holds.
pub(super) fn changes_content(flags: libc::c_int) -> bool {
    OpenFlags(flags).acc_mode() != OpenAccMode::O_RDONLY || flags & libc::O_TRUNC != 0
}

/// Whether the file `node` names is a bibliography, by a name it was looked
/// up by or by the name it has now, which `fh`, when the kernel gives one,
/// holds open too. Lattice renames files outside the sandbox, its own writes
/// among them, and a file opened before a rename onto a `*.bib` name is
/// still open after it, so the name is read again from the open file each
/// time, not kept from the lookup.
pub(super) fn is_named_bibliography(node: &Node, fh: Option<FileHandle>) -> Result<bool, Errno> {
    let named = |fd: RawFd| current_name(fd).map(|name| is_bibliography(&name));
    let renamed = match fh {
        Some(fh) => named(fh.0 as RawFd)?,
        None => false,
    };
    Ok(node.is_bibliography() || renamed || named(node.fd.as_raw_fd())?)
}

/// Refuse a change to what the file `node` names holds, or to its
/// attributes, if it is a bibliography.
pub(super) fn may_change(node: &Node, fh: Option<FileHandle>) -> Result<(), Errno> {
    if is_named_bibliography(node, fh)? {
        return Err(DENIED);
    }
    Ok(())
}
