//! The Agent's annotation tools from the conversation (`propose`, `ask`),
//! recorded into the open round as the Tauri app's rounds record them
//! (`toolHost` in `src/app/annotation-rounds.ts`): the annotation joins the
//! open round, or a new one; a proposal keeps its file's text from before
//! the round's first answer and waits for the writer's review like any
//! other; a question waits for the writer's answer in the panel.
//!
//! The Agent's page checks the call first (`executeAgentAnnotationsToolRequest`:
//! the annotation exists and is open, the edits apply to its passage) and
//! hands over what to record (`agent/surface/annotations.rs`).

use gpui::Context;
use lattice_core::project::AnnotationRevision;
use lattice_i18n::t;

use super::AnnotationRounds;

/// What the Agent's tool records about an annotation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolAnswer {
    /// The passage as the Agent would have it, and why.
    Proposal { text: String, reason: String },
    /// What the Agent asks the writer first.
    Question(String),
}

impl AnnotationRounds {
    /// Record the Agent tool's `answer` about annotation `id` into the open
    /// round, or a new one; why it could not, when it could not.
    pub fn record_tool(
        &mut self,
        id: &str,
        answer: ToolAnswer,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let root = self.root(cx).ok_or("No project is open.")?;
        if !super::store::store(cx).read(cx).loaded(&root) {
            return Err(t!(
                "This project's annotations are still being read. Try again in a moment."
            )
            .to_string());
        }
        // The page checked both; the store may have moved on since.
        let comment =
            Self::find(&root, id, cx).ok_or("The annotation is no longer in this project.")?;
        if comment.resolved {
            return Err("The annotation is already resolved.".into());
        }
        let round = Self::join_round(&root, &[id.to_string()], cx);
        let revision = match answer {
            ToolAnswer::Proposal { text, reason } => {
                self.keep_baseline(&root, round, std::slice::from_ref(&comment.path), cx);
                AnnotationRevision {
                    round,
                    state: "proposed".into(),
                    original: Some(comment.quote.clone()),
                    text: Some(text),
                    reason: Some(reason).filter(|reason| !reason.trim().is_empty()),
                    question: None,
                    answer: None,
                    error: None,
                }
            }
            ToolAnswer::Question(question) => AnnotationRevision {
                round,
                state: "asked".into(),
                original: None,
                text: None,
                reason: None,
                question: Some(question),
                answer: None,
                error: None,
            },
        };
        let asked = revision.state == "asked";
        self.record(&root, id, revision, |_| {}, cx);
        // As the Tauri rounds do after a question: a round with nothing left
        // running or waiting on a proposal settles.
        if asked {
            self.settle(cx);
        }
        cx.notify();
        Ok(())
    }
}
