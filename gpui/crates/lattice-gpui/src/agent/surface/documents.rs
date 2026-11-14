//! What the Agent's page asks of the window's documents, and what the window
//! tells it of them (`shell/agent_documents.rs` answers):
//!
//! Page to host (requests):
//!   agent:document-tool   { family, request }      a canvas, spreadsheet or presentation tool call
//!                                                  → `{ result }` from the open document's page,
//!                                                    or `{ local: true }` to run it in the page
//!   agent:create-document { path, documentType, expiresAt }  → the created path, once ready
//! Host to page:
//!   agent:deck-request    { kind, deckPath }       Open Slide's request for the composer
//!   agent:files-changed   { paths }                the project watcher's burst (`null`: anything)
//!   agent:overleaf        { linked, docPaths }     the project's Overleaf link and its documents
//!
//! A page preview with no deck open runs in the Agent's page, which starts
//! Open Slide through the same `presentation_*` commands a deck's page
//! invokes; the surface holds that standing ([`DeckSession`]) as a deck does.

use gpui::{App, Context};
use serde_json::{Value, json};

use super::{SurfaceEvent, SynaraSurface};
use crate::structured::DeckSession;

/// The `presentation_*` commands the Agent's own page preview invokes.
pub(super) fn is_presentation(command: &str) -> bool {
    command.starts_with("presentation_") && crate::structured::deck_handles(command)
}

/// The window's answer to a request the page made of its documents.
pub(super) fn document_request(id: u64, kind: &str, payload: &Value) -> Option<SurfaceEvent> {
    match kind {
        "agent:document-tool" => Some(SurfaceEvent::DocumentTool {
            id,
            family: payload.get("family")?.as_str()?.to_string(),
            request: payload.get("request")?.clone(),
        }),
        "agent:create-document" => {
            let path = payload.get("path")?.as_str()?.trim();
            let document_type = payload.get("documentType")?.as_str()?;
            // The Tauri app's closed set (`agent-project-document-tools.ts`).
            let extension = match document_type {
                "board" => ".tldr",
                "spreadsheet" => ".lattice-sheet",
                _ => return None,
            };
            if path.is_empty() || !path.to_lowercase().ends_with(extension) {
                return None;
            }
            Some(SurfaceEvent::CreateDocument {
                id,
                path: path.to_string(),
                expires_at: payload.get("expiresAt")?.as_f64()?,
            })
        }
        _ => None,
    }
}

impl SynaraSurface {
    /// Answer the page's request `id`.
    pub fn answer(&self, id: u64, result: Result<Value, String>, cx: &mut App) {
        self.respond(id, result, cx);
    }

    /// Open Slide asks the Agent's composer for `request`.
    pub fn deck_request(&self, request: Value, cx: &mut App) {
        self.post("agent:deck-request", request, cx);
    }

    /// The project's files changed on disk (the paper library follows).
    pub fn files_changed(&self, paths: Option<&[String]>, cx: &mut App) {
        self.post("agent:files-changed", json!({ "paths": paths }), cx);
    }

    /// The project's Overleaf link, and its documents' paths by id, for the
    /// Agent's view of the project's comments.
    pub fn set_overleaf(&mut self, overleaf: Value, cx: &mut App) {
        if self.overleaf == overleaf {
            return;
        }
        self.overleaf = overleaf.clone();
        self.post("agent:overleaf", overleaf, cx);
    }

    /// A `presentation_*` command of the page's own page preview, answered
    /// through this surface's standing with Open Slide.
    pub(super) fn invoke_deck(
        &mut self,
        id: u64,
        command: &str,
        args: &Value,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root.clone() else {
            self.respond(id, Err("No project is open.".into()), cx);
            return;
        };
        let deck = self.deck.get_or_insert_with(|| DeckSession::new(&root, cx));
        let task = deck.invoke(command, args, cx);
        let ensures = command == "presentation_ensure_ready";
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                // The preview's hidden frame loads the runtime's origin.
                if ensures
                    && let Ok(info) = &result
                    && let Some(origin) = info.get("origin").and_then(Value::as_str)
                    && let Some(island) = &this.island
                {
                    island.update(cx, |island, _| island.allow_frame_origin(origin));
                }
                this.respond(id, result, cx);
            })
            .ok();
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_call_carries_its_family_and_synaras_envelope() {
        let request = json!({ "type": "synara:canvas-tool-request", "id": "a" });
        assert_eq!(
            document_request(
                7,
                "agent:document-tool",
                &json!({ "family": "canvas", "request": request })
            ),
            Some(SurfaceEvent::DocumentTool {
                id: 7,
                family: "canvas".into(),
                request
            })
        );
        assert_eq!(
            document_request(7, "agent:document-tool", &json!({ "family": "canvas" })),
            None
        );
    }

    #[test]
    fn the_agent_creates_only_boards_and_sheets_under_their_own_extension() {
        let create = |path: &str, kind: &str| {
            document_request(
                3,
                "agent:create-document",
                &json!({ "path": path, "documentType": kind, "expiresAt": 10.0 }),
            )
        };
        assert_eq!(
            create("notes/plan.tldr", "board"),
            Some(SurfaceEvent::CreateDocument {
                id: 3,
                path: "notes/plan.tldr".into(),
                expires_at: 10.
            })
        );
        assert!(create("results.lattice-sheet", "spreadsheet").is_some());
        // A sheet's name for a board, a TeX file, another kind: refused.
        assert_eq!(create("results.lattice-sheet", "board"), None);
        assert_eq!(create("main.tex", "spreadsheet"), None);
        assert_eq!(create("talk/index.tsx", "deck"), None);
    }

    #[test]
    fn only_the_runtimes_commands_are_the_previews() {
        assert!(is_presentation("presentation_ensure_ready"));
        assert!(is_presentation("presentation_release"));
        assert!(is_presentation("presentation_refresh_native_workspace"));
        assert!(!is_presentation("read_project_file"));
        assert!(!is_presentation("presentation_delete_everything"));
    }
}
