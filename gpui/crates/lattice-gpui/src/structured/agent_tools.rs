//! The Agent's tool calls on a structured document: a board's canvas tools,
//! a spreadsheet's range tools, a deck's page preview, and the wait for a
//! document the Agent created to be ready for them.
//!
//! The Tauri app runs each call against the open editor's registration in
//! its one window (`use-synara-host.ts`'s tool routes). Here the editor is
//! this document's page, so the Agent's owner hands the call to the
//! document, which sends it to the page (`agent:tool`), where the Tauri app's
//! own executor runs (`gpui/islands/shared/agent-tools.ts`); the page's
//! result envelope comes back (`agent:tool-result`) and goes to the Agent as
//! it is.
//!
//! A call the page cannot finish, because it was torn down (hibernated,
//! reloaded) or its tab closed, is answered with an error rather than run
//! again elsewhere: it may already have changed the document.
//!
//! A board has no page: the native whiteboard answers its canvas calls at
//! once (`lattice_board::board::agent_canvas`), in the envelope the Tauri
//! executor (`src/agent/agent-canvas-tools.ts`) answers with.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use futures::channel::oneshot;
use gpui::Context;
use lattice_board::board::BoardView;
use lattice_board::board::agent_canvas::ToolError;
use serde_json::{Value, json};

use super::{StructuredDocument, StructuredKind};

/// What a call is answered with: the page's result, or why there is none.
pub type AgentCallResult = Result<Value, String>;

/// The calls a document's page has not answered yet.
#[derive(Default)]
pub struct AgentCalls {
    next: u64,
    pending: HashMap<u64, oneshot::Sender<AgentCallResult>>,
}

impl AgentCalls {
    fn start(&mut self) -> (u64, oneshot::Receiver<AgentCallResult>) {
        self.next += 1;
        let (sender, receiver) = oneshot::channel();
        self.pending.insert(self.next, sender);
        (self.next, receiver)
    }

    /// The page answered call `id` (an unknown or repeated id is dropped).
    fn finish(&mut self, payload: &Value) {
        let Some(sender) = payload
            .get("id")
            .and_then(Value::as_u64)
            .and_then(|id| self.pending.remove(&id))
        else {
            return;
        };
        let answer = match (payload.get("result"), payload.get("error")) {
            (Some(result), _) if !result.is_null() => Ok(result.clone()),
            (_, Some(Value::String(error))) => Err(error.clone()),
            _ => Err("The document's page gave no answer.".into()),
        };
        sender.send(answer).ok();
    }

    /// The page went away: every call it held fails.
    fn abandon(&mut self) {
        for (_, sender) in self.pending.drain() {
            sender
                .send(Err(
                    "The document closed before the Agent's call finished.".into()
                ))
                .ok();
        }
    }
}

impl StructuredDocument {
    pub fn kind(&self) -> StructuredKind {
        self.kind
    }

    /// The document's project-relative path.
    pub fn relative(&self) -> &str {
        &self.relative
    }

    /// Its panel is the one its group displays.
    pub fn is_shown(&self) -> bool {
        self.shown
    }

    /// Run the Agent's tool `request` (Synara's envelope) on the page; the
    /// answer is the Tauri executor's result envelope.
    pub fn agent_tool(
        &mut self,
        request: Value,
        cx: &mut Context<Self>,
    ) -> oneshot::Receiver<AgentCallResult> {
        if let Some(board) = &self.board {
            let (sender, answer) = oneshot::channel();
            let view = board.view.clone();
            sender
                .send(view.update(cx, |view, cx| canvas_tool(view, &request, cx)))
                .ok();
            return answer;
        }
        let (id, answer) = self.agent_calls.start();
        let path = self.relative.clone();
        self.post(
            "agent:tool",
            json!({ "id": id, "path": path, "request": request }),
            cx,
        );
        answer
    }

    /// Wait, at most `timeout_ms`, for the page's editor to register with
    /// the Agent's tools (a document the Agent just created, opened).
    pub fn agent_registered(
        &mut self,
        timeout_ms: u64,
        cx: &mut Context<Self>,
    ) -> oneshot::Receiver<AgentCallResult> {
        if self.board.is_some() {
            let (sender, answer) = oneshot::channel();
            sender.send(Ok(json!({ "ready": true }))).ok();
            return answer;
        }
        let (id, answer) = self.agent_calls.start();
        let path = self.relative.clone();
        self.post(
            "agent:await-document",
            json!({ "id": id, "path": path, "timeoutMs": timeout_ms }),
            cx,
        );
        answer
    }

    pub(super) fn agent_answered(&mut self, payload: &Value) {
        self.agent_calls.finish(payload);
    }

    pub(super) fn agent_page_gone(&mut self) {
        self.agent_calls.abandon();
    }
}

/// Synara's canvas request run on the native board: the Tauri executor's
/// result envelope, or why the request is no canvas request.
fn canvas_tool(
    view: &mut BoardView,
    request: &Value,
    cx: &mut Context<BoardView>,
) -> AgentCallResult {
    let parsed = request.as_object().and_then(|r| {
        let is = |key: &str, value: Value| r.get(key) == Some(&value);
        if !is("type", json!("synara:canvas-tool-request"))
            || r.get("version")?.as_f64() != Some(1.)
        {
            return None;
        }
        let id = r
            .get("id")?
            .as_str()
            .filter(|id| (1..=128).contains(&id.encode_utf16().count()))?;
        let expires_at = r.get("expiresAt")?.as_f64()?;
        let action = r
            .get("action")?
            .as_str()
            .filter(|a| matches!(*a, "list" | "create" | "update" | "delete"))?;
        Some((id, expires_at, action, r.get("args")?.as_object()?))
    });
    let Some((id, expires_at, action, args)) = parsed else {
        return Err("not a canvas tool request".into());
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0., |elapsed| elapsed.as_millis() as f64);
    let outcome = if expires_at <= now {
        Err(ToolError {
            code: "canvas_tool_expired",
            message: "The canvas request expired before execution.".into(),
        })
    } else {
        view.agent_canvas(action, args, cx)
    };
    let mut envelope = json!({ "type": "lattice:canvas-tool-result", "version": 1, "id": id });
    match outcome {
        Ok(result) => {
            envelope["ok"] = json!(true);
            envelope["result"] = result;
        }
        Err(error) => {
            envelope["ok"] = json!(false);
            envelope["error"] = json!({ "code": error.code, "message": error.message });
        }
    }
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(receiver: &mut oneshot::Receiver<AgentCallResult>) -> Option<AgentCallResult> {
        receiver.try_recv().ok().flatten()
    }

    #[test]
    fn each_call_gets_its_own_answer() {
        let mut calls = AgentCalls::default();
        let (first, mut first_answer) = calls.start();
        let (second, mut second_answer) = calls.start();
        assert_ne!(first, second);
        calls.finish(&json!({ "id": second, "result": { "ok": true } }));
        assert_eq!(answer(&mut first_answer), None);
        assert_eq!(answer(&mut second_answer), Some(Ok(json!({ "ok": true }))));
        calls.finish(&json!({ "id": first, "error": "not a canvas tool request" }));
        assert_eq!(
            answer(&mut first_answer),
            Some(Err("not a canvas tool request".into()))
        );
    }

    #[test]
    fn a_repeated_answer_changes_nothing() {
        let mut calls = AgentCalls::default();
        let (id, mut receiver) = calls.start();
        calls.finish(&json!({ "id": id, "result": 1 }));
        calls.finish(&json!({ "id": id, "result": 2 }));
        assert_eq!(answer(&mut receiver), Some(Ok(json!(1))));
    }

    #[test]
    fn a_page_torn_down_fails_what_it_held_rather_than_dropping_it() {
        let mut calls = AgentCalls::default();
        let (_, mut receiver) = calls.start();
        calls.abandon();
        assert!(matches!(answer(&mut receiver), Some(Err(_))));
        // Answers for the gone page find nothing to finish.
        calls.finish(&json!({ "id": 1, "result": {} }));
    }
}
