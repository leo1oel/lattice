//! What the Agent is told of the window beyond the source editor, as the
//! Tauri app's `useAgentContext` (`src/app/use-agent-context.ts`) gathers it:
//!
//! - the one shared selection, owned by whichever surface last reported one
//!   (the editor, or the PDF): an empty report from one pane never wipes a
//!   selection the other owns, a surface activated away from the owner lets
//!   the owner's selection go, and a selection the Agent took stays out until
//!   it changes ([`SharedSelection`]);
//! - what a document in front reports of itself, as its page last said: the
//!   visual Markdown editor's selection (`onSelectionMarkdown`) and Open
//!   Slide's deck and slide (`onContext`), which the document keeps;
//! - the surface being worked in, the compiled PDF's page and page count,
//!   and a project PDF's place when its selection is the one shared;
//! - a paper in its reader in front (`activePaper`, `paperView`), whose
//!   text's selection is the paper's.
//!
//! The page builds the snapshot itself with `buildAgentHostContext`
//! (`islands/agent/main.tsx`); this assembles its inputs.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

/// A surface that can own the shared selection (`AgentHostSurface`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Source {
    Editor,
    Pdf,
    /// A paper's text in its reader.
    Paper,
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Pdf => "pdf",
            Self::Paper => "paper",
        }
    }
}

/// A selection as a surface reports it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Selected {
    pub text: String,
    /// The whole selection's length, when `text` was cut before it got here.
    pub length: Option<usize>,
    /// The source editor's lines (`selectionLines`).
    pub lines: Option<(u32, u32)>,
    /// A project PDF open as a document, and where in it (`selectionPdfDocument`).
    pub pdf_document: Option<Value>,
}

/// The one selection the Agent sees, and which surface owns it.
#[derive(Default)]
pub struct SharedSelection {
    owner: Option<Source>,
    selected: Selected,
    /// What each surface reported last, so only a change is a report.
    last: HashMap<Source, String>,
    /// The selection the Agent took: its surface does not re-report it.
    dismissed: Option<(Source, String)>,
}

impl SharedSelection {
    pub fn owner(&self) -> Option<Source> {
        self.owner
    }

    pub fn selected(&self) -> &Selected {
        &self.selected
    }

    /// `source` shows `selected` now (empty: nothing); a report only when it
    /// changed since that surface's last (`reportSelection`).
    pub fn observe(&mut self, source: Source, selected: Selected) {
        if self.last.get(&source) == Some(&selected.text) {
            // The same text with new details (a PDF's page read later).
            if self.owner == Some(source) && !selected.text.is_empty() {
                self.selected = selected;
            }
            return;
        }
        self.last.insert(source, selected.text.clone());
        if !selected.text.is_empty()
            && self
                .dismissed
                .as_ref()
                .is_some_and(|(by, text)| *by == source && *text == selected.text)
        {
            return;
        }
        if selected.text.is_empty() {
            if self.dismissed.as_ref().is_some_and(|(by, _)| *by == source) {
                self.dismissed = None;
            }
            if self.owner == Some(source) {
                self.owner = None;
                self.selected = Selected::default();
            }
            return;
        }
        self.dismissed = None;
        self.owner = Some(source);
        self.selected = selected;
    }

    /// The Agent took the selection: it goes until its surface selects
    /// something else (`dismissSelection`).
    pub fn dismiss(&mut self) {
        if let Some(owner) = self.owner.take()
            && !self.selected.text.is_empty()
        {
            self.dismissed = Some((owner, std::mem::take(&mut self.selected.text)));
        }
        self.selected = Selected::default();
    }

    /// The writer moved to `surface` (`activateSurface`): another surface's
    /// selection goes, as a press elsewhere lets it go.
    pub fn activate(&mut self, surface: Source) {
        match self.owner {
            Some(owner) if owner == surface => {}
            Some(_) => self.dismiss(),
            None => {
                if self
                    .dismissed
                    .as_ref()
                    .is_some_and(|(by, _)| *by == surface)
                {
                    self.dismissed = None;
                }
            }
        }
    }
}

/// `useAgentContext`'s inputs for the page (`Workspace` in the island).
pub struct Inputs<'a> {
    /// The project file in front: the editor's, a board's, an image's, a
    /// project PDF's.
    pub active_file: &'a str,
    /// The source editor's caret, when a text editor is in front.
    pub editor_position: Option<Value>,
    pub surface: Source,
    /// The compiled PDF's page (1-based) and page count.
    pub pdf_page: usize,
    pub pdf_page_count: Option<usize>,
    pub presentation: Option<Value>,
    /// The paper in its reader in front, as its summary (`PaperSummary`),
    /// and the text it shows (`"blog"` or `"fulltext"`).
    pub paper: Option<(Value, &'static str)>,
    pub selection: &'a SharedSelection,
}

pub fn workspace(inputs: Inputs<'_>) -> Value {
    let mut workspace = Map::new();
    workspace.insert("activeFile".into(), json!(inputs.active_file));
    workspace.insert(
        "editorPosition".into(),
        inputs.editor_position.unwrap_or(Value::Null),
    );
    workspace.insert("activeSurface".into(), json!(inputs.surface.name()));
    workspace.insert(
        "canvasMode".into(),
        json!(match inputs.surface {
            Source::Pdf => "pdf",
            Source::Editor | Source::Paper => "split",
        }),
    );
    workspace.insert("pdfPage".into(), json!(inputs.pdf_page.max(1)));
    workspace.insert("pdfPageCount".into(), json!(inputs.pdf_page_count));
    workspace.insert(
        "presentation".into(),
        inputs.presentation.unwrap_or(Value::Null),
    );
    let (paper, view) = inputs.paper.unwrap_or((Value::Null, "blog"));
    workspace.insert("activePaper".into(), paper);
    workspace.insert("paperView".into(), json!(view));
    if let Some(owner) = inputs.selection.owner() {
        let selected = inputs.selection.selected();
        workspace.insert("selection".into(), json!(selected.text));
        workspace.insert("selectionLength".into(), json!(selected.length));
        workspace.insert("selectionSource".into(), json!(owner.name()));
        workspace.insert(
            "selectionLines".into(),
            selected.lines.map_or(
                Value::Null,
                |(start, end)| json!({ "start": start, "end": end }),
            ),
        );
        workspace.insert(
            "selectionPdfDocument".into(),
            selected.pdf_document.clone().unwrap_or(Value::Null),
        );
    }
    Value::Object(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(text: &str) -> Selected {
        Selected {
            text: text.into(),
            ..Selected::default()
        }
    }

    // `use-agent-context.ts`: in split view the editor and the PDF share one
    // selection; an empty report from one pane leaves the other's alone.
    #[test]
    fn an_empty_report_never_wipes_the_other_panes_selection() {
        let mut shared = SharedSelection::default();
        shared.observe(Source::Editor, text("a theorem"));
        shared.observe(Source::Pdf, text(""));
        assert_eq!(shared.owner(), Some(Source::Editor));
        shared.observe(Source::Pdf, text("from the PDF"));
        assert_eq!(shared.owner(), Some(Source::Pdf));
        assert_eq!(shared.selected().text, "from the PDF");
        // The editor still shows its old selection: unchanged, no report.
        shared.observe(Source::Editor, text("a theorem"));
        assert_eq!(shared.owner(), Some(Source::Pdf));
        shared.observe(Source::Pdf, text(""));
        assert_eq!(shared.owner(), None);
    }

    #[test]
    fn a_dismissed_selection_stays_out_until_it_changes() {
        let mut shared = SharedSelection::default();
        shared.observe(Source::Editor, text("taken"));
        shared.dismiss();
        assert_eq!(shared.owner(), None);
        shared.observe(Source::Editor, text("taken"));
        assert_eq!(shared.owner(), None);
        shared.observe(Source::Editor, text("taken again"));
        assert_eq!(shared.owner(), Some(Source::Editor));
    }

    #[test]
    fn moving_to_another_surface_lets_the_owners_selection_go() {
        let mut shared = SharedSelection::default();
        shared.observe(Source::Editor, text("kept"));
        shared.activate(Source::Editor);
        assert_eq!(shared.owner(), Some(Source::Editor));
        shared.activate(Source::Pdf);
        assert_eq!(shared.owner(), None);
        // The editor re-showing that selection does not bring it back.
        shared.observe(Source::Editor, text("kept"));
        assert_eq!(shared.owner(), None);
    }

    #[test]
    fn the_workspace_carries_the_owner_and_the_pdf() {
        let mut shared = SharedSelection::default();
        shared.observe(
            Source::Pdf,
            Selected {
                text: "attention".into(),
                pdf_document: Some(json!({ "path": "paper.pdf", "page": 2, "pageCount": 9 })),
                ..Selected::default()
            },
        );
        let workspace = workspace(Inputs {
            active_file: "paper.pdf",
            editor_position: None,
            surface: Source::Pdf,
            pdf_page: 3,
            pdf_page_count: Some(12),
            presentation: None,
            paper: None,
            selection: &shared,
        });
        assert_eq!(workspace["activeSurface"], "pdf");
        assert_eq!(workspace["selectionSource"], "pdf");
        assert_eq!(workspace["selectionPdfDocument"]["page"], 2);
        assert_eq!(workspace["pdfPage"], 3);
        assert_eq!(workspace["pdfPageCount"], 12);
        let none = super::workspace(Inputs {
            active_file: "main.tex",
            editor_position: Some(json!({ "path": "main.tex", "line": 4, "column": 0 })),
            surface: Source::Editor,
            pdf_page: 0,
            pdf_page_count: None,
            presentation: None,
            paper: None,
            selection: &SharedSelection::default(),
        });
        assert!(none.get("selection").is_none());
        assert_eq!(none["activePaper"], Value::Null);
        assert_eq!(none["pdfPage"], 1);
        assert_eq!(none["editorPosition"]["line"], 4);
    }

    // `buildAgentHostContext` takes a paper in front, with the paper's own
    // selection, before the editor's file.
    #[test]
    fn a_paper_in_front_carries_its_summary_view_and_selection() {
        let mut shared = SharedSelection::default();
        shared.observe(Source::Editor, text("from the source"));
        shared.activate(Source::Paper);
        shared.observe(Source::Paper, text("scaled dot-product attention"));
        let workspace = workspace(Inputs {
            active_file: ".research/papers/1706.03762/paper.md",
            editor_position: None,
            surface: Source::Paper,
            pdf_page: 1,
            pdf_page_count: None,
            presentation: None,
            paper: Some((
                json!({ "arxivId": "1706.03762", "title": "Attention" }),
                "fulltext",
            )),
            selection: &shared,
        });
        assert_eq!(workspace["activeSurface"], "paper");
        assert_eq!(workspace["activePaper"]["arxivId"], "1706.03762");
        assert_eq!(workspace["paperView"], "fulltext");
        assert_eq!(workspace["selectionSource"], "paper");
        assert_eq!(workspace["selection"], "scaled dot-product attention");
    }
}
