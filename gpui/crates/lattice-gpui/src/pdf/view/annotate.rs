//! Annotating the compiled PDF, as the Tauri app's `pdf-annotations.tsx`
//! offers it and `pdf-annotation-composer.tsx` writes it: once a drag has
//! selected text on a page, an Annotate button stands under the
//! selection's end; choosing it opens the note under the selection, which
//! maps the words to the source with SyncTeX first and says where
//! (`PDF p.1 → main.tex:35`), Save waiting until it knows. A press anywhere
//! else, a scroll, a zoom, a new copy of the PDF or Escape takes the offer
//! away. The note is the source editor's (`annotations::form`); Esc or a
//! click outside closes it, and one with words in it is offered back
//! ("Note discarded", Undo), on the same selection.
//!
//! The note is a local annotation on the span SyncTeX's line holds, and it
//! keeps where on the page it was made, so the PDF draws it there.

use std::{ops::Range, path::Path, rc::Rc};

use gpui::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement as _, KeyDownEvent,
    ParentElement as _, Pixels, Point, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, div, px,
};
use gpui_kit::component::input::{InputEvent, TextareaState};
use lattice_core::project::{PdfAnchor, PdfRect};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{PopFrom, pop_in},
    tokens::{RADIUS_SURFACE, SPACING_4, SPACING_5},
};

use super::{hover_card::CardBounds, *};
use crate::{
    annotations::{
        AnnotationRequest,
        form::{self, NoteForm},
        model::{self, Intent},
        store,
    },
    pdf::source_anchor::source_range_for_pdf_text,
};

/// The composer's width (`COMPOSER_PLACE`).
const COMPOSER_WIDTH: Pixels = px(360.);
/// The offer's gap under the selection's last line.
const OFFER_GAP: f32 = 4.;
/// The offer's height (`--control-height-compact`).
const OFFER_HEIGHT: f32 = 24.;

/// The note being written, as a scenario reads it: where SyncTeX placed it
/// (its file and line), and its error.
pub type ComposerState = (Option<(String, usize)>, Option<String>);

/// Text selected on a page to annotate: its page, its line boxes (PDF
/// points from the page's top-left), its text, and the point SyncTeX maps
/// to the source (the first line's start, in PDF points).
#[derive(Clone, Debug)]
struct Selected {
    page: usize,
    rects: Vec<[f32; 4]>,
    text: String,
    point: (f32, f32),
}

/// Annotate, for the copy, zoom and scroll it was measured in.
struct Offer {
    selected: Selected,
    generation: u64,
    scale: f32,
    scroll: (f32, f32),
}

/// Where the selection was written: the source file, the 1-based line the
/// span starts on, the span's bytes, and the file as it was read.
#[derive(Debug)]
struct Mapped {
    path: String,
    line: usize,
    range: Range<usize>,
    source: String,
}

/// Why the selection has no place in the source.
enum Unmapped {
    Search(String),
    Unread(String),
    Outside(String),
}

/// The note being written.
struct Composing {
    id: u64,
    selected: Selected,
    field: Entity<TextareaState>,
    intent: Option<Intent>,
    mapped: Option<Mapped>,
    error: Option<SharedString>,
    _field: Subscription,
    _mapping: Task<()>,
}

#[derive(Default)]
pub(in crate::pdf) struct Annotating {
    offer: Option<Offer>,
    composing: Option<Composing>,
    /// Counts the offers asked for (a later answer for an earlier one is
    /// dropped) and the notes opened.
    asked: u64,
    opened: u64,
    composer_bounds: CardBounds,
}

/// Where the text selected on `page` (0-based) at `point` came from.
fn map_selection(
    root: &Path,
    document: Option<&str>,
    page: usize,
    point: (f32, f32),
    text: &str,
) -> Result<Mapped, Unmapped> {
    let round = |value: f32| (f64::from(value) * 1000.).round() / 1000.;
    let target = lattice_core::latex::inverse_search_in(
        root,
        page as u32 + 1,
        round(point.0),
        round(point.1),
        document,
    )
    .map_err(Unmapped::Search)?;
    // SyncTeX may name the file by its full path.
    let path = Path::new(&target.path);
    let path = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let source =
        std::fs::read_to_string(root.join(&path)).map_err(|_| Unmapped::Unread(path.clone()))?;
    let range = source_range_for_pdf_text(&source, target.line as usize, text)
        .ok_or_else(|| Unmapped::Outside(path.clone()))?;
    let line = source[..range.start].matches('\n').count() + 1;
    Ok(Mapped {
        path,
        line,
        range,
        source,
    })
}

impl PdfView {
    /// Whether this PDF takes notes: it shows a project's notes, made
    /// here as local annotations.
    fn annotatable(&self) -> bool {
        self.notes_source().is_some_and(|source| source.annotatable)
    }

    /// A drag that selected text ended: offer Annotate where it ends, once
    /// the selection's text is read.
    pub(in crate::pdf) fn offer_annotate(&mut self, cx: &mut Context<Self>) {
        self.dismiss_offer(cx);
        if !self.annotatable() {
            return;
        }
        let (Some(selection), Some(document)) = (
            self.selection.filter(|selection| !selection.is_empty()),
            &self.document,
        ) else {
            return;
        };
        let generation = document.info.generation;
        let ((page, _), _) = selection.ordered();
        let Some(slot) = self.pages.get(page) else {
            return;
        };
        let Some(text) = slot
            .text
            .clone()
            .filter(|_| slot.text_generation == generation)
        else {
            return;
        };
        let Some(&(width, _)) = self.page_sizes().get(page) else {
            return;
        };
        let rects = selection
            .range_on(page, text.chars.len())
            .map(|range| text.highlight(range))
            .unwrap_or_default();
        let Some(&[x0, y0, x1, y1]) = rects.first() else {
            return;
        };
        let Some(reading) = self.selected_text_task(cx) else {
            return;
        };
        let point = (x0 + (x1 - x0).min(0.02 * width), (y0 + y1) / 2.);
        let (scale, scroll) = (self.layout.scale, self.scroll_offset());
        let asked = self.annotating.asked;
        cx.spawn(async move |this, cx| {
            let text = reading.await;
            this.update(cx, |this, cx| {
                let text = text.trim();
                if this.annotating.asked != asked || text.is_empty() {
                    return;
                }
                this.annotating.offer = Some(Offer {
                    selected: Selected {
                        page,
                        rects,
                        text: text.to_string(),
                        point,
                    },
                    generation,
                    scale,
                    scroll,
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Take Annotate away (and any answer still coming for it).
    pub(in crate::pdf) fn dismiss_offer(&mut self, cx: &mut Context<Self>) {
        self.annotating.asked += 1;
        if self.annotating.offer.take().is_some() {
            cx.notify();
        }
    }

    /// Whether Annotate shows (also for a scenario).
    pub fn offer_shown(&self) -> bool {
        self.annotating.offer.is_some()
    }

    /// Before a frame: a scroll, a zoom or a new copy of the PDF takes the
    /// offer away.
    pub(in crate::pdf) fn retire_offer(&mut self, cx: &mut Context<Self>) {
        let generation = self
            .document
            .as_ref()
            .map(|document| document.info.generation);
        let stale = self.annotating.offer.as_ref().is_some_and(|offer| {
            Some(offer.generation) != generation
                || offer.scale != self.layout.scale
                || offer.scroll != self.scroll_offset()
        });
        if stale {
            self.dismiss_offer(cx);
        }
    }

    /// The project went away or stopped taking notes here.
    pub(in crate::pdf) fn end_annotating(&mut self) {
        if !self.annotatable() {
            self.annotating.asked += 1;
            self.annotating.offer = None;
            self.annotating.composing = None;
        }
    }

    /// Annotate, under the end of the selection on `page`, its right edge
    /// at the selection's.
    pub(in crate::pdf) fn annotate_offer(
        &self,
        page: usize,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let offer = self.annotating.offer.as_ref()?;
        if offer.selected.page != page {
            return None;
        }
        let &(width, _) = self.page_sizes().get(page)?;
        let &[_, _, x1, y1] = offer.selected.rects.last()?;
        let scale = self.layout.scale;
        let palette = cx.palette().clone();
        let button = div()
            .id("pdf-annotate-offer")
            .flex()
            .items_center()
            .gap(px(4.))
            .h(px(OFFER_HEIGHT))
            .px(SPACING_4)
            .rounded_full()
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .text_color(palette.text)
            .text_role(TextRole::BodyCompact, cx)
            .whitespace_nowrap()
            .cursor_pointer()
            .hover(|this| this.bg(palette.hover))
            // The press keeps the selection, and its release offers nothing.
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_up(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|this, _, window, cx| {
                if let Some(offer) = this.annotating.offer.take() {
                    this.open_composer(offer.selected, None, window, cx);
                }
            }))
            .child(Icon::MESSAGE_SQUARE_TEXT.element(px(13.), palette.text_secondary))
            .child(t!("Annotate"));
        Some(
            div()
                .absolute()
                .right(px((width - x1) * scale))
                .top(px(y1 * scale + OFFER_GAP))
                .child(pop_in("pdf-annotate-offer-in", PopFrom::Above, button))
                .into_any_element(),
        )
    }

    /// Open the note on `selected`, with `written` when it is offered back,
    /// and look its words up in the source.
    fn open_composer(
        &mut self,
        selected: Selected,
        written: Option<(String, Option<Intent>)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(source) = self
            .notes_source()
            .filter(|source| source.annotatable)
            .cloned()
        else {
            return;
        };
        self.dismiss_offer(cx);
        let (body, intent) = written.unwrap_or_default();
        let field = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(t!("What should change here?"))
                .auto_grow(2, 8)
                .default_value(body)
        });
        field.update(cx, |field, cx| field.focus(window, cx));
        let subscription =
            cx.subscribe_in(&field, window, |this, _, event, window, cx| match event {
                // ⌘↵ saves; ⇧⌘↵ saves and asks the agent about the note.
                InputEvent::PressEnter {
                    secondary: true, ..
                } => this.save_pdf_note(window.modifiers().shift, window, cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            });
        self.annotating.opened += 1;
        let id = self.annotating.opened;
        let (page, point, text) = (selected.page, selected.point, selected.text.clone());
        let mapping = cx.background_spawn(async move {
            map_selection(&source.root, source.document.as_deref(), page, point, &text)
        });
        let mapping = cx.spawn(async move |this, cx| {
            let mapped = mapping.await;
            this.update(cx, |this, cx| {
                let Some(note) = this.annotating.composing.as_mut().filter(|note| note.id == id)
                else {
                    return;
                };
                match mapped {
                    Ok(mapped) => note.mapped = Some(mapped),
                    Err(Unmapped::Search(error)) => note.error = Some(error.into()),
                    Err(Unmapped::Unread(path)) => {
                        note.error = Some(t!("Lattice could not read {path}.", path = path).into())
                    }
                    Err(Unmapped::Outside(path)) => {
                        note.error = Some(
                            t!(
                                "SyncTeX placed this text outside {path}. Build the PDF again, then annotate.",
                                path = path
                            )
                            .into(),
                        )
                    }
                }
                cx.notify();
            })
            .ok();
        });
        self.annotating.composing = Some(Composing {
            id,
            selected,
            field,
            intent,
            mapped: None,
            error: None,
            _field: subscription,
            _mapping: mapping,
        });
        cx.notify();
    }

    /// Save the note: a local annotation on the span SyncTeX found, kept
    /// where on the page it was made; with `revise`, the agent is asked
    /// about it at once.
    fn save_pdf_note(&mut self, revise: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.notes_source().map(|source| source.root.clone()) else {
            return;
        };
        let sizes = self.page_sizes().to_vec();
        let Some(note) = &mut self.annotating.composing else {
            return;
        };
        let Some(mapped) = &note.mapped else {
            return;
        };
        let body = note.field.read(cx).value().to_string();
        if body.trim().is_empty() && note.intent.is_none() {
            return;
        }
        let Some(&(width, height)) = sizes.get(note.selected.page) else {
            return;
        };
        let author = store::author(&root, cx);
        let made = model::new_note(
            &mapped.path,
            &mapped.source,
            mapped.range.start,
            mapped.range.end,
            &body,
            note.intent,
            &author,
        )
        .map(|mut made| {
            made.pdf = Some(PdfAnchor {
                page: note.selected.page as u32 + 1,
                rects: note
                    .selected
                    .rects
                    .iter()
                    .map(|&[x0, y0, x1, y1]| PdfRect {
                        x: f64::from(x0 / width),
                        y: f64::from(y0 / height),
                        width: f64::from((x1 - x0) / width),
                        height: f64::from((y1 - y0) / height),
                    })
                    .collect(),
                text: note.selected.text.clone(),
            });
            made
        });
        let Some(made) = made else {
            note.error = Some(
                t!("The source changed since the PDF was built. Build again, then annotate.")
                    .into(),
            );
            cx.notify();
            return;
        };
        let store = store::store(cx);
        let Some(id) = store.update(cx, |store, cx| store.add(&root, made, cx)) else {
            return;
        };
        self.annotating.composing = None;
        self.selection = None;
        window.focus(&self.focus_handle, cx);
        cx.emit(PdfViewEvent::Annotation(AnnotationRequest::Created(
            id.clone(),
        )));
        if revise {
            cx.emit(PdfViewEvent::Annotation(AnnotationRequest::Revise(id)));
        }
        cx.notify();
    }

    /// Esc or a click outside closed the note; one with words in it is
    /// offered back, on the same selection. A click outside goes on to do
    /// what it does there.
    fn dismiss_composer(&mut self, outside: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(note) = self.annotating.composing.take() else {
            return;
        };
        if !outside {
            window.focus(&self.focus_handle, cx);
        }
        cx.notify();
        let body = note.field.read(cx).value().to_string();
        if body.trim().is_empty() {
            return;
        }
        let (selected, intent) = (note.selected, note.intent);
        let view = cx.weak_entity();
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
                    let (selected, body) = (selected.clone(), body.clone());
                    view.update(cx, |view, cx| {
                        view.open_composer(selected, Some((body, intent)), window, cx)
                    })
                    .ok();
                },
            )),
            cx,
        );
    }

    /// The note, under the selection on its page and kept there as the PDF
    /// scrolls or zooms; none while the selection is off screen.
    pub(in crate::pdf) fn annotate_composer(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let note = self.annotating.composing.as_ref()?;
        let selected = &note.selected;
        let union = selected.rects.iter().fold(
            (f32::MAX, f32::MAX, f32::MIN, f32::MIN),
            |(left, top, right, bottom), &[x0, y0, x1, y1]| {
                (left.min(x0), top.min(y0), right.max(x1), bottom.max(y1))
            },
        );
        let about = self.page_box_on_window(selected.page, union)?;
        if !self.viewport.intersects(&about) {
            return None;
        }
        let page = selected.page + 1;
        let location: SharedString = match &note.mapped {
            Some(mapped) => {
                let name = Path::new(&mapped.path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                t!(
                    "PDF p.{page} → {name}:{line}",
                    page = page,
                    name = name,
                    line = mapped.line
                )
                .into()
            }
            None => t!("PDF p.{page} → …", page = page).into(),
        };
        let id = note.id;
        let body = form::note_form(
            NoteForm {
                quote: &selected.text,
                location,
                field: &note.field,
                intent: note.intent,
                error: note.error.clone(),
                ready: note.mapped.is_some(),
            },
            Rc::new(|this: &mut Self, intent, _| {
                if let Some(note) = &mut this.annotating.composing {
                    note.intent = intent;
                }
            }),
            Rc::new(|this: &mut Self, revise, window, cx| this.save_pdf_note(revise, window, cx)),
            cx,
        );
        let palette = cx.palette().clone();
        let content = div()
            .id(("pdf-annotation-composer", id as usize))
            .w(COMPOSER_WIDTH)
            .p(SPACING_5)
            .rounded(RADIUS_SURFACE)
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .text_color(palette.text)
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down_out(
                cx.listener(|this, _, window, cx| this.dismiss_composer(true, window, cx)),
            )
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                let keys = &event.keystroke;
                if keys.key == "escape" {
                    cx.stop_propagation();
                    this.dismiss_composer(false, window, cx);
                } else if keys.key == "enter" && keys.modifiers.secondary(cx) {
                    cx.stop_propagation();
                    this.save_pdf_note(keys.modifiers.shift, window, cx);
                }
            }))
            .child(body);
        let painted = self.annotating.composer_bounds.clone();
        Some(self.popup_over(
            SharedString::from(format!("pdf-annotation-composer-{id}")),
            about,
            COMPOSER_WIDTH,
            painted,
            content,
            true,
            window,
            cx,
        ))
    }

    /// Where Annotate stands on the window, for a scenario.
    pub fn annotate_offer_center(&self) -> Option<Point<Pixels>> {
        let offer = self.annotating.offer.as_ref()?;
        let &[_, y0, x1, y1] = offer.selected.rects.last()?;
        let line = self.page_box_on_window(offer.selected.page, (x1, y0, x1, y1))?;
        Some(gpui::point(
            line.right() - px(12.),
            line.bottom() + px(OFFER_GAP + OFFER_HEIGHT / 2.),
        ))
    }

    /// The note being written, for a scenario: its location once mapped,
    /// and its error.
    pub fn annotate_composer_state(&self) -> Option<ComposerState> {
        let note = self.annotating.composing.as_ref()?;
        Some((
            note.mapped
                .as_ref()
                .map(|mapped| (mapped.path.clone(), mapped.line)),
            note.error.as_ref().map(ToString::to_string),
        ))
    }

    /// Write `body` in the note being written, for a scenario.
    pub fn annotate_composer_write(&self, body: &str, window: &mut Window, cx: &mut App) {
        if let Some(note) = &self.annotating.composing {
            note.field.update(cx, |field, cx| {
                field.set_value(body.to_string(), window, cx)
            });
        }
    }

    /// Where on the window the characters of `needle` start and end on
    /// `page`, as read from its text, for a scenario's drag.
    pub fn text_span_points(
        &self,
        page: usize,
        needle: &str,
    ) -> Option<(Point<Pixels>, Point<Pixels>)> {
        let text = self.pages.get(page)?.text.as_ref()?;
        let chars: Vec<char> = text.chars.iter().map(|ch| ch.ch).collect();
        let wanted: Vec<char> = needle.chars().collect();
        if wanted.is_empty() {
            return None;
        }
        let start = (0..=chars.len().checked_sub(wanted.len())?)
            .find(|&at| chars[at..at + wanted.len()] == *wanted)?;
        let (first, last) = (text.chars[start], text.chars[start + wanted.len() - 1]);
        let from = self.page_box_on_window(page, (first.x0, first.y0, first.x0 + 0.5, first.y1))?;
        let to = self.page_box_on_window(page, (last.x1 - 0.5, last.y0, last.x1, last.y1))?;
        Some((
            gpui::point(from.left(), from.center().y),
            gpui::point(to.right(), to.center().y),
        ))
    }
}
