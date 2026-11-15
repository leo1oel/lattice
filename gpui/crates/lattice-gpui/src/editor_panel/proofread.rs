//! Proofreading the source editor's selection through the embedded agent,
//! as the Tauri app does (`src/canvas/proofread-layer.tsx`,
//! `proofread-bridge.ts`, `src/editor/proofread-anchor.ts`).
//!
//! Proofread (⌘⌥P, the selection toolbar, the palette), Polish, or Rewrite
//! by the writer's own instruction (the toolbar's Rewrite menu) opens the
//! card (`card.rs`) in a block under the selection's last line, so the text
//! below moves down rather than hiding behind it, and marks the span it
//! would replace in the accent at 12%. The agent's answer is a revision of
//! the span (`lattice_editor::proofread`), split into separate edits, each
//! with the reason it gave; Lattice holds back any edit that would change
//! protected LaTeX. ⌘↵ applies the edits the writer kept, in one undo step
//! of its own, and marks them for a moment (`accept_marks.rs`); Esc
//! discards them all. One proofread at a time: a new one replaces it.
//!
//! The span is held by anchors, so typing at either edge stays outside it;
//! an edit inside it while the agent worked is caught at Accept, which asks
//! to proofread again rather than overwrite it.

mod accept_marks;
mod card;
pub(super) mod inline_edits;
mod instruction_menu;

use std::{collections::BTreeSet, mem::Discriminant, ops::Range, sync::Arc, time::Duration};

use editor::{MultiBufferOffset, SelectionEffects, display_map::ToDisplayPoint as _, scroll::Autoscroll};
use gpui::{
    AppContext as _, Context, Entity, Focusable as _, IntoElement as _, Subscription, Task,
    Window,
};
use language::{Anchor, Point, ToOffset as _};
use lattice_editor::{
    blocks::{BlockSide, BlockWidget},
    decorations::Highlight,
    proofread::{self, Ask},
};
use lattice_i18n::t;
use lattice_ui::ActiveLattice as _;

pub(super) use accept_marks::AcceptMarks;
pub(super) use instruction_menu::InstructionMenu;

use self::{
    accept_marks::Accepted,
    card::{CardEvent, CardState, ProofreadCard},
};
use super::EditorPanel;
use crate::agent::text_task::{self, TextTask};

gpui::actions!(
    lattice_proofread,
    [
        /// Proofread the selection (⌘⌥P).
        ProofreadSelection,
        /// Polish the selection.
        PolishSelection,
        /// Rewrite the selection by an instruction: the toolbar's menu.
        RewriteSelection,
    ]
);

/// ⌘⌥P in the editor, as the Tauri app's proofread keymap binds it.
pub fn bindings() -> Vec<gpui::KeyBinding> {
    let key = if cfg!(target_os = "macos") { "cmd-alt-p" } else { "ctrl-alt-p" };
    vec![gpui::KeyBinding::new(key, ProofreadSelection, Some("LatticeEditor"))]
}

/// The span's mark and the card's block.
const SOURCE: &str = "proofread-source";
const BLOCK: &str = "proofread-card";

/// One open proofread.
struct Session {
    /// The file it was asked in (the panel's), the text it was asked about
    /// and the source around it its LaTeX check reads.
    original: String,
    context: proofread::Context,
    ask: Ask,
    range: Range<Anchor>,
    card: Entity<ProofreadCard>,
    _events: Subscription,
    _status: Subscription,
    /// The card status last scrolled into view.
    revealed: Option<Discriminant<CardState>>,
    /// The agent's task and the wait for its answer; dropped, both stop.
    run: Option<(Option<TextTask>, Task<()>)>,
}

#[derive(Default)]
pub(super) struct ProofreadState {
    session: Option<Session>,
    pub(super) instruction: Option<InstructionMenu>,
    pub(super) accepted: AcceptMarks,
    /// The e2e scenario's stand-in for the agent's reply.
    scripted: Option<String>,
}

impl EditorPanel {
    /// Whether the agent may proofread here: an editable LaTeX source in a
    /// project.
    pub(super) fn can_proofread(&self, cx: &gpui::App) -> bool {
        self.relative.to_ascii_lowercase().ends_with(".tex")
            && !self.editor.read(cx).read_only(cx)
            && self.project_root(cx).is_dir()
    }

    /// Proofread, polish or rewrite the selection.
    pub(crate) fn start_proofread(&mut self, ask: Ask, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_proofread(cx) {
            return;
        }
        let range = self.toolbar_selection(cx);
        let text = self.buffer.read(cx).text();
        let Some(range) = range.filter(|range| !text[range.clone()].trim().is_empty()) else {
            // Say what it needs rather than do nothing, which read as a
            // broken shortcut.
            crate::notices::show(
                crate::notices::Notice::new(
                    lattice_ui::components::ToastLevel::Info,
                    t!("Proofread"),
                )
                .detail(t!("Select the text to proofread first."))
                .key("proofread-no-selection"),
                cx,
            );
            return;
        };
        self.close_proofread(cx);
        let snapshot = self.buffer.read(cx).snapshot();
        // Text typed at either edge stays outside the span.
        let anchors = snapshot.anchor_after(range.start)..snapshot.anchor_before(range.end);
        let (original, context) = anchored_text(&text, range.clone());
        let editable = !self.editor.read(cx).read_only(cx);
        let card = cx.new(|_| ProofreadCard::new(original.clone(), ask.clone(), editable));
        let events = cx.subscribe_in(&card, window, |this, _, event, window, cx| {
            this.card_event(event.clone(), window, cx)
        });
        let status = cx.observe_in(&card, window, |this, card, window, cx| {
            let status = std::mem::discriminant(card.read(cx).state());
            let Some(session) = &mut this.proofread.session else {
                return;
            };
            if session.revealed.replace(status) != Some(status) {
                // One frame lays the card out and Zed measures its block;
                // the next reads the block at its real height.
                cx.on_next_frame(window, |_, window, cx| {
                    cx.on_next_frame(window, |this, window, cx| this.reveal_proofread(window, cx))
                });
            }
        });
        self.proofread.session = Some(Session {
            original,
            context,
            ask,
            range: anchors,
            card,
            _events: events,
            _status: status,
            revealed: None,
            run: None,
        });
        self.dismiss_toolbar(cx);
        // Collapse the selection so the toolbar steps aside; the span stays
        // marked.
        let at = MultiBufferOffset(range.end);
        self.editor.update(cx, |editor, cx| {
            editor.change_selections(SelectionEffects::no_scroll(), window, cx, |selections| {
                selections.select_ranges([at..at])
            })
        });
        self.place_proofread(window, cx);
        self.run_proofread(cx);
    }

    /// Mark the span and put the card under its last line.
    fn place_proofread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = &self.proofread.session else {
            return;
        };
        let snapshot = self.buffer.read(cx).snapshot();
        let range = session.range.start.to_offset(&snapshot)..session.range.end.to_offset(&snapshot);
        // A selection ending in a line break ends at the next line's start;
        // the card still belongs under the last line with selected text.
        let last = if range.end > range.start { range.end - 1 } else { range.end };
        let line = snapshot.offset_to_point(last).row;
        let card = session.card.clone();
        let accent = cx.palette().accent;
        let mark = (!range.is_empty()).then(|| Highlight {
            range,
            color: accent.opacity(0.12),
        });
        let lattice = self.lattice.clone();
        window.defer(cx, move |_, cx| {
            lattice.update(cx, |lattice, cx| {
                lattice.set_highlights(SOURCE, mark.into_iter().collect(), cx);
                lattice.set_blocks(
                    BLOCK,
                    vec![BlockWidget {
                        line,
                        side: BlockSide::Below,
                        lines: 4,
                        render: Arc::new(move |_| card.clone().into_any_element()),
                    }],
                    cx,
                );
            })
        });
    }

    /// Scroll the card into view, its top first when it is taller than the
    /// editor (`revealCard`): a selection near the bottom opened it below
    /// the fold.
    fn reveal_proofread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = &self.proofread.session else {
            return;
        };
        let snapshot = self.buffer.read(cx).snapshot();
        let range = session.range.start.to_offset(&snapshot)..session.range.end.to_offset(&snapshot);
        let last = if range.end > range.start { range.end - 1 } else { range.end };
        let line = snapshot.offset_to_point(last).row;
        let line_len = snapshot.line_len(line);
        let below_last_line = line >= snapshot.max_point().row;
        self.editor.update(cx, |editor, cx| {
            let Some(visible) = editor.visible_line_count() else {
                return;
            };
            let display = editor.snapshot(window, cx);
            let map = &display.display_snapshot;
            // The card's rows: after its line's last display row, up to the
            // next line's first (or the end, under the last line).
            let top = Point::new(line, line_len).to_display_point(map).row().0 as f64 + 1.;
            let bottom = if below_last_line {
                map.max_point().row().0 as f64 + 1.
            } else {
                Point::new(line + 1, 0).to_display_point(map).row().0 as f64
            };
            let margin = 0.5;
            let scroll = editor.scroll_position(cx);
            let above = top - margin - scroll.y;
            let below = bottom + margin - (scroll.y + visible);
            let shift = if above < 0. {
                above
            } else if below > 0. {
                below.min(above)
            } else {
                return;
            };
            editor.set_scroll_position(gpui::point(scroll.x, scroll.y + shift), window, cx);
        });
    }

    /// Ask the agent about the session's span as it reads now.
    fn run_proofread(&mut self, cx: &mut Context<Self>) {
        let root = self.project_root(cx);
        let path = self.relative.clone();
        let scripted = self.proofread.scripted.clone();
        let Some(session) = &mut self.proofread.session else {
            return;
        };
        session.run = None;
        let (original, ask, context) =
            (session.original.clone(), session.ask.clone(), session.context.clone());
        session.card.update(cx, |card, cx| {
            card.set(original.clone(), ask.clone(), CardState::Loading, cx)
        });
        if !proofread::within_max_length(&original) {
            let limit = proofread::MAX_LENGTH.to_string();
            let state = CardState::Error {
                message: t!("Select at most {limit} characters to proofread.", limit = limit),
                retryable: false,
            };
            session.card.update(cx, |card, cx| card.set_state(state, cx));
            return;
        }
        // The agent writes its notes in the interface's language.
        let language = if lattice_i18n::locale().is_chinese() {
            "Simplified Chinese"
        } else {
            "English"
        };
        let prompt = proofread::prompt(&original, &path, &ask, language);
        let (task, answer) = match scripted {
            Some(reply) => {
                let timer = cx.background_executor().clone();
                (
                    None,
                    cx.background_executor().spawn(async move {
                        timer.timer(Duration::from_millis(300)).await;
                        Ok(text_task::Answer { text: reply, model: None })
                    }),
                )
            }
            None => {
                let mut task = TextTask::start(root, prompt, cx);
                let answer = task.answer();
                (Some(task), answer)
            }
        };
        let card = session.card.clone();
        let wait = cx.spawn(async move |this, cx| {
            let answered = answer.await;
            this.update(cx, |this, cx| {
                let state = match answered {
                    Ok(answer) => match proofread::parse_reply(&answer.text, &original) {
                        Some(revised) => {
                            let reasons = proofread::parse_reasons(&answer.text);
                            let review = proofread::review(&original, &revised, &context);
                            CardState::Ready {
                                review: proofread::with_reasons(review, &original, &reasons),
                                rejected: BTreeSet::new(),
                                model: answer.model,
                            }
                        }
                        None => CardState::Error {
                            message: unreadable(&ask),
                            retryable: true,
                        },
                    },
                    Err(failure) => CardState::Error {
                        retryable: failure != text_task::Failure::Unavailable,
                        message: failure_message(&failure, &ask),
                    },
                };
                card.update(cx, |card, cx| card.set_state(state, cx));
                if let Some(session) = &mut this.proofread.session {
                    session.run = None;
                }
            })
            .ok();
        });
        session.run = Some((task, wait));
    }

    fn card_event(&mut self, event: CardEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            CardEvent::Accept => {
                self.accept_proofread(false, window, cx);
            }
            CardEvent::AcceptAll => {
                self.accept_proofread(true, window, cx);
            }
            CardEvent::Dismiss => self.dismiss_proofread(window, cx),
            CardEvent::Retry => self.retry_proofread(None, cx),
            CardEvent::Mode(ask) => self.retry_proofread(Some(ask), cx),
            CardEvent::Choose(id, accepted) => {
                if let Some(session) = &self.proofread.session {
                    session.card.update(cx, |card, cx| card.choose(id, accepted, cx));
                }
            }
        }
    }

    /// Ask again about the span as it reads now, with `ask` (the session's
    /// own by default).
    fn retry_proofread(&mut self, ask: Option<Ask>, cx: &mut Context<Self>) {
        let text = self.buffer.read(cx).text();
        let snapshot = self.buffer.read(cx).snapshot();
        let Some(session) = &mut self.proofread.session else {
            return;
        };
        let range = session.range.start.to_offset(&snapshot)..session.range.end.to_offset(&snapshot);
        let (original, context) = anchored_text(&text, range);
        session.original = original;
        session.context = context;
        if let Some(ask) = ask {
            session.ask = ask;
        }
        self.run_proofread(cx);
    }

    /// Apply the edits the writer kept (every offered one with `all`).
    fn accept_proofread(&mut self, all: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(session) = &self.proofread.session else {
            return false;
        };
        let CardState::Ready { review, rejected, .. } = session.card.read(cx).state().clone() else {
            return false;
        };
        if self.editor.read(cx).read_only(cx) {
            return false;
        }
        let snapshot = self.buffer.read(cx).snapshot();
        let from = session.range.start.to_offset(&snapshot);
        let to = session.range.end.to_offset(&snapshot).max(from);
        let card = session.card.clone();
        let fail = |message: String, cx: &mut Context<Self>| {
            card.update(cx, |card, cx| {
                card.set_state(CardState::Error { message, retryable: true }, cx)
            });
            true
        };
        // An edit inside the span while the agent worked would be
        // overwritten.
        if snapshot.text_for_range(from..to).collect::<String>() != session.original {
            return fail(
                t!("The selected text changed while it was being proofread. Proofread it again to review the current text.")
                    .to_string(),
                cx,
            );
        }
        let edits = if all { review.edits.clone() } else { proofread::chosen_edits(&review, &rejected) };
        if edits.is_empty() {
            self.dismiss_proofread(window, cx);
            return true;
        }
        let revised = proofread::apply_edits(&session.original, &edits);
        // Each edit passed on its own; two together could still form LaTeX
        // neither did (a backslash and a word meeting, say).
        if proofread::protected_change(&session.original, &revised, &session.context).is_some() {
            return fail(
                t!("Together, the chosen edits would change LaTeX. Accept fewer edits, or proofread again.")
                    .to_string(),
                cx,
            );
        }
        // Where each edit's new words sit once all of them are made.
        let mut sorted = edits.clone();
        sorted.sort_by_key(|edit| edit.from);
        let mut shift: isize = 0;
        let accepted: Vec<Accepted> = sorted
            .iter()
            .map(|edit| {
                let at = (from + edit.from) as isize + shift;
                shift += edit.insert.len() as isize - (edit.to - edit.from) as isize;
                Accepted {
                    from: at as usize,
                    to: at as usize + edit.insert.len(),
                    removed: session.original[edit.from..edit.to].to_string(),
                }
            })
            .collect();
        let editor = self.editor.clone();
        editor.update(cx, |editor, cx| {
            // Its own undo step, never merged with typing on either side.
            editor.buffer().update(cx, |buffer, cx| {
                buffer.finalize_last_transaction(cx);
                buffer.edit(
                    sorted.iter().map(|edit| {
                        (
                            MultiBufferOffset(from + edit.from)..MultiBufferOffset(from + edit.to),
                            edit.insert.as_str(),
                        )
                    }),
                    None,
                    cx,
                );
                buffer.finalize_last_transaction(cx);
            });
            let (start, end) = (MultiBufferOffset(from), MultiBufferOffset(from + revised.len()));
            editor.change_selections(
                SelectionEffects::scroll(Autoscroll::fit()),
                window,
                cx,
                |selections| selections.select_ranges([start..end]),
            );
        });
        self.close_proofread(cx);
        self.mark_accepted(accepted, cx);
        window.focus(&self.editor.focus_handle(cx), cx);
        true
    }

    fn dismiss_proofread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_proofread(cx);
        window.focus(&self.editor.focus_handle(cx), cx);
    }

    /// Put the card and its mark away; the agent's task stops.
    pub(super) fn close_proofread(&mut self, cx: &mut Context<Self>) {
        if self.proofread.session.take().is_none() {
            return;
        }
        self.lattice.update(cx, |lattice, cx| {
            lattice.clear_layer(SOURCE, cx);
            lattice.set_blocks(BLOCK, Vec::new(), cx);
        });
        cx.notify();
    }

    /// ⌘↵ while a card is open: accept the edits still made, or close a
    /// card with none, once the agent has answered. Whether the card took
    /// the key.
    pub(super) fn proofread_accept_key(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.accept_proofread(false, window, cx)
    }

    /// Esc while a card is open: discard it. Whether the card took the key.
    pub(super) fn proofread_escape(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.proofread.session.is_none() {
            return false;
        }
        self.dismiss_proofread(window, cx);
        true
    }

    /// The palette's and the keys' asks.
    pub(crate) fn proofread_action(&mut self, ask: Option<Ask>, window: &mut Window, cx: &mut Context<Self>) {
        match ask {
            Some(ask) => self.start_proofread(ask, window, cx),
            None => self.open_rewrite_menu(window, cx),
        }
    }

    // ---- the e2e scenario's handles ----------------------------------------

    /// Answer the next proofreads with `reply` instead of the agent.
    pub(crate) fn script_proofread_reply(&mut self, reply: Option<String>) {
        self.proofread.scripted = reply;
    }

    /// The open card's summary state: none, loading, ready with how many
    /// edits offered and kept, or an error.
    pub(crate) fn proofread_card(&self, cx: &gpui::App) -> Option<(String, usize, usize)> {
        let session = self.proofread.session.as_ref()?;
        let card = session.card.read(cx);
        let (offered, kept) = card.counts();
        let status = match card.state() {
            CardState::Loading => "loading",
            CardState::Ready { .. } => "ready",
            CardState::Error { .. } => "error",
        };
        Some((status.to_string(), offered, kept))
    }

    /// Whether the selection toolbar's Rewrite menu is open.
    pub(crate) fn rewrite_menu_open(&self) -> bool {
        self.proofread.instruction.is_some()
    }

    /// Submit `instruction` from the open Rewrite menu, as its choice would.
    pub(crate) fn scripted_instruction(
        &mut self,
        instruction: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.proofread.instruction.is_some() {
            self.submit_instruction(instruction, window, cx);
        }
    }

    /// The open card's instruction, when it is a rewrite.
    pub(crate) fn proofread_instruction(&self, cx: &gpui::App) -> Option<String> {
        match self.proofread.session.as_ref()?.card.read(cx).ask() {
            Ask::Instruction(instruction) => Some(instruction.clone()),
            _ => None,
        }
    }

    /// Press one of the open card's actions, as a click would.
    pub(crate) fn scripted_proofread(&mut self, action: &str, window: &mut Window, cx: &mut Context<Self>) {
        let event = match action {
            "accept" => CardEvent::Accept,
            "accept-all" => CardEvent::AcceptAll,
            "dismiss" => CardEvent::Dismiss,
            "polish" => CardEvent::Mode(Ask::Polish),
            "keep-first" => CardEvent::Choose(0, false),
            _ => return,
        };
        self.card_event(event, window, cx);
    }
}

/// The span's text, with its LaTeX context; past the limit, the card
/// refuses before asking, so it needs none.
fn anchored_text(text: &str, range: Range<usize>) -> (String, proofread::Context) {
    let original = text[range.clone()].to_string();
    if !proofread::within_max_length(&original) {
        return (original, proofread::Context::default());
    }
    (original, proofread::context(text, range.start, range.end))
}

fn unreadable(ask: &Ask) -> String {
    if matches!(ask, Ask::Instruction(_)) {
        t!("The agent's reply did not contain a rewritten version of the selection.")
    } else {
        t!("The agent's reply did not contain a proofread version of the selection.")
    }
    .to_string()
}

fn failure_message(failure: &text_task::Failure, ask: &Ask) -> String {
    let rewrite = matches!(ask, Ask::Instruction(_));
    match failure {
        text_task::Failure::Unavailable => t!(
            "This version of the agent runtime cannot proofread yet. Update Lattice to use proofreading."
        )
        .to_string(),
        text_task::Failure::Failed(detail) if detail.is_empty() => if rewrite {
            t!("The agent could not rewrite the selection.")
        } else {
            t!("The agent could not proofread the selection.")
        }
        .to_string(),
        text_task::Failure::Failed(detail) => {
            if rewrite {
                t!("The agent could not rewrite the selection: {detail}", detail = detail)
            } else {
                t!("The agent could not proofread the selection: {detail}", detail = detail)
            }
        }
    }
}
