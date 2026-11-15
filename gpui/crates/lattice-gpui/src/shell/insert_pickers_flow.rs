//! The window's side of the insert pickers and Go to symbol
//! (`search/insert_pickers.rs`, `app-search-dialogs.tsx`): ⌘⇧K Insert
//! citation and ⌘⇧L Insert reference in a LaTeX source, ⌘⇧O Go to symbol in
//! any text editor, each quick open's card on its own list in quick open's
//! place over the documents. A cite or ref pick writes `\cite{key}` or
//! `\ref{label}` at the caret, the caret after it and the keyboard back in
//! the text (`citeInsertRequest` in `document-canvas.tsx`); Insert citation
//! also ticks Get started's "Cite a paper". ⌘G opens Go to line
//! (`search/goto_line.rs`) on the editor in front.

use gpui::{
    AppContext as _, Context, Entity, InteractiveElement as _, Subscription, Window, actions,
};
use lattice_i18n::t;

use super::{
    Shell,
    commands::{Command, Section},
    parts::Part,
};
use crate::search::{
    goto_line::{GotoLineDialog, GotoLineEvent},
    insert_pickers::{PickerKind, citation_items, inserted, reference_items},
    live_labels::{local_labels, merge_references},
    quick_open::{QuickOpen, QuickOpenEvent, QuickOpenSource},
};

actions!(
    lattice,
    [InsertCitation, InsertReference, GoToSymbol, GoToLine]
);

/// The open Go to line dialog, and what it reports to.
#[derive(Default)]
pub(crate) struct GotoLine {
    open: Option<(Entity<GotoLineDialog>, Subscription)>,
}

impl GotoLine {
    pub(super) fn close(&mut self) {
        self.open = None;
    }
}

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(GotoLine::default()),
    views: &[],
    actions: |element, cx| {
        element
            .on_action(cx.listener(|this, _: &InsertCitation, window, cx| {
                this.open_picker(PickerKind::InsertCitation, window, cx)
            }))
            .on_action(cx.listener(|this, _: &InsertReference, window, cx| {
                this.open_picker(PickerKind::InsertReference, window, cx)
            }))
            .on_action(cx.listener(|this, _: &GoToSymbol, window, cx| {
                this.open_picker(PickerKind::GoToSymbol, window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &GoToLine, window, cx| this.open_goto_line(window, cx)),
            )
    },
    commands: |context, out| {
        if context.text_editor {
            out.push(Command::new(
                "goto-line",
                t!("Go to line"),
                Section::Navigate,
                GoToLine,
            ));
            out.push(Command::new(
                "goto-symbol",
                t!("Go to symbol"),
                Section::Navigate,
                GoToSymbol,
            ));
        }
        if context.latex_source {
            out.push(Command::new(
                "cite",
                t!("Insert citation"),
                Section::Edit,
                InsertCitation,
            ));
            out.push(Command::new(
                "ref",
                t!("Insert reference"),
                Section::Edit,
                InsertReference,
            ));
        }
    },
};

impl Shell {
    /// A text editor is in front (`textEditor`): a source, not a board,
    /// sheet or deck.
    pub(crate) fn text_editor_in_front(&self, cx: &gpui::App) -> bool {
        self.active_editor()
            .is_some_and(|editor| editor.read(cx).structured().is_none())
    }

    /// Open `kind`'s picker in quick open's place, or close it again.
    pub(crate) fn open_picker(
        &mut self,
        kind: PickerKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .documents
            .quick_open
            .as_ref()
            .is_some_and(|open| open.read(cx).picker_kind() == Some(kind))
        {
            self.close_document_overlays(window, cx);
            return;
        }
        let applies = match kind {
            PickerKind::GoToSymbol => self.text_editor_in_front(cx),
            PickerKind::InsertCitation | PickerKind::InsertReference => {
                self.latex_source_in_front(cx)
            }
        };
        let Some(project) = self.project.clone().filter(|_| applies) else {
            return;
        };
        if !self.dismiss_overlays_for_documents(cx) {
            return;
        }
        let live = self.live_latex(cx);
        let (root, main, items) = {
            let project = project.read(cx);
            let index = project.index().read(cx);
            let items = match kind {
                PickerKind::InsertCitation => Some(citation_items(index.citations())),
                PickerKind::InsertReference => Some(reference_items(&match &live {
                    Some((path, text)) => {
                        merge_references(index.references(), path, local_labels(path, text))
                    }
                    None => index.references().to_vec(),
                })),
                // Read in the background from the main document, as `@` is.
                PickerKind::GoToSymbol => None,
            };
            (
                project.root().to_path_buf(),
                project.main_document().map(str::to_string),
                items,
            )
        };
        let current = self
            .active_editor()
            .map(|editor| editor.read(cx).relative().to_string());
        let source = QuickOpenSource {
            paths: Vec::new(),
            recent: Vec::new(),
            line_target: current.clone(),
            current,
            root,
            main,
            live,
        };
        let weak = cx.entity().downgrade();
        let view = cx.new(|cx| QuickOpen::picker(weak, kind, items, source, window, cx));
        cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            QuickOpenEvent::Dismiss => this.close_document_overlays(window, cx),
        })
        .detach();
        view.update(cx, |view, cx| view.focus_input(window, cx));
        self.documents.quick_open = Some(view);
        cx.notify();
    }

    /// The LaTeX source in front, its path and its unsaved text, which the
    /// pickers' labels and sections are read from over the saved ones
    /// (`liveReferences`, `outlineNodes`).
    pub(crate) fn live_latex(&self, cx: &gpui::App) -> Option<(String, String)> {
        let editor = self
            .active_editor()
            .filter(|_| self.latex_source_in_front(cx))?;
        let editor = editor.read(cx);
        Some((editor.relative().to_string(), editor.text_and_caret(cx).0))
    }

    /// A cite or ref pick: `\command{key}` at the editor's caret.
    pub(crate) fn insert_at_caret(
        &mut self,
        command: &str,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(editor) = self.active_editor() else {
            return;
        };
        let text = inserted(command, key);
        editor.update(cx, |editor, cx| {
            let (_, caret) = editor.text_and_caret(cx);
            editor.replace_range(caret, caret, &text, caret + text.len(), window, cx);
        });
        if command == "cite" {
            crate::get_started::progress::mark(crate::get_started::Step::Cite, cx);
        }
    }

    /// Whether Go to line is open.
    pub(crate) fn goto_line_open(&self) -> bool {
        self.parts.get::<GotoLine>().open.is_some()
    }

    /// The open Go to line dialog, for the window to draw.
    pub(super) fn goto_line_dialog(&self) -> Option<Entity<GotoLineDialog>> {
        self.parts
            .get::<GotoLine>()
            .open
            .as_ref()
            .map(|(dialog, _)| dialog.clone())
    }

    /// ⌘G: Go to line on the text editor in front, starting from its
    /// caret's line; or closed again.
    pub(crate) fn open_goto_line(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.goto_line_open() {
            self.close_document_overlays(window, cx);
            return;
        }
        if !self.text_editor_in_front(cx) {
            return;
        }
        let Some(editor) = self.active_editor() else {
            return;
        };
        if !self.dismiss_overlays_for_documents(cx) {
            return;
        }
        let (text, caret) = editor.read(cx).text_and_caret(cx);
        let line = text[..caret.min(text.len())].matches('\n').count() as u32 + 1;
        let max_line = text.matches('\n').count() as u32 + 1;
        let dialog = cx.new(|cx| GotoLineDialog::new(line, max_line, window, cx));
        let target = editor.downgrade();
        let events = cx.subscribe_in(&dialog, window, move |this, _, event, window, cx| {
            this.parts.get_mut::<GotoLine>().open = None;
            match event {
                GotoLineEvent::Go(line) => {
                    if let Some(editor) = target.upgrade() {
                        editor.update(cx, |editor, cx| editor.go_to_line(*line, window, cx));
                    }
                }
                GotoLineEvent::Close => this.focus_front(window, cx),
            }
            cx.notify();
        });
        self.parts.get_mut::<GotoLine>().open = Some((dialog, events));
        cx.notify();
    }
}
