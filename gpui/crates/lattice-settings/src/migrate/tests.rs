use super::*;

/// A file's permission bits; none to compare where there are none.
fn mode(meta: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        meta.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        0
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "lattice-settings-migrate-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A LocalStorage database as WebKit writes it: UTF-16LE blobs, still in
/// the write-ahead log as while the Tauri app runs.
fn local_storage(website_data: &Path, items: &[(&str, &str)]) -> PathBuf {
    let path = website_data.join("Default/salt/salt/LocalStorage/localstorage.sqlite3");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL; CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL);",
        )
        .unwrap();
    for (key, value) in items {
        let blob: Vec<u8> = value.encode_utf16().flat_map(u16::to_le_bytes).collect();
        connection
            .execute(
                "INSERT INTO ItemTable VALUES (?1, ?2)",
                rusqlite::params![key, blob],
            )
            .unwrap();
    }
    std::mem::forget(connection);
    path
}

/// Every file under `root` with its bytes and mode, to show a tree was left
/// exactly as it was.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, u32)> {
    let mut files = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                pending.push(path);
            } else {
                let bytes = std::fs::read(&path).unwrap_or_default();
                files.insert(path, (bytes, mode(&meta)));
            }
        }
    }
    files
}

struct Profile {
    root: PathBuf,
    tauri: Tauri,
    gpui: Gpui,
}

fn profile(name: &str) -> Profile {
    let root = scratch(name);
    Profile {
        tauri: Tauri {
            data: root.join("tauri/data"),
            config: root.join("tauri/config"),
            website_data: Some(root.join("tauri/WebsiteData")),
        },
        gpui: Gpui {
            state: root.join("gpui/state"),
            data: root.join("gpui/data"),
            overleaf: root.join("gpui/overleaf"),
        },
        root,
    }
}

const THEME: &str = r##"{"id":"dev.ada.paper","name":"Paper","version":"1.0.0","variants":[]}"##;

/// A Tauri profile with something of every kind.
fn full_tauri_profile(profile: &Profile) {
    let tauri = &profile.tauri;
    local_storage(
        tauri.website_data.as_deref().unwrap(),
        &[
            (
                RECENT_PROJECTS,
                r#"[{"name":"Thesis","path":"/Users/ada/Thesis","openedAt":1700000000000},{"name":"Old","path":"/Users/ada/Old"},{"path":"/no/name"}]"#,
            ),
            (RECENT_COMMANDS, r#"["build","open-settings"]"#),
            (
                SUBMISSION_TEMPLATES,
                r#"[{"name":"NeurIPS","items":[{"title":"Checklist"}]}]"#,
            ),
            (GET_STARTED, r#"{"done":["build"],"skipped":[]}"#),
            ("lattice.theme-preference.v1", "dark"),
        ],
    );
    let plugins = tauri.data.join("plugins");
    let package = plugins.join("packages/dev.ada.wordcount/1.2.0");
    write(
        &package.join("lattice-plugin.toml"),
        "id = \"dev.ada.wordcount\"\n",
    );
    write(&package.join("main.js"), "export default {}\n");
    write(
        &plugins.join("data/dev.ada.wordcount/cache.json"),
        "{\"n\":3}",
    );
    let registry = json!({
        "version": 1,
        "plugins": [
            {
                "id": "dev.ada.wordcount",
                "source": { "kind": "url", "url": "https://example.com/wc.zip", "sha256": "ab" },
                "dir": package,
                "enabled": true,
                "granted": { "projectRead": ["context"] },
                "manifest": { "id": "dev.ada.wordcount", "version": "1.2.0" }
            },
            {
                "id": "dev.ada.local",
                "source": { "kind": "folder", "path": "/Users/ada/plugins/local" },
                "dir": "/Users/ada/plugins/local",
                "enabled": false,
                "granted": null,
                "manifest": { "id": "dev.ada.local", "version": "0.1.0" }
            },
            { "id": "../escape", "source": { "kind": "folder", "path": "/x" }, "dir": "/x" }
        ]
    });
    write(&plugins.join("registry.json"), &pretty(&registry));
    write(&tauri.data.join("themes/dev.ada.paper.json"), THEME);
    write(
        &tauri.data.join("themes/renamed.json"),
        r#"{"id":"dev.ada.other","name":"Other"}"#,
    );
    write(
        &tauri.data.join("templates/abc123/template.json"),
        r#"{"id":"abc123","name":"Lab report"}"#,
    );
    write(
        &tauri.data.join("templates/abc123/files/main.tex"),
        "\\documentclass{article}",
    );
    write(&tauri.data.join("templates/.half-made/template.json"), "{}");
    write(
        &tauri.data.join("synara/skills/proofread/SKILL.md"),
        "# Proofread",
    );
    write(
        &tauri.config.join("overleaf-session.json"),
        r#"{"host":"https://www.overleaf.com","cookie":"overleaf_session2=s3cret","email":"ada@example.com"}"#,
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(
            tauri.config.join("overleaf-session.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    write(
        &tauri.config.join("overleaf-local-copies.json"),
        r#"{"folders":["/Users/ada/Overleaf Projects/Thesis","/Users/ada/Paper"]}"#,
    );
    write(
        &tauri.config.join("overleaf-download-folder.json"),
        r#"{"folder":"/Users/ada/Overleaf Projects"}"#,
    );
}

#[test]
fn carries_every_kind_over_and_leaves_the_tauri_app_as_it_was() {
    let profile = profile("full");
    full_tauri_profile(&profile);
    let before = snapshot(&profile.root.join("tauri"));

    let report = migrate(&profile.tauri, &profile.gpui).expect("a first run");
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let carried: Vec<(&str, usize)> = report.carried.iter().map(|(k, v)| (*k, *v)).collect();
    assert_eq!(
        carried,
        [
            ("get started", 1),
            ("overleaf download folder", 1),
            ("overleaf linked folders", 2),
            ("overleaf session", 1),
            ("plugins", 2),
            ("recent commands", 1),
            ("recent projects", 2),
            ("skills", 1),
            ("submission templates", 1),
            ("templates", 1),
            ("themes", 1),
        ]
    );
    assert_eq!(snapshot(&profile.root.join("tauri")), before);

    let gpui = &profile.gpui;
    // Recent projects: in RecentProjects' shape, the nameless entry dropped.
    assert_eq!(
        read_json(&gpui.state.join("recent-projects.json")),
        json!([
            { "name": "Thesis", "path": "/Users/ada/Thesis", "openedAt": 1700000000000u64 },
            { "name": "Old", "path": "/Users/ada/Old" }
        ])
    );
    assert_eq!(
        read_json(&gpui.state.join("recent-commands.json")),
        json!(["build", "open-settings"])
    );
    assert_eq!(
        read_json(&gpui.state.join("submission-templates.json"))[0]["name"],
        "NeurIPS"
    );
    assert_eq!(
        read_json(&gpui.state.join("get-started.json"))["done"],
        json!(["build"])
    );

    // Plugins: the URL install's package copied and its record pointed at
    // the copy, still enabled with its grants; the folder install as it was.
    let registry = read_json(&gpui.data.join("plugins/registry.json"));
    let plugins = registry["plugins"].as_array().unwrap();
    assert_eq!(plugins.len(), 2);
    let package = gpui.data.join("plugins/packages/dev.ada.wordcount/1.2.0");
    assert_eq!(PathBuf::from(plugins[0]["dir"].as_str().unwrap()), package);
    assert_eq!(plugins[0]["enabled"], true);
    assert_eq!(plugins[0]["granted"], json!({ "projectRead": ["context"] }));
    assert!(package.join("main.js").is_file());
    assert_eq!(
        std::fs::read_to_string(gpui.data.join("plugins/data/dev.ada.wordcount/cache.json"))
            .unwrap(),
        "{\"n\":3}"
    );
    assert_eq!(plugins[1]["dir"], "/Users/ada/plugins/local");
    assert_eq!(plugins[1]["enabled"], false);

    // Themes: the one named by its id; the renamed file is no theme.
    assert_eq!(
        std::fs::read_to_string(gpui.data.join("themes/dev.ada.paper.json")).unwrap(),
        THEME
    );
    assert!(!gpui.data.join("themes/renamed.json").exists());

    // Templates and skills, whole; a half-made template stays behind.
    assert!(gpui.state.join("templates/abc123/files/main.tex").is_file());
    assert!(!gpui.state.join("templates/.half-made").exists());
    assert!(gpui.data.join("synara/skills/proofread/SKILL.md").is_file());

    // Overleaf: the session, owner-only, the linked folders and the download
    // folder.
    let session = gpui.overleaf.join("overleaf-session.json");
    assert_eq!(read_json(&session)["cookie"], "overleaf_session2=s3cret");
    #[cfg(unix)]
    {
        let mode_of = |path: &Path| mode(&std::fs::metadata(path).unwrap());
        assert_eq!(mode_of(&session), 0o600);
        assert_eq!(
            mode_of(&gpui.overleaf.join("overleaf-download-folder.json")),
            0o644
        );
    }
    assert_eq!(
        read_json(&gpui.overleaf.join("overleaf-local-copies.json"))["folders"],
        json!(["/Users/ada/Overleaf Projects/Thesis", "/Users/ada/Paper"])
    );
    assert_eq!(
        read_json(&gpui.overleaf.join("overleaf-download-folder.json"))["folder"],
        "/Users/ada/Overleaf Projects"
    );

    // Nothing half-written is left beside what was written.
    let leftovers: Vec<PathBuf> = snapshot(&profile.root.join("gpui"))
        .into_keys()
        .filter(|path| path.to_string_lossy().contains(".migrating"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = std::fs::remove_dir_all(&profile.root);
}

#[test]
fn runs_once_and_a_second_pass_adds_nothing_twice() {
    let profile = profile("twice");
    full_tauri_profile(&profile);
    assert!(migrate(&profile.tauri, &profile.gpui).is_some());
    let marker = read_json(&profile.gpui.state.join(MARKER));
    assert_eq!(marker["version"], MARKER_VERSION);
    assert_eq!(marker["carried"]["plugins"], 2);
    let after_first = snapshot(&profile.root.join("gpui"));

    // The marker skips the step.
    assert!(migrate(&profile.tauri, &profile.gpui).is_none());
    assert_eq!(snapshot(&profile.root.join("gpui")), after_first);

    // Without it (a launch whose first pass could not finish), the merges
    // find everything already there and change nothing but the marker.
    let marker_path = profile.gpui.state.join(MARKER);
    std::fs::remove_file(&marker_path).unwrap();
    let again = migrate(&profile.tauri, &profile.gpui).expect("a run");
    assert!(again.carried.is_empty(), "{:?}", again.carried);
    assert!(again.failed.is_empty());
    let without_marker = |mut files: BTreeMap<PathBuf, (Vec<u8>, u32)>| {
        assert!(files.remove(&marker_path).is_some());
        files
    };
    assert_eq!(
        without_marker(snapshot(&profile.root.join("gpui"))),
        without_marker(after_first)
    );
    let _ = std::fs::remove_dir_all(&profile.root);
}

#[test]
fn what_the_gpui_app_already_has_wins() {
    let profile = profile("own");
    full_tauri_profile(&profile);
    let gpui = &profile.gpui;
    write(
        &gpui.state.join("recent-projects.json"),
        r#"[{"name":"Mine","path":"/Users/ada/Mine","openedAt":5},{"name":"Thesis","path":"/Users/ada/Thesis","openedAt":9}]"#,
    );
    write(&gpui.state.join("recent-commands.json"), r#"["mine"]"#);
    write(
        &gpui.data.join("plugins/registry.json"),
        r#"{"version":1,"plugins":[{"id":"dev.ada.wordcount","dir":"/mine","enabled":false}]}"#,
    );
    write(
        &gpui.data.join("themes/dev.ada.paper.json"),
        "{\"id\":\"dev.ada.paper\",\"mine\":true}",
    );
    write(
        &gpui.overleaf.join("overleaf-session.json"),
        r#"{"cookie":"mine"}"#,
    );
    write(
        &gpui.overleaf.join("overleaf-local-copies.json"),
        r#"{"folders":["/Users/ada/Paper","/Users/ada/Mine"]}"#,
    );

    let report = migrate(&profile.tauri, gpui).expect("a run");
    assert!(report.failed.is_empty());
    assert_eq!(
        read_json(&gpui.state.join("recent-projects.json")),
        json!([
            { "name": "Mine", "path": "/Users/ada/Mine", "openedAt": 5 },
            { "name": "Thesis", "path": "/Users/ada/Thesis", "openedAt": 9 },
            { "name": "Old", "path": "/Users/ada/Old" }
        ])
    );
    assert_eq!(
        read_json(&gpui.state.join("recent-commands.json")),
        json!(["mine"])
    );
    let plugins = read_json(&gpui.data.join("plugins/registry.json"))["plugins"].clone();
    assert_eq!(
        plugins[0],
        json!({"id":"dev.ada.wordcount","dir":"/mine","enabled":false})
    );
    assert_eq!(plugins[1]["id"], "dev.ada.local");
    assert!(!gpui.data.join("plugins/packages").exists());
    assert_eq!(
        read_json(&gpui.data.join("themes/dev.ada.paper.json"))["mine"],
        true
    );
    assert_eq!(
        read_json(&gpui.overleaf.join("overleaf-session.json"))["cookie"],
        "mine"
    );
    assert_eq!(
        read_json(&gpui.overleaf.join("overleaf-local-copies.json"))["folders"],
        json!([
            "/Users/ada/Paper",
            "/Users/ada/Mine",
            "/Users/ada/Overleaf Projects/Thesis"
        ])
    );
    let _ = std::fs::remove_dir_all(&profile.root);
}

#[test]
fn recent_projects_stop_at_eight() {
    let profile = profile("eight");
    let tauri: Vec<Value> = (0..8)
        .map(|n| json!({ "name": format!("T{n}"), "path": format!("/t/{n}") }))
        .collect();
    let own: Vec<Value> = (0..6)
        .map(|n| json!({ "name": format!("G{n}"), "path": format!("/g/{n}") }))
        .collect();
    let target = profile.gpui.state.join("recent-projects.json");
    write(&target, &pretty(&Value::Array(own)));
    assert_eq!(
        recent_projects(Some(&pretty(&Value::Array(tauri))), &target).unwrap(),
        2
    );
    let list = read_json(&target);
    assert_eq!(list.as_array().unwrap().len(), RECENT_PROJECTS_KEPT);
    assert_eq!(list[7]["path"], "/t/1");
    let _ = std::fs::remove_dir_all(&profile.root);
}

/// Write `value` under `key` in the Tauri app's localStorage, as the Tauri
/// app does while it runs (after a switch back to it).
fn store(website_data: &Path, key: &str, value: &str) {
    let path = website_data.join("Default/salt/salt/LocalStorage/localstorage.sqlite3");
    // A write in the same millisecond as the last one would leave its time
    // unchanged.
    std::thread::sleep(std::time::Duration::from_millis(20));
    let connection = rusqlite::Connection::open(&path).unwrap();
    let blob: Vec<u8> = value.encode_utf16().flat_map(u16::to_le_bytes).collect();
    connection
        .execute(
            "INSERT INTO ItemTable VALUES (?1, ?2)",
            rusqlite::params![key, blob],
        )
        .unwrap();
    std::mem::forget(connection);
}

fn project(name: &str, opened_at: Option<u64>) -> Value {
    let mut entry = json!({ "name": name, "path": format!("/p/{name}") });
    if let Some(opened_at) = opened_at {
        entry["openedAt"] = opened_at.into();
    }
    entry
}

fn union(own: &[Value], tauri: &[Value]) -> (usize, Vec<Value>) {
    static RUN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let run = RUN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = scratch(&format!("union-{run}"));
    let target = dir.join("recent-projects.json");
    if !own.is_empty() {
        write(&target, &pretty(&Value::Array(own.to_vec())));
    }
    let changed =
        recent_projects_union(Some(&pretty(&Value::Array(tauri.to_vec()))), &target).unwrap();
    let list = std::fs::read(&target)
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).unwrap())
        .unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    (changed, list)
}

#[test]
fn a_later_switch_joins_both_lists_newest_first_in_either_order() {
    // The Tauri app's projects newer than the GPUI app's.
    let (changed, list) = union(
        &[project("g1", Some(20)), project("g2", Some(10))],
        &[project("t1", Some(40)), project("t2", Some(30))],
    );
    assert_eq!(changed, 2);
    assert_eq!(
        list,
        vec![
            project("t1", Some(40)),
            project("t2", Some(30)),
            project("g1", Some(20)),
            project("g2", Some(10)),
        ]
    );
    // And older: the same list either way.
    let (_, list) = union(
        &[project("t1", Some(40)), project("t2", Some(30))],
        &[
            project("g1", Some(20)),
            project("g2", Some(10)),
            project("old", None),
        ],
    );
    assert_eq!(
        list,
        vec![
            project("t1", Some(40)),
            project("t2", Some(30)),
            project("g1", Some(20)),
            project("g2", Some(10)),
            project("old", None),
        ]
    );
}

#[test]
fn a_folder_in_both_lists_keeps_the_newer_opening() {
    let (changed, list) = union(
        &[project("a", Some(10)), project("b", Some(50))],
        &[project("a", Some(60)), project("b", Some(5))],
    );
    assert_eq!(changed, 1);
    assert_eq!(list, vec![project("a", Some(60)), project("b", Some(50))]);
    // Nothing newer: the list is left as it was, unwritten.
    let (changed, list) = union(
        &[project("a", Some(60)), project("b", Some(50))],
        &[project("a", Some(60)), project("b", None)],
    );
    assert_eq!(changed, 0);
    assert_eq!(list, vec![project("a", Some(60)), project("b", Some(50))]);
}

#[test]
fn the_union_keeps_eight_and_never_drops_the_gpui_apps_own() {
    let own: Vec<Value> = (0..6).map(|n| project(&format!("g{n}"), Some(n))).collect();
    let tauri: Vec<Value> = (0..5)
        .map(|n| project(&format!("t{n}"), Some(100 + n)))
        .collect();
    let (_, list) = union(&own, &tauri);
    assert_eq!(list.len(), RECENT_PROJECTS_KEPT);
    // The two newest of the Tauri app's, then all six of the GPUI app's.
    assert_eq!(list[0], project("t4", Some(104)));
    assert_eq!(list[1], project("t3", Some(103)));
    for entry in &own {
        assert!(list.contains(entry), "{entry} was dropped");
    }
    // A full list takes none of the Tauri app's in, however new.
    let full: Vec<Value> = (0..8).map(|n| project(&format!("g{n}"), Some(n))).collect();
    let (changed, list) = union(&full, &tauri);
    assert_eq!(changed, 0);
    assert_eq!(list.len(), RECENT_PROJECTS_KEPT);
    for entry in &full {
        assert!(list.contains(entry));
    }
}

#[test]
fn a_later_switch_merges_the_recent_projects_and_nothing_else() {
    let profile = profile("later");
    full_tauri_profile(&profile);
    let (tauri, gpui) = (&profile.tauri, &profile.gpui);
    // No marker yet: the first pass's to do, not this.
    assert!(merge_recent_projects(tauri, gpui).is_none());
    assert!(migrate(tauri, gpui).is_some());
    // The launch after the first pass: the Tauri app has not run since.
    assert!(merge_recent_projects(tauri, gpui).is_none());

    // Some time in the GPUI app...
    write(
        &gpui.state.join("recent-projects.json"),
        r#"[{"name":"Native","path":"/Users/ada/Native","openedAt":1800000000000},{"name":"Thesis","path":"/Users/ada/Thesis","openedAt":1750000000000}]"#,
    );
    write(&gpui.state.join("recent-commands.json"), r#"["mine"]"#);
    write(
        &gpui.overleaf.join("overleaf-session.json"),
        r#"{"cookie":"mine"}"#,
    );
    // ...then back in the Tauri app, which opens projects and changes the
    // rest of its state too.
    let website_data = tauri.website_data.as_deref().unwrap();
    store(
        website_data,
        RECENT_PROJECTS,
        r#"[{"name":"Back","path":"/Users/ada/Back","openedAt":1900000000000},{"name":"Thesis","path":"/Users/ada/Thesis","openedAt":1850000000000}]"#,
    );
    store(website_data, RECENT_COMMANDS, r#"["tauri"]"#);
    write(
        &tauri.config.join("overleaf-session.json"),
        r#"{"cookie":"tauri"}"#,
    );
    write(
        &tauri.data.join("themes/dev.ada.new.json"),
        r#"{"id":"dev.ada.new"}"#,
    );
    write(&tauri.data.join("synara/skills/cite/SKILL.md"), "# Cite");
    let tauri_before = snapshot(&profile.root.join("tauri"));
    let gpui_before = snapshot(&profile.root.join("gpui"));

    let merged = merge_recent_projects(tauri, gpui)
        .expect("the Tauri app ran since")
        .unwrap();
    assert_eq!(merged, 2);
    assert_eq!(
        read_json(&gpui.state.join("recent-projects.json")),
        json!([
            { "name": "Back", "path": "/Users/ada/Back", "openedAt": 1900000000000u64 },
            { "name": "Thesis", "path": "/Users/ada/Thesis", "openedAt": 1850000000000u64 },
            { "name": "Native", "path": "/Users/ada/Native", "openedAt": 1800000000000u64 }
        ])
    );
    // Only the list and the marker changed; the Tauri app's files not at all.
    let recents = gpui.state.join("recent-projects.json");
    let marker = gpui.state.join(MARKER);
    let mut after = snapshot(&profile.root.join("gpui"));
    let mut before = gpui_before;
    for path in [&recents, &marker] {
        after.remove(path);
        before.remove(path);
    }
    assert_eq!(after, before);
    assert_eq!(snapshot(&profile.root.join("tauri")), tauri_before);
    assert_eq!(read_json(&marker)["carried"]["plugins"], 2);

    // Once per switch: the next launch finds the storage as it was.
    assert!(merge_recent_projects(tauri, gpui).is_none());
    let _ = std::fs::remove_dir_all(&profile.root);
}

#[test]
fn no_tauri_app_carries_nothing_and_still_marks_the_step_done() {
    let profile = profile("missing");
    let report = migrate(&profile.tauri, &profile.gpui).expect("a run");
    assert!(report.carried.is_empty());
    assert!(report.failed.is_empty());
    assert!(!profile.root.join("tauri").exists());
    let written: Vec<PathBuf> = snapshot(&profile.root.join("gpui")).into_keys().collect();
    assert_eq!(written, [profile.gpui.state.join(MARKER)]);
    assert!(migrate(&profile.tauri, &profile.gpui).is_none());
    let _ = std::fs::remove_dir_all(&profile.root);
}

#[test]
fn corrupt_tauri_stores_carry_nothing_and_break_nothing() {
    let profile = profile("corrupt");
    let tauri = &profile.tauri;
    // A localStorage "database" that is not one, and values that do not
    // parse in a second, readable one.
    write(
        &tauri
            .website_data
            .as_deref()
            .unwrap()
            .join("Default/bad/bad/LocalStorage/localstorage.sqlite3"),
        "not a database",
    );
    local_storage(
        tauri.website_data.as_deref().unwrap(),
        &[
            (RECENT_PROJECTS, "{ not json"),
            (RECENT_COMMANDS, r#"{"not":"a list"}"#),
            (GET_STARTED, "[]"),
        ],
    );
    write(&tauri.data.join("plugins/registry.json"), "{ truncated");
    write(&tauri.data.join("themes/dev.ada.paper.json"), "{ truncated");
    write(&tauri.config.join("overleaf-session.json"), "garbage");
    write(
        &tauri.config.join("overleaf-local-copies.json"),
        r#"{"folders":"nope"}"#,
    );
    write(&tauri.config.join("overleaf-download-folder.json"), "{}");
    let before = snapshot(&profile.root.join("tauri"));

    let report = migrate(tauri, &profile.gpui).expect("a run");
    assert!(report.carried.is_empty(), "{:?}", report.carried);
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(snapshot(&profile.root.join("tauri")), before);
    let written: Vec<PathBuf> = snapshot(&profile.root.join("gpui")).into_keys().collect();
    assert_eq!(written, [profile.gpui.state.join(MARKER)]);
    let _ = std::fs::remove_dir_all(&profile.root);
}

#[test]
fn gpui_folders_inside_the_tauri_apps_are_refused() {
    let profile = profile("overlap");
    full_tauri_profile(&profile);
    let before = snapshot(&profile.root.join("tauri"));
    let inside = Gpui {
        state: profile.root.join("gpui/state"),
        data: profile.tauri.data.join("lattice-gpui"),
        overleaf: profile.root.join("gpui/overleaf"),
    };
    assert!(migrate(&profile.tauri, &inside).is_none());
    let same_config = Gpui {
        state: profile.root.join("gpui/state"),
        data: profile.root.join("gpui/data"),
        overleaf: profile.tauri.config.clone(),
    };
    assert!(migrate(&profile.tauri, &same_config).is_none());
    assert_eq!(snapshot(&profile.root.join("tauri")), before);
    assert!(!profile.root.join("gpui").exists());
    let _ = std::fs::remove_dir_all(&profile.root);
}

#[test]
fn a_plugin_whose_package_is_gone_stays_behind() {
    let profile = profile("gone");
    let from = profile.tauri.data.join("plugins");
    let registry = json!({ "version": 1, "plugins": [{
        "id": "dev.ada.gone",
        "source": { "kind": "url", "url": "https://example.com/g.zip", "sha256": "ab" },
        "dir": from.join("packages/dev.ada.gone/1.0.0"),
        "enabled": true
    }]});
    write(&from.join("registry.json"), &pretty(&registry));
    let to = profile.gpui.data.join("plugins");
    assert_eq!(plugins(&from, &to).unwrap(), 0);
    assert!(!to.exists());
    let _ = std::fs::remove_dir_all(&profile.root);
}

#[test]
fn a_corrupt_gpui_plugin_registry_is_left_alone() {
    let profile = profile("own-corrupt");
    full_tauri_profile(&profile);
    let registry = profile.gpui.data.join("plugins/registry.json");
    write(&registry, "{ mine, truncated");
    let report = migrate(&profile.tauri, &profile.gpui).expect("a run");
    assert!(!report.carried.contains_key("plugins"));
    assert_eq!(
        std::fs::read_to_string(&registry).unwrap(),
        "{ mine, truncated"
    );
    let _ = std::fs::remove_dir_all(&profile.root);
}

#[test]
fn a_kind_that_cannot_be_written_leaves_no_marker_and_runs_again() {
    let profile = profile("blocked");
    full_tauri_profile(&profile);
    // The themes folder is a file, so no theme can be written into it.
    write(&profile.gpui.data.join("themes"), "in the way");
    let report = migrate(&profile.tauri, &profile.gpui).expect("a run");
    assert_eq!(
        report
            .failed
            .iter()
            .map(|(kind, _)| *kind)
            .collect::<Vec<_>>(),
        ["themes"]
    );
    assert!(report.carried.contains_key("plugins"));
    assert!(!profile.gpui.state.join(MARKER).exists());

    std::fs::remove_file(profile.gpui.data.join("themes")).unwrap();
    let again = migrate(&profile.tauri, &profile.gpui).expect("a second run");
    let carried: Vec<&str> = again.carried.keys().copied().collect();
    assert_eq!(carried, ["themes"]);
    assert!(profile.gpui.state.join(MARKER).exists());
    let _ = std::fs::remove_dir_all(&profile.root);
}
