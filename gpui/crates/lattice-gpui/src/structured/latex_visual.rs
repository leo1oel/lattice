//! A `.tex` file's Visual view: the Tauri app's source editor in Visual mode
//! (`src/editor/latex/visual/latex-visual.ts` over the CodeMirror editor
//! `src/canvas/source-session.ts` builds) in the `latex` island
//! (`gpui/islands/latex/main.tsx`, which lists the protocol), owned by a
//! [`StructuredDocument`] of kind [`StructuredKind::LatexVisual`] that the
//! panel shows in place of its source (`editor_panel/latex_view.rs`).
//!
//! It is a visual editor over the panel's buffer as a Markdown file's is
//! (`markdown.rs`): its edits come as the whole file and the text they were
//! made against, undo and redo are the buffer's, its caret is the status
//! bar's, and it reads the project's tree, its TeX sources (for the macros it
//! draws and the `\graphicspath` its figures load from) and its images
//! through the same session. Beside those, what the Tauri app's canvas gave
//! the editor as its live data (`LatexEditorLiveData`) comes from here:
//!
//! - the project's citations and labels, from the index the source editor's
//!   cards read (`tex:index`), and whether it is still being read, so a
//!   citation is not called undefined before the bibliography is in;
//! - the manuscript's root document (`tex:root`), whose folder `\input`
//!   paths are read from;
//! - the last build that wrote a PDF (`tex:build`), whose `.aux` numbers the
//!   references and equations Visual mode draws, read through the Tauri
//!   command its modules invoke (`read_project_file`);
//! - a citation's Go to entry (`tex:open-citation`), opened at its entry in
//!   the primary bibliography as the source editor's card opens it.

use gpui::{Context, Entity};
use lattice_editor::index::ProjectIndex;
use serde_json::{Value, json};

use super::{MarkdownEvent, StructuredDocument, StructuredEvent, StructuredKind};
use crate::project::Project;

/// What a `.tex` file's Visual page last had of the project beyond the
/// visual editors' session.
pub(super) struct LatexSession {
    project_index: Entity<ProjectIndex>,
    /// `{ citations, references, pending }`, as `tex:index` sends it.
    index: Value,
    /// The manuscript's root document, project-relative.
    root_document: Option<String>,
    /// `{ rootDocument, auxFolder }` of the last build that wrote a PDF.
    build: Value,
}

/// The index as the page's `CitationInfo` and `ReferenceInfo` lists have it
/// (`src/editor/latex/latex-text.ts`).
fn index_payload(index: &ProjectIndex) -> Value {
    let citations = index
        .citations()
        .iter()
        .map(|citation| {
            let mut entry = json!({
                "key": citation.key,
                "title": citation.title,
                "authors": citation.authors,
                "year": citation.year,
                "venue": citation.venue,
            });
            for (field, value) in [
                ("doi", &citation.doi),
                ("url", &citation.url),
                ("arxivId", &citation.arxiv_id),
            ] {
                if let Some(value) = value {
                    entry[field] = json!(value);
                }
            }
            entry
        })
        .collect::<Vec<_>>();
    let references = index
        .references()
        .iter()
        .map(|reference| {
            json!({
                "label": reference.label,
                "kind": reference.kind,
                "title": reference.title,
                "snippet": reference.snippet,
                "path": reference.path,
                "line": reference.line,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "citations": citations,
        "references": references,
        "pending": index.is_loading(),
    })
}

/// The build the page numbers its labels from, as `CompiledBuild` has it.
fn build_payload(build: Option<(&str, &str)>) -> Value {
    match build {
        Some((root_document, aux_folder)) => json!({
            "rootDocument": root_document,
            "auxFolder": aux_folder,
        }),
        None => Value::Null,
    }
}

impl StructuredDocument {
    /// A `.tex` file's Visual view over `source`, following `project`'s
    /// files and index.
    pub fn latex_visual(
        project: &Entity<Project>,
        relative: String,
        source: String,
        window: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self::visual_editor(
            StructuredKind::LatexVisual,
            project,
            relative,
            source,
            window,
            cx,
        );
        let index = project.read(cx).index().clone();
        this.latex = Some(LatexSession {
            project_index: index.clone(),
            index: index_payload(index.read(cx)),
            root_document: None,
            build: Value::Null,
        });
        this._subscriptions
            .push(cx.observe(&index, |this, index, cx| this.index_changed(&index, cx)));
        this
    }

    /// The project's index was read again: the page gets it when it changed.
    fn index_changed(&mut self, index: &Entity<ProjectIndex>, cx: &mut Context<Self>) {
        let payload = index_payload(index.read(cx));
        let Some(session) = &mut self.latex else {
            return;
        };
        if session.index == payload {
            return;
        }
        session.index = payload.clone();
        self.post("tex:index", payload, cx);
    }

    /// The manuscript's root document, which `\input` paths are read from.
    pub fn set_root_document(&mut self, root: String, cx: &mut Context<Self>) {
        let Some(session) = &mut self.latex else {
            return;
        };
        let root = (!root.is_empty()).then_some(root);
        if session.root_document == root {
            return;
        }
        session.root_document = root.clone();
        self.post("tex:root", json!({ "path": root }), cx);
    }

    /// The last build that wrote a PDF, as its root document and the folder
    /// its `.aux` files went to; `None` before one.
    pub fn set_compiled_build(&mut self, build: Option<(&str, &str)>, cx: &mut Context<Self>) {
        let payload = build_payload(build);
        let Some(session) = &mut self.latex else {
            return;
        };
        if session.build == payload {
            return;
        }
        session.build = payload.clone();
        self.post("tex:build", json!({ "build": payload }), cx);
    }

    /// ⌘F, ⌘G and ⇧⌘G in the Visual view: the page's own search panel
    /// opens, or steps to the `"next"` or `"previous"` match.
    pub fn find(&mut self, step: &str, cx: &mut Context<Self>) {
        self.post("tex:find", json!({ "step": step }), cx);
    }

    /// A citation's Go to entry: its entry in the primary bibliography.
    pub(super) fn open_citation(&mut self, payload: &Value, cx: &mut Context<Self>) {
        let Some(session) = &self.latex else {
            return;
        };
        let key = payload.get("key").and_then(Value::as_str).unwrap_or_default();
        if let Some((path, line)) = session.project_index.read(cx).citation_entry(key) {
            cx.emit(StructuredEvent::Markdown(MarkdownEvent::OpenLocation(
                path, line,
            )));
        }
    }

    /// The fields of `doc:open` a `.tex` file's Visual page needs beside a
    /// visual editor's.
    pub(super) fn latex_open(&self, payload: &mut Value) {
        let Some(session) = &self.latex else {
            return;
        };
        payload["index"] = session.index.clone();
        payload["rootDocument"] = json!(session.root_document);
        payload["build"] = session.build.clone();
    }

    /// One of the Tauri commands Visual mode's modules invoke; false when
    /// `command` is not one of them.
    pub(super) fn invoke_latex(
        &mut self,
        id: u64,
        command: &str,
        args: &Value,
        cx: &mut Context<Self>,
    ) -> bool {
        match command {
            // A build's `.aux` files and the entry files of editable figures.
            "read_project_file" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let root = self.root.clone();
                self.answer_off_thread(id, cx, move || {
                    lattice_core::project::read_file(&root, &path).map(Value::String)
                });
            }
            _ => return false,
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_build_is_named_as_compiled_build_names_it() {
        assert_eq!(build_payload(None), Value::Null);
        assert_eq!(
            build_payload(Some(("paper/main.tex", ".research/build/paper"))),
            json!({ "rootDocument": "paper/main.tex", "auxFolder": ".research/build/paper" })
        );
    }
}
