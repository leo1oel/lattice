//! Default-off seeding of the bundled `research-writing` skill.
//!
//! Synara's Settings switch and provider discovery share `skills.disabled`.
//! Frontmatter alone does not enforce a default-off skill in the pinned runtime.
//! Seed that preference before starting the managed sidecar, once for both new
//! and upgrading users. Keep the marker outside Synara's settings envelope:
//! Synara rewrites that envelope and drops unknown fields when a setting changes.

use serde_json::{json, Value};
use std::path::Path;

const SETTINGS: &str = "userdata/settings.json";
const MARKER: &str = "userdata/.lattice-research-writing-default-v1";
const SKILL: &str = "research-writing";

pub(super) fn initialize_research_writing_preference(home: &Path) -> Result<(), String> {
    if home.join(MARKER).is_file() && home.join(SETTINGS).is_file() {
        return Ok(());
    }
    let mut document: Value = match std::fs::read(home.join(SETTINGS)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error.to_string()),
    }
    .map_err(|error| format!("Could not read the agent skill preferences: {error}"))?;
    // Older Synara installations store plain settings, newer ones wrap them in
    // { revision, migrationVersion, settings }. Preserve either format and all
    // unrelated preferences, including provider credentials in legacy files.
    let settings = if document.get("settings").is_some() {
        document.get_mut("settings").expect("settings field exists")
    } else {
        &mut document
    };
    let settings = settings.as_object_mut().ok_or("The agent settings must be a JSON object.")?;
    let disabled = settings
        .entry("skills")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("The agent skill preferences must be a JSON object.")?
        .entry("disabled")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or("The disabled agent skills must be a JSON array.")?;
    if !disabled.iter().all(Value::is_string) {
        return Err("The disabled agent skills must contain only names.".into());
    }
    if !disabled
        .iter()
        .any(|name| name.as_str().is_some_and(|name| name.trim().eq_ignore_ascii_case(SKILL)))
    {
        disabled.push(json!(SKILL));
    }

    let bytes = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("Could not encode the agent skill preferences: {error}"))?;
    let directory = crate::project_fs::ProjectDir::open(home)?;
    directory.atomic_write(SETTINGS, &bytes)?;
    // A failed migration must not start the sidecar. Retrying before the marker
    // is written is safe; after it is written, Settings owns the user's choice.
    directory.atomic_write(MARKER, b"1\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn read(home: &TempDir) -> Vec<u8> {
        std::fs::read(home.join(SETTINGS)).unwrap()
    }

    fn json(home: &TempDir) -> Value {
        serde_json::from_slice(&read(home)).unwrap()
    }

    #[test]
    fn research_writing_defaults_off_and_preserves_settings_choices_on_restart() {
        let home = TempDir::new("skills");
        initialize_research_writing_preference(&home).unwrap();
        let initial = json(&home);
        assert_eq!(initial, json!({"skills": {"disabled": ["research-writing"]}}));

        // Synara's Settings switch removes the name when enabling and adds it
        // when disabling; subsequent host startups must preserve both choices.
        for disabled in [json!([]), json!(["research-writing"])] {
            let saved = serde_json::to_vec(&json!({
                "revision": 8, "migrationVersion": 2,
                "settings": {"skills": {"disabled": disabled}, "theme": "dark"}
            }))
            .unwrap();
            home.write(SETTINGS, &saved);
            initialize_research_writing_preference(&home).unwrap();
            assert_eq!(read(&home), saved);
        }

        // Resetting settings restores the opt-in default, even with a marker.
        std::fs::remove_file(home.join(SETTINGS)).unwrap();
        initialize_research_writing_preference(&home).unwrap();
        assert_eq!(json(&home), initial);
    }

    #[test]
    fn research_writing_upgrade_preserves_legacy_and_enveloped_settings() {
        for enveloped in [false, true] {
            for (disabled, expected_disabled) in [
                (json!(["other"]), json!(["other", "research-writing"])),
                (json!(["Research-Writing"]), json!(["Research-Writing"])),
            ] {
                let settings = |disabled: Value| {
                    let settings = json!({
                        "skills": {"disabled": disabled},
                        "providers": {"claudeCode": {"enabled": false}}
                    });
                    if enveloped {
                        json!({"revision": 7, "migrationVersion": 2, "settings": settings})
                    } else {
                        settings
                    }
                };
                let home = TempDir::new("skills");
                home.write(SETTINGS, serde_json::to_vec(&settings(disabled)).unwrap());
                initialize_research_writing_preference(&home).unwrap();
                assert_eq!(json(&home), settings(expected_disabled));
            }
        }
    }

    #[test]
    fn research_writing_does_not_overwrite_invalid_preferences() {
        for invalid in ["{", "[]", r#"{"settings":null}"#, r#"{"skills":{"disabled":[1]}}"#] {
            let home = TempDir::new("skills");
            home.write(SETTINGS, invalid);
            assert!(initialize_research_writing_preference(&home).is_err());
            assert_eq!(read(&home), invalid.as_bytes());
            assert!(!home.join(MARKER).exists());
        }
    }
}
