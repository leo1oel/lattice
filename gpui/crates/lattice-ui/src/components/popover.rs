//! Menus and popovers that open from a trigger.
//!
//! GPUI Kit's headless popover (`gpui_kit::base::Popover`) owns the open
//! state, the anchoring below the trigger, dismissal (Escape, a press
//! outside) and focus: it moves focus into the popup and gives it back on
//! close. Lattice draws what opens:
//!
//! - a [`Menu`] on the menu surface (`menu_list.rs`), its highlight moved by
//!   the arrow keys, Home and End, run with Enter or Space;
//! - a [`PopoverCard`], Paper's popover: 288 wide on the same 10px lift at
//!   the popover level, 16px in, its lead action compact tinted.
//!
//! Both spring from the trigger on the pop tier (`pop_in`), 4px below it.

use std::rc::Rc;

use gpui::{
    Anchor, AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement,
    RenderOnce, SharedString, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::base::{Popover as BasePopover, Selectable};

use crate::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{Menu, MenuSurface, PopFrom, SubmenuBounds, menu::MENU_OFFSET, pop_in},
};

type BuildMenu = Rc<dyn Fn(Menu, &mut Window, &mut App) -> Menu>;

/// A trigger that opens a [`Menu`] below it.
///
/// The trigger shows itself open while the menu is (a Button takes its
/// pressed look); `menu` builds the menu each time it draws. The menu takes
/// focus while open and gives it back on close, so a
/// [`super::MenuAction::dispatch`] item runs its command where focus was.
#[derive(IntoElement)]
pub struct MenuPopover<T: Selectable + IntoElement + 'static> {
    id: ElementId,
    trigger: T,
    anchor: Anchor,
    menu: BuildMenu,
}

impl<T: Selectable + IntoElement + 'static> MenuPopover<T> {
    pub fn new(
        id: impl Into<ElementId>,
        trigger: T,
        menu: impl Fn(Menu, &mut Window, &mut App) -> Menu + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            trigger,
            anchor: Anchor::TopLeft,
            menu: Rc::new(menu),
        }
    }

    /// Which corner of the menu meets the trigger's: the top left by
    /// default, the top right for a trigger at the end of a strip (a
    /// panel's ⋯), so the menu opens inward.
    pub fn anchor(mut self, anchor: Anchor) -> Self {
        self.anchor = anchor;
        self
    }
}

impl<T: Selectable + IntoElement + 'static> RenderOnce for MenuPopover<T> {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let child = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), name.into())
        };
        let focus = window
            .use_keyed_state(child("menu-focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        // The focus the menu interrupts: its commands' keys are read there.
        let interrupted = window.use_keyed_state(child("interrupted"), cx, |_, _| None);
        if !focus.contains_focused(window, cx) {
            let now = window.focused(cx);
            interrupted.update(cx, |was, _| *was = now);
        }
        let submenus = window
            .use_keyed_state(child("submenus"), cx, |_, _| SubmenuBounds::default())
            .read(cx)
            .clone();
        let menu_id = child("menu");
        let build = self.menu;
        // A press outside the menu closes it, as Kit's popover would, but
        // one in an open submenu, beside the menu, is inside it.
        BasePopover::new(self.id)
            .anchor(self.anchor)
            .offset(MENU_OFFSET)
            .trigger(self.trigger)
            .track_focus(&focus)
            .overlay_closable(false)
            .content(move |_, window, cx| {
                let popover = cx.entity();
                let outside = popover.clone();
                let context = interrupted.read(cx).clone();
                submenus.clear();
                let menu = build(Menu::new(menu_id.clone()), window, cx)
                    .track_focus(&focus)
                    .action_context(context)
                    .submenu_bounds(submenus.clone())
                    .on_dismiss(move |window, cx| {
                        popover.update(cx, |state, cx| state.dismiss(window, cx));
                        window.refresh();
                    });
                let inside = submenus.clone();
                div()
                    .on_mouse_down_out(move |_, window, cx| {
                        if !inside.contains(window.mouse_position()) {
                            outside.update(cx, |state, cx| state.dismiss(window, cx));
                            window.refresh();
                        }
                    })
                    .child(pop_in(menu_id.clone(), PopFrom::Above, menu))
            })
    }
}

/// Paper's popover: a small form or a few facts on the lift, 288 wide.
#[derive(IntoElement)]
pub struct PopoverCard {
    title: Option<SharedString>,
    children: Vec<AnyElement>,
    actions: Vec<AnyElement>,
}

impl PopoverCard {
    pub fn new() -> Self {
        Self {
            title: None,
            children: Vec::new(),
            actions: Vec::new(),
        }
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Actions at the foot, right-aligned, left to right; the lead last, as
    /// a compact tinted Button.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }
}

impl Default for PopoverCard {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for PopoverCard {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for PopoverCard {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        // Measured on the board: the 13/18 title, 14px to the field, the
        // compact actions 12px under it.
        MenuSurface::new()
            .w(px(288.))
            .p(px(16.))
            .gap(px(12.))
            .when_some(self.title, |this, title| {
                this.child(
                    div()
                        .text_role(TextRole::Subtitle, cx)
                        .text_color(palette.text)
                        .child(title),
                )
            })
            .children(self.children)
            .when(!self.actions.is_empty(), |this| {
                this.child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .children(self.actions),
                )
            })
    }
}

/// A trigger that opens a [`PopoverCard`] (or any content) below it.
#[derive(IntoElement)]
pub struct Popover<T: Selectable + IntoElement + 'static> {
    id: ElementId,
    trigger: T,
    content: Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>,
}

impl<T: Selectable + IntoElement + 'static> Popover<T> {
    pub fn new<E: IntoElement>(
        id: impl Into<ElementId>,
        trigger: T,
        content: impl Fn(&mut Window, &mut App) -> E + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            trigger,
            content: Rc::new(move |window, cx| content(window, cx).into_any_element()),
        }
    }
}

impl<T: Selectable + IntoElement + 'static> RenderOnce for Popover<T> {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let id = ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "card".into());
        let content = self.content;
        BasePopover::new(self.id)
            .offset(MENU_OFFSET)
            .trigger(self.trigger)
            .content(move |_, window, cx| pop_in(id.clone(), PopFrom::Above, content(window, cx)))
    }
}
