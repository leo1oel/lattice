//! The ground under the titlebar: the chrome the dock's cards stand on, 12px
//! from the window's sides and bottom and 6px under the titlebar, with the
//! empty center's hint and the floating panels over it.

use gpui::{
    Context, ParentElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
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
            .bg(palette.chrome)
            .pt(px(WORKSPACE_TOP))
            .px(px(WORKSPACE_SIDE))
            .pb(px(WORKSPACE_SIDE))
            .children(lattice_ui::parity::probe("workspace"))
            .child(self.dock_area.clone())
            .when(
                self.center_empty(cx) && !self.dock_area.read(cx).is_zoomed(),
                |this| this.child(arrange::empty_center(self, cx)),
            )
            .children(self.floating.render(self.floating_area(window), cx))
    }
}
