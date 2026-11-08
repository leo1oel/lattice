use super::{install, list, remove, run, set_enabled};
use crate::test_support::TempDir;
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn fixture() -> (TempDir, TempDir) {
    let store = TempDir::new("plugin-store");
    let plugin = TempDir::new("plugin-source");
    plugin.write("lattice-plugin.json", r#"{"id":"example.hello","name":"Hello","version":"1.0.0","api_version":1,"commands":[{"id":"hello","title":"Hello","executable":"hello.sh"}]}"#);
    let script = plugin.write("hello.sh", "#!/bin/sh\nread request\nprintf '%s\\n' \"$LATTICE_PLUGIN_ID:$LATTICE_COMMAND_ID:$LATTICE_PLUGIN_API_VERSION\" \"$request\"\n");
    fs::set_permissions(script, fs::Permissions::from_mode(0o755)).unwrap();
    (store, plugin)
}

#[test]
fn install_enable_run_disable_and_remove_leave_the_source_intact() {
    let (store, plugin) = fixture();
    assert!(!install(&store, &plugin).unwrap()[0].enabled);
    assert!(install(&store, &plugin).is_err());
    assert!(run(&store, "example.hello", "hello", None).is_err());
    assert!(set_enabled(&store, "example.hello", true).unwrap()[0].enabled);
    let project = TempDir::new("plugin-project");
    let result = run(&store, "example.hello", "hello", Some(&project)).unwrap();
    assert!(result.success);
    assert!(result.stdout.contains("example.hello:hello:1"));
    assert!(result.stdout.contains(&project.to_string_lossy().to_string()));
    assert!(run(&store, "example.hello", "unknown", None).is_err());
    set_enabled(&store, "example.hello", false).unwrap();
    assert!(run(&store, "example.hello", "hello", None).is_err());
    remove(&store, "example.hello").unwrap();
    assert!(list(&store).unwrap().is_empty());
    assert!(plugin.join("hello.sh").exists());
}

#[test]
fn refuses_escaping_executables_and_a_changed_manifest() {
    let (store, plugin) = fixture();
    let manifest = plugin.join("lattice-plugin.json");
    let good = fs::read_to_string(&manifest).unwrap();
    fs::write(&manifest, good.replace("hello.sh", "../outside.sh")).unwrap();
    assert!(install(&store, &plugin).is_err());
    fs::write(&manifest, &good).unwrap();
    install(&store, &plugin).unwrap();
    set_enabled(&store, "example.hello", true).unwrap();
    fs::write(&manifest, good.replace("Hello\",\"version", "Changed\",\"version")).unwrap();
    assert!(run(&store, "example.hello", "hello", None).unwrap_err().contains("changed"));
}

#[test]
fn unknown_api_and_invalid_ids_are_rejected() {
    let (store, plugin) = fixture();
    let manifest = plugin.join("lattice-plugin.json");
    let good = fs::read_to_string(&manifest).unwrap();
    fs::write(&manifest, good.replace("\"api_version\":1", "\"api_version\":2")).unwrap();
    assert!(install(&store, &plugin).is_err());
    fs::write(&manifest, good.replace("example.hello", "../bad")).unwrap();
    assert!(install(&store, &plugin).is_err());
}
