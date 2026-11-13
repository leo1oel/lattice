//! The design system's motion, driven with native pointer moves: the
//! Project tree's fluid hover lights the row under the pointer, glides to the
//! next row within one session rather than fading out and in again, and
//! clears when the pointer leaves (`lattice_ui::fluid_hover`). With
//! `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the window on the first row, at
//! two moments of the glide and on the second row, for a look review.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Bounds, Pixels, point, px};
use serde_json::json;

use super::Steps;
use crate::{native, scenario::Run};

/// Long enough for the fast tier's glide (80 ms) and a frame either side.
const SETTLE: Duration = Duration::from_millis(200);

fn near(a: Option<Bounds<Pixels>>, b: Bounds<Pixels>) -> bool {
    a.is_some_and(|a| {
        (a.origin.x - b.origin.x).abs() < px(0.5)
            && (a.origin.y - b.origin.y).abs() < px(0.5)
            && (a.size.width - b.size.width).abs() < px(0.5)
            && (a.size.height - b.size.height).abs() < px(0.5)
    })
}

impl Run {
    pub(super) async fn fluid_hover(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        let snapshot = |cx: &mut AsyncApp| {
            cx.update(|cx| tree.read(cx).hover_snapshot(cx).unwrap_or_default())
        };
        // Two rows the fill may land on (not the open file's, which keeps
        // its own selection fill); the pointer jumps from one to the other in
        // one move, so a glide is one session even across the open file.
        let rows = snapshot(cx).rows;
        let mut targets = rows
            .iter()
            .filter(|(_, _, target)| *target)
            .map(|(ix, bounds, _)| (*ix, *bounds));
        let pair = targets.next().zip(targets.next());
        let Some(((first, first_bounds), (second, second_bounds))) = pair else {
            steps.check(
                "the Project tree's rows register with its fluid hover",
                false,
                json!({ "rows": rows.len() }),
            );
            return Ok(());
        };
        let native = self.native(cx)?;

        native::send_mouse(native, native::Mouse::Moved, first_bounds.center())?;
        self.pause(cx, SETTLE).await;
        let on_first = snapshot(cx);
        steps.check(
            "the pointer over a tree row lights it with the tree's one fill",
            on_first.lit == Some(first) && near(on_first.fill, first_bounds),
            json!({ "lit": on_first.lit, "row": first, "fill": format!("{:?}", on_first.fill) }),
        );

        self.fluid_shot(cx, "fluid-tree-1-first", Duration::ZERO)
            .await;
        native::send_mouse(native, native::Mouse::Moved, second_bounds.center())?;
        // Into the fast tier's 80 ms: the fill on its way.
        self.fluid_shot(cx, "fluid-tree-2-gliding-25ms", Duration::from_millis(25))
            .await;
        self.fluid_shot(cx, "fluid-tree-3-gliding-50ms", Duration::from_millis(25))
            .await;
        self.pause(cx, SETTLE).await;
        self.fluid_shot(cx, "fluid-tree-4-second", Duration::ZERO)
            .await;
        let on_second = snapshot(cx);
        steps.check(
            "moving to another row glides the same fill there instead of fading a new one in",
            on_second.lit == Some(second)
                && near(on_second.fill, second_bounds)
                && on_second.sessions == on_first.sessions,
            json!({
                "lit": on_second.lit,
                "row": second,
                "sessions": [on_first.sessions, on_second.sessions],
            }),
        );

        // Off the tree, over the titlebar's middle.
        let away = self.with_window(cx, |_, window, _| {
            point(window.viewport_size().width / 2., px(20.))
        })?;
        native::send_mouse(native, native::Mouse::Moved, away)?;
        self.pause(cx, SETTLE).await;
        let away_snapshot = snapshot(cx);
        steps.check(
            "leaving the tree fades its fill out",
            away_snapshot.lit.is_none() && away_snapshot.leaving == 0,
            json!({ "lit": away_snapshot.lit, "leaving": away_snapshot.leaving }),
        );
        Ok(())
    }

    /// Save the window as `name` under `LATTICE_E2E_SHOTS`, after `wait`.
    async fn fluid_shot(&self, cx: &mut AsyncApp, name: &str, wait: Duration) {
        #[cfg(target_os = "macos")]
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            self.pause(cx, wait).await;
            let path = std::path::Path::new(&dir).join(format!("{name}.png"));
            if let Err(error) = self.capture(cx, &path.to_string_lossy()).await {
                log::warn!("could not save {}: {error:#}", path.display());
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (cx, name, wait);
    }
}
