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
//! (`checkpoint_realtime_text`), so the next sync has nothing to merge; a
//! sync running then is waited out first, as both write the sync's state.
//!
//! The regular sync leaves the live document to the channel (`live_paths`).
//! Anything that cannot be proven (an operation that does not fit, an
//! update Overleaf refuses, a send whose outcome is unknown) drops the
//! document back to regular sync, which reconciles it.

use std::time::Duration;

use gpui::{Entity, WeakEntity};
use lattice_core::overleaf_rt::{
    Submission,
    ot::{OtDesync, OtDocument, OtSend},
};

use super::*;
use crate::editor_panel::EditorPanel;

/// Typing goes out this long after the first unsent keystroke.
const SEND_AFTER: Duration = Duration::from_millis(250);
/// A document left with work in flight is waited on this long.
const DRAIN: Duration = Duration::from_secs(15);

struct LiveDoc {
    path: String,
    doc_id: String,
    editor: WeakEntity<EditorPanel>,
    ot: OtDocument,
    /// The coalescing timer, while typing waits to go out.
    send: Option<Task<()>>,
    /// Left, waiting for the work in flight to be answered.
    draining: Option<Task<()>>,
}

#[derive(Default)]
pub(super) struct DocumentsState {
    live: Option<LiveDoc>,
    /// Draining documents left behind by a switch: by id.
    leaving: Vec<LiveDoc>,
    /// The editor the writer works in, live or not.
    shown: Option<WeakEntity<EditorPanel>>,
    joining: Option<Task<()>>,
    /// Agreed copies to record once the running sync is over.
    checkpoints: Vec<(String, String)>,
    /// The U+FFFD notice was shown this session.
    replaced_told: bool,
    /// Paths handed back to regular sync: not joined again until a sync
    /// has reconciled them.
    suspended: BTreeSet<String>,
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

    /// The paths the channel carries, which regular sync leaves alone.
    pub(super) fn live_paths(&self) -> BTreeSet<String> {
        self.documents
            .live
            .iter()
            .chain(&self.documents.leaving)
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
        let current = self.documents.live.as_ref().map(|doc| doc.editor.clone());
        if wanted.as_ref().map(|(editor, _, _)| editor) == current.as_ref() {
            return;
        }
        self.documents.joining = None;
        if let Some(doc) = self.documents.live.take() {
            self.leave(doc, cx);
        }
        if let Some((editor, path, doc_id)) = wanted {
            self.join(editor, path, doc_id, cx);
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
        if self.documents.suspended.contains(&path) {
            return None;
        }
        let doc_id = self.doc_of_path(&path)?;
        Some((weak, path, doc_id))
    }

    fn join(
        &mut self,
        editor: WeakEntity<EditorPanel>,
        path: String,
        doc_id: String,
        cx: &mut Context<Self>,
    ) {
        let (Some(client), Some(root)) = (self.client.clone(), self.root.clone()) else {
            return;
        };
        let id = doc_id.clone();
        let joining = lattice_core::runtime::spawn(async move { client.join_doc(&id, None).await });
        let agreed_path = path.clone();
        let agreed =
            cx.background_spawn(
                async move { lattice_core::overleaf::agreed_text(&root, &agreed_path) },
            );
        self.documents.joining = Some(cx.spawn(async move |this, cx| {
            let joined = joining.await;
            let agreed = agreed.await;
            this.update(cx, |this, cx| {
                this.documents.joining = None;
                let Ok(Ok(joined)) = joined else {
                    return;
                };
                let Some(panel) = editor.upgrade() else {
                    return;
                };
                let buffer = panel.read(cx).overleaf_text(cx);
                let mut ot = OtDocument::new(joined.text.clone(), joined.version);
                let send = if buffer == joined.text {
                    None
                } else if agreed.as_deref() == Some(joined.text.as_str()) {
                    // Overleaf has not moved since the last sync: the
                    // buffer's difference is typing that has not reached it.
                    let typed = ot.local(&buffer);
                    if typed.replaced {
                        panel.update(cx, |panel, cx| panel.take_overleaf_text(ot.text(), cx));
                    }
                    typed.send
                } else if agreed.as_deref() == Some(buffer.as_str()) {
                    // Only Overleaf moved: take its text.
                    panel.update(cx, |panel, cx| panel.take_overleaf_text(&joined.text, cx));
                    None
                } else {
                    // Both moved: regular sync merges it.
                    this.release_doc(&doc_id, None);
                    this.documents.suspended.insert(path);
                    this.sync(
                        SyncOptions {
                            automatic: true,
                            ..Default::default()
                        },
                        cx,
                    );
                    return;
                };
                this.documents.live = Some(LiveDoc {
                    path,
                    doc_id,
                    editor,
                    ot,
                    send: None,
                    draining: None,
                });
                if let Some(send) = send {
                    let id = this
                        .documents
                        .live
                        .as_ref()
                        .map(|doc| doc.doc_id.clone())
                        .unwrap_or_default();
                    this.send_ops(&id, send, Vec::new(), cx);
                }
                cx.notify();
            })
            .ok();
        }));
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
        let doc_id = doc.doc_id.clone();
        let sending = lattice_core::runtime::spawn(async move {
            let submission = Submission {
                dup_if_source: &dup_if_source,
                hash: None,
            };
            client
                .send_ops(&doc_id, send.version, send.ops, false, submission)
                .await
        });
        let doc_id = doc.doc_id.clone();
        cx.spawn(async move |this, cx| {
            let sent = matches!(sending.await, Ok(Ok(())));
            if !sent {
                // Whether it landed is unknown: regular sync reconciles.
                this.update(cx, |this, cx| this.drop_live(&doc_id, None, cx))
                    .ok();
            }
        })
        .detach();
    }

    /// What the channel said about a document.
    pub(super) fn document_event(&mut self, event: RealtimeEvent, cx: &mut Context<Self>) {
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
            doc.ot.local(&buffer).send
        });
        if doc.ot.settled() {
            let checkpoint = doc.ot.server_text().to_string();
            self.release_doc(&doc.doc_id, Some((doc.path, checkpoint)));
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
        let checkpoint = doc
            .ot
            .settled()
            .then(|| (doc.path.clone(), doc.ot.server_text().to_string()));
        self.release_doc(&doc.doc_id, checkpoint);
        cx.notify();
    }

    /// Leave `doc_id` on Overleaf, recording `checkpoint` as the sync's
    /// agreed copy of its path (after the running sync, if any).
    fn release_doc(&mut self, doc_id: &str, checkpoint: Option<(String, String)>) {
        if let Some(client) = self.client.clone() {
            let doc_id = doc_id.to_string();
            lattice_core::runtime::spawn(async move {
                client.leave_doc(&doc_id).await.ok();
            });
        }
        if let Some(checkpoint) = checkpoint {
            self.documents.checkpoints.push(checkpoint);
            if !self.syncing {
                self.write_checkpoints();
            }
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

    /// A sync ended: the agreed copies it held back are written, and the
    /// shown document may be joined (a merge it made settled it).
    pub(super) fn after_sync_documents(&mut self, cx: &mut Context<Self>) {
        self.write_checkpoints();
        self.documents.suspended.clear();
        self.reconsider_live(cx);
    }

    /// Stop editing `doc_id` live, without recording an agreed copy:
    /// regular sync reconciles it. `notice`, if any, says why.
    fn drop_live(&mut self, doc_id: &str, notice: Option<String>, cx: &mut Context<Self>) {
        if let Some(doc) = self.documents.live.take_if(|doc| doc.doc_id == doc_id) {
            self.documents.suspended.insert(doc.path);
        }
        self.documents.leaving.retain(|doc| doc.doc_id != doc_id);
        self.release_doc(doc_id, None);
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
    /// their agreed copies; the rest go back to regular sync.
    pub(super) fn documents_dropped(&mut self, cx: &mut Context<Self>) {
        self.documents.joining = None;
        let docs: Vec<LiveDoc> = self
            .documents
            .live
            .take()
            .into_iter()
            .chain(self.documents.leaving.drain(..))
            .collect();
        for doc in docs {
            let checkpoint = doc
                .ot
                .settled()
                .then(|| (doc.path, doc.ot.server_text().to_string()));
            if let Some(checkpoint) = checkpoint {
                self.documents.checkpoints.push(checkpoint);
            }
        }
        if !self.syncing {
            self.write_checkpoints();
        }
        cx.notify();
    }
}

fn drift_notice(desync: &OtDesync) -> String {
    let _ = desync;
    t!("This document drifted from Overleaf's copy, so live editing stopped. Syncing will reconcile it.").to_string()
}
