//! A copy of the document shown in the viewer: a new one, or a rebuild of
//! the one on screen, which keeps the pages it did not change.

use gpui::{Context, Window};
use lattice_core::pdf_pages::PageSignatures;

use super::{Document, PageSlot, PdfView, PendingScroll, changed_pages};
use crate::pdf::engine::DocumentInfo;

impl PdfView {
    pub(super) fn set_document(
        &mut self,
        info: DocumentInfo,
        signatures: Option<PageSignatures>,
        reload: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.loading = false;
        self.message = None;
        self.dismiss_citation(cx);
        self.dismiss_compound(cx);
        self.stop_autoscroll(cx);
        let generation = info.generation;
        let count = info.page_sizes.len();
        // Where the reader is, read before the old layout goes: a rebuild of
        // another shape keeps that point of that page rather than the offset,
        // which lands elsewhere once pages above it grow or go.
        let kept = (reload && self.pending_scroll.is_none())
            .then(|| self.layout.rebuilt_place(self.scroll_offset(), count))
            .flatten();
        let previous = self.document.take();
        let same_shape = reload
            && previous
                .as_ref()
                .is_some_and(|old| old.info.page_sizes == info.page_sizes)
            && self.pages.len() == count;
        if same_shape {
            let changed = match (
                previous.as_ref().and_then(|old| old.signatures.as_ref()),
                signatures.as_ref(),
            ) {
                (Some(before), Some(after)) => changed_pages(before, after),
                _ => None,
            };
            let mut redrawn = Vec::new();
            for (ix, slot) in self.pages.iter_mut().enumerate() {
                let unchanged = changed.as_ref().is_some_and(|set| !set.contains(&ix));
                slot.base.cancel();
                slot.detail.cancel();
                slot.text_pending = None;
                if unchanged {
                    // The same drawing: its image and text are the new copy's.
                    for drawn in [&mut slot.base, &mut slot.detail] {
                        if let Some(key) = &mut drawn.key {
                            key.generation = generation;
                        }
                    }
                    if slot.text.is_some() {
                        slot.text_generation = generation;
                    }
                } else {
                    // Its old image stays until the new one is drawn.
                    slot.text = None;
                    redrawn.push(ix);
                }
            }
            self.stats.kept = count - redrawn.len();
            self.stats.swaps.push(redrawn.clone());
            self.stats.last_swap = Some(redrawn);
            // A selection on a page that changed may no longer be on its text.
            if self.selection.is_some_and(|selection| {
                let ((from, _), (to, _)) = selection.ordered();
                self.stats
                    .last_swap
                    .as_ref()
                    .is_some_and(|redrawn| redrawn.iter().any(|ix| (from..=to).contains(ix)))
            }) {
                self.selection = None;
            }
        } else {
            for mut slot in self.pages.drain(..) {
                slot.base.release(window);
                slot.detail.release(window);
            }
            self.pages = (0..count).map(|_| PageSlot::default()).collect();
            self.selection = None;
            self.stats.last_swap = None;
            self.stats.kept = 0;
            if !reload {
                self.back.clear();
                self.forward.clear();
            }
        }
        self.document = Some(Document { info, signatures });
        if !reload && self.pending_scroll.is_none() {
            self.current_page = 0;
            self.pending_scroll = Some(PendingScroll::Offset(0., 0.));
        } else if !same_shape && let Some((page, x, y)) = kept {
            // A rebuild with fewer pages than the one read used to send the
            // reader back to the first page.
            self.current_page = page;
            self.pending_scroll = Some(PendingScroll::PagePoint {
                page,
                x: Some(x),
                y,
                at_y: 0.,
            });
        }
        self.current_page = self.current_page.min(count.saturating_sub(1));
        self.relayout();
        // The search on screen is run again on the new copy, without moving
        // the reader to a match (`rerunSearch`).
        if self.find.query.trim().is_empty() {
            self.find.matches.clear();
            self.find.current = None;
        } else {
            self.run_find(false, cx);
        }
        self.scroll_to_mark(cx);
        // The pages on screen are asked for now, not at the next frame.
        self.sync_pages(window, cx);
        self.promote = Some(generation);
        self.check_promoted(cx);
        cx.notify();
    }
}
