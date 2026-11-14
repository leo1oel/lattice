//! The live preview's hooks in the viewer (`crate::live_preview`): the layer
//! it draws over the pages, and the moment a document just opened is on
//! screen, which tells the live preview the edits it holds can stop being
//! painted.

use gpui::{Context, Entity};

use super::PdfView;

impl PdfView {
    /// Draw the live preview over the pages, or stop.
    pub fn set_live_preview(
        &mut self,
        preview: Option<Entity<crate::live_preview::LivePreview>>,
        cx: &mut Context<Self>,
    ) {
        if self.live.as_ref().map(|layer| layer.preview()) == preview.as_ref() {
            return;
        }
        if let Some(mut layer) = self.live.take() {
            layer.release_all(cx);
        }
        self.live = preview.map(|preview| crate::live_preview::layer::Layer::new(preview, cx));
        cx.notify();
    }

    pub(crate) fn live_layer_mut(&mut self) -> Option<&mut crate::live_preview::layer::Layer> {
        self.live.as_mut()
    }

    pub(crate) fn live_layer(&self) -> Option<&crate::live_preview::layer::Layer> {
        self.live.as_ref()
    }

    /// Once the pages on screen show the document just opened, tell the
    /// live preview it is on screen (`basePromoted`): the edits it holds
    /// stop being painted only then, so no page shows them twice or not at
    /// all in between.
    pub(in crate::pdf) fn check_promoted(&mut self, cx: &mut Context<Self>) {
        let Some(generation) = self.promote else {
            return;
        };
        let visible = self.visible_pages();
        let shown = visible.clone().all(|page| {
            self.pages.get(page).is_none_or(|slot| {
                slot.base.pending.is_none()
                    && slot.base.key.is_some_and(|key| key.generation == generation)
            })
        });
        if !shown {
            return;
        }
        self.promote = None;
        let pages = u32::try_from(self.pages.len()).ok();
        if let Some(layer) = &self.live {
            layer
                .preview()
                .update(cx, |preview, cx| preview.base_promoted(pages, cx));
        }
    }
}
