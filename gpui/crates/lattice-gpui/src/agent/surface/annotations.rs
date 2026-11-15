//! The Agent's page on the project's annotations, through the window's own
//! store (`crate::annotations::store`), the one writer of
//! `.research/annotations.json` in the app, and its revision rounds
//! (`crate::annotations::rounds`). The Tauri app's Agent works on its
//! window's comments store (`use-editor-comments.ts`) and rounds
//! (`annotation-rounds.ts`); here those are the native ones, and the page
//! only reads:
//!
//! - `list_annotations` answers with what the store holds, once it has read
//!   the file;
//! - every change the store makes, whoever made it, reaches the page
//!   (`agent:annotations`), so the Agent sees the notes as they are;
//! - `record_annotation_tool` hands an annotation tool's call from the
//!   conversation (`propose`, `ask`), which the page has checked, to the
//!   window, which records it into the open round
//!   ([`SurfaceEvent::AnnotationTool`]).

use std::time::Duration;

use gpui::{Context, Subscription};
use lattice_i18n::t;
use serde_json::{Value, json};

use super::{SurfaceEvent, SynaraSurface};
use crate::annotations::{
    rounds::ToolAnswer,
    store::{self, Notes},
};

/// How long `list_annotations` waits for the store's first read.
const READ_WAIT: Duration = Duration::from_secs(15);

/// What the page was last told of the annotations, and the store it follows.
#[derive(Default)]
pub(super) struct PageAnnotations {
    told: Value,
    _store: Option<Subscription>,
}

fn notes_value(notes: &Notes) -> Value {
    json!({ "annotations": notes.annotations, "rounds": notes.rounds })
}

/// An annotation tool's call as the page hands it over: the annotation's
/// id and what to record about it.
fn tool_call(args: &Value) -> Result<(String, ToolAnswer), String> {
    let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);
    let id = text("annotationId")
        .filter(|id| !id.is_empty())
        .ok_or("The annotation tool named no annotation.")?;
    let answer = match text("action").as_deref() {
        Some("propose") => ToolAnswer::Proposal {
            text: text("text").ok_or("The proposal has no text.")?,
            reason: text("reason").unwrap_or_default(),
        },
        Some("ask") => ToolAnswer::Question(
            text("question")
                .filter(|question| !question.trim().is_empty())
                .ok_or("The question is empty.")?,
        ),
        _ => return Err("Unknown annotation tool.".into()),
    };
    Ok((id, answer))
}

impl SynaraSurface {
    /// Follow the store for the project now open, and tell the page what it
    /// holds (`set_project`).
    pub(super) fn follow_annotations(&mut self, cx: &mut Context<Self>) {
        self.annotations = PageAnnotations::default();
        let Some(root) = self.root.clone() else {
            return;
        };
        let store = store::store(cx);
        store.update(cx, |store, cx| store.ensure(&root, cx));
        self.annotations._store = Some(cx.observe(&store, |this, _, cx| this.tell_annotations(cx)));
        self.tell_annotations(cx);
    }

    /// Tell the page the store's annotations, when they changed since.
    fn tell_annotations(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let Some(store) = store::try_store(cx) else {
            return;
        };
        let store = store.read(cx);
        let Some(notes) = store.notes(&root).filter(|_| store.loaded(&root)) else {
            return;
        };
        let value = notes_value(notes);
        if value != self.annotations.told {
            self.annotations.told = value.clone();
            self.post("agent:annotations", value, cx);
        }
    }

    /// `list_annotations`: what the store holds, once it has read the file.
    pub(super) fn list_annotations(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            self.respond(id, Err("No project is open.".into()), cx);
            return;
        };
        let store = store::store(cx);
        store.update(cx, |store, cx| store.ensure(&root, cx));
        cx.spawn(async move |this, cx| {
            let started = std::time::Instant::now();
            let answer = loop {
                let state = store.read_with(cx, |store, _| {
                    if store.loaded(&root) {
                        Some(Ok(store.notes(&root).map(notes_value).unwrap_or_default()))
                    } else {
                        store.read_failure(&root).map(|error| Err(error.to_string()))
                    }
                });
                match state {
                    Some(answer) => break answer,
                    None if started.elapsed() < READ_WAIT => {
                        cx.background_executor().timer(Duration::from_millis(50)).await;
                    }
                    None => {
                        break Err(t!(
                            "This project's annotations are still being read. Try again in a moment."
                        )
                        .to_string());
                    }
                }
            };
            this.update(cx, |this, cx| this.respond(id, answer, cx)).ok();
        })
        .detach();
    }

    /// `record_annotation_tool`: an annotation tool's call from the
    /// conversation, for the window's rounds to record; the window answers.
    pub(super) fn record_annotation_tool(&mut self, id: u64, args: &Value, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            self.respond(id, Err("No project is open.".into()), cx);
            return;
        };
        let asked = args.get("projectRoot").and_then(Value::as_str);
        if asked.is_none_or(|asked| {
            !super::super::commands::same_root(std::path::Path::new(asked), &root)
        }) {
            self.respond(
                id,
                Err("The project changed before the annotation tool ran.".into()),
                cx,
            );
            return;
        }
        match tool_call(args) {
            Ok((annotation, answer)) => cx.emit(SurfaceEvent::AnnotationTool {
                id,
                annotation,
                answer,
            }),
            Err(error) => self.respond(id, Err(error), cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The page's wire format (`library.ts`'s tool host).
    #[test]
    fn a_tool_call_reads_as_the_page_sends_it() {
        let proposal = json!({
            "annotationId": "a1", "action": "propose", "text": "the revised passage", "reason": "clearer",
        });
        assert_eq!(
            tool_call(&proposal),
            Ok((
                "a1".into(),
                ToolAnswer::Proposal {
                    text: "the revised passage".into(),
                    reason: "clearer".into(),
                }
            ))
        );
        let question =
            json!({ "annotationId": "a1", "action": "ask", "question": "Which result?" });
        assert_eq!(
            tool_call(&question),
            Ok(("a1".into(), ToolAnswer::Question("Which result?".into())))
        );
        assert!(
            tool_call(&json!({ "annotationId": "a1", "action": "ask", "question": " " })).is_err()
        );
        assert!(tool_call(&json!({ "action": "propose", "text": "x" })).is_err());
        assert!(tool_call(&json!({ "annotationId": "a1", "action": "delete" })).is_err());
    }
}
