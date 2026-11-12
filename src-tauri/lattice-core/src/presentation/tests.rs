use super::*;

#[test]
fn startup_errors_prefer_the_child_process_cause() {
    let stderr = "node:internal/modules/package_json_reader:301\n\
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@open-slide/core'\n\
Node.js v24.20.0\n";
    assert_eq!(
        startup_error_message("EOF while parsing a value", stderr),
        "Open Slide startup failed: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@open-slide/core'"
    );
    assert_eq!(
        startup_error_message("EOF while parsing a value", ""),
        "Open Slide startup failed: EOF while parsing a value"
    );
}

#[test]
fn only_a_live_page_still_showing_the_project_keeps_its_lease() {
    let project = Path::new("/projects/talk");
    let owner = |window: &str, page: &str| LeaseOwner { window: window.into(), page: page.into() };
    let leases = BTreeMap::from([
        ("open-deck".to_string(), owner("project-1", "page-a")),
        ("closed-window".to_string(), owner("main", "page-b")),
        ("moved-on".to_string(), owner("project-2", "page-c")),
        ("reloaded".to_string(), owner("project-3", "page-old")),
        ("replaced-tab".to_string(), owner("browser-1", "page-d")),
    ]);
    let pages = HashMap::from([
        ("project-1".to_string(), "page-a".to_string()),
        ("main".to_string(), "page-b".to_string()),
        ("project-2".to_string(), "page-c".to_string()),
        ("project-3".to_string(), "page-new".to_string()),
        // A navigation already removed `browser-1`'s page.
    ]);
    let shows = |window: &str| match window {
        "project-1" | "project-3" | "browser-1" => Some(project.to_path_buf()),
        "project-2" => Some(PathBuf::from("/projects/paper")),
        // `main` closed, so nothing binds it.
        _ => None,
    };

    let mut stale = stale_leases(&leases, project, &pages, &shows);
    stale.sort();
    assert_eq!(stale, ["closed-window", "moved-on", "reloaded", "replaced-tab"]);
}

/// A runtime for project `talk` whose single lease belongs to the page
/// `page-1` of window `main`, with a `sleep` standing in for Open Slide.
/// Its Node executable does not exist, so any new launch fails at once.
fn runtime_held_by_main(parent: &crate::test_support::TempDir) -> (PresentationRuntime, PathBuf) {
    let talk = fs::canonicalize(parent.join("talk")).unwrap();
    let mut command = crate::test_support::sleep_command(60);
    crate::commands::in_new_process_group(&mut command);
    let runtime = PresentationRuntime {
        node: NodeRuntime { executable: parent.join("missing/node") },
        entry_path: parent.join("missing/server.mjs"),
        shadow_parent: parent.join("shadows"),
        running: Arc::default(),
        pages: Arc::default(),
    };
    let mut running = Running {
        child: command.spawn().unwrap(),
        project_root: talk.clone(),
        shadow_root: parent.join("shadows/workspace"),
        origin: "http://127.0.0.1:9".into(),
        session_url: String::new(),
        control_token: String::new(),
        leases: BTreeMap::new(),
        idle_generation: 0,
    };
    running.lease(LeaseOwner { window: "main".into(), page: "page-1".into() });
    *runtime.running.lock().unwrap() = Some(running);
    runtime.pages.lock().unwrap().insert("main".into(), "page-1".into());
    (runtime, talk)
}

#[test]
fn another_projects_deck_waits_only_for_a_live_holder() {
    let parent = crate::test_support::TempDir::new("presentation-leases");
    parent.write("talk/slides/talk/index.tsx", "export default [];\n");
    parent.write("paper/slides/paper/index.tsx", "export default [];\n");
    let (runtime, talk) = runtime_held_by_main(&parent);
    let paper = parent.join("paper");
    let other = LeaseOwner { window: "project-1".into(), page: "page-2".into() };

    // `main` still shows `talk`: offer to switch rather than fail.
    let showing_talk = |window: &str| (window == "main").then(|| talk.clone());
    let busy = runtime.ensure(paper.to_str().unwrap(), other.clone(), &showing_talk).unwrap();
    assert_eq!(busy.state, "busy");
    assert_eq!(busy.project_root.as_deref(), Some(talk.to_str().unwrap()));
    assert!(busy.lease_id.is_none());

    // `main` closed without releasing: its lease no longer blocks, the
    // old runtime stops, and `paper` gets its own (here failing) launch.
    let error = runtime.ensure(paper.to_str().unwrap(), other, &|_| None).unwrap_err();
    assert!(error.starts_with("Could not start Open Slide"), "{error}");
    assert!(runtime.running.lock().unwrap().is_none());
}

#[test]
fn a_replaced_page_releases_its_leases_but_not_its_successors() {
    let parent = crate::test_support::TempDir::new("presentation-reload");
    parent.write("talk/slides/talk/index.tsx", "export default [];\n");
    let (runtime, _) = runtime_held_by_main(&parent);
    // The reloaded page leased the same deck before the old lease went.
    runtime
        .running
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .leases
        .insert("successor".into(), LeaseOwner { window: "main".into(), page: "page-2".into() });
    runtime.pages.lock().unwrap().insert("main".into(), "page-2".into());

    runtime.drop_superseded_leases("main");

    let leases = runtime.running.lock().unwrap().as_ref().unwrap().leases.clone();
    runtime.shutdown();
    assert_eq!(leases.keys().collect::<Vec<_>>(), ["successor"]);
}

#[test]
fn shadows_only_native_open_slide_workspace_paths() {
    for (path, native) in [
        ("slides/research-update/index.tsx", true),
        ("assets/chart.png", true),
        ("open-slide.config.ts", true),
        ("main.tex", false),
        ("slides-backup/index.tsx", false),
    ] {
        assert_eq!(is_native_path(Path::new(path)), native, "{path}");
    }
}

#[test]
fn shadow_mirrors_every_file_a_deck_can_import_and_sees_later_ones() {
    let parent = crate::test_support::TempDir::new("presentation-deck-files");
    let source = parent.join("project");
    let shadow = parent.join("shadow");
    for path in [
        "slides/talk/index.tsx",
        "slides/talk/assets/chart.png",
        "slides/talk/assets/fonts/display.woff2",
        "slides/talk/data/results.json",
        "slides/talk/embed.html",
        "assets/logo.svg",
    ] {
        parent.write(&format!("project/{path}"), path);
    }

    synchronize(&source, &shadow).unwrap();
    let mirrored = native_files(&shadow).unwrap();
    assert_eq!(
        mirrored.keys().map(String::as_str).collect::<Vec<_>>(),
        native_files(&source).unwrap().keys().map(String::as_str).collect::<Vec<_>>()
    );
    assert!(mirrored.contains_key("slides/talk/assets/fonts/display.woff2"));

    // An asset written after the runtime started is one that `refresh`
    // must upload: it is in the project's listing but not the shadow's.
    parent.write("project/slides/talk/assets/late.png", "late");
    let source_files = native_files(&source).unwrap();
    let pending =
        source_files.keys().filter(|path| !mirrored.contains_key(*path)).collect::<Vec<_>>();
    assert_eq!(pending, ["slides/talk/assets/late.png"]);
}

#[test]
fn shadow_sync_does_not_walk_unrelated_project_directories() {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    let parent = crate::test_support::TempDir::new("presentation-shadow");
    let source = parent.join("project");
    let shadow = parent.join("shadow");
    let unrelated = source.join("large-paper-cache");
    parent.write("project/slides/talk/index.tsx", "export default [];\n");
    fs::create_dir_all(&unrelated).unwrap();
    #[cfg(unix)]
    fs::set_permissions(&unrelated, fs::Permissions::from_mode(0o000)).unwrap();

    let result = synchronize(&source, &shadow);
    #[cfg(unix)]
    fs::set_permissions(&unrelated, fs::Permissions::from_mode(0o700)).unwrap();
    // Only an existing directory is a presentation project.
    assert!(scoped_root(source.join("slides/talk/index.tsx").to_str().unwrap()).is_err());
    assert!(scoped_root(parent.join("missing").to_str().unwrap()).is_err());

    assert!(result.is_ok(), "{result:?}");
    assert_eq!(
        fs::read_to_string(shadow.join("slides/talk/index.tsx")).unwrap(),
        "export default [];\n"
    );
    assert!(!shadow.join("large-paper-cache").exists());
}

/// Start a stand-in runtime that prints `line` as its readiness handshake and
/// then idles until the supervisor stops it, in its own process group as
/// `spawn` starts the real one.
#[cfg(unix)]
fn child_announcing(line: &str) -> Child {
    use std::os::unix::process::CommandExt;
    Command::new("/bin/sh")
        .args(["-c", "printf '%s\\n' \"$1\"; exec sleep 30", "sh", line])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap()
}

#[cfg(unix)]
#[test]
fn accepts_only_the_open_slide_version_the_runtime_pins() {
    // The oracle is the runtime's own manifest: the version of @open-slide/core
    // it installs is the version its server reports in the handshake
    // (tools/open-slide-runtime/version-pin.node-test.mjs).
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../../tools/open-slide-runtime/package.json"))
            .unwrap();
    let pinned = manifest["dependencies"]["@open-slide/core"].as_str().unwrap();
    let handshake = |version: &str| {
        serde_json::json!({
            "ready": true,
            "port": 4100,
            "sessionToken": "session",
            "controlToken": "control",
            "version": version,
        })
        .to_string()
    };

    let mut current = child_announcing(&handshake(pinned));
    let ready = await_ready(&mut current, "control");
    terminate_process_group(&mut current);
    assert_eq!(ready.map(|ready| ready.port), Ok(4100));

    let mut stale = child_announcing(&handshake("0.0.0-other"));
    assert_eq!(
        await_ready(&mut stale, "control").map(|ready| ready.port),
        Err("Open Slide returned invalid readiness data.".to_string())
    );
    assert!(matches!(stale.try_wait(), Ok(Some(_))), "a refused runtime is stopped");
}
