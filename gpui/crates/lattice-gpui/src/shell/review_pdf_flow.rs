//! The window's side of Export review PDF (`crate::pdf::review_sheet`):
//! opened from a PDF's overflow menu over that PDF, and from the
//! Annotations panel over the live PDF, with the project's local notes as
//! they are then and the writer's name for the cover note
//! (`annotationRounds.openReviewPdf`).

use gpui::{AnyElement, AppContext as _, Context, Entity, IntoElement as _, Subscription, Window};

use super::{
    Shell,
    parts::{Part, no_commands},
};
use crate::{
    annotations::store,
    pdf::{
        PdfView,
        review_sheet::{ReviewSheet, ReviewSheetEvent},
    },
};

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(ReviewFlow::default()),
    views: &[],
    actions: |element, _| element,
    commands: no_commands,
};

#[derive(Default)]
pub(crate) struct ReviewFlow {
    sheet: Option<(Entity<ReviewSheet>, Subscription)>,
}

impl Shell {
    /// Show Export review PDF over `view`'s PDF (`None`: the live one).
    pub(crate) fn open_review_sheet(
        &mut self,
        view: Option<Entity<PdfView>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let view = view.unwrap_or_else(|| self.pdf.read(cx).live_view().clone());
        let source = view.read(cx).review_source();
        let notes: Vec<_> = store::try_store(cx)
            .map(|store| {
                store
                    .read(cx)
                    .annotations(&root)
                    .into_iter()
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let author = store::author(&root, cx).name;
        let sheet = cx.new(|cx| ReviewSheet::new(source, notes, author, cx));
        let subscription = cx.subscribe_in(&sheet, window, |this, _, event, _, cx| match event {
            ReviewSheetEvent::Close => {
                this.parts.get_mut::<ReviewFlow>().sheet = None;
                cx.notify();
            }
        });
        self.parts.get_mut::<ReviewFlow>().sheet = Some((sheet, subscription));
        cx.notify();
    }

    /// The sheet, for the window to draw over everything.
    pub(super) fn review_sheet(&self) -> Option<AnyElement> {
        let (sheet, _) = self.parts.get::<ReviewFlow>().sheet.as_ref()?;
        Some(sheet.clone().into_any_element())
    }

    /// The sheet, while it is up (for a scenario).
    pub(crate) fn review_sheet_entity(&self) -> Option<Entity<ReviewSheet>> {
        self.parts
            .get::<ReviewFlow>()
            .sheet
            .as_ref()
            .map(|(sheet, _)| sheet.clone())
    }
}
