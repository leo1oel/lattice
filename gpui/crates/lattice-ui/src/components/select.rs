//! Select: a field that opens a list of options.
//!
//! Paper's Fields and selection board: the trigger is a field (32px, 28
//! compact, the 6px corner, 12px in, the chosen value and a 12px chevron);
//! the popup is the menu surface on the popover level, 4px below and at
//! least as wide as the trigger. The highlight is the accent wash; the
//! chosen value carries a check. Like a field, the trigger answers with its
//! border, never a ring: hover, keyboard focus and an open list deepen it.
//!
//! GPUI Kit's headless select (`gpui_kit::base::Select`) owns the combobox
//! semantics and the keys that open, confirm and dismiss it (Space, Enter,
//! the arrows, Escape), and moves focus into the list and back. The list
//! moves its highlight with the arrows, Home and End, and the pointer moves
//! the same highlight, so only one option is ever lit: the menu's fluid
//! hover, one fill gliding between options (`crate::fluid_hover`). A long
//! list scrolls inside its 320px cap under Lattice's scrollbar, and the keys
//! keep the highlighted option in view.

use std::rc::Rc;

use gpui::{
    App, Bounds, ClickEvent, ElementId, FocusHandle, InteractiveElement as _, IntoElement,
    KeyDownEvent, MouseButton, ParentElement as _, Pixels, RenderOnce, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, anchored, deferred, div, point,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::base::{
    ElementExt as _, POPUP_PRIORITY, Select as BaseSelect, Selectable,
    actions::{Confirm, SelectDown, SelectUp},
};

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{
        MENU_INSET, MenuItem, MenuSurface, PopFrom, Step, field::field_height, menu::MENU_OFFSET,
        pop_in, step_highlight,
    },
    fluid_hover::FluidHover,
    icons::ICON_SMALL,
    interaction::{mix, track_pointer, use_interaction},
    scrollbar::FluidScrollbar,
    shape,
    tokens::{FONT_WEIGHT_REGULAR, OPACITY_FIELD_DISABLED},
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
type ChangeHandler = Rc<dyn Fn(&usize, &mut Window, &mut App)>;

/// The tallest the list stands before it scrolls.
const LIST_MAX_HEIGHT: Pixels = px(320.);

/// A select's trigger: the field with its chosen value and a chevron.
///
/// [`Select`] draws one; it is public for a host that opens its own popup.
#[derive(IntoElement)]
pub struct SelectTrigger {
    id: ElementId,
    value: SharedString,
    compact: bool,
    open: bool,
    focused: bool,
    invalid: bool,
    disabled: bool,
    on_click: Option<ClickHandler>,
}

impl SelectTrigger {
    pub fn new(id: impl Into<ElementId>, value: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            value: value.into(),
            compact: false,
            open: false,
            focused: false,
            invalid: false,
            disabled: false,
            on_click: None,
        }
    }

    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    /// While the list is open the edge stays deepened.
    pub fn open(mut self, open: bool) -> Self {
        self.open = open;
        self
    }

    /// Keyboard focus deepens the edge too: a field draws no ring.
    pub fn focused(mut self, focused: bool) -> Self {
        self.focused = focused;
        self
    }

    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl Selectable for SelectTrigger {
    fn selected(self, selected: bool) -> Self {
        self.open(selected)
    }

    fn is_selected(&self) -> bool {
        self.open
    }
}

impl RenderOnce for SelectTrigger {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        let deepened = !self.disabled && (self.open || self.focused);
        let border = if self.invalid {
            palette.danger
        } else {
            mix(
                palette.field_border,
                palette.field_border_hover,
                interaction.hover.max(if deepened { 1. } else { 0. }),
            )
        };
        let role = if self.compact {
            TextRole::BodyCompact
        } else {
            TextRole::Body
        };
        let disabled = self.disabled;
        let frame = div().id(self.id);
        let frame = if disabled {
            frame
        } else {
            track_pointer(frame, pointer)
        };
        frame
            .flex()
            .items_center()
            .gap(px(6.))
            .h(field_height(self.compact))
            .pl(px(12.))
            .pr(px(10.))
            .rounded(px(6.))
            .border_1()
            .border_color(border)
            .bg(palette.input)
            .when(disabled, |this| this.opacity(OPACITY_FIELD_DISABLED))
            .when(!disabled, |this| this.cursor_pointer())
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_role(role, cx)
                    .font_weight(FONT_WEIGHT_REGULAR)
                    .text_color(palette.text)
                    .child(self.value),
            )
            .child(Icon::CHEVRON_DOWN.element(ICON_SMALL, palette.text_secondary))
            .when_some(self.on_click.filter(|_| !disabled), |this, on_click| {
                this.on_click(move |event, window, cx| on_click(event, window, cx))
            })
    }
}

/// What a select keeps between frames.
struct SelectMemory {
    open: bool,
    highlighted: Option<usize>,
    trigger: FocusHandle,
    list: FocusHandle,
    /// The trigger's bounds as last laid out: the list opens under them, at
    /// least as wide.
    bounds: Bounds<Pixels>,
    /// The list's scroll, which follows the highlight.
    scroll: ScrollHandle,
}

impl SelectMemory {
    /// Light `ix`, scrolled into view.
    fn highlight(&mut self, ix: Option<usize>) {
        self.highlighted = ix;
        if let Some(ix) = ix {
            self.scroll.scroll_to_item(ix);
        }
    }
}

/// A select: a trigger and its list of options.
#[derive(IntoElement)]
pub struct Select {
    id: ElementId,
    options: Vec<SharedString>,
    selected: Option<usize>,
    placeholder: SharedString,
    compact: bool,
    invalid: bool,
    disabled: bool,
    default_open: bool,
    on_change: Option<ChangeHandler>,
}

impl Select {
    pub fn new(
        id: impl Into<ElementId>,
        options: impl IntoIterator<Item = impl Into<SharedString>>,
        selected: Option<usize>,
    ) -> Self {
        Self {
            id: id.into(),
            options: options.into_iter().map(Into::into).collect(),
            selected,
            placeholder: SharedString::default(),
            compact: false,
            invalid: false,
            disabled: false,
            default_open: false,
            on_change: None,
        }
    }

    /// Shown in the trigger while nothing is chosen.
    pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.placeholder = placeholder.into();
        self
    }

    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Open on the first frame (the gallery shows the list at rest).
    pub fn default_open(mut self, open: bool) -> Self {
        self.default_open = open;
        self
    }

    /// Called with the chosen option's index.
    pub fn on_change(mut self, handler: impl Fn(&usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Select {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let child = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), name.into())
        };
        let (default_open, selected) = (self.default_open, self.selected);
        let memory = window.use_keyed_state(child("memory"), cx, move |_, cx| SelectMemory {
            open: default_open,
            highlighted: selected,
            trigger: cx.focus_handle(),
            list: cx.focus_handle(),
            bounds: Bounds::default(),
            scroll: ScrollHandle::new(),
        });
        let (open, highlighted, trigger_focus, list_focus, bounds, scroll) = {
            let m = memory.read(cx);
            (
                m.open && !self.disabled,
                m.highlighted,
                m.trigger.clone(),
                m.list.clone(),
                m.bounds,
                m.scroll.clone(),
            )
        };
        let value = self
            .selected
            .and_then(|ix| self.options.get(ix).cloned())
            .unwrap_or_else(|| self.placeholder.clone());
        let count = self.options.len();
        let on_change = self.on_change.clone();

        // Opening lights the chosen option; closing hands focus back to the
        // trigger (the headless select does it for Escape and Enter).
        let set_open = {
            let memory = memory.clone();
            Rc::new(move |open: bool, cx: &mut App| {
                memory.update(cx, |m, cx| {
                    m.open = open;
                    m.highlight(selected);
                    cx.notify();
                })
            })
        };
        let commit = {
            let memory = memory.clone();
            let on_change = on_change.clone();
            let set_open = set_open.clone();
            Rc::new(
                move |ix: Option<usize>, window: &mut Window, cx: &mut App| {
                    let trigger = memory.read(cx).trigger.clone();
                    set_open(false, cx);
                    trigger.focus(window, cx);
                    if let (Some(ix), Some(on_change)) = (ix, on_change.as_ref()) {
                        on_change(&ix, window, cx);
                    }
                },
            )
        };

        let keyboard_focus = trigger_focus.is_focused(window) && window.last_input_was_keyboard();
        let trigger = SelectTrigger::new(child("trigger"), value)
            .open(open)
            .focused(keyboard_focus)
            .invalid(self.invalid)
            .disabled(self.disabled)
            .when(self.compact, SelectTrigger::compact);

        let list = (open && bounds.size.width > px(0.)).then(|| {
            // One fill for the pointer and the keys (the app's select runs
            // the menu's fluid hover), opening on the chosen option.
            let hover = FluidHover::new(child("fluid"), window, cx)
                .fill(cx.palette().accent_soft)
                .radius(shape::MENU.inner())
                .follow(highlighted, cx);
            let rows = self
                .options
                .iter()
                .enumerate()
                .map(|(ix, label)| {
                    let choose = commit.clone();
                    let row = MenuItem::new(
                        ElementId::NamedChild(
                            std::sync::Arc::new(self.id.clone()),
                            SharedString::from(format!("option-{ix}")),
                        ),
                        label.clone(),
                    )
                    .checked(self.selected == Some(ix))
                    .highlighted(hover.lit(cx) == Some(ix))
                    .fluid()
                    .on_click(move |_, window, cx| choose(Some(ix), window, cx));
                    hover.item(ix, row)
                })
                .collect::<Vec<_>>();
            let lit = hover.clone();
            // The keys go on from the option the pointer lit.
            let mover = |step: Step| {
                let memory = memory.clone();
                let lit = lit.clone();
                move |cx: &mut App| {
                    let from = lit.lit(cx);
                    memory.update(cx, |m, cx| {
                        m.highlight(step_highlight(&vec![true; count], from, step));
                        cx.notify();
                    })
                }
            };
            let (up, down, home, end) = (
                mover(Step::Previous),
                mover(Step::Next),
                mover(Step::First),
                mover(Step::Last),
            );
            let fill = hover.highlight();
            let close = commit.clone();
            let confirm = commit.clone();
            // Enter and Space confirm here, in the list, rather than at the
            // headless root: after its own confirm the root hands focus back
            // to the list, which has closed by then.
            let surface = div()
                .id(child("list"))
                .track_focus(&list_focus)
                .on_action(move |_: &SelectUp, _, cx| up(cx))
                .on_action(move |_: &SelectDown, _, cx| down(cx))
                .on_action(move |_: &Confirm, window, cx| confirm(hover.lit(cx), window, cx))
                .on_key_down(move |event: &KeyDownEvent, _, cx| {
                    match event.keystroke.key.as_str() {
                        "home" => home(cx),
                        "end" => end(cx),
                        _ => return,
                    }
                    cx.stop_propagation();
                })
                .on_mouse_down_out(move |_, window, cx| close(None, window, cx))
                .child(
                    MenuSurface::new()
                        .min_w(bounds.size.width)
                        .max_h(LIST_MAX_HEIGHT)
                        .child(
                            // The fill and the bar are laid over the rows'
                            // viewport, which clips them.
                            div()
                                .relative()
                                .child(fill)
                                .child(
                                    div()
                                        .id(child("rows"))
                                        .flex()
                                        .flex_col()
                                        .max_h(LIST_MAX_HEIGHT - MENU_INSET * 2.)
                                        .overflow_y_scroll()
                                        .track_scroll(&scroll)
                                        .children(rows),
                                )
                                .child(FluidScrollbar::vertical(child("bar"), &scroll)),
                        ),
                );
            deferred(
                anchored()
                    .position(point(bounds.left(), bounds.bottom() + MENU_OFFSET))
                    .snap_to_window_with_margin(px(8.))
                    .child(pop_in(child("pop"), PopFrom::Above, surface)),
            )
            .with_priority(POPUP_PRIORITY)
        });
        // Until the trigger has been laid out once the list has nowhere to
        // stand; one more frame places it.
        if open && list.is_none() {
            window.request_animation_frame();
        }

        let toggle = set_open.clone();
        let list_handle = list_focus.clone();
        BaseSelect::new(child("root"))
            .open(open)
            .disabled(self.disabled)
            .focus_handle(&trigger_focus)
            .content_focus_handle(&list_focus)
            .on_open_change(move |open, _, cx| set_open(open, cx))
            .child(
                div()
                    .id(child("anchor"))
                    .relative()
                    .on_prepaint({
                        let memory = memory.clone();
                        move |bounds, _, cx| {
                            if memory.read(cx).bounds != bounds {
                                memory.update(cx, |m, cx| {
                                    m.bounds = bounds;
                                    cx.notify();
                                });
                            }
                        }
                    })
                    // The press toggles. An open list closes on any press
                    // outside it first, so a press on the trigger that finds
                    // it already closed this frame leaves it closed.
                    .when(!self.disabled, |this| {
                        this.on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            window.prevent_default();
                            cx.stop_propagation();
                            let now = memory.read(cx).open;
                            if now == open {
                                toggle(!open, cx);
                                if !open {
                                    list_handle.focus(window, cx);
                                }
                            }
                        })
                    })
                    .child(trigger),
            )
            .children(list)
    }
}
