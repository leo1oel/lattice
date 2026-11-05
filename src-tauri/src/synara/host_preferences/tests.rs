use super::*;
use crate::test_support::TempDir;
use serde_json::{json, Value};

fn patch(value: Value) -> Patch {
    serde_json::from_value(value).unwrap()
}

#[test]
fn native_preferences_merge_sections_and_survive_a_new_load_without_private_state() {
    let directory = TempDir::new("agent-ui-prefs");
    save(&directory, patch(json!({"kind":"general","defaultProvider":"codex"}))).unwrap();
    let composer = json!({
        "stickyActiveProvider":"codex",
        "stickyModelSelectionByProvider":{"codex":{
            "provider":"codex","model":"gpt-6.1-sol","instanceId":"codex",
            "options":{"reasoningEffort":"high","fastMode":false}
        }}
    });
    save(&directory, patch(json!({"kind":"composer","composer":composer}))).unwrap();
    assert_eq!(
        serde_json::to_value(load(&directory).unwrap()).unwrap(),
        json!({"defaultProvider":"codex","composer":composer})
    );
    // General resets must not discard the independently saved model choices.
    save(&directory, patch(json!({"kind":"general","defaultProvider":null}))).unwrap();
    assert_eq!(
        serde_json::to_value(load(&directory).unwrap()).unwrap(),
        json!({"composer":composer})
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(directory.join(FILE)).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn native_preferences_refuse_unknown_fields_invalid_selections_and_oversized_storage() {
    for value in [
        json!({"kind":"general","defaultProvider":"codex","apiKey":"private"}),
        json!({"kind":"composer","composer":{"stickyActiveProvider":null,"stickyModelSelectionByProvider":{},"draftsByThreadId":{"private":"text"}}}),
        json!({"kind":"composer","composer":{"stickyActiveProvider":"codex","stickyModelSelectionByProvider":{"codex":{"provider":"codex","model":"gpt-6.1-sol","options":{"apiKey":"private"}}}}}),
    ] {
        assert!(serde_json::from_value::<Patch>(value).is_err());
    }
    let directory = TempDir::new("agent-ui-prefs-invalid");
    for value in [
        json!({"kind":"general","defaultProvider":"other"}),
        json!({"kind":"composer","composer":{"stickyActiveProvider":"missing","stickyModelSelectionByProvider":{}}}),
        json!({"kind":"composer","composer":{"stickyActiveProvider":"codex","stickyModelSelectionByProvider":{"codex":{"provider":"codex","model":"x".repeat(257)}}}}),
        json!({"kind":"composer","composer":{"stickyActiveProvider":"codex","stickyModelSelectionByProvider":{"codex":{"provider":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"unbounded-value"}}}}}),
    ] {
        assert!(save(&directory, patch(value)).is_err());
        assert!(!directory.join(FILE).exists());
    }
    directory.write(FILE, vec![b' '; LIMIT as usize + 1]);
    assert!(load(&directory).is_err());
}

#[test]
fn native_preferences_do_not_rewrite_corrupt_files_or_follow_destination_links() {
    let directory = TempDir::new("agent-ui-prefs-corrupt");
    directory.write(FILE, b"{ invalid");
    assert!(save(&directory, patch(json!({"kind":"general","defaultProvider":"codex"}))).is_err());
    assert_eq!(std::fs::read(directory.join(FILE)).unwrap(), b"{ invalid");
    #[cfg(unix)]
    {
        let target = directory.write("target", b"{}");
        std::fs::remove_file(directory.join(FILE)).unwrap();
        std::os::unix::fs::symlink(&target, directory.join(FILE)).unwrap();
        assert!(
            save(&directory, patch(json!({"kind":"general","defaultProvider":"codex"}))).is_err()
        );
        assert_eq!(std::fs::read(target).unwrap(), b"{}");
    }
}
