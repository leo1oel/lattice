//! A card that opens under its trigger, aligned to the trigger's end, after
//! the pointer rests on it, as the Tauri app's `HoverCard` around the Build
//! button (open after 280 ms, close 120 ms after the pointer leaves both).
//! A press on the trigger shuts it, and it stays shut until the pointer
//! leaves: pressing Build is for building, and a card over the editor on
//! every press would be in the way.

use std::{rc::Rc, time::Duration};

use gpui::{
    Anchor, AnyElement, App, Bounds, Context, ElementId, Entity, InteractiveElement as _,
    IntoElement, MouseButton, ParentElement as _, Pixels, RenderOnce,
    StatefulInteractiveElement as _, Styled as _, Task, Window, anchored, canvas, deferred, div,
    point, px,
};
use lattice_ui::components::{PopFrom, pop_in};

const OPEN_DELAY: Duration = Duration::from_millis(280);
const CLOSE_DELAY: Duration = Duration::from_millis(120);
/// The gap between the trigger and the card.
const OFFSET: Pixels = px(6.);

type Content = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

#[derive(Default)]
struct HoverCardState {
    open: bool,
    /// Pressed since the pointer came: stays shut until it leaves.
    pressed: bool,
    over_trigger: bool,
    over_card: bool,
    /// The trigger's box in the window, as of its last frame.
    bounds: Option<Bounds<Pixels>>,
    timer: Option<Task<()>>,
}

impl HoverCardState {
    fn settle(&mut self, cx: &mut Context<Self>) {
        let want = (self.over_trigger && !self.pressed) || (self.open && self.over_card);
        if want == self.open {
            self.timer = None;
            return;
        }
        let delay = if want { OPEN_DELAY } else { CLOSE_DELAY };
        self.timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            this.update(cx, |this, cx| {
                this.open = want;
                this.timer = None;
                cx.notify();
            })
            .ok();
        }));
    }

    fn press(&mut self, cx: &mut Context<Self>) {
        self.pressed = true;
        self.open = false;
        self.timer = None;
        cx.notify();
    }
}

#[derive(IntoElement)]
pub struct HoverCard {
    id: ElementId,
    trigger: AnyElement,
    content: Content,
}

impl HoverCard {
    pub fn new(
        id: impl Into<ElementId>,
        trigger: impl IntoElement,
        content: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            trigger: trigger.into_any_element(),
            content: Rc::new(content),
        }
    }
}

impl RenderOnce for HoverCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let child = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), name.into())
        };
        let state: Entity<HoverCardState> =
            window.use_keyed_state(child("state"), cx, |_, _| HoverCardState::default());
        let (open, bounds) = {
            let state = state.read(cx);
            (state.open, state.bounds)
        };
        let card = bounds.filter(|_| open).map(|bounds| {
            let over = state.clone();
            let content = (self.content)(window, cx);
            deferred(
                anchored()
                    .position(point(bounds.right(), bounds.bottom() + OFFSET))
                    .anchor(Anchor::TopRight)
                    .snap_to_window_with_margin(px(8.))
                    .child(
                        div()
                            .id(child("card"))
                            .occlude()
                            .on_hover(move |hovered, _, cx| {
                                over.update(cx, |state, cx| {
                                    state.over_card = *hovered;
                                    state.settle(cx);
                                });
                            })
                            .child(pop_in(child("pop"), PopFrom::Above, content)),
                    ),
            )
            .with_priority(1)
        });
        let (hover, press, measure) = (state.clone(), state.clone(), state);
        div()
            .id(self.id.clone())
            .relative()
            .flex()
            .flex_none()
            .child(self.trigger)
            .child(
                canvas(
                    move |bounds, _, cx| {
                        measure.update(cx, |state, _| state.bounds = Some(bounds));
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .on_hover(move |hovered, _, cx| {
                hover.update(cx, |state, cx| {
                    state.over_trigger = *hovered;
                    if !*hovered {
                        state.pressed = false;
                    }
                    state.settle(cx);
                });
            })
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                press.update(cx, |state, cx| state.press(cx));
            })
            .children(card)
    }
}
