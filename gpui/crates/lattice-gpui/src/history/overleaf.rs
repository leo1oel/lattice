//! Overleaf's own project history in the History panel (the Tauri app's
//! `use-overleaf-history.ts` and `overleaf-history.tsx`): the paginated feed
//! of what Overleaf recorded, and what can be done with it — restore a file,
//! bring back a deleted one, restore the whole project, name or unname a
//! version — through the same REST layer Overleaf's own editor uses
//! (`lattice_core::overleaf::history_*`).
//!
//! This is not the project's git history: it covers every edit a
//! collaborator made in the browser while Lattice was closed, and none of
//! that is in local git. A restore rewrites Overleaf's copy, not the files
//! here, so the window syncs after one (`HistoryEvent::OverleafRestored`).
//! Every mutation reads the first page again rather than patching what is
//! shown, since a restore mints a new update at the top of the feed and the
//! server is the only authority on its shape.
//!
//! It is read when the panel first shows a linked project, and again on the
//! refresh and after each action; not on the panel's poll, which is git's.

use std::path::Path;

use gpui::{AppContext as _, Context, Entity, Subscription, Task, Window};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::overleaf::OverleafUpdate;
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;
use serde_json::Value;

use super::{
    diff_view::{FileChange, LoadedDiff},
    panel::{HistoryEvent, HistoryPanel, Latest},
};
use crate::{
    notices::{self, Notice},
    overleaf::OverleafBridge,
};

/// Updates per page, as the Tauri app reads them.
const PAGE: u32 = 20;

/// What Overleaf's history holds for the linked project, as far as read.
#[derive(Default)]
pub struct OverleafHistory {
    /// Newest first.
    pub updates: Vec<OverleafUpdate>,
    /// The cursor for the next page; none when there is none.
    pub next_before: Option<i64>,
    pub loading: bool,
    pub loading_more: bool,
    pub error: Option<String>,
    /// A restore or a label is under way.
    pub busy: bool,
    /// The first page has been asked for since the project was linked.
    asked: bool,
    seq: u64,
    /// Counts the resets, so an action started before one is not settled
    /// on the project after it.
    epoch: u64,
    pub opened: Option<OpenedOverleaf>,
}

impl OverleafHistory {
    /// Nothing read, with the read counter carried on so a read started
    /// before cannot pass for one started after.
    fn cleared(&self) -> Self {
        Self {
            seq: self.seq,
            epoch: self.epoch + 1,
            ..Self::default()
        }
    }
}

/// One file of an update's range (`overleaf_history_files`): only those
/// with an operation changed.
#[derive(Clone, Debug, PartialEq)]
pub struct OverleafFile {
    pub pathname: String,
    /// "added", "edited", "removed" or "renamed".
    pub operation: String,
    pub new_pathname: Option<String>,
    /// For a removed file, the version to pass back to bring it back.
    pub deleted_at_v: Option<i64>,
}

/// An opened file's two sides; none when Overleaf says it is binary.
pub struct OverleafDiff {
    pub loaded: Option<LoadedDiff>,
}

/// The update opened in the timeline.
pub struct OpenedOverleaf {
    pub to_version: i64,
    /// Compared with Overleaf's newest version rather than its own changes.
    pub compare: bool,
    pub files: Latest<Vec<OverleafFile>>,
    pub diff: Latest<OverleafDiff>,
    /// The field a name for this version is typed in, while open.
    pub label: Option<(Entity<InputState>, Subscription)>,
}

/// The versions an opened update reads between: its own changes run from
/// the version before it; compared with now, from it to Overleaf's newest.
pub fn range(update: &OverleafUpdate, newest: Option<i64>, compare: bool) -> (i64, i64) {
    if compare {
        (update.to_version, newest.unwrap_or(update.to_version))
    } else {
        (update.from_version, update.to_version)
    }
}

/// The key an opened update's files are read under; none when its range
/// holds no change to read.
pub fn files_key(update: &OverleafUpdate, newest: Option<i64>, compare: bool) -> Option<String> {
    let (from, to) = range(update, newest, compare);
    (from < to).then(|| format!("{from}:{to}"))
}

pub fn overleaf_key(to_version: i64) -> String {
    format!("overleaf:{to_version}")
}

/// The files `overleaf_history_files` says changed: `{diff: [...]}`, each
/// with `pathname` and, when it changed, `operation`.
pub fn changed_files(body: &Value) -> Vec<OverleafFile> {
    let text = |item: &Value, key: &str| item.get(key).and_then(Value::as_str).map(str::to_string);
    body.get("diff")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(OverleafFile {
                pathname: text(item, "pathname")?,
                operation: text(item, "operation")?,
                new_pathname: text(item, "newPathname"),
                deleted_at_v: item.get("deletedAtV").and_then(Value::as_i64),
            })
        })
        .collect()
}

/// Overleaf's chunk stream (`{diff: [{u|i|d}...]}`) back into the two texts
/// it was split from: `u` belongs to both, `d` to the before text and `i` to
/// the after text. None when Overleaf says the file is binary.
pub fn texts_from_chunks(body: &Value) -> Option<(String, String)> {
    let chunks = body.get("diff")?.as_array()?;
    let (mut before, mut after) = (String::new(), String::new());
    for chunk in chunks {
        let part = |key: &str| chunk.get(key).and_then(Value::as_str).unwrap_or("");
        before.push_str(part("u"));
        before.push_str(part("d"));
        after.push_str(part("u"));
        after.push_str(part("i"));
    }
    Some((before, after))
}

fn config_dir() -> std::path::PathBuf {
    crate::overleaf::config_dir()
}

impl HistoryPanel {
    /// The window's link to Overleaf, whose project's history this shows
    /// while it is linked.
    pub fn set_overleaf(&mut self, bridge: Entity<OverleafBridge>, cx: &mut Context<Self>) {
        self._overleaf_link = Some(cx.observe(&bridge, |this, bridge, cx| {
            let linked = bridge.read(cx).link().is_some();
            if linked != this.overleaf_linked {
                this.overleaf_linked = linked;
                this.overleaf_reset();
                if !linked && this.view == super::timeline::HistoryView::Overleaf {
                    this.view = super::timeline::HistoryView::Everything;
                }
                if linked {
                    this.load_overleaf(cx);
                }
                cx.notify();
            }
        }));
        self.overleaf_linked = bridge.read(cx).link().is_some();
    }

    /// The project changed: nothing of the last one's Overleaf history stays.
    pub(super) fn overleaf_reset(&mut self) {
        self.overleaf = self.overleaf.cleared();
    }

    /// Read the first page, unless the panel is off screen (then when it is
    /// shown) or the project is not linked.
    pub(super) fn load_overleaf(&mut self, cx: &mut Context<Self>) {
        if !self.overleaf_linked {
            return;
        }
        if !self.shown_now(cx) {
            self.overleaf.asked = false;
            return;
        }
        self.overleaf.asked = true;
        self.read_overleaf_page(None, cx).detach();
    }

    /// Shown and linked, the first page has not been asked for: ask now.
    pub(super) fn overleaf_catch_up(&mut self, cx: &mut Context<Self>) {
        if self.overleaf_linked && !self.overleaf.asked && self.shown_now(cx) {
            self.overleaf.asked = true;
            let this = cx.entity();
            cx.defer(move |cx| {
                this.update(cx, |this, cx| this.read_overleaf_page(None, cx).detach())
            });
        }
    }

    /// Read the page after what is shown.
    pub(super) fn load_more_overleaf(&mut self, cx: &mut Context<Self>) {
        let history = &self.overleaf;
        // The cursor belongs to the list on screen, which a first-page read
        // in flight is about to replace.
        if history.next_before.is_none() || history.loading || history.loading_more {
            return;
        }
        self.read_overleaf_page(history.next_before, cx).detach();
    }

    fn read_overleaf_page(&mut self, before: Option<i64>, cx: &mut Context<Self>) -> Task<()> {
        let Some(root) = self.root.clone() else {
            return Task::ready(());
        };
        let first = before.is_none();
        self.overleaf.seq += 1;
        let seq = self.overleaf.seq;
        self.overleaf.loading = first;
        self.overleaf.loading_more = !first;
        self.overleaf.error = None;
        cx.notify();
        let read = cx.background_executor().spawn(async move {
            lattice_core::overleaf::history_updates(&config_dir(), &root, before, PAGE)
        });
        cx.spawn(async move |this, cx| {
            let read = read.await;
            let (read, expired) = crate::overleaf::settled(read);
            if expired {
                cx.update(crate::overleaf::session_changed);
            }
            this.update(cx, |this, cx| {
                let history = &mut this.overleaf;
                if seq != history.seq {
                    return;
                }
                history.loading = false;
                history.loading_more = false;
                match read {
                    Ok((updates, next)) => {
                        if first {
                            history.updates = updates;
                        } else {
                            history.updates.extend(updates);
                        }
                        history.next_before = next;
                    }
                    Err(error) => history.error = Some(error),
                }
                if first && let Some((to_version, compare)) = this.opened_range_moved() {
                    this.open_overleaf(to_version, compare, cx);
                }
                cx.notify();
            })
            .ok();
        })
    }

    /// The opened update, when the range its files were read over is no
    /// longer the one the list now gives it.
    fn opened_range_moved(&self) -> Option<(i64, bool)> {
        let opened = self.overleaf.opened.as_ref()?;
        let update = self.opened_update(opened.to_version)?;
        let key = files_key(update, self.overleaf_newest(), opened.compare);
        (key != opened.files.key).then_some((opened.to_version, opened.compare))
    }

    fn opened_update(&self, to_version: i64) -> Option<&OverleafUpdate> {
        self.overleaf
            .updates
            .iter()
            .find(|update| update.to_version == to_version)
    }

    fn overleaf_newest(&self) -> Option<i64> {
        self.overleaf
            .updates
            .first()
            .map(|update| update.to_version)
    }

    /// Open the update `to_version` (compared with now when `compare`) and
    /// read which files its range changed.
    pub(super) fn open_overleaf(&mut self, to_version: i64, compare: bool, cx: &mut Context<Self>) {
        self.overleaf.opened = Some(OpenedOverleaf {
            to_version,
            compare,
            files: Latest::default(),
            diff: Latest::default(),
            label: None,
        });
        let Some(update) = self.opened_update(to_version) else {
            return;
        };
        let (from, to) = range(update, self.overleaf_newest(), compare);
        let Some(key) = files_key(update, self.overleaf_newest(), compare) else {
            return;
        };
        let Some(root) = self.root.clone() else {
            return;
        };
        let Some(opened) = self.overleaf.opened.as_mut() else {
            return;
        };
        let generation = opened.files.start(key);
        let read = cx.background_executor().spawn(async move {
            lattice_core::overleaf::history_files(&config_dir(), &root, from, to)
                .map(|body| changed_files(&body))
        });
        cx.spawn(async move |this, cx| {
            let read = read.await;
            let (read, expired) = crate::overleaf::settled(read);
            if expired {
                cx.update(crate::overleaf::session_changed);
            }
            this.update(cx, |this, cx| {
                if let Some(opened) = this.overleaf.opened.as_mut()
                    && opened.files.settle(generation, read)
                {
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Read the open update's file `path` across its range; the open file
    /// again closes it.
    pub(super) fn open_overleaf_file(&mut self, path: String, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let newest = self.overleaf_newest();
        let Some(opened) = self.overleaf.opened.as_mut() else {
            return;
        };
        if opened.diff.is(&path) {
            opened.diff.clear();
            cx.notify();
            return;
        }
        let Some(update) = self
            .overleaf
            .updates
            .iter()
            .find(|update| update.to_version == opened.to_version)
        else {
            return;
        };
        let (from, to) = range(update, newest, opened.compare);
        let generation = opened.diff.start(path.clone());
        cx.notify();
        let file = path.clone();
        let read = cx.background_executor().spawn(async move {
            lattice_core::overleaf::history_diff(&config_dir(), &root, &file, from, to)
        });
        cx.spawn(async move |this, cx| {
            let read = read.await;
            let (read, expired) = crate::overleaf::settled(read);
            if expired {
                cx.update(crate::overleaf::session_changed);
            }
            this.update(cx, |this, cx| {
                let diff = read.map(|body| match texts_from_chunks(&body) {
                    Some((before, after)) => OverleafDiff {
                        loaded: Some(LoadedDiff::new(
                            FileChange {
                                path: path.clone(),
                                before: Some(before),
                                after: Some(after),
                            },
                            cx,
                        )),
                    },
                    None => OverleafDiff { loaded: None },
                });
                if let Some(opened) = this.overleaf.opened.as_mut()
                    && opened.diff.settle(generation, diff)
                {
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Run one action on Overleaf's history and, once it succeeds, say `done`
    /// and read the first page again (a restore also syncs the window); a
    /// refusal stays shown above the list. Busy until the reread settles.
    fn overleaf_action(
        &mut self,
        done: String,
        restored: bool,
        work: impl FnOnce(&Path, &Path) -> Result<(), String> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root.clone() else {
            return;
        };
        if self.overleaf.busy {
            return;
        }
        self.overleaf.busy = true;
        self.overleaf.error = None;
        let epoch = self.overleaf.epoch;
        cx.notify();
        let run = cx
            .background_executor()
            .spawn(async move { work(&config_dir(), &root) });
        cx.spawn(async move |this, cx| {
            let outcome = run.await;
            let (outcome, expired) = crate::overleaf::settled(outcome);
            if expired {
                cx.update(crate::overleaf::session_changed);
            }
            let reread = this.update(cx, |this, cx| match outcome {
                _ if this.overleaf.epoch != epoch => None,
                Ok(()) => {
                    notices::show(
                        Notice::new(ToastLevel::Success, done).source(t!("Overleaf history")),
                        cx,
                    );
                    if restored {
                        cx.emit(HistoryEvent::OverleafRestored);
                    }
                    if let Some(opened) = this.overleaf.opened.as_mut() {
                        opened.label = None;
                    }
                    Some(this.read_overleaf_page(None, cx))
                }
                Err(error) => {
                    this.overleaf.busy = false;
                    this.overleaf.error = Some(error);
                    cx.notify();
                    None
                }
            });
            if let Ok(Some(reread)) = reread {
                reread.await;
                this.update(cx, |this, cx| {
                    if this.overleaf.epoch == epoch {
                        this.overleaf.busy = false;
                        cx.notify();
                    }
                })
                .ok();
            }
        })
        .detach();
    }

    /// Rewind the whole project on Overleaf to `version`, once the writer
    /// confirms what that deletes.
    pub(super) fn restore_overleaf_project(&mut self, version: i64, cx: &mut Context<Self>) {
        let question = format!(
            "{}\n\n{}",
            t!("Restore the whole project to this version on Overleaf?"),
            t!(
                "Files added since will be deleted, and everything else will be rewound to match. The only way back from here is another restore."
            ),
        );
        self.ask(
            question,
            true,
            move |this, cx| {
                this.overleaf_action(
                    t!("Project restored.").into(),
                    true,
                    move |config, root| {
                        lattice_core::overleaf::history_revert(config, root, version, None)
                    },
                    cx,
                )
            },
            cx,
        );
    }

    /// Restore `file` as the update left it, or bring it back when deleted.
    pub(super) fn restore_overleaf_file(
        &mut self,
        to_version: i64,
        file: OverleafFile,
        cx: &mut Context<Self>,
    ) {
        let done = t!("Restored {path}.", path = &file.pathname).to_string();
        self.overleaf_action(
            done,
            true,
            move |config, root| match (file.operation.as_str(), file.deleted_at_v) {
                ("removed", Some(version)) => lattice_core::overleaf::history_restore_file(
                    config,
                    root,
                    version,
                    &file.pathname,
                ),
                _ => lattice_core::overleaf::history_revert(
                    config,
                    root,
                    to_version,
                    Some(&file.pathname),
                ),
            },
            cx,
        );
    }

    /// Open the field a name for the opened version is typed in.
    pub(super) fn open_overleaf_label(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(to_version) = self
            .overleaf
            .opened
            .as_ref()
            .map(|opened| opened.to_version)
        else {
            return;
        };
        let field = cx.new(|cx| InputState::new(window, cx).placeholder(t!("Name this version…")));
        let subscription = cx.subscribe(&field, move |this, field, event, cx| match event {
            InputEvent::PressEnter { .. } => {
                let comment = field.read(cx).value().to_string();
                this.add_overleaf_label(to_version, comment, cx);
            }
            InputEvent::Change => cx.notify(),
            _ => {}
        });
        field.update(cx, |field, cx| field.focus(window, cx));
        if let Some(opened) = self.overleaf.opened.as_mut() {
            opened.label = Some((field, subscription));
        }
        cx.notify();
    }

    pub(super) fn close_overleaf_label(&mut self, cx: &mut Context<Self>) {
        if let Some(opened) = self.overleaf.opened.as_mut() {
            opened.label = None;
            cx.notify();
        }
    }

    pub(super) fn add_overleaf_label(
        &mut self,
        version: i64,
        comment: String,
        cx: &mut Context<Self>,
    ) {
        let comment = comment.trim().to_string();
        if comment.is_empty() {
            return;
        }
        self.overleaf_action(
            t!("Version named.").into(),
            false,
            move |config, root| {
                lattice_core::overleaf::history_add_label(config, root, version, &comment)
            },
            cx,
        );
    }

    /// Remove a version's name, once the writer confirms.
    pub(super) fn delete_overleaf_label(
        &mut self,
        id: String,
        comment: String,
        cx: &mut Context<Self>,
    ) {
        let question = t!(
            "Remove the “{comment}” label from this Overleaf version?",
            comment = comment
        )
        .to_string();
        self.ask(
            question,
            true,
            move |this, cx| {
                let id = id.clone();
                this.overleaf_action(
                    t!("Label removed.").into(),
                    false,
                    move |config, root| {
                        lattice_core::overleaf::history_delete_label(config, root, &id)
                    },
                    cx,
                )
            },
            cx,
        );
    }
}

/// What the parity and e2e scenarios ask of Overleaf's history, as the
/// writer's clicks would.
impl HistoryPanel {
    /// The Overleaf view, as its pill chooses it.
    pub fn show_overleaf_for_scenario(&mut self, cx: &mut Context<Self>) {
        self.select_view(super::timeline::HistoryView::Overleaf, cx);
    }

    /// Overleaf's entries as read, newest first.
    pub fn overleaf_updates(&self) -> &[OverleafUpdate] {
        &self.overleaf.updates
    }

    /// The entry `to_version` opened compared with now, as its tool does.
    pub fn compare_overleaf_for_scenario(&mut self, to_version: i64, cx: &mut Context<Self>) {
        self.compare_row(overleaf_key(to_version), cx);
    }

    /// The opened entry's changed files, once read.
    pub fn overleaf_files(&self) -> Option<Vec<OverleafFile>> {
        self.overleaf.opened.as_ref()?.files.value.clone()
    }

    /// The opened entry's file `path`, opened as its chip does.
    pub fn open_overleaf_file_for_scenario(&mut self, path: &str, cx: &mut Context<Self>) {
        self.open_overleaf_file(path.to_string(), cx);
    }

    /// The opened file's two sides, once read.
    pub fn overleaf_diff_texts(&self) -> Option<(Option<String>, Option<String>)> {
        let loaded = self
            .overleaf
            .opened
            .as_ref()?
            .diff
            .value
            .as_ref()?
            .loaded
            .as_ref()?;
        Some((loaded.change.before.clone(), loaded.change.after.clone()))
    }

    /// The opened entry's file `path` restored, as its Restore does.
    pub fn restore_overleaf_file_for_scenario(
        &mut self,
        path: &str,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(opened) = self.overleaf.opened.as_ref() else {
            return false;
        };
        let version = opened.to_version;
        let Some(file) = opened
            .files
            .value
            .as_ref()
            .and_then(|files| files.iter().find(|file| file.pathname == path).cloned())
        else {
            return false;
        };
        self.restore_overleaf_file(version, file, cx);
        true
    }

    /// The opened entry's "Name this version" field, opened.
    pub fn name_overleaf_version_for_scenario(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_overleaf_label(window, cx);
    }

    /// An Overleaf action is under way.
    pub fn overleaf_busy(&self) -> bool {
        self.overleaf.busy
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn chunks_read_back_into_both_texts() {
        // Overleaf's own example shape: unchanged, deleted, inserted runs.
        let body = json!({ "diff": [
            { "u": "The " },
            { "d": "quick" },
            { "i": "slow" },
            { "u": " fox\n" },
        ] });
        let (before, after) = texts_from_chunks(&body).expect("text");
        assert_eq!(before, "The quick fox\n");
        assert_eq!(after, "The slow fox\n");
    }

    #[test]
    fn clearing_keeps_the_read_counter_running() {
        let history = OverleafHistory {
            loading: true,
            error: Some("refused".into()),
            busy: true,
            asked: true,
            seq: 3,
            epoch: 1,
            ..OverleafHistory::default()
        };
        let history = history.cleared();
        assert_eq!(history.seq, 3);
        assert_eq!(history.epoch, 2);
        assert!(!history.loading && !history.busy && !history.asked);
        assert_eq!(history.error, None);
    }

    #[test]
    fn a_binary_file_has_no_texts() {
        assert_eq!(
            texts_from_chunks(&json!({ "diff": { "binary": true } })),
            None
        );
    }

    #[test]
    fn only_files_with_an_operation_changed() {
        let body = json!({ "diff": [
            { "pathname": "main.tex", "operation": "edited" },
            { "pathname": "refs.bib" },
            { "pathname": "old.tex", "operation": "removed", "deletedAtV": 41 },
            { "pathname": "a.tex", "operation": "renamed", "newPathname": "b.tex" },
        ] });
        let files = changed_files(&body);
        let names: Vec<&str> = files.iter().map(|file| file.pathname.as_str()).collect();
        assert_eq!(names, ["main.tex", "old.tex", "a.tex"]);
        assert_eq!(files[1].deleted_at_v, Some(41));
        assert_eq!(files[2].new_pathname.as_deref(), Some("b.tex"));
    }

    #[test]
    fn an_update_reads_its_own_range_or_up_to_the_newest() {
        let update = OverleafUpdate {
            from_version: 10,
            to_version: 12,
            start_ts: 0,
            end_ts: 0,
            authors: Vec::new(),
            paths: Vec::new(),
            labels: Vec::new(),
            origin: None,
        };
        assert_eq!(range(&update, Some(20), false), (10, 12));
        assert_eq!(range(&update, Some(20), true), (12, 20));
        // The newest itself, compared with now, has nothing between.
        assert_eq!(range(&update, Some(12), true), (12, 12));
        assert_eq!(files_key(&update, Some(12), true), None);
        // A newer version moves the compared range, and so the key its
        // files are read under; its own changes stay put.
        assert_eq!(files_key(&update, Some(20), true).as_deref(), Some("12:20"));
        assert_eq!(files_key(&update, Some(21), true).as_deref(), Some("12:21"));
        assert_eq!(
            files_key(&update, Some(21), false).as_deref(),
            Some("10:12")
        );
    }
}
