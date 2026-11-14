use super::*;
use crate::test_support::TempDir;

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

    let agent_home = TempDir::new("bib-guard-agent");
    let mountpoint = TempDir::new("bib-guard-filter");
    let layout = Layout::new(home_folder().as_deref(), &fs::canonicalize(&agent_home).unwrap());
    assert!(layout.guards(&root.0), "the test's project is outside the guard");
    let filter = name_filter::mount(Path::new("/"), &mountpoint).expect("mount the filter");
    let bubblewrap = bubblewrap().expect("bubblewrap");
    let run = |script: &str, args: &[&PathBuf]| {
        Command::new(&bubblewrap)
            .args(layout.arguments(&mountpoint))
            .args(["--", "/bin/sh", "-c", script, "sandbox-test"])
            .args(args)
            .status()
            .expect("run sandboxed command")
            .success()
    };

    // The macOS guard's attacks, unchanged.
    let attempts: [(&str, &[&PathBuf]); 12] = [
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
    ];
    for (script, args) in attempts {
        assert!(!run(script, args), "sandbox allowed: {script}");
    }

    assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
    assert_eq!(fs::read_to_string(&uppercase).unwrap(), "uppercase");
    assert!(!created.exists() && !later.join("Later.BiB").exists() && !bib_alias.exists());
    // The moved folder took its bibliography along untouched, and the
    // folder made in its place could not be given one.
    assert_eq!(fs::read_to_string(root.0.join("paper.old/references.bib")).unwrap(), "original");
    assert!(moved.is_dir() && !moved.join("references.bib").exists());
    assert!(run("printf changed > \"$1\" && cat \"$2\" >/dev/null", &[&ordinary, &bibliography]));
    assert_eq!(fs::read_to_string(&ordinary).unwrap(), "changed");

    // A background descendant is inside the same sandbox for as long as
    // it lives, which is no longer than the sandbox: it ends with the
    // command that started it.
    assert!(run(
        "(sleep 0.05; printf changed > \"$1\") >/dev/null 2>&1 & \
         (sleep 1; printf late > \"$2\") >/dev/null 2>&1 & sleep 0.3",
        &[&bibliography, &late],
    ));
    thread::sleep(Duration::from_millis(1200));
    assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
    assert!(!late.exists());

    // Outside the sandbox the same files are Lattice's to write.
    fs::write(&bibliography, "brokered").unwrap();
    assert!(run("grep -q brokered \"$1\"", &[&bibliography]));
    drop(filter);
}

#[test]
fn the_sandbox_cannot_reach_host_processes_or_undo_its_mounts() {
    if !guard_available() {
        return;
    }
    let root = Guarded::new();
    let bibliography = root.write("references.bib", "original");
    let agent_home = TempDir::new("bib-guard-agent");
    let mountpoint = TempDir::new("bib-guard-filter");
    let layout = Layout::new(home_folder().as_deref(), &fs::canonicalize(&agent_home).unwrap());
    let filter = name_filter::mount(Path::new("/"), &mountpoint).expect("mount the filter");
    let script = "printf changed >> \"/proc/$2/root$1\" && exit 1; \
         kill -0 \"$2\" 2>/dev/null && exit 2; \
         [ \"$$\" = 2 ] || exit 3; \
         printf changed > /run/x.bib 2>/dev/null && exit 4; \
         printf changed > /usr/x.bib 2>/dev/null && exit 5; \
         printf changed >> \"$3$1\" 2>/dev/null && exit 6; \
         exit 0";
    let status = Command::new(bubblewrap().expect("bubblewrap"))
        .args(layout.arguments(&mountpoint))
        .args(["--", "/bin/sh", "-c", script, "sandbox-test"])
        .arg(&bibliography)
        .arg(std::process::id().to_string())
        // The filter's own mount, which the sandbox sees under /tmp.
        .arg(mountpoint.as_os_str())
        .status()
        .expect("run sandboxed command");
    assert_eq!(status.code(), Some(0), "see the script for what each exit status means");
    assert_eq!(fs::read_to_string(&bibliography).unwrap(), "original");
    drop(filter);
}
