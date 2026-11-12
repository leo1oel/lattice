//! The page window: which pages hold images, at what size, and the text
//! of those on screen.
//!
//! Before each frame the view finds the pages near the viewport, asks
//! PDFium for what they lack, and lets go of the images of every page more
//! than two away from the screen, from memory and from the GPU atlas. A page
//! larger than `MAX_PAGE_PIXELS` at its zoom is drawn smaller, with the part
//! on screen drawn again at full size on top, as PDF.js caps a canvas and
//! adds a detail one.

use super::*;

/// Pages kept drawn on each side of the visible ones.
pub(in crate::pdf) const KEEP_AROUND: usize = 2;

/// Pages drawn ahead on each side of the visible ones.
pub(in crate::pdf) const DRAW_AHEAD: usize = 1;

/// The most device pixels one page's image may hold (about 24 MB); a larger
/// page is drawn at this size with its visible part drawn again on top.
pub(in crate::pdf) const MAX_PAGE_PIXELS: u64 = 6_000_000;

/// The image of one page, as drawn for one copy of the document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::pdf) struct ImageKey {
    pub width_px: u32,
    pub generation: u64,
    pub dark: bool,
    /// The part of the page drawn, for a page drawn again at full size on
    /// top of its capped image.
    pub region: Option<PixelRect>,
}

#[derive(Default)]
pub(in crate::pdf) struct Drawn {
    pub image: Option<Arc<RenderImage>>,
    pub key: Option<ImageKey>,
    pub pending: Option<(ImageKey, Arc<AtomicBool>)>,
}

impl Drawn {
    pub(in crate::pdf) fn cancel(&mut self) {
        if let Some((_, cancel)) = self.pending.take() {
            cancel.store(true, Ordering::Relaxed);
        }
    }

    pub(in crate::pdf) fn release(&mut self, window: &mut Window) {
        self.cancel();
        self.key = None;
        if let Some(image) = self.image.take() {
            window.drop_image(image).ok();
        }
    }
}

#[derive(Default)]
pub(in crate::pdf) struct PageSlot {
    pub base: Drawn,
    pub detail: Drawn,
    pub text: Option<Arc<PageText>>,
    /// The copy the text was read from, and a read under way.
    pub text_generation: u64,
    pub text_pending: Option<u64>,
}

impl PdfView {
    /// Before each frame: follow a resize, find the page in view, ask for the
    /// images and text the pages on screen need, and let go of the rest.
    pub(in crate::pdf) fn prepare_frame(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let bounds = self.scroll.bounds();
        if bounds.size != self.viewport.size {
            let resized = self.viewport.size.width > px(0.);
            self.viewport = bounds;
            self.relayout();
            if self.fit.is_some() && resized {
                self.settle(REFIT_SETTLE, cx);
            } else if !resized {
                self.render_scale = self.scale;
            }
            self.apply_pending_scroll();
            self.scroll_to_mark();
        } else {
            self.viewport = bounds;
        }
        if self.layout.len() == 0 || self.viewport.size.height <= px(0.) {
            return;
        }
        self.apply_pending_scroll();
        let dark = crate::pdf::dark::enabled();
        if dark != self.dark {
            self.dark = dark;
        }
        let (scroll_x, scroll_y) = self.scroll_offset();
        let (width, height) = self.viewport_size();
        let visible = self.layout.visible(scroll_y, height);
        let current = self
            .layout
            .current_page(scroll_y, height, self.current_page);
        if current != self.current_page {
            self.current_page = current;
            // A fitted page takes its scale from the page in view.
            if self.fit.is_some() {
                let scale = self.scale;
                self.relayout();
                if scale != self.scale {
                    self.settle(REFIT_SETTLE, cx);
                }
            }
        }
        let keep = visible.start.saturating_sub(KEEP_AROUND)
            ..(visible.end + KEEP_AROUND).min(self.pages.len());
        let draw = visible.start.saturating_sub(DRAW_AHEAD)
            ..(visible.end + DRAW_AHEAD).min(self.pages.len());
        for page in 0..self.pages.len() {
            if !keep.contains(&page) {
                let slot = &mut self.pages[page];
                slot.base.release(window);
                slot.detail.release(window);
                slot.text = None;
                slot.text_pending = None;
            } else if !visible.contains(&page) {
                // Only a page on screen keeps its full-size part, and a page
                // drawn in the other page colours (dark pages turned on or
                // off) is not kept to be shown in them.
                let slot = &mut self.pages[page];
                slot.detail.release(window);
                if !draw.contains(&page) && slot.base.key.is_some_and(|key| key.dark != self.dark) {
                    slot.base.release(window);
                }
            }
        }
        let viewport = (scroll_x, scroll_y, width, height);
        for page in draw {
            self.request_page(page, visible.contains(&page), viewport, window, cx);
        }
    }

    /// The image `page` needs at the current scale, and, on screen, its
    /// text and its full-size part when its image is capped.
    pub(super) fn request_page(
        &mut self,
        page: usize,
        on_screen: bool,
        (scroll_x, scroll_y, width, height): (f32, f32, f32, f32),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(document) = &self.document else {
            return;
        };
        let generation = document.info.generation;
        let (width_pt, height_pt) = document.info.page_sizes[page];
        let scale_factor = window.scale_factor();
        // A page with no image yet is drawn at the scale shown; one with an
        // image waits for a zoom to settle, its image stretched meanwhile.
        let scale = if self.pages[page].base.image.is_some() {
            self.render_scale
        } else {
            self.scale
        };
        let full_width = (width_pt * scale * scale_factor).round().max(1.) as u32;
        let full_height = (height_pt * scale * scale_factor).round().max(1.) as u32;
        let capped = u64::from(full_width) * u64::from(full_height) > MAX_PAGE_PIXELS;
        let base_width = if capped {
            ((MAX_PAGE_PIXELS as f64 * f64::from(width_pt) / f64::from(height_pt.max(1.))).sqrt()
                as u32)
                .max(1)
        } else {
            full_width
        };
        let dark = self.dark;
        let base_key = ImageKey {
            width_px: base_width,
            generation,
            dark,
            region: None,
        };
        let needs = |drawn: &Drawn, key: ImageKey| {
            drawn.key != Some(key) && drawn.pending.as_ref().is_none_or(|(want, _)| *want != key)
        };
        if needs(&self.pages[page].base, base_key) {
            self.render(page, base_key, false, window, cx);
        }
        if !on_screen {
            return;
        }
        let text_current =
            self.pages[page].text_generation == generation && self.pages[page].text.is_some();
        if !text_current && self.pages[page].text_pending != Some(generation) {
            self.read_text(page, generation, cx);
        }
        // The part of a capped page on screen (and half a screen around it)
        // at full size, snapped to 256px so a small scroll asks for nothing.
        if capped && self.render_scale == self.scale {
            let Some(rect) = self.layout.page(page) else {
                return;
            };
            let to_px = |value: f32| value * scale_factor;
            let left = to_px((scroll_x - width / 2. - rect.x).max(0.));
            let top = to_px((scroll_y - height / 2. - rect.y).max(0.));
            let right = to_px((scroll_x + width * 1.5 - rect.x).min(rect.w));
            let bottom = to_px((scroll_y + height * 1.5 - rect.y).min(rect.h));
            if right <= left || bottom <= top {
                return;
            }
            let snap_down = |value: f32| (value as u32 / 256) * 256;
            let snap_up = |value: f32, max: u32| {
                (value.ceil() as u32)
                    .div_ceil(256)
                    .saturating_mul(256)
                    .min(max)
            };
            let (x, y) = (snap_down(left), snap_down(top));
            let region = PixelRect {
                x,
                y,
                w: snap_up(right, full_width).saturating_sub(x).max(1),
                h: snap_up(bottom, full_height).saturating_sub(y).max(1),
            };
            let covered = self.pages[page].detail.key.is_some_and(|key| {
                key.generation == generation
                    && key.width_px == full_width
                    && key.dark == dark
                    && key.region.is_some_and(|have| {
                        have.x <= to_px((scroll_x - rect.x).max(0.)) as u32
                            && have.y <= to_px((scroll_y - rect.y).max(0.)) as u32
                            && have.x + have.w
                                >= (to_px((scroll_x + width - rect.x).min(rect.w)) as u32)
                                    .min(full_width)
                            && have.y + have.h
                                >= (to_px((scroll_y + height - rect.y).min(rect.h)) as u32)
                                    .min(full_height)
                    })
            });
            let detail_key = ImageKey {
                width_px: full_width,
                generation,
                dark,
                region: Some(region),
            };
            if !covered && needs(&self.pages[page].detail, detail_key) {
                self.render(page, detail_key, true, window, cx);
            }
        } else if !capped {
            self.pages[page].detail.release(window);
        }
    }

    pub(super) fn render(
        &mut self,
        page: usize,
        key: ImageKey,
        detail: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Ok(engine), Some(doc)) = (self.engine.clone(), self.doc) else {
            return;
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let slot = &mut self.pages[page];
        let drawn = if detail {
            &mut slot.detail
        } else {
            &mut slot.base
        };
        drawn.cancel();
        drawn.pending = Some((key, cancel.clone()));
        self.stats.renders += 1;
        let rendered = engine.render(RenderRequest {
            doc,
            generation: key.generation,
            page,
            width_px: key.width_px,
            region: key.region,
            dark: key.dark,
            cancel,
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(rendered)) = rendered.await else {
                return;
            };
            this.update_in(cx, |this, window, cx| {
                this.image_arrived(page, key, detail, rendered.image, window, cx)
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn read_text(&mut self, page: usize, generation: u64, cx: &mut Context<Self>) {
        let (Ok(engine), Some(doc)) = (self.engine.clone(), self.doc) else {
            return;
        };
        self.pages[page].text_pending = Some(generation);
        let reading = engine.text(doc, generation, page);
        cx.spawn(async move |this, cx| {
            let Ok(Ok(text)) = reading.await else {
                return;
            };
            this.update(cx, |this, cx| {
                let Some(slot) = this.pages.get_mut(page) else {
                    return;
                };
                if slot.text_pending != Some(generation) {
                    return;
                }
                slot.text_pending = None;
                slot.text = Some(text);
                slot.text_generation = generation;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A drawn image arrived: it replaces the page's old one, unless the page
    /// wants another by now.
    pub(in crate::pdf) fn image_arrived(
        &mut self,
        page: usize,
        key: ImageKey,
        detail: bool,
        image: Arc<RenderImage>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(slot) = self.pages.get_mut(page) else {
            window.drop_image(image).ok();
            return;
        };
        let drawn = if detail {
            &mut slot.detail
        } else {
            &mut slot.base
        };
        if drawn.pending.as_ref().map(|(want, _)| *want) != Some(key) {
            window.drop_image(image).ok();
            return;
        }
        drawn.pending = None;
        if let Some(old) = drawn.image.replace(image) {
            window.drop_image(old).ok();
        }
        drawn.key = Some(key);
        cx.notify();
    }

    /// Images held now, for a scenario that checks the page window.
    pub fn images_held(&self) -> usize {
        self.pages
            .iter()
            .map(|slot| {
                usize::from(slot.base.image.is_some()) + usize::from(slot.detail.image.is_some())
            })
            .sum()
    }

    /// The pages holding an image now, for a scenario that checks the page
    /// window.
    pub fn held_pages(&self) -> Vec<usize> {
        self.pages
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.base.image.is_some())
            .map(|(ix, _)| ix)
            .collect()
    }

    /// Whether every image held is drawn in the pages' colours as they are
    /// now (dark or not), and there is one.
    pub fn images_follow_dark_pages(&self) -> bool {
        let keys: Vec<_> = self.pages.iter().filter_map(|slot| slot.base.key).collect();
        !keys.is_empty() && keys.iter().all(|key| key.dark == self.dark)
    }

    /// Pages whose image is on screen at the size they are shown.
    pub fn pages_drawn(&self) -> usize {
        self.pages
            .iter()
            .filter(|slot| slot.base.image.is_some() && slot.base.pending.is_none())
            .count()
    }

    /// The page images' keys' copies, for a scenario that checks a swap.
    pub fn drawn_generations(&self) -> Vec<Option<u64>> {
        self.pages
            .iter()
            .map(|slot| slot.base.key.map(|key| key.generation))
            .collect()
    }

    pub fn generation(&self) -> Option<u64> {
        self.document
            .as_ref()
            .map(|document| document.info.generation)
    }

    pub fn visible_pages(&self) -> Range<usize> {
        let (_, scroll_y) = self.scroll_offset();
        self.layout.visible(scroll_y, self.viewport_size().1)
    }

    pub fn dark_pages(&self) -> bool {
        self.dark
    }

    /// The links of page `page`, once its text has been read.
    pub fn links(&self, page: usize) -> Option<Vec<crate::pdf::text::Link>> {
        Some(self.pages.get(page)?.text.as_ref()?.links.clone())
    }

    /// Start a selection drag with no pointer, for a scenario.
    pub fn page_text(&self, page: usize) -> Option<Arc<PageText>> {
        self.pages.get(page)?.text.clone()
    }
}
