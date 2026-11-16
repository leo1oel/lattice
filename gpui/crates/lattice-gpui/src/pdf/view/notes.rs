//! The project's annotations drawn on the PDF, as the Tauri app's
//! `pdf-annotations.tsx` draws them: every open, numbered note made on the
//! PDF or in a .tex file is an amber highlight over the words it quotes,
//! with its numbered pin in the margin beside its column (blue while the
//! agent's proposal waits, violet while its question does). A note made on
//! the PDF is drawn on the page it was made on; one made in a .tex file
//! where SyncTeX puts its first line in the last build
//! (`annotation_place.rs`). Resting the pointer on a highlight or its pin
//! lights it; a click opens its comment card, the source editor's, with
//! Resolve and Reply; Escape or a click elsewhere closes it.
//!
//! Each note is placed again whenever the PDF is read anew (a rebuild moves
//! the words its marks cover), off the main thread: a note keeps its last
//! place until it is placed on the new document.

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, Pixels,
    SharedString, Styled as _, Task, div, px,
};
use lattice_core::project::EditorComment;
use lattice_ui::ActiveLattice as _;

use super::{hover_card::CardBounds, *};
use crate::{
    annotations::{
        AnnotationRequest,
        card::{self, CardEvent, PIN},
        colors,
        model::{self, Status},
    },
    pdf::{
        annotation_place::{self, Band, MarkPlace, MarkReader, Side, SyncBox},
        engine::DocId,
        text::PageText,
    },
};

/// The gap between a pin and its column's edge, and between stacked pins.
const PIN_GAP: f32 = 4.;

/// What the host tells the PDF of the project's notes: the project, the
/// root document whose PDF this is (`None`: the compiled one), the notes,
/// and whether new ones are made here.
#[derive(Clone)]
pub struct PdfNotes {
    pub root: PathBuf,
    pub document: Option<String>,
    pub notes: Arc<Vec<EditorComment>>,
    /// Whether text selected here may be annotated: the notes are local
    /// annotations (a project linked to Overleaf comments there instead).
    pub annotatable: bool,
}

/// Whether the PDF draws `note`: open and numbered, made on the PDF or in a
/// .tex file, whose text TeX typesets (`drawnOnPdf`).
pub fn drawn_on_pdf(note: &EditorComment) -> bool {
    !note.resolved
        && note.number > 0
        && (note.pdf.is_some() || note.path.to_ascii_lowercase().ends_with(".tex"))
}

/// Each annotated source file's text, by path (`None` when unreadable).
type BuiltSources = HashMap<String, Option<String>>;

/// What a note's place depends on, besides the document: the note, its
/// range and its quote.
type PlaceKey = (String, u32, u32, String);

/// Each note's place (`None`: it has none on the document), by what it was
/// placed from.
type PlaceCache = HashMap<PlaceKey, Option<MarkPlace>>;

fn place_key(note: &EditorComment) -> PlaceKey {
    (note.id.clone(), note.from, note.to, note.quote.clone())
}

#[derive(Default)]
pub(in crate::pdf) struct NoteMarks {
    source: Option<PdfNotes>,
    /// Where each note is drawn, by id, and the document generation and
    /// notes they were placed for.
    places: HashMap<String, MarkPlace>,
    placed_for: Option<(u64, usize)>,
    /// The places found on a generation, so a new list of notes places only
    /// the notes that changed.
    cache: Option<(u64, Arc<PlaceCache>)>,
    /// Each annotated source file's text as the PDF arrived (what it was
    /// built from), by path, for the generation it was read for.
    built: Option<(u64, Arc<BuiltSources>)>,
    task: Option<Task<()>>,
    /// The note under the pointer, and the note whose card is open.
    hovered: Option<String>,
    card: Option<String>,
    card_bounds: CardBounds,
    /// Whether the project has local (numbered) notes, resolved ones too.
    numbered: bool,
    /// Counts the notes handed over, so a new list is placed again.
    revision: usize,
}

/// Reads pages through the engine and SyncTeX through lattice-core, off the
/// main thread.
pub(in crate::pdf) struct Reader {
    engine: Arc<PdfEngine>,
    doc: DocId,
    generation: u64,
    sizes: Vec<(f32, f32)>,
    root: PathBuf,
    document: Option<String>,
    path: String,
    texts: HashMap<usize, Option<Arc<PageText>>>,
}

impl Reader {
    /// A reader of copy `generation` of `doc`, whose pages are `sizes`
    /// points, built from `root` (`document`: a root document's own PDF).
    pub(in crate::pdf) fn new(
        engine: Arc<PdfEngine>,
        doc: DocId,
        generation: u64,
        sizes: Vec<(f32, f32)>,
        root: PathBuf,
        document: Option<String>,
    ) -> Self {
        Self {
            engine,
            doc,
            generation,
            sizes,
            root,
            document,
            path: String::new(),
            texts: HashMap::new(),
        }
    }

    /// SyncTeX looks up lines of `path` (project-relative) from here on.
    pub(in crate::pdf) fn set_path(&mut self, path: &str) {
        self.path = path.to_string();
    }
}

impl MarkReader for Reader {
    fn page_count(&self) -> usize {
        self.sizes.len()
    }

    fn page(&mut self, page: usize) -> Option<(Arc<PageText>, (f32, f32))> {
        let size = *self.sizes.get(page)?;
        let text = self
            .texts
            .entry(page)
            .or_insert_with(|| {
                futures::executor::block_on(self.engine.text(self.doc, self.generation, page))
                    .ok()
                    .and_then(Result::ok)
            })
            .clone()?;
        Some((text, size))
    }

    fn sync(&mut self, line: u32, column: u32) -> Option<SyncBox> {
        let target = lattice_core::latex::forward_search_in(
            &self.root,
            &self.path,
            line,
            column,
            self.document.as_deref(),
        )
        .ok()??;
        Some(SyncBox {
            page: (target.page as usize).checked_sub(1)?,
            x: target.x as f32,
            y: target.y as f32,
            width: target.width as f32,
            height: target.height as f32,
        })
    }
}

impl PdfView {
    /// Whether Export review PDF… is offered (`None`: this PDF shows no
    /// project's notes) and has local notes to export, resolved ones too.
    pub(in crate::pdf) fn has_local_notes(&self) -> Option<bool> {
        self.notes.source.as_ref().map(|_| self.notes.numbered)
    }

    /// The project's notes, as the host last told them.
    pub(in crate::pdf) fn notes_source(&self) -> Option<&PdfNotes> {
        self.notes.source.as_ref()
    }

    /// Tell the viewer the project's notes; `None` draws none.
    pub fn set_notes(&mut self, source: Option<PdfNotes>, cx: &mut Context<Self>) {
        let marks = &mut self.notes;
        marks.revision += 1;
        marks.numbered = source
            .as_ref()
            .is_some_and(|source| source.notes.iter().any(|note| note.number > 0));
        marks.source = source.map(|source| PdfNotes {
            notes: Arc::new(
                source
                    .notes
                    .iter()
                    .filter(|note| drawn_on_pdf(note))
                    .cloned()
                    .collect(),
            ),
            ..source
        });
        let drawn = |id: &Option<String>| {
            id.as_ref().is_some_and(|id| {
                marks
                    .source
                    .as_ref()
                    .is_some_and(|source| source.notes.iter().any(|note| &note.id == id))
            })
        };
        if !drawn(&marks.hovered) {
            marks.hovered = None;
        }
        if !drawn(&marks.card) {
            marks.card = None;
        }
        if marks
            .source
            .as_ref()
            .is_none_or(|source| source.notes.is_empty())
        {
            marks.places.clear();
        }
        self.end_annotating();
        cx.notify();
    }

    /// Each frame: the notes are placed again once the document or the
    /// notes changed.
    pub(in crate::pdf) fn place_notes(&mut self, cx: &mut Context<Self>) {
        let (Some(document), Ok(engine), Some(doc)) = (&self.document, &self.engine, self.doc)
        else {
            return;
        };
        let Some(source) = self
            .notes
            .source
            .clone()
            .filter(|source| !source.notes.is_empty())
        else {
            return;
        };
        let generation = document.info.generation;
        let now = (generation, self.notes.revision);
        if self.notes.placed_for == Some(now) || self.loading {
            return;
        }
        self.notes.placed_for = Some(now);
        // The annotated files as this PDF arrived: what it was built from.
        // A file first annotated later is read when its first note comes.
        let mut built = match &self.notes.built {
            Some((at, built)) if *at == generation => built.clone(),
            _ => Arc::default(),
        };
        for note in source.notes.iter().filter(|note| note.pdf.is_none()) {
            if !built.contains_key(&note.path) {
                let text = std::fs::read_to_string(source.root.join(&note.path)).ok();
                Arc::make_mut(&mut built).insert(note.path.clone(), text);
            }
        }
        self.notes.built = Some((generation, built.clone()));
        let cache = match &self.notes.cache {
            Some((at, cache)) if *at == generation => cache.clone(),
            _ => Arc::default(),
        };
        let engine = engine.clone();
        let sizes = document.info.page_sizes.clone();
        let job = cx.background_spawn(async move {
            place_all(&source, &engine, doc, generation, sizes, &built, &cache)
        });
        self.notes.task = Some(cx.spawn(async move |this, cx| {
            let (places, cache) = job.await;
            this.update(cx, |this, cx| {
                if this.notes.placed_for == Some(now) {
                    this.notes.places = places;
                    this.notes.cache = Some((generation, Arc::new(cache)));
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// The note whose highlight or pin is at a window `position`.
    fn note_at(&self, position: Point<Pixels>) -> Option<String> {
        let (x, y) = self.sheet_point(position);
        let (page, page_x, page_y) = self.layout.page_point_near(x, y)?;
        let size = *self.page_sizes().get(page)?;
        let (fx, fy) = (page_x / size.0, page_y / size.1);
        let scale = self.layout.scale;
        self.pins_on_page(page, size)
            .into_iter()
            .find_map(|(note, place, (pin_x, pin_y))| {
                let on_band = place.bands.iter().any(|band| {
                    fx >= band.x
                        && fx <= band.x + band.width
                        && fy >= band.y
                        && fy <= band.y + band.height
                });
                let on_pin = page_x * scale >= pin_x
                    && page_x * scale <= pin_x + PIN
                    && page_y * scale >= pin_y
                    && page_y * scale <= pin_y + PIN;
                (on_band || on_pin).then(|| note.id.clone())
            })
    }

    /// The notes placed on page `page` (of `size`), in the order they are
    /// drawn, each with its pin's top-left on the page at the current scale.
    /// Pins of passages starting on one line stand side by side, outward
    /// from the column.
    fn pins_on_page(
        &self,
        page: usize,
        size: (f32, f32),
    ) -> Vec<(&EditorComment, &MarkPlace, (f32, f32))> {
        let Some(source) = &self.notes.source else {
            return Vec::new();
        };
        let scale = self.layout.scale;
        let mut rows: HashMap<(Side, i32), usize> = HashMap::new();
        source
            .notes
            .iter()
            .filter_map(|note| {
                let place = self
                    .notes
                    .places
                    .get(&note.id)
                    .filter(|place| place.page == page)?;
                let row = (place.pin.side, (place.pin.y * 200.).round() as i32);
                let stack = rows.entry(row).or_default();
                let origin = pin_origin(place, size, scale, *stack);
                *stack += 1;
                Some((note, place, origin))
            })
            .collect()
    }

    /// The pointer moved over the pages: the note under it lights.
    pub(in crate::pdf) fn hover_note(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        if self.notes.places.is_empty() {
            return;
        }
        let under = self.note_at(position);
        if under != self.notes.hovered {
            self.notes.hovered = under.clone();
            self.rest_on_note(under, cx);
            cx.notify();
        }
    }

    /// The pointer left the pages: no note is lit.
    pub(in crate::pdf) fn leave_notes(&mut self, cx: &mut Context<Self>) {
        if self.notes.hovered.take().is_some() {
            self.rest_on_note(None, cx);
            cx.notify();
        }
    }

    /// A click on the pages (not a drag that selected): a note's highlight or
    /// pin opens its card; anywhere else closes the card. True when it took
    /// the click.
    pub(in crate::pdf) fn click_note(
        &mut self,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) -> bool {
        let under = self.note_at(position);
        let took = under.is_some();
        if self.notes.card != under {
            self.notes.card = under;
            cx.notify();
        }
        took
    }

    /// Whether a window `position` is on the open note's card.
    pub(in crate::pdf) fn on_note_card(&self, position: Point<Pixels>) -> bool {
        self.notes.card.is_some()
            && self
                .notes
                .card_bounds
                .get()
                .is_some_and(|card| card.contains(&position))
    }

    /// Escape: the open card closes; true when one was open.
    pub(in crate::pdf) fn close_note_card(&mut self, cx: &mut Context<Self>) -> bool {
        let had = self.notes.card.take().is_some();
        if had {
            cx.notify();
        }
        had
    }

    /// The marks on page `page` (`rect`'s size at `scale`): each placed
    /// note's highlight and pin, the hovered or open one lit.
    pub(in crate::pdf) fn note_marks(&self, page: usize, cx: &App) -> Vec<AnyElement> {
        let Some(size) = self.page_sizes().get(page).copied() else {
            return Vec::new();
        };
        let palette = cx.palette().clone();
        let scale = self.layout.scale;
        let (w, h) = (size.0 * scale, size.1 * scale);
        let mut out = Vec::new();
        for (note, place, (x, y)) in self.pins_on_page(page, size) {
            let status = Status::of(note);
            let colors = colors::mark(status, &palette);
            let lit = self.notes.hovered.as_deref() == Some(note.id.as_str())
                || self.notes.card.as_deref() == Some(note.id.as_str());
            let tint = if lit {
                colors.tint.opacity(colors.tint.a * 2.4)
            } else {
                colors.tint
            };
            for band in &place.bands {
                out.push(
                    div()
                        .absolute()
                        .left(px(band.x * w))
                        .top(px(band.y * h))
                        .w(px(band.width * w))
                        .h(px(band.height * h))
                        .bg(tint)
                        .border_b_1()
                        .border_color(colors.rule)
                        .into_any_element(),
                );
            }
            out.push(
                div()
                    .absolute()
                    .left(px(x))
                    .top(px(y))
                    .cursor_pointer()
                    .child(card::pin(note.number, status, PIN, cx))
                    .into_any_element(),
            );
        }
        out
    }

    /// The open note's card over its passage; `None` when none is open or
    /// it has no place on the pages shown.
    pub(in crate::pdf) fn note_card_element(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        // With the comment column open, the card stands there.
        if self.column_open() {
            return None;
        }
        let id = self.notes.card.clone()?;
        let note = self
            .notes
            .source
            .as_ref()?
            .notes
            .iter()
            .find(|note| note.id == id)?
            .clone();
        let place = self.notes.places.get(&id)?;
        let first: Band = *place.bands.first()?;
        let size = *self.page_sizes().get(place.page)?;
        let about = self.page_box_on_window(
            place.page,
            (
                first.x * size.0,
                first.y * size.1,
                (first.x + first.width) * size.0,
                (first.y + first.height) * size.1,
            ),
        )?;
        let on = self.note_card_action(cx);
        let content = div()
            .id("pdf-note-card")
            .occlude()
            .child(card::comment_card(&[note], on, px(320.), cx));
        let painted = self.notes.card_bounds.clone();
        let id = SharedString::from(format!("pdf-note-{id}"));
        Some(self.hover_card(id, about, px(320.), painted, content, window, cx))
    }

    /// What a note's card asks (Resolve, Reply) goes to the host, and the
    /// card closes.
    pub(in crate::pdf) fn note_card_action(&self, cx: &mut Context<Self>) -> card::CardAction {
        let view = cx.entity().downgrade();
        std::rc::Rc::new(move |event, _, cx| {
            let request = match event {
                CardEvent::Resolve(id) => AnnotationRequest::Resolve(id),
                CardEvent::Reply(id) => AnnotationRequest::Reply(id),
            };
            view.update(cx, |this, cx| {
                this.notes.card = None;
                cx.emit(PdfViewEvent::Annotation(request));
                cx.notify();
            })
            .ok();
        })
    }

    /// The notes drawn on the pages with where, in reading order: by page,
    /// then down it (the comment column's order).
    pub(in crate::pdf) fn placed_notes(&self) -> Vec<(EditorComment, MarkPlace)> {
        let Some(source) = &self.notes.source else {
            return Vec::new();
        };
        let mut placed: Vec<_> = source
            .notes
            .iter()
            .filter_map(|note| Some((note.clone(), self.notes.places.get(&note.id)?.clone())))
            .collect();
        placed.sort_by(|(_, a), (_, b)| a.page.cmp(&b.page).then(a.pin.y.total_cmp(&b.pin.y)));
        placed
    }

    /// Open `id`'s card (`None` closes it).
    pub(in crate::pdf) fn open_note_card(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        if self.notes.card != id {
            self.notes.card = id;
            cx.notify();
        }
    }

    /// Light `id`'s passage, as the pointer over its card in the column does.
    pub(in crate::pdf) fn light_note(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        if self.notes.hovered != id {
            self.notes.hovered = id;
            cx.notify();
        }
    }

    /// The window bounds of `id`'s first band, what its popups stand over.
    pub(in crate::pdf) fn note_passage_on_window(&self, id: &str) -> Option<Bounds<Pixels>> {
        let place = self.notes.places.get(id)?;
        let first: Band = *place.bands.first()?;
        let size = *self.page_sizes().get(place.page)?;
        self.page_box_on_window(
            place.page,
            (
                first.x * size.0,
                first.y * size.1,
                (first.x + first.width) * size.0,
                (first.y + first.height) * size.1,
            ),
        )
    }

    /// The notes placed, and the note whose card is open, for a scenario.
    pub fn note_places(&self) -> Vec<(String, MarkPlace)> {
        let mut places: Vec<_> = self.notes.places.clone().into_iter().collect();
        places.sort_by(|a, b| a.0.cmp(&b.0));
        places
    }

    pub fn note_card(&self) -> Option<&str> {
        self.notes.card.as_deref()
    }

    /// The note lit by the pointer, for a scenario.
    pub fn note_hovered(&self) -> Option<&str> {
        self.notes.hovered.as_deref()
    }

    /// Where on the window a placed note's pin centres, as it is drawn
    /// (stacked beside the pins of passages on its line), for a scenario.
    pub fn note_pin_center(&self, id: &str) -> Option<Point<Pixels>> {
        let page = self.notes.places.get(id)?.page;
        let size = *self.page_sizes().get(page)?;
        let scale = self.layout.scale;
        let (_, _, (x, y)) = self
            .pins_on_page(page, size)
            .into_iter()
            .find(|(note, _, _)| note.id == id)?;
        let bounds = self.page_box_on_window(
            page,
            (x / scale, y / scale, (x + PIN) / scale, (y + PIN) / scale),
        )?;
        Some(bounds.center())
    }

    /// Where on the window a placed note's first band centres, for a
    /// scenario.
    pub fn note_center(&self, id: &str) -> Option<Point<Pixels>> {
        let place = self.notes.places.get(id)?;
        let band = place.bands.first()?;
        let size = *self.page_sizes().get(place.page)?;
        let bounds = self.page_box_on_window(
            place.page,
            (
                band.x * size.0,
                band.y * size.1,
                (band.x + band.width) * size.0,
                (band.y + band.height) * size.1,
            ),
        )?;
        Some(bounds.center())
    }
}

/// A pin's top-left on its page (pixels at `scale`), `stack` places outward.
fn pin_origin(place: &MarkPlace, size: (f32, f32), scale: f32, stack: usize) -> (f32, f32) {
    let x = place.pin.x * size.0 * scale;
    let y = place.pin.y * size.1 * scale - PIN / 2.;
    let step = (PIN + PIN_GAP) * stack as f32;
    match place.pin.side {
        Side::Start => (x - PIN_GAP - PIN - step, y),
        Side::End => (x + PIN_GAP + step, y),
    }
}

/// Every note's place on the document (off the main thread), and the cache
/// of the current notes' places; a note already in `cache` is not placed
/// again.
fn place_all(
    source: &PdfNotes,
    engine: &Arc<PdfEngine>,
    doc: DocId,
    generation: u64,
    sizes: Vec<(f32, f32)>,
    built: &BuiltSources,
    cache: &PlaceCache,
) -> (HashMap<String, MarkPlace>, PlaceCache) {
    let mut reader = Reader {
        engine: engine.clone(),
        doc,
        generation,
        sizes,
        root: source.root.clone(),
        document: source.document.clone(),
        path: String::new(),
        texts: HashMap::new(),
    };
    let mut places = HashMap::new();
    let mut placed = PlaceCache::new();
    for note in source.notes.iter() {
        let key = place_key(note);
        if let Some(place) = cache.get(&key) {
            if let Some(place) = place {
                places.insert(note.id.clone(), place.clone());
            }
            placed.insert(key, place.clone());
            continue;
        }
        let place = match &note.pdf {
            Some(anchor) => {
                let page = (anchor.page as usize).checked_sub(1);
                page.and_then(|page| {
                    let (text, size) = reader.page(page)?;
                    let saved: Vec<Band> = anchor
                        .rects
                        .iter()
                        .map(|rect| Band {
                            x: rect.x as f32,
                            y: rect.y as f32,
                            width: rect.width as f32,
                            height: rect.height as f32,
                        })
                        .collect();
                    annotation_place::place_pdf_mark(
                        page,
                        &text,
                        size,
                        &note.quote,
                        &anchor.text,
                        &saved,
                    )
                })
            }
            None => {
                reader.path = note.path.clone();
                std::fs::read_to_string(source.root.join(&note.path))
                    .ok()
                    .and_then(|text| {
                        let range = model::anchor_of(&text, note)?;
                        let as_built = annotation_place::lines_as_built(
                            &text,
                            built.get(&note.path).and_then(Option::as_deref),
                            range.end,
                        );
                        annotation_place::place_source_mark(
                            &note.quote,
                            &text,
                            range,
                            as_built,
                            &mut reader,
                        )
                    })
            }
        };
        if let Some(place) = &place {
            places.insert(note.id.clone(), place.clone());
        }
        placed.insert(key, place);
    }
    (places, placed)
}
