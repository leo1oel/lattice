//! What the Revision rounds sheet compares (`annotation-rounds-dialog.tsx`):
//! every settled round as a version of the files it touched, the text each
//! file reads in a version, and the paragraphs two versions differ in, each
//! tagged with the accepted annotations behind it.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use lattice_core::{
    models::FileChange,
    project::{AnnotationRound, EditorComment},
};
use similar::{Algorithm, DiffOp, capture_diff_slices};

/// A version on the rail: the live project, a round as it left the files,
/// or the text before the first round.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Version {
    Now,
    Round(u32),
    Before,
}

impl Version {
    pub fn key(&self) -> String {
        match self {
            Version::Now => "now".into(),
            Version::Round(number) => format!("round:{number}"),
            Version::Before => "before".into(),
        }
    }
}

/// Every version, newest first: Now, each settled round, then the text
/// before revisions.
pub fn versions(settled: &[AnnotationRound]) -> Vec<Version> {
    let mut out = vec![Version::Now];
    let mut numbers: Vec<u32> = settled.iter().map(|round| round.number).collect();
    numbers.sort_unstable();
    out.extend(numbers.into_iter().rev().map(Version::Round));
    out.push(Version::Before);
    out
}

/// What the sheet read: each settled round's files, and the live text of
/// every file a round touched (the open buffer, else the disk).
#[derive(Clone, Debug, Default)]
pub struct Snapshots {
    pub rounds: BTreeMap<u32, Vec<FileChange>>,
    pub now: BTreeMap<String, Option<String>>,
}

impl Snapshots {
    /// Each file's text in `version`: after the last round up to it that
    /// touched the file, else before the first round that did (`textAt`).
    pub fn text_at(&self, version: &Version) -> BTreeMap<String, Option<String>> {
        if *version == Version::Now {
            return self.now.clone();
        }
        let mut texts = BTreeMap::new();
        for files in self.rounds.values() {
            for file in files {
                texts.entry(file.path.clone()).or_insert_with(|| file.before.clone());
            }
        }
        let Version::Round(last) = version else {
            return texts;
        };
        for (number, files) in &self.rounds {
            if number > last {
                break;
            }
            for file in files {
                texts.insert(file.path.clone(), file.after.clone());
            }
        }
        texts
    }

    /// Whether the files now read otherwise than the newest round left them
    /// (Now's dot).
    pub fn now_edited(&self) -> bool {
        let Some(&newest) = self.rounds.keys().next_back() else {
            return false;
        };
        self.text_at(&Version::Round(newest))
            .iter()
            .any(|(path, text)| self.now.get(path) != Some(text))
    }
}

/// One paragraph that differs between two versions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Changed {
    pub path: String,
    pub older: String,
    pub newer: String,
    /// The accepted annotations behind it, by number.
    pub numbers: Vec<u32>,
}

/// The runs of lines that differ between `older` and `newer`, compared
/// without the spaces around them, each run's lines joined: a paper written
/// a sentence or a paragraph to a line compares by sentence or paragraph;
/// blank lines alone are no change (`changedParagraphs`).
pub fn changed_paragraphs(older: &str, newer: &str) -> Vec<(String, String)> {
    let a: Vec<&str> = older.split('\n').map(str::trim).collect();
    let b: Vec<&str> = newer.split('\n').map(str::trim).collect();
    let mut out = Vec::new();
    let join = |lines: &[&str]| {
        lines
            .iter()
            .filter(|line| !line.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join("\n")
    };
    let (mut removed, mut added): (Vec<&str>, Vec<&str>) = (Vec::new(), Vec::new());
    let mut flush = |removed: &mut Vec<&str>, added: &mut Vec<&str>| {
        let (older, newer) = (join(removed), join(added));
        if !older.is_empty() || !newer.is_empty() {
            out.push((older, newer));
        }
        removed.clear();
        added.clear();
    };
    for op in capture_diff_slices(Algorithm::Myers, &a, &b) {
        match op {
            DiffOp::Equal { .. } => flush(&mut removed, &mut added),
            DiffOp::Delete { old_index, old_len, .. } => {
                removed.extend(&a[old_index..old_index + old_len]);
            }
            DiffOp::Insert { new_index, new_len, .. } => {
                added.extend(&b[new_index..new_index + new_len]);
            }
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                removed.extend(&a[old_index..old_index + old_len]);
                added.extend(&b[new_index..new_index + new_len]);
            }
        }
    }
    flush(&mut removed, &mut added);
    out
}

/// The paragraphs `older` and `newer` differ in, file by file, each tagged
/// with the accepted annotations of the rounds between them whose passage
/// the newer paragraph holds.
pub fn changes(
    snapshots: &Snapshots,
    settled: &[AnnotationRound],
    annotations: &[EditorComment],
    older: &Version,
    newer: &Version,
) -> Vec<Changed> {
    let (before, after) = (snapshots.text_at(older), snapshots.text_at(newer));
    let after_older = |number: u32| match older {
        Version::Before => true,
        Version::Round(last) => number > *last,
        Version::Now => false,
    };
    let up_to_newer = |number: u32| match newer {
        Version::Now => true,
        Version::Round(last) => number <= *last,
        Version::Before => false,
    };
    let rounds: BTreeSet<u32> = settled
        .iter()
        .map(|round| round.number)
        .filter(|&number| after_older(number) && up_to_newer(number))
        .collect();
    let accepted: Vec<&EditorComment> = annotations
        .iter()
        .filter(|note| {
            note.revision
                .as_ref()
                .is_some_and(|revision| revision.state == "accepted" && rounds.contains(&revision.round))
        })
        .collect();
    let paths: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    let empty = None;
    let mut out = Vec::new();
    for path in paths {
        let read = |texts: &BTreeMap<String, Option<String>>| {
            texts.get(path).unwrap_or(&empty).clone().unwrap_or_default()
        };
        for (older, newer) in changed_paragraphs(&read(&before), &read(&after)) {
            let mut numbers: Vec<u32> = accepted
                .iter()
                .filter(|note| {
                    let quote = note.quote.trim();
                    note.path == *path && !quote.is_empty() && newer.contains(quote)
                })
                .map(|note| note.number)
                .collect();
            numbers.sort_unstable();
            out.push(Changed {
                path: path.clone(),
                older,
                newer,
                numbers,
            });
        }
    }
    out
}

/// What became of a round's annotations: how many accepted, rejected and
/// still open.
pub fn outcome_counts(round: &AnnotationRound) -> (usize, usize, usize) {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for outcome in round.outcomes.values() {
        *counts.entry(outcome.as_str()).or_default() += 1;
    }
    let accepted = counts.get("accepted").copied().unwrap_or(0);
    let rejected = counts.get("rejected").copied().unwrap_or(0);
    (accepted, rejected, round.outcomes.len() - accepted - rejected)
}

/// The files to write to restore `version`: each that differs from now and
/// that the version has a text for.
pub fn restore_files(snapshots: &Snapshots, version: &Version) -> Vec<(String, String)> {
    snapshots
        .text_at(version)
        .into_iter()
        .filter_map(|(path, text)| {
            let text = text?;
            (snapshots.now.get(&path) != Some(&Some(text.clone()))).then_some((path, text))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(number: u32) -> AnnotationRound {
        AnnotationRound {
            number,
            started_at: String::new(),
            settled_at: Some(String::new()),
            outcomes: Default::default(),
            history_id: None,
        }
    }

    fn file(path: &str, before: &str, after: &str) -> FileChange {
        FileChange {
            path: path.into(),
            before: Some(before.into()),
            after: Some(after.into()),
        }
    }

    fn snapshots() -> Snapshots {
        // Round 1 touched a.tex; round 2 touched a.tex again and b.tex;
        // a.tex has been edited by hand since.
        let mut rounds = BTreeMap::new();
        rounds.insert(1, vec![file("a.tex", "One.\n\nTwo.\n", "One, revised.\n\nTwo.\n")]);
        rounds.insert(
            2,
            vec![
                file("a.tex", "One, revised.\n\nTwo.\n", "One, revised.\n\nTwo, revised.\n"),
                file("b.tex", "Bee.\n", "Bee, revised.\n"),
            ],
        );
        let now = [
            ("a.tex".to_string(), Some("One, revised.\n\nTwo, edited by hand.\n".to_string())),
            ("b.tex".to_string(), Some("Bee, revised.\n".to_string())),
        ]
        .into_iter()
        .collect();
        Snapshots { rounds, now }
    }

    #[test]
    fn each_version_reads_its_files_as_its_rounds_left_them() {
        let snapshots = snapshots();
        let before = snapshots.text_at(&Version::Before);
        assert_eq!(before["a.tex"].as_deref(), Some("One.\n\nTwo.\n"));
        assert_eq!(before["b.tex"].as_deref(), Some("Bee.\n"));
        let first = snapshots.text_at(&Version::Round(1));
        assert_eq!(first["a.tex"].as_deref(), Some("One, revised.\n\nTwo.\n"));
        // Round 1 did not touch b.tex: it reads as before the rounds.
        assert_eq!(first["b.tex"].as_deref(), Some("Bee.\n"));
        assert!(snapshots.now_edited());
        assert_eq!(
            versions(&[round(2), round(1)]),
            [Version::Now, Version::Round(2), Version::Round(1), Version::Before]
        );
    }

    #[test]
    fn paragraphs_compare_by_line_without_their_spaces() {
        assert_eq!(
            changed_paragraphs("A.\n  B.\n\nC.\n", "A.\nB.\n\nC, changed.\nD.\n"),
            [("C.".to_string(), "C, changed.\nD.".to_string())]
        );
        // Blank lines alone are no change.
        assert!(changed_paragraphs("A.\n\nB.\n", "A.\n\n\nB.\n").is_empty());
    }

    #[test]
    fn a_change_names_the_accepted_annotations_behind_it() {
        let snapshots = snapshots();
        let note: EditorComment = serde_json::from_value(serde_json::json!({
            "id": "n1", "number": 3, "path": "a.tex", "from": 0, "to": 3, "quote": "One, revised.",
            "prefix": "", "suffix": "", "body": "", "authorId": "", "authorName": "",
            "createdAt": "", "updatedAt": "",
            "revision": { "round": 1, "state": "accepted" },
        }))
        .unwrap();
        let found = changes(&snapshots, &[round(1), round(2)], &[note.clone()], &Version::Before, &Version::Round(1));
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].older.as_str(), found[0].newer.as_str()), ("One.", "One, revised."));
        assert_eq!(found[0].numbers, [3]);
        // Its round lies outside round 1 → round 2.
        let later = changes(&snapshots, &[round(1), round(2)], &[note], &Version::Round(1), &Version::Round(2));
        assert!(later.iter().all(|change| change.numbers.is_empty()));
        assert_eq!(later.len(), 2);
    }

    #[test]
    fn restoring_writes_only_the_files_that_differ() {
        let snapshots = snapshots();
        assert_eq!(
            restore_files(&snapshots, &Version::Round(2)),
            [("a.tex".to_string(), "One, revised.\n\nTwo, revised.\n".to_string())]
        );
    }
}
