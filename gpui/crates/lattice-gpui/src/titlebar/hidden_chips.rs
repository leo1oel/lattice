//! The hidden panels' chips (`trellis-titlebar.tsx`, `.trellis-hidden-chip`):
//! one per panel put away with Hide, right of the search field, each
//! bringing its panel back where it was. In a preset or focus mode, the
//! panels it parked come back with the writer's own layout (or their
//! toggles), so only hidden documents get a chip there.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, px,
};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, components::LatticeTooltip};

use crate::shell::Shell;

/// A chip at its widest; past it, its title ends in an ellipsis.
const CHIP_MAX: f32 = 140.;

pub(super) fn hidden_chips(shell: &Shell, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let hidden = shell.hidden_panels(cx);
    if hidden.is_empty() {
        return None;
    }
    let palette = cx.palette().clone();
    let chips = hidden.into_iter().enumerate().map(|(ix, (panel, title))| {
        let tooltip: gpui::SharedString = format!("Restore {title}").into();
        div()
            .id(("hidden-chip", ix))
            .flex()
            .flex_initial()
            .min_w_0()
            .max_w(px(CHIP_MAX))
            .h(px(28.))
            .items_center()
            .px(px(8.))
            .rounded(px(6.))
            .border_1()
            .border_dashed()
            .border_color(palette.line_strong)
            .text_role(TextRole::BodyCompact, cx)
            .text_color(palette.text_secondary)
            .hover(|chip| chip.bg(palette.chrome_hover).text_color(palette.text))
            .cursor_pointer()
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child(title),
            )
            .tooltip(move |_, cx| LatticeTooltip::view(tooltip.clone(), None, cx))
            .on_click(cx.listener(move |shell, _, _, cx| shell.restore_panel(&panel, cx)))
    });
    Some(
        div()
            .flex()
            .flex_initial()
            .min_w_0()
            .items_center()
            .gap(px(4.))
            .overflow_hidden()
            .children(chips)
            .into_any_element(),
    )
}
