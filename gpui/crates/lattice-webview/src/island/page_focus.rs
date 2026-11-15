//! Giving the page the keyboard back from the host: after a window dialog
//! the page asked for (the Visual view's Wrap in environment… and Rename the
//! environment), the page's editor takes it again, as the Tauri app's
//! canvas focuses its editor once it applies the dialog's edit. A GPUI
//! focus alone leaves AppKit's first responder on GPUI's view, so the
//! page's own keys would never reach it.

use gpui::{Context, Window};

use super::Island;

impl Island {
    /// Give the page AppKit's first responder and GPUI's focus.
    pub fn focus_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(webview) = &self.webview else {
            return;
        };
        if let Err(error) = webview.read(cx).raw().focus() {
            log::warn!("{}: focus: {error}", self.config.name);
            return;
        }
        self.set_page_focused(true, window, cx);
    }
}
