//! The agent's reviews of the paper (`.research/reviews/<id>.json`): one
//! file per review, named by when it started (a UTC time, so the names sort
//! in the order the reviews were made), with the writer's decision on each of
//! its points. The panel reopens on the newest.
//!
//! The report's shape belongs to the renderer (`src/agent/agent-review.ts`),
//! which checks it on the way back in; this side only keeps the file a JSON
//! object of bounded size under a name it chose.

use crate::project_fs::ProjectDir;
use crate::util::err;
use std::fs;
use std::path::Path;

const REVIEWS_DIRECTORY: &str = ".research/reviews";
/// Far past any report (sixteen findings of a few hundred characters each).
const MAX_REVIEW_BYTES: usize = 1024 * 1024;

/// Whether `id` names a review file: the renderer's UTC timestamp, or any
/// short run of letters, digits and dashes, so it can never leave the folder.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// The newest review, or none before the first.
pub fn read_latest_review(root: &Path) -> Result<Option<serde_json::Value>, String> {
    let directory = root.join(REVIEWS_DIRECTORY);
    let Ok(entries) = fs::read_dir(&directory) else {
        return Ok(None);
    };
    let mut ids = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_suffix(".json")?;
            (valid_id(id) && entry.file_type().ok()?.is_file()).then(|| id.to_string())
        })
        .collect::<Vec<_>>();
    ids.sort();
    // A file a crash cut short, an edit by hand broke or that cannot be read gives way to the one before it.
    for id in ids.iter().rev() {
        let Ok(raw) = fs::read_to_string(directory.join(format!("{id}.json"))) else {
            continue;
        };
        if let Ok(value @ serde_json::Value::Object(_)) = serde_json::from_str(&raw) {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

/// Write review `id`, replacing the file of that review.
pub fn write_review(root: &Path, id: &str, review: &serde_json::Value) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Invalid review id.".into());
    }
    if !review.is_object() {
        return Err("A review must be a JSON object.".into());
    }
    if serde_json::to_vec(review).map_err(err)?.len() > MAX_REVIEW_BYTES {
        return Err("The review is too large to save.".into());
    }
    let raw = serde_json::to_string_pretty(review).map_err(err)?;
    ProjectDir::open(root)?.atomic_write(&format!("{REVIEWS_DIRECTORY}/{id}.json"), format!("{raw}\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;
    use serde_json::json;

    #[test]
    fn reads_the_newest_review_back() {
        let fixture = Fixture::empty("reviews-newest");
        assert_eq!(read_latest_review(&fixture.root).unwrap(), None);
        write_review(&fixture.root, "2026-10-16T02-42-05Z", &json!({ "id": "a" })).unwrap();
        write_review(&fixture.root, "2026-10-17T09-00-00Z", &json!({ "id": "b" })).unwrap();
        assert_eq!(read_latest_review(&fixture.root).unwrap(), Some(json!({ "id": "b" })));
        // Saving a decision on a review rewrites its own file.
        write_review(&fixture.root, "2026-10-17T09-00-00Z", &json!({ "id": "b", "seen": true }))
            .unwrap();
        assert_eq!(
            read_latest_review(&fixture.root).unwrap(),
            Some(json!({ "id": "b", "seen": true }))
        );
    }

    #[test]
    fn skips_a_broken_file_for_the_one_before() {
        let fixture = Fixture::empty("reviews-broken");
        write_review(&fixture.root, "2026-10-16T02-42-05Z", &json!({ "id": "a" })).unwrap();
        fixture.write(".research/reviews/2026-10-18T00-00-00Z.json", "{ \"id\": ");
        fixture.write(".research/reviews/notes.txt", "not a review");
        fs::write(fixture.path(".research/reviews/2026-10-19T00-00-00Z.json"), [0xff, 0xfe]).unwrap();
        assert_eq!(read_latest_review(&fixture.root).unwrap(), Some(json!({ "id": "a" })));
    }

    #[test]
    fn refuses_names_that_leave_the_folder_and_values_that_are_not_reports() {
        let fixture = Fixture::empty("reviews-refused");
        for id in ["", "../annotations", "a/b", "a.json", &"x".repeat(65)] {
            assert!(write_review(&fixture.root, id, &json!({})).is_err(), "{id}");
        }
        assert!(write_review(&fixture.root, "ok", &json!([1, 2])).is_err());
        let huge = json!({ "verdict": "x".repeat(MAX_REVIEW_BYTES) });
        assert!(write_review(&fixture.root, "ok", &huge).is_err());
        assert!(!fixture.path(".research/reviews/ok.json").exists());
    }
}
