//! The status bar's counts of the open buffer: its words, as of opening or
//! the last save, and its TODO markers, as of the last pause in typing (the
//! Tauri app counts them in its settled source, `use-settled-source.ts`).
//! Both are counted off the main thread.

use std::time::Duration;

use gpui::{AppContext as _, Context};

use super::EditorPanel;
use crate::editor_status;

/// The pause in typing after which the buffer's TODOs are counted again, as
/// the Tauri app settles the source it counts them in (`use-settled-source.ts`).
pub(super) const TODO_SETTLE: Duration = Duration::from_millis(500);

impl EditorPanel {
    /// Recount the words from the buffer's text, off the main thread.
    pub(super) fn count_words(&mut self, cx: &mut Context<Self>) {
        let text = self.buffer.read(cx).as_rope().clone();
        let counted = cx.background_spawn(async move { editor_status::count_words(&text) });
        self._count = Some(cx.spawn(async move |this, cx| {
            let words = counted.await;
            this.update(cx, |this, cx| {
                this.words = Some(words);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Count the buffer's TODO markers again once typing has paused for
    /// `delay`, off the main thread; the next edit restarts the wait.
    pub(super) fn scan_todos(&mut self, delay: Duration, cx: &mut Context<Self>) {
        let relative = self.relative.clone();
        let text = self.buffer.read(cx).as_rope().clone();
        self._todos = Some(cx.spawn(async move |this, cx| {
            if !delay.is_zero() {
                cx.background_executor().timer(delay).await;
            }
            let (found, source) = cx
                .background_spawn(async move {
                    let source = text.to_string();
                    (
                        crate::status_counters::buffer_todos(&relative, &source),
                        source,
                    )
                })
                .await;
            this.update(cx, |this, cx| {
                if this.buffer_todos != found {
                    this.buffer_todos = found;
                    cx.notify();
                }
                // The rail reads the file's own headings from the text as of
                // this pause, as the Tauri app's settled source.
                if let Some(rail) = &this.rail {
                    let path = this.relative.clone();
                    rail.update(cx, |rail, cx| rail.set_source(path, source, cx));
                }
            })
            .ok();
        }));
    }
}
