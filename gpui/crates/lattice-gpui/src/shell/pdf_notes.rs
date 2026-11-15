//! The project's annotations on its compiled PDFs (`pdf-annotations.tsx`):
//! the live PDF and each root document's tab are given the notes the
//! annotation store holds, again whenever it changes, and a note's card
//! there asks the window as the source editor's does (Resolve, Reply).

use gpui::{Context, Entity, Subscription};

use super::{Shell, parts::Part};
use crate::{
    annotations::store,
    pdf::{PdfNotes, PdfPanel},
};

pub(super) const PART: Part = Part {
    install: |_, cx| {
        let store = store::store(cx);
        let watching: Subscription = cx.observe(&store, |this, _, cx| this.give_pdf_notes(cx));
        Box::new(PdfNoteWatch { _store: watching })
    },
    views: &[],
    actions: |element, _| element,
    commands: super::parts::no_commands,
};

struct PdfNoteWatch {
    _store: Subscription,
}

impl Shell {
    /// Every compiled PDF of the project gets its notes.
    pub(super) fn give_pdf_notes(&self, cx: &mut Context<Self>) {
        let live = self.pdf.clone();
        self.give_pdf_notes_to(&live, None, cx);
        for (document, panel) in self.root_pdf_tabs() {
            self.give_pdf_notes_to(&panel, Some(document), cx);
        }
    }

    /// `panel`, showing `document`'s PDF (`None`: the compiled one), gets
    /// the project's notes.
    pub(super) fn give_pdf_notes_to(
        &self,
        panel: &Entity<PdfPanel>,
        document: Option<String>,
        cx: &mut Context<Self>,
    ) {
        // A linked project's notes are Overleaf comments (`overleaf_collab`).
        let annotatable = self.overleaf.read(cx).link().is_none();
        let notes = self.root(cx).map(|root| {
            let store = store::store(cx);
            let notes = store
                .read(cx)
                .annotations(&root)
                .into_iter()
                .cloned()
                .collect::<Vec<_>>();
            PdfNotes {
                root,
                document,
                notes: std::sync::Arc::new(notes),
                annotatable,
            }
        });
        panel.update(cx, |panel, cx| panel.set_notes(notes, cx));
    }
}
