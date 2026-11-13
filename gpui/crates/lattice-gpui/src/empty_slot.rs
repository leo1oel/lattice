//! A document panel's empty place (`slot` views, the Tauri app's
//! `SlotView`): a workspace's arrangement keeps one in each panel that held
//! documents, so opening or closing documents never changes the
//! arrangement. Its tab reads "Empty" and its body says where documents
//! come from.

use gpui::{
    App, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Window, div,
};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _};

pub struct EmptySlotPanel {
    focus_handle: FocusHandle,
}

impl EmptySlotPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
        }
    }
}

impl EventEmitter<PanelEvent> for EmptySlotPanel {}

impl Focusable for EmptySlotPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for EmptySlotPanel {
    fn panel_name(&self) -> &'static str {
        "EmptySlot"
    }
}

impl Panel for EmptySlotPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some("Empty".into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        "Empty"
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for EmptySlotPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        div()
            .id("empty-slot")
            .track_focus(&self.focus_handle)
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .px_6()
            .text_role(TextRole::Body, cx)
            .text_color(palette.text_secondary)
            .text_center()
            .child(lattice_i18n::t!(
                "Open a file from Project to start writing"
            ))
    }
}
