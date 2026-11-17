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
    /// `trigger`, recording where it was drawn while `menu` is the open one,
    /// so the menu is centred on it; a trigger that moved places it anew.
    pub(super) fn menu_trigger(
        &self,
        menu: Menu,
        trigger: impl IntoElement,
        cx: &Context<Self>,
    ) -> AnyElement {
        if self.toolbar.menu != Some(menu) {
            return trigger.into_any_element();
        }
        let cell = self.toolbar.trigger.clone();
        let panel = cx.entity_id();
        div()
            .relative()
            .child(trigger)
            .child(
                canvas(
                    move |bounds, window, _| {
                        if cell.replace(Some(bounds)) != Some(bounds) {
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

    /// The open `menu` over the toolbar drawn at `toolbar`, recording where
    /// it was drawn in `areas`. Until its trigger and the menu itself have
    /// been drawn once, it stands at the toolbar's left.
    pub(super) fn menu_layer(
        &self,
        menu: AnyElement,
        toolbar: Bounds<Pixels>,
        areas: Rc<std::cell::RefCell<Vec<Bounds<Pixels>>>>,
        cx: &Context<Self>,
    ) -> AnyElement {
        let trigger = self.toolbar.trigger.get().unwrap_or(toolbar);
        let shift = self
            .toolbar
            .menu_size
            .get()
            .map_or(px(0.), |size| (trigger.size.width - size.width) / 2.);
        let size = self.toolbar.menu_size.clone();
        let panel = cx.entity_id();
        deferred(
            anchored()
                .attach(trigger, gpui::Anchor::TopLeft)
                .anchor(gpui::Anchor::BottomLeft)
                .offset(gpui::point(shift, -px(GAP)))
                .child(
                    div().relative().child(menu).child(
                        canvas(
                            move |bounds, window, _| {
                                areas.borrow_mut().push(bounds);
                                // A new size (the palette's custom colour
                                // view) centres it anew.
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
        )
        .with_priority(1)
        .into_any_element()
    }
}
