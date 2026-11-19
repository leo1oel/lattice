//! The pickers over the open document's project (`app-search-dialogs.tsx`):
//! Insert citation (⌘⇧K) and Insert reference (⌘⇧L), which put
//! `\cite{key}` or `\ref{label}` at the caret, and Go to symbol (⌘⇧O),
//! which opens a section or a label where it is. Each is quick open's card
//! (`SearchPickerDialog` is the Tauri app's quick open dialog with a fixed
//! list) on its own items, title and placeholder, and says "No matches"
//! when a query finds nothing.
//!
//! The recent project finder ("Open a recent project…",
//! `recent-projects-finder.tsx` in the Tauri app) is the same card over the
//! recent projects but the one in front, newest first: a row is the
//! project's name, its parent folder (home as ~), the Cloud glyph and an
//! "Overleaf" badge for a linked one, and a "Missing" badge, dimmed, for one
//! whose folder is gone. A pick opens it as Open Recent does.

use lattice_editor::index::{Citation, Reference};
use lattice_i18n::t;
use lattice_ui::components::Badge;

use super::{
    ranking::{RankedRow, rank, score_item},
    symbols::{Symbol, SymbolGroup},
};
use crate::recents::RecentProject;

/// How a missing project's glyph, name and folder are dimmed.
pub const MISSING_OPACITY: f32 = 0.55;

/// Which picker a quick open card is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PickerKind {
    InsertCitation,
    InsertReference,
    GoToSymbol,
    /// "Open a recent project…": the recent projects, not the project's own
    /// items.
    RecentProject,
}

impl PickerKind {
    /// What the field says before anything is typed.
    pub fn placeholder(self) -> String {
        match self {
            PickerKind::InsertCitation => t!("Insert \\cite{…}").to_string(),
            PickerKind::InsertReference => t!("Insert \\ref{…}").to_string(),
            PickerKind::GoToSymbol => t!("Go to section or label…").to_string(),
            PickerKind::RecentProject => t!("Open a recent project…").to_string(),
        }
    }

    /// The command a pick of this picker writes at the caret, if it writes.
    pub fn command(self) -> Option<&'static str> {
        match self {
            PickerKind::InsertCitation => Some("cite"),
            PickerKind::InsertReference => Some("ref"),
            PickerKind::GoToSymbol | PickerKind::RecentProject => None,
        }
    }
}

/// The finder's rows for `query`, as indices of `projects`: every one,
/// newest first, for an empty query; else those whose name or path match,
/// best first and newest first between equals.
pub fn rank_projects(projects: &[RecentProject], query: &str) -> Vec<usize> {
    let query = query.trim();
    rank(
        projects,
        |project| {
            score_item(
                &RankedRow {
                    label: &project.name,
                    detail: &project.path.to_string_lossy(),
                    group: "",
                },
                query,
            )
        },
        |_, _| std::cmp::Ordering::Equal,
        projects.len(),
    )
}

/// A project row's trailing badge: "Missing" for a gone folder, else
/// "Overleaf" for a linked one.
pub fn project_badge(project: &RecentProject) -> Option<Badge> {
    if project.missing {
        Some(Badge::new(t!("Missing")).compact())
    } else if project.overleaf {
        Some(Badge::new(t!("Overleaf")).compact())
    } else {
        None
    }
}

/// Insert citation's rows: one per bibliography key, its detail the work's
/// title, byline (`paperBylineAuthors`, the citation card's) and year.
pub fn citation_items(citations: &[Citation]) -> Vec<Symbol> {
    citations
        .iter()
        .map(|citation| Symbol {
            label: citation.key.clone(),
            detail: [
                citation.title.trim().to_string(),
                lattice_editor::latex::cards::byline_authors(&citation.authors).unwrap_or_default(),
                citation.year.trim().to_string(),
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
            group: SymbolGroup::Citation,
            path: String::new(),
            line: 0,
        })
        .collect()
}

/// Insert reference's rows: one per label, where it is.
pub fn reference_items(references: &[Reference]) -> Vec<Symbol> {
    references
        .iter()
        .map(|reference| Symbol {
            label: reference.label.clone(),
            detail: format!("{}:{}", reference.path, reference.line),
            group: SymbolGroup::Reference,
            path: reference.path.clone(),
            line: reference.line,
        })
        .collect()
}

/// What a cite or ref pick writes at the caret.
pub fn inserted(command: &str, key: &str) -> String {
    format!("\\{command}{{{key}}}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn citation(key: &str, title: &str, authors: &str, year: &str) -> Citation {
        Citation {
            key: key.into(),
            title: title.into(),
            authors: authors.into(),
            year: year.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_citation_row_names_its_key_with_its_title_byline_and_year() {
        let rows = citation_items(&[
            citation(
                "vaswani2017",
                "Attention Is All You Need",
                "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki",
                "2017",
            ),
            citation("knuth1984", "The TeXbook", "Donald E. Knuth", "1984"),
            citation("bare", "", "", ""),
        ]);
        assert_eq!(rows[0].label, "vaswani2017");
        assert_eq!(
            rows[0].detail,
            "Attention Is All You Need, Ashish Vaswani, Noam Shazeer, Niki Parmar, 2017"
        );
        assert_eq!(rows[1].detail, "The TeXbook, Donald E. Knuth, 1984");
        assert_eq!(rows[2].detail, "");
        assert!(rows.iter().all(|row| row.group == SymbolGroup::Citation));
    }

    #[test]
    fn a_reference_row_is_its_label_where_it_is() {
        let rows = reference_items(&[Reference {
            label: "sec:intro".into(),
            path: "chapters/intro.tex".into(),
            line: 3,
            ..Default::default()
        }]);
        assert_eq!(rows[0].label, "sec:intro");
        assert_eq!(rows[0].detail, "chapters/intro.tex:3");
        assert_eq!(
            (rows[0].path.as_str(), rows[0].line),
            ("chapters/intro.tex", 3)
        );
    }

    fn recent(name: &str, path: &str) -> RecentProject {
        RecentProject {
            name: name.into(),
            path: path.into(),
            ..Default::default()
        }
    }

    #[test]
    fn the_finder_lists_every_project_newest_first_then_ranks_a_query() {
        let projects = [
            recent("Thesis", "/Users/writer/Documents/thesis"),
            recent(
                "NeurIPS rebuttal",
                "/Users/writer/Papers/2026/neurips-rebuttal",
            ),
            recent("Sparse attention", "/Users/writer/Papers/sparse-attention"),
            recent("Notes on rebuttals", "/Users/writer/notes"),
        ];
        assert_eq!(rank_projects(&projects, ""), [0, 1, 2, 3]);
        assert_eq!(rank_projects(&projects, "  "), [0, 1, 2, 3]);
        // The name leads; a match further in follows.
        assert_eq!(rank_projects(&projects, "neur"), [1]);
        assert_eq!(rank_projects(&projects, "rebut"), [1, 3]);
        // The path is searched too.
        assert_eq!(rank_projects(&projects, "papers"), [1, 2]);
        assert!(rank_projects(&projects, "zzz").is_empty());
        assert_eq!(rank_projects(&[], ""), Vec::<usize>::new());
    }

    #[test]
    fn a_finder_row_says_where_the_project_is_and_what_it_is() {
        let mut linked = recent("Paper", "/Users/writer/Papers/paper");
        linked.overleaf = true;
        let mut gone = linked.clone();
        gone.missing = true;
        assert!(project_badge(&recent("Plain", "/p/plain")).is_none());
        assert!(project_badge(&linked).is_some());
        assert!(project_badge(&gone).is_some());
        assert_eq!(
            crate::welcome::parent_folder_label(&linked.path),
            "~/Papers"
        );
        assert_eq!(PickerKind::RecentProject.command(), None);
        assert_eq!(
            PickerKind::RecentProject.placeholder(),
            "Open a recent project…"
        );
    }

    #[test]
    fn a_pick_writes_the_command_around_the_key() {
        assert_eq!(inserted("cite", "knuth1984"), "\\cite{knuth1984}");
        assert_eq!(inserted("ref", "sec:intro"), "\\ref{sec:intro}");
        assert_eq!(PickerKind::InsertCitation.command(), Some("cite"));
        assert_eq!(PickerKind::GoToSymbol.command(), None);
    }
}
