//! Keeping the sandbox from the host's abstract Unix sockets.
//!
//! An abstract socket has a name but no file. It belongs to the network
//! namespace, which the sandbox shares with the host so the providers reach
//! their servers, so no mount hides it. The X server listens on one beside
//! its file in `/tmp/.X11-unix`, and commonly lets every process of the user
//! connect without a cookie (`SI:localuser`): through it the sandbox could
//! type into other windows. A session bus that `dbus-launch` started may have
//! no other address. Landlock's scope for abstract sockets (Linux 6.12)
//! refuses a connection to one made outside the sandbox; the guard puts the
//! process that becomes bubblewrap under it, and everything bubblewrap starts
//! stays under it. An older kernel has no such scope, and neither has a
//! sandbox a setuid bubblewrap starts: there the agent stays off, unless the
//! writer opted in to run it with reduced isolation (`guard_options`).

use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// `struct landlock_ruleset_attr` up to `scoped`, from `<linux/landlock.h>`.
#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}

/// `landlock_create_ruleset`'s flag that asks for the kernel's ABI version.
const CREATE_RULESET_VERSION: libc::c_uint = 1;
/// `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET`.
const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1;
/// The first Landlock ABI with scopes.
const SCOPED_ABI: libc::c_long = 6;

/// A Landlock ruleset that only scopes abstract sockets: the files the
/// sandbox reaches are the mounts' and the name filter's to decide.
pub(in crate::synara::bibliography_guard) struct AbstractSocketScope(OwnedFd);

impl AbstractSocketScope {
    /// The scope, or why the sandbox started by `bubblewrap` cannot have it.
    pub(in crate::synara::bibliography_guard) fn new(
        bubblewrap: &Path,
    ) -> Result<Self, &'static str> {
        // An unprivileged process enters a ruleset only with `no_new_privs`,
        // which would keep a setuid bubblewrap from becoming root.
        if fs::metadata(bubblewrap).map_or(true, |metadata| metadata.mode() & 0o4000 != 0) {
            return Err("bubblewrap is setuid");
        }
        // SAFETY: a null attribute of size 0 with this flag only asks for the
        // ABI version, and touches no memory.
        let abi = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<RulesetAttr>(),
                0usize,
                CREATE_RULESET_VERSION,
            )
        };
        if abi < SCOPED_ABI {
            return Err("this kernel has no Landlock scopes (they need Linux 6.12)");
        }
        let attr = RulesetAttr {
            handled_access_fs: 0,
            handled_access_net: 0,
            scoped: SCOPE_ABSTRACT_UNIX_SOCKET,
        };
        // SAFETY: `attr` is a valid attribute of the size given, which the
        // call only reads.
        let descriptor = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                &attr,
                size_of::<RulesetAttr>(),
                0 as libc::c_uint,
            )
        };
        if descriptor < 0 {
            return Err("the kernel refused the Landlock ruleset");
        }
        // SAFETY: the call returned a new descriptor, which nothing else owns.
        Ok(Self(unsafe { OwnedFd::from_raw_fd(descriptor as libc::c_int) }))
    }

    /// Put the calling process, and every process it starts from now on,
    /// under the scope for good. Async-signal-safe, for between fork and
    /// exec.
    pub(in crate::synara::bibliography_guard) fn enter(&self) -> io::Result<()> {
        // SAFETY: both calls take integers only, and the descriptor is open
        // for as long as `self` lives.
        let entered = unsafe {
            libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0
                && libc::syscall(libc::SYS_landlock_restrict_self, self.0.as_raw_fd(), 0) == 0
        };
        if entered {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}
