//! GPUI Kit's popup menus with the fluid hover.

use std::time::{Duration, Instant};

use gpui::{App, Bounds, Corners, Hsla, Pixels, Window, fill};

use super::{FluidHoverState, ItemKind};

/// GPUI Kit's popup menus (the context menus, a dock's ⋯ menu) with the
/// fluid hover: Kit keeps its own highlighted item, moved by the pointer and
/// the keys alike, and this draws it as the one gliding fill behind the rows,
/// the same engine as [`FluidHover`] (installed by `kit::apply` through
/// Kit's `GlobalMenuHighlight`, a Lattice diff in `patches/`).
#[derive(Default)]
pub struct KitMenuGlide {
    menus:
        std::cell::RefCell<std::collections::HashMap<gpui::EntityId, (FluidHoverState, Instant)>>,
}

/// How long a menu's glide is kept once it stops drawing.
const KIT_MENU_KEPT: Duration = Duration::from_secs(5);

impl gpui_kit::component::menu::MenuHighlight for KitMenuGlide {
    fn paint(
        &self,
        menu: gpui::EntityId,
        rows: &[gpui_kit::component::menu::MenuHighlightRow],
        selected: Option<usize>,
        bounds: Bounds<Pixels>,
        fill_colour: Hsla,
        radius: Pixels,
        window: &mut Window,
        cx: &mut App,
    ) {
        let now = Instant::now();
        let mut menus = self.menus.borrow_mut();
        menus.retain(|_, (_, seen)| now.saturating_duration_since(*seen) < KIT_MENU_KEPT);
        let (state, seen) = menus
            .entry(menu)
            .or_insert_with(|| (FluidHoverState::default(), now));
        *seen = now;
        state.frame = state.frame.wrapping_add(1);
        for row in rows {
            let kind = if row.enabled {
                ItemKind::target()
            } else {
                ItemKind::skip()
            };
            state.record(row.index, row.bounds, kind.section(row.section));
        }
        state.wanted = selected;
        let running = state.reconcile(now, cx.reduce_motion());
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            for (rect, opacity) in state.fills(now) {
                let mut colour = fill_colour;
                colour.a *= opacity.clamp(0., 1.);
                window.paint_quad(fill(rect, colour).corner_radii(Corners::all(radius)));
            }
        });
        if running {
            window.request_animation_frame();
        }
    }
}
