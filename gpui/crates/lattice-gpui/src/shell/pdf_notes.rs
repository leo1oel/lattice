//! The project's annotations on its compiled PDFs (`pdf-annotations.tsx`):
//! the live PDF and each root document's tab are given the notes the
//! annotation store holds, again whenever it changes, and a note's card
//! there asks the window as the source editor's does (Resolve, Reply).

use gpui::{Context, Entity, SharedString, Subscription, Window};
use lattice_i18n::t;

use super::{Shell, parts::Part};
use crate::{
    annotations::store,
    pdf::{NoteDestination, OverleafNotes, PdfNotes, PdfPanel, note_destination},
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
        let overleaf = self.overleaf_notes(cx);
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
                overleaf,
            }
        });
        panel.update(cx, |panel, cx| panel.set_notes(notes, cx));
    }

    /// A linked project's Overleaf side as its PDFs know it: the file open
    /// live and the files Overleaf holds; `None` for a project not linked.
    pub(super) fn overleaf_notes(&self, cx: &gpui::App) -> Option<OverleafNotes> {
        let bridge = self.overleaf.read(cx);
        bridge.linked().then(|| OverleafNotes {
            live_file: bridge.live_file().map(str::to_string),
            doc_paths: std::sync::Arc::new(
                bridge
                    .doc_paths()
                    .map(|(_, path)| path.to_string())
                    .collect(),
            ),
        })
    }

    /// The live PDF's picture of the Overleaf side is out of date (the link
    /// loaded, a file went live): every PDF is told again.
    pub(super) fn follow_overleaf_for_pdf_notes(&self, cx: &mut Context<Self>) {
        let now = self.overleaf_notes(cx);
        if self
            .pdf
            .read(cx)
            .overleaf_notes()
            .map(|known| known.cloned())
            != Some(now)
        {
            self.give_pdf_notes(cx);
        }
    }

    /// A note made on `panel`'s PDF goes to Overleaf as a comment
    /// (`createFromPdf`): placed again in the file's live text, which
    /// collaborators may have changed since the build, and refused when its
    /// words are no longer there. On a file Overleaf holds that is not the
    /// one open live, the file opens live first and the note waits to be
    /// sent again. The note closes as it is sent; what goes wrong after says
    /// so as Overleaf's own errors do.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn post_pdf_note(
        &mut self,
        panel: &Entity<PdfPanel>,
        id: u64,
        path: &str,
        line: usize,
        selection: &str,
        quote: &str,
        body: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), SharedString> {
        let view = panel.read(cx).live_view().clone();
        let answer = |answer: Result<(), SharedString>, cx: &mut Context<Self>| {
            view.update(cx, |view, cx| {
                view.answer_overleaf_note(id, answer.clone(), cx)
            });
            answer
        };
        let name = std::path::Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        match note_destination(self.overleaf_notes(cx).as_ref(), path) {
            NoteDestination::Overleaf => {}
            NoteDestination::OtherFile => {
                if let Some(root) = self.root(cx) {
                    self.open_path(root.join(path), Some(line as u32), window, cx);
                }
                let opening = t!(
                    "{name} is opening live with Overleaf beside the PDF. Comment again once it has opened.",
                    name = name
                );
                return answer(Err(opening.into()), cx);
            }
            NoteDestination::Offline | NoteDestination::Annotation => {
                let error = t!(
                    "This file is not live with Overleaf right now. Reconnect before commenting."
                );
                return answer(Err(error.into()), cx);
            }
        }
        let Some(live) = self.overleaf.read(cx).live_text(path).map(str::to_string) else {
            let error =
                t!("This file is not live with Overleaf right now. Reconnect before commenting.");
            return answer(Err(error.into()), cx);
        };
        // Where the words stand in the live text now.
        let range = crate::pdf::source_anchor::source_range_for_pdf_text(&live, line, selection)
            .filter(|range| live.get(range.clone()) == Some(quote));
        let Some(range) = range else {
            let stale =
                t!("The source changed since the PDF was built. Build again, then annotate.");
            return answer(Err(stale.into()), cx);
        };
        let from = live[..range.start].encode_utf16().count() as i64;
        let (path, quote, body) = (path.to_string(), quote.to_string(), body.to_string());
        self.overleaf.update(cx, |bridge, cx| {
            bridge.add_comment(&path, from, quote, body, |_| {}, cx)
        });
        answer(Ok(()), cx)
    }
}
