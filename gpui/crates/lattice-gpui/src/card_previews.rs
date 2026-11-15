//! What the editor's cards draw their previews with
//! (`lattice_editor::latex::previews`): KaTeX's picture of an equation, from
//! the math island's page ([`math_page`], macOS), and a figure, read as the
//! Tauri app's `read_project_asset` and `referenceAssetPreviewDataUrl` read
//! it:
//!
//! - a PNG, JPEG, WebP or SVG is shown as it is;
//! - a PDF shows its first page, at most 720px wide, as PDF.js draws it
//!   there, through the PDF viewer's PDFium;
//! - any other format (EPS) has no preview, and a file that cannot be read
//!   (gone, larger than 50 MB) failed to load.
//!
//! The loader is the build chip's infinity loader (`InfinityLoader`).

#[cfg(target_os = "macos")]
mod math_page;

use std::{
    path::Path,
    rc::Rc,
    sync::{Arc, atomic::AtomicBool},
};

use gpui::{AnyElement, App, AppContext as _, ElementId, ImageFormat, ImageSource, Pixels, Task};
use lattice_editor::latex::previews::{self, Figure, MathPicture, MathRequest, PreviewHost};
use lattice_ui::ActiveLattice as _;

/// The largest figure read for a preview (`MAX_INLINE_ASSET_BYTES`).
const FIGURE_BYTES_MAX: u64 = 50 * 1024 * 1024;
/// A PDF figure's first page is drawn this wide (`referenceAssetPreviewDataUrl`
/// scales it to 720 CSS pixels, at most twice its own size).
const PDF_WIDTH: u32 = 720;

struct Host {
    #[cfg(target_os = "macos")]
    math: math_page::MathPage,
}

/// Draw the editor's card previews from now on.
pub fn install(cx: &mut App) {
    let host = Host {
        #[cfg(target_os = "macos")]
        math: math_page::MathPage::start(cx),
    };
    previews::install(Rc::new(host), cx);
}

/// What a figure is, by its extension (`asset_mime_type`).
enum Kind {
    Image(ImageFormat),
    Pdf,
    Other,
}

fn kind_of(path: &Path) -> Kind {
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
    match extension.as_deref() {
        Some("png") => Kind::Image(ImageFormat::Png),
        Some("jpg" | "jpeg") => Kind::Image(ImageFormat::Jpeg),
        Some("webp") => Kind::Image(ImageFormat::Webp),
        Some("svg") => Kind::Image(ImageFormat::Svg),
        Some("pdf") => Kind::Pdf,
        _ => Kind::Other,
    }
}

fn read_figure(path: &Path) -> Option<Vec<u8>> {
    let size = std::fs::metadata(path).ok()?.len();
    (size <= FIGURE_BYTES_MAX)
        .then(|| std::fs::read(path).ok())
        .flatten()
}

impl PreviewHost for Host {
    fn math(&self, request: &MathRequest, cx: &mut App) -> Task<Option<MathPicture>> {
        #[cfg(target_os = "macos")]
        {
            let picture = self.math.picture(request.clone());
            cx.spawn(async move |_| picture.await.ok().flatten())
        }
        // Elsewhere the card keeps the equation's source.
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (request, cx);
            Task::ready(None)
        }
    }

    fn figure(&self, path: &Path, cx: &mut App) -> Task<Figure> {
        let path = path.to_path_buf();
        match kind_of(&path) {
            Kind::Other => Task::ready(if path.is_file() {
                Figure::Unavailable
            } else {
                Figure::Failed
            }),
            Kind::Image(format) => {
                let read = cx.background_spawn(async move { read_figure(&path) });
                cx.spawn(async move |_| match read.await {
                    Some(bytes) => Figure::Shown(ImageSource::Image(Arc::new(
                        gpui::Image::from_bytes(format, bytes),
                    ))),
                    None => Figure::Failed,
                })
            }
            Kind::Pdf => {
                let engine = crate::pdf::PdfEngine::global(cx).ok();
                cx.spawn(async move |cx| {
                    let Some(engine) = engine else {
                        return Figure::Failed;
                    };
                    match first_page(&engine, path, cx).await {
                        Some(image) => Figure::Shown(ImageSource::Render(image)),
                        None => Figure::Failed,
                    }
                })
            }
        }
    }

    fn loader(&self, id: ElementId, size: Pixels, cx: &App) -> AnyElement {
        crate::build::chip_mark::infinity_loader(id, size, cx.palette())
    }
}

/// A PDF figure's first page, [`PDF_WIDTH`] pixels wide.
async fn first_page(
    engine: &Arc<crate::pdf::PdfEngine>,
    path: std::path::PathBuf,
    cx: &mut gpui::AsyncApp,
) -> Option<Arc<gpui::RenderImage>> {
    let bytes = cx
        .background_executor()
        .spawn(async move { read_figure(&path) })
        .await?;
    let doc = engine.new_document();
    let drawn = async {
        let info = engine.open(doc, bytes).await.ok()?.ok()?;
        let page = engine
            .render(crate::pdf::RenderRequest {
                doc,
                generation: info.generation,
                page: 0,
                width_px: PDF_WIDTH,
                region: None,
                dark: false,
                cancel: Arc::new(AtomicBool::new(false)),
            })
            .await
            .ok()?
            .ok()?;
        Some(page.image)
    }
    .await;
    engine.close(doc);
    drawn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn figures_preview_the_formats_the_tauri_app_previews() {
        assert!(matches!(
            kind_of(Path::new("figs/Plot.PNG")),
            Kind::Image(ImageFormat::Png)
        ));
        assert!(matches!(
            kind_of(Path::new("a.jpeg")),
            Kind::Image(ImageFormat::Jpeg)
        ));
        assert!(matches!(
            kind_of(Path::new("a.svg")),
            Kind::Image(ImageFormat::Svg)
        ));
        assert!(matches!(kind_of(Path::new("a.pdf")), Kind::Pdf));
        assert!(matches!(kind_of(Path::new("a.eps")), Kind::Other));
        assert!(matches!(kind_of(Path::new("a")), Kind::Other));
    }
}
