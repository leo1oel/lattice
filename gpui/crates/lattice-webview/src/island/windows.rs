//! The window an island's page is in, which follows the window that draws
//! the island (`Island::move_to_window`), and what the island hears of it.

use anyhow::Result;
use gpui::{Context, Focusable as _, Subscription, Window};

use super::Island;
use crate::native::refuse_keyboard_while_hidden;

impl Island {
    /// The island is drawn in `window`, not the one its page is in: move the
    /// page there as it is, and listen to that window from now on.
    pub fn move_to_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.window.window_id() == window.window_handle().window_id() {
            return;
        }
        self.window = window.window_handle();
        self._window_subscriptions = vec![activation(window, cx)];
        // The keyboard stays in the window the page left; the page takes it
        // again in this one when clicked.
        self.page_focused = false;
        if let Some(webview) = self.webview.clone() {
            if let Err(error) = webview.update(cx, |webview, cx| webview.move_to_window(window, cx))
            {
                log::error!("{}: moving the page: {error:#}", self.config.name);
            }
            refuse_keyboard_while_hidden(webview.read(cx), window);
            self.listen_to_focus(window, cx);
        }
        self.drawn = true;
        self.sync_native_visibility(cx);
        cx.notify();
    }

    /// The window the page is in is about to close: take the page out of it,
    /// as it is, until the island is drawn in another
    /// ([`Island::move_to_window`]).
    pub fn leave_window(&mut self, cx: &mut Context<Self>) {
        if let Some(webview) = &self.webview {
            webview.read(cx).leave_window();
        }
        self.page_focused = false;
    }

    /// GPUI's focus leaving the page, in the window the island is in.
    pub(crate) fn listen_to_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(webview) = &self.webview else {
            return;
        };
        let focus = webview.read(cx).focus_handle(cx);
        self._webview_subscriptions =
            vec![cx.on_focus_out(&focus, window, |this, _, window, cx| {
                this.sync_native_focus(window, cx);
            })];
    }
}

/// The window becoming active hands the keyboard back as GPUI's focus says.
pub(super) fn activation(window: &mut Window, cx: &mut Context<Island>) -> Subscription {
    cx.observe_window_activation(window, |this, window, cx| {
        if window.is_window_active() {
            this.sync_native_focus(window, cx);
        }
    })
}

/// Update the island in the window it is in now, which moving its page
/// changes, so its tasks are not bound to the window they started in. While
/// that window is closing and the page not yet back, the island's own window
/// takes the update. `Err` once the island is gone.
pub(crate) fn update_in_home<R>(
    this: &gpui::WeakEntity<Island>,
    cx: &mut gpui::AsyncApp,
    mut update: impl FnMut(&mut Island, &mut Window, &mut Context<Island>) -> R,
) -> Result<R> {
    let (home, origin) = this.read_with(cx, |island, _| (island.window, island.origin))?;
    for window in [home, origin] {
        if let Ok(result) = window.update(cx, |_, window, cx| {
            this.update(cx, |island, cx| update(island, window, cx))
        }) {
            return result;
        }
    }
    anyhow::bail!("the island's windows are closed")
}
