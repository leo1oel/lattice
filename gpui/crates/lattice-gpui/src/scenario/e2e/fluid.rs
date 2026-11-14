//! The design system's motion, driven with native pointer moves: the
//! Project tree's fluid hover lights the row under the pointer, glides to the
//! next row within one session rather than fading out and in again, and
//! clears when the pointer leaves (`lattice_ui::fluid_hover`). With
//! `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the window on the first row, at
//! two moments of the glide and on the second row, for a look review.

use std::time::{Duration, Instant};

use anyhow::Result;
use gpui::{AsyncApp, Bounds, Pixels, point, px};
use serde_json::{Value, json};

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

/// The fill's top in each frame painted from `since`, as (ms, y) pairs.
fn glide_frames(painted: &[(Instant, Bounds<Pixels>)], since: Instant) -> Vec<(f32, f32)> {
    painted
        .iter()
        .filter(|(at, _)| *at >= since)
        .map(|(at, rect)| {
            (
                at.saturating_duration_since(since).as_secs_f32() * 1000.,
                f32::from(rect.origin.y),
            )
        })
        .collect()
}

/// Whether a glide from `from` to `to` moved every frame toward `to` until
/// it landed there: never back, never past it, never holding still on the
/// way (a stall is a step), and landed.
fn glides_smoothly(frames: &[(f32, f32)], from: f32, to: f32) -> bool {
    let toward = (to - from).signum();
    // The frames painted before the move reached the list still show the
    // fill where it was.
    let Some(set_off) = frames.iter().position(|(_, y)| (y - from).abs() >= 0.05) else {
        return false;
    };
    let frames = &frames[set_off.saturating_sub(1)..];
    let landed = frames.iter().position(|(_, y)| (y - to).abs() < 0.05);
    let Some(landed) = landed else {
        return false;
    };
    let travel = &frames[..=landed];
    travel.len() >= 3
        && travel.windows(2).all(|pair| {
            let step = (pair[1].1 - pair[0].1) * toward;
            // A repaint within the same frame may draw the same place; a
            // later frame that does is a stall.
            step > 0. || (step == 0. && pair[1].0 - pair[0].0 < 2.)
        })
        && travel.iter().all(|(_, y)| (y - to) * toward <= 0.05)
}

fn frames_json(frames: &[(f32, f32)]) -> Value {
    json!(
        frames
            .iter()
            .map(
                |(ms, y)| json!({ "ms": (ms * 10.).round() / 10., "y": (y * 100.).round() / 100. })
            )
            .collect::<Vec<_>>()
    )
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
        // Active and in front: gpui-fast draws an inactive window at 30
        // frames a second, which would space the glide's frames out to 33ms.
        #[cfg(target_os = "macos")]
        native::order_front(native);
        self.with_window(cx, |_, window, cx| {
            cx.activate(true);
            window.activate_window();
        })?;
        self.pause(cx, SETTLE).await;
        let active = self.with_window(cx, |_, window, _| window.is_window_active())?;

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
        let glide_start = Instant::now();
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
        // Frame by frame, as painted: every frame of the glide moves the fill
        // on toward the row (the spring is evaluated at each frame's time),
        // none holds it still or sends it back.
        let frames = glide_frames(&on_second.painted, glide_start);
        let (from_y, to_y) = (
            f32::from(first_bounds.origin.y),
            f32::from(second_bounds.origin.y),
        );
        steps.check(
            "the glide moves the fill toward the row in every frame it paints until it lands",
            glides_smoothly(&frames, from_y, to_y),
            json!({ "window_active": active, "from": from_y, "to": to_y, "frames": frames_json(&frames) }),
        );

        // A pointer that reaches the next row before the glide lands bends
        // the same glide on: it keeps its speed instead of starting again
        // from rest, so the fill never stalls at the row it passed.
        let third = rows
            .iter()
            .filter(|(ix, _, target)| *target && *ix != first && *ix != second)
            .map(|(ix, bounds, _)| (*ix, *bounds))
            .find(|(_, bounds)| {
                (bounds.origin.y - second_bounds.origin.y).signum()
                    == (second_bounds.origin.y - first_bounds.origin.y).signum()
            });
        if let Some((third, third_bounds)) = third {
            native::send_mouse(native, native::Mouse::Moved, first_bounds.center())?;
            self.pause(cx, SETTLE).await;
            let chase_start = Instant::now();
            native::send_mouse(native, native::Mouse::Moved, second_bounds.center())?;
            self.pause(cx, Duration::from_millis(30)).await;
            native::send_mouse(native, native::Mouse::Moved, third_bounds.center())?;
            self.pause(cx, SETTLE).await;
            let chased = snapshot(cx);
            let frames = glide_frames(&chased.painted, chase_start);
            let to_y = f32::from(third_bounds.origin.y);
            steps.check(
                "a pointer that reaches the next row mid-glide carries the same glide on, \
                 never stalling at the row it passed",
                chased.lit == Some(third) && glides_smoothly(&frames, from_y, to_y),
                json!({
                    "rows": [first, second, third],
                    "from": from_y,
                    "to": to_y,
                    "frames": frames_json(&frames),
                }),
            );
        }

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
