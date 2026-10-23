//! What the app writes into a project's manifest beside its root documents:
//! the settings dialog's build settings and budgets, the deadline, the
//! submission checklist's own items and the project dictionary.

use super::manifest::{read_manifest, write_manifest};
use super::paths::{safe_path, stays_inside};
use crate::models::{ProjectDeadline, ProjectManifest, SubmissionItem};
use std::path::Path;

/// What the settings dialog, the budget editor and the build panel's engine
/// actions change. `None` keeps a setting and a `Some(None)` budget clears it.
#[derive(Debug, Default)]
pub struct ManifestSettings {
    pub engine: Option<String>,
    pub keep_engine: Option<bool>,
    pub trusted: Option<bool>,
    pub stop_on_first_error: Option<bool>,
    pub word_budget: Option<Option<u32>>,
    pub page_budget: Option<Option<u32>>,
}

pub fn update_manifest_settings(
    root: &Path, settings: ManifestSettings,
) -> Result<ProjectManifest, String> {
    let mut manifest = read_manifest(root)?;
    if let Some(engine) = settings.engine {
        let normalized = engine.trim().to_ascii_lowercase();
        if !matches!(normalized.as_str(), "pdf" | "xelatex" | "lualatex") {
            return Err("Choose pdf, xelatex, or lualatex.".to_string());
        }
        manifest.engine = normalized;
    }
    manifest.keep_engine = settings.keep_engine.unwrap_or(manifest.keep_engine);
    manifest.trusted = settings.trusted.unwrap_or(manifest.trusted);
    manifest.stop_on_first_error =
        settings.stop_on_first_error.unwrap_or(manifest.stop_on_first_error);
    manifest.word_budget = settings.word_budget.unwrap_or(manifest.word_budget);
    manifest.page_budget = settings.page_budget.unwrap_or(manifest.page_budget);
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

/// Set or clear the submission deadline. The venue is trimmed and the time
/// must be a whole minute in the "YYYY-MM-DDTHH:MM" form, Anywhere on Earth.
pub fn set_deadline(
    root: &Path, deadline: Option<ProjectDeadline>,
) -> Result<ProjectManifest, String> {
    let mut manifest = read_manifest(root)?;
    manifest.deadline = match deadline {
        None => None,
        Some(deadline) => {
            let venue = deadline.venue.trim().to_string();
            if venue.is_empty() || venue.chars().count() > 80 {
                return Err("Name the deadline in at most 80 characters.".to_string());
            }
            if !matches!(deadline.kind.as_str(), "abstract" | "paper" | "rebuttal") {
                return Err("Choose abstract, paper, or rebuttal.".to_string());
            }
            let due = chrono::NaiveDateTime::parse_from_str(&deadline.due, "%Y-%m-%dT%H:%M")
                .map_err(|_| "Give the deadline as a date and a time.".to_string())?;
            Some(ProjectDeadline {
                venue,
                kind: deadline.kind,
                due: due.format("%Y-%m-%dT%H:%M").to_string(),
            })
        }
    };
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

/// Replace the checklist's own items. Text is trimmed and an empty optional
/// field is dropped. A confirmed item linked to a file keeps the stamp it was
/// sent with, or takes the file's current mtime when it arrives without one
/// (just confirmed, or confirmed again after a change); any other item holds
/// no stamp.
pub fn set_submission_items(
    root: &Path, items: Vec<SubmissionItem>,
) -> Result<ProjectManifest, String> {
    fn optional(value: Option<String>, limit: usize, what: &str) -> Result<Option<String>, String> {
        let value = value.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        match value {
            Some(value) if value.chars().count() > limit => {
                Err(format!("Keep the {what} to at most {limit} characters."))
            }
            value => Ok(value),
        }
    }
    if items.len() > 200 {
        return Err("A checklist holds at most 200 items.".to_string());
    }
    let mut manifest = read_manifest(root)?;
    let mut normalized: Vec<SubmissionItem> = Vec::with_capacity(items.len());
    for item in items {
        let id = item.id.trim().to_string();
        if id.is_empty() || id.len() > 64 || normalized.iter().any(|seen| seen.id == id) {
            return Err("Each checklist item needs its own id.".to_string());
        }
        let title = item.title.trim().to_string();
        if title.is_empty() || title.chars().count() > 200 {
            return Err("Name each checklist item in at most 200 characters.".to_string());
        }
        if !matches!(item.status.as_str(), "todo" | "review" | "confirmed") {
            return Err("Choose to do, to check, or confirmed.".to_string());
        }
        let file = optional(item.file, 500, "file path")?;
        if file.as_deref().is_some_and(|file| !stays_inside(Path::new(file))) {
            return Err("Link a file inside the project.".to_string());
        }
        let source_checked = optional(item.source_checked, 10, "checked date")?;
        if let Some(day) = &source_checked {
            chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
                .map_err(|_| "Give the checked date as a day.".to_string())?;
        }
        let confirmed_mtime_ms = match (&file, item.status.as_str()) {
            (Some(file), "confirmed") => {
                item.confirmed_mtime_ms.or_else(|| file_mtime_ms(root, file))
            }
            _ => None,
        };
        normalized.push(SubmissionItem {
            id,
            title,
            status: item.status,
            file,
            source: optional(item.source, 500, "source")?,
            source_checked,
            owner: optional(item.owner, 80, "owner")?,
            confirmed_mtime_ms,
        });
    }
    manifest.submission_items = normalized;
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

fn file_mtime_ms(root: &Path, relative: &str) -> Option<u64> {
    let modified = safe_path(root, relative).ok()?.metadata().ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

/// Replace the project dictionary with single words, unique ignoring ASCII
/// case (the first spelling wins) and sorted.
pub fn set_spelling_words(root: &Path, words: Vec<String>) -> Result<ProjectManifest, String> {
    let mut manifest = read_manifest(root)?;
    let mut normalized: Vec<String> = Vec::new();
    for word in words.iter().map(|word| word.trim()).filter(|word| !word.is_empty()) {
        if word.chars().count() > 80 || word.chars().any(char::is_whitespace) {
            return Err("Project dictionary terms must be single words of at most 80 characters."
                .to_string());
        }
        if !normalized.iter().any(|existing| existing.eq_ignore_ascii_case(word)) {
            normalized.push(word.to_string());
        }
    }
    normalized.sort_by_key(|word| word.to_ascii_lowercase());
    manifest.spelling_words = normalized;
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::manifest::MANIFEST_PATH;
    use crate::project::test_support::Fixture;
    use std::fs;

    #[test]
    fn settings_and_the_project_dictionary_can_be_updated() {
        let fixture = Fixture::project("manifest-settings");
        let root = &fixture.root;
        let updated = update_manifest_settings(
            root,
            ManifestSettings {
                engine: Some("xelatex".into()),
                trusted: Some(true),
                stop_on_first_error: Some(true),
                word_budget: Some(Some(5000)),
                page_budget: Some(Some(9)),
                ..ManifestSettings::default()
            },
        )
        .unwrap();
        assert_eq!(updated.engine, "xelatex");
        assert!(updated.trusted && updated.stop_on_first_error);
        assert_eq!((updated.word_budget, updated.page_budget), (Some(5000), Some(9)));
        let engine = |engine: &str| ManifestSettings {
            engine: Some(engine.into()),
            ..ManifestSettings::default()
        };
        assert!(update_manifest_settings(root, engine("tectonic")).is_err());
        assert!(read_manifest(root).unwrap().stop_on_first_error, "a setting it left alone stays");
        let words = ["TexLab", "VLM", "texlab"].map(String::from).to_vec();
        assert_eq!(set_spelling_words(root, words).unwrap().spelling_words, vec!["TexLab", "VLM"]);
        assert_eq!(read_manifest(root).unwrap().engine, "xelatex");
    }

    #[test]
    fn submission_items_are_validated_and_stamp_the_confirmed_file() {
        let fixture = Fixture::project("manifest-submission-items");
        let root = &fixture.root;
        fixture.write("supplementary.pdf", "%PDF-1.5");
        let item = |id: &str, title: &str, status: &str, file: Option<&str>| SubmissionItem {
            id: id.to_string(),
            title: title.to_string(),
            status: status.to_string(),
            file: file.map(str::to_string),
            source: Some("  ".to_string()),
            source_checked: None,
            owner: Some(" Ada ".to_string()),
            confirmed_mtime_ms: None,
        };
        let set = set_submission_items(
            root,
            vec![
                item("a", " supplementary.pdf checked ", "confirmed", Some("supplementary.pdf")),
                item("b", "All authors approved", "todo", None),
                item("c", "Cover letter", "confirmed", Some("letter.pdf")),
            ],
        )
        .unwrap();
        let [supplement, authors, letter] = &set.submission_items[..] else { panic!() };
        assert_eq!(supplement.title, "supplementary.pdf checked");
        assert_eq!(
            (supplement.source.as_deref(), supplement.owner.as_deref()),
            (None, Some("Ada"))
        );
        assert_eq!(supplement.confirmed_mtime_ms, file_mtime_ms(root, "supplementary.pdf"));
        assert!(supplement.confirmed_mtime_ms.is_some());
        assert_eq!(authors.confirmed_mtime_ms, None, "an unconfirmed item holds no stamp");
        assert_eq!(letter.confirmed_mtime_ms, None, "a missing file has no mtime to keep");
        assert_eq!(read_manifest(root).unwrap().submission_items, set.submission_items);

        // A stamp sent back is kept, so a later edit to the file stays visible.
        let mut kept = set.submission_items.clone();
        kept[0].confirmed_mtime_ms = Some(1);
        assert_eq!(
            set_submission_items(root, kept).unwrap().submission_items[0].confirmed_mtime_ms,
            Some(1)
        );

        for bad in [
            vec![item("a", "One", "todo", None), item("a", "Two", "todo", None)],
            vec![item("a", " ", "todo", None)],
            vec![item("a", "One", "done", None)],
            vec![item("a", "One", "todo", Some("../outside.pdf"))],
            vec![item("a", "One", "todo", Some("/etc/hosts"))],
            vec![SubmissionItem {
                source_checked: Some("2027-02-30".to_string()),
                ..item("a", "One", "todo", None)
            }],
        ] {
            assert!(set_submission_items(root, bad.clone()).is_err(), "{bad:?}");
        }
        assert_eq!(set_submission_items(root, Vec::new()).unwrap().submission_items, Vec::new());
        let raw = fs::read_to_string(root.join(MANIFEST_PATH)).unwrap();
        assert!(!raw.contains("submissionItems"), "an empty list leaves no key behind");
    }

    #[test]
    fn the_deadline_is_validated_kept_in_aoe_and_cleared() {
        let fixture = Fixture::project("manifest-deadline");
        let root = &fixture.root;
        let deadline = |venue: &str, kind: &str, due: &str| ProjectDeadline {
            venue: venue.into(),
            kind: kind.into(),
            due: due.into(),
        };
        let set =
            set_deadline(root, Some(deadline("  NeurIPS 2027 ", "paper", "2027-05-15T23:59")))
                .unwrap();
        assert_eq!(set.deadline, Some(deadline("NeurIPS 2027", "paper", "2027-05-15T23:59")));
        assert_eq!(read_manifest(root).unwrap().deadline, set.deadline);
        for bad in [
            deadline(" ", "paper", "2027-05-15T23:59"),
            deadline("NeurIPS", "camera-ready", "2027-05-15T23:59"),
            deadline("NeurIPS", "paper", "2027-05-15"),
            deadline("NeurIPS", "paper", "2027-02-30T12:00"),
        ] {
            assert!(set_deadline(root, Some(bad.clone())).is_err(), "{bad:?}");
        }
        assert_eq!(read_manifest(root).unwrap().deadline, set.deadline);
        assert_eq!(set_deadline(root, None).unwrap().deadline, None);
        let raw = std::fs::read_to_string(root.join(MANIFEST_PATH)).unwrap();
        assert!(!raw.contains("deadline"), "a cleared deadline leaves no key behind");
    }
}
