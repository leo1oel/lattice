//! The e2e checks of the revision rounds (`annotations/rounds.rs`), the
//! panel's side of them and the proposal's review card
//! (`editor_panel/annotation_review.rs`). The scenario stands in for the
//! agent (a scratch run has no Synara service): everything from its reply
//! on is the app's own.
//!
//! - a note saved with Save and revise now asks the agent about it alone,
//!   and its answer is kept as the note's proposal in round 1, which the
//!   panel offers to review;
//! - reviewing it puts the card under the passage, and ⌘↵ there writes the
//!   proposal, resolves the note and settles the round as a version; ⌘Z
//!   takes the edit back;
//! - the agent's question waits on the note; the writer's answer, sent
//!   from the note's field, asks again and clears the field; ⌘↵ on the
//!   card with every edit kept writes and decides nothing, and ⌫ rejects
//!   the proposal, the text untouched.
//!
//! The notes and the round are taken out again, and the chapter put back.

use std::{path::Path, time::Duration};

use anyhow::Result;
use editor::SelectionEffects;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::Steps;
use crate::{
    annotations::{rounds::AnnotationRounds, store},
    editor_panel::EditorPanel,
    scenario::Run,
};

const PASSAGE: &str = "A second line of the introduction.";
const REVISED: &str = "A second, clearer line of the introduction.";
const REVISION: &str =
    "<revision>A second, clearer line of the introduction.</revision>\n<reason>Clearer.</reason>";
const QUESTION: &str = "<question>Which line should it point to?</question>";

impl Run {
    pub(super) async fn annotation_rounds(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let original = std::fs::read_to_string(&chapter)?;
        let editor = self.open(cx, &chapter, Some(1))?;
        let rounds = self.with_window(cx, |shell, _, cx| shell.read(cx).annotation_rounds())?;
        let loaded = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                store::try_store(cx).is_some_and(|store| store.read(cx).loaded(root))
            })
            .await;

        // Save and revise now: the note, then its proposal in round 1.
        self.script_rounds(cx, &rounds, REVISION)?;
        let first = self.note_and_revise(cx, &editor, root).await?;
        let proposed = self.wait_state(cx, root, &first, "proposed").await;
        let offered = cx.update(|cx| rounds.read(cx).neighbour(None, 1, cx)) == Some(first.clone());
        steps.check(
            "Save and revise now asks the agent about the note alone; its proposal waits in round 1 for review",
            loaded && proposed && offered,
            json!({ "loaded": loaded, "proposed": proposed, "offered": offered }),
        );

        // Review: the card under the passage; ⌘↵ writes it and settles the
        // round; ⌘Z takes it back.
        self.with_window(cx, |_, _, cx| rounds.update(cx, |rounds, cx| rounds.open_review(&first, cx)))?;
        let shown = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                editor.read(cx).reviewing_annotation() == Some(first.as_str())
            })
            .await;
        self.adapter_shot(cx, "annotation-review").await;
        let accepted = {
            let _front = self.focused(cx, "review card").await?;
            self.press(cx, '\n', true).await?;
            self.wait_for(cx, Duration::from_secs(3), |_, cx| {
                editor.read(cx).text(cx).contains(REVISED) && editor.read(cx).reviewing_annotation().is_none()
            })
            .await
        };
        let resolved = self.wait_state(cx, root, &first, "accepted").await;
        let settled = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                store::try_store(cx)
                    .and_then(|store| store.read(cx).notes(root).cloned())
                    .is_some_and(|notes| {
                        notes.rounds.iter().any(|round| round.number == 1 && round.settled_at.is_some())
                    })
            })
            .await;
        let undone = {
            let _front = self.focused(cx, "editor").await?;
            self.press(cx, 'z', true).await?;
            self.wait_for(cx, Duration::from_secs(2), |_, cx| editor.read(cx).text(cx) == original)
                .await
        };
        steps.check(
            "the proposal's card opens under its passage; ⌘↵ writes it, resolves the note and saves the round as a version; ⌘Z takes it back",
            shown && accepted && resolved && settled && undone,
            json!({ "shown": shown, "accepted": accepted, "resolved": resolved, "settled": settled, "undone": undone }),
        );

        // A question, the writer's answer, then ⌫ rejects the proposal.
        self.script_rounds(cx, &rounds, QUESTION)?;
        let second = self.note_and_revise(cx, &editor, root).await?;
        let asked = self.wait_state(cx, root, &second, "asked").await;
        self.adapter_shot(cx, "annotation-question").await;
        self.script_rounds(cx, &rounds, REVISION)?;
        // The answer goes in through the note's field in the panel, which
        // leaves with the question once sent.
        let panel = self.with_window(cx, |shell, _, cx| shell.read(cx).annotations_panel())?;
        let field = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| panel.read(cx).answer_draft(&second, cx).is_some())
            .await;
        let sent = self.with_window(cx, |_, window, cx| {
            panel.update(cx, |panel, cx| panel.scripted_answer(&second, "The first line", window, cx))
        })?;
        let answered = self.wait_state(cx, root, &second, "proposed").await;
        let cleared = cx.update(|cx| panel.read(cx).answer_draft(&second, cx).is_none());
        self.with_window(cx, |_, _, cx| rounds.update(cx, |rounds, cx| rounds.open_review(&second, cx)))?;
        let reviewing = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                editor.read(cx).reviewing_annotation() == Some(second.as_str())
            })
            .await;
        // ⌘↵ with every edit kept writes nothing and decides nothing.
        self.with_window(cx, |_, _, cx| editor.update(cx, |editor, cx| editor.scripted_review_keep_all(cx)))?;
        {
            let _front = self.focused(cx, "review card").await?;
            self.press(cx, '\n', true).await?;
        }
        self.pause(cx, Duration::from_millis(400)).await;
        let held = self.editor_text(cx, &editor) == original
            && cx.update(|cx| editor.read(cx).reviewing_annotation() == Some(second.as_str()))
            && self.wait_state(cx, root, &second, "proposed").await;
        {
            let _front = self.focused(cx, "review card").await?;
            self.press(cx, '\u{8}', false).await?;
        }
        let rejected = self.wait_state(cx, root, &second, "rejected").await;
        let untouched = self.editor_text(cx, &editor) == original;
        steps.check(
            "the agent's question waits on the note; the answer from its field asks again and clears it; ⌘↵ with every edit kept does nothing, and ⌫ rejects the proposal",
            asked && field && sent && answered && cleared && reviewing && held && rejected && untouched,
            json!({ "asked": asked, "field": field, "sent": sent, "answered": answered, "cleared": cleared, "reviewing": reviewing, "held": held, "rejected": rejected, "untouched": untouched }),
        );

        // Put the project back as it was.
        self.with_window(cx, |_, window, cx| {
            rounds.update(cx, |rounds, cx| {
                rounds.script_reply(None);
                rounds.close_review(cx);
            });
            let store = store::store(cx);
            store.update(cx, |store, cx| {
                store.commit(
                    root,
                    |notes| {
                        notes.annotations.retain(|note| note.id != first && note.id != second);
                        notes.rounds.clear();
                        true
                    },
                    cx,
                );
            });
            editor.update(cx, |editor, cx| {
                let length = editor.text(cx).len();
                editor.replace_range(0, length, &original, 0, window, cx)
            })
        })?;
        Ok(())
    }

    fn script_rounds(&self, cx: &mut AsyncApp, rounds: &Entity<AnnotationRounds>, reply: &str) -> Result<()> {
        let reply = reply.to_string();
        self.with_window(cx, |_, _, cx| rounds.update(cx, |rounds, _| rounds.script_reply(Some(reply))))
    }

    /// Annotate the passage with a note and save it with Save and revise
    /// now; the new note's id.
    async fn note_and_revise(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<EditorPanel>,
        root: &Path,
    ) -> Result<String> {
        let text = self.editor_text(cx, editor);
        let start = text.find(PASSAGE).unwrap_or(0);
        let zed = cx.update(|cx| editor.read(cx).editor().clone());
        self.with_window(cx, |_, window, cx| {
            window.focus(&gpui::Focusable::focus_handle(zed.read(cx), cx), cx);
            zed.update(cx, |zed, cx| {
                zed.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([editor::MultiBufferOffset(start)
                        ..editor::MultiBufferOffset(start + PASSAGE.len())])
                })
            })
        })?;
        let before: Vec<String> = cx.update(|cx| Self::note_ids(root, cx));
        self.dispatch_to_shell(cx, &crate::shell::AnnotateSelection)?;
        self.wait_for(cx, Duration::from_secs(5), |_, cx| editor.read(cx).composing_annotation())
            .await;
        {
            let _front = self.focused(cx, "annotation composer").await?;
            self.pause(cx, Duration::from_millis(300)).await;
            self.type_text(cx, "Make it clearer").await?;
        }
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| editor.scripted_save_and_revise(window, cx))
        })?;
        self.wait_for(cx, Duration::from_secs(5), |_, cx| Self::note_ids(root, cx).len() > before.len())
            .await;
        Ok(cx
            .update(|cx| Self::note_ids(root, cx))
            .into_iter()
            .find(|id| !before.contains(id))
            .unwrap_or_default())
    }

    fn note_ids(root: &Path, cx: &gpui::App) -> Vec<String> {
        store::try_store(cx).map_or_else(Vec::new, |store| {
            store.read(cx).annotations(root).into_iter().map(|note| note.id.clone()).collect()
        })
    }

    /// Wait for note `id`'s revision to read `state`.
    async fn wait_state(&self, cx: &mut AsyncApp, root: &Path, id: &str, state: &'static str) -> bool {
        let id = id.to_string();
        let root = root.to_path_buf();
        self.wait_for(cx, Duration::from_secs(5), move |_, cx| {
            store::try_store(cx)
                .and_then(|store| store.read(cx).get(&root, &id).cloned())
                .and_then(|note| note.revision)
                .is_some_and(|revision| revision.state == state)
        })
        .await
    }
}

/// This file's registration as the e2e module `annotation_rounds`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 43,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/annotations/rounds.rs",
        "gpui/crates/lattice-gpui/src/annotations/panel/rounds_view.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/annotation_review.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/annotation_review/card.rs",
        "gpui/crates/lattice-gpui/src/shell/rounds_flow.rs",
        "gpui/crates/lattice-editor/src/annotation_revision.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.annotation_rounds(cx, steps, &fixture.root)),
};
