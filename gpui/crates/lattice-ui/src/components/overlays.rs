//! What floats: tooltips, toasts and dialogs, and the pop-in they arrive on.
//!
//! Everything that floats stands on the lift and takes one elevation level,
//! with the ring as its only edge (Paper's Overlays board):
//!
//! - a tooltip is popover level, its shortcut quiet text beside the label,
//!   never typed into it;
//! - a toast is 320 wide at the floating level: a 16px level icon (the only
//!   thing severity colours), a 13/18 medium title, caption detail, the first
//!   action compact tinted and the rest compact secondary, and an X;
//! - a dialog is 390 wide with 14px corners at the dialog level: 20px in,
//!   16 at the foot, a serif title, one line of copy, fields 12px apart,
//!   actions 24px below. A 36px mark only when it asks something risky.
//!
//! Each arrives as the app's CSS has it (`motion::Entrance`): popups spring
//! out of their trigger's side on the pop tier, from 95% and 6px away, most
//! of the way within a few frames; a tooltip grows from 98% on the fast tier;
//! a dialog rises 6px from 98% on the slow tier; a toast drops in its own
//! height from 96%. The scale is a paint transform (`gpui::scaled`), so
//! layout and the pointer see the surface at rest throughout.

use gpui::{
    AnimationExt as _, AnyElement, AnyView, App, AppContext as _, ElementId, Hsla, IntoElement,
    ParentElement as _, Render, RenderOnce, SharedString, Styled as _, Window, div, point,
    prelude::FluentBuilder as _, px, scaled,
};

use crate::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::IconButton,
    icons::ICON_LARGE,
    motion::Entrance,
    tokens::{CONTAINER_DIALOG, CONTAINER_TOAST, FONT_WEIGHT_MEDIUM},
};

/// Where a popup comes from, relative to its trigger.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum PopFrom {
    /// Below the trigger: it travels down into place.
    #[default]
    Above,
    /// Above the trigger: it travels up.
    Below,
}

/// Wrap a popup's content so it enters on the pop tier
/// ([`Entrance::POPUP`]): it fades in, grows from 95% about the edge that
/// faces its trigger and travels the last 6px from that side. Keyed by `id`,
/// so it plays once, when the popup first appears.
pub fn pop_in(id: impl Into<ElementId>, from: PopFrom, content: impl IntoElement) -> AnyElement {
    enter(id.into(), Entrance::POPUP, from, content)
}

/// An entrance from a trigger's side: `from` says which edge stays put.
fn enter(
    id: ElementId,
    entrance: Entrance,
    from: PopFrom,
    content: impl IntoElement,
) -> AnyElement {
    let (direction, edge) = match from {
        PopFrom::Above => (-1., 0.),
        PopFrom::Below => (1., 1.),
    };
    scaled(div().relative().child(content))
        .origin(point(0.5, edge))
        .with_animation(id, entrance.animation(), move |this, t| {
            let (movement, fade) = entrance.sample_at(t);
            this.scale(entrance.scale(movement)).map_child(|child| {
                child
                    .top(px(direction * (1. - movement) * entrance.travel))
                    .opacity(fade)
            })
        })
        .into_any_element()
}

/// Wrap a dialog or sheet so it enters on the slow tier
/// ([`Entrance::DIALOG`]): it fades in, grows from 98% about its centre and
/// rises the last 6px.
pub fn rise_in(id: impl Into<ElementId>, content: impl IntoElement) -> AnyElement {
    let entrance = Entrance::DIALOG;
    scaled(div().relative().child(content))
        .with_animation(id, entrance.animation(), move |this, t| {
            let (movement, fade) = entrance.sample_at(t);
            this.scale(entrance.scale(movement)).map_child(|child| {
                child
                    .top(px((1. - movement) * entrance.travel))
                    .opacity(fade)
            })
        })
        .into_any_element()
}

/// Wrap a toast so it enters as the app's toast stack has it
/// ([`Entrance::TOAST`]): from a stack at the top (`PopFrom::Above`) it drops
/// in its own height from 96% about its lower edge, from one at the bottom it
/// rises, moving on the slow tier and fading on the moderate.
pub fn toast_in(id: impl Into<ElementId>, from: PopFrom, content: impl IntoElement) -> AnyElement {
    let entrance = Entrance::TOAST;
    let (direction, edge) = match from {
        PopFrom::Above => (-1., 1.),
        PopFrom::Below => (1., 0.),
    };
    scaled(div().child(content))
        .origin(point(0.5, edge))
        .with_animation(id, entrance.animation(), move |this, t| {
            let (movement, fade) = entrance.sample_at(t);
            this.scale(entrance.scale(movement))
                .translate(point(0., direction * (1. - movement)))
                .map_child(|child| child.opacity(fade))
        })
        .into_any_element()
}

/// A tooltip in Lattice's look: a label and, quietly, its shortcut.
pub struct LatticeTooltip {
    label: SharedString,
    shortcut: Option<SharedString>,
}

impl LatticeTooltip {
    pub fn view(
        label: impl Into<SharedString>,
        shortcut: Option<SharedString>,
        cx: &mut App,
    ) -> AnyView {
        cx.new(|_| Self {
            label: label.into(),
            shortcut,
        })
        .into()
    }
}

impl Render for LatticeTooltip {
    fn render(&mut self, _: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let card = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .h(px(24.))
            .px(px(8.))
            .rounded(px(6.))
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .whitespace_nowrap()
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text)
            .child(self.label.clone())
            .when_some(self.shortcut.clone(), |this, keys| {
                this.child(div().text_color(palette.text_secondary).child(keys))
            });
        enter(
            ("lattice-tooltip", cx.entity_id()).into(),
            Entrance::TOOLTIP,
            PopFrom::Above,
            card,
        )
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ToastLevel {
    #[default]
    Info,
    Success,
    Warning,
    Error,
}

impl ToastLevel {
    fn mark(self, palette: &crate::Palette) -> (Icon, Hsla) {
        match self {
            ToastLevel::Info => (Icon::INFO, palette.info),
            ToastLevel::Success => (Icon::CIRCLE_CHECK, palette.success),
            ToastLevel::Warning => (Icon::TRIANGLE_ALERT, palette.warning),
            ToastLevel::Error => (Icon::CIRCLE_ALERT, palette.danger),
        }
    }
}

#[derive(IntoElement)]
pub struct Toast {
    id: ElementId,
    level: ToastLevel,
    title: SharedString,
    detail: Option<SharedString>,
    actions: Vec<AnyElement>,
    on_dismiss: Option<Box<dyn Fn(&gpui::ClickEvent, &mut Window, &mut App)>>,
}

impl Toast {
    pub fn new(
        id: impl Into<ElementId>,
        level: ToastLevel,
        title: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            level,
            title: title.into(),
            detail: None,
            actions: Vec::new(),
            on_dismiss: None,
        }
    }

    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// The first action is the compact tinted lead, the rest compact
    /// secondary; pass the Buttons already sized.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }

    pub fn on_dismiss(
        mut self,
        handler: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_dismiss = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for Toast {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (icon, hue) = self.level.mark(&palette);
        let has_actions = !self.actions.is_empty();
        div()
            .w(CONTAINER_TOAST)
            .flex()
            .items_start()
            .gap(px(8.))
            .pl(px(12.))
            .pr(px(8.))
            .py(px(10.))
            .rounded(px(10.))
            .bg(palette.raised)
            .shadow(Elevation::Floating.shadows(&palette))
            .child(div().pt(px(1.)).child(icon.element(ICON_LARGE, hue)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_role(TextRole::Subtitle, cx)
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
                    .when(has_actions, |this| {
                        this.child(div().flex().gap(px(6.)).pt(px(8.)).children(self.actions))
                    }),
            )
            .when_some(self.on_dismiss, |this, on_dismiss| {
                this.child(
                    IconButton::new(self.id, Icon::CLOSE)
                        .frame(px(24.), px(24.))
                        .tooltip("Dismiss")
                        .on_click(on_dismiss),
                )
            })
    }
}

#[derive(IntoElement)]
pub struct DialogCard {
    title: SharedString,
    body: Option<SharedString>,
    mark: Option<(Icon, Hsla, Hsla)>,
    fields: Vec<AnyElement>,
    actions: Vec<AnyElement>,
}

impl DialogCard {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            body: None,
            mark: None,
            fields: Vec::new(),
            actions: Vec::new(),
        }
    }

    pub fn body(mut self, body: impl Into<SharedString>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// The 36px mark a risky question carries: its icon, ink and wash.
    pub fn mark(mut self, icon: Icon, ink: Hsla, wash: Hsla) -> Self {
        self.mark = Some((icon, ink, wash));
        self
    }

    pub fn field(mut self, field: impl IntoElement) -> Self {
        self.fields.push(field.into_any_element());
        self
    }

    /// Actions, left to right; Cancel first, the answer last.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }
}

impl RenderOnce for DialogCard {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let id = ElementId::NamedChild(
            std::sync::Arc::new(ElementId::Name("dialog-card".into())),
            self.title.clone(),
        );
        let card = div()
            .w(CONTAINER_DIALOG)
            .flex()
            .flex_col()
            .pt(px(20.))
            .px(px(20.))
            .pb(px(16.))
            .rounded(px(14.))
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .when_some(self.mark, |this, (icon, ink, wash)| {
                this.child(
                    div()
                        .size(px(36.))
                        .mb(px(16.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(10.))
                        .bg(wash)
                        .child(icon.element(ICON_LARGE, ink)),
                )
            })
            .child(
                div()
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child(self.title),
            )
            .children(self.body.map(|body| {
                div()
                    .pt(px(4.))
                    .text_role(TextRole::Body, cx)
                    .text_color(palette.text_secondary)
                    .child(body)
            }))
            .when(!self.fields.is_empty(), |this| {
                this.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .pt(px(16.))
                        .children(self.fields),
                )
            })
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .pt(px(24.))
                    .children(self.actions),
            );
        rise_in(id, card)
    }
}
