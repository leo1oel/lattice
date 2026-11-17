//! Native pointer drags for the e2e scenario's dock steps (macOS and
//! Windows), with a frame drawn after every event.

use std::{cell::Cell, rc::Rc, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Pixels, Point};
use lattice_ui::components::{TAB_CLOSE, TAB_CLOSE_INSET, TAB_INSET};
use serde_json::{Value, json};

use super::{Run, sleep};
use crate::native;

/// The moves a drag makes between its press and its release.
const MOVES: usize = 24;

impl Run {
    /// Drag with native mouse events from `from` to `to`, a frame drawn
    /// before the press and after every event (`frame_after_input`). Returns
    /// what the step's detail records: whether the platform was presenting
    /// the window, how many of those frames the window drew itself (the rest
    /// were drawn here), and whether a drag was on before the release.
    pub(super) async fn native_drag(
        &self,
        cx: &mut AsyncApp,
        from: Point<Pixels>,
        to: Point<Pixels>,
    ) -> Result<Value> {
        let native = self.native(cx)?;
        let presented = self.with_window(cx, |_, window, _| window.is_visible())?;
        let mut events = vec![(native::Mouse::Down, from)];
        events.extend((1..=MOVES).map(|step| {
            let t = step as f32 / MOVES as f32;
            let point = gpui::point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
            (native::Mouse::Dragged, point)
        }));
        events.push((native::Mouse::Up, to));
        let frames = events.len() + 1;
        // The press lands on the hitboxes of the dock as it is now.
        let mut drawn_by_window = usize::from(self.frame_after_input(cx).await?);
        let mut dragging = false;
        for (kind, point) in events {
            native::send_mouse(native, kind, point)?;
            drawn_by_window += usize::from(self.frame_after_input(cx).await?);
            dragging |= cx.update(|cx| cx.has_active_drag());
        }
        // The drop's own work (a dock emptied, a panel moved) settles.
        sleep(cx, Duration::from_millis(400)).await;
        Ok(json!({
            "presented": presented,
            "frames_drawn_by_window": format!("{drawn_by_window}/{frames}"),
            "dragging": dragging,
            "from": [f32::from(from.x), f32::from(from.y)],
            "to": [f32::from(to.x), f32::from(to.y)],
        }))
    }

    /// Have a frame drawn after native pointer input, as the next event
    /// needs: input lands on the hitboxes of the last frame drawn, a dock
    /// rebuilt since (a tab closed, the layout reset) has replaced the groups
    /// those name, and a dock's drop zones are drawn only once a drag is on.
    /// The window draws the frame itself while the platform presents it. One
    /// it does not present (covered, or on a locked screen; a CI runner's
    /// window can be, partway through a run) gets no frames from the display,
    /// so the frame is drawn here, as it is when a presented window has not
    /// drawn one within half a second. Returns whether the window drew it.
    pub(super) async fn frame_after_input(&self, cx: &mut AsyncApp) -> Result<bool> {
        let drawn = Rc::new(Cell::new(false));
        let flag = drawn.clone();
        let presented = self.with_window(cx, move |_, window, _| {
            window.refresh();
            // Runs as the window's next frame starts, which draws it in the
            // same turn, before the wait below looks again.
            window.on_next_frame(move |_, _| flag.set(true));
            window.is_visible()
        })?;
        if presented
            && self
                .wait_for(cx, Duration::from_millis(500), |_, _| drawn.get())
                .await
        {
            return Ok(true);
        }
        self.with_window(cx, |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })?;
        Ok(false)
    }
}

impl Run {
    /// Where to press to drag `view` by its tab in `panel`: its icon, read
    /// from the strip as last drawn. A fixed offset from the panel's edge
    /// assumes the tab is first and the strip unscrolled; a narrow panel
    /// scrolls its strip to the selected tab and shrinks the tabs. So the
    /// point comes from the tab's own box, kept inside the list's visible
    /// part and clear of the close square at the tab's end.
    pub(super) fn tab_grip(
        &self,
        cx: &mut AsyncApp,
        panel: &str,
        view: &str,
    ) -> Result<Point<Pixels>> {
        let (tabs, list) = cx.update(|cx| {
            let workspace = self.shell.read(cx).workspace().read(cx);
            (
                workspace.tab_bounds(panel),
                workspace.tab_list_bounds(panel),
            )
        });
        let tab = tabs
            .iter()
            .find(|(id, _)| id == view)
            .map(|(_, bounds)| *bounds)
            .with_context(|| format!("{view} has no tab drawn in {panel}: {tabs:?}"))?;
        let (left, right) = match list {
            Some(list) => (tab.left().max(list.left()), tab.right().min(list.right())),
            None => (tab.left(), tab.right()),
        };
        // The close square and its inset end the tab (`PanelTab`).
        let grip_end = right - (TAB_CLOSE + TAB_CLOSE_INSET);
        anyhow::ensure!(
            grip_end > left,
            "{view}'s tab shows no grip: tab {tab:?}, list {list:?}"
        );
        let icon = tab.left() + TAB_INSET + lattice_ui::icons::ICON / 2.;
        let x = if icon >= left && icon < grip_end {
            icon
        } else {
            left + (grip_end - left) / 2.
        };
        Ok(gpui::point(x, tab.center().y))
    }
}
