//! The editor adapter's extension points, each checked through its real
//! Lattice use in `main.tex`: the citation and reference cards (hover), other
//! people's carets, a block widget, TexLab's diagnostics (marks and their
//! card), and command and citation completion. Gutter marks have no Lattice
//! use yet, so they are checked with a layer of the scenario's own.
//!
//! The pointer moves with native mouse-moved events, and completion is
//! driven with native keys, as the rest of the scenario is. With
//! `LATTICE_E2E_SHOTS=DIR` (macOS) the window is saved at each card, the
//! carets and the completion menu, for a look review.

use std::time::Duration;

use anyhow::{Context as _, Result};
use editor::SelectionEffects;
use gpui::{AsyncApp, Bounds, Entity, Focusable as _, Pixels, Point, point, px};
use lattice_editor::{
    LatticeEditor, TexlabService,
    blocks::{BlockSide, BlockWidget},
    gutter::{GutterMark, GutterShape},
    hover::HoverTarget,
    latex::diagnostics,
    remote_cursors::{RemoteCursor, presence_color},
};
use serde_json::{Value, json};

use super::Steps;

mod card_sides;
use crate::{editor_panel::EditorPanel, native, scenario::Run};

/// Long enough for a hover card's delay (300 ms) and its entrance.
pub(super) const CARD_WAIT: Duration = Duration::from_secs(3);
/// The scenario's own gutter layer.
const GUTTER_LAYER: &str = "e2e-gutter";
/// How far inside the editor a hover card stays: the Tauri app's
/// `citationTooltipSpace` insets the editor's edges by 8 px.
const CARD_INSET: Pixels = px(8.);
/// The adapter's gap between a card and its key.
const CARD_GAP: Pixels = px(4.);

impl Run {
    pub(super) async fn editor_adapter(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &std::path::Path,
    ) -> Result<()> {
        // What follows waits for the overlay to paint the editor's carets,
        // gutter marks and cards, which only an active window draws: GPUI's
        // own focus (`Run::focused`).
        let _front = self.focused(cx, "editor_adapter").await?;
        let panel = self.open(cx, &root.join("main.tex"), Some(8))?;
        self.pause(cx, Duration::from_millis(600)).await;
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());
        // The index reads the project in the background after it opens.
        self.wait_for(cx, Duration::from_secs(10), |shell, cx| {
            shell.read(cx).project().is_some_and(|project| {
                let index = project.read(cx).index().read(cx);
                index.citation("knuth1984").is_some() && index.reference("sec:method").is_some()
            })
        })
        .await;

        self.hover_cards(cx, steps, &panel, &lattice).await?;
        self.remote_carets(cx, steps, &lattice).await?;
        self.block_widget(cx, steps, &lattice).await?;
        self.gutter_marks(cx, steps, &lattice).await?;
        self.texlab_marks(cx, steps, &panel, &lattice).await?;
        self.completions(cx, steps, &panel).await?;
        self.park(cx)?;
        Ok(())
    }

    /// The height of one of the editor's display rows, from its own layout:
    /// a caret's height. (The overlay records it only in frames that draw
    /// gutter marks or carets.) Not the distance between two lines: a narrow
    /// editor (a 1024px CI screen leaves the center ~170px) wraps a line
    /// over several rows.
    fn line_height(
        &self,
        cx: &mut AsyncApp,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<Option<Pixels>> {
        let lattice = lattice.clone();
        self.with_window(cx, move |_, window, cx| {
            lattice.update(cx, |lattice, cx| {
                lattice
                    .offset_bounds(0, window, cx)
                    .map(|caret| caret.size.height)
            })
        })
    }

    fn park(&self, cx: &mut AsyncApp) -> Result<()> {
        let corner = self.with_window(cx, |_, window, _| {
            let size = window.viewport_size();
            point(size.width - px(4.), size.height - px(4.))
        })?;
        native::send_mouse(self.native(cx)?, native::Mouse::Moved, corner)
    }

    async fn hover_cards(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<()> {
        // First, before anything sets a gutter mark or a caret: the cards
        // open in an editor with nothing of the overlay's to paint.
        let (offset, key) = self.text_point(cx, panel, lattice, "knuth1984", 4).await?;
        self.hover_at(cx, key.center()).await?;
        let shown = self.wait_for_card(cx, lattice, "citation").await;
        let text = self.editor_text(cx, panel);
        let covers_key = shown
            .as_ref()
            .is_some_and(|(range, _)| text.get(range.clone()) == Some("knuth1984"));
        // The card rises above the key where it fits under the editor's top
        // edge, and hangs below it where it does not.
        let editor = cx.update(|cx| lattice.read(cx).painted().bounds);
        let card = shown.as_ref().and_then(|(_, card)| *card);
        let placed = card
            .zip(editor)
            .is_some_and(|(card, editor)| card_placed(key, card, editor));
        self.adapter_shot(cx, "citation-card").await;
        steps.check(
            "hovering a citation key opens its card (key, title, authors, actions) by the key",
            covers_key && placed,
            json!({ "offset": offset, "shown": shown.as_ref().map(|(r, c)| json!({ "range": [r.start, r.end], "card": c.map(bounds_json) })) }),
        );

        // Off the key and the card, it closes.
        self.park(cx)?;
        let lattice_wait = lattice.clone();
        let closed = self
            .wait_for(cx, CARD_WAIT, move |_, cx| {
                lattice_wait.read(cx).shown_hover(cx).is_empty()
            })
            .await;
        steps.check(
            "the citation card closes when the pointer leaves the key and the card",
            closed,
            json!({}),
        );
        if let Some(card) = card {
            self.card_sides(cx, steps, panel, lattice, card.size.height)
                .await?;
        }

        let (_, label) = self
            .text_point(cx, panel, lattice, "sec:method}.", 4)
            .await?;
        self.hover_at(cx, label.center()).await?;
        let shown = self.wait_for_card(cx, lattice, "reference").await;
        let covers_label = shown
            .as_ref()
            .is_some_and(|(range, _)| text.get(range.clone()) == Some("sec:method"));
        self.adapter_shot(cx, "reference-card").await;
        steps.check(
            "hovering a \\ref label opens the reference card for what it names",
            covers_label,
            json!({ "shown": shown.as_ref().map(|(r, _)| [r.start, r.end]) }),
        );
        self.park(cx)?;
        self.pause(cx, Duration::from_millis(400)).await;
        self.following_stack(cx, steps, panel, lattice).await?;
        self.line_hover(cx, steps, panel, lattice).await
    }

    /// A target is hovered over any of its characters, on whichever display
    /// row the editor's soft wrap puts them, and never from the empty space
    /// past a line's end, where the editor clamps the pointer's offset to the
    /// line's last one: a scenario provider's span over the whole
    /// `Some text with ...` line (which also answers at the clamped end)
    /// opens on its last character and stays closed to the right of it.
    async fn line_hover(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<()> {
        let text = self.editor_text(cx, panel);
        let start = text
            .find("Some text with")
            .context("main.tex has the text line")?;
        let end = start + text[start..].find('\n').context("the line ends")?;
        let enabled = std::rc::Rc::new(std::cell::Cell::new(true));
        let provider_on = enabled.clone();
        lattice.update(cx, |lattice, _| {
            lattice.add_hover_provider(std::rc::Rc::new(
                move |_: &language::BufferSnapshot, offset: usize, _: &gpui::App| {
                    (provider_on.get() && (start..=end).contains(&offset)).then(|| HoverTarget {
                        range: start..end,
                        id: "e2e-line",
                        card: std::rc::Rc::new(|_, _, _| {
                            use gpui::{IntoElement as _, ParentElement as _};
                            gpui::div().child("A line card").into_any_element()
                        }),
                    })
                },
            ))
        });
        let (_, first) = self
            .text_point(cx, panel, lattice, "Some text with", 0)
            .await?;
        let (_, last) = self
            .text_point(cx, panel, lattice, "sec:method}.", 11)
            .await?;
        let wrapped = last.top() > first.top();
        self.hover_at(cx, last.center()).await?;
        let on_last = self.wait_for_stack(cx, lattice, &["e2e-line"]).await;
        self.adapter_shot(cx, "line-card-last-row").await;
        self.park(cx)?;
        let lattice_wait = lattice.clone();
        let closed = self
            .wait_for(cx, CARD_WAIT, move |_, cx| {
                lattice_wait.read(cx).shown_hover(cx).is_empty()
            })
            .await;
        let editor = cx
            .update(|cx| lattice.read(cx).painted().bounds)
            .context("the editor was drawn")?;
        let past_x = (last.right() + px(60.)).min(editor.right() - px(4.));
        let past = point(past_x, last.center().y);
        let room_past_end = past_x > last.right() + px(4.);
        self.hover_at(cx, past).await?;
        // Well past the hover delay and a card's entrance.
        self.pause(cx, Duration::from_millis(900)).await;
        let past_shown = cx.update(|cx| lattice.read(cx).shown_hover(cx));
        enabled.set(false);
        self.park(cx)?;
        self.pause(cx, Duration::from_millis(400)).await;
        steps.check(
            "a target opens over its last character (on a wrapped row too) and not from the space past its line's end",
            on_last && closed && room_past_end && past_shown.is_empty(),
            json!({
                "wrapped": wrapped,
                "first": bounds_json(first),
                "last": bounds_json(last),
                "on_last": on_last,
                "closed": closed,
                "past": [f32::from(past.x), f32::from(past.y)],
                "room_past_end": room_past_end,
                "past_shown": past_shown.iter().map(|(id, range)| json!({ "id": id, "range": [range.start, range.end] })).collect::<Vec<_>>(),
            }),
        );
        Ok(())
    }

    /// Wait for the shown cards to be `expected`, top to bottom.
    async fn wait_for_stack(
        &self,
        cx: &mut AsyncApp,
        lattice: &Entity<LatticeEditor>,
        expected: &'static [&'static str],
    ) -> bool {
        let lattice = lattice.clone();
        self.wait_for(cx, CARD_WAIT, move |_, cx| {
            let lattice = lattice.read(cx);
            let ids: Vec<_> = lattice
                .shown_hover(cx)
                .into_iter()
                .map(|(id, _)| id)
                .collect();
            ids == expected && lattice.painted().card.is_some()
        })
        .await
    }

    /// A stack follows the targets under the pointer while the pointer stays
    /// by it, as each of CodeMirror's hover sources follows its own range: a
    /// scenario provider's span over the whole `\cite{knuth1984}` opens alone
    /// on `\cite`, the citation card joins once the pointer rests on the key,
    /// and goes again once the pointer is back on `\cite`.
    async fn following_stack(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<()> {
        let command = "\\cite{knuth1984}";
        let start = self
            .editor_text(cx, panel)
            .find(command)
            .context("main.tex cites knuth1984")?;
        let span = start..start + command.len();
        let enabled = std::rc::Rc::new(std::cell::Cell::new(true));
        let provider_on = enabled.clone();
        lattice.update(cx, |lattice, _| {
            lattice.add_hover_provider(std::rc::Rc::new(
                move |_: &language::BufferSnapshot, offset: usize, _: &gpui::App| {
                    (provider_on.get() && span.contains(&offset)).then(|| HoverTarget {
                        range: span.clone(),
                        id: "e2e-span",
                        card: std::rc::Rc::new(|_, _, _| {
                            use gpui::{IntoElement as _, ParentElement as _};
                            gpui::div().child("A span card").into_any_element()
                        }),
                    })
                },
            ))
        });
        let native = self.native(cx)?;
        let (_, on_command) = self.text_point(cx, panel, lattice, command, 2).await?;
        let (_, on_key) = self.text_point(cx, panel, lattice, "knuth1984", 4).await?;
        self.hover_at(cx, on_command.center()).await?;
        let alone = self.wait_for_stack(cx, lattice, &["e2e-span"]).await;
        native::send_mouse(native, native::Mouse::Moved, on_key.center())?;
        let joined = alone
            && self
                .wait_for_stack(cx, lattice, &["citation", "e2e-span"])
                .await;
        native::send_mouse(native, native::Mouse::Moved, on_command.center())?;
        let dropped = joined && self.wait_for_stack(cx, lattice, &["e2e-span"]).await;
        let shown = cx.update(|cx| lattice.read(cx).shown_hover(cx));
        enabled.set(false);
        self.park(cx)?;
        self.pause(cx, Duration::from_millis(400)).await;
        steps.check(
            "a shown stack follows the targets under the pointer: a card joins on its target and goes when the pointer leaves it",
            alone && joined && dropped,
            json!({
                "alone": alone,
                "joined": joined,
                "dropped": dropped,
                "shown": shown.iter().map(|(id, range)| json!({ "id": id, "range": [range.start, range.end] })).collect::<Vec<_>>(),
            }),
        );
        Ok(())
    }

    fn scroll_editor(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<editor::Editor>,
        position: Point<f64>,
    ) -> Result<()> {
        let editor = editor.clone();
        self.with_window(cx, move |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.set_scroll_position(position, window, cx);
            })
        })
    }

    async fn remote_carets(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<()> {
        let cursors = |column: u32| {
            vec![
                RemoteCursor {
                    id: "ada".into(),
                    name: "Ada Lovelace".into(),
                    color: presence_color(None, 200.),
                    row: 0,
                    column: 5,
                },
                RemoteCursor {
                    id: "grace".into(),
                    name: "Grace Hopper".into(),
                    color: presence_color(Some("#0b6e4f"), 0.),
                    row: 7,
                    column,
                },
            ]
        };
        // Both carets' lines in view: the editor opened centred on line 8,
        // which in a narrow editor, whose lines wrap, scrolls line 1 out.
        let editor = cx.update(|cx| lattice.read(cx).editor().clone());
        let start = cx.update(|cx| editor.update(cx, |editor, cx| editor.scroll_position(cx)));
        self.scroll_editor(cx, &editor, point(start.x, 0.))?;
        lattice.update(cx, |lattice, cx| {
            lattice.set_remote_cursors(cursors(10), cx)
        });
        self.pause(cx, Duration::from_millis(300)).await;
        let first = cx.update(|cx| lattice.read(cx).painted());
        self.adapter_shot(cx, "remote-carets").await;
        let lattice_wait = lattice.clone();
        let faded = self
            .wait_for(cx, Duration::from_secs(4), move |_, cx| {
                let painted = lattice_wait.read(cx).painted();
                painted.cursors.len() == 2
                    && painted
                        .cursors
                        .iter()
                        .all(|cursor| cursor.label_opacity == 0.)
            })
            .await;
        // The pointer on a caret's line beside it, above its bar, shows the
        // faded tag: the caret's hover area is its whole line.
        let grace_faded = cx.update(|cx| {
            lattice
                .read(cx)
                .painted()
                .cursors
                .into_iter()
                .find(|cursor| cursor.id.as_ref() == "grace")
        });
        let hover_point = grace_faded
            .as_ref()
            .map(|cursor| point(cursor.bar.center().x, cursor.hover.top() + px(1.)));
        let mut hover_tag = false;
        if let Some((at, cursor)) = hover_point.zip(grace_faded.as_ref())
            && at.y < cursor.bar.top()
        {
            native::send_mouse(self.native(cx)?, native::Mouse::Moved, at)?;
            let lattice_wait = lattice.clone();
            hover_tag = self
                .wait_for(cx, Duration::from_secs(2), move |_, cx| {
                    lattice_wait
                        .read(cx)
                        .painted()
                        .cursors
                        .iter()
                        .any(|cursor| cursor.id.as_ref() == "grace" && cursor.label_opacity == 1.)
                })
                .await;
            self.park(cx)?;
            self.pause(cx, Duration::from_millis(100)).await;
        }
        // A caret that moves shows its name again, two characters along.
        lattice.update(cx, |lattice, cx| {
            lattice.set_remote_cursors(cursors(12), cx)
        });
        self.pause(cx, Duration::from_millis(300)).await;
        let moved = cx.update(|cx| lattice.read(cx).painted());
        let caret = |painted: &lattice_editor::Painted, id: &str| {
            painted
                .cursors
                .iter()
                .find(|cursor| cursor.id.as_ref() == id)
                .cloned()
        };
        let line_height = first.line_height.unwrap_or_default();
        let (ada, grace, grace_moved) = (
            caret(&first, "ada"),
            caret(&first, "grace"),
            caret(&moved, "grace"),
        );
        let drawn = ada
            .as_ref()
            .zip(grace.as_ref())
            .is_some_and(|(ada, grace)| {
                // Named at once; the top line's tag hangs below it.
                ada.label_opacity == 1.
                    && grace.label_opacity == 1.
                    && ada.label_below
                    && !grace.label_below
                    && grace.bar.top() > ada.bar.top() + line_height * 6.
            });
        let stepped = grace
            .as_ref()
            .zip(grace_moved.as_ref())
            .is_some_and(|(before, after)| {
                let step = after.bar.left() - before.bar.left();
                step > px(8.)
                    && step < px(30.)
                    && after.label_opacity == 1.
                    && moved
                        .cursors
                        .iter()
                        .any(|cursor| cursor.id.as_ref() == "ada" && cursor.label_opacity == 0.)
            });
        steps.check(
            "remote carets draw as Overleaf's: bar, dot and a name tag that shows, fades, shows while the pointer is on the caret's line beside it, and shows again when the caret moves",
            drawn && faded && hover_tag && stepped,
            json!({
                "first": first.cursors.iter().map(cursor_json).collect::<Vec<_>>(),
                "moved": moved.cursors.iter().map(cursor_json).collect::<Vec<_>>(),
                "faded": faded,
                "hover_point": hover_point.map(|at| [f32::from(at.x), f32::from(at.y)]),
                "hover_tag": hover_tag,
            }),
        );
        lattice.update(cx, |lattice, cx| lattice.set_remote_cursors(Vec::new(), cx));
        self.scroll_editor(cx, &editor, start)?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }

    async fn block_widget(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<()> {
        let line_top = |this: &Self, cx: &mut AsyncApp| {
            let lattice = lattice.clone();
            this.with_window(cx, move |_, window, cx| {
                lattice.update(cx, |lattice, cx| lattice.line_top(7, window, cx))
            })
        };
        let before = line_top(self, cx)?;
        let line_height = self.line_height(cx, lattice)?;
        lattice.update(cx, |lattice, cx| {
            lattice.set_blocks(
                "e2e",
                vec![BlockWidget {
                    line: 5,
                    side: BlockSide::Below,
                    lines: 2,
                    render: std::sync::Arc::new(|_| {
                        use gpui::{IntoElement as _, ParentElement as _, Styled as _};
                        gpui::div()
                            .h_full()
                            .child("A block widget")
                            .into_any_element()
                    }),
                }],
                cx,
            )
        });
        self.pause(cx, Duration::from_millis(300)).await;
        let with_block = line_top(self, cx)?;
        lattice.update(cx, |lattice, cx| lattice.set_blocks("e2e", Vec::new(), cx));
        self.pause(cx, Duration::from_millis(300)).await;
        let after = line_top(self, cx)?;
        let pushed = before
            .zip(with_block)
            .zip(line_height)
            .is_some_and(|((before, with), line)| ((with - before) - line * 2.).abs() < px(1.));
        steps.check(
            "a block widget between lines pushes the lines below it down by its height, and goes again",
            pushed && after == before,
            json!({ "before": before.map(f32::from), "with_block": with_block.map(f32::from), "after": after.map(f32::from), "line_height": line_height.map(f32::from) }),
        );
        Ok(())
    }

    async fn gutter_marks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<()> {
        lattice.update(cx, |lattice, cx| {
            lattice.set_gutter_marks(
                GUTTER_LAYER,
                vec![GutterMark {
                    line: 7,
                    color: gpui::rgb(0x0b6e4f).into(),
                    shape: GutterShape::Dot,
                    hover: Some(std::rc::Rc::new(|_, _, _| {
                        use gpui::{IntoElement as _, ParentElement as _};
                        gpui::div().child("A gutter card").into_any_element()
                    })),
                }],
                cx,
            )
        });
        let wait_lattice = lattice.clone();
        let painted = self
            .wait_for(cx, Duration::from_secs(3), move |_, cx| {
                wait_lattice
                    .read(cx)
                    .painted()
                    .gutter
                    .iter()
                    .any(|(layer, _, _)| *layer == GUTTER_LAYER)
            })
            .await;
        let (gutter, line_top, line_height) = {
            let lattice = lattice.clone();
            self.with_window(cx, move |_, window, cx| {
                lattice.update(cx, |lattice, cx| {
                    (
                        lattice.painted().gutter,
                        lattice.line_top(7, window, cx),
                        lattice.painted().line_height,
                    )
                })
            })?
        };
        let mark = gutter
            .iter()
            .find(|(layer, _, _)| *layer == GUTTER_LAYER)
            .map(|(_, row, bounds)| (*row, *bounds));
        // Centred on its line's row, in the editor's own coordinates.
        let on_line =
            mark.zip(line_top.zip(line_height))
                .is_some_and(|((row, bounds), (top, height))| {
                    row == 7 && (bounds.center().y - (top + height / 2.)).abs() < px(1.)
                });
        let card = match mark {
            Some((_, bounds)) => {
                self.hover_at(cx, bounds.center()).await?;
                self.wait_for_card(cx, lattice, GUTTER_LAYER)
                    .await
                    .is_some()
            }
            None => false,
        };
        self.adapter_shot(cx, "gutter-card").await;
        self.park(cx)?;
        self.pause(cx, Duration::from_millis(400)).await;
        lattice.update(cx, |lattice, cx| {
            lattice.set_gutter_marks(GUTTER_LAYER, Vec::new(), cx)
        });
        let wait_lattice = lattice.clone();
        let cleared = self
            .wait_for(cx, Duration::from_secs(3), move |_, cx| {
                wait_lattice.read(cx).painted().gutter.is_empty()
            })
            .await;
        steps.check(
            "a gutter mark is painted beside its line, opens its card on hover, and goes with its layer",
            painted && on_line && card && cleared,
            json!({
                "mark": mark.map(|(row, bounds)| json!({ "row": row, "bounds": bounds_json(bounds) })),
                "line_top": line_top.map(f32::from),
                "card": card,
                "cleared": cleared,
            }),
        );
        Ok(())
    }

    async fn texlab_marks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<()> {
        if !TexlabService::available() {
            steps.check(
                "TexLab's diagnostics show as marks with their card",
                true,
                json!({ "skipped": "texlab is not installed" }),
            );
            return Ok(());
        }
        let diagnostics = cx
            .update(|cx| panel.read(cx).texlab_diagnostics().cloned())
            .context("main.tex has TexLab diagnostics")?;
        // An unknown label, at the end of the paragraph's line.
        let editor = cx.update(|cx| panel.read(cx).editor().clone());
        let end = cx.update(|cx| {
            let text = editor.read(cx).text(cx);
            text.find("\\ref{sec:method}.")
                .map(|at| at + "\\ref{sec:method}.".len())
        });
        let end = end.context("main.tex has its reference")?;
        // TexLab keeps one document, and syncs only the editor the writer is
        // in (or the one already its document): put the writer in main.tex.
        let writer = self.writer_in(cx, &editor).await?;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([
                        editor::MultiBufferOffset(end)..editor::MultiBufferOffset(end)
                    ])
                });
                editor.handle_input(" \\ref{nolabel}", window, cx);
            })
        })?;
        let wait_diagnostics = diagnostics.clone();
        let found = self
            .wait_for(cx, Duration::from_secs(40), move |_, cx| {
                let located = wait_diagnostics.read(cx).located(cx);
                located
                    .iter()
                    .any(|located| located.message.contains("Undefined reference"))
            })
            .await;
        let (located, marks, painted, document) = cx.update(|cx| {
            (
                diagnostics.read(cx).located(cx),
                lattice.read(cx).mark_ranges(diagnostics::LAYER, cx),
                lattice.read(cx).painted(),
                self.shell.read(cx).project().and_then(|project| {
                    project
                        .read(cx)
                        .texlab()
                        .read(cx)
                        .document()
                        .map(str::to_string)
                }),
            )
        });
        // As in the Tauri app, the lint draws nothing in the gutter.
        let no_gutter = painted.gutter.is_empty();
        let text = self.editor_text(cx, panel);
        let underlined = marks.iter().any(|range| {
            text.get(range.clone())
                .is_some_and(|marked| marked.contains("nolabel"))
        });
        steps.check(
            "TexLab's diagnostics show as wavy marks, with nothing in the gutter",
            found && underlined && no_gutter,
            json!({
                "writer": writer,
                "texlab_document": document,
                "located": located.iter().map(|l| json!({ "range": [l.range.start, l.range.end], "message": l.message, "severity": format!("{:?}", l.severity) })).collect::<Vec<_>>(),
                "marks": marks.iter().map(|r| [r.start, r.end]).collect::<Vec<_>>(),
                "gutter": painted.gutter.iter().map(|(layer, row, bounds)| json!({ "layer": layer, "row": row, "bounds": bounds_json(*bounds) })).collect::<Vec<_>>(),
            }),
        );

        let (_, underline) = self.text_point(cx, panel, lattice, "nolabel", 3).await?;
        self.hover_at(cx, underline.center()).await?;
        let underline_card = self
            .wait_for_card(cx, lattice, "diagnostic")
            .await
            .is_some();
        self.adapter_shot(cx, "diagnostic-card").await;
        self.park(cx)?;
        steps.check(
            "a diagnostic's underline opens the lint card",
            underline_card,
            json!({ "underline_card": underline_card }),
        );

        // Taking the reference out again clears the line.
        let typed = " \\ref{nolabel}";
        cx.update(|cx| {
            let buffer = panel.read(cx).lattice_editor().read(cx).buffer().clone();
            buffer.update(cx, |buffer, cx| {
                buffer.edit([(end..end + typed.len(), "")], None, cx)
            });
        });
        let wait_diagnostics = diagnostics.clone();
        let cleared = self
            .wait_for(cx, Duration::from_secs(40), move |_, cx| {
                !wait_diagnostics
                    .read(cx)
                    .located(cx)
                    .iter()
                    .any(|located| located.message.contains("Undefined reference"))
            })
            .await;
        steps.check(
            "fixing the reference clears its diagnostic",
            // Only a diagnostic that showed can clear.
            found && cleared,
            json!({ "found": found, "cleared": cleared }),
        );
        self.stacked_cards(cx, steps, panel, lattice, &diagnostics)
            .await
    }

    /// A TexLab diagnostic on a citation key the index knows: with the
    /// bibliography unlinked, TexLab calls `knuth1984` undefined, though the
    /// project's `references.bib` (which the index reads) has it. Hovering
    /// the key opens both cards, the citation card over the lint card, as the
    /// Tauri app's hover host stacks its sources' tooltips.
    async fn stacked_cards(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
        diagnostics: &Entity<diagnostics::TexlabDiagnostics>,
    ) -> Result<()> {
        let link = "\\bibliography{references}";
        let at = self
            .editor_text(cx, panel)
            .find(link)
            .context("main.tex links its bibliography")?;
        let buffer = cx.update(|cx| lattice.read(cx).buffer().clone());
        buffer.update(cx, |buffer, cx| {
            buffer.edit([(at..at + link.len(), "")], None, cx)
        });
        let key = self
            .editor_text(cx, panel)
            .find("knuth1984")
            .context("main.tex cites knuth1984")?;
        let wait_diagnostics = diagnostics.clone();
        let found = self
            .wait_for(cx, Duration::from_secs(40), move |_, cx| {
                wait_diagnostics
                    .read(cx)
                    .located(cx)
                    .iter()
                    .any(|located| located.range.start <= key && key < located.range.end)
            })
            .await;
        let (_, rect) = self.text_point(cx, panel, lattice, "knuth1984", 4).await?;
        self.hover_at(cx, rect.center()).await?;
        let stacked = self
            .wait_for_stack(cx, lattice, &["citation", "diagnostic"])
            .await;
        let shown = cx.update(|cx| lattice.read(cx).shown_hover(cx));
        let located = cx.update(|cx| diagnostics.read(cx).located(cx));
        self.adapter_shot(cx, "stacked-cards").await;
        self.park(cx)?;
        buffer.update(cx, |buffer, cx| buffer.edit([(at..at, link)], None, cx));
        steps.check(
            "a TexLab diagnostic on a citation key the index knows opens the citation card over its lint card",
            found && stacked,
            json!({
                "found": found,
                "shown": shown.iter().map(|(id, range)| json!({ "id": id, "range": [range.start, range.end] })).collect::<Vec<_>>(),
                "located": located.iter().map(|l| json!({ "range": [l.range.start, l.range.end], "message": l.message })).collect::<Vec<_>>(),
            }),
        );
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }

    /// Put the writer in `editor`, as clicking into it does: give it the
    /// window's focus, and the `Focused` event the editor panel follows.
    /// GPUI emits that only in an active window, and on a locked screen
    /// nothing can become active, so in an inactive window the scenario
    /// emits it, as GPUI would once the window became key.
    pub(super) async fn writer_in(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<editor::Editor>,
    ) -> Result<Value> {
        let handle = cx.update(|cx| editor.read(cx).focus_handle(cx));
        let focus = handle.clone();
        self.with_window(cx, move |_, window, cx| window.focus(&focus, cx))?;
        // Focus listeners run as a frame finishes.
        self.pause(cx, Duration::from_millis(100)).await;
        let (focused, active) = self.with_window(cx, move |_, window, _| {
            (handle.is_focused(window), window.is_window_active())
        })?;
        if focused && !active {
            editor.update(cx, |_, cx| cx.emit(editor::EditorEvent::Focused));
        }
        Ok(json!({ "focused": focused, "window_active": active }))
    }

    async fn completions(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
    ) -> Result<()> {
        let editor = cx.update(|cx| panel.read(cx).editor().clone());
        let end = cx
            .update(|cx| {
                let text = editor.read(cx).text(cx);
                text.find("\\ref{sec:method}.")
                    .map(|at| at + "\\ref{sec:method}.".len())
            })
            .context("main.tex has its reference")?;
        // Into a citation's braces (the bracket pairing closes them), then
        // the first letters of the key with native keys.
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([
                        editor::MultiBufferOffset(end)..editor::MultiBufferOffset(end)
                    ])
                });
                editor.handle_input(" \\cite", window, cx);
                editor.handle_input("{", window, cx);
            })
        })?;
        self.type_text(cx, "kn").await?;
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());
        let labels = |cx: &mut AsyncApp| -> Vec<String> {
            cx.update(|cx| {
                if !editor.read(cx).has_visible_completions_menu() {
                    return Vec::new();
                }
                lattice
                    .read(cx)
                    .offered_completions()
                    .into_iter()
                    .map(|label| label.to_string())
                    .collect()
            })
        };
        let wait_editor = editor.clone();
        self.wait_for(cx, Duration::from_secs(3), move |_, cx| {
            wait_editor.read(cx).has_visible_completions_menu()
        })
        .await;
        let citation_menu = labels(cx);
        self.adapter_shot(cx, "citation-completion").await;
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let text = self.editor_text(cx, panel);
        steps.check(
            "typing in a \\cite slot lists the project's entries by title; Enter inserts the key",
            citation_menu.iter().any(|label| label == "The TeXbook")
                && text.contains("\\cite{knuth1984}")
                && !text.contains("\\cite{knuth1984}}"),
            json!({ "menu": citation_menu }),
        );

        // A command: `\textb` lists \textbf first; Enter puts the caret in
        // its braces, where typing goes.
        let end = cx
            .update(|cx| {
                let text = editor.read(cx).text(cx);
                text.find("\\cite{knuth1984}.")
                    .or_else(|| text.rfind("\\cite{knuth1984}"))
                    .map(|at| at + "\\cite{knuth1984}".len())
            })
            .context("the citation went in")?;
        let end = end + usize::from(self.editor_text(cx, panel)[end..].starts_with('}'));
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([
                        editor::MultiBufferOffset(end)..editor::MultiBufferOffset(end)
                    ])
                });
            })
        })?;
        self.type_text(cx, " \\textb").await?;
        let wait_editor = editor.clone();
        self.wait_for(cx, Duration::from_secs(3), move |_, cx| {
            wait_editor.read(cx).has_visible_completions_menu()
        })
        .await;
        let command_menu = labels(cx);
        self.adapter_shot(cx, "command-completion").await;
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.type_text(cx, "x").await?;
        let text = self.editor_text(cx, panel);
        steps.check(
            "typing a command lists the vocabulary (\\textbf first for \\textb); Enter puts the caret in its braces",
            command_menu.first().map(String::as_str) == Some("\\textbf") && text.contains("\\textbf{x}"),
            json!({ "menu": command_menu.iter().take(5).collect::<Vec<_>>(), "line": text.lines().nth(7) }),
        );

        // A package in the middle of a list: in `\usepackage{|,amsmath}`,
        // `x` lists the prefix match xcolor before the infix graphicx, and
        // Enter inserts the bare name, leaving the list's comma and brace
        // as they were (the Tauri app's options insert only their label).
        let start = cx
            .update(|cx| {
                let text = editor.read(cx).text(cx);
                text.find("\\usepackage{amsmath}")
                    .map(|at| at + "\\usepackage{".len())
            })
            .context("main.tex loads amsmath")?;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([
                        editor::MultiBufferOffset(start)..editor::MultiBufferOffset(start)
                    ])
                });
                editor.handle_input(",", window, cx);
                editor.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([
                        editor::MultiBufferOffset(start)..editor::MultiBufferOffset(start)
                    ])
                });
            })
        })?;
        self.type_text(cx, "x").await?;
        let wait_editor = editor.clone();
        self.wait_for(cx, Duration::from_secs(3), move |_, cx| {
            wait_editor.read(cx).has_visible_completions_menu()
        })
        .await;
        let package_menu = labels(cx);
        self.adapter_shot(cx, "package-completion").await;
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let text = self.editor_text(cx, panel);
        steps.check(
            "typing a package mid-list ranks prefix matches first (xcolor before graphicx); Enter inserts the bare name",
            package_menu.first().map(String::as_str) == Some("xcolor")
                && package_menu.iter().any(|label| label == "graphicx")
                && text.contains("\\usepackage{xcolor,amsmath}\n"),
            json!({ "menu": package_menu.iter().take(5).collect::<Vec<_>>(), "line": text.lines().nth(1) }),
        );
        Ok(())
    }
}

/// Whether a hover card for `key` sits where the Tauri app's tooltip space
/// puts it: inside the editor's top edge, above the key when it fits there
/// and below it when it does not.
fn card_placed(key: Bounds<Pixels>, card: Bounds<Pixels>, editor: Bounds<Pixels>) -> bool {
    let fits_above = key.top() - editor.top() >= card.size.height + CARD_GAP + CARD_INSET;
    let inside = card.top() >= editor.top() + CARD_INSET - px(1.);
    let side = if fits_above {
        card.bottom() <= key.top() + px(1.)
    } else {
        card.top() >= key.bottom() - px(1.)
    };
    inside && side
}

fn bounds_json(bounds: Bounds<Pixels>) -> Value {
    json!([
        f32::from(bounds.origin.x),
        f32::from(bounds.origin.y),
        f32::from(bounds.size.width),
        f32::from(bounds.size.height)
    ])
}

fn cursor_json(cursor: &lattice_editor::PaintedCursor) -> Value {
    json!({
        "id": cursor.id.as_ref(),
        "bar": bounds_json(cursor.bar),
        "label": bounds_json(cursor.label),
        "hover": bounds_json(cursor.hover),
        "opacity": cursor.label_opacity,
        "below": cursor.label_below,
    })
}
