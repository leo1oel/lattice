//! The status bar's two counters, as the Tauri app's
//! (`useCounters` in `src/canvas/editor-status-bar.tsx`): the open
//! annotations on the file shown, and the manuscript's TODO markers.
//!
//! Both are lattice-core's: the annotations file (`read_annotations`) and the
//! project's TODO scan (`list_todos`), read in the background when the
//! project opens and after each save or outside edit, as the manuscript's
//! word count is. The file in the editor counts its buffer's markers in
//! place of what the scan read of it on disk, as `mergeTodosWithBuffer`
//! rescans the open file, so a marker counts as it is typed (the editor
//! rescans its buffer once typing settles, `EditorPanel::scan_todos`).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use gpui::{App, AppContext as _, Context, Entity, Global, Task};
use lattice_core::project::{self, TodoHit};

/// What each open project holds for the counters, by its root. One per app:
/// every editor's status bar reads the entry of the project it belongs to,
/// so windows on different projects keep their own counts.
#[derive(Default)]
pub struct ProjectCounters {
    projects: HashMap<PathBuf, ProjectEntry>,
}

#[derive(Default)]
struct ProjectEntry {
    todos: Vec<TodoHit>,
    /// Each annotation's file and whether it is resolved.
    annotations: Vec<(String, bool)>,
    generation: u64,
    _task: Option<Task<()>>,
}

struct ProjectCountersGlobal(Entity<ProjectCounters>);

impl Global for ProjectCountersGlobal {}

pub fn project_counters(cx: &mut App) -> Entity<ProjectCounters> {
    if let Some(global) = cx.try_global::<ProjectCountersGlobal>() {
        return global.0.clone();
    }
    let entity = cx.new(|_| ProjectCounters::default());
    cx.set_global(ProjectCountersGlobal(entity.clone()));
    entity
}

/// Read `root`'s counts again. Called with the manuscript's word count
/// (`ManuscriptWords::refresh`): when the project opens, after each save
/// and after an outside edit.
pub fn refresh(root: PathBuf, cx: &mut App) {
    project_counters(cx).update(cx, |counters, cx| counters.refresh(root, cx));
}

impl ProjectCounters {
    /// Read `root`'s annotations and TODOs again in the background; the
    /// other projects' counts stay as they are.
    pub fn refresh(&mut self, root: PathBuf, cx: &mut Context<Self>) {
        let entry = self.projects.entry(root.clone()).or_default();
        entry.generation += 1;
        let generation = entry.generation;
        entry._task = Some(cx.spawn(async move |this, cx| {
            let read = root.clone();
            let (todos, annotations) = cx
                .background_spawn(async move {
                    let todos = project::list_todos(&read).unwrap_or_default();
                    let annotations = project::read_annotations(&read)
                        .map(|read| {
                            read.annotations
                                .into_iter()
                                .map(|annotation| (annotation.path, annotation.resolved))
                                .collect()
                        })
                        .unwrap_or_default();
                    (todos, annotations)
                })
                .await;
            this.update(cx, |this, cx| {
                if let Some(entry) = this.projects.get_mut(&root)
                    && entry.generation == generation
                {
                    entry.todos = todos;
                    entry.annotations = annotations;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    fn counts(&self, root: &Path, relative: &str, buffer_todos: Option<usize>) -> Counts {
        let Some(entry) = self.projects.get(root) else {
            return Counts::default();
        };
        Counts {
            annotations: entry
                .annotations
                .iter()
                .filter(|(path, resolved)| path == relative && !resolved)
                .count(),
            todos: merged_todos(&entry.todos, relative, buffer_todos),
        }
    }
}

/// The counts the status bar shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    /// Unresolved annotations on the file shown.
    pub annotations: usize,
    /// TODO markers across the manuscript.
    pub todos: usize,
}

/// The counts for the editor on `relative` (its path in the project at
/// `root`), whose buffer held `buffer_todos` markers when last scanned.
pub fn counts(root: &Path, relative: &str, buffer_todos: Option<usize>, cx: &App) -> Counts {
    cx.try_global::<ProjectCountersGlobal>()
        .map(|global| global.0.read(cx).counts(root, relative, buffer_todos))
        .unwrap_or_default()
}

/// The scan's markers with the open file's replaced by its buffer's, once
/// the buffer has been scanned.
fn merged_todos(scanned: &[TodoHit], relative: &str, buffer_todos: Option<usize>) -> usize {
    match buffer_todos {
        Some(here) => scanned.iter().filter(|hit| hit.path != relative).count() + here,
        None => scanned.len(),
    }
}

/// The markers in an open file's buffer, as the scan would read the file:
/// only a `.tex` or Markdown file is rescanned from its buffer, as the Tauri
/// app's `mergeTodosWithBuffer` rescans only those.
pub fn buffer_todos(relative: &str, text: &str) -> Option<usize> {
    let lower = relative.to_ascii_lowercase();
    (lower.ends_with(".tex") || lower.ends_with(".md"))
        .then(|| project::todos_in_text(relative, text).len())
}

/// A count as the bar writes it (`formatCount`): grouped thousands.
pub fn format_count(count: usize) -> String {
    let digits = count.to_string();
    let mut out = String::new();
    for (ix, digit) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(path: &str, line: u32) -> TodoHit {
        TodoHit {
            path: path.into(),
            line,
            kind: "TODO".into(),
            preview: String::new(),
        }
    }

    #[test]
    fn the_open_file_counts_its_buffer_in_place_of_its_scan() {
        let scanned = [hit("main.tex", 3), hit("main.tex", 9), hit("intro.tex", 1)];
        // The buffer lost one of main.tex's markers and gained none.
        let here = buffer_todos("main.tex", "% TODO one\nplain\n");
        assert_eq!(here, Some(1));
        assert_eq!(merged_todos(&scanned, "main.tex", here), 2);
        // A file that is neither TeX nor Markdown keeps the scan.
        assert_eq!(buffer_todos("refs.bib", "% TODO"), None);
        assert_eq!(merged_todos(&scanned, "refs.bib", None), 3);
    }

    #[test]
    fn each_project_keeps_its_own_counts() {
        let entry = |todos: Vec<TodoHit>, annotations: Vec<(String, bool)>| ProjectEntry {
            todos,
            annotations,
            ..ProjectEntry::default()
        };
        let counters = ProjectCounters {
            projects: HashMap::from([
                (
                    PathBuf::from("/a"),
                    entry(
                        vec![hit("main.tex", 1), hit("main.tex", 2), hit("intro.tex", 4)],
                        vec![("main.tex".into(), false), ("main.tex".into(), true)],
                    ),
                ),
                (
                    PathBuf::from("/b"),
                    entry(vec![hit("paper.tex", 7)], vec![]),
                ),
            ]),
        };
        let a = counters.counts(Path::new("/a"), "main.tex", None);
        let b = counters.counts(Path::new("/b"), "paper.tex", None);
        assert_eq!(
            a,
            Counts {
                annotations: 1,
                todos: 3
            }
        );
        assert_eq!(
            b,
            Counts {
                annotations: 0,
                todos: 1
            }
        );
        assert_eq!(
            counters.counts(Path::new("/c"), "main.tex", None),
            Counts::default()
        );
    }

    #[test]
    fn counts_group_thousands() {
        assert_eq!(format_count(7), "7");
        assert_eq!(format_count(1204), "1,204");
        assert_eq!(format_count(120_400), "120,400");
    }
}
