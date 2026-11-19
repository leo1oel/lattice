//! Waiting for the main window to draw: a press means nothing to an element
//! no frame has drawn yet, and macOS stops a covered window's frames.

use std::{cell::Cell, rc::Rc, time::Duration};

use gpui::AsyncApp;

use crate::scenario::Run;

impl Run {
    /// Whether the main window draws a frame within a second.
    pub(in crate::scenario) async fn next_frame(&self, cx: &mut AsyncApp) -> bool {
        let drew = Rc::new(Cell::new(false));
        self.with_window(cx, {
            let drew = drew.clone();
            move |_, window, _| window.on_next_frame(move |_, _| drew.set(true))
        })
        .ok();
        for _ in 0..20 {
            if drew.get() {
                break;
            }
            self.pause(cx, Duration::from_millis(50)).await;
        }
        drew.get()
    }
}
