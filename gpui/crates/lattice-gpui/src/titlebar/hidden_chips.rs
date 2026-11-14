//! The hidden panels' chips (`trellis-titlebar.tsx`, `.trellis-hidden-chip`):
//! one per panel put away with Hide, right of the search field, each
//! bringing its panel back where it was. In a preset or focus mode, the
//! panels it parked come back with the writer's own layout (or their
//! toggles), so only hidden documents get a chip there.
//!
//! Short of room the chips shrink, each to an ellipsis, rather than clip
//! (`.trellis-hidden-chip`: `flex: 0 1 auto`, `min-width: 0`), after the
//! titlebar has folded everything else it can.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, px,
};
use lattice_i18n::{space_mixed_script, t};
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _, components::LatticeTooltip,
    typography::shaped_width,
};

use crate::shell::Shell;

/// A chip at its widest; past it, its title ends in an ellipsis.
const CHIP_MAX: f32 = 140.;
/// A chip's side padding and its dashed border, and the gap between chips.
const CHIP_CHROME: f32 = 8. * 2. + 1. * 2.;
const CHIP_GAP: f32 = 4.;

/// How wide the chips draw with room for each: every chip at its title's
/// width, up to its cap. Zero with no panel hidden.
pub(super) fn natural_width(shell: &Shell, window: &gpui::Window, cx: &gpui::App) -> f32 {
    let titles: Vec<f32> = shell
        .hidden_panels(cx)
        .iter()
        .map(|(_, title)| f32::from(shaped_width(title, TextRole::BodyCompact, None, window, cx)))
        .collect();
    row_width(&titles)
}

fn row_width(titles: &[f32]) -> f32 {
    let chips: f32 = titles
        .iter()
        .map(|title| (title + CHIP_CHROME).min(CHIP_MAX))
        .sum();
    chips + CHIP_GAP * titles.len().saturating_sub(1) as f32
}

pub(super) fn hidden_chips(shell: &Shell, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let hidden = shell.hidden_panels(cx);
    if hidden.is_empty() {
        return None;
    }
    let palette = cx.palette().clone();
    let chips = hidden.into_iter().enumerate().map(|(ix, (panel, title))| {
        let tooltip: gpui::SharedString = space_mixed_script(&t!("Restore {0}", title)).into();
        div()
            .id(("hidden-chip", ix))
            .relative()
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
            .children(lattice_ui::parity::probe(format!("titlebar/chip/{ix}")))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chip_counts_its_title_up_to_its_cap() {
        assert_eq!(row_width(&[]), 0.);
        assert_eq!(row_width(&[40.]), 58.);
        assert_eq!(row_width(&[40., 300.]), 58. + 4. + 140.);
    }
}
