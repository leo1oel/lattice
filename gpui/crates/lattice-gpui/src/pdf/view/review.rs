//! What Export review PDF reads of the PDF on screen (`review-pdf-sheet.tsx`
//! places each note on the viewer's own document): its pages' text and
//! SyncTeX's map of the build, read off the main thread, the file it was
//! read from, and the SHA-256 of the bytes shown, so the copy is written
//! only over the PDF the notes were placed on.

use std::{path::PathBuf, sync::Arc, time::SystemTime};

use lattice_core::project::EditorComment;

use super::{notes::Reader, *};
use crate::pdf::{
    engine::{DocId, PdfEngine},
    review_place::{ReviewPlacement, place_review},
};

/// The PDF on screen, as a review copy is made from it.
#[derive(Clone)]
pub struct ReviewSource {
    engine: Arc<PdfEngine>,
    doc: DocId,
    generation: u64,
    pub sizes: Vec<(f32, f32)>,
    pub root: PathBuf,
    document: Option<String>,
    /// The file shown, and when it was written (the build).
    pub path: PathBuf,
    pub built: Option<SystemTime>,
    pub digest: String,
}

impl ReviewSource {
    /// Where each of `notes` goes, in order; blocks on the PDF worker and
    /// SyncTeX, so it runs off the main thread.
    pub fn place(&self, notes: &[EditorComment]) -> Vec<ReviewPlacement> {
        let mut reader = Reader::new(
            self.engine.clone(),
            self.doc,
            self.generation,
            self.sizes.clone(),
            self.root.clone(),
            self.document.clone(),
        );
        notes
            .iter()
            .map(|note| {
                // A note made on the PDF falls back to SyncTeX too when its
                // page is gone from this build.
                let source = std::fs::read_to_string(self.root.join(&note.path)).ok();
                reader.set_path(&note.path);
                place_review(note, source.as_deref(), &mut reader)
            })
            .collect()
    }

    /// The shown PDF's file name (`paper.pdf`).
    pub fn file_name(&self) -> String {
        self.path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

impl PdfView {
    /// The PDF on screen, for a review copy; `None` while none is loaded or
    /// it shows no project's notes.
    pub fn review_source(&self) -> Option<ReviewSource> {
        let engine = self.engine.clone().ok()?;
        let document = self.document.as_ref()?;
        let notes = self.notes_source()?;
        let path = self.source.clone()?;
        let built = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok();
        Some(ReviewSource {
            engine,
            doc: self.doc?,
            generation: document.info.generation,
            sizes: document.info.page_sizes.clone(),
            root: notes.root.clone(),
            document: notes.document.clone(),
            path,
            built,
            digest: self.shown_digest.clone()?,
        })
    }
}
