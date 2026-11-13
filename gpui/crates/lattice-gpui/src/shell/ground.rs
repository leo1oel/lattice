//! The ground under the titlebar: the chrome the dock's cards stand on, 12px
//! from the window's sides and bottom and 6px under the titlebar, with the
//! empty center's hint and the floating panels over it.

use gpui::{
    Context, InteractiveElement as _, ParentElement as _, Styled as _, Window, deferred, div,
    prelude::FluentBuilder as _, px,
};
use lattice_ui::ActiveLattice as _;

use super::{Shell, WORKSPACE_SIDE, WORKSPACE_TOP, arrange};

impl Shell {
    /// The cards under the titlebar, on the chrome.
    pub(super) fn workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::Div {
        let palette = cx.palette().clone();
        div()
            .relative()
            .flex_1()
            .min_h_0()
            // The chrome, or its translucent shell over the vibrancy.
            .bg(palette.shell)
            .pt(px(WORKSPACE_TOP))
            .px(px(WORKSPACE_SIDE))
            .pb(px(WORKSPACE_SIDE))
            .children(lattice_ui::parity::probe("workspace"))
            // While a dock panel is dragged, webview islands step aside: a
            // page would hide the drop targets under it and swallow the drag.
            .on_drag_move(cx.listener(
                |this, _: &gpui::DragMoveEvent<gpui_kit::component::dock::DragPanel>, _, cx| {
                    if !this.panel_dragging {
                        this.panel_dragging = true;
                        lattice_webview::set_dock_dragging(true, cx);
                    }
                },
            ))
            // The drag ends wherever the button comes up: over the
            // workspace, or over the titlebar, a floating card or outside the
            // window, where the workspace is not hovered.
            .capture_any_mouse_up(
                cx.listener(|this, _, window, cx| this.end_panel_drag(window, cx)),
            )
            .on_mouse_up_out(
                gpui::MouseButton::Left,
                cx.listener(|this, _, window, cx| this.end_panel_drag(window, cx)),
            )
            .child(self.dock_area.clone())
            .when(
                self.center_empty(cx) && !self.dock_area.read(cx).is_zoomed(),
                |this| this.child(arrange::empty_center(self, cx)),
            )
            // Deferred, so a docked webview island does not cover a panel
            // floating over it (gpui-fast puts native views under the
            // overlay surface). An island floating in one is hosted on the
            // overlay surface in turn, above the card it floats in.
            .children(
                self.floating
                    .render(self.floating_area(window), cx)
                    .into_iter()
                    .map(|card| deferred(card).with_priority(super::layers::FLOATING_PRIORITY)),
            )
    }

    fn end_panel_drag(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel_dragging {
            self.panel_dragging = false;
            window.defer(cx, |_, cx| lattice_webview::set_dock_dragging(false, cx));
        }
    }
}
