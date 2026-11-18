//! What the sandbox is kept from of the writer's session: the session bus,
//! the display and the host's abstract sockets.

use super::*;
use std::os::linux::net::SocketAddrExt;
use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};

/// What a program finds of the session inside: a runtime folder that is
/// empty and its own, and none of the variables that would name the bus or
/// the display. The runtime folder is a stand-in here, with a socket in it.
#[test]
fn the_sandbox_finds_an_empty_runtime_folder_and_no_session_variables() {
    if !guard_available() {
        return;
    }
    let runtime = Guarded::new();
    let bus = runtime.0.join("bus");
    let _listener = UnixListener::bind(&bus).unwrap();
    let sandbox = Sandbox::with_runtime(std::slice::from_ref(&runtime.0));
    let script = "env | grep -q -E \
         '^(DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|WAYLAND_SOCKET|XAUTHORITY)=' && exit 1; \
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
        .status()
        .expect("run sandboxed command");
    assert_eq!(status.code(), Some(0), "see the script for what each exit status means");
    // What the sandbox made there went with it.
    assert!(bus.exists() && !runtime.0.join("own").exists());
}

/// Through the session bus a process can have systemd's user manager start
/// another, outside the sandbox and the filter, or read the keyring, where
/// Lattice keeps the model endpoint's key. Each must fail inside wherever it
/// works outside, also with the bus's address put back; a machine without a
/// user session, as a build machine, has neither to check.
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
    // What works outside, then what must fail inside: `$1` is the
    // bibliography, and `$2` the bus's address outside.
    let checks = [
        (
            "systemd's user manager",
            format!("{systemd_run} true"),
            format!("{systemd_run} /bin/sh -c 'printf changed >> \"$1\"' sh \"$1\""),
        ),
        ("the Secret Service", search.to_string(), search.to_string()),
    ];
    for (service, outside, inside) in checks {
        let reachable = Command::new("/bin/sh")
            .args(["-c", &outside])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !reachable {
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
    }
    assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
}

/// What the probe below connects to, when the test after it runs it inside
/// the sandbox: the name of an abstract socket.
const ABSTRACT_PROBE: &str = "LATTICE_GUARD_ABSTRACT_PROBE";

/// Not a test of its own: inside the sandbox, the test binary itself is the
/// client, as no shell tool reaches an abstract socket. Exits 0 when the
/// kernel refuses the connection, 1 when it is made.
#[test]
fn abstract_socket_probe() {
    let Some(name) = std::env::var_os(ABSTRACT_PROBE) else { return };
    let address = SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
    let code = match UnixStream::connect_addr(&address) {
        Ok(_) => 1,
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => 0,
        Err(error) => {
            eprintln!("the probe failed otherwise: {error}");
            2
        }
    };
    std::process::exit(code);
}

/// A host process's abstract socket, as the X server's beside its file in
/// `/tmp/.X11-unix`, is out of the sandbox's reach where the kernel has
/// Landlock scopes. A stand-in listens here.
#[test]
fn the_sandbox_cannot_connect_to_the_hosts_abstract_sockets() {
    if !guard_available() {
        return;
    }
    let sandbox = Sandbox::new();
    if let Err(reason) = AbstractSocketScope::new(&sandbox.bubblewrap) {
        eprintln!("skipped, the sandbox reaches abstract sockets here: {reason}");
        return;
    }
    let name = format!("lattice-guard-test-{}", uuid::Uuid::new_v4());
    let address = SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
    let _listener = UnixListener::bind_addr(&address).unwrap();
    // Outside, it is reached as any process reaches it.
    UnixStream::connect_addr(&address).expect("connect outside the sandbox");
    let test = module_path!().split_once("::").map_or(module_path!(), |(_, path)| path);
    let test = format!("{test}::abstract_socket_probe");
    let executable = std::env::current_exe().unwrap();
    let status = sandbox
        .program(&[executable.as_os_str(), "--exact".as_ref(), test.as_ref()])
        .env(ABSTRACT_PROBE, &name)
        .stdout(Stdio::null())
        .status()
        .expect("run the probe in the sandbox");
    assert_eq!(status.code(), Some(0), "1: the sandbox connected; 2: the probe failed otherwise");
}
