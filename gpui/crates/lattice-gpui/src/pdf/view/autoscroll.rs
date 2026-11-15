//! Middle-click autoscroll on the pages, as the Tauri app's
//! `use-pdf-autoscroll.ts` gives the PDF pane in webviews without native
//! autoscroll: a middle press off a link starts it, the pages then scroll
//! towards the pointer at a speed that follows its distance from where the
//! press was (still within 12px of it, so the writer can pause; then
//! `(distance - 12)^1.4 * 2` px/s, at most 1800), and the cursor is the
//! up-down arrow over the pages. Any press stops it (and is not also a
//! click), as do the wheel, Escape, and the window going to the background.

use std::time::Instant;

use super::*;

/// Within this many pixels of the press, the pages rest.
const QUIET: f32 = 12.;
/// The fastest it scrolls, in px/s.
const TOP_SPEED: f32 = 1800.;
/// A frame longer than this (a stall) moves as if it were this long.
const MAX_STEP: Duration = Duration::from_millis(32);

pub(in crate::pdf) struct Autoscroll {
    origin: f32,
    pointer: f32,
    previous: Instant,
    /// The window was active when it started: its going to the background
    /// (`blur`) stops it.
    active: bool,
}

/// The speed, px/s and signed, for the pointer `distance` px below the
/// press (negative: above).
pub(in crate::pdf) fn speed(distance: f32) -> f32 {
    let outside = (distance.abs() - QUIET).max(0.);
    distance.signum() * (outside.powf(1.4) * 2.).min(TOP_SPEED)
}

impl PdfView {
    /// A middle press on the pages: autoscroll starts, unless it is on a
    /// link (whose middle click keeps its own meaning) or already running.
    pub(in crate::pdf) fn on_sheet_middle_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.stop_autoscroll_on_press(event.button, cx) {
            return;
        }
        let (x, y) = self.sheet_point(event.position);
        let on_link = self
            .layout
            .to_page(x, y)
            .and_then(|(page, x, y)| self.link_at(page, x, y))
            .is_some();
        if on_link {
            return;
        }
        cx.stop_propagation();
        let y = f32::from(event.position.y);
        self.autoscroll = Some(Autoscroll {
            origin: y,
            pointer: y,
            previous: Instant::now(),
            active: window.is_window_active(),
        });
        self.blocked_up = Some(MouseButton::Middle);
        cx.notify();
    }

    /// A press while autoscroll runs stops it, and its release is not a
    /// click; true when it did.
    pub(in crate::pdf) fn stop_autoscroll_on_press(
        &mut self,
        button: MouseButton,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.autoscroll.is_none() {
            return false;
        }
        self.blocked_up = Some(button);
        self.stop_autoscroll(cx);
        cx.stop_propagation();
        true
    }

    /// The release of a press autoscroll took; true when it was one.
    pub(in crate::pdf) fn take_blocked_up(&mut self, button: MouseButton) -> bool {
        if self.blocked_up == Some(button) {
            self.blocked_up = None;
            return true;
        }
        false
    }

    pub(in crate::pdf) fn stop_autoscroll(&mut self, cx: &mut Context<Self>) {
        if self.autoscroll.take().is_some() {
            cx.notify();
        }
    }

    pub(in crate::pdf) fn autoscroll_pointer(&mut self, position: Point<Pixels>) {
        if let Some(autoscroll) = &mut self.autoscroll {
            autoscroll.pointer = f32::from(position.y);
        }
    }

    pub fn autoscrolling(&self) -> bool {
        self.autoscroll.is_some()
    }

    /// How far the pages are scrolled down, and the middle of their area on
    /// the window, for a scenario.
    pub fn scroll_top(&self) -> f32 {
        self.scroll_offset().1
    }

    pub fn pages_center(&self) -> Point<Pixels> {
        self.viewport.center()
    }

    /// One frame's scroll, asking for the next while it runs; it stops when
    /// the window goes to the background.
    pub(in crate::pdf) fn autoscroll_frame(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .autoscroll
            .as_ref()
            .is_some_and(|autoscroll| autoscroll.active && !window.is_window_active())
        {
            self.stop_autoscroll(cx);
        }
        let Some(autoscroll) = &mut self.autoscroll else {
            return;
        };
        let now = Instant::now();
        let step = now.duration_since(autoscroll.previous).min(MAX_STEP);
        autoscroll.previous = now;
        let by = speed(autoscroll.pointer - autoscroll.origin) * step.as_secs_f32();
        if by != 0. {
            let (x, y) = self.scroll_offset();
            self.set_scroll((x, y + by), cx);
        }
        window.request_animation_frame();
    }
}

#[cfg(test)]
mod tests {
    use super::speed;

    #[test]
    fn the_speed_follows_the_pointers_distance_with_a_quiet_centre() {
        // `Math.sign(d) * Math.min(1800, (|d| - 12) ** 1.4 * 2)`.
        assert_eq!(speed(0.), 0.);
        assert_eq!(speed(12.), 0.);
        assert_eq!(speed(-10.), 0.);
        assert!((speed(22.) - 2. * 10f32.powf(1.4)).abs() < 0.01);
        assert!((speed(-22.) + 2. * 10f32.powf(1.4)).abs() < 0.01);
        assert_eq!(speed(2000.), 1800.);
        assert_eq!(speed(-2000.), -1800.);
    }
}
