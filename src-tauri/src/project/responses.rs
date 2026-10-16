//! The writer's answers to the venue's reviewers (`.research/responses.json`):
//! each reviewer comment as it was pasted, its stable number, the reply and
//! what changed for it. One file per project, rewritten whole on each save.
//!
//! The shape belongs to the renderer (`src/project/reviewer-responses.ts`),
//! which checks it on the way back in; this side only keeps the file a JSON
//! object of bounded size.

use crate::project_fs::ProjectDir;
use crate::util::err;
use std::fs;
use std::path::Path;

const RESPONSES_FILE: &str = ".research/responses.json";
/// Far past any review cycle: dozens of comments of a few thousand characters
/// each, with replies as long.
const MAX_RESPONSES_BYTES: usize = 4 * 1024 * 1024;

/// The project's responses, or none before the first comment is added. A file
/// that is there but cannot be read or parsed (a merge left conflict markers
/// in it) is an error, never none: the renderer would otherwise save a fresh
/// one over every comment it still holds.
pub fn read_responses(root: &Path) -> Result<Option<serde_json::Value>, String> {
    let raw = match fs::read_to_string(root.join(RESPONSES_FILE)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{RESPONSES_FILE} could not be read: {error}")),
    };
    match serde_json::from_str(&raw) {
        Ok(value @ serde_json::Value::Object(_)) => Ok(Some(value)),
        Ok(_) => Err(format!("{RESPONSES_FILE} is not a JSON object.")),
        Err(error) => Err(format!("{RESPONSES_FILE} is not valid JSON: {error}")),
    }
}

/// Replace the project's responses.
pub fn write_responses(root: &Path, responses: &serde_json::Value) -> Result<(), String> {
    if !responses.is_object() {
        return Err("The responses must be a JSON object.".into());
    }
    let raw = serde_json::to_string_pretty(responses).map_err(err)?;
    if raw.len() > MAX_RESPONSES_BYTES {
        return Err("The responses are too large to save.".into());
    }
    ProjectDir::open(root)?.atomic_write(RESPONSES_FILE, format!("{raw}\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;
    use serde_json::json;

    #[test]
    fn reads_back_what_was_written() {
        let fixture = Fixture::empty("responses-round-trip");
        assert_eq!(read_responses(&fixture.root).unwrap(), None);
        let saved =
            json!({ "version": 1, "comments": [{ "id": "a", "reviewer": 1, "number": 1 }] });
        write_responses(&fixture.root, &saved).unwrap();
        assert_eq!(read_responses(&fixture.root).unwrap(), Some(saved));
    }

    #[test]
    fn a_broken_file_is_an_error_and_only_an_absent_one_is_none() {
        let fixture = Fixture::empty("responses-broken");
        assert_eq!(read_responses(&fixture.root).unwrap(), None);
        fixture.write(
            RESPONSES_FILE,
            "<<<<<<< HEAD\n{ \"version\": 1, \"comments\": [] }\n=======\n{ \"version\": 1 }\n>>>>>>> theirs\n",
        );
        assert!(read_responses(&fixture.root).is_err());
        fixture.write(RESPONSES_FILE, "{ \"version\": ");
        assert!(read_responses(&fixture.root).is_err());
        fixture.write(RESPONSES_FILE, "[1, 2]");
        assert!(read_responses(&fixture.root).is_err());
        fs::write(fixture.path(RESPONSES_FILE), [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_responses(&fixture.root).is_err());
    }

    #[test]
    fn refuses_values_that_are_not_objects_or_too_large() {
        let fixture = Fixture::empty("responses-refused");
        assert!(write_responses(&fixture.root, &json!([1, 2])).is_err());
        let huge = json!({ "comments": "x".repeat(MAX_RESPONSES_BYTES) });
        assert!(write_responses(&fixture.root, &huge).is_err());
        assert!(!fixture.path(RESPONSES_FILE).exists());
    }
}
