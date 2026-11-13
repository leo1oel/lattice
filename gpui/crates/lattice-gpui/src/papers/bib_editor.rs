//! A `.bib` file's visual form (`bib-visual-editor.tsx`): its references as
//! a searchable list, and the one in front as a form whose every field edits
//! the file in place.
//!
//! The form edits the source editor's own buffer: each change is a splice
//! into the text as it is at that moment, the entry found again by its key
//! (the list may be drawn from a copy a keystroke old), so untouched entries,
//! comments and macros never move and the editor's undo history records the
//! change like any other edit (⌘Z outside a field steps it back). A text the
//! parser cannot read whole is never edited here; the form says why and
//! offers the line that failed.
//!
//! The list draws only the rows in view (`uniform_list`), every row one
//! height, and parses a copy of the text off the main thread a moment after
//! typing in the source pauses, so the source beside it never waits.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyDownEvent,
    Subscription, Task, UniformListScrollHandle, Window,
};
use gpui_kit::component::input::{InputEvent, InputState};
use language::{Buffer, BufferEvent};
use lattice_core::bib_document::{self, BibEdit, BibEntry, BibParseError, BibParseReason};
use lattice_i18n::t;

use super::PapersPanel;
use crate::notices::{self, Notice, NoticeAction};

pub mod add;
mod detail;
mod edits;
mod list;
pub mod model;

use model::{BibFilter, BibSort, Row, Usages};

/// A pause in typing in the source beside the list before it reads the
/// text again.
const PARSE_SETTLE: Duration = Duration::from_millis(150);
/// The list's share of the width as the divider left it, shared by every
/// bibliography in the session (`BIB_LIST_RATIO_DEFAULT`, 0.44).
static LIST_RATIO: AtomicU32 = AtomicU32::new(0x3EE1_47AE);

pub(super) fn list_ratio() -> f32 {
    f32::from_bits(LIST_RATIO.load(Ordering::Relaxed))
}

fn set_list_ratio(ratio: f32) {
    LIST_RATIO.store(ratio.to_bits(), Ordering::Relaxed);
}

pub enum BibEditorEvent {
    /// Show the 1-based `line` of the project-relative `path` in its source.
    OpenLine { path: String, line: u32 },
    /// A reference was picked in the list: the source beside it shows it.
    Picked { line: u32 },
}

/// What a parse of the text found.
struct Parsed {
    text: String,
    rows: Vec<Row>,
    macros: HashMap<String, String>,
    error: Option<BibParseError>,
}

fn parse_rows(text: String) -> Parsed {
    match bib_document::parse(&text) {
        Ok(document) => {
            let rows = document
                .entries
                .iter()
                .enumerate()
                .map(|(index, entry)| Row {
                    summary: bib_document::summarize_entry(&text, entry, &document.macros),
                    entry: entry.clone(),
                    index,
                })
                .collect();
            Parsed {
                text,
                rows,
                macros: document.macros,
                error: None,
            }
        }
        Err(error) => Parsed {
            text,
            rows: Vec::new(),
            macros: HashMap::new(),
            error: Some(error),
        },
    }
}

/// Why the list cannot show a file that failed to parse
/// (`bibUnreadableReason`).
pub(super) fn unreadable_reason(error: &BibParseError) -> String {
    let line = error.line;
    match (error.reason, error.key.as_deref()) {
        (BibParseReason::MissingKey, _) => {
            t!("Line {line}: an entry has no citation key.", line = line)
        }
        (BibParseReason::Unclosed, Some(key)) => t!(
            "Line {line}: the entry “{key}” is never closed.",
            line = line,
            key = key
        ),
        (BibParseReason::Unclosed, None) => {
            t!("Line {line}: an entry is never closed.", line = line)
        }
        (BibParseReason::BadField, Some(key)) => t!(
            "Line {line}: a field of “{key}” could not be read.",
            line = line,
            key = key
        ),
        (BibParseReason::BadField, None) => {
            t!("Line {line}: a field could not be read.", line = line)
        }
    }
}

/// The last delete, for its notice's Undo.
struct Deleted {
    /// Which delete it was: an older notice's Undo finds it gone.
    id: u64,
    /// The text the delete left.
    text: String,
    removed: String,
    /// The references that followed and preceded it in the file, by key:
    /// once the text has moved on, it goes back beside them, never at an
    /// old offset that may now fall inside another entry.
    next: Option<String>,
    previous: Option<String>,
    key: String,
}

pub struct BibEditor {
    root: PathBuf,
    /// The file, from the project root.
    path: String,
    buffer: Entity<Buffer>,
    papers: Option<Entity<PapersPanel>>,
    pub(super) text: String,
    pub(super) rows: Vec<Row>,
    pub(super) macros: HashMap<String, String>,
    pub(super) error: Option<BibParseError>,
    pub(super) usages: Option<Usages>,
    usage_revision: Option<u64>,
    pub(super) query: Entity<InputState>,
    pub(super) filter: BibFilter,
    pub(super) sort: BibSort,
    /// The reference in front, by key: offsets move with every edit, keys
    /// do not.
    pub(super) selected: Option<String>,
    /// A pane too narrow for both shows the reference in place of the list.
    pub(super) detail_open: bool,
    /// The body's width, and where it starts in the window, as last laid
    /// out.
    pub(super) width: std::rc::Rc<std::cell::Cell<f32>>,
    pub(super) body_origin: std::rc::Rc<std::cell::Cell<f32>>,
    pub(super) resizing: bool,
    pub(super) scroll: UniformListScrollHandle,
    /// A key to bring into view once the list has it.
    pub(super) reveal: Option<String>,
    pub(super) detail: Option<detail::Detail>,
    pub(super) adding: Option<Entity<add::AddReference>>,
    deleted: Option<Deleted>,
    deletes: u64,
    /// A line the source moved to while the list was still drawn from an
    /// older text, followed once the parse catches up.
    follow: Option<u32>,
    /// The buffer's edits as counted, and the count when the text the rows
    /// were parsed from was read: they differ while a parse is due.
    edits: u64,
    parsed_edits: u64,
    pub(super) focus: FocusHandle,
    _parse: Option<Task<()>>,
    _usages: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<BibEditorEvent> for BibEditor {}

impl BibEditor {
    pub fn new(
        root: PathBuf,
        path: String,
        buffer: Entity<Buffer>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder(t!("Search references")));
        let mut subscriptions = vec![
            cx.subscribe(&buffer, |this, _, event: &BufferEvent, cx| {
                if matches!(event, BufferEvent::Edited { .. } | BufferEvent::Reloaded) {
                    this.edits += 1;
                    this.schedule_parse(PARSE_SETTLE, cx);
                }
            }),
            cx.subscribe_in(&query, window, |this, _, event, window, cx| match event {
                InputEvent::Change => {
                    this.scroll_to_top();
                    cx.notify()
                }
                InputEvent::PressEnter { .. } => window.focus(&this.focus, cx),
                _ => {}
            }),
        ];
        subscriptions.shrink_to_fit();
        let parsed = parse_rows(buffer.read(cx).text());
        let mut this = Self {
            root,
            path,
            buffer,
            papers: None,
            text: String::new(),
            rows: Vec::new(),
            macros: HashMap::new(),
            error: None,
            usages: None,
            usage_revision: None,
            query,
            filter: BibFilter::All,
            sort: BibSort::File,
            selected: None,
            detail_open: false,
            width: Default::default(),
            body_origin: Default::default(),
            resizing: false,
            scroll: UniformListScrollHandle::new(),
            reveal: None,
            detail: None,
            adding: None,
            deleted: None,
            deletes: 0,
            follow: None,
            edits: 0,
            parsed_edits: 0,
            focus: cx.focus_handle(),
            _parse: None,
            _usages: None,
            _subscriptions: subscriptions,
        };
        this.apply_parse(parsed, 0, cx);
        this.scan_usages(cx);
        this
    }

    /// The library the references open their papers from; its every new
    /// scan of the manuscript's citations is read here too.
    pub fn set_papers(&mut self, papers: Entity<PapersPanel>, cx: &mut Context<Self>) {
        let observe = cx.observe(&papers, |this, papers, cx| {
            let revision = papers.read(cx).usage_revision;
            if this.usage_revision != Some(revision) {
                this.usage_revision = Some(revision);
                this.scan_usages(cx);
            }
            cx.notify();
        });
        self._subscriptions.push(observe);
        self.usage_revision = Some(papers.read(cx).usage_revision);
        self.papers = Some(papers);
        cx.notify();
    }

    pub(super) fn papers(&self) -> Option<&Entity<PapersPanel>> {
        self.papers.as_ref()
    }

    /// The form's width as it was last laid out; zero before it is drawn.
    pub fn laid_out_width(&self) -> f32 {
        self.width.get()
    }

    /// The references' keys, in file order.
    pub fn keys(&self) -> Vec<String> {
        self.rows.iter().map(|row| row.entry.key.clone()).collect()
    }

    /// The reference in front, by key.
    pub fn selected_key(&self) -> Option<&str> {
        self.selected_row().map(|row| row.entry.key.as_str())
    }

    /// Bring `key` to the front, as a click on its row does.
    pub fn pick(&mut self, key: &str, cx: &mut Context<Self>) {
        self.select(key.to_string(), true, cx);
    }

    /// Write `value` into the field `name` of `key`, as its box does on
    /// leaving it (delimiters kept); false when nothing was written.
    pub fn set_field(
        &mut self,
        key: &str,
        name: &str,
        value: &str,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(row) = self.rows.iter().find(|row| row.entry.key == key) else {
            return false;
        };
        let index = row.index;
        let Some(field) = row
            .entry
            .fields
            .iter()
            .position(|field| field.name.eq_ignore_ascii_case(name))
        else {
            return false;
        };
        let raw = self
            .text
            .get(row.entry.fields[field].value_from..row.entry.fields[field].value_to)
            .unwrap_or("");
        let (_, style) = bib_document::editable_value(raw);
        let Some(raw) = bib_document::encode_value(value, style, &self.macros) else {
            return false;
        };
        let name = name.to_string();
        self.edit_entry(
            key,
            index,
            |_, entry| {
                let field = entry
                    .fields
                    .get(field)
                    .filter(|field| field.name.eq_ignore_ascii_case(&name))?;
                Some(bib_document::replace_value_edit(field, &raw))
            },
            cx,
        )
        .is_some()
    }

    fn schedule_parse(&mut self, delay: Duration, cx: &mut Context<Self>) {
        self._parse = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let Ok((text, edits)) =
                this.update(cx, |this, cx| (this.buffer.read(cx).text(), this.edits))
            else {
                return;
            };
            let parsed = cx.background_spawn(async move { parse_rows(text) }).await;
            this.update(cx, |this, cx| this.apply_parse(parsed, edits, cx))
                .ok();
        }));
    }

    /// `edits`: the buffer's edit count when `parsed`'s text was read.
    fn apply_parse(&mut self, parsed: Parsed, edits: u64, cx: &mut Context<Self>) {
        self.parsed_edits = edits;
        if parsed.text != self.text || self.error.is_some() || parsed.error.is_some() {
            self.text = parsed.text;
            self.rows = parsed.rows;
            self.macros = parsed.macros;
            self.error = parsed.error;
            cx.notify();
        }
        if let Some(line) = self.follow.take() {
            self.follow_line(line, cx);
        }
    }

    /// Where the manuscript cites each key, read again.
    fn scan_usages(&mut self, cx: &mut Context<Self>) {
        let root = self.root.clone();
        let scan =
            cx.background_spawn(async move { lattice_core::project::citation_usages(&root) });
        self._usages = Some(cx.spawn(async move |this, cx| {
            let usages = scan.await;
            this.update(cx, |this, cx| {
                // Without the scan nothing is flagged unused, rather than
                // everything.
                this.usages = usages.ok().map(Usages::group);
                cx.notify();
            })
            .ok();
        }));
    }

    /// The row of the reference in front, by its key (any case, as BibTeX
    /// reads keys).
    pub(super) fn selected_row(&self) -> Option<&Row> {
        let key = self.selected.as_deref()?;
        self.rows
            .iter()
            .find(|row| row.entry.key == key)
            .or_else(|| {
                self.rows
                    .iter()
                    .find(|row| row.entry.key.eq_ignore_ascii_case(key))
            })
    }

    /// The rows the list shows, in its order.
    pub(super) fn shown(&self, cx: &App) -> Vec<usize> {
        let query = self.query.read(cx).value();
        model::shown(
            &self.rows,
            &query,
            self.filter,
            self.sort,
            self.usages.as_ref(),
        )
        .into_iter()
        .map(|row| row.index)
        .collect()
    }

    pub(super) fn select(&mut self, key: String, open: bool, cx: &mut Context<Self>) {
        if let Some(row) = self.rows.iter().find(|row| row.entry.key == key) {
            cx.emit(BibEditorEvent::Picked {
                line: row.entry.line as u32,
            });
        }
        self.selected = Some(key);
        if open {
            self.detail_open = true;
        }
        cx.notify();
    }

    /// The source beside the list moved to `line`: the list follows the
    /// reference under it (`use-bib-source-sync.ts`).
    pub fn follow_line(&mut self, line: u32, cx: &mut Context<Self>) {
        // The rows' offsets are the parsed text's: the line means nothing in
        // them until the parse of the buffer as it is now lands.
        if self.parsed_edits != self.edits {
            self.follow = Some(line);
            return;
        }
        let offset = line_offset(&self.text, line);
        let Some(row) = self
            .rows
            .iter()
            .find(|row| row.entry.from <= offset && offset < row.entry.to.max(row.entry.from + 1))
        else {
            return;
        };
        if self.selected.as_deref() != Some(row.entry.key.as_str()) {
            self.selected = Some(row.entry.key.clone());
            self.reveal = self.selected.clone();
            cx.notify();
        }
    }

    pub(super) fn set_filter(&mut self, filter: BibFilter, cx: &mut Context<Self>) {
        self.filter = filter;
        self.scroll_to_top();
        cx.notify();
    }

    pub(super) fn set_sort(&mut self, sort: BibSort, cx: &mut Context<Self>) {
        self.sort = sort;
        cx.notify();
    }

    pub(super) fn show_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.query
            .update(cx, |query, cx| query.set_value("", window, cx));
        self.filter = BibFilter::All;
        cx.notify();
    }

    fn scroll_to_top(&self) {
        self.scroll.scroll_to_item(0, gpui::ScrollStrategy::Top);
    }

    /// Make `edit` of the reference `key` against the buffer as it is now:
    /// the entry is found again (where it was, else by its key) and the
    /// splice measured on that. The list reads the result at once.
    pub(super) fn edit_entry(
        &mut self,
        key: &str,
        index: usize,
        edit: impl FnOnce(&str, &BibEntry) -> Option<BibEdit>,
        cx: &mut Context<Self>,
    ) -> Option<(String, BibEdit)> {
        let base = self.buffer.read(cx).text();
        let document = bib_document::parse(&base).ok()?;
        let entry = document
            .entries
            .get(index)
            .filter(|entry| entry.key == key)
            .or_else(|| document.entries.iter().find(|entry| entry.key == key))?;
        let change = edit(&base, entry)?;
        if change.from == change.to && change.insert.is_empty() {
            return None;
        }
        self.splice(&change, cx);
        Some((base, change))
    }

    fn splice(&mut self, change: &BibEdit, cx: &mut Context<Self>) {
        let insert = change.insert.clone();
        let range = change.from..change.to;
        self.buffer
            .update(cx, |buffer, cx| buffer.edit([(range, insert)], None, cx));
        let text = self.buffer.read(cx).text();
        self.apply_parse(parse_rows(text), self.edits, cx);
    }

    /// Replace the whole text with `next`, computed from `base`; refused
    /// when the text has moved on since.
    pub(super) fn replace_text(
        &mut self,
        next: String,
        base: &str,
        cx: &mut Context<Self>,
    ) -> bool {
        let current = self.buffer.read(cx).text();
        if current != base {
            return false;
        }
        let change = BibEdit {
            from: 0,
            to: current.len(),
            insert: next,
        };
        self.splice(&change, cx);
        true
    }

    pub(super) fn delete(&mut self, key: String, index: usize, cx: &mut Context<Self>) {
        // The next reference down takes its place, else the one above: read
        // from the list before the delete parses the text again.
        let shown = self.shown(cx);
        let neighbour = shown
            .iter()
            .position(|row| *row == index)
            .and_then(|at| {
                shown
                    .get(at + 1)
                    .or_else(|| at.checked_sub(1).and_then(|at| shown.get(at)))
            })
            .and_then(|index| {
                self.rows
                    .iter()
                    .find(|row| row.index == *index && row.entry.key != key)
            })
            .map(|row| row.entry.key.clone());
        let Some((base, change)) = self.edit_entry(
            &key,
            index,
            |source, entry| Some(bib_document::delete_entry_edit(source, entry)),
            cx,
        ) else {
            return;
        };
        self.selected = neighbour;
        self.deletes += 1;
        let id = self.deletes;
        let next = self
            .rows
            .iter()
            .find(|row| row.entry.from >= change.from)
            .map(|row| row.entry.key.clone());
        let previous = self
            .rows
            .iter()
            .rev()
            .find(|row| row.entry.to <= change.from)
            .map(|row| row.entry.key.clone());
        self.deleted = Some(Deleted {
            id,
            text: self.text.clone(),
            removed: base[change.from..change.to].to_string(),
            next,
            previous,
            key: key.clone(),
        });
        let cited = self
            .usages
            .as_ref()
            .map_or(0, |usages| usages.of(&key).len());
        let view = cx.entity().downgrade();
        let mut notice = Notice::new(
            lattice_ui::components::ToastLevel::Success,
            t!("Deleted “{key}”", key = key),
        )
        .key(format!("bib-delete:{}:{key}", self.path))
        .action(NoticeAction::new(t!("Undo"), move |_, cx| {
            view.update(cx, |this, cx| this.undo_delete(id, cx)).ok();
        }));
        if cited > 0 {
            notice = notice.detail(t!(
                "It is still cited in the manuscript ({cited}).",
                cited = cited
            ));
        }
        notices::show(notice, cx);
    }

    fn undo_delete(&mut self, id: u64, cx: &mut Context<Self>) {
        if self.deleted.as_ref().is_none_or(|deleted| deleted.id != id) {
            return;
        }
        let Some(deleted) = self.deleted.take() else {
            return;
        };
        let current = self.buffer.read(cx).text();
        // Nothing changed since: step the history back, so redo still works.
        if current == deleted.text {
            self.buffer.update(cx, |buffer, cx| buffer.undo(cx));
        } else {
            let Some(at) = restore_at(&current, &deleted) else {
                notices::error(
                    t!("Could not restore “{key}”", key = deleted.key),
                    t!("The references around it changed since it was deleted."),
                    cx,
                );
                return;
            };
            self.splice(
                &BibEdit {
                    from: at,
                    to: at,
                    insert: deleted.removed,
                },
                cx,
            );
        }
        let text = self.buffer.read(cx).text();
        self.apply_parse(parse_rows(text), self.edits, cx);
        self.selected = Some(deleted.key.clone());
        self.reveal = Some(deleted.key);
        self.detail_open = true;
        cx.notify();
    }

    pub(super) fn open_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity().downgrade();
        let sheet = cx.new(|cx| add::AddReference::new(add::AddTarget::Bib(view), window, cx));
        sheet.update(cx, |sheet, cx| sheet.focus_lookup(window, cx));
        self.adding = Some(sheet);
        cx.notify();
    }

    /// Append `entry` (keyed `key`) to the file, and bring it to the front.
    pub(super) fn add_entry(
        &mut self,
        entry: &str,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let base = self.buffer.read(cx).text();
        let taken: Vec<String> = self.rows.iter().map(|row| row.entry.key.clone()).collect();
        let next = model::append_entry(&base, entry, key, &taken)?;
        if !self.replace_text(next, &base, cx) {
            return Err(t!(
                "The bibliography changed while resolving the citation. Retry the import."
            )
            .into());
        }
        self.show_all(window, cx);
        window.focus(&self.focus, cx);
        self.selected = Some(key.to_string());
        self.reveal = Some(key.to_string());
        self.detail_open = true;
        self.adding = None;
        cx.notify();
        Ok(())
    }

    pub(super) fn close_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.adding = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    pub(super) fn open_line(&mut self, path: String, line: u32, cx: &mut Context<Self>) {
        cx.emit(BibEditorEvent::OpenLine { path, line });
    }

    /// The reference's paper: read it, or download it first, as the Papers
    /// list does.
    pub(super) fn open_paper(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(papers), Some(row)) = (
            self.papers.clone(),
            self.rows.iter().find(|row| row.entry.key == key),
        ) else {
            return;
        };
        let (paper, state) = {
            let library = papers.read(cx);
            model::entry_paper(&library.papers, key, &row.summary, &library.fetching.states)
        };
        if let (Some(paper), model::PaperState::Open | model::PaperState::Download) = (paper, state)
        {
            papers.update(cx, |papers, cx| papers.activate(&paper, None, window, cx));
        }
    }

    pub(super) fn set_ratio_from(&mut self, list_width: f32, cx: &mut Context<Self>) {
        let tracks = self.width.get() - 1.;
        if tracks <= 0. {
            return;
        }
        let max = (tracks - list::DETAIL_MIN_WIDTH).max(list::LIST_MIN_WIDTH);
        set_list_ratio(list_width.clamp(list::LIST_MIN_WIDTH, max) / tracks);
        cx.notify();
    }

    pub(super) fn reset_ratio(&mut self, cx: &mut Context<Self>) {
        set_list_ratio(0.44);
        cx.notify();
    }

    /// The list's keys: the arrows move through it, Enter opens the
    /// reference, Delete removes it; ⌘Z steps the file's history outside a
    /// field.
    pub(super) fn key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.focus.is_focused(window) {
            return;
        }
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        if (modifiers.platform || modifiers.control) && !modifiers.alt && keystroke.key == "z" {
            self.buffer.update(cx, |buffer, cx| {
                if modifiers.shift {
                    buffer.redo(cx);
                } else {
                    buffer.undo(cx);
                }
            });
            cx.stop_propagation();
            return;
        }
        let shown = self.shown(cx);
        if shown.is_empty() {
            return;
        }
        let at = self
            .selected_row()
            .and_then(|row| shown.iter().position(|index| *index == row.index));
        let target = match keystroke.key.as_str() {
            "down" => Some(at.map_or(0, |at| (at + 1).min(shown.len() - 1))),
            "up" => Some(at.map_or(0, |at| at.saturating_sub(1))),
            "pagedown" => Some(at.map_or(0, |at| (at + 10).min(shown.len() - 1))),
            "pageup" => Some(at.map_or(0, |at| at.saturating_sub(10))),
            "home" => Some(0),
            "end" => Some(shown.len() - 1),
            "enter" => {
                if at.is_some() {
                    self.detail_open = true;
                    cx.notify();
                }
                None
            }
            "delete" | "backspace" => {
                if let Some(row) = self.selected_row() {
                    let (key, index) = (row.entry.key.clone(), row.index);
                    self.delete(key, index, cx);
                }
                None
            }
            _ => return,
        };
        cx.stop_propagation();
        if let Some(target) = target
            && let Some(row) = self.rows.iter().find(|row| row.index == shown[target])
        {
            let key = row.entry.key.clone();
            self.select(key, false, cx);
            self.scroll
                .scroll_to_item(target, gpui::ScrollStrategy::Nearest);
        }
    }
}

/// Where a deleted reference goes back into `current`, a text edited since
/// the delete: before the reference that followed it, else after the line
/// of the one that preceded it, else at the end when it was the only one.
/// None when those are gone, or the text would not read whole with it back.
fn restore_at(current: &str, deleted: &Deleted) -> Option<usize> {
    let document = bib_document::parse(current).ok()?;
    let find = |key: &Option<String>| {
        let key = key.as_deref()?;
        document.entries.iter().find(|entry| entry.key == key)
    };
    let at = if let Some(next) = find(&deleted.next) {
        if deleted.removed.ends_with('\n') {
            current[..next.from].rfind('\n').map_or(0, |at| at + 1)
        } else {
            next.from
        }
    } else if let Some(previous) = find(&deleted.previous) {
        current[previous.to..]
            .find('\n')
            .map_or(current.len(), |at| previous.to + at + 1)
    } else if deleted.next.is_none() && deleted.previous.is_none() {
        current.len()
    } else {
        return None;
    };
    let mut restored = current.to_string();
    restored.insert_str(at, &deleted.removed);
    bib_document::parse(&restored)
        .ok()?
        .entries
        .iter()
        .any(|entry| entry.key == deleted.key)
        .then_some(at)
}

/// The byte offset of the start of the 1-based `line` in `text`.
fn line_offset(text: &str, line: u32) -> usize {
    if line <= 1 {
        return 0;
    }
    text.match_indices('\n')
        .nth(line as usize - 2)
        .map_or(text.len(), |(at, _)| at + 1)
}

impl Focusable for BibEditor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
