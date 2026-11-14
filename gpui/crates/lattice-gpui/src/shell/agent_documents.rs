//! The Agent's work on the window's structured documents, as the Tauri app's
//! window hands it to its open editors (`use-synara-host.ts`'s tool routes,
//! `use-project-tree.ts`'s `createAgentProjectDocument`, the deck's
//! `onOpenSlideAgentRequest` in `use-document-surfaces.tsx`):
//!
//! - a tool call goes to the open document whose editor registered for it
//!   in the Tauri app ([`pick`]): the canvas tools to the board shown in
//!   front (only a shown board registers its adapter, `board-editor.tsx`),
//!   the range tools to the sheet they name, a page preview to an open deck
//!   (it refreshes the runtime's copy the way the deck does); with none, the
//!   Agent's page runs the call itself (`local`), as the Tauri executor does
//!   with nothing registered;
//! - a board or sheet the Agent creates is created as the Project pane
//!   creates one, opened, and answered once its editor has registered;
//! - Open Slide's Ask AI, Apply comments and Draft a deck show the Agent and
//!   hand its composer the request.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{AppContext as _, Context, Entity, Window};
use lattice_core::project as core_project;
use serde_json::{Value, json};

use super::Shell;
use crate::{
    agent::SynaraSurface,
    structured::{StructuredDocument, StructuredKind},
};

/// How often a created document is looked at while its page draws.
const DRAW_POLL: Duration = Duration::from_millis(50);

/// Which of the Agent's tool families a call is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolFamily {
    Canvas,
    Spreadsheet,
    Presentation,
}

impl ToolFamily {
    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "canvas" => Some(Self::Canvas),
            "spreadsheet" => Some(Self::Spreadsheet),
            "presentation" => Some(Self::Presentation),
            _ => None,
        }
    }
}

/// An open structured document, as [`pick`] weighs it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Candidate {
    pub kind: StructuredKind,
    pub relative: String,
    /// Its panel is displayed in its group.
    pub shown: bool,
    /// Its page is up (not hibernated, not loading).
    pub drawn: bool,
    /// It is the editor the writer was last in.
    pub front: bool,
}

fn same_path(a: &str, b: &str) -> bool {
    a.replace('\\', "/").trim_start_matches("./") == b.replace('\\', "/").trim_start_matches("./")
}

/// The document a call of `family` (Synara's `request`) goes to, by index
/// into `candidates`; `None` when no open page holds what it needs.
pub(crate) fn pick(family: ToolFamily, request: &Value, candidates: &[Candidate]) -> Option<usize> {
    let wanted = request
        .get("args")
        .and_then(|args| args.get("path"))
        .and_then(Value::as_str);
    let fits = |candidate: &Candidate| {
        candidate.drawn
            && match family {
                ToolFamily::Canvas => candidate.kind == StructuredKind::Board && candidate.shown,
                ToolFamily::Spreadsheet => {
                    candidate.kind == StructuredKind::Sheet
                        && wanted.is_some_and(|path| same_path(path, &candidate.relative))
                }
                ToolFamily::Presentation => candidate.kind == StructuredKind::Deck,
            }
    };
    // The one in front, then one on screen, then any.
    let rank = |candidate: &Candidate| (candidate.front, candidate.shown);
    candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| fits(candidate))
        .max_by_key(|(index, candidate)| (rank(candidate), std::cmp::Reverse(*index)))
        .map(|(index, _)| index)
}

/// Milliseconds left before `expires_at`, a JavaScript `Date.now()` time.
fn remaining_ms(expires_at: f64) -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or_default();
    (expires_at - now).max(0.) as u64
}

impl Shell {
    /// The window's open structured documents, with what [`pick`] weighs.
    fn structured_documents(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Vec<(Entity<StructuredDocument>, Candidate)> {
        let front = self.active_editor();
        self.open_editors()
            .into_iter()
            .filter_map(|editor| {
                let document = editor.read(cx).structured()?.clone();
                let candidate = {
                    let read = document.read(cx);
                    Candidate {
                        kind: read.kind(),
                        relative: read.relative().to_string(),
                        shown: read.is_shown(),
                        drawn: read.is_drawn(),
                        front: front.as_ref() == Some(&editor),
                    }
                };
                Some((document, candidate))
            })
            .collect()
    }

    /// Run the Agent's tool call on the open document that holds what it
    /// needs, and answer the page `{ result }` (the document page's envelope)
    /// or `{ local: true }` (no open page holds it).
    pub(crate) fn agent_document_tool(
        &mut self,
        surface: &Entity<SynaraSurface>,
        id: u64,
        family: ToolFamily,
        request: &Value,
        cx: &mut Context<Self>,
    ) {
        let documents = self.structured_documents(cx);
        let candidates: Vec<_> = documents
            .iter()
            .map(|(_, candidate)| candidate.clone())
            .collect();
        let Some(index) = pick(family, request, &candidates) else {
            surface.update(cx, |surface, cx| {
                surface.answer(id, Ok(json!({ "local": true })), cx)
            });
            return;
        };
        let document = documents[index].0.clone();
        let answer = document.update(cx, |document, cx| document.agent_tool(request.clone(), cx));
        let surface = surface.downgrade();
        cx.spawn(async move |_, cx| {
            let result = answer
                .await
                .unwrap_or_else(|_| {
                    Err("The document closed before the Agent's call finished.".into())
                })
                .map(|result| json!({ "result": result }));
            surface
                .update(cx, |surface, cx| surface.answer(id, result, cx))
                .ok();
        })
        .detach();
    }

    /// Create the board or sheet at `path` as the Project pane creates a
    /// file, open it, and answer the page with the path it was created at
    /// once its editor has registered with the Agent's tools.
    pub(crate) fn agent_create_document(
        &mut self,
        surface: &Entity<SynaraSurface>,
        id: u64,
        path: String,
        expires_at: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let answer = move |result: Result<Value, String>,
                           cx: &mut gpui::App,
                           surface: &gpui::WeakEntity<SynaraSurface>| {
            surface
                .update(cx, |surface, cx| surface.answer(id, result, cx))
                .ok();
        };
        let weak = surface.downgrade();
        let Some(project) = self.project.clone() else {
            answer(
                Err("Open a Lattice project before creating a document.".into()),
                cx,
                &weak,
            );
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let created = cx.background_spawn({
            let root = root.clone();
            async move { core_project::create_entry(&root, &path, "file") }
        });
        cx.spawn_in(window, async move |this, cx| {
            let created = match created.await {
                Ok(created) => created,
                Err(error) => {
                    cx.update(|_, cx| answer(Err(error), cx, &weak)).ok();
                    return;
                }
            };
            let document = this
                .update_in(cx, |this, window, cx| {
                    project.update(cx, |project, cx| project.rescan(cx));
                    let editor = this.open_path(root.join(&created), None, window, cx)?;
                    editor.read(cx).structured().cloned()
                })
                .ok()
                .flatten();
            let Some(document) = document else {
                let error = format!(
                    "Lattice created {created} but could not open it as a board or spreadsheet."
                );
                cx.update(|_, cx| answer(Err(error), cx, &weak)).ok();
                return;
            };
            // The page draws, then its editor registers (`agent-tools.ts`).
            while remaining_ms(expires_at) > 0
                && !cx
                    .update(|_, cx| document.read(cx).is_drawn())
                    .unwrap_or(false)
            {
                cx.background_executor().timer(DRAW_POLL).await;
            }
            let registered = cx
                .update(|_, cx| {
                    document.update(cx, |document, cx| {
                        document.agent_registered(remaining_ms(expires_at), cx)
                    })
                })
                .ok();
            let result = match registered {
                Some(registered) => match registered.await {
                    Ok(Ok(_)) => Ok(Value::String(created)),
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err(format!("{created} closed before it was ready.")),
                },
                None => Err("The window closed.".into()),
            };
            cx.update(|_, cx| answer(result, cx, &weak)).ok();
        })
        .detach();
    }

    /// A deck's Open Slide asks the Agent: show it, and hand its composer the
    /// request (`openSlideComposerPrompt`, in the Agent's page).
    pub(super) fn deck_agent_request(
        &mut self,
        request: &Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.project.is_none() {
            return;
        }
        self.show_view("agent", true, window, cx);
        let surface = self.agent.panel.read(cx).surface().clone();
        let request = request.clone();
        surface.update(cx, |surface, cx| surface.deck_request(request, cx));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(kind: StructuredKind, relative: &str) -> Candidate {
        Candidate {
            kind,
            relative: relative.into(),
            shown: true,
            drawn: true,
            front: false,
        }
    }

    fn canvas() -> Value {
        json!({ "type": "synara:canvas-tool-request", "action": "list", "args": {} })
    }

    fn sheet(path: &str) -> Value {
        json!({ "type": "synara:spreadsheet-tool-request", "action": "read", "args": { "path": path } })
    }

    #[test]
    fn canvas_tools_go_to_the_board_in_front_and_never_to_a_hidden_one() {
        let mut hidden = candidate(StructuredKind::Board, "hidden.tldr");
        hidden.shown = false;
        hidden.front = true;
        let mut front = candidate(StructuredKind::Board, "front.tldr");
        front.front = true;
        let other = candidate(StructuredKind::Board, "other.tldr");
        let paper = candidate(StructuredKind::Sheet, "results.lattice-sheet");
        let candidates = [hidden.clone(), other.clone(), front, paper];
        assert_eq!(pick(ToolFamily::Canvas, &canvas(), &candidates), Some(2));
        // With no board in front, a shown one; a hidden board holds no adapter.
        assert_eq!(
            pick(ToolFamily::Canvas, &canvas(), &[hidden.clone(), other]),
            Some(1)
        );
        assert_eq!(pick(ToolFamily::Canvas, &canvas(), &[hidden]), None);
    }

    #[test]
    fn range_tools_go_only_to_the_sheet_they_name() {
        let results = candidate(StructuredKind::Sheet, "data/results.lattice-sheet");
        let budget = candidate(StructuredKind::Sheet, "budget.lattice-sheet");
        let candidates = [budget, results];
        assert_eq!(
            pick(
                ToolFamily::Spreadsheet,
                &sheet("data/results.lattice-sheet"),
                &candidates
            ),
            Some(1)
        );
        // A sheet that is not open is the Agent page's to read from disk.
        assert_eq!(
            pick(
                ToolFamily::Spreadsheet,
                &sheet("other.lattice-sheet"),
                &candidates
            ),
            None
        );
        assert_eq!(pick(ToolFamily::Spreadsheet, &canvas(), &candidates), None);
    }

    #[test]
    fn a_page_that_is_not_up_takes_no_call() {
        let mut sleeping = candidate(StructuredKind::Sheet, "results.lattice-sheet");
        sleeping.drawn = false;
        assert_eq!(
            pick(
                ToolFamily::Spreadsheet,
                &sheet("results.lattice-sheet"),
                &[sleeping]
            ),
            None
        );
        let mut deck = candidate(StructuredKind::Deck, "slides/talk/index.tsx");
        deck.drawn = false;
        assert_eq!(
            pick(ToolFamily::Presentation, &json!({}), &[deck.clone()]),
            None
        );
        deck.drawn = true;
        deck.shown = false;
        // A deck need not be shown: its page refreshes the runtime either way.
        assert_eq!(pick(ToolFamily::Presentation, &json!({}), &[deck]), Some(0));
    }

    #[test]
    fn tool_families_are_the_agent_pages_names() {
        assert_eq!(ToolFamily::parse("canvas"), Some(ToolFamily::Canvas));
        assert_eq!(
            ToolFamily::parse("spreadsheet"),
            Some(ToolFamily::Spreadsheet)
        );
        assert_eq!(
            ToolFamily::parse("presentation"),
            Some(ToolFamily::Presentation)
        );
        assert_eq!(ToolFamily::parse("bibliography"), None);
    }
}
