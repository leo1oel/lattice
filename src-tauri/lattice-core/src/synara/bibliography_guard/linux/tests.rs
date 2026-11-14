use super::*;
use crate::test_support::TempDir;
use std::ffi::CString;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, PermissionsExt};

/// A folder where the guard reaches. Not the system temp dir, which the
/// sandbox takes from the host unfiltered.
struct Guarded(PathBuf);

impl Guarded {
    fn new() -> Self {
        let path = PathBuf::from(format!("/var/tmp/lattice-bib-guard-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }

    fn write(&self, relative: &str, contents: &str) -> PathBuf {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        path
    }
}

impl Drop for Guarded {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The guard's requirements here, or a note on why its tests cannot run:
/// a build machine without bubblewrap, FUSE or user namespaces is not a
/// failure of the guard. `LATTICE_REQUIRE_BIBLIOGRAPHY_GUARD` makes it one.
fn guard_available() -> bool {
    let Some(reason) = missing() else { return true };
    assert!(
        std::env::var_os("LATTICE_REQUIRE_BIBLIOGRAPHY_GUARD").is_none(),
        "the bibliography guard cannot run here: {reason}"
    );
    eprintln!("skipped, the bibliography guard cannot run here: {reason}");
    false
}

/// The guard as `guard` sets it up, for one test: the agent's folder inside
/// an app data folder, as Lattice's is, the filter mounted in the agent's
/// folder, as where `XDG_RUNTIME_DIR` is unset, and bubblewrap with the
/// layout over it. Fields drop in order, the mount first.
struct Sandbox {
    _filter: fuser::BackgroundSession,
    mountpoint: Mountpoint,
    layout: Layout,
    bubblewrap: PathBuf,
    _app_data: TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let app_data = TempDir::new("bib-guard-app");
        let home = fs::canonicalize(&app_data).unwrap().join("synara");
        fs::create_dir(&home).unwrap();
        let mountpoint = Mountpoint::create_in(&home.join(MOUNTS)).expect("the filter's folder");
        let filter = name_filter::mount(Path::new("/"), &mountpoint.0).expect("mount the filter");
        Self {
            _filter: filter,
            mountpoint,
            layout: Layout::new(home_folder().as_deref(), &home),
            bubblewrap: bubblewrap().expect("bubblewrap"),
            _app_data: app_data,
        }
    }

    /// `script` for `/bin/sh` inside the sandbox; its arguments follow.
    fn command(&self, script: &str) -> Command {
        let mut command = Command::new(&self.bubblewrap);
        command.args(self.layout.arguments(&self.mountpoint.0)).args([
            "--",
            "/bin/sh",
            "-c",
            script,
            "sandbox-test",
        ]);
        command
    }

    fn run(&self, script: &str, args: &[&PathBuf]) -> bool {
        self.command(script).args(args).status().expect("run sandboxed command").success()
    }

    /// `path` reached through the filter from outside the sandbox, which is
    /// how the sandbox reaches it.
    fn through(&self, path: &Path) -> PathBuf {
        self.mountpoint.0.join(path.strip_prefix("/").unwrap())
    }
}

#[test]
fn bibliography_sandbox_blocks_direct_and_indirect_bib_writes() {
    if !guard_available() {
        return;
    }
    let root = Guarded::new();
    let path = |name: &str| root.0.join(name);
    let (bibliography, uppercase, ordinary) = (
        root.write("references.bib", "original"),
        root.write("OTHER.BIB", "uppercase"),
        root.write("ordinary.txt", "ordinary"),
    );
    let (replacement, renamed, alias) =
        (path("replacement.tmp"), path("renamed.tmp"), path("alias.txt"));
    let (bib_alias, hardlink_alias) = (path("alias.bib"), path("hardlink.txt"));
    crate::test_support::symlink(&bibliography, &alias).expect("symlink to bibliography");
    // What bubblewrap's read-only binds cannot stop: bibliographies that
    // do not exist yet, and a project folder moved out from under them.
    let (created, later, late) = (path("new.bib"), path("later"), path("late.txt"));
    let moved = root.write("paper/references.bib", "original").parent().unwrap().to_path_buf();
    // A project folder swapped for a link to a copy in /tmp, where the
    // filter does not reach: Lattice would follow it and edit the copy.
    let thesis = root.write("thesis/references.bib", "original").parent().unwrap().to_path_buf();
    let copy_folder = TempDir::new("bib-guard-copy");
    let copy = copy_folder.to_path_buf();

    let sandbox = Sandbox::new();
    assert!(sandbox.layout.guards(&root.0), "the test's project is outside the guard");

    // The macOS guard's attacks, unchanged, then Linux's own.
    let attempts: [(&str, &[&PathBuf]); 13] = [
        ("printf changed >> \"$1\"", &[&bibliography]),
        ("printf changed > \"$1\"", &[&bibliography]),
        ("rm \"$1\"", &[&bibliography]),
        ("printf replacement > \"$1\" && mv -f \"$1\" \"$2\"", &[&replacement, &bibliography]),
        (
            "mv \"$1\" \"$2\" && printf changed > \"$2\" && mv \"$2\" \"$1\"",
            &[&bibliography, &renamed],
        ),
        ("printf changed > \"$1\"", &[&uppercase]),
        ("ln \"$1\" \"$2\" && printf changed > \"$2\"", &[&bibliography, &hardlink_alias]),
        ("printf changed > \"$1\"", &[&alias]),
        ("ln -s \"$1\" \"$2\" && printf changed > \"$2\"", &[&ordinary, &bib_alias]),
        ("printf new > \"$1\"", &[&created]),
        ("mkdir \"$1\" && printf new > \"$1/Later.BiB\"", &[&later]),
        ("mv \"$1\" \"$1.old\" && mkdir \"$1\" && cp \"$1.old/references.bib\" \"$1/\"", &[&moved]),
        (
            "mv \"$1\" \"$1.old\" && cp -a \"$1.old/.\" \"$2\" \
             && printf injected >> \"$2/references.bib\" && ln -s \"$2\" \"$1\"",
            &[&thesis, &copy],
        ),
    ];
    for (script, args) in attempts {
        assert!(!sandbox.run(script, args), "sandbox allowed: {script}");
    }

    assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
    assert_eq!(fs::read_to_string(&uppercase).unwrap(), "uppercase");
    assert!(!created.exists() && !later.join("Later.BiB").exists() && !bib_alias.exists());
    // The moved folder took its bibliography along untouched, and the
    // folder made in its place could not be given one.
    assert_eq!(fs::read_to_string(root.0.join("paper.old/references.bib")).unwrap(), "original");
    assert!(moved.is_dir() && !moved.join("references.bib").exists());
    // The swap got as far as the link, which is what failed.
    assert_eq!(fs::read_to_string(copy.join("references.bib")).unwrap(), "originalinjected");
    assert!(fs::symlink_metadata(&thesis).is_err(), "the project folder's name was given a link");
    assert!(sandbox
        .run("printf changed > \"$1\" && cat \"$2\" >/dev/null", &[&ordinary, &bibliography]));
    assert_eq!(fs::read_to_string(&ordinary).unwrap(), "changed");

    // A background descendant is inside the same sandbox for as long as
    // it lives, which is no longer than the sandbox: it ends with the
    // command that started it.
    assert!(sandbox.run(
        "(sleep 0.05; printf changed > \"$1\") >/dev/null 2>&1 & \
         (sleep 1; printf late > \"$2\") >/dev/null 2>&1 & sleep 0.3",
        &[&bibliography, &late],
    ));
    thread::sleep(Duration::from_millis(1200));
    assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
    assert!(!late.exists());

    // Outside the sandbox the same files are Lattice's to write.
    fs::write(&bibliography, "brokered").unwrap();
    assert!(sandbox.run("grep -q brokered \"$1\"", &[&bibliography]));
}

#[test]
fn the_sandbox_cannot_reach_host_processes_or_undo_its_mounts() {
    if !guard_available() {
        return;
    }
    let root = Guarded::new();
    let bibliography = root.write("references.bib", "original");
    let sandbox = Sandbox::new();
    let script = "printf changed >> \"/proc/$2/root$1\" && exit 1; \
         kill -0 \"$2\" 2>/dev/null && exit 2; \
         [ \"$$\" = 2 ] || exit 3; \
         printf changed > /run/x.bib 2>/dev/null && exit 4; \
         printf changed > /usr/x.bib 2>/dev/null && exit 5; \
         printf changed >> \"$3$1\" 2>/dev/null && exit 6; \
         [ -z \"$(ls -A \"${3%/*}\")\" ] || exit 7; \
         exit 0";
    let status = sandbox
        .command(script)
        .arg(&bibliography)
        .arg(std::process::id().to_string())
        // The filter's own mount, in the agent's folder, which the sandbox
        // has writable: through it, it would see the host's whole tree.
        .arg(sandbox.mountpoint.0.as_os_str())
        .status()
        .expect("run sandboxed command");
    assert_eq!(status.code(), Some(0), "see the script for what each exit status means");
    assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
}

/// Lattice renames files outside the sandbox, onto a bibliography too, as
/// its atomic writes do. A file the sandbox opened before such a rename
/// stays open after it, and whatever reaches it then is refused.
#[test]
fn a_file_opened_before_a_rename_onto_a_bibliography_cannot_change_it() {
    if !guard_available() {
        return;
    }
    let root = Guarded::new();
    let bibliography = root.write("references.bib", "original");
    let (draft, other) = (root.write("draft.txt", "draft"), root.write("other.txt", "other"));
    let sandbox = Sandbox::new();
    let file = fs::OpenOptions::new().read(true).write(true).open(sandbox.through(&draft)).unwrap();
    let source = fs::File::open(sandbox.through(&other)).unwrap();
    let fd = file.as_raw_fd();
    let checked = |result: libc::c_long| match result {
        0.. => Ok(()),
        _ => Err(io::Error::last_os_error()),
    };
    let write = || file.write_at(b"D", 0).map(drop);
    let truncate = || file.set_len(5);
    // SAFETY: `fd` is open for writing.
    let allocate =
        || checked(unsafe { libc::fallocate(fd, libc::FALLOC_FL_KEEP_SIZE, 0, 1) }.into());
    let copy = || {
        let (mut from, mut to): (libc::off64_t, libc::off64_t) = (0, 0);
        // SAFETY: both descriptors are open, and the offsets are locals.
        checked(unsafe { libc::copy_file_range(source.as_raw_fd(), &mut from, fd, &mut to, 1, 0) }
            as libc::c_long)
    };
    let chmod = || file.set_permissions(fs::Permissions::from_mode(0o644));
    let reopen =
        || fs::OpenOptions::new().write(true).open(format!("/proc/self/fd/{fd}")).map(drop);
    let changes: [(&str, &dyn Fn() -> io::Result<()>); 6] = [
        ("write", &write),
        ("truncate", &truncate),
        ("fallocate", &allocate),
        ("copy_file_range", &copy),
        ("chmod", &chmod),
        ("reopen", &reopen),
    ];
    for (name, change) in &changes {
        change().unwrap_or_else(|error| panic!("{name} before the rename: {error}"));
    }

    fs::rename(&draft, &bibliography).unwrap();
    let renamed = fs::read(&bibliography).unwrap();
    let allowed: Vec<_> =
        changes.iter().filter(|(_, change)| !refused(&change())).map(|(name, _)| name).collect();
    assert!(allowed.is_empty(), "the filter let these through: {allowed:?}");
    assert_eq!(fs::read(&bibliography).unwrap(), renamed);
}

/// Whether the filter refused a change, as it refuses a bibliography's.
fn refused(result: &io::Result<()>) -> bool {
    result.as_ref().err().and_then(|error| error.raw_os_error()) == Some(libc::EPERM)
}

/// The broker writes a bibliography through a temporary beside it and
/// renames that over the `.bib`, the race `ProjectDir::atomic_write`'s
/// `.tmp.bib` name closes. The sandbox polls for the temporary, opens it
/// for writing, and writes through it once the rename has taken it away.
#[test]
fn the_sandbox_cannot_write_through_the_brokers_temporary() {
    if !guard_available() {
        return;
    }
    let root = Guarded::new();
    root.write("references.bib", "original");
    let ready = root.0.join("ready.txt");
    let script = r#"
        : > "$2"
        while :; do
          for f in "$1"/.lattice-*; do
            [ -e "$f" ] || continue
            if (
              exec 3<>"$f" || exit 1
              while [ -e "$f" ]; do :; done
              printf INJECTED >&3
            ) 2>/dev/null; then exit 0; fi
          done
        done
    "#;
    let sandbox = Sandbox::new();
    let mut agent = sandbox.command(script).arg(&root.0).arg(&ready).spawn().unwrap();
    while !ready.exists() {
        thread::sleep(Duration::from_millis(5));
    }
    // Large enough that the temporary exists for a while on every write.
    let mut payload = b"@misc{broker,}\n".to_vec();
    payload.resize(16 << 20, b'%');
    let project = crate::project_fs::ProjectDir::open(&root.0).unwrap();
    let mut injected = false;
    for _ in 0..8 {
        project.atomic_write("references.bib", &payload).unwrap();
        thread::sleep(Duration::from_millis(50));
        if let Some(status) = agent.try_wait().unwrap() {
            injected = status.success();
            break;
        }
    }
    let _ = agent.kill();
    let _ = agent.wait();

    let written = fs::read(root.0.join("references.bib")).unwrap();
    assert!(written == payload, "the bibliography changed behind the guard");
    assert!(!injected, "the sandboxed process wrote through the broker's temporary");
}

/// A symbolic link is followed by Lattice outside the sandbox, so the
/// filter neither makes one nor moves one.
#[test]
fn links_cannot_be_made_or_moved_through_the_filter() {
    if !guard_available() {
        return;
    }
    let root = Guarded::new();
    root.write("thesis/main.tex", "thesis");
    root.write("draft/main.tex", "draft");
    let notes = root.write("notes.txt", "notes");
    let copy = TempDir::new("bib-guard-copy");
    // One the host made, such as the user.
    crate::test_support::symlink(&copy, root.0.join("link")).unwrap();
    let sandbox = Sandbox::new();
    let through = |name: &str| sandbox.through(&root.0.join(name));
    let exchange = |a: &str, b: &str| {
        let path = |name| CString::new(through(name).as_os_str().as_bytes()).unwrap();
        let (a, b) = (path(a), path(b));
        // SAFETY: both paths are NUL-terminated.
        let exchanged = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                a.as_ptr(),
                libc::AT_FDCWD,
                b.as_ptr(),
                libc::RENAME_EXCHANGE,
            )
        };
        if exchanged == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    };
    // The project folder moved aside first, as in the attack: the kernel
    // itself refuses a link moved onto a folder.
    fs::rename(through("thesis"), through("thesis.old")).unwrap();
    let attempts = [
        ("make a link", std::os::unix::fs::symlink(&*copy, through("new"))),
        ("move a link into a folder's place", fs::rename(through("link"), through("thesis"))),
        ("move a file onto a link", fs::rename(through("notes.txt"), through("link"))),
        ("exchange a folder and a link", exchange("draft", "link")),
        ("give a link a second name", fs::hard_link(through("link"), through("second"))),
    ];
    let allowed: Vec<_> =
        attempts.into_iter().filter(|(_, result)| !refused(result)).map(|(what, _)| what).collect();
    assert!(allowed.is_empty(), "the filter let these through: {allowed:?}");
    assert!(fs::symlink_metadata(root.0.join("link")).unwrap().file_type().is_symlink());
    assert!(fs::symlink_metadata(root.0.join("thesis")).is_err());
    assert!(root.0.join("draft/main.tex").is_file() && notes.is_file());
    // Folders still move, as the first rename showed.
    assert!(root.0.join("thesis.old/main.tex").is_file());
}

/// The sandbox runs in a session of its own, without the terminal Lattice
/// may have been started from, led by bubblewrap's process 1. A SIGTERM to
/// that session's group, as `pass_on_termination` sends, reaches the
/// command, which finds it as it expects to.
#[test]
fn the_sandbox_has_its_own_session_and_stops_on_its_sigterm() {
    if !guard_available() {
        return;
    }
    let root = Guarded::new();
    let ready = root.0.join("ready");
    let sandbox = Sandbox::new();
    let script = "[ \"$(cut -d' ' -f6 /proc/$$/stat)\" = 1 ] || exit 3; \
         [ -e /dev/tty ] && true 2>/dev/null </dev/tty && exit 4; \
         trap 'exit 7' TERM; : > \"$1\"; while :; do sleep 0.05; done";
    let mut command = sandbox.command(script).arg(&ready).spawn().unwrap();
    while !ready.exists() {
        if let Some(status) = command.try_wait().unwrap() {
            panic!("the command ended first, with {status}");
        }
        thread::sleep(Duration::from_millis(10));
    }
    let leader = child_of(command.id() as libc::pid_t).expect("bubblewrap's process 1");
    // SAFETY: `kill` takes and returns plain integers.
    unsafe { libc::kill(-leader, libc::SIGTERM) };
    assert_eq!(command.wait().unwrap().code(), Some(7));
}
