//! What floats: tooltips, toasts and dialogs, and the pop-in they arrive on.
//!
//! Everything that floats stands on the lift and takes one elevation level,
//! with the ring as its only edge (Paper's Overlays board):
//!
//! - a tooltip is popover level, its shortcut quiet text beside the label,
//!   never typed into it;
//! - a toast is `toast.rs`'s card;
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

use std::time::Duration;

use gpui::{
    AnimationExt as _, AnyElement, AnyView, App, AppContext as _, ElementId, Hsla,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, RenderOnce, SharedString,
    Styled as _, Window, div, point, prelude::FluentBuilder as _, px, scaled,
};

use crate::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    icons::ICON_LARGE,
    motion::{Entrance, Exit},
    tokens::CONTAINER_DIALOG,
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

/// A Kit popover's content, entering on the pop tier while open and
/// playing its exit while it leaves (`popup-motion.css`): give the popover
/// [`popup_exit`] with `.exit(..)` and pass its state here.
pub fn popup_motion(
    state: &gpui_kit::base::PopoverState,
    id: impl Into<ElementId>,
    from: PopFrom,
    content: impl IntoElement,
) -> AnyElement {
    match state.leaving() {
        Some(elapsed) => pop_out(from, elapsed, content),
        None => pop_in(id, from, content),
    }
}

/// How long a popover is drawn after it closes, for [`popup_motion`].
pub fn popup_exit() -> std::time::Duration {
    Exit::POPUP.duration()
}

/// Wrap a hand-built tooltip's card so it enters as [`LatticeTooltip`]
/// does ([`Entrance::TOOLTIP`]): for a tooltip that holds more than one
/// line, such as a status pill's explanation.
pub fn tip_in(id: impl Into<ElementId>, from: PopFrom, content: impl IntoElement) -> AnyElement {
    enter(id.into(), Entrance::TOOLTIP, from, content)
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

thread_local! {
    // Exit frames drawn, popups' and dialogs': main thread only.
    static EXIT_FRAMES: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}

/// How many exit frames have been drawn, popups' ([`pop_out`]) and
/// dialogs' ([`sink_out`]): the e2e scenario reads it to see an exit play.
pub fn exit_frames() -> (usize, usize) {
    EXIT_FRAMES.with(std::cell::Cell::get)
}

/// A popup on its way out, `elapsed` into its exit ([`Exit::POPUP`]): back
/// toward 95% about the edge that faces its trigger and 6px toward it as it
/// fades, on the pop tier's exit, a plain ease-out a tier quicker than it
/// came. Its owner keeps drawing it, without input, until
/// [`Exit::is_done`], and asks for frames meanwhile.
pub fn pop_out(from: PopFrom, elapsed: Duration, content: impl IntoElement) -> AnyElement {
    EXIT_FRAMES.with(|frames| frames.set((frames.get().0 + 1, frames.get().1)));
    let exit = Exit::POPUP;
    let (direction, edge) = match from {
        PopFrom::Above => (-1., 0.),
        PopFrom::Below => (1., 1.),
    };
    let (movement, opacity) = exit.sample(elapsed);
    scaled(
        div()
            .relative()
            .top(px(direction * movement * exit.travel))
            .opacity(opacity)
            .child(content)
            .child(input_cover()),
    )
    .origin(point(0.5, edge))
    .scale(exit.scale(movement))
    .into_any_element()
}

/// A dialog or sheet on its way out, `elapsed` into its exit
/// ([`Exit::DIALOG`], `modal-sink`): it sinks `--space-2` to 98% and fades
/// on the slow tier's exit.
pub fn sink_out(elapsed: Duration, content: impl IntoElement) -> AnyElement {
    EXIT_FRAMES.with(|frames| frames.set((frames.get().0, frames.get().1 + 1)));
    let exit = Exit::DIALOG;
    let (movement, opacity) = exit.sample(elapsed);
    scaled(
        div()
            .relative()
            .top(px(movement * exit.travel))
            .opacity(opacity)
            .child(content)
            .child(input_cover()),
    )
    .scale(exit.scale(movement))
    .into_any_element()
}

/// Laid over a surface on its way out, so the picture takes no press or
/// hover (`pointer-events: none` on `[data-leaving]`), nor does what is
/// under it until it has gone.
fn input_cover() -> impl IntoElement {
    div().absolute().inset_0().occlude()
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
