//! The e2e check that a hover card takes the side of its key the Tauri app
//! gives it: above the key with room inside the editor above it, below a key
//! near the editor's top.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Bounds, Entity, Pixels, point, px};
use lattice_editor::{
    LatticeEditor,
    blocks::{BlockSide, BlockWidget},
};
use serde_json::json;

use super::{CARD_GAP, CARD_INSET, Steps, bounds_json, card_placed};
use crate::{editor_panel::EditorPanel, scenario::Run};

impl Run {
    /// The citation card on each side of its key: with room above the key
    /// inside the editor it rises above it, and with the key too near the
    /// editor's top for that it hangs below it, though the window has room
    /// above the editor (the tab strip and titlebar) for the card.
    pub(super) async fn card_sides(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
        card_height: Pixels,
    ) -> Result<()> {
        let editor = cx.update(|cx| lattice.read(cx).editor().clone());
        let start = cx.update(|cx| editor.update(cx, |editor, cx| editor.scroll_position(cx)));
        let line_height = self
            .line_height(cx, lattice)?
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
        self.pause(cx, Duration::from_millis(300)).await;
        // Then scrolled so the key sits a line past the room: in a narrow
        // editor, whose lines wrap, the room alone pushes it out of view.
        self.scroll_key_to(cx, panel, lattice, &editor, needed + line_height)
            .await?;
        let roomy = self.citation_card(cx, panel, lattice).await?;
        self.adapter_shot(cx, "citation-card-above").await;
        self.park(cx)?;
        lattice.update(cx, |lattice, cx| {
            lattice.set_blocks("e2e-room", Vec::new(), cx)
        });
        self.pause(cx, Duration::from_millis(400)).await;

        // Near the top: scrolled so the key sits a line short of the room.
        let target = (needed - line_height).max(line_height * 0.5);
        self.scroll_key_to(cx, panel, lattice, &editor, target)
            .await?;
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
            room(shown) >= needed
                && card.bottom() <= key.top() + px(1.)
                && card_placed(key, card, editor)
        });
        let below = near.as_ref().is_some_and(|shown| {
            let (key, card, editor) = *shown;
            room(shown) < needed
                && card.top() >= key.bottom() - px(1.)
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

    /// Scroll the editor so the top of `knuth1984` sits `target` below the
    /// editor's top edge (or as near as scrolling from the top gets it).
    async fn scroll_key_to(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
        editor: &Entity<editor::Editor>,
        target: Pixels,
    ) -> Result<()> {
        let line_height = self
            .line_height(cx, lattice)?
            .context("the editor was drawn")?;
        let (_, key) = self.text_point(cx, panel, lattice, "knuth1984", 4).await?;
        let editor_top = cx
            .update(|cx| lattice.read(cx).painted().bounds.map(|b| b.top()))
            .context("the editor was drawn")?;
        let scroll = cx.update(|cx| editor.update(cx, |editor, cx| editor.scroll_position(cx)));
        let rows = scroll.y + ((key.top() - editor_top - target) / line_height) as f64;
        self.scroll_editor(cx, editor, point(scroll.x, rows.max(0.)))?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
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
}
