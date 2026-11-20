//! AppKit adapter for GPUI Fast's native window composition.
//! The existing Wry parent stays unchanged for focus_parent(); only WKWebView
//! is reattached. All positioning goes through the surface instead of Wry's
//! original parent coordinates.
use std::{cell::Cell, rc::Rc};

use anyhow::{Context as _, Result};
use gpui::{AnyWindowHandle, AsyncApp, Bounds, Window, WindowCompositionSurface, point, px, size};
use objc2::rc::Retained;
use objc2_app_kit::NSView;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use wry::WebViewExtMacOS as _;

pub(super) struct NativeWebViewSurface {
    surface: WindowCompositionSurface,
    original_parent: Retained<NSView>,
    scale_factor: Cell<f32>,
    /// The window's interface zoom: GPUI's pixels are this many points, so
    /// the WebView's frame, which AppKit measures in points, is scaled by it.
    interface_zoom: Cell<f32>,
    window: AnyWindowHandle,
    /// The WebView left the window (`leave_window`), whose views go with it:
    /// nothing here touches them again, while the island is still drawn in
    /// the window it moves to before the move.
    left: Cell<bool>,
    cx: AsyncApp,
}

impl NativeWebViewSurface {
    pub(super) fn new(webview: &wry::WebView, window: &Window, cx: &gpui::App) -> Result<Self> {
        // SAFETY: Wry built the WebView as a child of this window's view, which
        // AppKit retains for as long as the WebView is in it.
        let original_parent =
            unsafe { webview.webview().superview() }.context("WebView has no parent")?;
        Self::attach(webview, original_parent, window, cx)
    }

    /// Move the WebView into `window`: a surface of that window's own takes it, and this
    /// one leaves the window it was in. WebKit keeps the page as it is, since a WKWebView
    /// moved between windows is neither reloaded nor torn down. `window` must not be the one
    /// the WebView is in now, and is being updated, so `cx` can still reach the other.
    pub(super) fn move_to(
        self,
        webview: &wry::WebView,
        window: &Window,
        cx: &mut gpui::App,
    ) -> Result<Self> {
        self.give_back_keyboard(webview);
        let moved = Self::attach(webview, window_view(window)?, window, cx)?;
        let result = self.window.update(cx, |_, window, _| {
            window
                .enable_window_composition()?
                .remove_surface(self.surface.id())
        });
        if let Ok(Err(error)) = result {
            log::warn!("cannot release WebView composition surface: {error:#}");
        }
        Ok(moved)
    }

    /// Take the WebView out of its window, which is about to close: a window
    /// torn down with the WebView still in it leaves it pointing at views
    /// that are gone. `move_to` puts it in a window again.
    pub(super) fn leave_window(&self, webview: &wry::WebView) {
        self.give_back_keyboard(webview);
        webview.webview().removeFromSuperview();
        self.left.set(true);
    }

    /// A page holding the keyboard leaves its window with nothing to type
    /// into but the window itself: GPUI's view there takes it back first.
    fn give_back_keyboard(&self, webview: &wry::WebView) {
        let view = webview.webview();
        if let Some(window) = view.window()
            && window.firstResponder().is_some_and(|responder| {
                std::ptr::addr_eq(Retained::as_ptr(&responder), Retained::as_ptr(&view))
            })
        {
            window.makeFirstResponder(Some(&self.original_parent));
        }
    }

    /// Give the keyboard back to the GPUI view of the window the WebView is in. Wry's own
    /// `focus_parent` names the view it was built in, which a moved WebView has left.
    pub(super) fn focus_parent(&self, webview: &wry::WebView) {
        if let Some(window) = webview.webview().window() {
            window.makeFirstResponder(Some(&self.original_parent));
        }
    }

    fn attach(
        webview: &wry::WebView,
        original_parent: Retained<NSView>,
        window: &Window,
        cx: &gpui::App,
    ) -> Result<Self> {
        let composition = window.enable_window_composition()?;
        let surface = composition.create_native_surface()?;
        let attached = (|| {
            let handle = surface.platform_surface()?.platform_handle()?;
            let parent = *handle
                .downcast::<usize>()
                .map_err(|_| anyhow::anyhow!("native surface is not an AppKit view"))?;
            anyhow::ensure!(parent != 0, "native surface has no AppKit view");
            let view = webview.webview();
            // SAFETY: Wry and the composition surface own these AppKit views;
            // this constructor runs on GPUI's main/UI thread. Adding the view
            // takes it out of the one it was in.
            unsafe { (&*(parent as *const NSView)).addSubview(&view) };
            Ok(())
        })();
        match attached {
            Ok(()) => Ok(Self {
                surface,
                original_parent,
                scale_factor: Cell::new(window.scale_factor()),
                interface_zoom: Cell::new(window.interface_zoom()),
                window: window.window_handle(),
                left: Cell::new(false),
                cx: cx.to_async(),
            }),
            Err(error) => {
                composition.remove_surface(surface.id())?;
                Err(error)
            }
        }
    }

    pub(super) fn set_scale_factor(&self, scale_factor: f32) {
        self.scale_factor.set(scale_factor);
    }

    pub(super) fn set_interface_zoom(&self, zoom: f32) {
        self.interface_zoom.set(zoom);
    }

    pub(super) fn set_bounds(&self, webview: &wry::WebView, rect: wry::Rect) -> Result<()> {
        if self.left.get() {
            return Ok(());
        }
        let scale = self.scale_factor.get();
        let (position, extent) = logical_bounds(rect, scale);
        let bounds = Bounds::new(
            point(px(position.x as f32), px(position.y as f32)),
            size(px(extent.width as f32), px(extent.height as f32)),
        );
        self.surface
            .platform_surface()?
            .set_bounds(bounds.to_device_pixels(scale))?;
        // WKWebView remains owned by Wry, on its creating UI thread.
        // Its frame is local to the managed surface, whose frame is window-relative.
        let zoom = f64::from(self.interface_zoom.get());
        webview.webview().setFrame(NSRect::new(
            NSPoint::new(0., 0.),
            NSSize::new(extent.width * zoom, extent.height * zoom),
        ));
        Ok(())
    }

    // The browser keeps its full DOM viewport; only its existing native container clips.
    pub(super) fn set_geometry(
        &self,
        webview: &wry::WebView,
        document: Bounds<gpui::Pixels>,
        visible: Bounds<gpui::Pixels>,
    ) -> Result<()> {
        if self.left.get() {
            return Ok(());
        }
        let scale = self.scale_factor.get();
        self.surface
            .platform_surface()?
            .set_bounds(visible.to_device_pixels(scale))?;
        let offset = document.origin - visible.origin;
        let zoom = self.interface_zoom.get();
        webview.webview().setFrame(NSRect::new(
            NSPoint::new(
                f64::from(offset.x * zoom),
                f64::from((visible.size.height - offset.y - document.size.height) * zoom),
            ),
            NSSize::new(
                f64::from(document.size.width * zoom),
                f64::from(document.size.height * zoom),
            ),
        ));
        Ok(())
    }

    pub(super) fn set_visible(&self, visible: bool) -> Result<()> {
        if self.left.get() {
            return Ok(());
        }
        self.surface.platform_surface()?.set_visible(visible)
    }

    pub(super) fn release(self, webview: Rc<wry::WebView>) {
        // Entity destruction can occur while App is borrowed. Run cleanup on the
        // foreground executor, retaining Wry until the managed surface is removed.
        self.cx
            .clone()
            .spawn(async move |cx| {
                if self.left.get() {
                    return;
                }
                self.original_parent.addSubview(&webview.webview());
                let result = self.window.update(cx, |_, window, _| {
                    window
                        .enable_window_composition()?
                        .remove_surface(self.surface.id())
                });
                if let Ok(Err(error)) = result {
                    log::warn!("cannot release WebView composition surface: {error:#}");
                }
            })
            .detach();
    }
}

/// The GPUI view of `window`, which a WebView built in it would have as its parent.
fn window_view(window: &Window) -> Result<Retained<NSView>> {
    use wry::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let RawWindowHandle::AppKit(handle) = HasWindowHandle::window_handle(window)?.as_raw() else {
        anyhow::bail!("not an AppKit window");
    };
    // SAFETY: GPUI's window owns its view for as long as the window is open,
    // and this runs on the main thread inside the window's update.
    unsafe { Retained::retain(handle.ns_view.as_ptr().cast::<NSView>()) }
        .context("the window has no view")
}

// Staging positions must remain window-relative at every display scale.
fn logical_bounds(
    rect: wry::Rect,
    scale: f32,
) -> (wry::dpi::LogicalPosition<f64>, wry::dpi::LogicalSize<f64>) {
    (
        rect.position.to_logical(f64::from(scale)),
        rect.size.to_logical(f64::from(scale)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use wry::dpi::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};

    #[test]
    fn retina_physical_bounds_keep_the_child_inside_its_container() {
        let (position, extent) = logical_bounds(
            wry::Rect {
                position: PhysicalPosition::new(400, 160).into(),
                size: PhysicalSize::new(1280, 960).into(),
            },
            2.,
        );
        assert_eq!(position, LogicalPosition::new(200., 80.));
        assert_eq!(extent, LogicalSize::new(640., 480.));
    }

    #[test]
    fn offscreen_logical_loading_bounds_do_not_shift_on_retina() {
        let rect = wry::Rect {
            position: LogicalPosition::new(-20000., -20000.).into(),
            size: LogicalSize::new(640., 480.).into(),
        };
        for scale in [1., 2.] {
            let (position, extent) = logical_bounds(rect, scale);
            assert_eq!(position, LogicalPosition::new(-20000., -20000.));
            assert_eq!(extent, LogicalSize::new(640., 480.));
        }
    }
}
