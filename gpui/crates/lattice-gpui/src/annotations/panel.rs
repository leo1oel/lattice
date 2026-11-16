//! The Annotations panel (`src/editor/comments/editor-comments-panel.tsx`,
//! `annotations.css`): the writer's notes on this project, grouped by the
//! file and the section they sit in, each with its pin, the passage it quotes
//! in the reading face, the note, and where and when it was made. The
//! window's "comments" view shows it for a project not linked to Overleaf
//! (one linked keeps its notes in Overleaf's comments instead).
//!
//! A filter picks Open (with a proposal accepted in the round under review
//! still among them), Resolved or All, and Filter annotations narrows the
//! list by the note's words, its quote, its file or its author. A card opens
//! its passage in the editor; its actions, shown while the pointer is over
//! it, resolve or reopen it, reply to it, and, for its author, edit or
//! delete it. Every action answers on the card: one that stays tints for a
//! moment and says what happened beside its place; one resolved out of its
//! filter, or deleted, leaves on the moderate exit before the change lands
//! (its toast offers it back).
//!
//! Revision rounds, their review and the review PDF are the rounds' own
//! (`docs/not-yet.md`); the panel lists the notes.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::LazyLock,
    time::{Duration, Instant},
};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EntityId, EventEmitter, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    input::{InputEvent, InputState, TextareaState},
};
use lattice_core::project::EditorComment;
use lattice_i18n::{t, tc};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, ButtonSize, Field, IconButton, Segmented},
    scrollbar::FluidScrollbar,
    tokens::{SPACING_2, SPACING_3, SPACING_4, SPACING_5, SPACING_6},
};
use regex::Regex;

use super::{
    model,
    store::{self, AnnotationStore},
};
use crate::{
    pdf::PdfPanel,
    research_art::{Drawing, research_art},
};

mod cards;
mod rounds_view;

/// A card leaving the list goes on the moderate exit (`LEAVE_MS`), then
/// the change lands.
const LEAVE: Duration = Duration::from_millis(180);
/// How long a card says what just happened to it (`CONFIRM_MS`).
const CONFIRM: Duration = Duration::from_millis(1800);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter {
    Open,
    Resolved,
    All,
}

/// What the writer just did to a card, as the card answers it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Resolved,
    Reopened,
    Saved,
    Replied,
}

impl Outcome {
    fn label(self) -> &'static str {
        match self {
            Outcome::Resolved => t!("Resolved"),
            Outcome::Reopened => t!("Reopened"),
            Outcome::Saved => t!("Saved"),
            Outcome::Replied => t!("Reply sent"),
        }
    }
}

/// What the panel asks of the window.
pub enum AnnotationsPanelEvent {
    /// Open the note's file and show its passage.
    Open(EditorComment),
    /// Open a file to annotate (the empty panel's Open a file).
    OpenFile,
    /// Export review PDF… over the live PDF.
    ExportReviewPdf,
}

/// The card being written in: an edit of the note, or a reply.
enum Writing {
    Edit {
        id: String,
        field: Entity<TextareaState>,
        _sub: Subscription,
    },
    Reply {
        id: String,
        field: Entity<TextareaState>,
        _sub: Subscription,
    },
}

/// What the panel reads of its window: the project and the file the writer
/// works in, and an open file's text (for its notes' lines and sections).
pub struct PanelHost {
    pub project: Box<dyn Fn(&App) -> Option<(PathBuf, Option<String>)>>,
    pub source: Box<dyn Fn(&str, &App) -> Option<String>>,
    /// The live PDF's panel, whose viewer hosts a review copy.
    pub live_pdf: Box<dyn Fn(&App) -> Option<Entity<PdfPanel>>>,
}

pub struct AnnotationsPanel {
    focus_handle: FocusHandle,
    store: Entity<AnnotationStore>,
    host: PanelHost,
    root: Option<PathBuf>,
    /// The file the writer works in: its notes come first.
    active: Option<String>,
    /// Each listed file's text as last read, for its notes' lines and
    /// sections.
    sources: HashMap<String, String>,
    filter: Filter,
    searching: bool,
    query: Entity<InputState>,
    writing: Option<Writing>,
    /// The note last opened from here, the gutter or a card: it stands out.
    active_note: Option<String>,
    /// Cards on their way out, and when they started.
    leaving: HashMap<String, Instant>,
    outcomes: HashMap<String, (Outcome, Instant)>,
    scroll: ScrollHandle,
    /// The revision rounds the panel shows (`panel/rounds_view.rs`).
    rounds: rounds_view::RoundsView,
    /// The live PDF followed, so the panel hears it load: its panel and
    /// the viewer the live PDF is in, which moves with its window.
    live_pdf: Option<(EntityId, Subscription, Subscription)>,
    _tasks: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<PanelEvent> for AnnotationsPanel {}
impl EventEmitter<AnnotationsPanelEvent> for AnnotationsPanel {}

impl AnnotationsPanel {
    pub fn new(host: PanelHost, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let store = store::store(cx);
        let query = cx.new(|cx| InputState::new(window, cx).placeholder(t!("Filter annotations…")));
        let subscriptions = vec![
            cx.observe(&store, |_, _, cx| cx.notify()),
            // A citation reason joins the notes once its cite is gone.
            super::orphans::observe(cx),
            cx.subscribe(&query, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
        ];
        Self {
            focus_handle: cx.focus_handle(),
            store,
            host,
            root: None,
            active: None,
            sources: HashMap::new(),
            filter: Filter::Open,
            searching: false,
            query,
            writing: None,
            active_note: None,
            leaving: HashMap::new(),
            outcomes: HashMap::new(),
            scroll: ScrollHandle::new(),
            rounds: Default::default(),
            live_pdf: None,
            _tasks: Vec::new(),
            _subscriptions: subscriptions,
        }
    }

    /// Follow the window: its project and the file in front, and the
    /// listed files' text.
    fn follow_host(&mut self, cx: &mut Context<Self>) {
        let (root, active) = match (self.host.project)(cx) {
            Some((root, active)) => (Some(root), active),
            None => (None, None),
        };
        self.set_root(root, cx);
        self.active = active;
        self.follow_live_pdf(cx);
        let paths: HashSet<String> = self
            .notes(cx)
            .into_iter()
            .map(|comment| comment.path)
            .collect();
        self.sources = paths
            .into_iter()
            .filter_map(|path| Some(((self.host.source)(&path, cx)?, path)))
            .map(|(text, path)| (path, text))
            .collect();
    }

    /// Hear the live PDF's viewer, the one in its window while it has one.
    fn follow_live_pdf(&mut self, cx: &mut Context<Self>) {
        let Some(pdf) = (self.host.live_pdf)(cx) else {
            self.live_pdf = None;
            return;
        };
        let view = pdf.read(cx).live_view().clone();
        if self
            .live_pdf
            .as_ref()
            .is_some_and(|(id, _, _)| *id == view.entity_id())
        {
            return;
        }
        self.live_pdf = Some((
            view.entity_id(),
            cx.observe(&pdf, |_, _, cx| cx.notify()),
            cx.observe(&view, |_, _, cx| cx.notify()),
        ));
    }

    /// Whether the live PDF can host a review copy: one is built and shows
    /// this project's notes.
    fn review_ready(&self, cx: &App) -> bool {
        (self.host.live_pdf)(cx)
            .is_some_and(|pdf| pdf.read(cx).live_view().read(cx).can_review())
    }

    /// Whether the project has local numbered notes, resolved ones too, for
    /// a review copy.
    fn has_numbered_notes(&self, cx: &App) -> bool {
        self.root.as_ref().is_some_and(|root| {
            self.store
                .read(cx)
                .annotations(root)
                .into_iter()
                .any(|note| note.number > 0)
        })
    }

    /// The project the panel lists: a change from one project to another
    /// closes what was being written and goes back to the open notes.
    fn set_root(&mut self, root: Option<PathBuf>, cx: &mut Context<Self>) {
        if self.root.is_some() && self.root != root {
            self.writing = None;
            self.active_note = None;
            self.filter = Filter::Open;
        }
        if let Some(root) = &root {
            self.store.update(cx, |store, cx| store.ensure(root, cx));
        }
        self.root = root;
    }

    /// The note last opened in the project `root`: its card stands out and
    /// comes into view.
    pub fn set_active_note(&mut self, root: PathBuf, id: Option<String>, cx: &mut Context<Self>) {
        self.set_root(Some(root), cx);
        if self.active_note != id {
            self.active_note = id;
            cx.notify();
        }
    }

    /// Open the reply box on the note `id` in the project `root` (a card's
    /// Reply…), showing every note so it is listed.
    pub fn reply_to(
        &mut self,
        root: PathBuf,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.set_root(Some(root), cx);
        self.filter = Filter::All;
        self.active_note = Some(id.clone());
        self.start_reply(id, window, cx);
    }

    pub fn set_filter(&mut self, filter: Filter, cx: &mut Context<Self>) {
        self.filter = filter;
        cx.notify();
    }

    /// The notes the panel lists now, by id, for scripted checks.
    pub fn listed(&self, cx: &App) -> Vec<String> {
        self.visible(cx)
            .into_iter()
            .map(|comment| comment.id)
            .collect()
    }

    fn notes(&self, cx: &App) -> Vec<EditorComment> {
        let Some(root) = self.root.clone() else {
            return Vec::new();
        };
        let mut notes: Vec<EditorComment> = self
            .store
            .read(cx)
            .annotations(&root)
            .into_iter()
            .cloned()
            .collect();
        // The citation reasons whose cite is gone (or that were resolved
        // there) join the notes; an anchored one belongs to its card.
        notes.extend(super::orphans::panel_reasons(&root, cx));
        notes
    }

    /// Whether `filter` lists `comment`.
    fn shown_in(&self, filter: Filter, comment: &EditorComment, cx: &App) -> bool {
        let round = self
            .root
            .as_ref()
            .and_then(|root| self.store.read(cx).notes(root))
            .and_then(|notes| {
                notes
                    .rounds
                    .iter()
                    .filter(|round| round.settled_at.is_none())
                    .map(|round| round.number)
                    .max()
            });
        let open = !comment.resolved
            || (round.is_some()
                && comment.revision.as_ref().is_some_and(|revision| {
                    revision.state == "accepted" && Some(revision.round) == round
                }));
        match filter {
            Filter::All => true,
            Filter::Open => open,
            Filter::Resolved => comment.resolved,
        }
    }

    fn visible(&self, cx: &App) -> Vec<EditorComment> {
        let needle = self.query.read(cx).value().trim().to_lowercase();
        self.notes(cx)
            .into_iter()
            .filter(|comment| self.shown_in(self.filter, comment, cx))
            .filter(|comment| {
                needle.is_empty()
                    || [
                        comment.body.as_str(),
                        comment.quote.as_str(),
                        comment.path.as_str(),
                        &model::author_display(&comment.author_name),
                    ]
                    .iter()
                    .any(|text| text.to_lowercase().contains(&needle))
            })
            .collect()
    }

    fn toggle_resolved(&mut self, comment: &EditorComment, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let mut after = comment.clone();
        after.resolved = !comment.resolved;
        let id = comment.id.clone();
        let resolved = after.resolved;
        if self.shown_in(self.filter, &after, cx) {
            self.store
                .update(cx, |store, cx| store.set_resolved(&root, &id, resolved, cx));
            self.answer(
                id,
                if resolved {
                    Outcome::Resolved
                } else {
                    Outcome::Reopened
                },
                cx,
            );
        } else {
            self.leave(id.clone(), cx, move |store, cx| {
                store.set_resolved(&root, &id, resolved, cx)
            });
        }
    }

    /// The card leaves, then `change` lands.
    fn leave(
        &mut self,
        id: String,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut AnnotationStore, &mut Context<AnnotationStore>) + 'static,
    ) {
        if self.leaving.contains_key(&id) {
            return;
        }
        self.leaving.insert(id.clone(), Instant::now());
        cx.notify();
        let store = self.store.clone();
        self._tasks.push(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LEAVE).await;
            store.update(cx, change);
            this.update(cx, |this, cx| {
                this.leaving.remove(&id);
                cx.notify();
            })
            .ok();
        }));
    }

    /// The card says what happened for a moment.
    fn answer(&mut self, id: String, outcome: Outcome, cx: &mut Context<Self>) {
        let at = Instant::now();
        self.outcomes.insert(id.clone(), (outcome, at));
        cx.notify();
        self._tasks.push(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CONFIRM).await;
            this.update(cx, |this, cx| {
                if this.outcomes.get(&id).is_some_and(|(_, when)| *when == at) {
                    this.outcomes.remove(&id);
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    fn start_edit(&mut self, comment: &EditorComment, window: &mut Window, cx: &mut Context<Self>) {
        let field = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(t!("Update annotation…"))
                .auto_grow(3, 10)
                .default_value(comment.body.clone())
        });
        field.update(cx, |field, cx| field.focus(window, cx));
        let sub = cx.subscribe(&field, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        self.writing = Some(Writing::Edit {
            id: comment.id.clone(),
            field,
            _sub: sub,
        });
        cx.notify();
    }

    fn start_reply(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let author = self
            .root
            .as_ref()
            .and_then(|root| self.store.read(cx).get(root, &id))
            .map(|comment| model::author_display(&comment.author_name))
            .unwrap_or_default();
        let field = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(t!("Reply to {author}", author = author))
                .auto_grow(2, 10)
        });
        field.update(cx, |field, cx| field.focus(window, cx));
        let sub = cx.subscribe(&field, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        self.writing = Some(Writing::Reply {
            id,
            field,
            _sub: sub,
        });
        cx.notify();
    }

    fn finish_edit(&mut self, cx: &mut Context<Self>) {
        let Some(Writing::Edit { id, field, .. }) = self.writing.take() else {
            return;
        };
        let body = field.read(cx).value().trim().to_string();
        let Some(root) = self.root.clone() else {
            return;
        };
        let before = self
            .store
            .read(cx)
            .get(&root, &id)
            .map(|comment| comment.body.clone());
        if !body.is_empty() && before.as_deref() != Some(body.as_str()) {
            self.store.update(cx, |store, cx| {
                store.update(&root, &id, |comment| comment.body = body, cx)
            });
            self.answer(id, Outcome::Saved, cx);
        }
        cx.notify();
    }

    fn send_reply(&mut self, cx: &mut Context<Self>) {
        let Some(Writing::Reply { id, field, .. }) = self.writing.take() else {
            return;
        };
        let body = field.read(cx).value().to_string();
        let Some(root) = self.root.clone() else {
            return;
        };
        let author = store::author(&root, cx);
        let sent = self
            .store
            .update(cx, |store, cx| store.reply(&root, &id, &body, &author, cx));
        if sent {
            self.answer(id, Outcome::Replied, cx);
        }
        cx.notify();
    }

    fn delete(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        self.leave(id.clone(), cx, move |store, cx| {
            store.delete(&root, &id, cx)
        });
    }

    /// The visible notes in reading order, under the file and section each
    /// sits in: the open file first, then the others by name.
    fn groups(
        &self,
        visible: Vec<EditorComment>,
    ) -> Vec<(Option<String>, Vec<(EditorComment, Option<u32>)>)> {
        let mut by_file: Vec<(String, Vec<EditorComment>)> = Vec::new();
        for comment in visible {
            match by_file.iter_mut().find(|(path, _)| *path == comment.path) {
                Some((_, notes)) => notes.push(comment),
                None => by_file.push((comment.path.clone(), vec![comment])),
            }
        }
        let active = self.active.clone();
        by_file.sort_by(|(a, _), (b, _)| {
            (Some(b) == active.as_ref())
                .cmp(&(Some(a) == active.as_ref()))
                .then_with(|| a.cmp(b))
        });
        let many = by_file.len() > 1;
        let mut out: Vec<(Option<String>, Vec<(EditorComment, Option<u32>)>)> = Vec::new();
        for (path, notes) in by_file {
            let source = self.sources.get(&path);
            let sections = source
                .map(|source| sections_of(source, &path))
                .unwrap_or_default();
            let name = file_name(&path);
            let mut placed: Vec<(EditorComment, usize, Option<u32>)> = notes
                .into_iter()
                .map(|comment| {
                    let range = source.and_then(|source| model::anchor_of(source, &comment));
                    let from = range.as_ref().map_or_else(
                        || {
                            source.map_or(comment.from as usize, |source| {
                                model::Utf16::new(source)
                                    .to_byte(comment.from as usize)
                                    .unwrap_or(0)
                            })
                        },
                        |range| range.start,
                    );
                    let line = source.zip(range).map(|(source, range)| {
                        source[..range.start].matches('\n').count() as u32 + 1
                    });
                    (comment, from, line)
                })
                .collect();
            placed.sort_by_key(|(comment, from, _)| (*from, comment.number));
            for (comment, from, line) in placed {
                let section = sections.iter().rev().find(|(offset, _)| *offset <= from);
                let label = match section {
                    Some((_, label)) => Some(label.clone()),
                    None if !sections.is_empty() => {
                        Some(t!("Before the first section").to_string())
                    }
                    None => None,
                };
                let heading = if many {
                    Some(lattice_i18n::join_phrases(
                        &[Some(name.clone()), label]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>(),
                    ))
                } else {
                    label
                };
                match out.last_mut() {
                    Some((last, items)) if *last == heading => items.push((comment, line)),
                    _ => out.push((heading, vec![(comment, line)])),
                }
            }
        }
        out
    }

    fn header(
        &mut self,
        open: usize,
        resolved: usize,
        has_notes: bool,
        review: Option<bool>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let count = |label: &str, count: usize| {
            if count > 0 {
                format!("{label} {count}")
            } else {
                label.to_string()
            }
        };
        let filter = self.filter;
        let mut segmented = Segmented::new("annotations-filter");
        for (value, label) in [
            (Filter::Open, count(tc!("annotation filter", "Open"), open)),
            (Filter::Resolved, count(t!("Resolved"), resolved)),
            (Filter::All, t!("All").to_string()),
        ] {
            let this = cx.weak_entity();
            segmented = segmented.label(label, filter == value, move |_, _, cx| {
                this.update(cx, |this, cx| this.set_filter(value, cx)).ok();
            });
        }
        let searching = self.searching;
        let search = IconButton::new("annotations-search-toggle", Icon::SEARCH)
            .on(searching)
            .tooltip(t!("Filter annotations"))
            .on_click(cx.listener(|this, _, window, cx| {
                this.searching = !this.searching;
                this.query.update(cx, |query, cx| {
                    query.set_value(String::new(), window, cx);
                    if this.searching {
                        query.focus(window, cx);
                    }
                });
                cx.notify();
            }));
        div()
            .flex()
            .flex_col()
            .gap(SPACING_4)
            .pt(SPACING_2)
            .pb(SPACING_4)
            .border_b_1()
            .border_color(palette.line)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(SPACING_2)
                    .min_w_0()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .when(has_notes, |this| this.child(segmented)),
                    )
                    .when(has_notes, |this| this.child(search))
                    .children(self.rounds_button(cx))
                    .when_some(review, |this, ready| {
                        this.child(
                            IconButton::new("annotations-review-pdf", Icon::MESSAGE_SQUARE_SHARE)
                                .disabled(!ready)
                                .tooltip(if ready {
                                    t!("Export review PDF…")
                                } else {
                                    t!("Build the PDF to export a review copy")
                                })
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(AnnotationsPanelEvent::ExportReviewPdf)
                                })),
                        )
                    }),
            )
            .when(searching && has_notes, |this| {
                this.child(
                    div()
                        .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                            if event.keystroke.key == "escape" {
                                this.searching = false;
                                this.query.update(cx, |query, cx| {
                                    query.set_value(String::new(), window, cx)
                                });
                                cx.notify();
                            }
                        }))
                        .child(Field::new(&self.query).compact().search()),
                )
            })
            .into_any_element()
    }

    fn empty(&self, has_notes: bool, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let searching = !self.query.read(cx).value().trim().is_empty();
        let (title, description): (Option<&str>, Option<&str>) = if !has_notes {
            (Some(t!("No annotations yet")), None)
        } else if searching {
            (None, Some(t!("No matches")))
        } else if self.filter == Filter::Resolved {
            (None, Some(t!("No resolved annotations")))
        } else {
            (None, Some(t!("No open annotations")))
        };
        let drawing = if has_notes {
            Drawing::MarginNotes
        } else {
            Drawing::AnnotationFlags
        };
        div()
            .flex_1()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(SPACING_3)
            .py(px(20.))
            .px(SPACING_6)
            .child(
                div()
                    .mb(SPACING_4)
                    .child(research_art(drawing, px(144.), palette.panel, cx)),
            )
            .children(title.map(|title| {
                div()
                    .text_role(TextRole::Subtitle, cx)
                    .text_color(palette.text)
                    .text_center()
                    .child(title)
            }))
            .children(description.map(|description| {
                div()
                    .text_role(TextRole::Body, cx)
                    .text_color(palette.text_secondary)
                    .text_center()
                    .child(description)
            }))
            .when(!has_notes && self.active.is_none(), |this| {
                this.child(
                    div().mt(SPACING_4).child(
                        Button::new("annotations-open-file", t!("Open a file"))
                            .size(ButtonSize::Compact)
                            .icon(Icon::FILE_SEARCH)
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(AnnotationsPanelEvent::OpenFile)),
                            ),
                    ),
                )
            })
            .into_any_element()
    }
}

fn file_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// The top-level headings of `source`, as the panel groups notes under them
/// (`sectionsOf`): chapters when it has them, else sections, numbered as
/// LaTeX numbers them (a starred one has none); Markdown's top headings for
/// Markdown. Each is its byte offset and its label.
pub fn sections_of(source: &str, path: &str) -> Vec<(usize, String)> {
    static MARKDOWN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?m)^(#{1,2})\s+(.+)$").unwrap());
    static LATEX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\\(chapter|section)(\*?)\{([^{}]*)\}").unwrap());
    let lower = path.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") {
        let headings: Vec<_> = MARKDOWN.captures_iter(source).collect();
        let Some(top) = headings.iter().map(|found| found[1].len()).min() else {
            return Vec::new();
        };
        return headings
            .iter()
            .filter(|found| found[1].len() == top)
            .map(|found| (found.get(0).unwrap().start(), found[2].trim().to_string()))
            .collect();
    }
    let commands: Vec<_> = LATEX.captures_iter(source).collect();
    let level = if commands.iter().any(|found| &found[1] == "chapter") {
        "chapter"
    } else {
        "section"
    };
    let mut number = 0;
    commands
        .iter()
        .filter(|found| &found[1] == level)
        .map(|found| {
            let title = found[3].split_whitespace().collect::<Vec<_>>().join(" ");
            let offset = found.get(0).unwrap().start();
            if !found[2].is_empty() {
                return (offset, title);
            }
            number += 1;
            (offset, format!("§{number} {title}"))
        })
        .collect()
}

impl Focusable for AnnotationsPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for AnnotationsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.follow_host(cx);
        if let Some(root) = self.root.clone() {
            super::orphans::read_sources(&root, cx);
        }
        let notes = self.notes(cx);
        let has_notes = !notes.is_empty();
        let open = notes
            .iter()
            .filter(|comment| self.shown_in(Filter::Open, comment, cx))
            .count();
        let resolved = notes
            .iter()
            .filter(|comment| self.shown_in(Filter::Resolved, comment, cx))
            .count();
        let visible = self.visible(cx);
        let review = self.has_numbered_notes(cx).then(|| self.review_ready(cx));
        let header = self.header(open, resolved, has_notes, review, cx);
        let author_id = self.store.read(cx).author_id().to_string();
        let list: AnyElement = if visible.is_empty() {
            self.empty(has_notes, cx)
        } else {
            let palette = cx.palette().clone();
            let groups = self.groups(visible);
            let mut list = div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .pt(SPACING_3)
                .pb(SPACING_6);
            for (index, (label, items)) in groups.into_iter().enumerate() {
                if let Some(label) = label {
                    list = list.child(
                        div()
                            .mt(if index == 0 { SPACING_2 } else { SPACING_5 })
                            .mb(SPACING_2)
                            .px(SPACING_4)
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(label),
                    );
                }
                for (comment, line) in items {
                    list = list.child(self.card(&comment, line, &author_id, window, cx));
                }
            }
            div()
                .id("annotations-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .track_scroll(&self.scroll)
                .child(list)
                .into_any_element()
        };
        div()
            .track_focus(&self.focus_handle)
            .key_context("AnnotationsPanel")
            .on_key_down(
                cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| this.rounds_key(event, cx)),
            )
            .size_full()
            .flex()
            .flex_col()
            .px(SPACING_5)
            .child(header)
            .children(self.rounds_banner(&notes, &self.rounds_list(cx), cx))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .child(list)
                    .when(has_notes, |this| {
                        this.child(FluidScrollbar::vertical(
                            "annotations-scrollbar",
                            &self.scroll,
                        ))
                    }),
            )
            .children(self.rounds_foot(&notes, cx))
    }
}

impl BasePanel for AnnotationsPanel {
    fn panel_name(&self) -> &'static str {
        "AnnotationsPanel"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for AnnotationsPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(t!("Annotations").into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        t!("Annotations")
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_number_as_latex_numbers_them() {
        let source = "\\section{Intro}\ntext\n\\section*{Aside}\n\\section{Method}\n";
        let sections = sections_of(source, "main.tex");
        let labels: Vec<_> = sections.iter().map(|(_, label)| label.as_str()).collect();
        assert_eq!(labels, ["§1 Intro", "Aside", "§2 Method"]);
        let chapters = sections_of("\\chapter{One}\\section{A}\\chapter{Two}", "book.tex");
        assert_eq!(chapters.len(), 2);
        let markdown = sections_of("# Title\n## Sub\n# Next\n", "notes.md");
        assert_eq!(
            markdown
                .iter()
                .map(|(_, label)| label.as_str())
                .collect::<Vec<_>>(),
            ["Title", "Next"]
        );
    }
}
