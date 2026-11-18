//! What the sandbox is kept from of the writer's session: the session bus,
//! the display, the host's abstract sockets and the SSH agent, and the two
//! opt-ins that give some of it back (`guard_options`).
//!
//! Some of this needs what a build machine may not have: a user session, or
//! a kernel with Landlock scopes. A test says `skipped` and why when it
//! cannot run, and `checked` when it did, so a run with `--nocapture` shows
//! which it was. Where the machine does have the session, a part of it that
//! does not answer is a failure under `LATTICE_REQUIRE_BIBLIOGRAPHY_GUARD`.

use super::*;
use std::os::linux::net::SocketAddrExt;
use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};

const REDUCED: GuardOptions = GuardOptions { reduced_isolation: true, forward_ssh_agent: false };

/// What a program finds of the session inside: a runtime folder that is
/// empty and its own, and none of the variables that would name the bus,
/// the display or an agent. The runtime folder is a stand-in here, with a
/// socket in it.
#[test]
fn the_sandbox_finds_an_empty_runtime_folder_and_no_session_variables() {
    if !guard_available() {
        return;
    }
    let runtime = Guarded::new();
    let bus = runtime.0.join("bus");
    let _listener = UnixListener::bind(&bus).unwrap();
    let sandbox = Sandbox::with_runtime(std::slice::from_ref(&runtime.0));
    let script = "env | grep -q -E '^(DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|\
         WAYLAND_SOCKET|XAUTHORITY|SSH_AUTH_SOCK|GPG_AGENT_INFO)=' && exit 1; \
         [ -d \"$1\" ] && [ -z \"$(ls -A \"$1\")\" ] || exit 2; \
         : > \"$1/own\" || exit 3; \
         [ ! -d /tmp/.X11-unix ] || [ -z \"$(ls -A /tmp/.X11-unix)\" ] || exit 4; \
         exit 0";
    let status = sandbox
        .command(script)
        .arg(&runtime.0)
        .env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={}", bus.display()))
        .env("DISPLAY", ":0")
        .env("WAYLAND_DISPLAY", "wayland-0")
        .env("WAYLAND_SOCKET", "3")
        .env("XAUTHORITY", runtime.0.join("Xauthority"))
        // Not a socket, so no agent the layout was told of: unset all the same.
        .env("SSH_AUTH_SOCK", runtime.0.join("agent"))
        .env("GPG_AGENT_INFO", runtime.0.join("gpg:0:1"))
        .status()
        .expect("run sandboxed command");
    assert_eq!(status.code(), Some(0), "see the script for what each exit status means");
    // What the sandbox made there went with it.
    assert!(bus.exists() && !runtime.0.join("own").exists());
}

/// Through the session bus a process can have systemd's user manager start
/// another, outside the sandbox and the filter, or read the keyring, where
/// Lattice keeps the model endpoint's key. Each must fail inside wherever
/// the session has it, also with the bus's address put back.
#[test]
fn the_sandbox_cannot_have_systemd_start_a_process_or_search_the_keyring() {
    if !guard_available() {
        return;
    }
    let root = Guarded::new();
    let bibliography = root.write("references.bib", "original");
    let sandbox = Sandbox::new();
    let address = std::env::var_os("DBUS_SESSION_BUS_ADDRESS").unwrap_or_default();
    let systemd_run = "systemd-run --user --quiet --wait --collect --";
    let search = "busctl --user call org.freedesktop.secrets /org/freedesktop/secrets \
         org.freedesktop.Secret.Service SearchItems 'a{ss}' 0";
    let succeeds = |script: &str| {
        Command::new("/bin/sh")
            .args(["-c", script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    };
    // Whether this session has each at all: the user manager's own socket,
    // and a name on the bus, owned or to be started on demand.
    let user_manager =
        runtime_folders().iter().any(|folder| folder.join("systemd/private").exists());
    let secret_service = succeeds("busctl --user list | grep -q '^org.freedesktop.secrets '");
    // What works outside, then what must fail inside: `$1` is the
    // bibliography, and `$2` the bus's address outside.
    let checks = [
        (
            "systemd's user manager",
            user_manager,
            format!("{systemd_run} true"),
            format!("{systemd_run} /bin/sh -c 'printf changed >> \"$1\"' sh \"$1\""),
        ),
        ("the Secret Service", secret_service, search.to_string(), search.to_string()),
    ];
    for (service, present, outside, inside) in checks {
        if !present {
            eprintln!("skipped {service}: this session has none");
            continue;
        }
        if !succeeds(&outside) {
            assert!(!guard_required(), "{service} is here but does not answer outside the sandbox");
            eprintln!("skipped {service}: it does not answer outside the sandbox either");
            continue;
        }
        for script in [inside.clone(), format!("DBUS_SESSION_BUS_ADDRESS=\"$2\" {inside}")] {
            let reached = sandbox
                .command(&script)
                .arg(&bibliography)
                .arg(&address)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("run sandboxed command")
                .success();
            assert!(!reached, "the sandbox reached {service}: {script}");
        }
        eprintln!("checked {service}: it answers outside the sandbox and not inside");
    }
    assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
}

/// What the probe below connects to, when a test runs it inside the
/// sandbox: `abstract:<name>`, `path:<socket>`, or `ssh-agent` for the
/// socket `SSH_AUTH_SOCK` names there.
const SOCKET_PROBE: &str = "LATTICE_GUARD_SOCKET_PROBE";
/// The probe's exit statuses.
const REFUSED: i32 = 0;
const CONNECTED: i32 = 1;
const FAILED: i32 = 2;
const NO_AGENT: i32 = 3;

/// Not a test of its own: inside the sandbox, the test binary itself is the
/// client, as no shell tool reaches an abstract socket. A path that does not
/// connect is `REFUSED` whatever the error; an abstract name only when the
/// kernel said `EPERM`, the scope's answer.
#[test]
fn socket_probe() {
    let Some(target) = std::env::var_os(SOCKET_PROBE) else { return };
    let target = target.to_string_lossy().into_owned();
    let code = if let Some(name) = target.strip_prefix("abstract:") {
        let address = SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
        match UnixStream::connect_addr(&address) {
            Ok(_) => CONNECTED,
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => REFUSED,
            Err(error) => {
                eprintln!("the probe failed otherwise: {error}");
                FAILED
            }
        }
    } else {
        let path = match target.strip_prefix("path:") {
            Some(path) => Some(PathBuf::from(path)),
            None => std::env::var_os("SSH_AUTH_SOCK").map(PathBuf::from),
        };
        match path.map(UnixStream::connect) {
            None => NO_AGENT,
            Some(Ok(_)) => CONNECTED,
            Some(Err(_)) => REFUSED,
        }
    };
    std::process::exit(code);
}

/// [`socket_probe`]'s exit status for `target`, run inside `sandbox` where
/// the host's `SSH_AUTH_SOCK` names `agent`.
fn probe(sandbox: &Sandbox, target: &str, agent: Option<&Path>) -> Option<i32> {
    let test = module_path!().split_once("::").map_or(module_path!(), |(_, path)| path);
    let test = format!("{test}::socket_probe");
    let executable = std::env::current_exe().unwrap();
    let mut command = sandbox.program(&[executable.as_os_str(), "--exact".as_ref(), test.as_ref()]);
    command.env(SOCKET_PROBE, target).env_remove("SSH_AUTH_SOCK").stdout(Stdio::null());
    if let Some(agent) = agent {
        command.env("SSH_AUTH_SOCK", agent);
    }
    command.status().expect("run the probe in the sandbox").code()
}

/// A stand-in for a host process's abstract socket, as the X server's beside
/// its file in `/tmp/.X11-unix`: its name and the listener that keeps it.
fn abstract_listener() -> (String, UnixListener) {
    let name = format!("lattice-guard-test-{}", uuid::Uuid::new_v4());
    let address = SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
    let listener = UnixListener::bind_addr(&address).unwrap();
    // Outside, it is reached as any process reaches it.
    UnixStream::connect_addr(&address).expect("connect outside the sandbox");
    (name, listener)
}

/// A host process's abstract socket is out of the sandbox's reach where the
/// kernel has Landlock scopes, which is the only place the guard starts the
/// sandbox unasked.
#[test]
fn the_sandbox_cannot_connect_to_the_hosts_abstract_sockets() {
    if !guard_available() {
        return;
    }
    let sandbox = Sandbox::new();
    if let Err(reason) = AbstractSocketScope::new(&sandbox.bubblewrap) {
        eprintln!("skipped, the agent stays off here unless the writer opts in: {reason}");
        return;
    }
    let (name, _listener) = abstract_listener();
    let code = probe(&sandbox, &format!("abstract:{name}"), None);
    assert_eq!(code, Some(REFUSED), "1: the sandbox connected; 2: the probe failed otherwise");
    eprintln!("checked the abstract socket scope: the kernel refused the sandbox's connection");
}

/// Where the kernel has no scope for abstract sockets the agent stays off,
/// with the notice that says so, until the writer turns reduced isolation
/// on: for what a kernel can answer, and for what this one does.
#[test]
fn without_the_socket_scope_the_agent_stays_off_until_the_writer_opts_in() {
    let off = GuardOptions::default();
    let no_scope = || Err::<AbstractSocketScope, _>("this kernel has no Landlock scopes");
    assert_eq!(socket_scope_for(no_scope(), off).err(), Some(NO_SOCKET_SCOPE));
    assert!(matches!(socket_scope_for(no_scope(), REDUCED), Ok(None)));
    // Forwarding the SSH agent is another question.
    let forwarding = GuardOptions { forward_ssh_agent: true, ..off };
    assert_eq!(socket_scope_for(no_scope(), forwarding).err(), Some(NO_SOCKET_SCOPE));
    for named in ["Linux 6.12", "X server", "abstract sockets", "reduced isolation", "sandbox"] {
        assert!(NO_SOCKET_SCOPE.contains(named), "the notice does not name {named}");
    }

    if !guard_available() {
        return;
    }
    // On this machine, as Lattice asks before each start and again when it
    // builds the launch (`SynaraRuntime::ensure_ready`, `command`).
    let scoped = AbstractSocketScope::new(&bubblewrap().unwrap()).is_ok();
    let app_data = TempDir::new("bib-guard-options");
    let home = fs::canonicalize(&app_data).unwrap().join("synara");
    fs::create_dir(&home).unwrap();
    let mut runtime = crate::synara::SynaraRuntime::default();
    runtime.home_dir = home.clone();
    let asked = || crate::synara::bibliography_guard::missing(&home);
    let launch = || command(Path::new("/bin/true"), &home, Path::new("/bin/true"));
    assert_eq!(lacks_socket_scope(), !scoped);
    if scoped {
        assert_eq!(asked(), None);
        assert!(launch().is_ok());
        eprintln!("checked the opt-in on a kernel with the scope: the agent starts without it");
    } else {
        assert_eq!(asked(), Some(NO_SOCKET_SCOPE));
        let info = runtime.ensure_ready().unwrap();
        assert_eq!(info.state, "unsupported");
        assert_eq!(info.message.as_deref(), Some(NO_SOCKET_SCOPE));
        assert_eq!(launch().err().as_deref(), Some(NO_SOCKET_SCOPE));
        eprintln!("checked the opt-in on a kernel without the scope: off by default");
    }
    runtime.set_guard_options(REDUCED).unwrap();
    assert_eq!(asked(), None);
    assert!(launch().is_ok());
}

/// The sandbox the opt-in starts: it runs, and it does reach the host's
/// abstract sockets, which is what the setting's wording says. Run outside
/// the scope here too where the kernel has one.
#[test]
fn with_reduced_isolation_the_sandbox_starts_and_reaches_abstract_sockets() {
    if !guard_available() {
        return;
    }
    let mut sandbox = Sandbox::new();
    sandbox.without_scope = true;
    assert!(sandbox.run("true", &[]), "the sandbox did not start");
    let (name, _listener) = abstract_listener();
    let code = probe(&sandbox, &format!("abstract:{name}"), None);
    assert_eq!(code, Some(CONNECTED), "0: refused, so isolation was not reduced");
}

/// The SSH agent's socket is the sandbox's to use only when the writer
/// forwards it, and then alone: the runtime folder it may be in stays empty
/// around it. Not forwarded, the variable is unset and the socket's own path
/// does not connect either, in the runtime folder or in the system temp dir,
/// which the sandbox otherwise has from the host.
#[test]
fn the_ssh_agent_is_out_of_reach_until_the_writer_forwards_it() {
    if !guard_available() {
        return;
    }
    let runtime = Guarded::new();
    let (in_runtime, bus) = (runtime.0.join("agent/ssh"), runtime.0.join("bus"));
    fs::create_dir(in_runtime.parent().unwrap()).unwrap();
    let temporary = TempDir::new("bib-guard-ssh");
    let in_temporary = fs::canonicalize(&temporary).unwrap().join("agent.sock");
    let _listeners =
        [&in_runtime, &bus, &in_temporary].map(|path| UnixListener::bind(path).unwrap());
    let path = |socket: &Path| format!("path:{}", socket.display());

    for socket in [&in_runtime, &in_temporary] {
        UnixStream::connect(socket).expect("connect outside the sandbox");
        let sandbox = |forwarded| {
            Sandbox::with_runtime(std::slice::from_ref(&runtime.0))
                .with_ssh_agent(socket, forwarded)
        };

        let kept_out = sandbox(false);
        assert_eq!(probe(&kept_out, "ssh-agent", Some(socket)), Some(NO_AGENT), "{socket:?}");
        assert_eq!(probe(&kept_out, &path(socket), Some(socket)), Some(REFUSED), "{socket:?}");
        drop(kept_out);

        let forwarded = sandbox(true);
        assert_eq!(probe(&forwarded, "ssh-agent", Some(socket)), Some(CONNECTED), "{socket:?}");
        // Only that socket: the bus beside it in the runtime folder is not there.
        assert_eq!(probe(&forwarded, &path(&bus), Some(socket)), Some(REFUSED), "{socket:?}");
    }
    UnixStream::connect(&in_temporary).expect("the host's socket is as it was");
}

/// The opt-ins are the writer's: the sandbox reads the folder they are kept
/// in and changes nothing there, though the rest of Lattice's data folder
/// around it is the agent's to write. (`printf`, not `:`, whose failed
/// redirection would end the shell with a status of its own.)
#[test]
fn the_sandbox_cannot_change_the_writers_opt_ins() {
    if !guard_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let file = sandbox.options.join("options.json");
    let script = "cat \"$1\" >/dev/null || exit 1; \
         printf '{\"reducedIsolation\":true}' > \"$1\" 2>/dev/null && exit 2; \
         printf '' > \"${1%/*}/new\" 2>/dev/null && exit 3; \
         rm \"$1\" 2>/dev/null && exit 4; \
         mv \"${1%/*}\" \"${1%/*}.old\" 2>/dev/null && exit 5; \
         printf '' > \"${1%/*}/../beside\" || exit 6; \
         exit 0";
    let status = sandbox.command(script).arg(&file).status().expect("run sandboxed command");
    assert_eq!(status.code(), Some(0), "see the script for what each exit status means");
    assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
    assert_eq!(fs::read_dir(&sandbox.options).unwrap().count(), 1);
}
