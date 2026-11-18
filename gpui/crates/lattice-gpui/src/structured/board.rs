//! A `.excalidraw` board in its panel: the native whiteboard
//! (`lattice_board::board::BoardView`, quiet.md's GPUI port of Excalidraw)
//! in place of a webview island, over the panel's buffer as the islands are:
//!
//! - an edit on the board is serialized a moment later (`SAVE_DELAY`, as the
//!   Tauri app's editor debounces its `onChange`) and becomes the buffer's
//!   text, which arms the autosave;
//! - a change to the file the panel loads (disk, git, Overleaf) is merged
//!   into the open board element by element (`Board::reconcile`);
//! - hiding or closing the panel writes what is pending at once, the text
//!   being typed included;
//! - the reader's camera stays out of the file, kept for the session by path.

use std::time::Duration;

use gpui::{AppContext as _, Context, Entity, Subscription, Task, Window};
use lattice_board::board::{BoardEvent, BoardView};

use super::{StructuredDocument, StructuredEvent, save_view_state, saved_view_state};

/// How long the board waits after an edit before it hands the file's text over.
const SAVE_DELAY: Duration = Duration::from_millis(400);

pub(super) struct NativeBoard {
    pub(super) view: Entity<BoardView>,
    /// The pending serialization of an edit.
    save: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl NativeBoard {
    pub(super) fn new(
        source: &str,
        path: &std::path::Path,
        window: &mut Window,
        cx: &mut Context<StructuredDocument>,
    ) -> Self {
        let view = cx.new(|cx| {
            let mut view = BoardView::open(source, window, cx);
            view.set_export_target(path);
            view
        });
        let state = saved_view_state(path, cx);
        if !state.is_null() {
            view.update(cx, |view, cx| view.restore_view_state(&state, cx));
        }
        let subscription = cx.subscribe(&view, StructuredDocument::on_board);
        Self {
            view,
            save: None,
            _subscriptions: vec![subscription],
        }
    }
}

impl StructuredDocument {
    fn on_board(&mut self, view: Entity<BoardView>, event: &BoardEvent, cx: &mut Context<Self>) {
        match event {
            BoardEvent::Changed => {
                let task = cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(SAVE_DELAY).await;
                    this.update(cx, |this, cx| this.write_board(cx)).ok();
                });
                if let Some(board) = &mut self.board {
                    board.save = Some(task);
                }
            }
            BoardEvent::ViewChanged => {
                let state = view.read(cx).view_state();
                save_view_state(&self.root.join(&self.relative), state, cx);
            }
        }
    }

    /// The board's text becomes the buffer's (what a pending edit waits for).
    fn write_board(&mut self, cx: &mut Context<Self>) {
        let Some(board) = &mut self.board else {
            return;
        };
        board.save = None;
        let view = board.view.clone();
        let text = view.update(cx, |view, _| view.file_text());
        if text != self.source {
            self.source = text;
            cx.emit(StructuredEvent::Changed(self.source.clone()));
        }
    }

    /// Hiding or closing: the text being typed ends and the edits are written now.
    pub(super) fn flush_board(&mut self, cx: &mut Context<Self>) {
        let Some(board) = &self.board else {
            return;
        };
        let view = board.view.clone();
        view.update(cx, |view, cx| view.finish_editing(cx));
        if self
            .board
            .as_ref()
            .is_some_and(|board| board.save.is_some())
        {
            self.write_board(cx);
        }
        cx.emit(StructuredEvent::Flushed);
    }

    /// The file changed outside: merged into the open board.
    pub(super) fn merge_board(&mut self, cx: &mut Context<Self>) {
        let Some(board) = &self.board else {
            return;
        };
        let view = board.view.clone();
        let source = self.source.clone();
        view.update(cx, |view, cx| view.merge_file(&source, cx));
    }
}
