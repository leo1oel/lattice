//! What the Linux sandbox mounts over its filtered root, and which folders
//! that leaves guarded.
//!
//! Every file in the sandbox is reached through the bibliography name filter
//! unless a mount here covers it:
//!
//! - system folders straight from the host, read-only, so programs load at
//!   full speed;
//! - an empty `/run` of the sandbox's own. A read-only mount still lets a
//!   socket in it be connected to, and through a container engine's there
//!   (`/run/docker.sock`, `/run/podman/podman.sock`) a process can start a
//!   container with any host folder mounted in it, outside the filter. All
//!   it gets back is the file the resolver is configured in, read-only, and
//!   the links in `/run` and on the way there from `/etc/resolv.conf`, as
//!   links ([`from_run`]); removable drives under `/run/media` are filtered
//!   as anywhere else;
//! - `/dev` and a `/proc` of the sandbox's own process namespace, so no host
//!   process can be reached through `/proc/<pid>/root`, signalled or traced;
//! - `/tmp` and the hidden folders of the home folder straight from the
//!   host, writable. They hold the providers' own state, whose SQLite files
//!   and sockets must be the very ones a provider running outside Lattice
//!   uses, and neither survives a FUSE layer in between. No bibliography
//!   there is guarded, so Lattice refuses to run the agent on a project in
//!   one of them ([`Layout::guards`]);
//! - an empty folder of the sandbox's own over the user's runtime folder
//!   (`XDG_RUNTIME_DIR`), wherever it is, and over the X server's sockets.
//!   Through the session bus there the sandbox could start a process outside
//!   itself (systemd's user
//!   manager, the portals) or read the keyring Lattice keeps its credentials
//!   in, which has no access control of its own; through the display it
//!   could type into other windows. Nothing is bound back, so what reads the
//!   keyring or opens a window from inside no longer can;
//! - the folder the writer's opt-ins for this sandbox are kept in
//!   (`guard_options`), read-only: the agent writes the rest of Lattice's
//!   data folder, and must not turn them on for itself.
//!
//! The SSH agent's socket is a file of its own, wherever `SSH_AUTH_SOCK`
//! names it. The sandbox has it only when the writer asked
//! ([`Layout::with_ssh_agent`]): bound alone, not with the folder it is in.
//! Otherwise the variable is unset, and a socket none of the mounts above
//! hides (one in `/tmp`, or in `~/.ssh`) is covered.
//!
//! A hard link or a rename cannot cross from one of those mounts into the
//! filter, and the sidecar cannot change the mounts: bubblewrap drops its
//! capabilities before it starts the sidecar, and a namespace nested inside
//! gets them locked. Hiding a socket's file does not hide an abstract one,
//! which is the guard's to refuse (`linux.rs`).

use crate::synara::guard_options::GuardOptions;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::fs::FileTypeExt;
use std::path::{Path, PathBuf};

/// Folders the sandbox takes from the host as they are, read-only: programs,
/// libraries and configuration, and the kernel's `/sys`.
const READ_ONLY: [&str; 11] = [
    "/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/nix", "/gnu", "/sys",
];

/// The daemons' sockets and state. The sandbox has one of its own.
const RUN: &str = "/run";

/// What names the system's resolver, commonly through a link into `/run`.
const RESOLVER: &str = "/etc/resolv.conf";

/// Where the X server's sockets are, in the host's `/tmp`.
const X11_SOCKETS: &str = "/tmp/.X11-unix";

/// What tells a program where the session bus, the display and GnuPG's agent
/// are. With the sockets gone the values would only point at nothing.
const SESSION_VARIABLES: [&str; 6] = [
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "XAUTHORITY",
    "GPG_AGENT_INFO",
];

/// What tells a program where the SSH agent's socket is.
const SSH_AGENT_VARIABLE: &str = "SSH_AUTH_SOCK";

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
    /// Links made in the sandbox's own `/run` once it is mounted: where, and
    /// what each points to.
    links: Vec<(PathBuf, PathBuf)>,
    /// The SSH agent's socket on the host, and whether the sandbox gets it.
    ssh_agent: Option<(PathBuf, bool)>,
}

impl Layout {
    /// The layout for the user whose home folder is `home` and whose runtime
    /// folders are `runtime`, with the sidecar's own state in `agent_home`.
    /// All are given as the host resolves them: a mount is made on a real
    /// folder, not through a link.
    pub(super) fn new(home: Option<&Path>, runtime: &[PathBuf], agent_home: &Path) -> Self {
        let real_folder =
            |path: &Path| fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir());
        let mut mounts =
            vec![(PathBuf::from("/dev"), View::Devices), (PathBuf::from("/proc"), View::Processes)];
        // Under `/run`, removable drives on some distributions: a project on
        // one is the agent's to work on like any other.
        let fixed = [("/dev/shm", View::Private)]
            .into_iter()
            .chain(READ_ONLY.map(|path| (path, View::ReadOnly)))
            .chain([(RUN, View::Private), ("/run/media", View::Filtered), ("/tmp", View::Direct)])
            .chain([(X11_SOCKETS, View::Private)]);
        mounts.extend(
            fixed
                .map(|(path, view)| (PathBuf::from(path), view))
                .filter(|(path, _)| real_folder(path)),
        );
        let (resolver, links) = if real_folder(Path::new(RUN)) {
            from_run(Path::new(RESOLVER), Path::new(RUN))
        } else {
            (Vec::new(), Vec::new())
        };
        mounts.extend(resolver.into_iter().map(|file| (file, View::ReadOnly)));
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
        // The writer's opt-ins for this sandbox are not the agent's to change.
        // The guard makes the folder before it starts the sandbox, so there
        // is always one to mount, and none the agent could make later.
        let options = GuardOptions::folder(agent_home).filter(|folder| real_folder(folder));
        mounts.extend(options.map(|folder| (folder, View::ReadOnly)));
        mounts.push((agent_home.to_path_buf(), View::Direct));
        // Last, over whichever mount above shows them: `/tmp` where a system
        // keeps them there, or the sandbox's own `/run`, where the folder
        // would otherwise be missing for a program that expects one.
        mounts.extend(
            runtime
                .iter()
                .filter(|path| real_folder(path))
                .map(|path| (path.clone(), View::Private)),
        );
        Self { mounts, links, ssh_agent: None }
    }

    /// The layout with the SSH agent listening on `socket`, a path as the
    /// host resolves it: the sandbox's to use when `forwarded`, and otherwise
    /// kept from it.
    pub(super) fn with_ssh_agent(mut self, socket: Option<PathBuf>, forwarded: bool) -> Self {
        self.ssh_agent = socket.map(|socket| (socket, forwarded));
        self
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
        for variable in SESSION_VARIABLES {
            add(&["--unsetenv", variable].map(OsStr::new));
        }
        match &self.ssh_agent {
            // By the path the socket is bound at below, whatever link the
            // variable named it through outside.
            Some((socket, true)) => {
                add(&["--setenv".as_ref(), SSH_AGENT_VARIABLE.as_ref(), socket.as_os_str()]);
            }
            _ => add(&["--unsetenv", SSH_AGENT_VARIABLE].map(OsStr::new)),
        }
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
        for (link, target) in &self.links {
            add(&["--symlink".as_ref(), target.as_os_str(), link.as_os_str()]);
        }
        match &self.ssh_agent {
            // Over the empty runtime folder, if it is in there: the socket
            // alone, with nothing else of the folder beside it.
            Some((socket, true)) => {
                add(&["--bind".as_ref(), socket.as_os_str(), socket.as_os_str()])
            }
            // Unsetting the variable hides no socket the sandbox can find by
            // looking: one in a folder it has from the host is covered.
            Some((socket, false)) if self.view(socket) != View::Private => {
                add(&["--ro-bind".as_ref(), "/dev/null".as_ref(), socket.as_os_str()]);
            }
            _ => {}
        }
        // The folder the filter is mounted in, covered last, over whichever
        // mount above shows it: through the filter's mount the sandbox would
        // see the host's whole tree, with what it has read-only or of its own
        // (`/run`, `/dev/shm`) as the host has them.
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

/// The user's runtime folders, as the host resolves them: the one
/// `XDG_RUNTIME_DIR` names, and systemd's `/run/user/<uid>`, which is where
/// a program looks for the session bus when that variable is unset.
pub(super) fn runtime_folders() -> Vec<PathBuf> {
    // SAFETY: `getuid` takes nothing and cannot fail.
    let systemd = PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() }));
    let named = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    let mut folders: Vec<PathBuf> = named
        .into_iter()
        .chain([systemd])
        .filter(|folder| folder.is_absolute())
        .filter_map(|folder| fs::canonicalize(folder).ok())
        // Not `/`, which would take the whole tree with it.
        .filter(|folder| folder.parent().is_some())
        .collect();
    folders.dedup();
    folders
}

/// What the sandbox has back of the host's `run` folder, as the host
/// resolves it: the file that `resolver` leads to, if it is in there, to be
/// bound read-only (`/run/systemd/resolve/stub-resolv.conf`,
/// `/run/NetworkManager/resolv.conf`, …), and the links on the way there and
/// directly in `run`, to be made again. A link is resolved inside the
/// sandbox, so it reaches nothing the sandbox has not got already; NixOS and
/// Guix keep the system's programs behind one (`/run/current-system`).
/// Nothing else: not a socket, and not the folder the file is in, beside
/// which systemd-resolved listens.
fn from_run(resolver: &Path, run: &Path) -> (Vec<PathBuf>, Vec<(PathBuf, PathBuf)>) {
    let mut links: Vec<(PathBuf, PathBuf)> = fs::read_dir(run)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| Some((entry.path(), fs::read_link(entry.path()).ok()?)))
        .collect();
    let mut files = Vec::new();
    let mut next = resolver.to_path_buf();
    // No further than the kernel follows links before it gives up.
    for _ in 0..40 {
        let (Some(folder), Some(name)) = (next.parent(), next.file_name()) else { break };
        // Each step where it really is, whatever links its folders are
        // reached through (`/var/run`, `/etc/../run`).
        let Ok(folder) = fs::canonicalize(folder) else { break };
        let at = folder.join(name);
        let Ok(target) = fs::read_link(&at) else {
            if at.starts_with(run) && at.is_file() {
                files.push(at);
            }
            break;
        };
        next = folder.join(&target);
        if at.starts_with(run) {
            links.push((at, target));
        }
    }
    links.sort();
    links.dedup();
    (files, links)
}

/// The SSH agent's socket, as the host resolves it: what `SSH_AUTH_SOCK`
/// names, when that is a socket.
pub(super) fn ssh_agent_socket() -> Option<PathBuf> {
    let named = PathBuf::from(std::env::var_os(SSH_AGENT_VARIABLE)?);
    let socket = fs::canonicalize(named).ok()?;
    fs::metadata(&socket).is_ok_and(|metadata| metadata.file_type().is_socket()).then_some(socket)
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
            ("/run", View::Private),
            ("/run/media", View::Filtered),
            ("/tmp", View::Direct),
            ("/tmp/.X11-unix", View::Private),
            ("/run/systemd/resolve/stub-resolv.conf", View::ReadOnly),
            ("/home/ada/.cache", View::Direct),
            ("/home/ada/.local", View::Direct),
            ("/home/ada/.local/share/lattice", View::Filtered),
            ("/home/ada/.local/share/lattice/agent-guard", View::ReadOnly),
            ("/home/ada/.local/share/lattice/synara", View::Direct),
            ("/run/user/1000", View::Private),
        ];
        let mounts = mounts.map(|(path, view)| (PathBuf::from(path), view)).to_vec();
        let links =
            [("/run/current-system", "/nix/store/0-nixos-system"), ("/run/shm", "/dev/shm")];
        let links = links.map(|(at, to)| (PathBuf::from(at), PathBuf::from(to))).to_vec();
        Layout { mounts, links, ssh_agent: None }
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
            "/home/ada/.local/share/lattice/agent-guard/paper",
            "/run/user/1000/paper",
            "/run/user/1001/paper",
            "/run/lock/paper",
            "/run/systemd/resolve",
            "/tmp/.X11-unix/paper",
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
            &["--unsetenv", "DBUS_SESSION_BUS_ADDRESS", "--unsetenv", "DISPLAY"],
            &["--unsetenv", "WAYLAND_DISPLAY", "--unsetenv", "WAYLAND_SOCKET"],
            &["--unsetenv", "XAUTHORITY", "--unsetenv", "GPG_AGENT_INFO"],
            &["--unsetenv", "SSH_AUTH_SOCK"],
            &["--bind", filter, "/"],
            &["--dev-bind", "/dev", "/dev"],
            &["--proc", "/proc"],
            &["--tmpfs", "/dev/shm"],
            &["--ro-bind", "/usr", "/usr"],
            &["--tmpfs", "/run"],
            &["--bind", &drives, "/run/media"],
            &["--bind", "/tmp", "/tmp"],
            &["--tmpfs", "/tmp/.X11-unix"],
            &[
                "--ro-bind",
                "/run/systemd/resolve/stub-resolv.conf",
                "/run/systemd/resolve/stub-resolv.conf",
            ],
            &["--bind", "/home/ada/.cache", "/home/ada/.cache"],
            &["--bind", "/home/ada/.local", "/home/ada/.local"],
            &["--bind", &through, app_data],
            &[
                "--ro-bind",
                "/home/ada/.local/share/lattice/agent-guard",
                "/home/ada/.local/share/lattice/agent-guard",
            ],
            &[
                "--bind",
                "/home/ada/.local/share/lattice/synara",
                "/home/ada/.local/share/lattice/synara",
            ],
            &["--tmpfs", "/run/user/1000"],
            &["--symlink", "/nix/store/0-nixos-system", "/run/current-system"],
            &["--symlink", "/dev/shm", "/run/shm"],
            &["--tmpfs", "/run/user/1000/lattice-agent-guard"],
        ]
        .concat();
        assert_eq!(arguments, expected);
    }

    /// What `arguments` says about the SSH agent, for one listening on
    /// `socket`: the variable's, then the socket's own mount.
    fn ssh_agent_arguments(socket: &str, forwarded: bool) -> (Vec<String>, Vec<String>) {
        let layout = layout().with_ssh_agent(Some(PathBuf::from(socket)), forwarded);
        let arguments = layout.arguments(Path::new("/run/user/1000/lattice-agent-guard/7"));
        let arguments: Vec<String> =
            arguments.iter().map(|value| value.to_string_lossy().into_owned()).collect();
        let about = |found: &dyn Fn(&[String]) -> bool| {
            let at = (0..arguments.len()).find(|&at| found(&arguments[at..]));
            at.map_or(Vec::new(), |at| arguments[at..at + 3.min(arguments.len() - at)].to_vec())
        };
        let variable = about(&|rest| rest.len() > 1 && rest[1] == "SSH_AUTH_SOCK");
        let mount = about(&|rest| rest.len() > 2 && rest[0].ends_with("bind") && rest[2] == socket);
        // The socket's mount comes after the folder it may be in is emptied.
        let emptied = arguments.windows(2).position(|pair| pair == ["--tmpfs", "/run/user/1000"]);
        let mounted = arguments
            .windows(3)
            .position(|triple| triple[0].ends_with("bind") && triple[2] == socket);
        assert!(mounted.is_none_or(|mounted| emptied.is_some_and(|emptied| emptied < mounted)));
        (variable, mount)
    }

    #[test]
    fn the_ssh_agent_reaches_the_sandbox_only_when_the_writer_forwards_it() {
        let strings = |values: &[&str]| values.iter().map(|value| value.to_string()).collect();
        let (in_runtime, in_tmp) = ("/run/user/1000/gcr/ssh", "/tmp/ssh-Xa1/agent.7");
        for socket in [in_runtime, in_tmp, "/home/ada/.ssh/agent/s.1"] {
            let (variable, mount) = ssh_agent_arguments(socket, true);
            let expected: Vec<String> = strings(&["--setenv", "SSH_AUTH_SOCK", socket]);
            assert_eq!(variable, expected, "{socket}");
            let expected: Vec<String> = strings(&["--bind", socket, socket]);
            assert_eq!(mount, expected, "{socket}");
        }
        // Not forwarded: gone with the runtime folder, with nothing bound.
        let (variable, mount) = ssh_agent_arguments(in_runtime, false);
        assert_eq!(variable[..2], ["--unsetenv", "SSH_AUTH_SOCK"]);
        assert!(mount.is_empty(), "{mount:?}");
        // In a folder the sandbox has from the host: covered.
        for socket in [in_tmp, "/home/ada/.cache/agent.sock", "/home/ada/agent.sock"] {
            let (variable, mount) = ssh_agent_arguments(socket, false);
            assert_eq!(variable[..2], ["--unsetenv", "SSH_AUTH_SOCK"], "{socket}");
            let expected: Vec<String> = strings(&["--ro-bind", "/dev/null", socket]);
            assert_eq!(mount, expected, "{socket}");
        }
    }

    /// The runtime folder here is under the system temp dir, which the
    /// sandbox takes from the host: it is only hidden if its own mount comes
    /// after that one.
    #[test]
    fn the_runtime_folder_is_hidden_and_every_mount_follows_its_parents() {
        let scratch = crate::test_support::TempDir::new("bib-guard-layout");
        let scratch = fs::canonicalize(&scratch).unwrap();
        let (home, runtime) = (scratch.join("home"), scratch.join("runtime"));
        let agent_home = home.join(".local/share/lattice/synara");
        for folder in [&home.join(".cache"), &agent_home, &runtime] {
            fs::create_dir_all(folder).unwrap();
        }
        let layout = Layout::new(Some(&home), std::slice::from_ref(&runtime), &agent_home);
        assert_eq!(layout.view(&runtime.join("bus")), View::Private);
        assert!(!layout.guards(&runtime));
        for (index, (mount, _)) in layout.mounts.iter().enumerate() {
            let parent = layout.mounts[index + 1..]
                .iter()
                .find(|(other, _)| other != mount && mount.starts_with(other));
            if let Some((parent, _)) = parent {
                panic!(
                    "{} is mounted before {}, which covers it",
                    mount.display(),
                    parent.display()
                );
            }
        }
    }

    /// The resolver's file and the links to it come back from `/run`, as
    /// the host resolves them, and nothing else there does: not the socket
    /// beside the file, nor a container engine's.
    #[test]
    fn of_run_the_sandbox_gets_the_resolvers_file_and_the_links() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;
        let scratch = crate::test_support::TempDir::new("bib-guard-run");
        let scratch = fs::canonicalize(&scratch).unwrap();
        let (etc, run) = (scratch.join("etc"), scratch.join("run"));
        let resolve = run.join("systemd/resolve");
        for folder in [&etc, &resolve, &run.join("NetworkManager"), &scratch.join("var")] {
            fs::create_dir_all(folder).unwrap();
        }
        let stub = resolve.join("stub-resolv.conf");
        fs::write(&stub, "nameserver 127.0.0.53\n").unwrap();
        let _listeners = [resolve.join("io.systemd.Resolve"), run.join("docker.sock")]
            .map(|socket| UnixListener::bind(socket).unwrap());
        symlink("/nix/store/0-nixos-system", run.join("current-system")).unwrap();
        symlink("../run", scratch.join("var/run")).unwrap();
        // systemd-resolved's, through a relative link, and through a second
        // link in `/run` as `resolvconf` makes it.
        symlink("../run/systemd/resolve/stub-resolv.conf", etc.join("resolved")).unwrap();
        let resolvconf = run.join("resolv.conf");
        symlink(&stub, &resolvconf).unwrap();
        symlink("../run/resolv.conf", etc.join("resolvconf")).unwrap();
        // NetworkManager's, through `/var/run`.
        let manager = run.join("NetworkManager/resolv.conf");
        fs::write(&manager, "nameserver 192.0.2.1\n").unwrap();
        symlink("../var/run/NetworkManager/resolv.conf", etc.join("manager")).unwrap();
        // One of the host's own, a missing one, and a loop.
        fs::write(etc.join("own"), "nameserver 192.0.2.2\n").unwrap();
        symlink("../run/missing.conf", etc.join("missing")).unwrap();
        symlink("loop", run.join("loop")).unwrap();
        symlink("../run/loop", etc.join("looping")).unwrap();

        let in_run = |at: &str, to: &str| (run.join(at), PathBuf::from(to));
        let links_in_run = [
            in_run("current-system", "/nix/store/0-nixos-system"),
            in_run("loop", "loop"),
            (resolvconf.clone(), stub.clone()),
        ];
        for (resolver, files) in [
            ("resolved", vec![stub.clone()]),
            ("resolvconf", vec![stub.clone()]),
            ("manager", vec![manager.clone()]),
            ("own", vec![]),
            ("missing", vec![]),
            ("looping", vec![]),
        ] {
            let (found, links) = from_run(&etc.join(resolver), &run);
            assert_eq!(found, files, "{resolver}");
            assert_eq!(links, links_in_run.to_vec(), "{resolver}");
        }
    }
}
