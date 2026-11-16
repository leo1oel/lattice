//! Where a note made on the PDF goes: `use-editor-comments.ts`'s
//! `destination`, case for case.

use std::sync::Arc;

use super::{NoteDestination, OverleafNotes, note_destination};

fn linked(live: Option<&str>, docs: &[&str]) -> OverleafNotes {
    OverleafNotes {
        live_file: live.map(str::to_string),
        doc_paths: Arc::new(docs.iter().map(|doc| doc.to_string()).collect()),
    }
}

#[test]
fn a_project_not_linked_keeps_local_annotations() {
    assert_eq!(
        note_destination(None, "main.tex"),
        NoteDestination::Annotation
    );
}

#[test]
fn a_file_overleaf_does_not_hold_keeps_a_local_annotation() {
    let overleaf = linked(Some("main.tex"), &["main.tex"]);
    assert_eq!(
        note_destination(Some(&overleaf), "local.tex"),
        NoteDestination::Annotation
    );
}

#[test]
fn the_live_file_takes_an_overleaf_comment() {
    let overleaf = linked(Some("main.tex"), &["main.tex", "intro.tex"]);
    assert_eq!(
        note_destination(Some(&overleaf), "main.tex"),
        NoteDestination::Overleaf
    );
    assert_eq!(
        note_destination(Some(&overleaf), "intro.tex"),
        NoteDestination::OtherFile
    );
}

#[test]
fn without_live_editing_a_note_waits() {
    let overleaf = linked(None, &["main.tex"]);
    assert_eq!(
        note_destination(Some(&overleaf), "main.tex"),
        NoteDestination::Offline
    );
    // Before the file list has loaded, every file counts as Overleaf's.
    let unknown = linked(None, &[]);
    assert_eq!(
        note_destination(Some(&unknown), "any.tex"),
        NoteDestination::Offline
    );
}
