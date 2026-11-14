//! What the session loads beside rtex's lines: the fonts and images its
//! display lists draw with, and the fallback PDF of a layout rtex could not
//! describe exactly, opened in PDFium.

use std::sync::Arc;

use gpui::{AppContext as _, Context};
use lattice_core::live_preview;

use super::{Fallback, Session, mark};
use crate::{
    live_preview::{
        LivePreview,
        fonts::{LoadedFont, LoadedImage, decode_bitmap, pixmap_from_rgba},
        model::Dirty,
        protocol::DisplayList,
        resources::{ImageResource, fonts_wanted, images_wanted, load_font, load_image},
    },
    pdf::{PdfEngine, RenderRequest},
};

impl Session {
    pub(super) fn load_resources(
        &mut self,
        dls: Vec<Arc<DisplayList>>,
        cx: &mut Context<LivePreview>,
    ) {
        let fonts = fonts_wanted(&dls, &|key| {
            self.fonts.has(key) || self.fonts_loading.contains(key)
        });
        let images = images_wanted(&dls, &|file| {
            self.images.has(file) || self.images_loading.contains(file)
        });
        if fonts.is_empty() && images.is_empty() {
            return;
        }
        self.fonts_loading
            .extend(fonts.iter().map(|(key, _)| key.clone()));
        self.images_loading
            .extend(images.iter().map(|(file, _)| file.clone()));
        let root = self.root.clone();
        let engine = self.engine.clone();
        cx.spawn(async move |this, cx| {
            let loaded_fonts = cx
                .background_spawn(async move {
                    fonts
                        .into_iter()
                        .map(|(key, desc)| (key, Arc::new(LoadedFont::load(load_font(&desc)))))
                        .collect::<Vec<_>>()
                })
                .await;
            let mut loaded_images = Vec::new();
            for (file, page) in images {
                let resource = cx
                    .background_spawn({
                        let (root, file) = (root.clone(), file.clone());
                        async move { load_image(&root, &file, page) }
                    })
                    .await;
                let image = match resource {
                    ImageResource::Missing(reason) => LoadedImage::Missing(reason),
                    ImageResource::Bitmap(bytes) => cx
                        .background_spawn(async move { decode_bitmap(&bytes) })
                        .await
                        .map(|pixmap| LoadedImage::Bitmap(Arc::new(pixmap)))
                        .unwrap_or_else(LoadedImage::Missing),
                    ImageResource::Pdf { data, page } => match &engine {
                        Some(engine) => rasterize_pdf_image(engine, data, page)
                            .await
                            .map(|pixmap| LoadedImage::Bitmap(Arc::new(pixmap)))
                            .unwrap_or_else(LoadedImage::Missing),
                        None => LoadedImage::Missing("PDFium was not found".into()),
                    },
                };
                loaded_images.push((file, image));
            }
            this.update(cx, |this, cx| {
                let Some(session) = this.session_mut() else {
                    return;
                };
                for (key, font) in loaded_fonts {
                    session.fonts_loading.remove(&key);
                    session.fonts.insert(key, font);
                }
                for (file, image) in loaded_images {
                    session.images_loading.remove(&file);
                    session.images.set(file, image);
                }
                mark(cx, Dirty::All);
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn load_fallback(
        &mut self,
        file: String,
        layout_version: u64,
        cx: &mut Context<LivePreview>,
    ) {
        let Some(engine) = self.engine.clone() else {
            return;
        };
        let build_dir = self.build_dir.clone();
        cx.spawn(async move |this, cx| {
            let bytes = cx
                .background_spawn(async move { live_preview::read_fallback_pdf(&build_dir, &file) })
                .await;
            let Ok(bytes) = bytes else { return };
            let doc = engine.new_document();
            let Ok(Ok(info)) = engine.open(doc, bytes).await else {
                engine.close(doc);
                return;
            };
            this.update(cx, |this, cx| {
                let Some(session) = this.session_mut() else {
                    engine.close(doc);
                    return;
                };
                // A newer layout's PDF already arrived.
                if session
                    .fallback
                    .as_ref()
                    .is_some_and(|fallback| fallback.layout_version > layout_version)
                {
                    engine.close(doc);
                    return;
                }
                let previous = session.fallback.replace(Fallback {
                    layout_version,
                    doc,
                    generation: info.generation,
                });
                if let Some(previous) = previous {
                    engine.close(previous.doc);
                }
                mark(cx, Dirty::All);
            })
            .ok();
        })
        .detach();
    }
}

/// A PDF image a display list draws (\includegraphics of a PDF), rasterized
/// once: enough pixels for a sharp figure at 200% zoom on a 2× screen.
async fn rasterize_pdf_image(
    engine: &Arc<PdfEngine>,
    data: Vec<u8>,
    page: u32,
) -> Result<tiny_skia::Pixmap, String> {
    let doc = engine.new_document();
    let result = async {
        let info = engine
            .open(doc, data)
            .await
            .map_err(|_| "PDFium stopped".to_string())?
            .map_err(|error| format!("{error:#}"))?;
        let count = info.page_sizes.len();
        if count == 0 {
            return Err("the PDF has no pages".to_string());
        }
        let index = (page.max(1) as usize).min(count) - 1;
        let (width, height) = info.page_sizes[index];
        let scale = (2400. / width.max(height).max(1.)).min(6.);
        let rendered = engine
            .render(RenderRequest {
                doc,
                generation: info.generation,
                page: index,
                width_px: (width * scale).ceil().max(1.) as u32,
                region: None,
                dark: false,
                cancel: Default::default(),
            })
            .await
            .map_err(|_| "PDFium stopped".to_string())?
            .map_err(|error| format!("{error:#}"))?;
        let image = rendered.image;
        let size = image.size(0);
        let bgra = image.as_bytes(0).ok_or("an empty figure")?;
        let rgba: Vec<u8> = bgra
            .chunks_exact(4)
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0], pixel[3]])
            .collect();
        pixmap_from_rgba(size.width.0 as u32, size.height.0 as u32, &rgba)
            .ok_or_else(|| "an empty figure".to_string())
    }
    .await;
    engine.close(doc);
    result
}
