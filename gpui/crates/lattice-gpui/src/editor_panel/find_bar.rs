//! Find and replace in the open file: the Tauri app's CodeMirror search
//! panel (`search({ top: true })` with `compactSearchPanel`,
//! `src/editor/latex/latex-editor.ts` and `search-panel.ts`, styled by
//! `.cm-panel.cm-search` in `src/styles/editor-workspace.css`), over Zed's
//! editor search.
//!
//! ⌘F / Ctrl+F opens it above the text, its query seeded from a short
//! selection and selected; every match is marked as the query is typed, the
//! one the selection is as the current one, and the counter reads
//! `current/total`. Enter and ↓ (F3) go to the next match, Shift+Enter and ↑
//! (Shift+F3, ⇧⌘G) to the previous, each centred in the view; Select all
//! makes every match a selection; Replace replaces the selected match and
//! goes on, Replace all replaces every one; Escape or × closes it and gives
//! the keys back to the text. Match case (Aa), Regular expression (.*) and
//! Whole word (W) are its toggles, and outside a regular expression `\n`,
//! `\t` and `\\` read as the characters, as CodeMirror reads them.
//!
//! Zed's own buffer search bar is not used: its look is Zed's, and its
//! action registrar took ⌘F's `Deploy` before the panel's handler, so the bar
//! deployed with nothing drawn and the query took the keys.

mod query;
mod view;

use std::{cell::Cell, ops::Range, rc::Rc, sync::Arc};

use editor::{
    Anchor, AnchorRangeExt as _, Editor, EditorEvent, SelectionEffects, scroll::Autoscroll,
};
use gpui::{
    AppContext as _, Context, Entity, EventEmitter, Focusable as _, Subscription, Task, Window,
    actions,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::t;
use project::search::SearchQuery;
use util::paths::PathMatcher;
use workspace::searchable::{SearchToken, SearchableItem as _};

pub use query::FindOptions;
use query::{ReplaceStep, count_label, next_match, previous_match, replace_step, selected_match};

actions!(
    lattice_find,
    [
        /// The next match of the open find bar's query (F3).
        FindNext,
        /// The previous match (Shift+F3, ⇧⌘G).
        FindPrevious,
    ]
);

/// The keys the Tauri app's search keymap keeps beside the panel's own
/// Enter and Shift+Enter (`searchKeymap` less the app's keys,
/// `src/editor/editor-app-shortcuts.ts`): F3 and Shift+F3, and ⇧⌘G for the
/// previous match (⌘G is the app's Go to line). In the editor and in the bar.
pub fn bindings() -> Vec<gpui::KeyBinding> {
    use gpui::KeyBinding;
    let previous = if cfg!(target_os = "macos") {
        "cmd-shift-g"
    } else {
        "ctrl-shift-g"
    };
    vec![
        KeyBinding::new("f3", FindNext, Some("LatticeEditor")),
        KeyBinding::new("shift-f3", FindPrevious, Some("LatticeEditor")),
        KeyBinding::new(previous, FindPrevious, Some("LatticeEditor")),
    ]
}

/// What to do once the search under way answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Then {
    Next,
    Previous,
}

pub enum FindBarEvent {
    /// Closed, with the keys given back to the text.
    Closed,
}

pub struct FindBar {
    editor: Entity<Editor>,
    query: Entity<InputState>,
    replacement: Entity<InputState>,
    options: FindOptions,
    open: bool,
    /// The query's matches, as anchors and as the byte ranges they had when
    /// they were found.
    matches: Vec<Range<Anchor>>,
    offsets: Vec<Range<usize>>,
    search: Option<Arc<SearchQuery>>,
    searching: Option<Task<()>>,
    then: Option<Then>,
    /// The bar's last laid-out size: at 520px wide or more its two rows
    /// share one grid, as the panel's container query has them.
    size: Rc<Cell<Option<(f32, f32)>>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<FindBarEvent> for FindBar {}

impl FindBar {
    pub fn new(editor: Entity<Editor>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder(t!("Find")));
        let replacement = cx.new(|cx| InputState::new(window, cx).placeholder(t!("Replace")));
        let subscriptions =
            vec![
                cx.subscribe_in(&query, window, |this, _, event: &InputEvent, window, cx| {
                    match event {
                        InputEvent::Change => this.refresh(window, cx),
                        InputEvent::PressEnter { shift, .. } => this.step(*shift, window, cx),
                        _ => {}
                    }
                }),
                cx.subscribe_in(
                    &replacement,
                    window,
                    |this, _, event: &InputEvent, window, cx| {
                        if let InputEvent::PressEnter { .. } = event {
                            this.replace_next(window, cx);
                        }
                    },
                ),
                cx.subscribe_in(
                    &editor,
                    window,
                    |this, _, event: &EditorEvent, window, cx| {
                        match event {
                            // The matches follow the text, as CodeMirror's do.
                            EditorEvent::BufferEdited if this.open => this.refresh(window, cx),
                            // The current match and the counter follow the selection.
                            EditorEvent::SelectionsChanged { .. } if this.open => {
                                this.paint(window, cx);
                                cx.notify();
                            }
                            _ => {}
                        }
                    },
                ),
            ];
        Self {
            editor,
            query,
            replacement,
            options: FindOptions::default(),
            open: false,
            matches: Vec::new(),
            offsets: Vec::new(),
            search: None,
            searching: None,
            then: None,
            size: Rc::new(Cell::new(None)),
            _subscriptions: subscriptions,
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn query_text(&self, cx: &gpui::App) -> String {
        self.query.read(cx).value().to_string()
    }

    /// The bar's width and height as last laid out.
    pub fn laid_out(&self) -> Option<(f32, f32)> {
        self.size.get()
    }

    /// Whether its rows share one grid (at 520px wide or more).
    pub fn is_wide(&self) -> bool {
        view::is_wide(self.size.get())
    }

    pub fn options(&self) -> FindOptions {
        self.options
    }

    pub fn match_count(&self) -> usize {
        self.offsets.len()
    }

    /// Whether a search is still to answer.
    pub fn pending(&self) -> bool {
        self.searching.is_some()
    }

    /// The counter's text: `current/total`.
    pub fn count_label(&self, cx: &gpui::App) -> String {
        let (selection, head) = self.selection(cx);
        count_label(&self.offsets, selection, head)
    }

    pub fn query_input(&self) -> &Entity<InputState> {
        &self.query
    }

    pub fn replacement_input(&self) -> &Entity<InputState> {
        &self.replacement
    }

    /// ⌘F: open, or with the bar open take the keys back to its query, seeded
    /// from a short selection and selected whole.
    pub fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let selected = self.selected_text(cx);
        if let Some(seed) = query::seed(&selected) {
            self.query
                .update(cx, |input, cx| input.set_value(seed, window, cx));
        }
        self.open = true;
        self.query.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        self.refresh(window, cx);
        cx.notify();
    }

    /// Escape or ×: the marks go and the text has the keys again; the query
    /// stays for the next ⌘F and F3.
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        self.open = false;
        self.searching = None;
        self.then = None;
        self.editor
            .update(cx, |editor, cx| editor.clear_matches(window, cx));
        window.focus(&self.editor.focus_handle(cx), cx);
        cx.emit(FindBarEvent::Closed);
        cx.notify();
    }

    pub fn set_options(
        &mut self,
        options: FindOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if options != self.options {
            self.options = options;
            self.refresh(window, cx);
            cx.notify();
        }
    }

    /// Type `text` as the query (the scenario's way in).
    pub fn set_query(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = text.to_string();
        self.query
            .update(cx, |input, cx| input.set_value(text, window, cx));
        self.refresh(window, cx);
    }

    /// The next match (`back`: the previous), round the ends of the file. A
    /// step with the bar closed uses the last query, as F3 does in the Tauri
    /// app, and opens the bar when there is none.
    pub fn step(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        let then = if back { Then::Previous } else { Then::Next };
        if self.query_text(cx).is_empty() {
            if !self.open {
                self.open(window, cx);
            }
            return;
        }
        if self.searching.is_some() || (!self.open && self.search.is_none()) {
            self.then = Some(then);
            if self.searching.is_none() {
                self.refresh(window, cx);
            }
            return;
        }
        if !self.open {
            // The text may have changed since the bar closed.
            self.then = Some(then);
            self.refresh(window, cx);
            return;
        }
        self.go(then, window, cx);
    }

    fn go(&mut self, then: Then, window: &mut Window, cx: &mut Context<Self>) {
        let (selection, _) = self.selection(cx);
        let found = match then {
            Then::Next => next_match(&self.offsets, &selection),
            Then::Previous => previous_match(&self.offsets, &selection),
        };
        if let Some(ix) = found {
            self.select(ix, window, cx);
        }
    }

    /// Select match `ix`, unfolded and centred, as every jump in the editor
    /// centres its target (`centerMatch`).
    fn select(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(range) = self.matches.get(ix).cloned() else {
            return;
        };
        self.editor.update(cx, |editor, cx| {
            editor.unfold_ranges(std::slice::from_ref(&range), false, true, cx);
            editor.change_selections(
                SelectionEffects::scroll(Autoscroll::center()).from_search(true),
                window,
                cx,
                |selections| selections.select_anchor_ranges([range]),
            );
        });
        self.paint(window, cx);
        cx.notify();
    }

    /// Select all: every match a selection of its own.
    pub fn select_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.matches.is_empty() {
            return;
        }
        let matches = self.matches.clone();
        self.editor.update(cx, |editor, cx| {
            editor.select_matches(&matches, SearchToken::default(), window, cx)
        });
    }

    /// Replace: the selected match is replaced and the next one selected;
    /// with the selection on none, the next match is only selected.
    pub fn replace_next(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(search) = self.search_with_replacement(cx) else {
            return;
        };
        let (selection, _) = self.selection(cx);
        match replace_step(&self.offsets, &selection) {
            Some(ReplaceStep::Replace(ix)) => {
                let range = self.matches[ix].clone();
                // The edit searches again; the next match is selected then.
                self.then = Some(Then::Next);
                self.editor.update(cx, |editor, cx| {
                    editor.replace(&range, &search, SearchToken::default(), window, cx)
                });
            }
            Some(ReplaceStep::Select(ix)) => self.select(ix, window, cx),
            None => {}
        }
    }

    /// Replace all, as one edit the history undoes at once.
    pub fn replace_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(search) = self.search_with_replacement(cx) else {
            return;
        };
        let matches = self.matches.clone();
        self.editor.update(cx, |editor, cx| {
            editor.replace_all(
                &mut matches.iter(),
                &search,
                SearchToken::default(),
                window,
                cx,
            )
        });
    }

    fn search_with_replacement(&self, cx: &gpui::App) -> Option<SearchQuery> {
        let search = self.search.as_ref()?;
        let replacement = self.replacement.read(cx).value().to_string();
        let replacement = if self.options.regexp {
            query::regex_replacement(&replacement)
        } else {
            query::unquote(&replacement)
        };
        Some(search.as_ref().clone().with_replacement(replacement))
    }

    /// Match the query against the text as it is now.
    fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.query_text(cx);
        let Some(search) = build_query(&text, self.options) else {
            // An empty query, or a regular expression that does not parse,
            // matches nothing: `0/0`, as CodeMirror's invalid query.
            self.search = None;
            self.searching = None;
            self.matches.clear();
            self.offsets.clear();
            self.then = None;
            self.paint(window, cx);
            cx.notify();
            return;
        };
        let search = Arc::new(search);
        self.search = Some(search.clone());
        let found = self
            .editor
            .update(cx, |editor, cx| editor.find_matches(search, window, cx));
        self.searching = Some(cx.spawn_in(window, async move |this, cx| {
            let matches = found.await;
            this.update_in(cx, |this, window, cx| {
                this.searching = None;
                let snapshot = this.editor.read(cx).buffer().read(cx).snapshot(cx);
                this.offsets = matches
                    .iter()
                    .map(|range| {
                        let range = range.to_offset(&snapshot);
                        range.start.0..range.end.0
                    })
                    .collect();
                this.matches = matches;
                if let Some(then) = this.then.take() {
                    this.go(then, window, cx);
                }
                this.paint(window, cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Mark the matches in the text, the selected one as the current one;
    /// with the bar closed, none.
    fn paint(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open || self.matches.is_empty() {
            self.editor
                .update(cx, |editor, cx| editor.clear_matches(window, cx));
            return;
        }
        let (selection, _) = self.selection(cx);
        let current = selected_match(&self.offsets, &selection);
        let matches = self.matches.clone();
        self.editor.update(cx, |editor, cx| {
            editor.update_matches(&matches, current, SearchToken::default(), window, cx)
        });
    }

    /// The newest selection as a byte range, and its head.
    fn selection(&self, cx: &gpui::App) -> (Range<usize>, usize) {
        let editor = self.editor.read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        let selection = editor.selections.newest_anchor();
        let range = (selection.start..selection.end).to_offset(&snapshot);
        let head = editor::ToOffset::to_offset(&selection.head(), &snapshot);
        (range.start.0..range.end.0, head.0)
    }

    fn selected_text(&self, cx: &gpui::App) -> String {
        let editor = self.editor.read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        let selection = editor.selections.newest_anchor();
        snapshot
            .text_for_range(selection.start..selection.end)
            .collect()
    }
}

/// The query as Zed's search runs it, or `None` for one that matches
/// nothing.
fn build_query(text: &str, options: FindOptions) -> Option<SearchQuery> {
    if text.is_empty() {
        return None;
    }
    let built = if options.regexp {
        SearchQuery::regex(
            text,
            options.whole_word,
            options.match_case,
            false,
            false,
            PathMatcher::default(),
            PathMatcher::default(),
            false,
            None,
        )
    } else {
        SearchQuery::text(
            query::unquote(text),
            options.whole_word,
            options.match_case,
            false,
            PathMatcher::default(),
            PathMatcher::default(),
            false,
            None,
        )
    };
    built.ok()
}
