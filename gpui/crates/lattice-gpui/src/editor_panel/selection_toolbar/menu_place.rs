//! Where the selection toolbar's menus stand (`selection_toolbar.rs`): as
//! the Tauri app's popovers (`side="top"`, `sideOffset={8}`,
//! `align="center"`, portaled), 8px over the button that opened one and
//! centred on it, drawn over the whole window rather than inside the
//! source view, so the frame above the editor (its tabs, the panel's edge)
//! never clips a tall one such as the highlighter palette over a selection
//! near the top; and under the button when the window has no room above,
//! as Radix flips one.

use gpui::{anchored, deferred};

use super::*;

impl EditorPanel {
    /// `trigger`, recording where it was drawn as `menu`'s, so the menu is
    /// centred on it from the frame it opens in; a trigger that moved under
    /// its open menu places the menu anew.
    pub(super) fn menu_trigger(
        &self,
        menu: Menu,
        trigger: impl IntoElement,
        cx: &Context<Self>,
    ) -> AnyElement {
        let triggers = self.toolbar.triggers.clone();
        let open = self.toolbar.menu == Some(menu);
        let panel = cx.entity_id();
        div()
            .relative()
            .child(trigger)
            .child(
                canvas(
                    move |bounds, window, _| {
                        let mut triggers = triggers.borrow_mut();
                        let moved = match triggers.iter_mut().find(|(at, _)| *at == menu) {
                            Some((_, drawn)) => std::mem::replace(drawn, bounds) != bounds,
                            None => {
                                triggers.push((menu, bounds));
                                true
                            }
                        };
                        if open && moved {
                            window.on_next_frame(move |_, cx| cx.notify(panel));
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .into_any_element()
    }

    /// Where `menu`'s trigger was last drawn.
    pub(super) fn menu_trigger_bounds(&self, menu: Menu) -> Option<Bounds<Pixels>> {
        self.toolbar
            .triggers
            .borrow()
            .iter()
            .find(|(at, _)| *at == menu)
            .map(|(_, bounds)| *bounds)
    }

    /// The open `menu` over the toolbar drawn at `toolbar`, in a window
    /// `viewport` big, recording where it was drawn in `areas`. Before its
    /// trigger has been drawn, it is centred on the toolbar.
    pub(super) fn menu_layer(
        &self,
        menu: AnyElement,
        toolbar: Bounds<Pixels>,
        viewport: gpui::Size<Pixels>,
        areas: Rc<std::cell::RefCell<Vec<Bounds<Pixels>>>>,
        cx: &Context<Self>,
    ) -> AnyElement {
        let trigger = self
            .toolbar
            .menu
            .and_then(|menu| self.menu_trigger_bounds(menu))
            .unwrap_or(toolbar);
        // Centred by layout, in a box as wide as its trigger that it
        // overflows evenly on both sides, so a menu that grows (the
        // palette's custom colour view) stays centred in the same frame;
        // its size as last drawn only keeps it inside the window, as Radix
        // shifts one along its edge.
        let shift = self.toolbar.menu_size.get().map_or(px(0.), |size| {
            let left = trigger.center().x - size.width / 2.;
            if left < px(0.) {
                -left
            } else if left + size.width > viewport.width {
                viewport.width - (left + size.width)
            } else {
                px(0.)
            }
        });
        let size = self.toolbar.menu_size.clone();
        let panel = cx.entity_id();
        deferred(
            anchored()
                .attach(trigger, gpui::Anchor::TopLeft)
                .anchor(gpui::Anchor::BottomLeft)
                .offset(gpui::point(shift, -px(GAP)))
                .child(
                    div().w(trigger.size.width).flex().justify_center().child(
                        div().flex_none().relative().child(menu).child(
                            canvas(
                                move |bounds, window, _| {
                                    areas.borrow_mut().push(bounds);
                                    if size.replace(Some(bounds.size)) != Some(bounds.size) {
                                        window.on_next_frame(move |_, cx| cx.notify(panel));
                                    }
                                },
                                |_, _, _, _| {},
                            )
                            .absolute()
                            .top_0()
                            .left_0()
                            .size_full(),
                        ),
                    ),
                ),
        )
        // On the popups' layer, as the app's menus are, over a hover card
        // (the Build button's) that may still stand where it opens.
        .with_priority(gpui_kit::base::POPUP_PRIORITY)
        .into_any_element()
    }
}
