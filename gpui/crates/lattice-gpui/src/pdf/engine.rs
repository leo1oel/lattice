//! PDFium on a thread of its own. PDFium is not thread-safe and its document
//! handles are not `Send`, so one worker owns the library and the open
//! document, and the UI talks to it through a channel.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    thread,
};

use anyhow::{Context as _, Result, anyhow};
use futures::channel::oneshot;
use gpui::RenderImage;
use pdfium_render::prelude::*;
use smallvec::smallvec;

/// What the UI needs to lay out a document before any page is drawn.
#[derive(Clone, Debug)]
pub struct DocumentInfo {
    /// Bumped on every open, so a render requested for an older copy of the
    /// file can be told apart from one for the current copy.
    pub generation: u64,
    /// Page sizes in PDF points.
    pub page_sizes: Vec<(f32, f32)>,
}

pub struct RenderedPage {
    pub generation: u64,
    pub page: usize,
    pub width_px: u32,
    pub image: Arc<RenderImage>,
}

enum Request {
    Open {
        path: PathBuf,
        reply: oneshot::Sender<Result<DocumentInfo>>,
    },
    Render {
        generation: u64,
        page: usize,
        width_px: u32,
        reply: oneshot::Sender<Result<RenderedPage>>,
    },
}

pub struct PdfEngine {
    requests: mpsc::Sender<Request>,
    pub library: PathBuf,
}

impl PdfEngine {
    /// Load PDFium and start its worker.
    pub fn start() -> Result<Self> {
        let library = find_library().ok_or_else(|| {
            anyhow!(
                "PDFium was not found. Run script/fetch-pdfium (macOS) or script/fetch-pdfium.ps1 (Windows), or set PDFIUM_LIBRARY_PATH."
            )
        })?;
        let bindings = Pdfium::bind_to_library(&library)
            .with_context(|| format!("loading {}", library.display()))?;
        let (requests, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("pdfium".into())
            .spawn(move || worker(Pdfium::new(bindings), receiver))?;
        Ok(Self { requests, library })
    }

    pub fn open(&self, path: PathBuf) -> oneshot::Receiver<Result<DocumentInfo>> {
        let (reply, receiver) = oneshot::channel();
        let _ = self.requests.send(Request::Open { path, reply });
        receiver
    }

    pub fn render(
        &self,
        generation: u64,
        page: usize,
        width_px: u32,
    ) -> oneshot::Receiver<Result<RenderedPage>> {
        let (reply, receiver) = oneshot::channel();
        let _ = self.requests.send(Request::Render {
            generation,
            page,
            width_px,
            reply,
        });
        receiver
    }
}

fn worker(pdfium: Pdfium, requests: mpsc::Receiver<Request>) {
    // The document borrows the library; both live for the worker's lifetime.
    let pdfium: &'static Pdfium = Box::leak(Box::new(pdfium));
    let mut document: Option<(u64, PdfDocument<'static>)> = None;
    let mut generation = 0;

    while let Ok(request) = requests.recv() {
        match request {
            Request::Open { path, reply } => {
                generation += 1;
                // The bytes are read up front rather than streamed from the
                // file: latexmk rewrites the PDF in place during the next
                // build, and on Windows an open handle would block it.
                let opened = std::fs::read(&path)
                    .with_context(|| format!("reading {}", path.display()))
                    .and_then(|bytes| {
                        pdfium
                            .load_pdf_from_byte_vec(bytes, None)
                            .map_err(|error| anyhow!("opening {}: {error}", path.display()))
                    });
                let result = opened.map(|opened| {
                    let page_sizes = opened
                        .pages()
                        .iter()
                        .map(|page| (page.width().value, page.height().value))
                        .collect();
                    document = Some((generation, opened));
                    DocumentInfo {
                        generation,
                        page_sizes,
                    }
                });
                let _ = reply.send(result);
            }
            Request::Render {
                generation: wanted,
                page,
                width_px,
                reply,
            } => {
                let result = match &document {
                    Some((current, document)) if *current == wanted => {
                        render_page(document, page, width_px).map(|image| RenderedPage {
                            generation: wanted,
                            page,
                            width_px,
                            image,
                        })
                    }
                    _ => Err(anyhow!("stale render request")),
                };
                let _ = reply.send(result);
            }
        }
    }
}

fn render_page(document: &PdfDocument, page: usize, width_px: u32) -> Result<Arc<RenderImage>> {
    let page = document
        .pages()
        .get(page as PdfPageIndex)
        .map_err(|error| anyhow!("page {page}: {error}"))?;
    let config = PdfRenderConfig::new()
        .set_target_width(width_px as Pixels)
        .render_form_data(true);
    let bitmap = page
        .render_with_config(&config)
        .map_err(|error| anyhow!("rendering: {error}"))?;
    let (width, height) = (bitmap.width() as u32, bitmap.height() as u32);
    // PDFium's bitmaps are BGRA, which is the byte order GPUI uploads.
    let bytes = bitmap.as_raw_bytes();
    let buffer = image::RgbaImage::from_raw(width, height, bytes)
        .ok_or_else(|| anyhow!("PDFium returned a short bitmap"))?;
    Ok(Arc::new(RenderImage::new(smallvec![image::Frame::new(
        buffer
    )])))
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
