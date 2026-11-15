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
//!   the primary bibliography as the source editor's card opens it;
//! - the spell check's settings, the project's dictionary and its ignored
//!   rules and sentences (`tex:spelling`), and a word added or a rule or
//!   sentence ignored from a lint's card ([`LatexEvent::AddWord`],
//!   [`LatexEvent::Ignore`]), written to the manifest as the source's are;
//! - the labels and citation keys nothing uses (`tex:unused`), read from the
//!   project's sources when TexLab is not there to report them, as the Tauri
//!   app's `list_unused_symbols` reads them;
//! - the manuscript's outline for the outline rail over the page
//!   (`tex:outline`), and a row's jump ([`LatexEvent::OutlineJump`]);
//! - Find references and Rename on a label or citation key, and an image
//!   pasted into the page, handed to the window's flows
//!   ([`LatexEvent::FindReferences`], [`LatexEvent::RenameSymbol`],
//!   [`LatexEvent::PasteImage`]), with the page's caret mirrored in the
//!   source ([`LatexEvent::Caret`]) so they act where the writer is.
//!
//! - the project's local annotations on the file (`tex:annotations`), which
//!   the page marks, pins and cards as the source does, and a pin's open, a
//!   card's Resolve and its Reply ([`LatexEvent::OpenAnnotation`],
//!   [`LatexEvent::ResolveAnnotation`], [`LatexEvent::ReplyAnnotation`]);
//!   co-authors' Overleaf carets come as the visual Markdown editor's do
//!   (`md:presence`, `markdown_host.rs`);
//! - a linked Overleaf project's comment threads on the file
//!   (`tex:overleaf`), which the page marks and shows in margin review as
//!   the source does, and what its cards ask of a thread
//!   ([`LatexEvent::OverleafReply`] and the others after it; a card has
//!   confirmed a deletion itself).
//!
//! The backend commands its modules invoke are answered in
//! `latex_services.rs`.

use std::path::PathBuf;

use gpui::{AppContext as _, Context, Entity};
use lattice_editor::{index::ProjectIndex, latex::spelling::Ignore, texlab::TexlabService};
use serde_json::{Value, json};

use super::{
    MarkdownEvent, StructuredDocument, StructuredEvent, StructuredKind,
    latex_services::LatexServices,
};
use crate::project::{Project, ProjectEvent};

/// What a `.tex` file's Visual page asks of its panel beside a visual
/// editor's asks ([`MarkdownEvent`]).
#[derive(Clone, Debug, PartialEq)]
pub enum LatexEvent {
    /// Add a word to the project's dictionary.
    AddWord(String),
    /// Leave a rule or a sentence unchecked in the project.
    Ignore(Ignore),
    /// List a label's (`"label"`) or citation key's (`"citation"`) uses.
    FindReferences { kind: String, symbol: String },
    /// Rename a label or citation key everywhere.
    RenameSymbol { kind: String, symbol: String },
    /// An image was pasted into the page: insert it as a figure.
    PasteImage,
    /// An outline rail row: open `path` at the 1-based `line`.
    OutlineJump { path: String, line: u32 },
    /// The page's caret, as a UTF-16 offset into the file.
    Caret(usize),
    /// A note's gutter pin: open it in the Annotations panel.
    OpenAnnotation(String),
    /// A note's card: resolve it.
    ResolveAnnotation(String),
    /// A note's card: reply to it with `body`.
    ReplyAnnotation { id: String, body: String },
    /// What an Overleaf thread's card asks, in margin review or over its
    /// mark: reply, resolve or reopen, delete, edit or delete a message.
    OverleafReply { thread: String, content: String },
    OverleafResolve { thread: String, resolved: bool },
    OverleafDelete(String),
    OverleafEditMessage { thread: String, message: String, content: String },
    OverleafDeleteMessage { thread: String, message: String },
}

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
    /// `{ enabled, words, ignores: { rules, sentences } }`, as `tex:spelling` sends it.
    spelling: Value,
    /// `{ labels, citations }` nothing uses.
    unused: Value,
    /// `{ nodes, rootPath, pdf }` for the outline rail.
    outline: Value,
    /// `{ comments, author }`: the project's annotations and who signs a reply.
    annotations: Value,
    /// `{ threads, anchors, hues, mode, canAct }`: a linked Overleaf
    /// project's comment threads on the file, for marks and margin review.
    overleaf: Value,
    /// Bumped by every read of the unused symbols, so a slow one is dropped.
    unused_generation: u64,
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
        dictionaries: Option<PathBuf>,
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
            spelling: Value::Null,
            unused: json!({ "labels": [], "citations": [] }),
            outline: Value::Null,
            annotations: Value::Null,
            overleaf: Value::Null,
            unused_generation: 0,
        });
        let texlab = project.read(cx).texlab().clone();
        this.latex_services = Some(LatexServices::new(texlab, dictionaries));
        this._subscriptions
            .push(cx.observe(&index, |this, index, cx| this.index_changed(&index, cx)));
        // A source changing on disk (a save among them) may use a label or
        // key, or stop using one; a bibliography may define or drop a key.
        this._subscriptions.push(cx.subscribe(project, |this, _, event, cx| {
            if let ProjectEvent::FilesChanged(paths) = event
                && paths.as_ref().is_none_or(|paths| {
                    paths.iter().any(|path| {
                        let path = path.to_ascii_lowercase();
                        path.ends_with(".tex") || path.ends_with(".bib")
                    })
                })
            {
                this.read_unused(cx);
            }
        }));
        this.read_unused(cx);
        this
    }

    /// Read the labels and citation keys nothing uses, off the main thread.
    /// With TexLab installed the Tauri app leaves them to TexLab's
    /// diagnostics and lists none.
    fn read_unused(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &mut self.latex else {
            return;
        };
        if TexlabService::available() {
            return;
        }
        session.unused_generation += 1;
        let generation = session.unused_generation;
        let root = self.root.clone();
        cx.spawn(async move |this, cx| {
            let unused = cx
                .background_spawn(async move { lattice_core::project::unused_symbols(&root) })
                .await;
            this.update(cx, |this, cx| {
                let Ok(unused) = unused else { return };
                let Some(session) = &mut this.latex else { return };
                if session.unused_generation != generation {
                    return;
                }
                let payload = json!({ "labels": unused.labels, "citations": unused.citations });
                if session.unused == payload {
                    return;
                }
                session.unused = payload.clone();
                this.post("tex:unused", payload, cx);
            })
            .ok();
        })
        .detach();
    }

    /// Whether Settings checks spelling, the project's dictionary and the
    /// rules and sentences it leaves unchecked.
    pub fn set_spelling(
        &mut self,
        enabled: bool,
        words: &[String],
        rules: &[String],
        sentences: &[String],
        cx: &mut Context<Self>,
    ) {
        let payload = json!({
            "enabled": enabled,
            "words": words,
            "ignores": { "rules": rules, "sentences": sentences },
        });
        self.set_latex_value(payload, "tex:spelling", |session| &mut session.spelling, cx);
    }

    /// The manuscript's outline for the rail, as `OutlineNode`s, its root
    /// document, and a token naming the PDF its pages come from (`None`
    /// before a build wrote one).
    pub fn set_outline(
        &mut self,
        nodes: Value,
        root_path: &str,
        pdf: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let payload = json!({ "nodes": nodes, "rootPath": root_path, "pdf": pdf });
        self.set_latex_value(payload, "tex:outline", |session| &mut session.outline, cx);
    }

    /// The project's local annotations (`EditorComment`s, as the Tauri app
    /// stores them) and who signs a reply (`{ id, name }`).
    pub fn set_annotations(&mut self, comments: Value, author: Value, cx: &mut Context<Self>) {
        let payload = json!({ "comments": comments, "author": author });
        self.set_latex_value(payload, "tex:annotations", |session| &mut session.annotations, cx);
    }

    /// A linked Overleaf project's comment threads on the file, as
    /// `shell/overleaf_review.rs` puts them for the Tauri app's cards.
    pub fn set_overleaf_review(&mut self, review: Value, cx: &mut Context<Self>) {
        self.set_latex_value(review, "tex:overleaf", |session| &mut session.overleaf, cx);
    }

    /// Keep `payload` in the session slot `slot` picks and post it as
    /// `kind`, when it changed.
    fn set_latex_value(
        &mut self,
        payload: Value,
        kind: &str,
        slot: impl FnOnce(&mut LatexSession) -> &mut Value,
        cx: &mut Context<Self>,
    ) {
        let Some(session) = &mut self.latex else {
            return;
        };
        let held = slot(session);
        if *held == payload {
            return;
        }
        *held = payload.clone();
        self.post(kind, payload, cx);
    }

    /// The page's own asks of its panel (`tex:*`); false when `kind` is not one.
    pub(super) fn on_latex_message(
        &mut self,
        kind: &str,
        payload: &Value,
        cx: &mut Context<Self>,
    ) -> bool {
        let text = |key: &str| {
            payload
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let event = match kind {
            "tex:open-citation" => {
                self.open_citation(payload, cx);
                return true;
            }
            "tex:add-word" => LatexEvent::AddWord(text("word")),
            "tex:ignore" => match (payload.get("rule"), payload.get("sentence")) {
                (Some(_), _) => LatexEvent::Ignore(Ignore::Rule(text("rule"))),
                (_, Some(_)) => LatexEvent::Ignore(Ignore::Sentence(text("sentence"))),
                _ => return true,
            },
            "tex:find-references" => LatexEvent::FindReferences {
                kind: text("kind"),
                symbol: text("symbol"),
            },
            "tex:rename" => LatexEvent::RenameSymbol {
                kind: text("kind"),
                symbol: text("symbol"),
            },
            "tex:paste-image" => LatexEvent::PasteImage,
            "tex:outline-jump" => LatexEvent::OutlineJump {
                path: text("path"),
                line: payload.get("line").and_then(Value::as_u64).unwrap_or(1).max(1) as u32,
            },
            "tex:caret" => LatexEvent::Caret(
                payload.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize,
            ),
            "tex:open-annotation" => LatexEvent::OpenAnnotation(text("id")),
            "tex:resolve-annotation" => LatexEvent::ResolveAnnotation(text("id")),
            "tex:reply-annotation" => LatexEvent::ReplyAnnotation {
                id: text("id"),
                body: text("body"),
            },
            "tex:overleaf-reply" => LatexEvent::OverleafReply {
                thread: text("thread"),
                content: text("content"),
            },
            "tex:overleaf-resolve" => LatexEvent::OverleafResolve {
                thread: text("thread"),
                resolved: payload.get("resolved").and_then(Value::as_bool).unwrap_or(true),
            },
            "tex:overleaf-delete" => LatexEvent::OverleafDelete(text("thread")),
            "tex:overleaf-edit-message" => LatexEvent::OverleafEditMessage {
                thread: text("thread"),
                message: text("message"),
                content: text("content"),
            },
            "tex:overleaf-delete-message" => LatexEvent::OverleafDeleteMessage {
                thread: text("thread"),
                message: text("message"),
            },
            _ => return false,
        };
        cx.emit(StructuredEvent::Latex(event));
        true
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
        payload["spelling"] = session.spelling.clone();
        payload["unused"] = session.unused.clone();
        payload["outline"] = session.outline.clone();
        payload["annotations"] = session.annotations.clone();
        payload["overleaf"] = session.overleaf.clone();
        payload["texlab"] = json!(TexlabService::available());
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
            _ => return self.invoke_latex_service(id, command, args, cx),
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
