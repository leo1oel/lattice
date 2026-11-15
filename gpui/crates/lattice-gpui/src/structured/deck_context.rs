//! What an Open Slide deck tells the rest of the window
//! (`open-slide-workspace.tsx`'s `onContext`, `open_project_window`):
//!
//! - the slide and element selected in the deck, and whether an inspector
//!   edit is still uncommitted (`OpenSlideContext`), which the Agent is
//!   told as its `presentation` context (`use-document-surfaces.tsx`'s
//!   `onOpenSlideContext`) and which keeps the deck's file out of Overleaf
//!   uploads until it lands (`wholeFileDraftPaths`);
//! - "Switch to that window" when another project's window holds the Open
//!   Slide runtime: that window comes forward, or the project opens in one.

use std::path::PathBuf;

use gpui::{App, Context};
use serde_json::Value;

use super::{StructuredDocument, StructuredEvent};

impl StructuredDocument {
    /// The deck's selection and pending edits, as last reported; none
    /// before the deck has said, or once it has nothing selected.
    pub fn deck_context(&self) -> Option<&Value> {
        self.deck_context.as_ref()
    }

    /// The deck reported its context (`null` for none).
    pub(super) fn deck_context_changed(&mut self, payload: &Value, cx: &mut Context<Self>) {
        let context = (!payload.is_null()).then(|| payload.clone());
        if context == self.deck_context {
            return;
        }
        self.deck_context = context;
        cx.emit(StructuredEvent::SurfaceContext);
    }

    /// Whether the writer may edit the deck (or the Markdown file in the
    /// visual editor): not, for one a read-only Overleaf role keeps as it is.
    pub fn set_editable(&mut self, editable: bool, cx: &mut Context<Self>) {
        if std::mem::replace(&mut self.editable, editable) == editable {
            return;
        }
        if matches!(
            self.kind,
            super::StructuredKind::Deck | super::StructuredKind::Markdown
        ) {
            self.post(
                "doc:editable",
                serde_json::json!({ "editable": editable }),
                cx,
            );
        }
    }

    /// The deck holds an edit its page has not committed yet.
    pub fn deck_pending_edits(&self) -> bool {
        self.deck_context
            .as_ref()
            .and_then(|context| context.get("pendingEdits"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// `open_project_window { path }`: bring the window showing `path`
    /// forward, or open the project in a new one.
    pub(super) fn open_project_window(&self, id: u64, args: &Value, cx: &mut App) {
        let Some(path) = args.get("path").and_then(Value::as_str).map(PathBuf::from) else {
            self.respond(id, Err("No project to switch to".into()), cx);
            return;
        };
        match crate::shell::windows::window_showing(&path, cx) {
            Some(handle) => {
                handle
                    .update(cx, |_, window, _| window.activate_window())
                    .ok();
            }
            None => crate::shell::windows::new_window(Some(path), None, cx),
        }
        self.respond(id, Ok(Value::Null), cx);
    }
}
