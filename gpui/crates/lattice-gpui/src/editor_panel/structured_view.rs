//! A board, spreadsheet or Open Slide deck in its panel: the island
//! (`crate::structured`) in place of the editor, over the panel's buffer,
//! which it saves and keeps in step with disk as it does any file's.

use std::time::Duration;

use futures::{FutureExt as _, channel::oneshot};
use gpui::{AppContext as _, Context, Entity, Window};

use super::EditorPanel;
use crate::structured::{StructuredDocument, StructuredEvent, StructuredKind};

/// How long a closing tab waits for its page to hand over what it holds.
const FLUSH_WAIT: Duration = Duration::from_millis(1500);

impl EditorPanel {
    /// Put the island in front of a structured document's text.
    pub(super) fn attach_structured(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(kind) = StructuredKind::of(&self.relative) else {
            return;
        };
        let root = self.project_root(cx);
        let relative = self.relative.clone();
        let source = self.buffer.read(cx).text();
        let document =
            cx.new(|cx| StructuredDocument::new(kind, &root, relative, source, window, cx));
        self._subscriptions
            .push(cx.subscribe(&document, Self::on_structured));
        self.structured = Some(document);
    }

    /// The board, sheet or deck in front of this file's text.
    pub fn structured(&self) -> Option<&Entity<StructuredDocument>> {
        self.structured.as_ref()
    }

    pub(super) fn on_structured(
        &mut self,
        document: Entity<StructuredDocument>,
        event: &StructuredEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            StructuredEvent::Changed(text) => self.take_page_text(text.clone(), cx),
            StructuredEvent::Persist(id) => {
                let id = *id;
                let save = self.save(cx);
                cx.spawn(async move |_, cx| {
                    let saved = save.await.unwrap_or(false);
                    document.update(cx, |document, cx| document.persisted(id, saved, cx));
                })
                .detach();
            }
            StructuredEvent::Flushed => {
                if let Some(flushed) = self.page_flushed.take() {
                    flushed.send(()).ok();
                }
            }
            // A Markdown file's visual editor is the views' (`markdown_view.rs`).
            StructuredEvent::Markdown(_) => {}
            StructuredEvent::Wrote { path, text } => {
                // Open Slide saved this deck's own file: the buffer takes
                // what landed as what is on disk.
                if *path == self.relative
                    && let Some(text) = text
                {
                    self.accept_written(text.clone(), cx);
                }
            }
        }
    }

    /// The page's editor serialized the document: the buffer takes it as an
    /// edit, which arms the autosave. The page keeps its own undo history,
    /// so the buffer keeps none of these.
    fn take_page_text(&mut self, text: String, cx: &mut Context<Self>) {
        if self.buffer.read(cx).text() == text {
            return;
        }
        self.buffer.update(cx, |buffer, cx| {
            buffer.finalize_last_transaction();
            buffer.set_text(text, cx);
            if let Some(id) = buffer
                .finalize_last_transaction()
                .map(|transaction| transaction.id)
            {
                buffer.forget_transaction(id);
            }
        });
    }

    /// The buffer's text changed (a reload from disk, a merge after a save):
    /// the page follows, unless the text is its own.
    pub(super) fn structured_source_changed(&mut self, cx: &mut Context<Self>) {
        if let Some(document) = self.structured.clone() {
            let text = self.buffer.read(cx).text();
            document.update(cx, |document, cx| document.set_source(text, cx));
        }
    }

    /// The panel became, or stopped being, its group's displayed tab.
    pub(super) fn structured_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        if let Some(document) = self.structured.clone() {
            document.update(cx, |document, cx| document.set_shown(shown, cx));
        }
    }

    pub(super) fn structured_files_changed(
        &mut self,
        paths: Option<&[String]>,
        cx: &mut Context<Self>,
    ) {
        if let Some(document) = self.structured.clone() {
            document.update(cx, |document, cx| document.files_changed(paths, cx));
        }
    }

    /// The tab left the dock: the page hands over what it holds, then the
    /// file saves. The panel stays alive until both are done, or the page has
    /// not answered within [`FLUSH_WAIT`].
    pub(super) fn close_structured(&mut self, cx: &mut Context<Self>) -> bool {
        // A Markdown file's visual editor, too, once its page has loaded:
        // one never shown holds nothing.
        let Some(document) = self.structured.clone().or_else(|| {
            self.markdown_document()
                .filter(|document| document.read(cx).page_ready(cx))
                .cloned()
        }) else {
            return false;
        };
        let (flushed, answered) = oneshot::channel();
        self.page_flushed = Some(flushed);
        document.update(cx, |document, cx| {
            document.flush(cx);
            document.set_shown(false, cx);
        });
        let this = cx.entity();
        let timer = cx.background_executor().timer(FLUSH_WAIT);
        cx.spawn(async move |_, cx| {
            futures::select_biased! {
                _ = answered.fuse() => {}
                _ = timer.fuse() => log::warn!("a closing page did not hand over its edits in time"),
            }
            let save = this.update(cx, |this, cx| {
                this.page_flushed = None;
                this.flush(cx);
                this.save_queue.clone()
            });
            if let Some(queue) = save {
                queue.await;
            }
            // The panel is dropped with `this`, once its save has landed.
            drop(this);
        })
        .detach();
        true
    }
}
