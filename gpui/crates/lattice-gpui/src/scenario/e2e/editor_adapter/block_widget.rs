//! A block widget in the editor, as the editor adapter places one: the
//! lines under it pushed down by its height, and back once it goes.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity, px};
use lattice_editor::{
    LatticeEditor,
    blocks::{BlockSide, BlockWidget},
};
use serde_json::json;

use super::super::Steps;
use crate::scenario::Run;

impl Run {
    pub(super) async fn block_widget(
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
}
