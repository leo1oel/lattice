//! The sandbox against real `sandbox-exec`: system tools stand in for a
//! plugin, so each test names exactly one thing the profile allows or denies.

use super::*;
use crate::test_support::TempDir;
use std::net::TcpListener;
use std::process::Output;

struct Fixture {
    _root: TempDir,
    plugin: PathBuf,
    data: PathBuf,
    outside: PathBuf,
}

fn fixture() -> Fixture {
    let root = TempDir::new("plugin-sandbox");
    std::fs::create_dir_all(root.join("data")).unwrap();
    root.write("plugin/readme.txt", "inside");
    root.write("outside/secret.txt", "secret");
    // Paths as the host hands them to a plugin: resolved (/private/var/…).
    let real = root.canonicalize().unwrap();
    let (plugin, data, outside) =
        (real.join("plugin"), real.join("data"), real.join("outside/secret.txt"));
    Fixture { plugin, data, outside, _root: root }
}

fn run(f: &Fixture, program: &str, args: &[&str], ports: &[u16]) -> Output {
    let launch = Launch {
        plugin_id: "dev.test.sandbox",
        program: Path::new(program),
        args: args.iter().map(OsString::from).collect(),
        plugin_dir: &f.plugin,
        data_dir: &f.data,
        runtime_reads: &[],
        exec_in_plugin_dir: false,
        network_local: ports,
        locale: "en",
    };
    command(&launch).unwrap().output().unwrap()
}

#[test]
fn reads_only_its_own_folders() {
    let f = fixture();
    let inside = f.plugin.join("readme.txt");
    let ok = run(&f, "/bin/cat", &[inside.to_str().unwrap()], &[]);
    assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));
    assert_eq!(ok.stdout, b"inside");

    let denied = run(&f, "/bin/cat", &[f.outside.to_str().unwrap()], &[]);
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("Operation not permitted"));

    let home = std::env::var("HOME").unwrap();
    let listing = run(&f, "/bin/ls", &[&home], &[]);
    assert!(!listing.status.success(), "listed the writer's home folder");
}

#[test]
fn writes_only_its_data_folder() {
    let f = fixture();
    let data_file = f.data.join("cache.json");
    assert!(run(&f, "/usr/bin/touch", &[data_file.to_str().unwrap()], &[]).status.success());
    let plugin_file = f.plugin.join("patched.js");
    assert!(!run(&f, "/usr/bin/touch", &[plugin_file.to_str().unwrap()], &[]).status.success());
    let beside = f.outside.with_file_name("dropped.txt");
    assert!(!run(&f, "/usr/bin/touch", &[beside.to_str().unwrap()], &[]).status.success());
    assert!(!plugin_file.exists() && !beside.exists());
}

#[test]
fn connects_only_to_declared_local_ports() {
    let f = fixture();
    let allowed = TcpListener::bind("127.0.0.1:0").unwrap();
    let other = TcpListener::bind("127.0.0.1:0").unwrap();
    let (allowed_port, other_port) =
        (allowed.local_addr().unwrap().port(), other.local_addr().unwrap().port());
    let probe = |port: u16| {
        run(&f, "/usr/bin/nc", &["-z", "-w", "2", "127.0.0.1", &port.to_string()], &[allowed_port])
    };
    let ok = probe(allowed_port);
    assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));
    assert!(!probe(other_port).status.success(), "reached an undeclared port");
    let none =
        run(&f, "/usr/bin/nc", &["-z", "-w", "2", "127.0.0.1", &allowed_port.to_string()], &[]);
    assert!(!none.status.success(), "reached a port with no network-local grant");
}

#[test]
fn the_environment_holds_nothing_of_the_writers() {
    let f = fixture();
    let out = run(&f, "/usr/bin/env", &[], &[]);
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    let allowed = [
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "LATTICE_PLUGIN_ID",
        "LATTICE_PLUGIN_API_LEVEL",
        "LATTICE_PLUGIN_DATA_DIR",
        "__CF_USER_TEXT_ENCODING",
    ];
    for line in text.lines() {
        let key = line.split('=').next().unwrap();
        assert!(allowed.contains(&key), "leaked {key}");
    }
    assert!(text.contains(&format!("HOME={}", f.data.display())));
}

#[test]
fn starts_nothing_but_its_entry_point() {
    let f = fixture();
    let out = run(&f, "/usr/bin/env", &["/bin/echo", "escaped"], &[]);
    assert!(!out.status.success());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("escaped"));
}
