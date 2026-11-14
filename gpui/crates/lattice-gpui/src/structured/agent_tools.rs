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

use std::collections::HashMap;

use futures::channel::oneshot;
use gpui::Context;
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
