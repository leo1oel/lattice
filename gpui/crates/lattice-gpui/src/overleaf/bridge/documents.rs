//! The open document edited live with Overleaf: the Tauri app's
//! `use-overleaf-realtime.ts`, on lattice-core's OT engine
//! (`overleaf_rt::ot`).
//!
//! In live mode, with the channel up, the document in the editor the writer
//! works in is joined: typing goes out as operations a quarter of a second
//! after the first unsent keystroke (one in flight at a time, the rest
//! queued behind it), and a co-author's operations come into the buffer as
//! they land, out of its undo history. Only that document is live; another
//! one is left once everything typed in it has been answered, waiting at
//! most 15 s.
//!
//! Joining reconciles the buffer with Overleaf's text through the copy the
//! last sync agreed on (`agreed_text`): equal to Overleaf's, the buffer's
//! difference is typing to send; equal to the buffer's, Overleaf's text is
//! taken; anything else is two sides that moved, which regular sync merges,
//! so the document is not joined. Leaving a document everything reached
//! records Overleaf's text as the sync's agreed copy
//! (`checkpoint_realtime_text`) once the file on disk holds it, so the next
//! sync has nothing to merge; a sync running then is waited out first, as
//! both write the sync's state. A buffer with conflict markers is never
//! joined, nor its typing sent: regular sync keeps them on this Mac.
//!
//! The regular sync leaves the live document to the channel (`live_paths`).
//! A document with work unanswered when the channel drops is held for the
//! reconnect (`resume`). Anything that cannot be proven (an operation that
//! does not fit, an update Overleaf refuses, a send whose outcome is
//! unknown) drops the document back to regular sync, which reconciles it.

use std::time::Duration;

use gpui::{Entity, WeakEntity};
use lattice_core::overleaf_rt::{
    Submission,
    ot::{OtDesync, OtDocument, OtSend},
};

use super::*;
use crate::{editor_panel::EditorPanel, history::conflicts::has_conflict_markers};

mod joining;
mod resume;

/// Typing goes out this long after the first unsent keystroke.
const SEND_AFTER: Duration = Duration::from_millis(250);
/// A document left with work in flight is waited on this long.
const DRAIN: Duration = Duration::from_secs(15);
/// Overleaf's hash rides on an update at most this often.
const HASH_EVERY: Duration = Duration::from_secs(5);

struct LiveDoc {
    path: String,
    doc_id: String,
    editor: WeakEntity<EditorPanel>,
    ot: OtDocument,
    /// The coalescing timer, while typing waits to go out.
    send: Option<Task<()>>,
    /// Left, waiting for the work in flight to be answered.
    draining: Option<Task<()>>,
    /// When an update last carried Overleaf's hash.
    hashed_at: Option<std::time::Instant>,
}

/// Where a file stands with Overleaf, for the status bar's save slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverleafSaveState {
    /// Live, and Overleaf has every edit.
    Live,
    /// Live, with an edit Overleaf has not acknowledged yet.
    Sending,
    /// A sync is running.
    Syncing,
    /// The live channel dropped: edits wait on this Mac.
    Offline,
    /// Edits go when the writer (or live mode's poll) syncs.
    Manual,
    /// The link is paused.
    Paused,
}

#[derive(Default)]
pub(super) struct DocumentsState {
    live: Option<LiveDoc>,
    /// Draining documents left behind by a switch: by id.
    leaving: Vec<LiveDoc>,
    /// The editor the writer works in, live or not.
    shown: Option<WeakEntity<EditorPanel>>,
    joining: Option<joining::Joining>,
    join_generation: u64,
    /// Updates for a document being joined or resumed, for the replay.
    early: Vec<RealtimeEvent>,
    /// Agreed copies to record once the running sync is over.
    checkpoints: Vec<(String, String)>,
    /// The U+FFFD notice was shown this session.
    replaced_told: bool,
    /// Paths handed back to regular sync: not joined again until a sync
    /// has reconciled them. A buffer with conflict markers is not joined
    /// either, until they are resolved.
    suspended: BTreeSet<String>,
    /// Documents with work unanswered when the channel dropped, kept for
    /// the reconnect to carry on with.
    held: Vec<LiveDoc>,
    /// Joining the held documents again from their versions.
    resuming: Option<Task<()>>,
}

impl OverleafBridge {
    /// The project-relative path of the document edited live, if any.
    pub fn live_file(&self) -> Option<&str> {
        self.documents.live.as_ref().map(|doc| doc.path.as_str())
    }

    /// Typing in the live document has not all reached Overleaf.
    pub fn live_sending(&self) -> bool {
        self.documents
            .live
            .as_ref()
            .is_some_and(|doc| doc.send.is_some() || !doc.ot.settled())
    }

    /// The editor the writer works in, live or not.
    pub(super) fn shown_editor(&self) -> Option<Entity<EditorPanel>> {
        self.documents.shown.as_ref()?.upgrade()
    }

    /// Where `path` stands with Overleaf, as the status bar's save slot
    /// words it (`overleafSaveState`); none when the project is not linked.
    pub fn save_state(&self, path: &str) -> Option<OverleafSaveState> {
        let link = self.link.as_ref()?;
        Some(if link.link.paused {
            OverleafSaveState::Paused
        } else if self.syncing {
            OverleafSaveState::Syncing
        } else if self.mode != OverleafSyncMode::Live {
            OverleafSaveState::Manual
        } else if self.channel == ChannelStatus::Live && self.live_file() == Some(path) {
            if self.live_sending() {
                OverleafSaveState::Sending
            } else {
                OverleafSaveState::Live
            }
        } else if self.channel == ChannelStatus::Error
            || (self.channel == ChannelStatus::Connecting && self.channel_detail.is_some())
        {
            // Reconnecting after a drop, or given up on: edits wait here.
            OverleafSaveState::Offline
        } else {
            OverleafSaveState::Manual
        })
    }

    /// The paths the channel carries, which regular sync leaves alone.
    pub(super) fn live_paths(&self) -> BTreeSet<String> {
        self.documents
            .live
            .iter()
            .chain(&self.documents.leaving)
            .chain(&self.documents.held)
            .map(|doc| doc.path.clone())
            .collect()
    }

    /// The writer works in `editor` now (or in none).
    pub fn editor_shown(&mut self, editor: Option<&Entity<EditorPanel>>, cx: &mut Context<Self>) {
        let shown = editor.map(Entity::downgrade);
        if self.documents.shown == shown {
            return;
        }
        self.documents.shown = shown;
        self.reconsider_live(cx);
    }

    /// Join the shown editor's document when live editing is on, after
    /// leaving any other.
    pub(super) fn reconsider_live(&mut self, cx: &mut Context<Self>) {
        let wanted = self.wanted_live(cx);
        let current = self
            .documents
            .live
            .as_ref()
            .map(|doc| &doc.editor)
            .or(self.documents.joining.as_ref().map(|joining| &joining.editor));
        if wanted.as_ref().map(|(editor, _, _)| editor) == current {
            return;
        }
        // A join still out is left once Overleaf answers it.
        if let Some(joining) = self.documents.joining.take() {
            self.take_early(&joining.doc_id);
        }
        if let Some(doc) = self.documents.live.take() {
            self.leave(doc, cx);
        }
        if let Some((editor, path, doc_id)) = wanted {
            // Back to a document still draining: it carries on, room and all.
            let draining = self
                .documents
                .leaving
                .iter()
                .position(|doc| doc.doc_id == doc_id && doc.editor == editor);
            match draining {
                Some(at) => {
                    let mut doc = self.documents.leaving.remove(at);
                    doc.draining = None;
                    self.documents.live = Some(doc);
                }
                None => self.join(editor, path, doc_id, cx),
            }
        }
        cx.notify();
    }

    /// The editor, path and document id to be live now, if any.
    fn wanted_live(&self, cx: &App) -> Option<(WeakEntity<EditorPanel>, String, String)> {
        if self.staged
            || self.mode != OverleafSyncMode::Live
            || self.channel != ChannelStatus::Live
            || self.client.is_none()
            || self.link().is_none()
        {
            return None;
        }
        let weak = self.documents.shown.clone()?;
        let editor = weak.upgrade()?;
        let path = editor.read(cx).relative().to_string();
        let held = self.documents.held.iter().any(|doc| doc.path == path);
        if held || self.documents.suspended.contains(&path) {
            return None;
        }
        // Never publish conflict markers: regular sync keeps them here.
        if has_conflict_markers(&editor.read(cx).overleaf_text(cx)) {
            return None;
        }
        let doc_id = self.doc_of_path(&path)?;
        Some((weak, path, doc_id))
    }

    /// The writer typed in `editor`.
    pub fn editor_typed(&mut self, editor: &Entity<EditorPanel>, cx: &mut Context<Self>) {
        let Some(doc) = self.documents.live.as_mut() else {
            return;
        };
        if doc.editor != editor.downgrade() || doc.send.is_some() {
            return;
        }
        // From the first unsent keystroke, never pushed back.
        doc.send = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SEND_AFTER).await;
            this.update(cx, |this, cx| this.flush_typing(cx)).ok();
        }));
        cx.notify();
    }

    /// Hand the live document's unsent typing to the OT state, sending it
    /// when nothing is in flight.
    fn flush_typing(&mut self, cx: &mut Context<Self>) {
        let Some(doc) = self.documents.live.as_mut() else {
            return;
        };
        doc.send = None;
        let Some(panel) = doc.editor.upgrade() else {
            return;
        };
        let buffer = panel.read(cx).overleaf_text(cx);
        if has_conflict_markers(&buffer) {
            let doc_id = doc.doc_id.clone();
            self.drop_live(&doc_id, None, cx);
            return;
        }
        let typed = doc.ot.local(&buffer);
        if typed.replaced {
            let stored = doc.ot.text().to_string();
            panel.update(cx, |panel, cx| panel.take_overleaf_text(&stored, cx));
            if !self.documents.replaced_told {
                self.documents.replaced_told = true;
                notices::show(
                    Notice::new(
                        ToastLevel::Info,
                        t!(
                            "Overleaf can't store emoji and some other special characters, so they were replaced with � — the same thing everyone else in the project sees."
                        ),
                    ),
                    cx,
                );
            }
        }
        if let Some(send) = typed.send {
            let id = doc.doc_id.clone();
            self.send_ops(&id, send, Vec::new(), cx);
        }
        cx.notify();
    }

    /// Send `doc_id`'s operation.
    fn send_ops(
        &mut self,
        doc_id: &str,
        send: OtSend,
        dup_if_source: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let Some(doc) = self.doc_mut(doc_id) else {
            return;
        };
        doc.ot.note_submitted(Some(&client.public_id()));
        // The hash describes the text once this update lands as sent, so it
        // rides only on one with nothing queued behind it, now and then.
        let due = doc.hashed_at.is_none_or(|at| at.elapsed() >= HASH_EVERY);
        let hash = doc
            .ot
            .sent_text()
            .filter(|_| due)
            .map(lattice_core::overleaf_rt::ot::doc_hash);
        if hash.is_some() {
            doc.hashed_at = Some(std::time::Instant::now());
        }
        let doc_id = doc.doc_id.clone();
        let asked = client.clone();
        let sending = lattice_core::runtime::spawn(async move {
            let submission = Submission {
                dup_if_source: &dup_if_source,
                hash: hash.as_deref(),
            };
            asked
                .send_ops(&doc_id, send.version, send.ops, false, submission)
                .await
        });
        let doc_id = doc.doc_id.clone();
        cx.spawn(async move |this, cx| {
            let sent = matches!(sending.await, Ok(Ok(())));
            // The connection closed under it: the drop it reports next
            // holds the document for the reconnect, as unanswered work.
            let dropping = client.current_entities().is_none();
            if !sent && !dropping {
                // Whether it landed is unknown: regular sync reconciles.
                this.update(cx, |this, cx| this.drop_live(&doc_id, None, cx))
                    .ok();
            }
        })
        .detach();
    }

    /// What the channel said about a document.
    pub(super) fn document_event(&mut self, event: RealtimeEvent, cx: &mut Context<Self>) {
        self.keep_early(&event);
        match event {
            RealtimeEvent::DocAck { doc_id, version } => {
                let Some(doc) = self.doc_mut(&doc_id) else {
                    return;
                };
                match doc.ot.acknowledge(Some(version)) {
                    Ok(next) => {
                        let draining = doc.draining.is_some();
                        let settled = doc.ot.settled();
                        if let Some(send) = next {
                            self.send_ops(&doc_id, send, Vec::new(), cx);
                        } else if draining && settled {
                            self.finish_leaving(&doc_id, cx);
                        }
                    }
                    Err(desync) => self.drop_live(&doc_id, Some(drift_notice(&desync)), cx),
                }
            }
            RealtimeEvent::DocUpdate {
                doc_id,
                version,
                ops,
                source,
                ..
            } => {
                let own = self.client.as_ref().map(|client| client.public_id());
                let is_live = self
                    .documents
                    .live
                    .as_ref()
                    .is_some_and(|doc| doc.doc_id == doc_id);
                if is_live {
                    // Typing not yet handed over goes first, so the update is
                    // transformed against it.
                    if self
                        .documents
                        .live
                        .as_ref()
                        .is_some_and(|doc| doc.send.is_some())
                    {
                        self.flush_typing(cx);
                    }
                }
                let Some(doc) = self.doc_mut(&doc_id) else {
                    return;
                };
                let mine = source.as_deref().is_some_and(|source| {
                    own.as_deref() == Some(source)
                        || doc.ot.submitted_via().iter().any(|id| id == source)
                });
                if mine {
                    return;
                }
                match doc.ot.remote(&ops, version) {
                    Ok(applied) if is_live && !applied.is_empty() => {
                        let fits = doc.editor.upgrade().is_some_and(|panel| {
                            panel.update(cx, |panel, cx| panel.take_overleaf_ops(&applied, cx))
                        });
                        if !fits {
                            let notice = t!("This document drifted from Overleaf's copy, so live editing stopped. Syncing will reconcile it.").to_string();
                            self.drop_live(&doc_id, Some(notice), cx);
                        }
                    }
                    Ok(_) => {}
                    Err(desync) => self.drop_live(&doc_id, Some(drift_notice(&desync)), cx),
                }
            }
            RealtimeEvent::OtError { doc_id, message } => {
                let notice = t!(
                    "Overleaf rejected a live update ({detail}). Falling back to syncing.",
                    detail = &message
                )
                .to_string();
                self.drop_live(&doc_id, Some(notice), cx);
            }
            _ => {}
        }
        cx.notify();
    }

    fn doc_mut(&mut self, doc_id: &str) -> Option<&mut LiveDoc> {
        self.documents
            .live
            .iter_mut()
            .chain(self.documents.leaving.iter_mut())
            .find(|doc| doc.doc_id == doc_id)
    }

    /// Leave `doc`: at once when everything reached Overleaf, else once it is
    /// answered, waiting at most [`DRAIN`].
    fn leave(&mut self, mut doc: LiveDoc, cx: &mut Context<Self>) {
        // Typing still waiting to go out is handed over first.
        let typed = doc.send.take().and_then(|_| {
            let buffer = doc.editor.upgrade()?.read(cx).overleaf_text(cx);
            if has_conflict_markers(&buffer) {
                return None;
            }
            doc.ot.local(&buffer).send
        });
        if doc.ot.settled() {
            self.release_doc(&doc.doc_id);
            self.checkpoint(&doc, cx);
            return;
        }
        let doc_id = doc.doc_id.clone();
        let waiting = doc_id.clone();
        doc.draining = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DRAIN).await;
            this.update(cx, |this, cx| this.finish_leaving(&waiting, cx))
                .ok();
        }));
        self.documents.leaving.push(doc);
        if let Some(send) = typed {
            self.send_ops(&doc_id, send, Vec::new(), cx);
        }
    }

    /// A left document's wait is over: record its agreed copy when
    /// everything reached Overleaf, and let it go.
    fn finish_leaving(&mut self, doc_id: &str, cx: &mut Context<Self>) {
        let Some(at) = self
            .documents
            .leaving
            .iter()
            .position(|doc| doc.doc_id == doc_id)
        else {
            return;
        };
        let doc = self.documents.leaving.remove(at);
        self.release_doc(&doc.doc_id);
        if doc.ot.settled() {
            self.checkpoint(&doc, cx);
        }
        cx.notify();
    }

    /// Leave `doc_id` on Overleaf, unless another copy of it (live,
    /// draining, held or being joined) still uses its room.
    fn release_doc(&mut self, doc_id: &str) {
        if self.doc_in_use(doc_id) {
            return;
        }
        if let Some(client) = self.client.clone() {
            joining::leave_room(client, doc_id);
        }
    }

    /// Record Overleaf's text for settled `doc` as the sync's agreed copy
    /// (after the running sync, if any), once the file on disk holds it: a
    /// co-author's edit reaches disk only with the editor's save, and an
    /// agreed copy ahead of disk would have sync push the older file back.
    /// A buffer that moved on since is the next sync's to carry.
    fn checkpoint(&mut self, doc: &LiveDoc, cx: &mut Context<Self>) {
        // A project closing has already let its link go.
        let (Some(panel), Some(root), Some(_)) =
            (doc.editor.upgrade(), self.root.clone(), self.link.as_ref())
        else {
            return;
        };
        let (path, text) = (doc.path.clone(), doc.ot.server_text().to_string());
        if panel.read(cx).saved_text() == text {
            return self.record_checkpoint(path, text);
        }
        if panel.read(cx).overleaf_text(cx) != text {
            return;
        }
        let save = panel.update(cx, |panel, cx| panel.save(cx));
        let editor = doc.editor.clone();
        cx.spawn(async move |this, cx| {
            if !matches!(save.await, Ok(true)) {
                return;
            }
            this.update(cx, |this, cx| {
                let saved = editor
                    .upgrade()
                    .is_some_and(|panel| panel.read(cx).saved_text() == text);
                if saved && this.root.as_ref() == Some(&root) {
                    this.record_checkpoint(path, text);
                }
            })
            .ok();
        })
        .detach();
    }

    fn record_checkpoint(&mut self, path: String, text: String) {
        self.documents.checkpoints.push((path, text));
        if !self.syncing {
            self.write_checkpoints();
        }
    }

    /// Record the agreed copies waiting for the sync to be over.
    fn write_checkpoints(&mut self) {
        let Some(root) = self.root.clone() else {
            self.documents.checkpoints.clear();
            return;
        };
        for (path, text) in self.documents.checkpoints.drain(..) {
            if let Err(error) =
                lattice_core::overleaf::checkpoint_realtime_text(&root, &path, &text)
            {
                log::warn!("could not record {path} as agreed with Overleaf: {error}");
            }
        }
    }

    /// A sync ended: the agreed copies it held back are written, and, when
    /// it `succeeded`, the shown document may be joined (a merge it made
    /// settled it). After a failed one, what it handed back stays out of
    /// live editing until a sync gets through.
    pub(super) fn after_sync_documents(&mut self, succeeded: bool, cx: &mut Context<Self>) {
        self.write_checkpoints();
        if succeeded {
            self.documents.suspended.clear();
        }
        self.reconsider_live(cx);
    }

    /// Stop editing `doc_id` live, without recording an agreed copy:
    /// regular sync reconciles it. `notice`, if any, says why.
    fn drop_live(&mut self, doc_id: &str, notice: Option<String>, cx: &mut Context<Self>) {
        if let Some(doc) = self.documents.live.take_if(|doc| doc.doc_id == doc_id) {
            self.documents.suspended.insert(doc.path);
        }
        self.documents.leaving.retain(|doc| doc.doc_id != doc_id);
        self.release_doc(doc_id);
        if let Some(notice) = notice {
            notices::show(
                Notice::new(ToastLevel::Warning, notice).key("overleaf-live-doc"),
                cx,
            );
        }
        self.sync(
            SyncOptions {
                automatic: true,
                ..Default::default()
            },
            cx,
        );
        cx.notify();
    }

    /// The channel dropped: documents everything reached are let go with
    /// their agreed copies. The rest are held for the reconnect when `hold`
    /// (the channel is coming back); otherwise they, and any still held, go
    /// back to regular sync, which is asked to run when there are any, and
    /// true is returned.
    pub(super) fn documents_dropped(&mut self, hold: bool, cx: &mut Context<Self>) -> bool {
        // A join still out is left once Overleaf answers it, if it can be.
        self.documents.joining = None;
        self.documents.resuming = None;
        self.documents.early.clear();
        let docs: Vec<LiveDoc> = self
            .documents
            .live
            .take()
            .into_iter()
            .chain(self.documents.leaving.drain(..))
            .collect();
        let mut handed = false;
        for mut doc in docs {
            if doc.ot.settled() {
                self.checkpoint(&doc, cx);
            } else if hold {
                // Typing still coalescing stays in the buffer, where the
                // resume picks it up.
                doc.send = None;
                doc.draining = None;
                self.documents.held.push(doc);
            } else {
                handed = true;
            }
        }
        if !hold && !self.documents.held.is_empty() {
            self.documents.held.clear();
            handed = true;
        }
        cx.notify();
        handed
    }
}

fn drift_notice(desync: &OtDesync) -> String {
    let _ = desync;
    t!("This document drifted from Overleaf's copy, so live editing stopped. Syncing will reconcile it.").to_string()
}
