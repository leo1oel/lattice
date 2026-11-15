//! The citation reasons the Annotations panel lists, and the titlebar
//! counts among the open notes (`useCitationReasonSources` and
//! `panelCitationReasons` in the Tauri app): a reason whose cite is gone
//! from its file, or that was resolved there. Whether a cite is gone is
//! read from the file as an open editor holds it, else from the saved file,
//! read once per annotation revision (a file that cannot be read is gone).

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use gpui::{App, AppContext as _, Context, Entity, Global, Task};
use lattice_core::project::EditorComment;

use super::{reasons, store};

#[derive(Default)]
struct Sources {
    /// What the open editors hold of their files, by path.
    live: HashMap<String, String>,
    /// The saved files, as last read: `None` for one that cannot be read.
    saved: HashMap<String, Option<String>>,
    /// The annotation revision `saved` was read at.
    revision: u64,
    reading: HashSet<String>,
    tasks: Vec<Task<()>>,
}

impl Sources {
    /// An editor holds `path` as `text` now, or no longer (`None`): the
    /// saved file, which it may have written meanwhile, is read again once
    /// it closes. Whether what is known of `path` changed.
    fn hold(&mut self, path: &str, text: Option<String>) -> bool {
        let forgot = self.saved.remove(path).is_some() | self.reading.remove(path);
        let changed = match text {
            Some(text) => self.live.insert(path.to_string(), text.clone()).as_ref() != Some(&text),
            None => self.live.remove(path).is_some(),
        };
        forgot || changed
    }
}

#[derive(Default)]
pub struct ReasonSources {
    roots: HashMap<PathBuf, Sources>,
}

struct ReasonSourcesGlobal(Entity<ReasonSources>);
impl Global for ReasonSourcesGlobal {}

fn sources(cx: &mut App) -> Entity<ReasonSources> {
    if let Some(global) = cx.try_global::<ReasonSourcesGlobal>() {
        return global.0.clone();
    }
    let entity = cx.new(|_| ReasonSources::default());
    cx.set_global(ReasonSourcesGlobal(entity.clone()));
    entity
}

/// Tell the panel what an open editor holds of `path` (`None` once it
/// closes, and the saved file speaks for it again).
pub fn set_live(root: &Path, path: &str, text: Option<String>, cx: &mut App) {
    let entity = sources(cx);
    entity.update(cx, |sources, cx| {
        let entry = sources.roots.entry(root.to_path_buf()).or_default();
        if entry.hold(path, text) {
            cx.notify();
        }
    });
}

impl ReasonSources {
    /// `path`'s text as far as it is known now: `None` while unread.
    fn known(&self, root: &Path, path: &str, revision: u64) -> Option<Option<String>> {
        let entry = self.roots.get(root)?;
        if let Some(text) = entry.live.get(path) {
            return Some(Some(text.clone()));
        }
        (entry.revision == revision)
            .then(|| entry.saved.get(path).cloned())
            .flatten()
    }

    /// Read `path`'s saved file, unless an editor holds it or it was read
    /// at `revision` already.
    fn read(&mut self, root: &Path, path: &str, revision: u64, cx: &mut Context<Self>) {
        let entry = self.roots.entry(root.to_path_buf()).or_default();
        if entry.revision != revision {
            entry.revision = revision;
            entry.saved.clear();
            entry.reading.clear();
            entry.tasks.clear();
        }
        if entry.live.contains_key(path)
            || entry.saved.contains_key(path)
            || !entry.reading.insert(path.to_string())
        {
            return;
        }
        let (file, path, root) = (root.join(path), path.to_string(), root.to_path_buf());
        entry.tasks.push(cx.spawn(async move |this, cx| {
            let text = cx
                .background_spawn(async move { std::fs::read_to_string(file).ok() })
                .await;
            this.update(cx, |this, cx| {
                if let Some(entry) = this.roots.get_mut(&root)
                    && entry.revision == revision
                    && entry.reading.remove(&path)
                {
                    entry.saved.insert(path, text);
                    cx.notify();
                }
            })
            .ok();
        }));
    }
}

fn all_of(root: &Path, cx: &App) -> Vec<EditorComment> {
    store::try_store(cx)
        .and_then(|store| {
            store
                .read(cx)
                .notes(root)
                .map(|notes| notes.annotations.clone())
        })
        .unwrap_or_default()
}

/// Read the saved files of `root`'s open reasons that no editor holds, so
/// [`panel_reasons`] can tell whether their cites are still there.
pub fn read_sources(root: &Path, cx: &mut App) {
    let all = all_of(root, cx);
    let paths: HashSet<String> = all
        .iter()
        .filter(|item| item.citation.is_some() && !item.resolved)
        .map(|item| item.path.clone())
        .collect();
    if paths.is_empty() {
        return;
    }
    let revision = crate::status_counters::annotations_revision(root, cx);
    let entity = sources(cx);
    entity.update(cx, |sources, cx| {
        for path in &paths {
            sources.read(root, path, revision, cx);
        }
    });
}

/// `root`'s reasons the Annotations panel lists: orphaned or resolved,
/// as far as their files have been read.
pub fn panel_reasons(root: &Path, cx: &App) -> Vec<EditorComment> {
    let all = all_of(root, cx);
    if !all.iter().any(|item| item.citation.is_some()) {
        return Vec::new();
    }
    let revision = crate::status_counters::annotations_revision(root, cx);
    let Some(sources) = cx
        .try_global::<ReasonSourcesGlobal>()
        .map(|global| global.0.read(cx))
    else {
        return reasons::panel_reasons(&all, |_| None)
            .into_iter()
            .cloned()
            .collect();
    };
    reasons::panel_reasons(&all, |path| sources.known(root, path, revision))
        .into_iter()
        .cloned()
        .collect()
}

/// How many of `root`'s orphaned reasons are still open: the titlebar's
/// count takes them with the notes.
pub fn open_orphans(root: &Path, cx: &mut App) -> usize {
    read_sources(root, cx);
    panel_reasons(root, cx)
        .iter()
        .filter(|reason| !reason.resolved)
        .count()
}

/// Draw `view` again whenever what the panel knows of the files changes.
pub fn observe<V: 'static>(cx: &mut Context<V>) -> gpui::Subscription {
    let entity = sources(cx);
    cx.observe(&entity, |_, _, cx| cx.notify())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `useCitationReasonSources`: a closed editor's file is read as it was
    /// saved, so a cite deleted and saved there is gone from it; the copy
    /// read before the editor held it does not speak for it.
    #[test]
    fn a_closed_editors_file_is_read_again_as_saved() {
        let root = Path::new("/project");
        let mut sources = ReasonSources::default();
        let entry = sources.roots.entry(root.to_path_buf()).or_default();
        entry.revision = 7;
        entry
            .saved
            .insert("main.tex".into(), Some("\\cite{knuth1984}".into()));
        assert!(entry.hold("main.tex", Some("Deleted.".into())));
        assert_eq!(
            sources.known(root, "main.tex", 7),
            Some(Some("Deleted.".into()))
        );
        let entry = sources.roots.get_mut(root).unwrap();
        assert!(entry.hold("main.tex", None));
        assert_eq!(sources.known(root, "main.tex", 7), None);
    }
}
