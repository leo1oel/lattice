//! Building a webview outside GPUI's updates, as WebView2 needs.
//!
//! Wry creates a WebView2 environment and controller synchronously, by
//! waiting on their completion handlers with `webview2_com::wait_with_pump`,
//! which pumps the thread's Windows messages until they finish. Built from
//! inside a GPUI update (a `window.defer`, an `Entity::update`, the build
//! closure of `open_window`), that pump dispatches GPUI's own messages while
//! the app is borrowed: a queued foreground task runs and borrows the app
//! again, and the app panics with `RefCell already borrowed` (on CI's Windows
//! runner, about two seconds after start, when the first island was shown).
//!
//! GPUI runs its foreground tasks from the platform's message loop, with
//! nothing borrowed between two of a task's updates, so a task that builds
//! the webview in its own body, then hands it to [`gpui_webview::WebView::new`]
//! in an update, lets the pump dispatch whatever it needs to. A task does not
//! run again while it is being polled, so the pump never re-enters the build.

use anyhow::{Context as _, Result};
use gpui::Window;
use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, WindowHandle as RawHandle};

/// `window`'s native handle, to build a child webview in outside any update.
pub struct DetachedParent(RawWindowHandle);

impl DetachedParent {
    pub fn of(window: &Window) -> Result<Self> {
        let handle =
            HasWindowHandle::window_handle(window).context("reading the window's native handle")?;
        Ok(Self(handle.as_raw()))
    }

    /// Build `builder`'s webview as a child of the window. Call it from a
    /// task's own body, never inside an update: see the module's comment,
    /// and only once the task has seen that the window is still open.
    pub fn build(&self, builder: wry::WebViewBuilder<'_>) -> wry::Result<wry::WebView> {
        builder.build_as_child(self)
    }
}

impl HasWindowHandle for DetachedParent {
    fn window_handle(&self) -> Result<RawHandle<'_>, HandleError> {
        // SAFETY: the handle is a window GPUI created and still owns: the
        // caller builds only after checking that the window is open.
        Ok(unsafe { RawHandle::borrow_raw(self.0) })
    }
}
