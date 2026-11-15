//! What a `.tex` file's Visual page asks of its panel beyond a visual
//! editor's edits and caret (`crate::structured::LatexEvent`), and what the
//! panel tells it beyond its text (`latex_view.rs`), as the Tauri app's
//! canvas wires its source editor (`source-session.ts`,
//! `use-document-surfaces.tsx`):
//!
//! - a word added to the dictionary, or a rule or sentence ignored, from a
//!   lint's card, written to the project's manifest as the source's are
//!   (`spelling.rs`), and the spell check's settings and lists sent back;
//! - Find references and Rename on a label or citation key, the window's
//!   own flows (`shell/references_flow.rs`);
//! - an image pasted into the page, inserted as a figure as ⌘V in the source
//!   inserts one (`shell/insert_flow.rs`), at the page's caret, which the
//!   source's mirrors;
//! - the outline rail over the page: the manuscript's outline as the Tauri
//!   app's `OutlineNode`s, and a row's jump, which shows the same place in
//!   the PDF as the source's rail does;
//! - the project's local annotations, which the page marks, pins and cards
//!   as the source does (`annotations.rs`): a pin opens its note in the
//!   Annotations panel and a card's Resolve resolves it, as the source's do,
//!   and a card's Reply is saved under the project's author;
//! - co-authors' Overleaf carets, kept so a page made later starts with them
//!   (`overleaf_carets.rs`);
//! - a linked Overleaf project's comment threads on the file, marked and in
//!   margin review as in the source (`shell/overleaf_review.rs`), kept the
//!   same way; a thread card's asks go out as the source's cards' do
//!   ([`ReviewAction`]);
//! - the page's edits grouped for ⌘Z as its own history groups them (the
//!   host's CodeMirror `history()`, as in the Tauri app), so a word typed in
//!   one go is undone at once however its keystrokes' edits arrive.

use std::{ops::Range, rc::Rc};

use editor::{MultiBufferOffset, SelectionEffects};
use gpui::{Context, Entity, Window};
use language::{Bias, OffsetUtf16};
use serde_json::{Value, json};

use super::{EditorPanel, EditorPanelEvent, ReviewAction};
use crate::{
    annotations::{AnnotationRequest, store},
    outline::Heading,
    structured::{LatexEvent, StructuredDocument, StructuredEvent},
    submission::references::SymbolKind,
};

/// The manuscript's headings, flat in reading order with their depth, as the
/// Tauri app's outline tree (`OutlineNode` in `latex-outline.ts`): each
/// heading holds the ones nested under it.
pub fn outline_nodes(headings: &[Heading]) -> Value {
    fn node(index: usize, heading: &Heading) -> Value {
        let mut node = json!({
            "id": format!("{}:{}:{index}", heading.path, heading.line),
            "level": heading.level,
            "title": heading.title,
            "line": heading.line,
            "path": heading.path,
            "kind": "section",
            "children": [],
        });
        if heading.starred {
            node["starred"] = json!(true);
        }
        if heading.appendix {
            node["appendix"] = json!(true);
        }
        node
    }
    // The open headings, outermost first, each with its depth; a heading at
    // or above an open one's depth closes it into its parent.
    let mut open: Vec<(usize, Value)> = Vec::new();
    let mut roots = Vec::new();
    let close = |open: &mut Vec<(usize, Value)>, roots: &mut Vec<Value>| {
        let (_, done) = open.pop().expect("an open heading");
        match open.last_mut() {
            Some((_, parent)) => parent["children"]
                .as_array_mut()
                .expect("children")
                .push(done),
            None => roots.push(done),
        }
    };
    for (index, heading) in headings.iter().enumerate() {
        while open
            .last()
            .is_some_and(|(depth, _)| *depth >= heading.depth)
        {
            close(&mut open, &mut roots);
        }
        open.push((heading.depth, node(index, heading)));
    }
    while !open.is_empty() {
        close(&mut open, &mut roots);
    }
    Value::Array(roots)
}

impl EditorPanel {
    /// The Visual page's reports: its own asks here, a visual editor's in
    /// `markdown_view.rs`.
    pub(super) fn on_latex_document(
        &mut self,
        document: &Entity<StructuredDocument>,
        event: &StructuredEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let StructuredEvent::Latex(event) = event else {
            self.on_markdown_document(document, event, window, cx);
            return;
        };
        match event {
            LatexEvent::AddWord(word) => super::spelling::add_word(&self.project, word.clone(), cx),
            LatexEvent::Ignore(ignore) => {
                super::spelling::ignore_in_project(&self.project, ignore.clone(), cx)
            }
            LatexEvent::FindReferences { kind, symbol }
            | LatexEvent::RenameSymbol { kind, symbol } => {
                let kind = match kind.as_str() {
                    "citation" => SymbolKind::Citation,
                    _ => SymbolKind::Label,
                };
                cx.emit(EditorPanelEvent::Symbol {
                    kind,
                    symbol: symbol.clone(),
                    rename: matches!(event, LatexEvent::RenameSymbol { .. }),
                });
            }
            LatexEvent::Environment { rename } => cx.emit(EditorPanelEvent::Environment {
                rename: rename.clone(),
            }),
            LatexEvent::PasteImage => cx.emit(EditorPanelEvent::PasteImage),
            LatexEvent::OutlineJump { path, line } => cx.emit(EditorPanelEvent::OutlineJump {
                path: path.clone(),
                line: *line,
            }),
            LatexEvent::Caret(offset) => self.mirror_caret(*offset, window, cx),
            LatexEvent::OpenAnnotation(id) => {
                cx.emit(EditorPanelEvent::Annotation(AnnotationRequest::Open(id.clone())))
            }
            LatexEvent::ResolveAnnotation(id) => {
                cx.emit(EditorPanelEvent::Annotation(AnnotationRequest::Resolve(id.clone())))
            }
            LatexEvent::OverleafReply { thread, content } => {
                cx.emit(EditorPanelEvent::OverleafReview(ReviewAction::ReplyWith {
                    thread: thread.clone(),
                    content: content.clone(),
                }))
            }
            LatexEvent::OverleafResolve { thread, resolved } => {
                let thread = thread.clone();
                cx.emit(EditorPanelEvent::OverleafReview(if *resolved {
                    ReviewAction::Resolve(thread)
                } else {
                    ReviewAction::Reopen(thread)
                }))
            }
            LatexEvent::OverleafDelete(thread) => cx.emit(EditorPanelEvent::OverleafReview(
                ReviewAction::DeleteConfirmed(thread.clone()),
            )),
            LatexEvent::OverleafEditMessage { thread, message, content } => {
                cx.emit(EditorPanelEvent::OverleafReview(ReviewAction::EditMessage {
                    thread: thread.clone(),
                    message: message.clone(),
                    content: content.clone(),
                }))
            }
            LatexEvent::OverleafDeleteMessage { thread, message } => {
                cx.emit(EditorPanelEvent::OverleafReview(ReviewAction::DeleteMessage {
                    thread: thread.clone(),
                    message: message.clone(),
                }))
            }
            LatexEvent::ReplyAnnotation { id, body } => {
                let root = self.project_root(cx);
                let author = store::author(&root, cx);
                store::store(cx).update(cx, |store, cx| {
                    store.reply(&root, id, body, &author, cx);
                });
            }
        }
    }

    /// Send the Visual page the project's annotations and who signs a reply.
    pub(super) fn forward_latex_annotations(&mut self, cx: &mut Context<Self>) {
        let Some(document) = self.latex_visual_document().cloned() else {
            return;
        };
        let root = self.project_root(cx);
        let Some(store) = store::try_store(cx) else {
            return;
        };
        let comments: Vec<_> = store
            .read(cx)
            .annotations(&root)
            .into_iter()
            .filter(|comment| comment.path == self.relative)
            .cloned()
            .collect();
        let comments = serde_json::to_value(comments).unwrap_or(Value::Array(Vec::new()));
        let author = store::author(&root, cx);
        let author = json!({ "id": author.id, "name": author.name });
        document.update(cx, |document, cx| document.set_annotations(comments, author, cx));
    }

    /// Co-authors' Overleaf carets: kept, and sent to the Visual page.
    pub(super) fn latex_presence(
        &mut self,
        carets: Vec<(String, f64, u32, u32)>,
        cx: &mut Context<Self>,
    ) {
        self.latex.presence = carets;
        self.forward_latex_presence(cx);
    }

    fn forward_latex_presence(&mut self, cx: &mut Context<Self>) {
        let Some(document) = self.latex_visual_document().cloned() else {
            return;
        };
        let carets = self
            .latex
            .presence
            .iter()
            .map(|(name, hue, row, column)| crate::structured::VisualCaret {
                name: name.clone(),
                hue: *hue,
                row: *row,
                column: *column,
            })
            .collect();
        document.update(cx, |document, cx| document.set_markdown_presence(carets, cx));
    }

    /// A linked Overleaf project's threads on the file: kept, and sent to
    /// the Visual page.
    pub fn set_overleaf_visual_review(&mut self, review: Value, cx: &mut Context<Self>) {
        self.latex.overleaf = Some(review);
        self.forward_latex_overleaf(cx);
    }

    fn forward_latex_overleaf(&mut self, cx: &mut Context<Self>) {
        let (Some(document), Some(review)) =
            (self.latex_visual_document().cloned(), self.latex.overleaf.clone())
        else {
            return;
        };
        document.update(cx, |document, cx| document.set_overleaf_review(review, cx));
    }

    /// Everything the Visual page shows beside its text that comes from the
    /// window's own state: sent once it is made, and when each changes.
    pub(super) fn forward_latex_review(&mut self, cx: &mut Context<Self>) {
        self.forward_latex_annotations(cx);
        self.forward_latex_presence(cx);
        self.forward_latex_overleaf(cx);
    }

    /// Apply the page's edit in its own undo transaction, then group it as
    /// the page's history did: with the page's previous edit when `join` and
    /// nothing else has changed the buffer since, else on its own (an edit
    /// arriving within the buffer's grouping interval of the last would
    /// otherwise join it, a word typed elsewhere joining the last word).
    pub(super) fn take_grouped_page_edit(
        &mut self,
        range: Range<MultiBufferOffset>,
        insert: String,
        join: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let version = self.buffer.read(cx).version();
        let previous = self
            .latex
            .page_edit
            .take()
            .filter(|(_, after)| join && *after == version)
            .map(|(transaction, _)| transaction);
        let transaction = self.editor.update(cx, |editor, cx| {
            if previous.is_none() {
                editor.finalize_last_transaction(cx);
            }
            let transaction = editor.transact(window, cx, |editor, _, cx| {
                editor.edit([(range, insert)], cx)
            })?;
            Some(match previous {
                Some(previous) => {
                    editor.group_until_transaction(previous, cx);
                    previous
                }
                None => transaction,
            })
        });
        self.latex.page_edit = transaction.map(|transaction| (transaction, self.buffer.read(cx).version()));
    }

    /// Put the source's caret at the page's, a UTF-16 `offset`, without
    /// scrolling or taking the keyboard: what acts at the caret (a pasted
    /// figure, a symbol's references) acts where the writer is.
    /// Wrap in environment… or Rename the environment's name, sent to the
    /// Visual page while it is in front, the keyboard back in it; false when
    /// the source is in front, for the source's edit.
    pub(crate) fn edit_visual_environment(
        &mut self,
        rename: bool,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(document) = self
            .latex_visual_document()
            .filter(|_| self.shows_latex_visual(cx))
            .cloned()
        else {
            return false;
        };
        document.update(cx, |document, cx| {
            document.edit_environment(rename, name, cx)
        });
        if let Some(island) = document.read(cx).island().cloned() {
            island.update(cx, |island, cx| island.focus_page(window, cx));
        }
        true
    }

    fn mirror_caret(&mut self, offset: usize, window: &mut Window, cx: &mut Context<Self>) {
        let snapshot = self.buffer.read(cx).snapshot();
        let offset = snapshot.clip_offset_utf16(OffsetUtf16(offset), Bias::Left);
        let caret = snapshot.offset_to_point(snapshot.offset_utf16_to_offset(offset));
        self.editor.update(cx, |editor, cx| {
            editor.change_selections(SelectionEffects::no_scroll(), window, cx, |selections| {
                selections.select_ranges([caret..caret])
            });
        });
    }

    /// The manuscript's outline, as the shell last read it: the Visual
    /// page's rail follows.
    pub(super) fn note_latex_outline(&mut self, headings: Rc<[Heading]>, cx: &mut Context<Self>) {
        self.latex.headings = Some(headings);
        self.forward_latex_outline(cx);
    }

    /// Send the Visual page the outline, with a token for the PDF its pages
    /// are read from: one per build that wrote a PDF.
    pub(super) fn forward_latex_outline(&mut self, cx: &mut Context<Self>) {
        let Some(document) = self.latex_visual_document().cloned() else {
            return;
        };
        let nodes = outline_nodes(self.latex.headings.as_deref().unwrap_or_default());
        let build = self.build.read(cx);
        let pdf = build
            .last()
            .is_some_and(|last| last.wrote_pdf)
            .then(|| format!("build-{}", build.builds()));
        let root = self.latex_root.clone();
        document.update(cx, |document, cx| {
            document.set_outline(nodes, &root, pdf, cx)
        });
    }

    /// Send the Visual page whether spelling is checked, the project's
    /// dictionary and what it leaves unchecked.
    pub(super) fn forward_latex_spelling(&mut self, cx: &mut Context<Self>) {
        let Some(document) = self.latex_visual_document().cloned() else {
            return;
        };
        let input = super::spelling::input(&self.project, cx);
        document.update(cx, |document, cx| {
            document.set_spelling(
                input.enabled,
                &input.words,
                &input.ignored_rules,
                &input.ignored_sentences,
                cx,
            )
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heading(level: u8, title: &str, line: u32, depth: usize) -> Heading {
        Heading {
            level,
            title: title.into(),
            path: "main.tex".into(),
            line,
            depth,
            starred: false,
            appendix: false,
        }
    }

    /// The shape `latex-outline.ts` parses `\section{A} \subsection{A.1}
    /// \subsection{A.2} \section{B}` into: two roots, the first holding both
    /// subsections, and ids unique by file, line and place in reading order.
    #[test]
    fn nested_headings_become_the_tauri_apps_outline_tree() {
        let nodes = outline_nodes(&[
            heading(3, "A", 3, 0),
            heading(4, "A.1", 5, 1),
            heading(4, "A.2", 7, 1),
            heading(3, "B", 9, 0),
        ]);
        let titles = |nodes: &Value| -> Vec<String> {
            nodes
                .as_array()
                .unwrap()
                .iter()
                .map(|node| node["title"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(titles(&nodes), ["A", "B"]);
        assert_eq!(titles(&nodes[0]["children"]), ["A.1", "A.2"]);
        assert_eq!(titles(&nodes[1]["children"]), Vec::<String>::new());
        assert_eq!(nodes[0]["children"][1]["id"], "main.tex:7:2");
        assert_eq!(nodes[0]["level"], 3);
        assert!(nodes[0].get("starred").is_none());
    }

    #[test]
    fn a_starred_heading_in_the_appendix_says_so() {
        let mut appendix = heading(3, "Proofs", 40, 0);
        appendix.starred = true;
        appendix.appendix = true;
        let nodes = outline_nodes(&[appendix]);
        assert_eq!(nodes[0]["starred"], true);
        assert_eq!(nodes[0]["appendix"], true);
    }

    /// `\chapter{Intro}\section{Background}` on one line: the rail numbers
    /// rows by id, so the two must not share one.
    #[test]
    fn two_headings_on_one_line_get_distinct_ids() {
        let nodes = outline_nodes(&[heading(2, "Intro", 4, 0), heading(3, "Background", 4, 1)]);
        let chapter = &nodes[0]["id"];
        let section = &nodes[0]["children"][0]["id"];
        assert_eq!(nodes[0]["children"][0]["title"], "Background");
        assert_ne!(chapter, section);
    }
}
