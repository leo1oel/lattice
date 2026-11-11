//! Surfaces that hold other things: Settings cards and rows, a panel's
//! header, and the empty, loading and error states.
//!
//! - A Settings card stands on the lift with the ring and the raised shadow,
//!   10px corners; its rows are at least 52px, the label in Settings' body
//!   (14/22) over a caption, the one control in a 170px column at the right,
//!   rows divided by the hairline.
//! - A panel or drawer header closes with an icon-only X, never a word.
//! - An empty region says what would be there and offers the next step; a
//!   load shows one indicator, and none for the first 150 ms; an error names
//!   what failed and offers the way out.

use std::time::Duration;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};

use crate::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::IconButton,
    icons::{ICON, ICON_LARGE},
    interaction::fade,
    motion::Motion,
    tokens::{CONTAINER_SETTINGS_CONTROL, FONT_WEIGHT_MEDIUM},
};

#[derive(IntoElement, Default)]
pub struct SettingsCard {
    rows: Vec<AnyElement>,
}

impl SettingsCard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn row(mut self, row: impl IntoElement) -> Self {
        self.rows.push(row.into_any_element());
        self
    }
}

impl RenderOnce for SettingsCard {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let count = self.rows.len();
        div()
            .flex()
            .flex_col()
            .rounded(px(10.))
            .bg(palette.raised)
            .shadow(Elevation::Raised.shadows(&palette))
            .children(self.rows.into_iter().enumerate().map(|(ix, row)| {
                div()
                    .when(ix + 1 < count, |this| {
                        this.border_b_1().border_color(palette.line)
                    })
                    .child(row)
            }))
    }
}

#[derive(IntoElement)]
pub struct SettingsRow {
    label: SharedString,
    description: Option<SharedString>,
    control: Option<AnyElement>,
}

impl SettingsRow {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            description: None,
            control: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn control(mut self, control: impl IntoElement) -> Self {
        self.control = Some(control.into_any_element());
        self
    }
}

impl RenderOnce for SettingsRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        div()
            .flex()
            .items_center()
            .gap(px(16.))
            .min_h(px(52.))
            .px(px(16.))
            .py(px(10.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_role_in(TextRole::Body, TypeScale::Settings, cx)
                            .text_color(palette.text)
                            .child(self.label),
                    )
                    .children(self.description.map(|description| {
                        div()
                            .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                            .text_color(palette.text_secondary)
                            .child(description)
                    })),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .justify_end()
                    .w(CONTAINER_SETTINGS_CONTROL)
                    .children(self.control),
            )
    }
}

/// A panel or drawer header: its title and the X that closes it.
#[derive(IntoElement)]
pub struct PanelHeader {
    id: ElementId,
    title: SharedString,
    on_close: Option<Box<dyn Fn(&gpui::ClickEvent, &mut Window, &mut App)>>,
}

impl PanelHeader {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            on_close: None,
        }
    }

    pub fn on_close(
        mut self,
        handler: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_close = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for PanelHeader {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        div()
            .flex()
            .items_center()
            .h(px(40.))
            .pl(px(14.))
            .pr(px(8.))
            .gap(px(8.))
            .border_b_1()
            .border_color(palette.line)
            .child(
                div()
                    .flex_1()
                    .text_role(TextRole::Subtitle, cx)
                    .text_color(palette.text)
                    .child(self.title),
            )
            .when_some(self.on_close, |this, on_close| {
                this.child(
                    IconButton::new(self.id, Icon::CLOSE)
                        .frame(px(24.), px(24.))
                        .tooltip("Close")
                        .on_click(on_close),
                )
            })
    }
}

/// What a region would hold, and the next step.
#[derive(IntoElement)]
pub struct EmptyState {
    title: SharedString,
    action: Option<AnyElement>,
}

impl EmptyState {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            action: None,
        }
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }
}

impl RenderOnce for EmptyState {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(12.))
            .p(px(24.))
            .child(
                div()
                    .text_role(TextRole::BodyCompact, cx)
                    .font_weight(crate::tokens::FONT_WEIGHT_SEMIBOLD)
                    .text_color(palette.text)
                    .child(self.title),
            )
            .children(self.action)
    }
}

/// A load in progress: nothing for the first 150 ms, then one indicator,
/// faded in on the fast tier.
#[derive(IntoElement)]
pub struct LoadingState {
    id: ElementId,
    label: SharedString,
    started: std::time::Instant,
}

/// Every loading indicator waits this long, so a quick load shows none.
pub const LOADING_REVEAL: Duration = Duration::from_millis(150);

impl LoadingState {
    /// `started` is when the load began; the indicator appears 150 ms after.
    pub fn new(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        started: std::time::Instant,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            started,
        }
    }
}

impl RenderOnce for LoadingState {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let shown = self.started.elapsed() >= LOADING_REVEAL;
        if !shown {
            window.request_animation_frame();
        }
        let opacity = fade(self.id, shown, Motion::Fast, window, cx);
        let palette = cx.palette();
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .p(px(24.))
            .opacity(opacity)
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(Icon::LOADER.element(ICON, palette.text_secondary))
            .child(self.label)
    }
}

/// What failed, and the way out.
#[derive(IntoElement)]
pub struct ErrorState {
    title: SharedString,
    detail: Option<SharedString>,
    action: Option<AnyElement>,
}

impl ErrorState {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            detail: None,
            action: None,
        }
    }

    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }
}

impl RenderOnce for ErrorState {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        div()
            .flex()
            .items_start()
            .gap(px(8.))
            .p(px(16.))
            .child(Icon::CIRCLE_ALERT.element(ICON_LARGE, palette.danger))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_role(TextRole::Body, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text)
                            .child(self.title),
                    )
                    .children(self.detail.map(|detail| {
                        div()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(detail)
                    }))
                    .children(self.action),
            )
    }
}
