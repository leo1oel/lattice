//! The palette's rows and how a query ranks them (`src/app/command-palette.tsx`):
//! a command, a project file, a Paper, a Settings row, or Find in project on
//! a query that found nothing; what an empty query leads with
//! (`super::palette_groups`); and the score a query gives a row's text.

use std::path::{Path, PathBuf};

use gpui::{Action, SharedString};
use lattice_core::papers::PaperSummary;
use lattice_i18n::t;

use super::{
    commands::Section,
    palette_groups::{self, Lead, Surface},
};

pub(super) const FILE_LIMIT: usize = 12;
pub(super) const COMMAND_LIMIT: usize = 40;
pub(super) const PAPER_LIMIT: usize = 6;
pub(super) const SETTING_LIMIT: usize = 6;
/// A deep project must not stall opening the palette.
pub(super) const MAX_FILES: usize = 4_000;

/// One row.
#[derive(Clone)]
pub(super) enum Entry {
    Command {
        id: SharedString,
        label: SharedString,
        section: Section,
        keys: Option<SharedString>,
        action: std::rc::Rc<dyn Action>,
        keywords: &'static str,
        detail: Option<SharedString>,
        recent: bool,
        /// The leading group it is listed in, over its section.
        lead: Option<SharedString>,
    },
    File {
        path: PathBuf,
        name: SharedString,
        folder: SharedString,
        lead: Option<SharedString>,
    },
    Paper {
        paper: Box<PaperSummary>,
        detail: Option<SharedString>,
    },
    Setting(Box<crate::settings::search::Entry>),
    /// Find in project on a query that found nothing.
    Find {
        query: String,
        keys: Option<SharedString>,
    },
}

impl Entry {
    pub(super) fn group(&self) -> SharedString {
        match self {
            Entry::Command { lead, section, .. } => {
                lead.clone().unwrap_or_else(|| section.label().into())
            }
            Entry::File { lead, .. } => lead.clone().unwrap_or_else(|| t!("Files").into()),
            Entry::Paper { .. } => t!("Papers").into(),
            Entry::Setting(_) => t!("Settings").into(),
            Entry::Find { .. } => SharedString::default(),
        }
    }

    /// The text a query searches: the label, the detail, the group, then
    /// the keywords (`scoreItem`); a file, its path (`scorePath`).
    pub(super) fn haystack(&self) -> String {
        match self {
            Entry::File { name, folder, .. } => {
                return Path::new(folder.as_ref())
                    .join(name.as_ref())
                    .to_string_lossy()
                    .into_owned();
            }
            Entry::Find { query, .. } => return query.clone(),
            _ => {}
        }
        let (label, detail) = entry_text(self);
        let shown = format!(
            "{label} {} {}",
            detail.as_deref().unwrap_or_default(),
            self.group()
        );
        match self {
            Entry::Command { keywords, .. } => format!("{shown} {keywords}"),
            Entry::Paper { paper, .. } => format!(
                "{shown} {} {} {}",
                paper.citation_key.as_deref().unwrap_or_default(),
                paper.arxiv_id,
                paper.authors
            ),
            Entry::Setting(entry) => {
                format!("{shown} {} {}", entry.terms, entry.description)
            }
            Entry::File { .. } | Entry::Find { .. } => unreachable!(),
        }
    }

    /// Where a row ranks among rows of the same score: commands by section,
    /// then files, Papers and Settings (`FOUND_ORDER`).
    pub(super) fn order(&self) -> usize {
        match self {
            Entry::Command { section, .. } => *section as usize,
            Entry::File { .. } => 100,
            Entry::Paper { .. } => 101,
            Entry::Setting(_) => 102,
            Entry::Find { .. } => 0,
        }
    }

    pub(super) fn with_lead(self, group: SharedString) -> Entry {
        match self {
            Entry::Command {
                id,
                label,
                section,
                keys,
                action,
                keywords,
                detail,
                recent,
                ..
            } => Entry::Command {
                id,
                label,
                section,
                keys,
                action,
                keywords,
                detail,
                recent,
                lead: Some(group),
            },
            Entry::File {
                path, name, folder, ..
            } => Entry::File {
                path,
                name,
                folder,
                lead: Some(group),
            },
            other => other,
        }
    }
}

/// A row's label and the detail at its end.
pub(super) fn entry_text(entry: &Entry) -> (SharedString, Option<SharedString>) {
    match entry {
        Entry::Command { label, detail, .. } => (label.clone(), detail.clone()),
        Entry::File { name, folder, .. } => {
            (name.clone(), (!folder.is_empty()).then(|| folder.clone()))
        }
        Entry::Paper { paper, detail } => (paper.title.clone().into(), detail.clone()),
        Entry::Setting(entry) => (entry.label.clone().into(), Some(entry.place.clone().into())),
        Entry::Find { query, .. } => (
            t!("Search the project for “{query}”", query = query).into(),
            None,
        ),
    }
}

/// A paper's detail: its authors, short, and its year (`paperShortAuthors`).
pub(super) fn paper_detail(paper: &PaperSummary) -> Option<SharedString> {
    let parts: Vec<String> = [
        crate::papers::model::short_authors(paper),
        paper.year.clone(),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect();
    (!parts.is_empty()).then(|| parts.join(", ").into())
}

/// The rows an empty query leads with: the recent commands and the
/// surface's, each under its group, then the recent files.
pub(super) fn leading_entries(
    commands: &[Entry],
    recent: &[String],
    surface: Option<Surface>,
    recent_files: Vec<String>,
    root: Option<&Path>,
) -> Vec<Entry> {
    let available: Vec<(&str, bool)> = commands
        .iter()
        .filter_map(|entry| match entry {
            Entry::Command { id, recent, .. } => Some((id.as_ref(), *recent)),
            _ => None,
        })
        .collect();
    let surface_group: SharedString = if surface == Some(Surface::Paper) {
        t!("In this paper").into()
    } else {
        t!("In this document").into()
    };
    let mut out: Vec<Entry> = palette_groups::leading(&available, recent, surface)
        .into_iter()
        .filter_map(|(id, lead)| {
            let entry = commands
                .iter()
                .find(|entry| matches!(entry, Entry::Command { id: listed, .. } if listed == id))?
                .clone();
            Some(entry.with_lead(match lead {
                Lead::Recent => t!("Recent").into(),
                Lead::Surface => surface_group.clone(),
            }))
        })
        .collect();
    if let Some(root) = root {
        for path in recent_files
            .into_iter()
            .take(palette_groups::RECENT_FILES_SHOWN)
        {
            let relative = Path::new(&path);
            out.push(Entry::File {
                name: relative
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default()
                    .into(),
                folder: relative
                    .parent()
                    .map(|parent| parent.to_string_lossy().into_owned())
                    .unwrap_or_default()
                    .into(),
                path: root.join(relative),
                lead: Some(t!("Recent files").into()),
            });
        }
    }
    out
}

/// The best `limit` of `entries` for `query`, with their scores, the
/// table's order breaking ties. `prose` rows (Papers, Settings) hold long
/// text, so only [`prose_score`] finds them, never scattered letters.
pub(super) fn scored(
    entries: &[Entry],
    query: &str,
    limit: usize,
    prose: bool,
) -> Vec<(i64, Entry)> {
    let rank = if prose { prose_score } else { score };
    let mut scored: Vec<(i64, usize)> = entries
        .iter()
        .enumerate()
        .filter_map(|(ix, entry)| rank(&entry.haystack().to_lowercase(), query).map(|s| (s, ix)))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(limit)
        .map(|(score, ix)| (score, entries[ix].clone()))
        .collect()
}

pub(super) fn sorted_by_section(mut entries: Vec<Entry>) -> Vec<Entry> {
    entries.sort_by_key(Entry::order);
    entries
}

/// The best `limit` of `entries` for `query`, best first, the table's order
/// breaking ties.
#[cfg(test)]
pub(super) fn ranked(entries: &[Entry], query: &str, limit: usize) -> Vec<Entry> {
    scored(entries, query, limit, false)
        .into_iter()
        .map(|(_, entry)| entry)
        .collect()
}

/// How well `query` matches `text`: every query character in order, more
/// for a run of them, for one at a word's start, and for an earlier start;
/// `None` when they are not all there.
pub(crate) fn score(text: &str, query: &str) -> Option<i64> {
    if let Some(at) = text.find(query) {
        let word_start = at == 0 || !text[..at].ends_with(char::is_alphanumeric);
        return Some(1_000 + if word_start { 500 } else { 0 } - at as i64);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut score = 0i64;
    let mut position = 0;
    let mut previous: Option<usize> = None;
    for wanted in query.chars() {
        let found = (position..chars.len()).find(|ix| chars[*ix] == wanted)?;
        let word_start = found == 0 || !chars[found - 1].is_alphanumeric();
        score += 10;
        if word_start {
            score += 30;
        }
        if previous == Some(found.wrapping_sub(1)) {
            score += 20;
        }
        score -= (found - position) as i64;
        previous = Some(found);
        position = found + 1;
    }
    Some(score)
}

/// How well `query` matches a prose row's `text` (`PROSE_FLOOR`): a run of
/// it anywhere, mid-word too, as [`score`] ranks it; else every spaced part
/// of a query of several somewhere; `None` for scattered letters.
pub(super) fn prose_score(text: &str, query: &str) -> Option<i64> {
    if text.contains(query) {
        return score(text, query);
    }
    let mut terms = query.split_whitespace();
    let several = terms.clone().nth(1).is_some();
    (several && terms.all(|term| text.contains(term))).then_some(500)
}

/// The project's files, as the tree lists them (no build products, no
/// hidden folders), relative to the root.
pub(super) fn project_files(root: &Path) -> Vec<Entry> {
    const SKIPPED: [&str; 4] = ["node_modules", "target", "__pycache__", "_minted"];
    const HIDDEN: [&str; 14] = [
        "aux",
        "bbl",
        "bcf",
        "blg",
        "fdb_latexmk",
        "fls",
        "log",
        "out",
        "toc",
        "synctex",
        "gz",
        "xdv",
        "run.xml",
        "lof",
    ];
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    'walk: while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                let linked = entry.file_type().is_ok_and(|kind| kind.is_symlink());
                if !linked && !SKIPPED.contains(&name.as_str()) {
                    stack.push(path);
                }
                continue;
            }
            if HIDDEN.iter().any(|ext| name.ends_with(&format!(".{ext}"))) {
                continue;
            }
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let folder = relative
                .parent()
                .map(|parent| parent.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(Entry::File {
                name: name.into(),
                folder: folder.into(),
                path,
                lead: None,
            });
            if out.len() >= MAX_FILES {
                break 'walk;
            }
        }
    }
    out.sort_by(|a, b| a.haystack().cmp(&b.haystack()));
    out
}

/// The list row showing entry `ix` of entries in `groups` (each entry's
/// section): a header row stands before each section's first entry.
pub(super) fn row_of<G: PartialEq>(groups: &[G], ix: usize) -> usize {
    let headers = (0..=ix.min(groups.len().saturating_sub(1)))
        .filter(|&i| i == 0 || groups[i] != groups[i - 1])
        .count();
    ix + headers
}

#[cfg(test)]
mod tests {
    use super::{
        Entry, FILE_LIMIT, paper_detail, project_files, prose_score, ranked, row_of, score,
    };
    use crate::papers::model::test_support::{paper, with};

    /// As the Tauri palette's rows (`command-palette.tsx`): a Paper's year
    /// is in its detail and a Settings row's tab in its place, so a query
    /// for either finds the row.
    #[test]
    fn a_prose_row_is_found_by_its_detail_and_group() {
        let attention = with(paper("Attention is all you need"), |paper| {
            paper.year = Some("2017".into());
        });
        let detail = paper_detail(&attention);
        let papers = [Entry::Paper {
            paper: Box::new(attention),
            detail,
        }];
        assert_eq!(super::scored(&papers, "2017", 6, true).len(), 1);
        assert_eq!(super::scored(&papers, "papers", 6, true).len(), 1);
        assert!(super::scored(&papers, "2018", 6, true).is_empty());

        let setting = Entry::Setting(Box::new(crate::settings::search::Entry {
            tab: lattice_settings::SettingsTab::Editor,
            label: "Font size".into(),
            place: "Editor › Source".into(),
            id: None,
            terms: String::new(),
            description: String::new(),
        }));
        let settings = [setting];
        assert_eq!(super::scored(&settings, "editor", 6, true).len(), 1);
        assert_eq!(super::scored(&settings, "settings", 6, true).len(), 1);
    }

    /// As the Tauri palette's `scoreItem` over `PROSE_FLOOR`: a run of the
    /// query mid-word, or every spaced part of it apart, lists a Paper or a
    /// Settings row; scattered letters do not.
    #[test]
    fn prose_rows_match_a_run_or_every_part_never_scattered_letters() {
        assert!(
            prose_score("roberta: a robustly optimized pretraining approach", "bert").is_some()
        );
        assert!(prose_score("font size editor source text", "font source").is_some());
        assert!(prose_score("font size editor source text", "source font").is_some());
        assert_eq!(prose_score("font size editor source text", "fzs"), None);
        assert_eq!(
            prose_score("font size editor source text", "font colour"),
            None
        );
    }

    #[test]
    fn a_highlighted_entry_scrolls_to_its_row_past_the_section_headers() {
        // Edit, Edit, Build, Layout, Layout: headers stand before entries 0,
        // 2 and 3, so the rows read H E E H E H E E.
        let groups = ["Edit", "Edit", "Build", "Layout", "Layout"];
        assert_eq!(row_of(&groups, 0), 1);
        assert_eq!(row_of(&groups, 1), 2);
        assert_eq!(row_of(&groups, 2), 4);
        assert_eq!(row_of(&groups, 4), 7);
    }

    #[test]
    fn files_rank_by_their_path_inside_the_project() {
        let root = std::env::temp_dir()
            .join(format!("lattice-gpui-palette-{}", std::process::id()))
            .join("thesis");
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        for ix in 0..FILE_LIMIT + 4 {
            std::fs::write(root.join("chapters").join(format!("a{ix:02}.tex")), "").unwrap();
        }
        std::fs::write(root.join("thesis.tex"), "").unwrap();
        let shown = ranked(&project_files(&root), "thesis", FILE_LIMIT);
        let names: Vec<String> = shown
            .iter()
            .map(|entry| match entry {
                Entry::File { name, .. } => name.to_string(),
                _ => String::new(),
            })
            .collect();
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
        assert_eq!(names, ["thesis.tex"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_linked_back_into_the_project_lists_its_files_once() {
        let root = std::env::temp_dir()
            .join(format!("lattice-gpui-palette-link-{}", std::process::id()))
            .join("thesis");
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(root.join("main.tex"), "").unwrap();
        std::fs::write(root.join("chapters").join("intro.tex"), "").unwrap();
        std::os::unix::fs::symlink(&root, root.join("chapters").join("loop")).unwrap();
        let count = project_files(&root).len();
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
        assert_eq!(count, 2);
    }

    #[test]
    fn a_run_at_a_word_start_beats_scattered_letters() {
        let run = score("show or hide the pdf", "pdf").unwrap();
        let scattered = score("pick a document folder", "pdf").unwrap();
        assert!(run > scattered);
    }

    #[test]
    fn letters_out_of_order_do_not_match() {
        assert_eq!(score("build project", "dliub"), None);
    }

    #[test]
    fn an_earlier_match_ranks_higher() {
        assert!(score("build project", "build") > score("clean build", "build"));
    }
}
