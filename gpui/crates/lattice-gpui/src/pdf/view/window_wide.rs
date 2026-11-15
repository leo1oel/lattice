//! What autoscroll and a citation's card hear from the whole window, as the
//! Tauri app's hooks listen on the document (`use-pdf-autoscroll.ts`,
//! `pdf-citation-hover.tsx`): while either is under way, a press anywhere
//! stops autoscroll (and its release is not a click) or closes the card, the
//! pointer's distance is followed off the pages, a pointer leaving the pages
//! starts the card's close, and Escape reaches them wherever the focus is.

use gpui::{AnyElement, DispatchPhase, IntoElement as _, Styled as _, canvas};

use super::*;

impl PdfView {
    /// Autoscroll runs, its press's release is still to come, or a card
    /// shows or waits to open.
    fn listens_window_wide(&self) -> bool {
        self.autoscroll.is_some()
            || self.blocked_up.is_some()
            || self.citation_active()
            || self.compound_active()
            || self.note_card().is_some()
    }

    /// The window's presses, releases and moves, taken before any element
    /// hears them; and Escape from any focus in this window, while
    /// [`Self::listens_window_wide`].
    ///
    /// The mouse listeners are registered on every paint, not only while
    /// autoscroll or a card is under way: a paint's listeners are the only
    /// ones the window has until the next paint, so ones added only once a
    /// middle press had started autoscroll would miss the moves and the
    /// release that arrive before the next frame (the release would then
    /// reach the page as a click). Each handler does nothing while idle.
    pub(in crate::pdf) fn window_wide_listeners(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let view = cx.entity().downgrade();
        if !self.listens_window_wide() {
            self.escape = None;
        } else if self.escape.is_none() {
            let view = view.clone();
            let handle = window.window_handle();
            self.escape = Some(cx.intercept_keystrokes(move |event, window, cx| {
                if event.keystroke.key != "escape" || window.window_handle() != handle {
                    return;
                }
                let took = view
                    .update(cx, |this, cx| this.on_window_escape(cx))
                    .unwrap_or(false);
                if took {
                    cx.stop_propagation();
                }
            }));
        }
        canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let down = view.clone();
                window.on_mouse_event(move |event: &MouseDownEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture {
                        down.update(cx, |this, cx| this.on_window_mouse_down(event, cx))
                            .ok();
                    }
                });
                let up = view.clone();
                window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture {
                        up.update(cx, |this, cx| {
                            if this.take_blocked_up(event.button) {
                                cx.stop_propagation();
                            }
                        })
                        .ok();
                    }
                });
                let moved = view.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture {
                        moved
                            .update(cx, |this, cx| this.on_window_mouse_move(event, cx))
                            .ok();
                    }
                });
            },
        )
        .absolute()
        .size_0()
        .into_any_element()
    }

    /// A press anywhere: it stops autoscroll and is not also a click, or it
    /// closes the card unless it is on the card.
    fn on_window_mouse_down(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        if self.autoscroll.is_some() {
            self.blocked_up = Some(event.button);
            self.stop_autoscroll(cx);
            cx.stop_propagation();
            return;
        }
        if !self.on_citation_card(event.position) {
            self.dismiss_citation(cx);
        }
        // A press off the pages closes the key card; one on them is a
        // click the pages decide on (`compound_click`).
        if !self.viewport.contains(&event.position) && !self.in_compound_bridge(event.position) {
            self.dismiss_compound(cx);
        }
        // One on the pages is a click the pages decide on (`click_note`).
        if !self.viewport.contains(&event.position) && !self.on_note_card(event.position) {
            self.close_note_card(cx);
        }
    }

    fn on_window_mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if let Some(autoscroll) = &mut self.autoscroll {
            autoscroll.pointer = f32::from(event.position.y);
        }
        if !self.viewport.contains(&event.position) && !self.on_citation_card(event.position) {
            self.leave_citation(cx);
        }
        if !self.viewport.contains(&event.position) && !self.in_compound_bridge(event.position) {
            self.leave_compound(cx);
        }
        if !self.viewport.contains(&event.position) {
            self.leave_notes(cx);
        }
    }

    /// Escape closes the card, and stops autoscroll; true when it took the
    /// key from the rest of the window.
    fn on_window_escape(&mut self, cx: &mut Context<Self>) -> bool {
        self.dismiss_citation(cx);
        self.dismiss_compound(cx);
        if self.close_note_card(cx) && self.autoscroll.is_none() {
            return true;
        }
        if self.autoscroll.is_some() {
            self.stop_autoscroll(cx);
            return true;
        }
        false
    }
}
