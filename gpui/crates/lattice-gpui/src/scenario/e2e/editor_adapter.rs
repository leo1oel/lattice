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
use gpui::{AsyncApp, Bounds, Entity, Pixels, Point, point, px};
use lattice_editor::{
    LatticeEditor, TexlabService,
    blocks::{BlockSide, BlockWidget},
    gutter::{GutterMark, GutterShape},
    latex::diagnostics,
    remote_cursors::{RemoteCursor, presence_color},
};
use serde_json::{Value, json};

use super::Steps;
use crate::{editor_panel::EditorPanel, native, scenario::Run};

/// Long enough for a hover card's delay (300 ms) and its entrance.
const CARD_WAIT: Duration = Duration::from_secs(3);
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
        // What follows reads the editor's layout and paint, which a covered
        // window does not get: put it above the others, leaving the keyboard
        // where it is.
        #[cfg(target_os = "macos")]
        native::order_front(self.native(cx)?);
        #[cfg(target_os = "windows")]
        native::bring_to_front(self.native(cx)?);
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

    /// Save the window as `name` under `LATTICE_E2E_SHOTS`, when set.
    async fn adapter_shot(&self, cx: &mut AsyncApp, name: &str) {
        #[cfg(target_os = "macos")]
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            // A covered window is not drawn: bring it above the others,
            // leaving the keyboard where it is.
            if let Ok(native) = self.native(cx) {
                native::order_front(native);
            }
            // A card or menu that just opened is still rising in.
            self.pause(cx, Duration::from_millis(450)).await;
            let path = std::path::Path::new(&dir).join(format!("{name}.png"));
            if let Err(error) = self.capture(cx, &path.to_string_lossy()).await {
                log::warn!("could not save {}: {error:#}", path.display());
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (cx, name);
    }

    fn park(&self, cx: &mut AsyncApp) -> Result<()> {
        let corner = self.with_window(cx, |_, window, _| {
            let size = window.viewport_size();
            point(size.width - px(4.), size.height - px(4.))
        })?;
        native::send_mouse(self.native(cx)?, native::Mouse::Moved, corner)
    }

    /// Where `needle`'s `nth` character is on screen, in `panel`'s text,
    /// once the editor has been drawn.
    async fn text_point(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
        needle: &str,
        nth: usize,
    ) -> Result<(usize, Bounds<Pixels>)> {
        let text = self.editor_text(cx, panel);
        let offset = text.find(needle).context("the text is in the file")? + nth;
        let wait_lattice = lattice.clone();
        self.wait_for(cx, Duration::from_secs(5), move |_, cx| {
            wait_lattice.read(cx).painted().bounds.is_some()
        })
        .await;
        let lattice = lattice.clone();
        let rect = self
            .with_window(cx, move |_, window, cx| {
                lattice.update(cx, |lattice, cx| lattice.offset_bounds(offset, window, cx))
            })?
            .context("the editor was not drawn")?;
        Ok((offset, rect))
    }

    async fn hover_at(&self, cx: &mut AsyncApp, at: Point<Pixels>) -> Result<()> {
        let native = self.native(cx)?;
        // A short approach, as a hand makes, then the rest.
        native::send_mouse(native, native::Mouse::Moved, point(at.x - px(6.), at.y))?;
        self.pause(cx, Duration::from_millis(30)).await;
        native::send_mouse(native, native::Mouse::Moved, at)
    }

    async fn wait_for_card(
        &self,
        cx: &mut AsyncApp,
        lattice: &Entity<LatticeEditor>,
        id: &str,
    ) -> Option<(std::ops::Range<usize>, Option<Bounds<Pixels>>)> {
        let lattice_wait = lattice.clone();
        let id = id.to_string();
        let shown = self
            .wait_for(cx, CARD_WAIT, move |_, cx| {
                let lattice = lattice_wait.read(cx);
                lattice
                    .shown_hover(cx)
                    .is_some_and(|(shown, _)| shown == id)
                    && lattice.painted().card.is_some()
            })
            .await;
        if !shown {
            return None;
        }
        // A card's first frame is placed before its height is known; its side
        // is settled on the next one, under its entrance.
        self.pause(cx, Duration::from_millis(450)).await;
        cx.update(|cx| {
            let lattice = lattice.read(cx);
            lattice
                .shown_hover(cx)
                .map(|(_, range)| (range, lattice.painted().card))
        })
    }

    async fn hover_cards(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<()> {
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
                lattice_wait.read(cx).shown_hover(cx).is_none()
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
        Ok(())
    }

    /// The citation card on each side of its key: with room above the key
    /// inside the editor it rises above it, and with the key too near the
    /// editor's top for that it hangs below it, though the window has room
    /// above the editor (the tab strip and titlebar) for the card.
    async fn card_sides(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
        card_height: Pixels,
    ) -> Result<()> {
        let editor = cx.update(|cx| lattice.read(cx).editor().clone());
        let start = cx.update(|cx| editor.update(cx, |editor, cx| editor.scroll_position(cx)));
        let line_height = cx
            .update(|cx| lattice.read(cx).painted().line_height)
            .context("the editor was drawn")?;
        let needed = card_height + CARD_GAP + CARD_INSET;

        // Room above: blank lines above the key's line push it down.
        let lines = (needed / line_height).ceil() as u32 + 2;
        lattice.update(cx, |lattice, cx| {
            lattice.set_blocks(
                "e2e-room",
                vec![BlockWidget {
                    line: 7,
                    side: BlockSide::Above,
                    lines,
                    render: std::sync::Arc::new(|_| {
                        use gpui::IntoElement as _;
                        gpui::div().into_any_element()
                    }),
                }],
                cx,
            )
        });
        self.scroll_editor(cx, &editor, point(start.x, 0.))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let roomy = self.citation_card(cx, panel, lattice).await?;
        self.adapter_shot(cx, "citation-card-above").await;
        self.park(cx)?;
        lattice.update(cx, |lattice, cx| lattice.set_blocks("e2e-room", Vec::new(), cx));
        self.pause(cx, Duration::from_millis(400)).await;

        // Near the top: scrolled so the key sits a line short of the room.
        let (_, key) = self
            .text_point(cx, panel, lattice, "knuth1984", 4)
            .await?;
        let editor_top = cx
            .update(|cx| lattice.read(cx).painted().bounds.map(|b| b.top()))
            .context("the editor was drawn")?;
        let target = (needed - line_height).max(line_height * 0.5);
        let top = cx.update(|cx| editor.update(cx, |editor, cx| editor.scroll_position(cx).y));
        let rows = top + ((key.top() - editor_top - target) / line_height) as f64;
        self.scroll_editor(cx, &editor, point(start.x, rows.max(0.)))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let near = self.citation_card(cx, panel, lattice).await?;
        self.adapter_shot(cx, "citation-card-below").await;
        self.park(cx)?;
        self.scroll_editor(cx, &editor, start)?;
        self.pause(cx, Duration::from_millis(400)).await;

        let room = |(key, _, editor): &(Bounds<Pixels>, Bounds<Pixels>, Bounds<Pixels>)| {
            key.top() - editor.top()
        };
        let above = roomy.as_ref().is_some_and(|shown| {
            let (key, card, editor) = *shown;
            room(shown) >= needed && card.bottom() <= key.top() + px(1.)
                && card_placed(key, card, editor)
        });
        let below = near.as_ref().is_some_and(|shown| {
            let (key, card, editor) = *shown;
            room(shown) < needed && card.top() >= key.bottom() - px(1.)
                && card_placed(key, card, editor)
        });
        let json = |shown: &Option<(Bounds<Pixels>, Bounds<Pixels>, Bounds<Pixels>)>| {
            shown.map(|(key, card, editor)| {
                json!({ "key": bounds_json(key), "card": bounds_json(card), "editor": bounds_json(editor) })
            })
        };
        steps.check(
            "a hover card rises above its key with room inside the editor above it, and hangs below a key near the editor's top",
            above && below,
            json!({ "needed": f32::from(needed), "above": json(&roomy), "below": json(&near) }),
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

    /// Hover `knuth1984` and return its key, its card and the editor, once
    /// the card is shown.
    async fn citation_card(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<Option<(Bounds<Pixels>, Bounds<Pixels>, Bounds<Pixels>)>> {
        let (_, key) = self.text_point(cx, panel, lattice, "knuth1984", 4).await?;
        self.hover_at(cx, key.center()).await?;
        let card = self
            .wait_for_card(cx, lattice, "citation")
            .await
            .and_then(|(_, card)| card);
        let editor = cx.update(|cx| lattice.read(cx).painted().bounds);
        Ok(card.zip(editor).map(|(card, editor)| (key, card, editor)))
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
            "remote carets draw as Overleaf's: bar, dot and a name tag that shows, fades, and shows again when the caret moves",
            drawn && faded && stepped,
            json!({
                "first": first.cursors.iter().map(cursor_json).collect::<Vec<_>>(),
                "moved": moved.cursors.iter().map(cursor_json).collect::<Vec<_>>(),
                "faded": faded,
            }),
        );
        lattice.update(cx, |lattice, cx| lattice.set_remote_cursors(Vec::new(), cx));
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
        let line_height = cx.update(|cx| lattice.read(cx).painted().line_height);
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
            json!({ "before": before.map(f32::from), "with_block": with_block.map(f32::from), "after": after.map(f32::from) }),
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
        let (located, marks, painted) = cx.update(|cx| {
            (
                diagnostics.read(cx).located(cx),
                lattice.read(cx).mark_ranges(diagnostics::LAYER, cx),
                lattice.read(cx).painted(),
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
            cleared,
            json!({}),
        );
        Ok(())
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
        "opacity": cursor.label_opacity,
        "below": cursor.label_below,
    })
}
