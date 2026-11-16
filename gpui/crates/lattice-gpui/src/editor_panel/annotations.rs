//! Local annotations in the source editor, as the Tauri app's
//! `editor-comments.ts` and `annotation-composer.tsx` draw them:
//!
//! - each open note's passage as an amber highlighter stroke (blue while the
//!   agent's proposal waits, violet while its question does), its tint with
//!   a rule along its bottom (`comment-marks.css`);
//! - its numbered pin in the gutter, on the line its passage starts, over
//!   the fold column (several on a line show the first, ringed); a click on
//!   the pin opens the note in the Annotations panel;
//! - the comment card over a passage the pointer rests on, with Resolve and
//!   Reply;
//! - the composer for a new note on the selection: the quote with where it
//!   is, a line for what should change, the intent chips, and Save (⌘↵),
//!   pinned beside the passage as the editor scrolls. Esc or a click outside
//!   closes it; a note with words in it is offered back ("Note discarded",
//!   Undo), in the file it was written on.
//!
//! A note finds its passage again after edits by its quote and context
//! (`model::resolve_anchor`); the marks are set again after a pause in
//! typing, and the adapter keeps them on their text in between.

use std::{cell::Cell, ops::Range, rc::Rc, time::Duration};

use editor::ToOffset as _;
use gpui::{
    App, AppContext as _, Bounds, Context, Entity, Focusable as _, Pixels, Point, SharedString,
    Subscription, Task, Window, px,
};
use gpui_kit::component::input::{InputEvent, TextareaState};
use language::ToOffset as _;
use language::{Anchor, Point as BufferPoint};
use lattice_core::project::EditorComment;
use lattice_editor::{
    decorations::{Highlight, Mark, MarkStyle, Underline},
    gutter::{GutterMark, GutterShape},
    hover::{HoverProvider, HoverTarget},
};
use lattice_i18n::t;
use lattice_ui::ActiveLattice as _;

use super::{EditorPanel, EditorPanelEvent};

mod composer;
use crate::annotations::{
    AnnotationRequest,
    card::{self, CardEvent, GUTTER_PIN},
    colors,
    model::{self, Intent, Status},
    store,
};

const MARKS: &str = "annotations";
const RULES: &str = "annotation-rules";
const DRAFT: &str = "annotation-draft";
pub(crate) const PINS: &str = "annotation-pins";
/// How long after the last keystroke the notes are placed again.
const SETTLE: Duration = Duration::from_millis(300);

/// What the hover cards read: each note on the file and its passage.
type Placed = Rc<std::cell::RefCell<Vec<(Range<usize>, EditorComment)>>>;

#[derive(Default)]
pub(super) struct AnnotationLayer {
    placed: Placed,
    /// Each pin's row and the notes it stands for, by number.
    pins: Vec<(u32, Vec<String>)>,
    provider: bool,
    draft: Option<Draft>,
    /// How many notes have been opened, which numbers each draft.
    drafts: u64,
    /// The source view's bounds as last drawn, which the composer is placed
    /// in.
    view: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The composer's height as last drawn.
    height: Rc<Cell<Pixels>>,
    _store: Option<Subscription>,
    _settle: Option<Task<()>>,
}

/// A note being written on a selection, before it is saved.
struct Draft {
    id: u64,
    range: Range<Anchor>,
    quote: String,
    prefix: String,
    suffix: String,
    /// The 1-based line the passage starts on.
    line: u32,
    field: Entity<TextareaState>,
    intent: Option<Intent>,
    error: Option<SharedString>,
    /// Which side of its passage it opened on, kept so scrolling cannot make
    /// it jump across the text.
    above: Option<bool>,
    _field: Subscription,
}

/// A discarded note, for Undo: what it said, and its passage.
#[derive(Clone)]
pub(crate) struct Discarded {
    path: String,
    from: u32,
    to: u32,
    quote: String,
    prefix: String,
    suffix: String,
    body: String,
    intent: Option<Intent>,
}

impl EditorPanel {
    /// Read the project's annotations and follow them.
    pub(super) fn attach_annotations(&mut self, cx: &mut Context<Self>) {
        let store = store::store(cx);
        let root = self.project_root(cx);
        store.update(cx, |store, cx| store.ensure(&root, cx));
        self.annotations._store =
            Some(cx.observe(&store, |this, _, cx| this.place_annotations(cx)));
        self.place_annotations(cx);
    }

    /// Place the notes again once typing pauses.
    pub(super) fn annotations_edited(&mut self, cx: &mut Context<Self>) {
        let root = self.project_root(cx);
        let has_notes = store::try_store(cx).is_some_and(|store| {
            store
                .read(cx)
                .annotations(&root)
                .into_iter()
                .any(|comment| comment.path == self.relative && !comment.resolved)
        });
        if !has_notes && self.annotations.draft.is_none() {
            return;
        }
        self.annotations._settle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SETTLE).await;
            this.update(cx, |this, cx| this.place_annotations(cx)).ok();
        }));
    }

    /// Mark each open note on this file, pin it in the gutter and give its
    /// passage its card.
    fn place_annotations(&mut self, cx: &mut Context<Self>) {
        let root = self.project_root(cx);
        let Some(store) = store::try_store(cx) else {
            return;
        };
        let notes: Vec<EditorComment> = store
            .read(cx)
            .annotations(&root)
            .into_iter()
            .filter(|comment| comment.path == self.relative && !comment.resolved)
            .cloned()
            .collect();
        let text = self.buffer.read(cx).text();
        let mut placed: Vec<(Range<usize>, EditorComment)> = notes
            .into_iter()
            .filter_map(|comment| Some((model::anchor_of(&text, &comment)?, comment)))
            .collect();
        placed.sort_by_key(|(range, comment)| (range.start, range.end, comment.number));
        let palette = cx.palette().clone();
        let mut highlights = Vec::new();
        let mut rules = Vec::new();
        for (range, comment) in &placed {
            let mark = colors::mark(Status::of(comment), &palette);
            highlights.push(Highlight {
                range: range.clone(),
                color: mark.tint,
            });
            rules.push(Mark {
                range: range.clone(),
                style: MarkStyle {
                    underline: Some(Underline {
                        color: mark.rule,
                        wavy: false,
                        thickness: px(1.5),
                    }),
                    ..MarkStyle::default()
                },
            });
        }
        // One pin per line, for the notes whose passages start there.
        let mut by_line: Vec<(u32, Vec<&EditorComment>)> = Vec::new();
        for (range, comment) in &placed {
            let row = text[..range.start].matches('\n').count() as u32;
            match by_line.iter_mut().find(|(line, _)| *line == row) {
                Some((_, notes)) => notes.push(comment),
                None => by_line.push((row, vec![comment])),
            }
        }
        let mut pins = Vec::new();
        let mut marks = Vec::new();
        for (row, mut notes) in by_line {
            notes.sort_by_key(|comment| comment.number);
            let first = notes[0];
            let status = Status::of(first);
            marks.push(GutterMark {
                line: row,
                color: colors::ink(status, &palette),
                shape: GutterShape::Pin {
                    label: first.number.to_string().into(),
                    ink: colors::pin_text(&palette),
                    more: notes.len() > 1,
                    size: px(GUTTER_PIN),
                },
                hover: None,
            });
            pins.push((
                row,
                notes.iter().map(|comment| comment.id.clone()).collect(),
            ));
        }
        self.annotations.pins = pins;
        *self.annotations.placed.borrow_mut() = placed;
        if !self.annotations.provider {
            self.annotations.provider = true;
            let provider = NoteCards {
                placed: self.annotations.placed.clone(),
                panel: cx.weak_entity(),
            };
            self.lattice.update(cx, |lattice, _| {
                lattice.add_hover_provider(Rc::new(provider))
            });
        }
        let draft = self.draft_highlight(&text, cx);
        self.lattice.update(cx, |lattice, cx| {
            lattice.set_highlights(MARKS, highlights, cx);
            lattice.set_marks(RULES, rules, cx);
            lattice.set_gutter_marks(PINS, marks, cx);
            lattice.set_marks(DRAFT, draft, cx);
        });
    }

    /// The draft's passage, marked as the Tauri app's `.editor-comment-draft`:
    /// the accent's soft wash over a 2px rule in the accent.
    fn draft_highlight(&self, _text: &str, cx: &App) -> Vec<Mark> {
        let Some(draft) = &self.annotations.draft else {
            return Vec::new();
        };
        let snapshot = self.buffer.read(cx).snapshot();
        let range = draft.range.start.to_offset(&snapshot)..draft.range.end.to_offset(&snapshot);
        if range.is_empty() {
            return Vec::new();
        }
        let palette = cx.palette();
        vec![Mark {
            range,
            style: MarkStyle {
                background: Some(palette.accent_soft),
                underline: Some(Underline {
                    color: palette.accent,
                    wavy: false,
                    thickness: px(2.),
                }),
                ..MarkStyle::default()
            },
        }]
    }

    /// The notes placed on this file, for scripted checks: each one's id,
    /// number and passage.
    pub fn placed_annotations(&self) -> Vec<(String, u32, Range<usize>)> {
        self.annotations
            .placed
            .borrow()
            .iter()
            .map(|(range, comment)| (comment.id.clone(), comment.number, range.clone()))
            .collect()
    }

    /// The selection, as bytes of the buffer; none when nothing is selected.
    fn selected_range(&self, cx: &App) -> Option<Range<usize>> {
        let editor = self.editor.read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        let selection = editor.selections.newest_anchor();
        let (start, end) = (
            selection.start.to_offset(&snapshot).0,
            selection.end.to_offset(&snapshot).0,
        );
        (start != end).then(|| start.min(end)..start.max(end))
    }

    /// Open the composer on the selection (the selection toolbar's Annotate,
    /// the palette's Annotate selection). Returns whether it opened.
    pub fn annotate_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(range) = self.selected_range(cx) else {
            return false;
        };
        let text = self.buffer.read(cx).text();
        let quote = text[range.clone()].to_string();
        if quote.trim().is_empty() {
            return false;
        }
        let (prefix, suffix) = model::context(&text, range.start, range.end);
        let units = model::Utf16::new(&text);
        self.open_draft(
            Discarded {
                path: self.relative.clone(),
                from: units.to_units(range.start) as u32,
                to: units.to_units(range.end) as u32,
                quote,
                prefix,
                suffix,
                body: String::new(),
                intent: None,
            },
            window,
            cx,
        )
    }

    /// Open a note on its passage, found again in the buffer.
    fn open_draft(&mut self, note: Discarded, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let text = self.buffer.read(cx).text();
        let Some(range) = model::resolve_anchor(
            &text,
            note.from,
            note.to,
            &note.quote,
            &note.prefix,
            &note.suffix,
        ) else {
            return false;
        };
        let snapshot = self.buffer.read(cx).snapshot();
        let anchors = snapshot.anchor_before(range.start)..snapshot.anchor_after(range.end);
        let line = text[..range.start].matches('\n').count() as u32 + 1;
        let field = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(t!("What should change here?"))
                .auto_grow(2, 8)
                .default_value(note.body.clone())
        });
        field.update(cx, |field, cx| field.focus(window, cx));
        let subscription =
            cx.subscribe_in(&field, window, |this, _, event, window, cx| match event {
                // ⌘↵ saves; ⇧⌘↵ saves and asks the agent about the note.
                InputEvent::PressEnter {
                    secondary: true, ..
                } => this.save_note(window.modifiers().shift, window, cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            });
        self.annotations.drafts += 1;
        self.annotations.draft = Some(Draft {
            id: self.annotations.drafts,
            range: anchors,
            quote: note.quote,
            prefix: note.prefix,
            suffix: note.suffix,
            line,
            field,
            intent: note.intent,
            error: None,
            above: None,
            _field: subscription,
        });
        self.place_annotations(cx);
        cx.notify();
        true
    }

    /// Whether a note is being written.
    pub fn composing_annotation(&self) -> bool {
        self.annotations.draft.is_some()
    }

    /// Save the note being written: a new annotation on its passage, or,
    /// when the passage has gone, why not, on the note.
    pub fn save_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.save_note(false, window, cx);
    }

    /// Save the draft as a note; with `revise`, ask the agent about it.
    pub(in crate::editor_panel) fn save_note(
        &mut self,
        revise: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(draft) = &self.annotations.draft else {
            return;
        };
        let body = draft.field.read(cx).value().to_string();
        if body.trim().is_empty() && draft.intent.is_none() {
            return;
        }
        let snapshot = self.buffer.read(cx).snapshot();
        let range = draft.range.start.to_offset(&snapshot)..draft.range.end.to_offset(&snapshot);
        let text = self.buffer.read(cx).text();
        let root = self.project_root(cx);
        let author = store::author(&root, cx);
        let note = (text.get(range.clone()) == Some(draft.quote.as_str()))
            .then(|| {
                model::new_note(
                    &self.relative,
                    &text,
                    range.start,
                    range.end,
                    &body,
                    draft.intent,
                    &author,
                )
            })
            .flatten();
        let Some(note) = note else {
            if let Some(draft) = &mut self.annotations.draft {
                draft.error = Some(
                    t!("The selected text changed. Select it again before commenting.").into(),
                );
            }
            cx.notify();
            return;
        };
        let store = store::store(cx);
        let added = store.update(cx, |store, cx| store.add(&root, note, cx));
        if let Some(id) = added {
            self.annotations.draft = None;
            self.place_annotations(cx);
            window.focus(&self.editor.focus_handle(cx), cx);
            cx.emit(EditorPanelEvent::Annotation(AnnotationRequest::Created(
                id.clone(),
            )));
            if revise {
                cx.emit(EditorPanelEvent::Annotation(AnnotationRequest::Revise(id)));
            }
        }
        cx.notify();
    }

    /// Esc or a click outside closed the note. A click outside goes on to do
    /// what it does there, so the editor does not take focus back from it. A
    /// note with words in it is offered back, in the file it was written on.
    pub fn dismiss_draft(&mut self, outside: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.annotations.draft.take() else {
            return;
        };
        self.place_annotations(cx);
        if !outside {
            window.focus(&self.editor.focus_handle(cx), cx);
        }
        cx.notify();
        let body = draft.field.read(cx).value().to_string();
        if body.trim().is_empty() {
            return;
        }
        let text = self.buffer.read(cx).text();
        let snapshot = self.buffer.read(cx).snapshot();
        let range = draft.range.start.to_offset(&snapshot)..draft.range.end.to_offset(&snapshot);
        let units = model::Utf16::new(&text);
        let discarded = Discarded {
            path: self.relative.clone(),
            from: units.to_units(range.start) as u32,
            to: units.to_units(range.end) as u32,
            quote: draft.quote,
            prefix: draft.prefix,
            suffix: draft.suffix,
            body,
            intent: draft.intent,
        };
        let panel = cx.weak_entity();
        crate::notices::show(
            crate::notices::Notice::new(
                lattice_ui::components::ToastLevel::Info,
                t!("Note discarded"),
            )
            .source(t!("Annotations"))
            .key("annotation-draft-discarded")
            .action(crate::notices::NoticeAction::new(
                t!("Undo"),
                move |window, cx| {
                    let discarded = discarded.clone();
                    panel
                        .update(cx, |panel, cx| panel.reopen_draft(discarded, window, cx))
                        .ok();
                },
            )),
            cx,
        );
    }

    /// Undo on "Note discarded": the note opens again on its passage,
    /// selected first, in the file it was written on.
    fn reopen_draft(&mut self, note: Discarded, window: &mut Window, cx: &mut Context<Self>) {
        if note.path != self.relative {
            return;
        }
        let text = self.buffer.read(cx).text();
        if let Some(range) = model::resolve_anchor(
            &text,
            note.from,
            note.to,
            &note.quote,
            &note.prefix,
            &note.suffix,
        ) {
            self.select_bytes(range, window, cx);
        }
        self.open_draft(note, window, cx);
    }

    /// Select bytes `range` of the buffer and bring them to the middle.
    pub(super) fn select_bytes(
        &mut self,
        range: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let snapshot = self.buffer.read(cx).snapshot();
        let (start, end) = (
            snapshot.offset_to_point(range.start),
            snapshot.offset_to_point(range.end),
        );
        self.editor.update(cx, |editor, cx| {
            editor.change_selections(
                editor::SelectionEffects::scroll(editor::scroll::Autoscroll::center()),
                window,
                cx,
                |selections| selections.select_ranges([start..end]),
            );
        });
    }

    /// Show the annotation `id`'s passage, selected, in the middle of the
    /// editor (`revealInEditor`); false when it no longer anchors here.
    pub fn reveal_annotation(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let root = self.project_root(cx);
        let Some(comment) =
            store::try_store(cx).and_then(|store| store.read(cx).get(&root, id).cloned())
        else {
            return false;
        };
        let text = self.buffer.read(cx).text();
        let Some(range) = model::anchor_of(&text, &comment) else {
            return false;
        };
        self.select_bytes(range, window, cx);
        window.focus(&self.editor.focus_handle(cx), cx);
        true
    }

    /// A press on a pin opens its note (`onOpenAnnotation`).
    pub(super) fn annotation_pin_pressed(
        &mut self,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) -> bool {
        let painted = self.lattice.read(cx).painted();
        let Some(line_height) = painted.line_height else {
            return false;
        };
        let hit = painted.gutter.iter().find(|(layer, _, bounds)| {
            *layer == PINS && {
                let area = Bounds {
                    origin: gpui::point(bounds.left(), bounds.center().y - line_height / 2.),
                    size: gpui::size(bounds.size.width, line_height),
                };
                area.contains(&position)
            }
        });
        let Some((_, row, _)) = hit else {
            return false;
        };
        let Some(id) = self
            .annotations
            .pins
            .iter()
            .find(|(line, _)| line == row)
            .and_then(|(_, ids)| ids.first().cloned())
        else {
            return false;
        };
        cx.emit(EditorPanelEvent::Annotation(AnnotationRequest::Open(id)));
        true
    }
}

/// The comment card over a note's passage, for every note on the text under
/// the pointer; anchored on the pointer's line, so the card hangs right over
/// it however many lines the passage takes.
struct NoteCards {
    placed: Placed,
    panel: gpui::WeakEntity<EditorPanel>,
}

impl HoverProvider for NoteCards {
    fn target(
        &self,
        text: &language::BufferSnapshot,
        offset: usize,
        _: &App,
    ) -> Option<HoverTarget> {
        let placed = self.placed.borrow();
        let hits: Vec<(Range<usize>, EditorComment)> = placed
            .iter()
            .filter(|(range, _)| offset >= range.start && offset < range.end)
            .cloned()
            .collect();
        if hits.is_empty() {
            return None;
        }
        let from = hits.iter().map(|(range, _)| range.start).min()?.min(offset);
        let to = hits.iter().map(|(range, _)| range.end).max()?.max(offset);
        let row = text.offset_to_point(offset).row;
        let line_start = text.point_to_offset(BufferPoint::new(row, 0));
        let line_end = text.point_to_offset(BufferPoint::new(row, text.line_len(row)));
        let range = from.max(line_start)..to.min(line_end).max(from.max(line_start) + 1);
        let comments: Vec<EditorComment> = hits.into_iter().map(|(_, comment)| comment).collect();
        let panel = self.panel.clone();
        Some(HoverTarget {
            range,
            id: "annotation",
            card: Rc::new(move |context, _, cx| {
                let panel = panel.clone();
                let on: card::CardAction = Rc::new(move |event, _, cx| {
                    let request = match event {
                        CardEvent::Resolve(id) => AnnotationRequest::Resolve(id),
                        CardEvent::Reply(id) => AnnotationRequest::Reply(id),
                    };
                    panel
                        .update(cx, |panel, cx| {
                            panel
                                .lattice
                                .update(cx, |lattice, cx| lattice.dismiss_hover(cx));
                            cx.emit(EditorPanelEvent::Annotation(request));
                        })
                        .ok();
                });
                card::comment_card(&comments, on, context.max_width, cx)
            }),
        })
    }
}
