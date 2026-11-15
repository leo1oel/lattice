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
        // Round 1 is open, not settled: the panel offers no Revision rounds yet.
        let panel = self.with_window(cx, |shell, _, cx| shell.read(cx).annotations_panel())?;
        let unsettled_button = cx.update(|cx| panel.read(cx).offers_rounds(cx));

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

        // Settled now: the panel offers Revision rounds.
        let settled_button = cx.update(|cx| panel.read(cx).offers_rounds(cx));
        steps.check(
            "the Annotations panel offers Revision rounds only once a round has settled",
            !unsettled_button && settled_button,
            json!({ "while_open": unsettled_button, "once_settled": settled_button }),
        );

        // The round, compared and opened in History from the rounds sheet.
        self.rounds_sheet(cx, steps, &rounds, &first, root).await?;
        self.rounds_restore(cx, steps, &rounds, &editor, &chapter, &original, root).await?;

        // A question, the writer's answer, then ⌫ rejects the proposal.
        self.script_rounds(cx, &rounds, QUESTION)?;
        let second = self.note_and_revise(cx, &editor, root).await?;
        let asked = self.wait_state(cx, root, &second, "asked").await;
        self.adapter_shot(cx, "annotation-question").await;
        self.script_rounds(cx, &rounds, REVISION)?;
        // The answer goes in through the note's field in the panel, which
        // leaves with the question once sent.
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

    /// Revision rounds: the sheet compares round 1 with the text before it,
    /// the revised paragraph tagged with the note's number, and its Open in
    /// History shows the round's entry, opened.
    async fn rounds_sheet(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        rounds: &Entity<AnnotationRounds>,
        note: &str,
        root: &Path,
    ) -> Result<()> {
        let number = cx.update(|cx| {
            store::try_store(cx)
                .and_then(|store| store.read(cx).get(root, note).map(|note| note.number))
                .unwrap_or_default()
        });
        // The round saved notice's Compare opens the sheet.
        let stack = cx.update(crate::notices::install);
        let notice_titles: Vec<String> =
            cx.update(|cx| stack.read(cx).titles()).into_iter().map(|title| title.to_string()).collect();
        let via_notice = self.with_window(cx, |_, window, cx| {
            stack.update(cx, |stack, cx| stack.answer("Annotations", "Compare", window, cx))
        })?;
        if !via_notice {
            self.with_window(cx, |_, _, cx| rounds.update(cx, |_, cx| cx.emit(crate::annotations::rounds::RoundsEvent::OpenRounds)))?;
        }
        let from_notice = via_notice
            && self
                .wait_for(cx, Duration::from_secs(3), |shell, cx| shell.read(cx).rounds_sheet_entity().is_some())
                .await;
        steps.check(
            "the Round 1 saved notice's Compare opens the Revision rounds sheet",
            from_notice,
            json!({ "answered": via_notice, "opened": from_notice, "notices": notice_titles }),
        );
        let mut shown = None;
        let compared = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shown = shell
                    .read(cx)
                    .rounds_sheet_entity()
                    .and_then(|sheet| sheet.read(cx).shown_changes());
                shown.as_ref().is_some_and(|changes| {
                    changes
                        .iter()
                        .any(|(newer, numbers)| newer.contains(REVISED) && numbers.contains(&number))
                })
            })
            .await;
        self.shots(cx, "revision-rounds").await;
        let sheet = cx.update(|cx| self.shell.read(cx).rounds_sheet_entity());
        if let Some(sheet) = &sheet {
            self.with_window(cx, |_, _, cx| sheet.update(cx, |sheet, cx| sheet.open_in_history(cx)))?;
        }
        let history_id = cx.update(|cx| {
            store::try_store(cx)
                .and_then(|store| store.read(cx).notes(root).cloned())
                .and_then(|notes| notes.rounds.iter().find(|round| round.number == 1).and_then(|round| round.history_id.clone()))
        });
        let opened = match &history_id {
            Some(id) => {
                let key = crate::history::activity_key(id);
                self.wait_for(cx, Duration::from_secs(10), move |shell, cx| {
                    let shell = shell.read(cx);
                    shell.rounds_sheet_entity().is_none()
                        && shell.history.read(cx).expanded_row() == Some(key.as_str())
                })
                .await
            }
            None => false,
        };
        // History opened as a tab over the editor: close it, for the steps
        // after annotate the editor's passage again.
        self.with_window(cx, |shell, _, cx| shell.update(cx, |shell, cx| shell.engine_do(cx, |engine| engine.close("history"))))?;
        steps.check(
            "the Revision rounds sheet compares round 1 with the text before it, the revised paragraph tagged with its note; Open in History shows the round's entry, opened",
            compared && opened,
            json!({ "compared": compared, "shown": shown, "history_id": history_id, "opened": opened }),
        );
        Ok(())
    }

    /// Revision rounds' restore: Round 1 (the file reads as before the
    /// rounds after ⌘Z) asks first, without Overleaf in a project not
    /// linked, then writes the round's text and reloads the open editor;
    /// restoring it again says the files already read so and writes
    /// nothing; Before revisions puts the text back. A sheet over a linked
    /// project asks with the Overleaf wording.
    #[allow(clippy::too_many_arguments)]
    async fn rounds_restore(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        rounds: &Entity<AnnotationRounds>,
        editor: &Entity<EditorPanel>,
        chapter: &Path,
        original: &str,
        root: &Path,
    ) -> Result<()> {
        use crate::annotations::rounds_sheet::{RoundsSheet, compare::Version};
        let open = |this: &Self, cx: &mut AsyncApp| {
            this.with_window(cx, |_, _, cx| {
                rounds.update(cx, |_, cx| cx.emit(crate::annotations::rounds::RoundsEvent::OpenRounds))
            })
        };
        let sheet = |this: &Self, cx: &mut AsyncApp| cx.update(|cx| this.shell.read(cx).rounds_sheet_entity());
        let question = |cx: &mut AsyncApp| {
            cx.update(|cx| crate::confirm::install(cx).read(cx).question().map(|question| question.to_string()))
        };
        let accept = |this: &Self, cx: &mut AsyncApp| {
            this.with_window(cx, |_, window, cx| {
                crate::confirm::install(cx).update(cx, |host, cx| host.accept(window, cx))
            })
        };

        // Restore Round 1.
        open(self, cx)?;
        let loaded = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell
                    .read(cx)
                    .rounds_sheet_entity()
                    .is_some_and(|sheet| sheet.read(cx).shown_changes().is_some())
            })
            .await;
        if let Some(sheet) = sheet(self, cx) {
            self.with_window(cx, |_, _, cx| sheet.update(cx, |sheet, cx| sheet.ask_to_restore(cx)))?;
        }
        self.pause(cx, Duration::from_millis(300)).await;
        let asked = question(cx);
        self.adapter_shot(cx, "revision-rounds-restore-confirm").await;
        let accepted = accept(self, cx)?;
        let written = self
            .wait_for(cx, Duration::from_secs(10), |_, _| {
                std::fs::read_to_string(chapter).is_ok_and(|text| text.contains(REVISED))
            })
            .await;
        let reloaded = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                editor.read(cx).text(cx).contains(REVISED) && shell.read(cx).rounds_sheet_entity().is_none()
            })
            .await;
        self.adapter_shot(cx, "revision-rounds-restored").await;
        steps.check(
            "Restore Round 1 asks first (no Overleaf wording when not linked), then writes the round's text, closes the sheet and reloads the open editor",
            loaded
                && asked.as_deref() == Some("Restore the files the rounds touched to Round 1?")
                && accepted
                && written
                && reloaded,
            json!({ "loaded": loaded, "asked": asked, "accepted": accepted, "written": written, "reloaded": reloaded }),
        );

        // Restoring Round 1 again: nothing to write.
        open(self, cx)?;
        let loaded = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell
                    .read(cx)
                    .rounds_sheet_entity()
                    .is_some_and(|sheet| sheet.read(cx).shown_changes().is_some())
            })
            .await;
        let before_again = std::fs::read_to_string(chapter).ok();
        let current = sheet(self, cx);
        if let Some(sheet) = &current {
            self.with_window(cx, |_, _, cx| sheet.update(cx, |sheet, cx| sheet.ask_to_restore(cx)))?;
        }
        self.pause(cx, Duration::from_millis(300)).await;
        let accepted = accept(self, cx)?;
        self.pause(cx, Duration::from_millis(500)).await;
        let error = current
            .as_ref()
            .and_then(|sheet| cx.update(|cx| sheet.read(cx).shown_error().map(|error| error.to_string())));
        let still_open = sheet(self, cx).is_some();
        let unchanged = std::fs::read_to_string(chapter).ok() == before_again;
        self.adapter_shot(cx, "revision-rounds-already-restored").await;
        steps.check(
            "restoring Round 1 again says the files already read as Round 1, keeps the sheet and writes nothing",
            loaded
                && accepted
                && error.as_deref() == Some("The files already read as Round 1.")
                && still_open
                && unchanged,
            json!({ "loaded": loaded, "accepted": accepted, "error": error, "still_open": still_open, "unchanged": unchanged }),
        );

        // Before revisions puts the text back.
        if let Some(sheet) = &current {
            self.with_window(cx, |_, _, cx| {
                sheet.update(cx, |sheet, cx| {
                    sheet.select(Version::Before, cx);
                    sheet.ask_to_restore(cx)
                })
            })?;
        }
        self.pause(cx, Duration::from_millis(300)).await;
        let asked = question(cx);
        let accepted = accept(self, cx)?;
        let back = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                std::fs::read_to_string(chapter).is_ok_and(|text| text == original)
                    && editor.read(cx).text(cx) == original
                    && shell.read(cx).rounds_sheet_entity().is_none()
            })
            .await;
        steps.check(
            "Restore Before revisions asks first, then puts the text before the rounds back on disk and in the editor",
            asked.as_deref() == Some("Restore the files the rounds touched to Before revisions?") && accepted && back,
            json!({ "asked": asked, "accepted": accepted, "back": back }),
        );

        // A project linked to Overleaf: the question says what syncing does.
        let notes = cx.update(|cx| store::try_store(cx).and_then(|store| store.read(cx).notes(root).cloned()));
        let linked_question = match notes {
            Some(notes) => {
                let root = root.to_path_buf();
                let linked = cx.update(|cx| {
                    gpui::AppContext::new(cx, |cx| RoundsSheet::new(root, &notes.rounds, notes.annotations.clone(), true, |_, _| None, cx))
                });
                cx.update(|cx| linked.update(cx, |sheet, cx| sheet.ask_to_restore(cx)));
                let asked = question(cx);
                self.with_window(cx, |_, _, cx| crate::confirm::install(cx).update(cx, |host, cx| host.dismiss(cx)))?;
                asked
            }
            None => None,
        };
        steps.check(
            "in a project linked to Overleaf, the restore question says syncing replaces the files on Overleaf too",
            linked_question.as_deref() == Some(
                "Restore the files the rounds touched to Round 1? Syncing then replaces them on Overleaf too, including co-authors' changes made there since; Overleaf's history keeps those.",
            ),
            json!({ "asked": linked_question }),
        );
        Ok(())
    }

    /// Save the window as `<name>-light.png` and `<name>-dark.png` into
    /// `LATTICE_E2E_SHOTS`, when set.
    async fn shots(&self, cx: &mut AsyncApp, name: &str) {
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return;
        }
        use lattice_ui::{Appearance, LatticeTheme};
        for (appearance, suffix) in [(Appearance::Dark, "dark"), (Appearance::Light, "light")] {
            cx.update(|cx| LatticeTheme::set_appearance(appearance, cx));
            self.adapter_shot(cx, &format!("{name}-{suffix}")).await;
        }
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
        "gpui/crates/lattice-gpui/src/shell/rounds_sheet_flow.rs",
        "gpui/crates/lattice-gpui/src/annotations/rounds_sheet",
        "gpui/crates/lattice-gpui/src/annotations/rounds_sheet.rs",
        "gpui/crates/lattice-gpui/src/history/focus_entry.rs",
        "gpui/crates/lattice-editor/src/annotation_revision.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.annotation_rounds(cx, steps, &fixture.root)),
};
