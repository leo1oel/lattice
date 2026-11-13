//! Papers and the Agent hold their places in the dock before their content
//! is ported: each is a real panel with its tab, card and strip where the
//! Tauri app puts it (Papers under Project, the Agent beside it), and a body
//! that says plainly it is not in the GPUI preview yet.

use gpui::{
    App, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Window, div, px,
};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, icons::ICON};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StandIn {
    Papers,
    Agent,
}

impl StandIn {
    pub fn name(self) -> &'static str {
        match self {
            StandIn::Papers => t!("Papers"),
            StandIn::Agent => t!("Agent"),
        }
    }

    pub fn icon(self) -> Icon {
        match self {
            StandIn::Papers => Icon::LIBRARY,
            StandIn::Agent => Icon::BOT,
        }
    }

    fn note(self) -> &'static str {
        match self {
            StandIn::Papers => t!("The papers library is not in the GPUI preview yet."),
            StandIn::Agent => t!("The Agent is not in the GPUI preview yet."),
        }
    }
}

pub struct StandInPanel {
    kind: StandIn,
    focus_handle: FocusHandle,
}

impl StandInPanel {
    pub fn new(kind: StandIn, cx: &mut Context<Self>) -> Self {
        Self {
            kind,
            focus_handle: cx.focus_handle(),
        }
    }

    pub fn kind(&self) -> StandIn {
        self.kind
    }
}

impl EventEmitter<PanelEvent> for StandInPanel {}

impl Focusable for StandInPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for StandInPanel {
    fn panel_name(&self) -> &'static str {
        match self.kind {
            StandIn::Papers => "PapersPanel",
            StandIn::Agent => "AgentPanel",
        }
    }
}

impl Panel for StandInPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(self.kind.name().into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.kind.name()
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for StandInPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        div()
            .id(self.panel_name())
            .track_focus(&self.focus_handle)
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .px(px(24.))
            .child(self.kind.icon().element(ICON, palette.text_secondary))
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .text_center()
                    .child(self.kind.note()),
            )
    }
}
