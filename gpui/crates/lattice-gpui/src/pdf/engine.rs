//! PDFium on a thread of its own. PDFium is not thread-safe and its document
//! handles are not `Send`, so one worker owns the library and every open
//! document, and the viewers talk to it through a queue.
//!
//! One worker serves every viewer in the process (the live PDF, the other
//! root documents' tabs, the separate window): PDFium is initialised once
//! per process. Its queue has two lanes. Opening a document, drawing a page
//! and reading a page's text go first; a search reads the pages it has not
//! read yet one at a time behind them, so drawing what is on screen never
//! waits for a long document's search. A draw whose page left the screen
//! before its turn is skipped.

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
};

use anyhow::{Context as _, Result, anyhow};
use futures::channel::oneshot;
use gpui::{App, Global, RenderImage, SharedString};
use pdfium_render::prelude::*;
use smallvec::smallvec;

use super::{
    find::{FindOptions, Match, find_in_page},
    text::{Link, LinkTarget, PageText, TextChar},
};

/// A document the worker holds for one viewer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DocId(u64);

/// What a viewer needs to lay out a document before any page is drawn.
#[derive(Clone, Debug)]
pub struct DocumentInfo {
    /// Bumped on every open, so a draw asked of an older copy of the file
    /// can be told apart from one of the current copy.
    pub generation: u64,
    /// Page sizes in PDF points.
    pub page_sizes: Vec<(f32, f32)>,
}

/// A part of a page drawn at `width_px` device pixels across: the whole
/// page, or the rectangle `region` of it (device pixels from its top-left
/// corner) when the whole page at that size would be too large to hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

pub struct RenderRequest {
    pub doc: DocId,
    pub generation: u64,
    pub page: usize,
    pub width_px: u32,
    pub region: Option<PixelRect>,
    pub dark: bool,
    /// Set by the viewer when the page leaves the screen before its turn.
    pub cancel: Arc<AtomicBool>,
}

pub struct RenderedPage {
    pub image: Arc<RenderImage>,
}

enum Request {
    Open {
        doc: DocId,
        bytes: Vec<u8>,
        reply: oneshot::Sender<Result<DocumentInfo>>,
    },
    Close {
        doc: DocId,
    },
    Render {
        request: RenderRequest,
        reply: oneshot::Sender<Result<RenderedPage>>,
    },
    Text {
        doc: DocId,
        generation: u64,
        page: usize,
        reply: oneshot::Sender<Result<Arc<PageText>>>,
    },
}

/// A search under way: the pages read so far, one more each turn.
struct FindJob {
    doc: DocId,
    generation: u64,
    query: String,
    options: FindOptions,
    next_page: usize,
    matches: Vec<Match>,
    reply: oneshot::Sender<Result<Vec<Match>>>,
}

#[derive(Default)]
struct Queue {
    requests: VecDeque<Request>,
    finds: VecDeque<FindJob>,
    stopped: bool,
}

pub struct PdfEngine {
    queue: Arc<(Mutex<Queue>, Condvar)>,
    next_doc: AtomicU64,
    pub library: PathBuf,
}

struct EngineGlobal(Result<Arc<PdfEngine>, SharedString>);

impl Global for EngineGlobal {}

impl PdfEngine {
    /// The process's worker, started on first use.
    pub fn global(cx: &mut App) -> Result<Arc<PdfEngine>, SharedString> {
        if !cx.has_global::<EngineGlobal>() {
            let engine = PdfEngine::start()
                .map(Arc::new)
                .map_err(|error| SharedString::from(format!("{error:#}")));
            match &engine {
                Ok(engine) => log::info!("PDFium loaded from {}", engine.library.display()),
                Err(error) => log::warn!("{error}"),
            }
            cx.set_global(EngineGlobal(engine));
        }
        cx.global::<EngineGlobal>().0.clone()
    }

    /// Load PDFium and start its worker.
    fn start() -> Result<Self> {
        let library = find_library().ok_or_else(|| {
            anyhow!(
                "PDFium was not found. Run script/fetch-pdfium (macOS) or script/fetch-pdfium.ps1 (Windows), or set PDFIUM_LIBRARY_PATH."
            )
        })?;
        let bindings = Pdfium::bind_to_library(&library)
            .with_context(|| format!("loading {}", library.display()))?;
        let queue: Arc<(Mutex<Queue>, Condvar)> = Arc::default();
        thread::Builder::new().name("pdfium".into()).spawn({
            let queue = queue.clone();
            move || worker(Pdfium::new(bindings), &queue)
        })?;
        Ok(Self {
            queue,
            next_doc: AtomicU64::new(1),
            library,
        })
    }

    pub fn new_document(&self) -> DocId {
        DocId(self.next_doc.fetch_add(1, Ordering::Relaxed))
    }

    fn push(&self, request: Request) {
        let (queue, ready) = &*self.queue;
        if let Ok(mut queue) = queue.lock() {
            queue.requests.push_back(request);
            ready.notify_one();
        }
    }

    /// Show `bytes` as `doc`, in place of what it showed before.
    pub fn open(&self, doc: DocId, bytes: Vec<u8>) -> oneshot::Receiver<Result<DocumentInfo>> {
        let (reply, receiver) = oneshot::channel();
        self.push(Request::Open { doc, bytes, reply });
        receiver
    }

    /// Let `doc` go, with its pages' text.
    pub fn close(&self, doc: DocId) {
        let (queue, ready) = &*self.queue;
        if let Ok(mut queue) = queue.lock() {
            queue.finds.retain(|job| job.doc != doc);
            queue.requests.push_back(Request::Close { doc });
            ready.notify_one();
        }
    }

    pub fn render(&self, request: RenderRequest) -> oneshot::Receiver<Result<RenderedPage>> {
        let (reply, receiver) = oneshot::channel();
        self.push(Request::Render { request, reply });
        receiver
    }

    /// A page's characters with their boxes, and its links.
    pub fn text(
        &self,
        doc: DocId,
        generation: u64,
        page: usize,
    ) -> oneshot::Receiver<Result<Arc<PageText>>> {
        let (reply, receiver) = oneshot::channel();
        self.push(Request::Text {
            doc,
            generation,
            page,
            reply,
        });
        receiver
    }

    /// Every match of `query` in `doc`, in page order. A search asked of
    /// the same document before this one ends unanswered.
    pub fn find(
        &self,
        doc: DocId,
        generation: u64,
        query: String,
        options: FindOptions,
    ) -> oneshot::Receiver<Result<Vec<Match>>> {
        let (reply, receiver) = oneshot::channel();
        let (queue, ready) = &*self.queue;
        if let Ok(mut queue) = queue.lock() {
            queue.finds.retain(|job| job.doc != doc);
            queue.finds.push_back(FindJob {
                doc,
                generation,
                query,
                options,
                next_page: 0,
                matches: Vec::new(),
                reply,
            });
            ready.notify_one();
        }
        receiver
    }
}

impl Drop for PdfEngine {
    fn drop(&mut self) {
        let (queue, ready) = &*self.queue;
        if let Ok(mut queue) = queue.lock() {
            queue.stopped = true;
            ready.notify_one();
        }
    }
}

enum Work {
    Request(Request),
    Find(FindJob),
}

fn next_work(queue: &(Mutex<Queue>, Condvar)) -> Option<Work> {
    let (lock, ready) = queue;
    let mut queue = lock.lock().ok()?;
    loop {
        if queue.stopped {
            return None;
        }
        if let Some(request) = queue.requests.pop_front() {
            return Some(Work::Request(request));
        }
        if let Some(job) = queue.finds.pop_front() {
            return Some(Work::Find(job));
        }
        queue = ready.wait(queue).ok()?;
    }
}

struct Open {
    generation: u64,
    document: PdfDocument<'static>,
    texts: HashMap<usize, Arc<PageText>>,
}

fn worker(pdfium: Pdfium, queue: &(Mutex<Queue>, Condvar)) {
    // The documents borrow the library; both live for the worker's lifetime.
    let pdfium: &'static Pdfium = Box::leak(Box::new(pdfium));
    let mut documents: HashMap<DocId, Open> = HashMap::new();
    let mut generation = 0;

    while let Some(work) = next_work(queue) {
        match work {
            Work::Request(Request::Open { doc, bytes, reply }) => {
                if reply.is_canceled() {
                    continue;
                }
                generation += 1;
                let result = pdfium
                    .load_pdf_from_byte_vec(bytes, None)
                    .map_err(|error| anyhow!("The PDF could not be read: {error}"))
                    .map(|document| {
                        let page_sizes = document
                            .pages()
                            .iter()
                            .map(|page| (page.width().value, page.height().value))
                            .collect();
                        documents.insert(
                            doc,
                            Open {
                                generation,
                                document,
                                texts: HashMap::new(),
                            },
                        );
                        DocumentInfo {
                            generation,
                            page_sizes,
                        }
                    });
                let _ = reply.send(result);
            }
            Work::Request(Request::Close { doc }) => {
                documents.remove(&doc);
            }
            Work::Request(Request::Render { request, reply }) => {
                if request.cancel.load(Ordering::Relaxed) {
                    continue;
                }
                let result = match documents.get(&request.doc) {
                    Some(open) if open.generation == request.generation => {
                        render_page(&open.document, &request).map(|image| RenderedPage { image })
                    }
                    _ => Err(anyhow!("stale render request")),
                };
                let _ = reply.send(result);
            }
            Work::Request(Request::Text {
                doc,
                generation,
                page,
                reply,
            }) => {
                let result = match documents.get_mut(&doc) {
                    Some(open) if open.generation == generation => page_text(open, page),
                    _ => Err(anyhow!("stale text request")),
                };
                let _ = reply.send(result);
            }
            Work::Find(mut job) => {
                let Some(open) = documents
                    .get_mut(&job.doc)
                    .filter(|open| open.generation == job.generation)
                else {
                    let _ = job.reply.send(Err(anyhow!("stale search")));
                    continue;
                };
                let count = open.document.pages().len() as usize;
                if job.next_page < count {
                    if let Ok(text) = page_text(open, job.next_page) {
                        job.matches.extend(
                            find_in_page(&text, &job.query, job.options)
                                .into_iter()
                                .map(|chars| Match {
                                    page: job.next_page,
                                    boxes: text.highlight(chars.clone()),
                                    chars,
                                }),
                        );
                    }
                    job.next_page += 1;
                }
                if job.next_page >= count {
                    let _ = job.reply.send(Ok(job.matches));
                } else if !job.reply.is_canceled() {
                    // Back of its lane: a newer search for the same document
                    // replaced it meanwhile only if it is no longer queued.
                    let (lock, _) = queue;
                    if let Ok(mut queue) = lock.lock()
                        && !queue.finds.iter().any(|other| other.doc == job.doc)
                    {
                        queue.finds.push_back(job);
                    }
                }
            }
        }
    }
}

/// Draw a page, or the part of it the request names, into an image GPUI can
/// upload: PDFium's bitmaps are BGRA, which is the byte order GPUI uploads.
fn render_page(document: &PdfDocument, request: &RenderRequest) -> Result<Arc<RenderImage>> {
    let page = document
        .pages()
        .get(request.page as PdfPageIndex)
        .map_err(|error| anyhow!("page {}: {error}", request.page))?;
    let config = PdfRenderConfig::new()
        .set_target_width(request.width_px as Pixels)
        .render_form_data(true)
        .render_annotations(true);
    let (width, height, mut bytes) = match request.region {
        None => {
            let bitmap = page
                .render_with_config(&config)
                .map_err(|error| anyhow!("rendering: {error}"))?;
            (
                bitmap.width() as u32,
                bitmap.height() as u32,
                bitmap.as_raw_bytes(),
            )
        }
        Some(region) => {
            let mut bitmap = PdfBitmap::empty(
                region.w as Pixels,
                region.h as Pixels,
                PdfBitmapFormat::BGRA,
            )
            .map_err(|error| anyhow!("a bitmap for page {}: {error}", request.page))?;
            let config = config.set_origin(-(region.x as Pixels), -(region.y as Pixels));
            page.render_into_bitmap_with_config(&mut bitmap, &config)
                .map_err(|error| anyhow!("rendering: {error}"))?;
            (region.w, region.h, bitmap.as_raw_bytes())
        }
    };
    if request.dark {
        super::dark::darken_bgra(&mut bytes);
    }
    let buffer = image::RgbaImage::from_raw(width, height, bytes)
        .ok_or_else(|| anyhow!("PDFium returned a short bitmap"))?;
    Ok(Arc::new(RenderImage::new(smallvec![image::Frame::new(
        buffer
    )])))
}

/// A page's text and links, read once per document copy.
fn page_text(open: &mut Open, index: usize) -> Result<Arc<PageText>> {
    if let Some(text) = open.texts.get(&index) {
        return Ok(text.clone());
    }
    let page = open
        .document
        .pages()
        .get(index as PdfPageIndex)
        .map_err(|error| anyhow!("page {index}: {error}"))?;
    let on_page = PageSpace::of(&page);
    let flip = |rect: PdfRect| {
        let (x0, y0) = on_page.to_view(rect.left().value, rect.top().value);
        let (x1, y1) = on_page.to_view(rect.right().value, rect.bottom().value);
        (x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1))
    };
    let mut chars = Vec::new();
    if let Ok(text) = page.text() {
        for ch in text.chars().iter() {
            let Some(unicode) = ch.unicode_char() else {
                continue;
            };
            let generated = ch.is_generated().unwrap_or(false);
            let (x0, y0, x1, y1) = ch
                .loose_bounds()
                .ok()
                .filter(|_| !matches!(unicode, '\r' | '\n'))
                .map(flip)
                .unwrap_or_default();
            chars.push(TextChar {
                ch: unicode,
                x0,
                y0,
                x1,
                y1,
                generated,
            });
        }
    }
    let pages = open.document.pages();
    let mut links = Vec::new();
    for link in page.links().iter() {
        let Ok(rect) = link.rect() else {
            continue;
        };
        // Where a destination points: its page, and the point the link names
        // to bring to the top of the view, from the page's top-left corner.
        let place = |destination: PdfDestination| {
            let page = destination.page_index().ok()? as usize;
            let target = pages
                .get(page as PdfPageIndex)
                .map(|page| PageSpace::of(&page))
                .unwrap_or(on_page);
            let (x, y) = match destination.view_settings().ok()? {
                PdfDestinationViewSettings::SpecificCoordinatesAndZoom(x, y, _) => {
                    (x.map(|x| x.value), y.map(|y| y.value))
                }
                PdfDestinationViewSettings::FitPageHorizontallyToWindow(y)
                | PdfDestinationViewSettings::FitBoundsHorizontallyToWindow(y) => {
                    (None, y.map(|y| y.value))
                }
                _ => (None, None),
            };
            let (x, y) = target.point_to_view(x, y);
            Some(LinkTarget::Page { page, x, y })
        };
        let target = link.destination().and_then(place).or_else(|| {
            let action = link.action()?;
            if let Some(local) = action.as_local_destination_action() {
                return local.destination().ok().and_then(place);
            }
            let uri = action.as_uri_action()?.uri().ok()?;
            super::text::openable_uri(&uri).then_some(LinkTarget::Uri(uri))
        });
        let Some(target) = target else {
            continue;
        };
        let (x0, y0, x1, y1) = flip(rect);
        links.push(Link {
            x0,
            y0,
            x1,
            y1,
            target,
        });
    }
    let text = Arc::new(PageText { chars, links });
    open.texts.insert(index, text.clone());
    Ok(text)
}

/// How a page's user space (PDF points, y up, `/Rotate` not applied) maps
/// onto the page as shown: points from its top-left corner, y down, turned
/// by `/Rotate` and cut to its crop box, as PDFium draws it.
#[derive(Clone, Copy)]
struct PageSpace {
    left: f32,
    bottom: f32,
    right: f32,
    top: f32,
    quarter_turns: u8,
}

impl PageSpace {
    fn of(page: &PdfPage) -> Self {
        let (left, bottom, right, top) = match page.boundaries().bounding() {
            Ok(bounds) => (
                bounds.bounds.left().value,
                bounds.bounds.bottom().value,
                bounds.bounds.right().value,
                bounds.bounds.top().value,
            ),
            Err(_) => (0., 0., page.width().value, page.height().value),
        };
        let quarter_turns = match page.rotation() {
            Ok(PdfPageRenderRotation::Degrees90) => 1,
            Ok(PdfPageRenderRotation::Degrees180) => 2,
            Ok(PdfPageRenderRotation::Degrees270) => 3,
            _ => 0,
        };
        Self {
            left,
            bottom,
            right,
            top,
            quarter_turns,
        }
    }

    /// `(x, y)` in user space, on the page as shown. `/Rotate` turns the
    /// page clockwise.
    fn to_view(self, x: f32, y: f32) -> (f32, f32) {
        match self.quarter_turns {
            1 => (y - self.bottom, x - self.left),
            2 => (self.right - x, y - self.bottom),
            3 => (self.top - y, self.right - x),
            _ => (x - self.left, self.top - y),
        }
    }

    /// A destination's point, either coordinate of which may be left open,
    /// on the page as shown: an open coordinate stays open on the axis it
    /// lands on.
    fn point_to_view(self, x: Option<f32>, y: Option<f32>) -> (Option<f32>, Option<f32>) {
        let (u, v) = self.to_view(x.unwrap_or(self.left), y.unwrap_or(self.top));
        let (has_u, has_v) = if self.quarter_turns % 2 == 1 {
            (y.is_some(), x.is_some())
        } else {
            (x.is_some(), y.is_some())
        };
        (has_u.then_some(u), has_v.then_some(v))
    }
}

/// `PDFIUM_LIBRARY_PATH` (the library or its folder), then beside the
/// executable (and `../Frameworks` in a macOS bundle), then the copy
/// `script/fetch-pdfium` puts in `vendor/pdfium`.
fn find_library() -> Option<PathBuf> {
    let name = Pdfium::pdfium_platform_library_name();
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PDFIUM_LIBRARY_PATH").map(PathBuf::from) {
        if path.is_dir() {
            candidates.push(path.join(&name));
        } else {
            candidates.push(path);
        }
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        candidates.push(dir.join(&name));
        candidates.push(dir.join("../Frameworks").join(&name));
    }
    let vendor = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/pdfium");
    let platform = if cfg!(target_os = "windows") {
        "win-x64/bin"
    } else if cfg!(target_arch = "aarch64") {
        "mac-arm64/lib"
    } else {
        "mac-x64/lib"
    };
    candidates.push(vendor.join(platform).join(&name));
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::PageSpace;

    // A Letter page whose crop box starts at (10, 20), as `/CropBox
    // [10 20 622 812]` names it.
    fn letter(quarter_turns: u8) -> PageSpace {
        PageSpace {
            left: 10.,
            bottom: 20.,
            right: 622.,
            top: 812.,
            quarter_turns,
        }
    }

    #[test]
    fn an_unturned_page_measures_from_its_crop_box_top_left() {
        assert_eq!(letter(0).to_view(10., 812.), (0., 0.));
        assert_eq!(letter(0).to_view(622., 20.), (612., 792.));
    }

    // PDF 32000-1 §7.7.3.3: `/Rotate` turns the page clockwise when shown.
    #[test]
    fn a_quarter_turn_puts_the_top_left_corner_at_the_top_right() {
        let page = letter(1);
        // Shown 792 wide and 612 tall.
        assert_eq!(page.to_view(10., 812.), (792., 0.));
        assert_eq!(page.to_view(10., 20.), (0., 0.));
        assert_eq!(page.to_view(622., 20.), (0., 612.));
    }

    #[test]
    fn half_and_three_quarter_turns_move_the_top_left_corner_round() {
        assert_eq!(letter(2).to_view(10., 812.), (612., 792.));
        assert_eq!(letter(3).to_view(10., 812.), (0., 612.));
    }

    #[test]
    fn a_destinations_open_coordinate_follows_its_axis_round_a_turn() {
        // A `/FitH 812` destination names only the top: on a quarter-turned
        // page that is a place across the page, with the height left open.
        assert_eq!(
            letter(1).point_to_view(None, Some(812.)),
            (Some(792.), None)
        );
        assert_eq!(letter(0).point_to_view(None, Some(812.)), (None, Some(0.)));
    }
}
