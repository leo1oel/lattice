//! What a saved paper's full text asks of its owner for the reader's
//! selection actions (`paper-selection-actions.tsx`, which the page shows
//! over the text as the Tauri reader does):
//!
//! - `md:locate-quote`: the page of the paper's PDF that holds a selected
//!   passage, and the words that name it there (`usePaperPdf().locateQuote`,
//!   `quote_page.rs`), for Copy source link and Add to note;
//! - the Tauri commands `paper-notes.ts` invokes to append the passage to
//!   the paper's note (`stat_project_file`, `read_project_file`,
//!   `write_project_file`), answered for that one file alone: the page may
//!   write the note of the paper it shows, and nothing else in the project.

use gpui::Context;
use lattice_core::project as core_project;
use serde_json::{Value, json};

use super::{QuotePdf, StructuredDocument, text};
use crate::papers::{paper_note::note_file, reader::quote_page::locate_quote};

impl StructuredDocument {
    /// The paper's note, from the project root, while the page shows a
    /// paper's reading text.
    fn paper_note(&self) -> Option<String> {
        let paper = self.markdown.as_ref()?.paper.as_ref()?;
        Some(note_file(
            paper.note.citation_key.as_deref(),
            &paper.note.arxiv_id,
        ))
    }

    /// `md:locate-quote { quote }`: the passage's place in the paper's PDF,
    /// `null` when no page holds it once.
    pub(super) fn locate_paper_quote(&mut self, id: u64, payload: &Value, cx: &mut Context<Self>) {
        let pdf: Option<QuotePdf> = self
            .markdown
            .as_ref()
            .and_then(|session| session.paper.as_ref())
            .and_then(|paper| paper.quote_pdf.clone());
        let Some(pdf) = pdf else {
            self.respond(id, Ok(Value::Null), cx);
            return;
        };
        let quote = text(payload, "quote").unwrap_or_default();
        let located = locate_quote(pdf, quote, cx);
        cx.spawn(async move |this, cx| {
            let result = located.await.map(|place| {
                place.map_or(
                    Value::Null,
                    |place| json!({ "page": place.page, "first": place.first, "last": place.last }),
                )
            });
            this.update(cx, |this, cx| this.respond(id, result, cx))
                .ok();
        })
        .detach();
    }

    /// One of the commands `paper-notes.ts` invokes, on the paper's note;
    /// false when `command` is not one of them.
    pub(super) fn invoke_paper_note(
        &mut self,
        id: u64,
        command: &str,
        args: &Value,
        cx: &mut Context<Self>,
    ) -> bool {
        if !matches!(
            command,
            "stat_project_file" | "read_project_file" | "write_project_file"
        ) {
            return false;
        }
        let path = text(args, "path").unwrap_or_default();
        if self.paper_note().as_deref() != Some(path.as_str()) {
            self.respond(id, Err(format!("{command} is not available here")), cx);
            return true;
        }
        let root = self.root.clone();
        match command {
            "stat_project_file" => {
                let exists = root.join(&path).is_file();
                self.respond(id, Ok(json!({ "exists": exists })), cx);
            }
            "read_project_file" => self.answer_off_thread(id, cx, move || {
                core_project::read_file(&root, &path).map(Value::String)
            }),
            _ => {
                let content = text(args, "content").unwrap_or_default();
                let base = text(args, "baseContent");
                self.answer_off_thread(id, cx, move || {
                    // The text read is the base: an edit that lands
                    // meanwhile is merged, not overwritten.
                    core_project::apply_editor_transaction(&root, path, content, base, None)
                        .map(|_| Value::Null)
                });
            }
        }
        true
    }
}
