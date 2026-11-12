//! Completion sources for Zed's completion menu.
//!
//! The Tauri app gives CodeMirror's autocomplete a list of sources
//! (`src/editor/latex/latex-completions.ts`, `latex-command-completions.ts`):
//! each looks at the text before the caret and, when the caret is in its
//! kind of slot, answers with the range to replace and the options, filtered
//! and ordered by itself. A [`CompletionSource`] does the same here, and the
//! adapter hands every source's answer to Zed's menu through one
//! `editor::CompletionProvider`.
//!
//! Sources filter and order their own options, as the citation source must
//! (it matches titles as well as keys), so the provider turns Zed's own
//! filtering and sorting off and asks again on every keystroke. A picked
//! option replaces its range with `insert` and puts the caret `caret` bytes
//! into it, as a CodeMirror template puts it in the first empty `{}`.

use std::{cell::RefCell, ops::Range, rc::Rc, sync::Arc};

use anyhow::Result;
use editor::{CompletionProvider, Editor, SelectionEffects};
use gpui::{App, Context, Entity, SharedString, Task, Window};
use language::{Buffer, BufferSnapshot, CodeLabel, ToOffset as _};
use project::{
    Completion, CompletionDisplayOptions, CompletionResponse, CompletionSource as ZedSource,
};

/// How much text before the caret a source sees (the Tauri app's `textBefore`).
pub const TEXT_BEFORE: usize = 600;

/// What a source is asked.
pub struct CompletionQuery<'a> {
    pub text: &'a BufferSnapshot,
    /// The caret, a byte offset.
    pub offset: usize,
    /// Up to [`TEXT_BEFORE`] bytes before the caret, on a character boundary.
    pub before: &'a str,
}

impl CompletionQuery<'_> {
    /// The byte offset of `before`'s start.
    pub fn before_start(&self) -> usize {
        self.offset - self.before.len()
    }
}

/// What kind of thing an option is, for its icon.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CompletionKind {
    #[default]
    Command,
    Environment,
    Citation,
    Label,
    Package,
}

/// One option.
#[derive(Clone, Debug, PartialEq)]
pub struct CompletionItem {
    /// What the menu shows.
    pub label: SharedString,
    /// What replaces the list's range.
    pub insert: String,
    /// Where the caret goes in `insert`, in bytes; its end when `None`.
    pub caret: Option<usize>,
    /// Quiet text at the row's end.
    pub detail: Option<SharedString>,
    pub kind: CompletionKind,
    /// Open the menu again once it went in: a `\cite{}` picked from the
    /// command list lists the keys next, as the Tauri app's brace path does.
    pub reopen: bool,
}

/// A source's answer: the range its options replace, and the options.
#[derive(Clone, Debug, PartialEq)]
pub struct CompletionList {
    pub range: Range<usize>,
    pub items: Vec<CompletionItem>,
}

/// A source of completions.
pub trait CompletionSource {
    /// The options for the caret in `query`, if the caret is in this
    /// source's kind of slot.
    fn complete(&self, query: &CompletionQuery, cx: &App) -> Option<CompletionList>;
}

pub(crate) type Sources = Rc<RefCell<Vec<Rc<dyn CompletionSource>>>>;

/// The labels the menu was last given, in order.
pub(crate) type Offered = Rc<RefCell<Vec<SharedString>>>;

/// The text before `offset`, at most [`TEXT_BEFORE`] bytes, starting on a
/// character boundary.
pub(crate) fn text_before(text: &BufferSnapshot, offset: usize) -> String {
    let mut start = offset.saturating_sub(TEXT_BEFORE);
    start = text.clip_offset(start, language::Bias::Right);
    text.text_for_range(start..offset).collect()
}

/// Every source's options at `offset`, in source order.
pub(crate) fn collect(
    sources: &[Rc<dyn CompletionSource>],
    text: &BufferSnapshot,
    offset: usize,
    cx: &App,
) -> Vec<CompletionList> {
    let before = text_before(text, offset);
    let query = CompletionQuery {
        text,
        offset,
        before: &before,
    };
    sources
        .iter()
        .filter_map(|source| source.complete(&query, cx))
        .filter(|list| !list.items.is_empty())
        .collect()
}

/// The adapter's `editor::CompletionProvider`: the sources, in order.
pub(crate) struct Provider {
    pub sources: Sources,
    pub editor: gpui::WeakEntity<Editor>,
    pub offered: Offered,
}

impl Provider {
    fn icon(kind: CompletionKind) -> Option<SharedString> {
        match kind {
            // The book the Tauri app draws beside a citation (`citationIcon`).
            CompletionKind::Citation => Some("icons/book-open.svg".into()),
            _ => None,
        }
    }

    fn completion(
        &self,
        item: CompletionItem,
        range: Range<language::Anchor>,
        start: language::Anchor,
        buffer: &Entity<Buffer>,
    ) -> Completion {
        let label = CodeLabel::plain(item.label.to_string(), None);
        let caret = item.caret.filter(|caret| *caret < item.insert.len());
        let reopen = item.reopen;
        let confirm = (caret.is_some() || reopen).then(|| {
            let editor = self.editor.clone();
            let buffer = buffer.downgrade();
            let caret = caret.unwrap_or(item.insert.len());
            Arc::new(move |_, window: &mut Window, cx: &mut App| {
                place_caret(
                    editor.clone(),
                    buffer.clone(),
                    start,
                    caret,
                    reopen,
                    window,
                    cx,
                );
                false
            }) as Arc<dyn Send + Sync + Fn(_, &mut Window, &mut App) -> bool>
        });
        Completion {
            replace_range: range,
            new_text: item.insert,
            label,
            documentation: item
                .detail
                .map(project::lsp_store::CompletionDocumentation::SingleLine),
            source: ZedSource::Custom,
            icon_path: Self::icon(item.kind),
            icon_color: None,
            match_start: None,
            snippet_deduplication_key: None,
            insert_text_mode: None,
            confirm,
            group: None,
        }
    }
}

/// After a picked option went in at `start`, put the caret `caret` bytes in,
/// and open the menu again when `reopen`. The menu applies the option inside
/// the editor's own update, so this runs once that is over.
fn place_caret(
    editor: gpui::WeakEntity<Editor>,
    buffer: gpui::WeakEntity<Buffer>,
    start: language::Anchor,
    caret: usize,
    reopen: bool,
    window: &mut Window,
    cx: &mut App,
) {
    window.defer(cx, move |window, cx| {
        let (Some(editor), Some(buffer)) = (editor.upgrade(), buffer.upgrade()) else {
            return;
        };
        let snapshot = buffer.read(cx).snapshot();
        let target = (start.to_offset(&snapshot) + caret).min(snapshot.len());
        let point = snapshot.offset_to_point(target);
        editor.update(cx, |editor, cx| {
            editor.change_selections(SelectionEffects::default(), window, cx, |selections| {
                selections.select_ranges([point..point])
            });
            if reopen {
                editor.show_completions(&editor::actions::ShowCompletions, window, cx);
            }
        });
    });
}

impl CompletionProvider for Provider {
    fn completions(
        &self,
        buffer: &Entity<Buffer>,
        buffer_position: language::Anchor,
        _trigger: editor::CompletionContext,
        _window: &mut Window,
        cx: &mut Context<Editor>,
    ) -> Task<Result<Vec<CompletionResponse>>> {
        let snapshot = buffer.read(cx).snapshot();
        let offset = buffer_position.to_offset(&snapshot);
        let sources = self.sources.borrow().clone();
        let lists = collect(&sources, &snapshot, offset, cx);
        *self.offered.borrow_mut() = lists
            .iter()
            .flat_map(|list| list.items.iter().map(|item| item.label.clone()))
            .collect();
        let completions: Vec<Completion> = lists
            .into_iter()
            .flat_map(|list| {
                let start = snapshot.anchor_before(list.range.start);
                let range = start..snapshot.anchor_after(list.range.end.max(list.range.start));
                list.items
                    .into_iter()
                    .map(|item| self.completion(item, range.clone(), start, buffer))
                    .collect::<Vec<_>>()
            })
            .collect();
        Task::ready(Ok(vec![CompletionResponse {
            completions,
            display_options: CompletionDisplayOptions {
                dynamic_width: true,
            },
            // Sources filter by themselves, on every keystroke.
            is_incomplete: true,
        }]))
    }

    fn is_completion_trigger(
        &self,
        buffer: &Entity<Buffer>,
        position: language::Anchor,
        _text: &str,
        _trigger_in_words: bool,
        cx: &mut Context<Editor>,
    ) -> bool {
        let snapshot = buffer.read(cx).snapshot();
        let offset = position.to_offset(&snapshot);
        let sources = self.sources.borrow().clone();
        !collect(&sources, &snapshot, offset, cx).is_empty()
    }

    fn filter_completions(&self) -> bool {
        false
    }

    fn sort_completions(&self) -> bool {
        false
    }
}
