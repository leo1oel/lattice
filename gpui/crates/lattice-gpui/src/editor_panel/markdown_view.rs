//! A Markdown file's visual editor in its panel: the island
//! (`crate::structured::markdown`) its Split and Preview views show, over the
//! panel's buffer, as the Tauri app's canvas puts its visual editor over the
//! CodeMirror source (`document-canvas.tsx`):
//!
//! - an edit the page made lands in the buffer as the minimal change from the
//!   text it was made against, in the buffer's history, so the source keeps
//!   its caret and the two views undo through one history; an edit made
//!   against text the buffer no longer holds is refused, and the page takes
//!   the buffer's text instead (`spliceMarkdownBody` returning null there);
//! - View in source shows the source with the caret where the visual editor
//!   pointed; a link to a project file opens it; the caret in the visual
//!   editor is the status bar's; a jump to a line in Preview lands in the
//!   visual editor, which takes the jump itself (`withEditorFor`);
//! - in Split each side follows the other's top line, the one that moved
//!   last leading (`use-markdown-split-scroll.ts`, by its source anchors).

use std::time::{Duration, Instant};

use editor::{
    SelectionEffects,
    actions::{Redo, Undo},
    display_map::ToDisplayPoint as _,
    scroll::Autoscroll,
};
use gpui::{AppContext as _, Context, Entity, Focusable as _, Window, point};
use language::{Bias, OffsetUtf16, Point};

use super::{DocumentView, EditorPanel, EditorPanelEvent};
use crate::structured::{MarkdownEvent, StructuredDocument, StructuredEvent};

/// How long a side the other moved keeps from answering with a move of its
/// own: a programmatic scroll's events arrive after it.
const FOLLOW_QUIET: Duration = Duration::from_millis(160);

/// The single replacement turning `previous` into `next`: the shared prefix
/// and suffix stay put (`minimalTextChange`), on character boundaries.
fn minimal_change<'a>(previous: &str, next: &'a str) -> (std::ops::Range<usize>, &'a str) {
    let prefix = previous
        .char_indices()
        .zip(next.chars())
        .find(|((_, a), b)| a != b)
        .map_or_else(|| previous.len().min(next.len()), |((index, _), _)| index);
    // A prefix that ends inside a character of `next` cannot happen: the
    // characters before it are equal, so their lengths are too.
    let previous_rest = &previous[prefix..];
    let next_rest = &next[prefix..];
    let suffix = previous_rest
        .chars()
        .rev()
        .zip(next_rest.chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .sum::<usize>();
    let suffix = suffix.min(previous_rest.len()).min(next_rest.len());
    (
        prefix..previous.len() - suffix,
        &next[prefix..next.len() - suffix],
    )
}

impl EditorPanel {
    /// The visual editor over this Markdown file's text.
    pub(super) fn new_markdown_document(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<StructuredDocument> {
        let project = self.project.clone();
        let relative = self.relative.clone();
        let source = self.buffer.read(cx).text();
        let document =
            cx.new(|cx| StructuredDocument::markdown(&project, relative, source, window, cx));
        self._subscriptions
            .push(cx.subscribe_in(&document, window, Self::on_markdown_document));
        document
    }

    fn on_markdown_document(
        &mut self,
        document: &Entity<StructuredDocument>,
        event: &StructuredEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let StructuredEvent::Markdown(event) = event else {
            // Saving now and handing over before a close are every page's.
            self.on_structured(document.clone(), event, cx);
            return;
        };
        match event {
            MarkdownEvent::Edit { base, source } => {
                self.take_markdown_edit(document, base, source, cx)
            }
            MarkdownEvent::Undo => self
                .editor
                .update(cx, |editor, cx| editor.undo(&Undo, window, cx)),
            MarkdownEvent::Redo => self
                .editor
                .update(cx, |editor, cx| editor.redo(&Redo, window, cx)),
            MarkdownEvent::ViewInSource(offset) => self.view_in_source(*offset, window, cx),
            MarkdownEvent::OpenPath(path) => {
                cx.emit(EditorPanelEvent::OpenFile { path: path.clone() })
            }
            MarkdownEvent::Caret(line, column) => {
                let moved = self.cursor.0 != *line;
                self.cursor = (*line, *column);
                if moved {
                    cx.emit(EditorPanelEvent::CaretLine);
                }
                cx.notify();
            }
            MarkdownEvent::Scrolled(line) => self.follow_preview(*line, window, cx),
        }
    }

    /// The page's edit, made against `base`: applied as the minimal change
    /// while the buffer holds `base`, else refused.
    fn take_markdown_edit(
        &mut self,
        document: &Entity<StructuredDocument>,
        base: &str,
        source: &str,
        cx: &mut Context<Self>,
    ) {
        let current = self.buffer.read(cx).text();
        if current != base {
            document.update(cx, |document, cx| document.resend_source(current, cx));
            return;
        }
        let (range, insert) = minimal_change(base, source);
        let insert = insert.to_string();
        self.buffer.update(cx, |buffer, cx| {
            buffer.edit([(range, insert)], None, cx);
        });
    }

    /// Show the source, the caret at a UTF-16 `offset` of the file, centred.
    fn view_in_source(&mut self, offset: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.set_document_view(DocumentView::Source, window, cx);
        let snapshot = self.buffer.read(cx).snapshot();
        let offset = snapshot.clip_offset_utf16(OffsetUtf16(offset), Bias::Left);
        let caret = snapshot.offset_to_point(snapshot.offset_utf16_to_offset(offset));
        self.editor.update(cx, |editor, cx| {
            editor.change_selections(
                SelectionEffects::scroll(Autoscroll::center()),
                window,
                cx,
                |selections| selections.select_ranges([caret..caret]),
            );
        });
        window.focus(&self.editor.focus_handle(cx), cx);
    }

    /// Whether a jump in this file lands in its visual editor: Markdown's
    /// Preview shows nothing else.
    pub(super) fn jumps_in_preview(&self) -> Option<Entity<StructuredDocument>> {
        if self.document_view() != Some(DocumentView::Preview) {
            return None;
        }
        self.markdown_document().cloned()
    }

    /// Split: the preview's top line is now `line`; the source follows.
    fn follow_preview(&mut self, line: u32, window: &mut Window, cx: &mut Context<Self>) {
        if self.document_view() != Some(DocumentView::Split)
            || self
                .markdown_led
                .is_some_and(|(source_led, at)| source_led && at.elapsed() < FOLLOW_QUIET)
        {
            return;
        }
        self.markdown_led = Some((false, Instant::now()));
        self.editor.update(cx, |editor, cx| {
            let snapshot = editor.display_snapshot(cx);
            let row = Point::new(line.saturating_sub(1), 0)
                .to_display_point(&snapshot)
                .row()
                .0;
            let x = editor.scroll_position(cx).x;
            editor.set_scroll_position(point(x, row as f64), window, cx);
        });
    }

    /// Split: the source scrolled; the preview follows its top line, unless
    /// the source is following the preview.
    pub(super) fn markdown_source_scrolled(&mut self, cx: &mut Context<Self>) {
        if self.document_view() != Some(DocumentView::Split) {
            return;
        }
        let Some(document) = self.markdown_document().cloned() else {
            return;
        };
        if self
            .markdown_led
            .is_some_and(|(source_led, at)| !source_led && at.elapsed() < FOLLOW_QUIET)
        {
            return;
        }
        self.markdown_led = Some((true, Instant::now()));
        let line = self.editor.update(cx, |editor, cx| {
            let top = editor.scroll_position(cx).y.max(0.).floor() as u32;
            let snapshot = editor.display_snapshot(cx);
            editor::display_map::DisplayPoint::new(editor::display_map::DisplayRow(top), 0)
                .to_point(&snapshot)
                .row
                + 1
        });
        document.update(cx, |document, cx| document.follow_line(line, cx));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(previous: &str, next: &str) -> String {
        let (range, insert) = minimal_change(previous, next);
        let mut text = previous.to_string();
        text.replace_range(range, insert);
        text
    }

    #[test]
    fn an_edit_replaces_only_what_changed() {
        assert_eq!(
            minimal_change("# A\n\nbody\n", "# A\n\nbodies\n"),
            (8..9, "ies")
        );
        assert_eq!(minimal_change("abc", "abc"), (3..3, ""));
        assert_eq!(minimal_change("", "x"), (0..0, "x"));
        assert_eq!(minimal_change("aXa", "aa"), (1..2, ""));
        // A repeated letter: the prefix takes what it can, the suffix the rest.
        assert_eq!(minimal_change("aaa", "aaaa"), (3..3, "a"));
    }

    #[test]
    fn wide_characters_keep_their_boundaries() {
        for (previous, next) in [
            ("中文段落", "中文的段落"),
            ("é", "e\u{301}"),
            ("😀 smile", "😃 smile"),
            (
                "---\ntitle: 标题\n---\n正文",
                "---\ntitle: 标题\n---\n正文。",
            ),
        ] {
            assert_eq!(apply(previous, next), next, "{previous:?} → {next:?}");
        }
    }
}
