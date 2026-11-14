//! What Git says of the tree's rows (`TreeRow::git`): each changed file's
//! mark, and a dot on every folder above one.

use std::collections::{HashMap, HashSet};

use lattice_ui::components::GitMark;

/// What Git says of each row: a changed file's mark, and the folders with a
/// change somewhere under them.
#[derive(Default)]
pub(super) struct GitMarks {
    pub(super) files: HashMap<String, GitMark>,
    pub(super) folders: HashSet<String>,
}

impl GitMarks {
    pub(super) fn new(statuses: &HashMap<String, String>) -> Self {
        let mut marks = GitMarks::default();
        // Each changed file marks its row, and every folder above it.
        for (path, status) in statuses {
            let mark = GitMark::from_status(status);
            marks.files.insert(path.clone(), mark);
            if mark == GitMark::Ignored {
                continue;
            }
            let mut folder = path.as_str();
            while let Some((parent, _)) = folder.rsplit_once('/') {
                marks.folders.insert(parent.to_string());
                folder = parent;
            }
        }
        marks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_marks_its_file_and_every_folder_above_it() {
        let statuses = HashMap::from([
            (
                "chapters/parts/intro.tex".to_string(),
                "modified".to_string(),
            ),
            ("notes.md".to_string(), "untracked".to_string()),
            ("build/out.log".to_string(), "ignored".to_string()),
        ]);
        let marks = GitMarks::new(&statuses);
        assert_eq!(
            marks.files.get("chapters/parts/intro.tex"),
            Some(&GitMark::Modified)
        );
        assert_eq!(marks.files.get("notes.md"), Some(&GitMark::Untracked));
        assert_eq!(marks.files.get("build/out.log"), Some(&GitMark::Ignored));
        assert!(marks.folders.contains("chapters"));
        assert!(marks.folders.contains("chapters/parts"));
        // An ignored file is no change to its folder.
        assert!(!marks.folders.contains("build"));
    }
}
