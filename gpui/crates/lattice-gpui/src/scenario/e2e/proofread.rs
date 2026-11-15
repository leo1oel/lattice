//! The e2e checks of the inline Proofread, Polish and Rewrite
//! (`editor_panel/proofread.rs` and its card, `lattice_editor::proofread`):
//!
//! - a sentence of the chapter selected and ⌘⌥P (the editor's key) opens
//!   the card under it, which reads the agent's reply as two edits with
//!   their reasons; the scenario stands in for the agent (a scratch run has
//!   no Synara service), and everything from the reply on is the app's own;
//! - the first edit kept as it was, ⌘↵ applies only the second, in one undo
//!   step of its own: ⌘Z puts the sentence back; the words it replaced
//!   stand struck where they were and fold their width away;
//! - the card's Polish asks again, and Esc discards it, the text untouched;
//! - with no stand-in the scratch run's agent cannot answer, and the card
//!   says it could not proofread, with Try again;
//! - the palette's Rewrite selection… opens the toolbar's Rewrite menu, and
//!   an instruction from it asks the agent with the writer's own words.
//!
//! The chapter is put back as it was.

use std::time::Duration;

use anyhow::Result;
use editor::SelectionEffects;
use gpui::{AsyncApp, Entity, Keystroke};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

const SENTENCE: &str = "This paragraph introduces the document.";
/// The agent's reply the scenario answers with: two changes, each with its
/// reason, as the prompt asks for them.
const REPLY: &str = "<proofread>This section introduces this document.</proofread>\n\
<reasons>\nparagraph => section | word choice | the unit is a section\n\
the document => this document | clarity |\n</reasons>";
const REVISED: &str = "This paragraph introduces this document.";

impl Run {
    pub(super) async fn proofread(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &std::path::Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let original = std::fs::read_to_string(&chapter)?;
        let editor = self.open(cx, &chapter, Some(1))?;
        self.with_window(cx, |_, _, cx| {
            editor.update(cx, |editor, _| editor.script_proofread_reply(Some(REPLY.into())))
        })?;

        // ⌘⌥P opens the card, which offers the reply's two edits.
        self.select_sentence(cx, &editor)?;
        self.keys(cx, "cmd-alt-p")?;
        let ready = self.card_reads(cx, &editor, "ready", 2, 2).await;
        self.adapter_shot(cx, "proofread-card").await;
        let card = cx.update(|cx| editor.read(cx).proofread_card(cx));
        steps.check(
            "⌘⌥P opens the proofread card under the selection, offering the agent's two edits",
            ready,
            json!({ "card": card }),
        );

        // Keep the first edit's original; ⌘↵ applies the other, alone, as
        // one undo step.
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| editor.scripted_proofread("keep-first", window, cx))
        })?;
        let kept = self.card_reads(cx, &editor, "ready", 2, 1).await;
        let accepted = {
            let _front = self.focused(cx, "proofread card").await?;
            self.press(cx, '\n', true).await?;
            self.wait_for(cx, Duration::from_secs(3), |_, cx| {
                editor.read(cx).proofread_card(cx).is_none()
                    && editor.read(cx).text(cx).contains(REVISED)
            })
            .await
        };
        // The replaced words fold from their end: the room they take
        // narrows a character at a time, then they are gone.
        let folds = self.ghost_widths(cx, &editor).await;
        let folded = folds.len() >= 2 && folds.windows(2).all(|pair| pair[1] < pair[0]);
        self.adapter_shot(cx, "proofread-accepted").await;
        let undone = {
            let _front = self.focused(cx, "editor").await?;
            self.press(cx, 'z', true).await?;
            self.wait_for(cx, Duration::from_secs(2), |_, cx| editor.read(cx).text(cx) == original)
                .await
        };
        steps.check(
            "kept edits stay as they were; ⌘↵ applies the rest in one undo step that ⌘Z takes back, its replaced words folding away",
            kept && accepted && folded && undone,
            json!({ "kept": kept, "accepted": accepted, "folds": folds.iter().map(|width| f32::from(*width)).collect::<Vec<_>>(), "undone": undone, "text": self.editor_text(cx, &editor) }),
        );

        // Polish asks again; Esc discards it all.
        self.select_sentence(cx, &editor)?;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.proofread_action(Some(lattice_editor::proofread::Ask::Proofread), window, cx);
                editor.scripted_proofread("polish", window, cx);
            })
        })?;
        let polished = self.card_reads(cx, &editor, "ready", 2, 2).await;
        let discarded = {
            let _front = self.focused(cx, "proofread card").await?;
            self.press(cx, '\u{1b}', false).await?;
            self.wait_for(cx, Duration::from_secs(2), |_, cx| editor.read(cx).proofread_card(cx).is_none())
                .await
        };
        let untouched = self.editor_text(cx, &editor) == original;
        steps.check(
            "Polish asks again; Esc discards the card and leaves the text untouched",
            polished && discarded && untouched,
            json!({ "polished": polished, "discarded": discarded, "untouched": untouched }),
        );

        // The scratch run's agent cannot answer: the card says so.
        self.with_window(cx, |_, _, cx| {
            editor.update(cx, |editor, _| editor.script_proofread_reply(None))
        })?;
        self.select_sentence(cx, &editor)?;
        self.keys(cx, "cmd-alt-p")?;
        let failed = self
            .wait_for(cx, Duration::from_secs(60), |_, cx| {
                editor
                    .read(cx)
                    .proofread_card(cx)
                    .is_some_and(|(status, _, _)| status == "error")
            })
            .await;
        self.adapter_shot(cx, "proofread-error").await;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| editor.scripted_proofread("dismiss", window, cx))
        })?;
        steps.check(
            "without an agent to answer, the card says it could not proofread",
            failed,
            json!({ "failed": failed }),
        );

        // The palette's Rewrite selection… opens the Rewrite menu; an
        // instruction from it asks with the writer's words.
        self.with_window(cx, |_, _, cx| {
            editor.update(cx, |editor, _| editor.script_proofread_reply(Some(REPLY.into())))
        })?;
        self.select_sentence(cx, &editor)?;
        self.dispatch_to_shell(cx, &crate::editor_panel::proofread::RewriteSelection)?;
        let menu = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| editor.read(cx).rewrite_menu_open())
            .await;
        self.adapter_shot(cx, "proofread-rewrite-menu").await;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.scripted_instruction("Shorten to about 100 words", window, cx)
            })
        })?;
        let rewritten = self.card_reads(cx, &editor, "ready", 2, 2).await;
        let instruction = cx.update(|cx| editor.read(cx).proofread_instruction(cx));
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| editor.scripted_proofread("dismiss", window, cx))
        })?;
        steps.check(
            "Rewrite selection… opens the Rewrite menu, whose instruction asks the agent in the writer's words",
            menu && rewritten && instruction.as_deref() == Some("Shorten to about 100 words"),
            json!({ "menu": menu, "rewritten": rewritten, "instruction": instruction }),
        );
        self.with_window(cx, |_, _, cx| {
            editor.update(cx, |editor, _| editor.script_proofread_reply(None))
        })?;
        let _ = original;
        Ok(())
    }

    /// The widths an accepted edit's replaced words took, in the order
    /// they were painted, until they are gone (or 1.5 s pass).
    async fn ghost_widths(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> Vec<gpui::Pixels> {
        let lattice = cx.update(|cx| editor.read(cx).lattice_editor().clone());
        let start = std::time::Instant::now();
        let mut widths: Vec<gpui::Pixels> = Vec::new();
        while start.elapsed() < Duration::from_millis(1500) {
            let width = cx.update(|cx| {
                lattice
                    .read(cx)
                    .painted()
                    .inline
                    .iter()
                    .filter(|(layer, _, _)| *layer == "proofread-accept-ghosts")
                    .map(|(_, _, bounds)| bounds.size.width)
                    .reduce(gpui::Pixels::max)
            });
            match width {
                Some(width) if widths.last() != Some(&width) => widths.push(width),
                None if !widths.is_empty() => break,
                _ => {}
            }
            cx.background_executor().timer(Duration::from_millis(8)).await;
        }
        widths
    }

    fn select_sentence(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> Result<()> {
        let text = self.editor_text(cx, editor);
        let start = text.find(SENTENCE).unwrap_or(0);
        let zed = cx.update(|cx| editor.read(cx).editor().clone());
        self.with_window(cx, |_, window, cx| {
            window.focus(&gpui::Focusable::focus_handle(zed.read(cx), cx), cx);
            zed.update(cx, |zed, cx| {
                zed.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([editor::MultiBufferOffset(start)
                        ..editor::MultiBufferOffset(start + SENTENCE.len())])
                })
            })
        })
    }

    /// A key through the window's keymap, as a press dispatches it.
    fn keys(&self, cx: &mut AsyncApp, keys: &'static str) -> Result<()> {
        let keystroke = Keystroke::parse(keys).map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_keystroke(keystroke, cx);
        })
    }

    /// Wait for the card to read `status` with `offered` edits, `kept` of
    /// them still made.
    async fn card_reads(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<EditorPanel>,
        status: &'static str,
        offered: usize,
        kept: usize,
    ) -> bool {
        self.wait_for(cx, Duration::from_secs(5), |_, cx| {
            editor.read(cx).proofread_card(cx)
                == Some((status.to_string(), offered, kept))
        })
        .await
    }
}

/// This file's registration as the e2e module `proofread` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 42,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_panel/proofread.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/proofread/card.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/proofread/inline_edits.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/proofread/accept_marks.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/proofread/instruction_menu.rs",
        "gpui/crates/lattice-gpui/src/agent/text_task.rs",
        "gpui/crates/lattice-editor/src/proofread.rs",
        "gpui/crates/lattice-editor/src/latex/protected.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.proofread(cx, steps, &fixture.root)),
};
