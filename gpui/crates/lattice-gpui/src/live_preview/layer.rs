//! The live preview drawn over the compiled PDF's pages
//! (`src/live-preview/live-preview-layer.tsx`). A page gets an image of its
//! own, over the PDF's and under the search hits, the selection, the SyncTeX
//! mark and the links, only when there is something to show on it:
//!
//! - a page rtex has laid out again since the PDF under it was built is
//!   drawn whole, from its display list when rtex describes it exactly,
//!   else from the fallback PDF of that layout;
//! - the paragraphs being typed are painted over it, their previous rows
//!   cleared first.
//!
//! Every other page is the viewer's alone. The image takes no pointer
//! events, so selection, links and the double-click to the source (on the
//! last real SyncTeX) work as they do without it. Each page is drawn on a
//! background thread from a snapshot of the session, and a draw a newer
//! change overtook is dropped.

use std::{collections::HashMap, sync::Arc};

use gpui::{AppContext as _, Context, Entity, RenderImage, Subscription, Task, Window};
use smallvec::smallvec;

use super::{
    Dirty, LivePreview, LivePreviewEvent,
    model::PageSource,
    paint::{JobSource, PageJob, compose, inexact_reason, only_loading, to_bgra},
    protocol::SP_PER_BP,
};
use crate::pdf::{PdfEngine, PdfView, RenderRequest};

/// What a page's image was drawn for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Key {
    stamp: u64,
    width_px: u32,
    dark: bool,
}

#[derive(Default)]
struct Slot {
    image: Option<Arc<RenderImage>>,
    drawn: Option<Key>,
    pending: Option<(Key, Task<()>)>,
}

/// A viewer's live layer: one image per page that has something to show.
pub struct Layer {
    preview: Entity<LivePreview>,
    slots: HashMap<usize, Slot>,
    /// Bumped on every change; a page is drawn again when the change it was
    /// drawn for is older than its own or the last "every page".
    stamp: u64,
    all: u64,
    pages: HashMap<usize, u64>,
    /// Images drawn, ever, for the e2e scenario.
    pub draws: u64,
    _subscription: Subscription,
}

impl Layer {
    pub fn new(preview: Entity<LivePreview>, cx: &mut Context<PdfView>) -> Self {
        let subscription = cx.subscribe(&preview, |view, _, event, cx| match event {
            LivePreviewEvent::Pages(dirty) => {
                if let Some(layer) = view.live_layer_mut() {
                    layer.invalidate(dirty);
                }
                cx.notify();
            }
            LivePreviewEvent::Changed => cx.notify(),
        });
        Self {
            preview,
            slots: HashMap::new(),
            stamp: 1,
            all: 1,
            pages: HashMap::new(),
            draws: 0,
            _subscription: subscription,
        }
    }

    pub fn preview(&self) -> &Entity<LivePreview> {
        &self.preview
    }

    fn invalidate(&mut self, dirty: &Dirty) {
        self.stamp += 1;
        match dirty {
            Dirty::All => self.all = self.stamp,
            Dirty::Pages(pages) => {
                for page in pages {
                    // rtex numbers pages from 1, the viewer from 0.
                    if let Some(ix) = (*page as usize).checked_sub(1) {
                        self.pages.insert(ix, self.stamp);
                    }
                }
            }
        }
    }

    fn stamp_of(&self, page: usize) -> u64 {
        self.all.max(self.pages.get(&page).copied().unwrap_or(0))
    }

    /// The image to draw over `page` (0-based), if any.
    pub fn image(&self, page: usize) -> Option<Arc<RenderImage>> {
        self.slots.get(&page)?.image.clone()
    }

    /// Let go of `page`'s image, from memory and from the GPU atlas.
    pub fn release(&mut self, page: usize, window: &mut Window) {
        if let Some(slot) = self.slots.remove(&page)
            && let Some(image) = slot.image
        {
            window.drop_image(image).ok();
        }
    }

    /// Let go of every page's image, inside a frame's window.
    pub fn release_every(&mut self, window: &mut Window) {
        for (_, slot) in self.slots.drain() {
            if let Some(image) = slot.image {
                window.drop_image(image).ok();
            }
        }
    }

    /// Let go of every page's image.
    pub fn release_all(&mut self, cx: &mut gpui::App) {
        for (_, slot) in self.slots.drain() {
            if let Some(image) = slot.image {
                cx.drop_image(image, None);
            }
        }
    }

    pub fn has_images(&self) -> bool {
        self.slots.values().any(|slot| slot.image.is_some())
    }

    /// The pages (0-based) holding a live image now.
    pub fn drawn_pages(&self) -> Vec<usize> {
        let mut pages: Vec<usize> = self
            .slots
            .iter()
            .filter(|(_, slot)| slot.image.is_some())
            .map(|(page, _)| *page)
            .collect();
        pages.sort_unstable();
        pages
    }
}

impl PdfView {
    /// Ask for `page`'s live image at `width_px` device pixels across, if
    /// it is not drawn for the latest change at that size.
    pub(crate) fn request_live_page(
        &mut self,
        page: usize,
        width_px: u32,
        (width_pt, height_pt): (f32, f32),
        dark: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(layer) = self.live_layer_mut() else { return };
        let key = Key {
            stamp: layer.stamp_of(page),
            width_px,
            dark,
        };
        let slot = layer.slots.entry(page).or_default();
        if slot.drawn == Some(key) || slot.pending.as_ref().is_some_and(|(want, _)| *want == key) {
            return;
        }
        let height_px = (width_px as f32 * height_pt / width_pt.max(1.)).round().max(1.) as u32;
        let preview = layer.preview.clone();
        let plan = preview.update(cx, |preview, cx| plan(preview, page as u32 + 1, width_px, height_px, width_pt.max(1.), cx));
        let Some(plan) = plan else {
            // Nothing to show: the page is the PDF's alone.
            let slot = self.live_layer_mut().and_then(|layer| layer.slots.remove(&page));
            if let Some(image) = slot.and_then(|slot| slot.image) {
                window.drop_image(image).ok();
            }
            return;
        };
        let task = cx.spawn_in(window, async move |this, cx| {
            let Plan { mut job, fallback } = plan;
            if let Some((engine, request)) = fallback {
                let rendered = engine.render(request).await;
                if let JobSource::Fallback { pixels, .. } = &mut job.source
                    && let Ok(Ok(rendered)) = rendered
                {
                    let size = rendered.image.size(0);
                    let (w, h) = (size.width.0.max(1) as u32, size.height.0.max(1) as u32);
                    job.k *= f64::from(w) / f64::from(job.width_px);
                    (job.width_px, job.height_px) = (w, h);
                    *pixels = rendered.image.as_bytes(0).map(<[u8]>::to_vec);
                }
            }
            let image = cx
                .background_spawn(async move {
                    let pixmap = compose(job)?;
                    let bgra = to_bgra(&pixmap, dark);
                    let buffer = image::RgbaImage::from_raw(pixmap.width(), pixmap.height(), bgra)?;
                    Some(Arc::new(RenderImage::new(smallvec![image::Frame::new(buffer)])))
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                let Some(layer) = this.live_layer_mut() else { return };
                let Some(slot) = layer.slots.get_mut(&page) else { return };
                if slot.pending.as_ref().map(|(want, _)| *want) != Some(key) {
                    if let Some(image) = image {
                        window.drop_image(image).ok();
                    }
                    return;
                }
                slot.pending = None;
                slot.drawn = Some(key);
                let old = match image {
                    Some(image) => {
                        layer.draws += 1;
                        slot.image.replace(image)
                    }
                    // A display-list page that cannot be drawn exactly yet
                    // shows the PDF under it.
                    None => slot.image.take(),
                };
                if let Some(old) = old {
                    window.drop_image(old).ok();
                }
                cx.notify();
            })
            .ok();
        });
        if let Some(slot) = self.live_layer_mut().map(|layer| layer.slots.entry(page).or_default()) {
            slot.pending = Some((key, task));
        }
    }
}

struct Plan {
    job: PageJob,
    fallback: Option<(Arc<PdfEngine>, RenderRequest)>,
}

/// What drawing page `n` (1-based) takes, read from the session now; `None`
/// when the page needs no layer.
fn plan(
    preview: &mut LivePreview,
    n: u32,
    width_px: u32,
    height_px: u32,
    width_pt: f32,
    cx: &mut Context<LivePreview>,
) -> Option<Plan> {
    let session = preview.session.as_mut()?;
    if !session.wants(n) {
        return None;
    }
    let source = session.model.page_source(n);
    // A live paragraph is drawn only when every glyph and image of it can
    // be, exactly: never approximated over the real page. Until then its old
    // rows stay as the PDF under it shows them.
    let mut missing = false;
    let overlays: Vec<_> = session
        .model
        .overlays_on(n)
        .into_iter()
        .filter(|page_overlay| {
            let reason = inexact_reason(
                &page_overlay.overlay.dl,
                &session.fonts,
                &session.images,
                Some(&mut page_overlay.rows.iter().map(|row| &row.line)),
            );
            // Not loading but missing: only the next layout or build shows
            // this edit.
            if reason.as_deref().is_some_and(|reason| !only_loading(reason)) {
                missing = true;
            }
            reason.is_none()
        })
        .map(|page_overlay| {
            let own = session.model.own_lines(n, page_overlay.overlay.par_id);
            (page_overlay, own)
        })
        .collect();
    if missing {
        session.wait_for_layout(cx);
    }
    let mut fallback = None;
    let job_source = match source {
        PageSource::Base => JobSource::Base {
            page: session.model.pages.get(&n).cloned(),
        },
        PageSource::DisplayList(page) => JobSource::DisplayList(page),
        PageSource::Fallback {
            page,
            layout_version,
        } => {
            if let (Some(engine), Some(pdf)) = (session.engine(), session.fallback_for(layout_version)) {
                fallback = Some((
                    engine.clone(),
                    RenderRequest {
                        doc: pdf.doc,
                        generation: pdf.generation,
                        page: n as usize - 1,
                        width_px,
                        region: None,
                        dark: false,
                        cancel: Default::default(),
                    },
                ));
            }
            JobSource::Fallback { page, pixels: None }
        }
    };
    Some(Plan {
        job: PageJob {
            width_px,
            height_px,
            // Device pixels per sp: the page is `width_px` across its width
            // in PDF points (bp).
            k: f64::from(width_px) / (f64::from(width_pt) * SP_PER_BP),
            source: job_source,
            overlays,
            fonts: session.fonts.clone(),
            images: session.images.clone(),
        },
        fallback,
    })
}
