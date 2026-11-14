//! The rule: which changes are a bibliography's, and so refused.

use fuser::{Errno, OpenAccMode, OpenFlags};
use std::ffi::OsStr;
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
