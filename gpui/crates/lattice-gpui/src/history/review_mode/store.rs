//! Review mode for each open project (`src/history/review-mode-store.ts`):
//! whether it is on, and the base each LaTeX file is reviewed against.
//!
//! The bases live in `.research/review/` (lattice-core's
//! `project::review_mode`), never in the writer's files: those hold the
//! writer's edits, as a document in Word does with Track Changes on. Turning
//! review mode on copies every file in; accepting a change rewrites that
//! file's copy; turning it off deletes the folder and leaves the files as
//! they are.
//!
//! An open file's base is held by its editor too (`editor_panel/review_marks.rs`),
//! so an accept is one undo step there; the editor writes it back here, and
//! this writes it to disk, a moment later so an Accept all or a run of
//! accepts is one write. Files that are not open keep theirs only here.
//!
//! One store per app, holding each project by its root, so every window and
//! every editor on a project sees one review mode.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};

use gpui::{App, AppContext as _, Context, Entity, Global, SharedString, Task};
use lattice_core::project::{self, ReviewBases};
use lattice_i18n::t;

use super::diff;

/// How long a base waits before it is written, so an Accept all or a run of
/// accepts is one write.
const SAVE_DELAY: Duration = Duration::from_millis(400);

/// What one project's review mode is.
#[derive(Default)]
struct ProjectReview {
    active: bool,
    /// The PDF panel shows the PDF with the changes marked instead of the
    /// paper's own; on when review mode is.
    marked: bool,
    /// Something the writer should know: a co-author's edit landed in text
    /// they had changed.
    notice: Option<SharedString>,
    /// Counts the bases written to disk, so the PDF with changes marked
    /// follows an accept.
    revision: u64,
    bases: HashMap<String, String>,
    /// Files lattice-core left out when review mode was turned on (too big,
    /// or not text): never tracked.
    excluded: HashSet<String>,
    /// When this review mode was turned on, naming it apart from an earlier
    /// one; none while it is off.
    session: Option<SharedString>,
    /// Bases waiting to be written, by path, each with the number of the
    /// timer that writes it (a later change restarts the wait).
    pending: HashMap<String, u64>,
    timers: u64,
    /// Bumped by every load, start and stop, so a later one wins.
    generation: u64,
}

pub struct ReviewModes {
    projects: HashMap<PathBuf, ProjectReview>,
}

struct ReviewGlobal(Entity<ReviewModes>);

impl Global for ReviewGlobal {}

/// The app's review modes, made on first use.
pub fn store(cx: &mut App) -> Entity<ReviewModes> {
    if let Some(global) = cx.try_global::<ReviewGlobal>() {
        return global.0.clone();
    }
    let store = cx.new(|_| ReviewModes {
        projects: HashMap::new(),
    });
    cx.set_global(ReviewGlobal(store.clone()));
    store
}

pub fn try_store(cx: &App) -> Option<Entity<ReviewModes>> {
    cx.try_global::<ReviewGlobal>().map(|global| global.0.clone())
}

/// The editor's text has `\n` line breaks whatever the file has; so must
/// its base.
fn editor_text(text: &str) -> String {
    crate::editor_panel::normalize_breaks(text)
}

/// A host call that failed, told to the writer: their tracked changes depend
/// on it.
fn report(message: &str, cx: &mut App) {
    crate::notices::show(
        crate::notices::Notice::new(
            lattice_ui::components::ToastLevel::Error,
            crate::host_errors::text(message),
        )
        .source(t!("Track changes")),
        cx,
    );
}

impl ReviewModes {
    fn project(&self, root: &Path) -> Option<&ProjectReview> {
        self.projects.get(root)
    }

    /// Whether review mode is on in `root`.
    pub fn active(&self, root: &Path) -> bool {
        self.project(root).is_some_and(|review| review.active)
    }

    /// Whether the PDF panel shows `root`'s PDF with the changes marked.
    pub fn marked(&self, root: &Path) -> bool {
        self.project(root)
            .is_some_and(|review| review.active && review.marked)
    }

    pub fn notice(&self, root: &Path) -> Option<SharedString> {
        self.project(root).and_then(|review| review.notice.clone())
    }

    /// Counts the bases written, so the marked PDF follows an accept.
    pub fn revision(&self, root: &Path) -> u64 {
        self.project(root).map_or(0, |review| review.revision)
    }

    /// The review mode now on, named by when it was turned on.
    pub fn session(&self, root: &Path) -> Option<SharedString> {
        self.project(root)
            .filter(|review| review.active)
            .and_then(|review| review.session.clone())
    }

    /// `path`'s base, or none when review mode is off or does not track it.
    /// A file made since has an empty base.
    pub fn base_for(&self, root: &Path, path: &str) -> Option<String> {
        let review = self.project(root)?;
        if !review.active || !project::is_reviewable_path(path) || review.excluded.contains(path) {
            return None;
        }
        Some(review.bases.get(path).cloned().unwrap_or_default())
    }

    fn adopt(&mut self, root: &Path, loaded: Option<ReviewBases>, cx: &mut Context<Self>) {
        let review = self.projects.entry(root.to_path_buf()).or_default();
        let same = review.active;
        let pending: Vec<String> = review.pending.keys().cloned().collect();
        for path in pending {
            if let Some(write) = self.flush_one(root, &path, cx) {
                write.detach();
            }
        }
        let review = self.projects.entry(root.to_path_buf()).or_default();
        let on = loaded.is_some();
        let (bases, excluded, session) = match loaded {
            Some(loaded) => (
                loaded
                    .bases
                    .into_iter()
                    .map(|(path, base)| (path, editor_text(&base)))
                    .collect(),
                loaded.excluded.into_iter().collect(),
                Some(SharedString::from(loaded.started_at)),
            ),
            None => Default::default(),
        };
        review.bases = bases;
        review.excluded = excluded;
        review.session = session;
        review.marked = on && (!same || review.marked);
        review.active = on;
        review.notice = None;
        cx.notify();
    }

    /// Read whether `root` is in review mode; a later load or switch wins.
    pub fn load(&mut self, root: &Path, cx: &mut Context<Self>) {
        let review = self.projects.entry(root.to_path_buf()).or_default();
        review.generation += 1;
        let generation = review.generation;
        let read_root = root.to_path_buf();
        let read = cx
            .background_executor()
            .spawn(async move { project::load_review(&read_root).ok().flatten() });
        let root = root.to_path_buf();
        cx.spawn(async move |this, cx| {
            let loaded = read.await;
            this.update(cx, |this, cx| {
                if this.projects.get(&root).map(|review| review.generation) == Some(generation) {
                    this.adopt(&root, loaded, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Read `root`'s review mode the first time it is asked about.
    pub fn ensure(&mut self, root: &Path, cx: &mut Context<Self>) {
        if !self.projects.contains_key(root) {
            self.load(root, cx);
        }
    }

    /// Turn review mode on: every file's text now becomes its base. `open`
    /// is the file in the editor and its text, unsaved edits included, which
    /// is what the writer sees.
    pub fn start(&mut self, root: &Path, open: Option<(String, String)>, cx: &mut Context<Self>) {
        let review = self.projects.entry(root.to_path_buf()).or_default();
        if review.active {
            return;
        }
        review.generation += 1;
        let generation = review.generation;
        let start_root = root.to_path_buf();
        let started = cx
            .background_executor()
            .spawn(async move { project::start_review(&start_root) });
        let root = root.to_path_buf();
        cx.spawn(async move |this, cx| {
            let started = started.await;
            this.update(cx, |this, cx| {
                if this.projects.get(&root).map(|review| review.generation) != Some(generation) {
                    return;
                }
                match started {
                    Err(message) => report(&message, cx),
                    Ok(loaded) => {
                        this.adopt(&root, Some(loaded), cx);
                        if let Some((path, text)) = open
                            && this.base_for(&root, &path).is_some()
                        {
                            this.set_base(&root, &path, editor_text(&text), cx);
                        }
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Turn review mode off: the files stay as they are and the bases are
    /// deleted. When they could not be, review mode is read back as the disk
    /// has it.
    pub fn stop(&mut self, root: &Path, cx: &mut Context<Self>) {
        let Some(review) = self.projects.get_mut(root) else {
            return;
        };
        if !review.active {
            return;
        }
        review.generation += 1;
        let generation = review.generation;
        review.pending.clear();
        review.bases.clear();
        review.excluded.clear();
        review.session = None;
        review.active = false;
        review.marked = false;
        review.notice = None;
        cx.notify();
        let stop_root = root.to_path_buf();
        let stopped = cx
            .background_executor()
            .spawn(async move { project::stop_review(&stop_root) });
        let root = root.to_path_buf();
        cx.spawn(async move |this, cx| {
            if let Err(message) = stopped.await {
                this.update(cx, |this, cx| {
                    report(&message, cx);
                    if this.projects.get(&root).map(|review| review.generation) == Some(generation) {
                        this.load(&root, cx);
                    }
                })
                .ok();
            }
        })
        .detach();
    }

    pub fn set_marked(&mut self, root: &Path, marked: bool, cx: &mut Context<Self>) {
        if let Some(review) = self.projects.get_mut(root) {
            let marked = marked && review.active;
            if review.marked != marked {
                review.marked = marked;
                cx.notify();
            }
        }
    }

    pub fn set_notice(&mut self, root: &Path, notice: Option<SharedString>, cx: &mut Context<Self>) {
        if let Some(review) = self.projects.get_mut(root)
            && review.notice != notice
        {
            review.notice = notice;
            cx.notify();
        }
    }

    /// The editor's base for `path` changed: an accept, an undo of one, or a
    /// co-author's edit. It is written a moment later.
    pub fn set_base(&mut self, root: &Path, path: &str, base: String, cx: &mut Context<Self>) {
        if self.base_for(root, path).is_none() {
            return;
        }
        let Some(review) = self.projects.get_mut(root) else {
            return;
        };
        if review.bases.get(path) == Some(&base) {
            return;
        }
        review.bases.insert(path.to_string(), base);
        review.timers += 1;
        let timer = review.timers;
        review.pending.insert(path.to_string(), timer);
        let (save_root, save_path) = (root.to_path_buf(), path.to_string());
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SAVE_DELAY).await;
            let write = this
                .update(cx, |this, cx| {
                    let waiting = this
                        .projects
                        .get(&save_root)
                        .and_then(|review| review.pending.get(&save_path))
                        == Some(&timer);
                    waiting.then(|| this.flush_one(&save_root, &save_path, cx)).flatten()
                })
                .ok()
                .flatten();
            if let Some(write) = write {
                write.await;
            }
        })
        .detach();
    }

    /// Write `path`'s waiting base now.
    fn flush_one(&mut self, root: &Path, path: &str, cx: &mut Context<Self>) -> Option<Task<()>> {
        let review = self.projects.get_mut(root)?;
        review.pending.remove(path)?;
        let base = review.bases.get(path).cloned()?;
        if !review.active {
            return None;
        }
        let generation = review.generation;
        let (save_root, save_path) = (root.to_path_buf(), path.to_string());
        let write = cx.background_executor().spawn(async move {
            project::save_review_base(&save_root, &save_path, &base)
        });
        let root = root.to_path_buf();
        Some(cx.spawn(async move |this, cx| {
            let written = write.await;
            this.update(cx, |this, cx| match written {
                Err(message) => report(&message, cx),
                Ok(()) => {
                    if let Some(review) = this.projects.get_mut(&root)
                        && review.active
                        && review.generation == generation
                    {
                        review.revision += 1;
                        cx.notify();
                    }
                }
            })
            .ok();
        }))
    }

    /// Write every waiting base now, before something reads them from disk
    /// (the PDF with changes marked). Settles once they are written.
    pub fn flush(&mut self, root: &Path, cx: &mut Context<Self>) -> Task<()> {
        let paths: Vec<String> = self
            .projects
            .get(root)
            .map(|review| review.pending.keys().cloned().collect())
            .unwrap_or_default();
        let writes: Vec<Task<()>> = paths
            .iter()
            .filter_map(|path| self.flush_one(root, path, cx))
            .collect();
        cx.background_executor().spawn(async move {
            for write in writes {
                write.await;
            }
        })
    }

    /// A sync wrote a co-author's edits into `path`, which went from `before`
    /// to `after` on disk, while no editor has it open: its base moves with
    /// them (`advance`). An open file's editor carries its own base forward.
    pub fn advance(&mut self, root: &Path, path: &str, before: &str, after: &str, cx: &mut Context<Self>) {
        let Some(base) = self.base_for(root, path) else {
            return;
        };
        if before == after {
            return;
        }
        let (base, _) = diff::base_after(&base, &editor_text(before), &editor_text(after));
        self.set_base(root, path, base, cx);
    }
}

/// Whether an Overleaf sync of `root` should read its files first, for
/// [`after_sync`]: review mode is on there.
pub fn reviewing(root: &Path, cx: &App) -> bool {
    try_store(cx).is_some_and(|store| store.read(cx).active(root))
}

/// Before an Overleaf sync, off the main thread: every reviewable file's
/// text on disk, for [`after_sync`] to tell what the sync brought.
pub fn before_sync(root: &Path, reviewing: bool) -> Option<std::collections::BTreeMap<String, String>> {
    reviewing.then(|| project::reviewable_texts(root).ok()).flatten()
}

/// After it: move the base of every file the sync pulled or merged forward
/// with what came from Overleaf (`afterSync`). A file that was not there
/// before is the co-author's whole: it comes in as its base. An open
/// editor of one takes the moved base and then the file's new text.
pub fn after_sync(
    root: &Path,
    before: Option<std::collections::BTreeMap<String, String>>,
    paths: &[String],
    cx: &mut App,
) {
    let (Some(before), Some(store)) = (before, try_store(cx)) else {
        return;
    };
    store.update(cx, |store, cx| {
        for path in paths {
            if store.base_for(root, path).is_none() {
                continue;
            }
            let was = before.get(path).map(String::as_str).unwrap_or("");
            if let Ok(now) = project::read_file(root, path) {
                store.advance(root, path, was, &now, cx);
            }
        }
    });
}

/// Ask before turning review mode off with changes waiting: they stop
/// being marked (`confirmStop`).
pub fn confirm_stop(root: PathBuf, cx: &mut App) {
    crate::confirm::ask(
        crate::confirm::Confirm::new(t!("Stop tracking changes?"))
            .body(t!(
                "Your edits stay in the files. The changes waiting for review are no longer marked."
            ))
            .confirm_label(t!("Stop tracking"))
            .on_confirm(move |_, cx| {
                let store = store(cx);
                store.update(cx, |store, cx| store.stop(&root, cx));
            }),
        cx,
    );
}
