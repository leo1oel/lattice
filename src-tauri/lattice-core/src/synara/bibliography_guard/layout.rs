//! What the Linux sandbox mounts over its filtered root, and which folders
//! that leaves guarded.
//!
//! Every file in the sandbox is reached through the bibliography name filter
//! unless a mount here covers it:
//!
//! - system folders and `/run` straight from the host, read-only, so
//!   programs load at full speed and the session's sockets still connect;
//! - `/dev` and a `/proc` of the sandbox's own process namespace, so no host
//!   process can be reached through `/proc/<pid>/root`, signalled or traced;
//! - `/tmp` and the hidden folders of the home folder straight from the
//!   host, writable. They hold the providers' own state, whose SQLite files
//!   and sockets must be the very ones a provider running outside Lattice
//!   uses, and neither survives a FUSE layer in between. No bibliography
//!   there is guarded, so Lattice refuses to run the agent on a project in
//!   one of them ([`Layout::guards`]).
//!
//! A hard link or a rename cannot cross from one of those mounts into the
//! filter, and the sidecar cannot change the mounts: bubblewrap drops its
//! capabilities before it starts the sidecar, and a namespace nested inside
//! gets them locked.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

/// Folders the sandbox takes from the host as they are, read-only: programs,
/// libraries and configuration, the kernel's `/sys`, and `/run` with the
/// session's sockets.
const READ_ONLY: [&str; 12] = [
    "/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/nix", "/gnu", "/sys",
    "/run",
];

/// How the sandbox sees one folder and everything under it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum View {
    /// Through the name filter: writable, except bibliographies.
    Filtered,
    /// The host's own folder, writable, bibliographies included.
    Direct,
    /// The host's own folder, read-only.
    ReadOnly,
    /// The host's devices.
    Devices,
    /// A folder of the sandbox's own that the host never sees.
    Private,
    /// The sandbox's own process table.
    Processes,
}

/// What the sandbox mounts over the filtered root, outermost first.
pub(super) struct Layout {
    mounts: Vec<(PathBuf, View)>,
}

impl Layout {
    /// The layout for the user whose home folder is `home`, with the
    /// sidecar's own state in `agent_home`. Both are given as the host
    /// resolves them: a mount is made on a real folder, not through a link.
    pub(super) fn new(home: Option<&Path>, agent_home: &Path) -> Self {
        let real_folder =
            |path: &Path| fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir());
        let mut mounts =
            vec![(PathBuf::from("/dev"), View::Devices), (PathBuf::from("/proc"), View::Processes)];
        // Under the read-only `/run`, removable drives on some distributions:
        // a project on one is the agent's to work on like any other.
        let fixed = [("/dev/shm", View::Private)]
            .into_iter()
            .chain(READ_ONLY.map(|path| (path, View::ReadOnly)))
            .chain([("/run/media", View::Filtered), ("/tmp", View::Direct)]);
        mounts.extend(
            fixed
                .map(|(path, view)| (PathBuf::from(path), view))
                .filter(|(path, _)| real_folder(path)),
        );
        if let Some(home) = home {
            let mut hidden: Vec<PathBuf> = fs::read_dir(home)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|entry| entry.file_name().as_encoded_bytes().starts_with(b"."))
                .map(|entry| entry.path())
                .filter(|path| real_folder(path))
                .collect();
            hidden.sort();
            mounts.extend(hidden.into_iter().map(|path| (path, View::Direct)));
        }
        // Lattice's own data sits in one of those hidden folders and is not
        // the agent's to write, so it goes back behind the filter; only the
        // sidecar's state under it stays direct.
        if let Some(app_data) = agent_home.parent() {
            mounts.push((app_data.to_path_buf(), View::Filtered));
        }
        mounts.push((agent_home.to_path_buf(), View::Direct));
        Self { mounts }
    }

    /// How the sandbox sees `path`: by the innermost mount it is under.
    fn view(&self, path: &Path) -> View {
        // A hidden folder made after the sandbox started is filtered there,
        // and one listed now may not have been direct then. Either way a
        // project in one is not promised a guard.
        self.mounts
            .iter()
            .filter(|(mount, _)| path.starts_with(mount))
            .max_by_key(|(mount, _)| mount.components().count())
            .map_or(View::Filtered, |(_, view)| *view)
    }

    /// Whether a bibliography in the project at `workspace` is behind the
    /// filter, wherever in it the agent writes.
    pub(super) fn guards(&self, workspace: &Path) -> bool {
        let workspace = fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        self.view(&workspace) == View::Filtered
            // A mount inside the project would be a hole in it.
            && !self.mounts.iter().any(|(mount, view)| {
                *view != View::Filtered && mount.starts_with(&workspace)
            })
    }

    /// bubblewrap's arguments for this layout over the name filter mounted
    /// at `filter`.
    pub(super) fn arguments(&self, filter: &Path) -> Vec<OsString> {
        let mut arguments: Vec<OsString> = Vec::new();
        let mut add = |values: &[&OsStr]| arguments.extend(values.iter().map(OsString::from));
        // Its own process namespace, which ends with the guard process, and
        // its own session: with no controlling terminal, nothing in it can
        // type into the terminal Lattice was started from (TIOCSTI,
        // CVE-2017-5226).
        add(&["--unshare-pid", "--die-with-parent", "--new-session"].map(OsStr::new));
        add(&["--bind".as_ref(), filter.as_os_str(), "/".as_ref()]);
        for (path, view) in &self.mounts {
            let path = path.as_os_str();
            match view {
                View::Filtered => {
                    let through =
                        filter.join(Path::new(path).strip_prefix("/").unwrap_or(path.as_ref()));
                    add(&["--bind".as_ref(), through.as_os_str(), path]);
                }
                View::Direct => add(&["--bind".as_ref(), path, path]),
                View::ReadOnly => add(&["--ro-bind".as_ref(), path, path]),
                View::Devices => add(&["--dev-bind".as_ref(), path, path]),
                View::Private => add(&["--tmpfs".as_ref(), path]),
                View::Processes => add(&["--proc".as_ref(), path]),
            }
        }
        // The folder the filter is mounted in, covered last, over whichever
        // mount above shows it: through the filter's mount the sandbox would
        // see the host's whole tree, with what it has read-only or of its own
        // (`/run`, `/dev/shm`) writable.
        if let Some(mounts) = filter.parent().filter(|folder| folder.parent().is_some()) {
            add(&["--tmpfs".as_ref(), mounts.as_os_str()]);
        }
        arguments
    }
}

/// The user's home folder, as the host resolves it.
pub(super) fn home_folder() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let home = fs::canonicalize(home).ok()?;
    // Not `/`, whose hidden folders are nobody's state.
    home.parent().is_some().then_some(home)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> Layout {
        let mounts = [
            ("/dev", View::Devices),
            ("/proc", View::Processes),
            ("/dev/shm", View::Private),
            ("/usr", View::ReadOnly),
            ("/run", View::ReadOnly),
            ("/run/media", View::Filtered),
            ("/tmp", View::Direct),
            ("/home/ada/.cache", View::Direct),
            ("/home/ada/.local", View::Direct),
            ("/home/ada/.local/share/lattice", View::Filtered),
            ("/home/ada/.local/share/lattice/synara", View::Direct),
        ];
        Layout { mounts: mounts.map(|(path, view)| (PathBuf::from(path), view)).to_vec() }
    }

    #[test]
    fn a_project_is_guarded_only_where_its_bibliographies_are_filtered() {
        let layout = layout();
        for guarded in [
            "/home/ada/papers/thesis",
            "/mnt/data/paper",
            "/run/media/ada/drive/paper",
            "/var/tmp/paper",
            "/home/ada/.local/share/lattice/projects/one",
            // Not hidden folders of the home folder itself.
            "/home/ada/papers/.drafts",
            "/home/ada/.cachet",
        ] {
            assert!(layout.guards(Path::new(guarded)), "{guarded}");
        }
        for unguarded in [
            "/tmp/paper",
            "/home/ada/.cache/paper",
            "/home/ada/.local/share/other",
            "/home/ada/.local/share/lattice/synara/workspace",
            "/run/user/1000/paper",
            "/usr/share/doc",
            "/dev/shm/paper",
            // Each holds a folder the sandbox takes straight from the host.
            "/",
            "/home/ada",
        ] {
            assert!(!layout.guards(Path::new(unguarded)), "{unguarded}");
        }
    }

    #[test]
    fn the_sandbox_mounts_the_layout_over_the_filter_in_order() {
        let arguments = layout().arguments(Path::new("/run/user/1000/lattice-agent-guard/7"));
        let arguments: Vec<&str> = arguments.iter().filter_map(|value| value.to_str()).collect();
        let filter = "/run/user/1000/lattice-agent-guard/7";
        let app_data = "/home/ada/.local/share/lattice";
        let through = format!("{filter}{app_data}");
        let drives = format!("{filter}/run/media");
        let expected: Vec<&str> = [
            &["--unshare-pid", "--die-with-parent", "--new-session"][..],
            &["--bind", filter, "/"],
            &["--dev-bind", "/dev", "/dev"],
            &["--proc", "/proc"],
            &["--tmpfs", "/dev/shm"],
            &["--ro-bind", "/usr", "/usr"],
            &["--ro-bind", "/run", "/run"],
            &["--bind", &drives, "/run/media"],
            &["--bind", "/tmp", "/tmp"],
            &["--bind", "/home/ada/.cache", "/home/ada/.cache"],
            &["--bind", "/home/ada/.local", "/home/ada/.local"],
            &["--bind", &through, app_data],
            &[
                "--bind",
                "/home/ada/.local/share/lattice/synara",
                "/home/ada/.local/share/lattice/synara",
            ],
            &["--tmpfs", "/run/user/1000/lattice-agent-guard"],
        ]
        .concat();
        assert_eq!(arguments, expected);
    }
}
