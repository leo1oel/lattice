//! Menus and popovers that open from a trigger.
//!
//! GPUI Kit's headless popover (`gpui_kit::base::Popover`) owns the open
//! state, the anchoring below the trigger, dismissal (Escape, a press
//! outside) and focus: it moves focus into the popup and gives it back on
//! close. Lattice draws what opens:
//!
//! - a [`Menu`] on the menu surface (`menu.rs`), its highlight moved by the
//!   arrow keys, Home and End, run with Enter or Space;
//! - a [`PopoverCard`], Paper's popover: 288 wide on the same 10px lift at
//!   the popover level, 16px in, its lead action compact tinted.
//!
//! Both spring from the trigger on the pop tier (`pop_in`), 4px below it.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, FocusHandle, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement, RenderOnce, SharedString, Styled as _, Window, div, prelude::FluentBuilder as _,
    px,
};
use gpui_kit::base::{Popover as BasePopover, Selectable};

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{
        MenuItem, MenuLabel, MenuSeparator, MenuSurface, PopFrom, Step, menu::MENU_OFFSET, pop_in,
        step_highlight,
    },
    fluid_hover::{FluidHover, ItemKind},
    shape,
};

type Action = Rc<dyn Fn(&mut Window, &mut App)>;

/// One of a menu's items: its label, what it runs, and how it looks.
pub struct MenuAction {
    label: SharedString,
    icon: Option<Icon>,
    shortcut: Option<SharedString>,
    disabled: bool,
    destructive: bool,
    run: Action,
}

impl MenuAction {
    pub fn new(
        label: impl Into<SharedString>,
        run: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            icon: None,
            shortcut: None,
            disabled: false,
            destructive: false,
            run: Rc::new(run),
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn shortcut(mut self, keys: impl Into<SharedString>) -> Self {
        self.shortcut = Some(keys.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn destructive(mut self) -> Self {
        self.destructive = true;
        self
    }
}

enum Entry {
    Item(MenuAction),
    Label(SharedString),
    Separator,
}

/// A menu: labelled groups of actions on the menu surface.
///
/// Drawn alone (in the gallery, or by a host that positions it) it is a
/// static list the pointer can still run; opened by a [`MenuPopover`] it
/// takes focus, and the keys move its highlight.
#[derive(IntoElement)]
pub struct Menu {
    id: ElementId,
    entries: Vec<Entry>,
    focus: Option<FocusHandle>,
    on_dismiss: Option<Action>,
    highlighted: Option<usize>,
}

impl Menu {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            entries: Vec::new(),
            focus: None,
            on_dismiss: None,
            highlighted: None,
        }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.entries.push(Entry::Label(label.into()));
        self
    }

    pub fn item(mut self, action: MenuAction) -> Self {
        self.entries.push(Entry::Item(action));
        self
    }

    pub fn separator(mut self) -> Self {
        self.entries.push(Entry::Separator);
        self
    }

    /// Light an item from the start, as when the keys opened the menu (and
    /// for the gallery, which shows the highlight at rest).
    pub fn highlighted(mut self, entry: usize) -> Self {
        self.highlighted = Some(entry);
        self
    }

    /// Take keyboard focus on `focus`, so the arrow keys reach the menu.
    pub fn track_focus(mut self, focus: &FocusHandle) -> Self {
        self.focus = Some(focus.clone());
        self
    }

    /// Run after an item ran, to close whatever opened the menu.
    pub fn on_dismiss(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_dismiss = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Menu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let initial = self.highlighted;
        let highlight = window.use_keyed_state(
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "highlight".into()),
            cx,
            move |_, _| initial,
        );
        let current = *highlight.read(cx);
        // One fill for the pointer and the keys, gliding between rows.
        let palette = cx.palette().clone();
        let hover = FluidHover::new(
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "fluid".into()),
            window,
            cx,
        )
        .fill(palette.accent_soft)
        .radius(shape::MENU.inner())
        .follow(current, cx);
        let enabled: Rc<[bool]> = self
            .entries
            .iter()
            .map(|entry| matches!(entry, Entry::Item(action) if !action.disabled))
            .collect();
        let actions: Rc<[Option<Action>]> = self
            .entries
            .iter()
            .map(|entry| match entry {
                Entry::Item(action) if !action.disabled => Some(action.run.clone()),
                _ => None,
            })
            .collect();
        let dismiss = self.on_dismiss.clone();
        // Running an item closes the menu first, so the action finds focus
        // back where it was before the menu opened.
        let run = {
            let highlight = highlight.clone();
            move |action: &Action, window: &mut Window, cx: &mut App| {
                highlight.update(cx, |at, _| *at = None);
                if let Some(dismiss) = dismiss.as_ref() {
                    dismiss(window, cx);
                }
                action(window, cx);
            }
        };
        let run = Rc::new(run);

        // A label or a separator starts a new section: the fill fades across
        // it instead of sliding through.
        let mut section = 0;
        let mut rows: Vec<AnyElement> = vec![hover.highlight()];
        rows.extend(
            self.entries
                .into_iter()
                .enumerate()
                .map(|(ix, entry)| match entry {
                    Entry::Label(label) => {
                        section += 1;
                        MenuLabel::new(label).into_any_element()
                    }
                    Entry::Separator => {
                        section += 1;
                        MenuSeparator.into_any_element()
                    }
                    Entry::Item(action) => {
                        let id = ElementId::NamedChild(
                            std::sync::Arc::new(self.id.clone()),
                            SharedString::from(format!("item-{ix}")),
                        );
                        let runner = run.clone();
                        let run_action = action.run.clone();
                        let kind = if action.disabled || action.destructive {
                            ItemKind::skip()
                        } else {
                            ItemKind::target()
                        }
                        .section(section);
                        let item = MenuItem::new(id, action.label)
                            .when_some(action.icon, MenuItem::icon)
                            .when_some(action.shortcut, MenuItem::shortcut)
                            .disabled(action.disabled)
                            .destructive(action.destructive)
                            .highlighted(hover.lit(cx) == Some(ix))
                            .fluid()
                            .on_click(move |_, window, cx| runner(&run_action, window, cx));
                        hover.item_as(ix, kind, item)
                    }
                }),
        );

        let keys = {
            let highlight = highlight.clone();
            let hover = hover.clone();
            move |event: &KeyDownEvent, window: &mut Window, cx: &mut App| {
                // The keys go on from the row the pointer lit, as a menu's
                // roving highlight does in the app.
                let at = hover.lit(cx);
                let step = match event.keystroke.key.as_str() {
                    "down" => Step::Next,
                    "up" => Step::Previous,
                    "home" => Step::First,
                    "end" => Step::Last,
                    "enter" | "space" => {
                        if let Some(action) = at.and_then(|at| actions.get(at).cloned().flatten()) {
                            cx.stop_propagation();
                            run(&action, window, cx);
                        }
                        return;
                    }
                    _ => return,
                };
                cx.stop_propagation();
                let next = step_highlight(&enabled, at, step);
                hover.key_to(next, cx);
                highlight.update(cx, |current, cx| {
                    *current = next;
                    cx.notify();
                });
            }
        };

        div()
            .id(self.id)
            .when_some(self.focus, |this, focus| {
                this.track_focus(&focus).on_key_down(keys)
            })
            .child(MenuSurface::new().children(rows))
    }
}

/// A trigger that opens a [`Menu`] below it.
///
/// The trigger shows itself open while the menu is (a Button takes its
/// pressed look); `menu` builds the menu each time it draws.
#[derive(IntoElement)]
pub struct MenuPopover<T: Selectable + IntoElement + 'static> {
    id: ElementId,
    trigger: T,
    menu: Rc<dyn Fn(Menu) -> Menu>,
}

impl<T: Selectable + IntoElement + 'static> MenuPopover<T> {
    pub fn new(
        id: impl Into<ElementId>,
        trigger: T,
        menu: impl Fn(Menu) -> Menu + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            trigger,
            menu: Rc::new(menu),
        }
    }
}

impl<T: Selectable + IntoElement + 'static> RenderOnce for MenuPopover<T> {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let focus = window
            .use_keyed_state(
                ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "menu-focus".into()),
                cx,
                |_, cx| cx.focus_handle(),
            )
            .read(cx)
            .clone();
        let menu_id = ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "menu".into());
        let build = self.menu;
        BasePopover::new(self.id)
            .offset(MENU_OFFSET)
            .trigger(self.trigger)
            .track_focus(&focus)
            .content(move |_, _, cx| {
                let popover = cx.entity();
                let menu = build(Menu::new(menu_id.clone()))
                    .track_focus(&focus)
                    .on_dismiss(move |window, cx| {
                        popover.update(cx, |state, cx| state.dismiss(window, cx));
                        window.refresh();
                    });
                pop_in(menu_id.clone(), PopFrom::Above, menu)
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
