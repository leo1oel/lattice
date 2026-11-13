//! The ground under the titlebar: the chrome the Trellis workspace's cards
//! stand on, 12px from the window's sides and bottom.

use gpui::{Context, ParentElement as _, Styled as _, div, px};
use lattice_ui::ActiveLattice as _;

use super::{Shell, WORKSPACE_SIDE};

impl Shell {
    /// The cards under the titlebar, on the chrome.
    pub(super) fn ground(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let palette = cx.palette().clone();
        div()
            .relative()
            .flex_1()
            .min_h_0()
            // The chrome, or its translucent shell over the vibrancy.
            .bg(palette.shell)
            .px(px(WORKSPACE_SIDE))
            .pb(px(WORKSPACE_SIDE))
            .children(lattice_ui::parity::probe("workspace"))
            .child(self.workspace.clone())
    }
}
