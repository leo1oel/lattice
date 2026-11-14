//! A menu's surface and rows, shared by menus, selects and context menus.
//!
//! Paper's Overlays board, and the app's `menu-surface.ts`: a menu stands on
//! the lift at the popover level, a 10px surface with a 4px inset, so its
//! rows keep the 6px control corner (concentric corners). It is at least
//! 9rem wide and stops at 352px (`--menu-max-width`); a longer name wraps
//! rather than widening it.
//!
//! - an item is 10px in and 6px tall of padding round a 13/20 regular label,
//!   10px between its 14px icon (secondary ink) and the label, its shortcut
//!   quiet at the end;
//! - the row the pointer lights and the row the arrow keys reach are one
//!   highlight, the accent wash (`--control-active-soft`): in a [`Menu`]
//!   (`menu_list.rs`) it is the list's fluid hover, one fill gliding between
//!   rows (`crate::fluid_hover`); a row drawn alone fades its own wash on the
//!   fast tier. A destructive item takes the danger ink and its own danger
//!   wash, which the gliding fill never lands on;
//! - a disabled item fades to 50% and takes no pointer;
//! - a group's label steps back to the caption role, medium, secondary ink,
//!   10px in, 8 over and 4 under;
//! - a separator runs to the surface's edge, through the inset, 4px clear of
//!   the rows on each side.
//!
//! Items are reached with the arrow keys from the menu that holds them, as a
//! menu's roving focus works in the app, so a row is not a tab stop of its
//! own; the menu is (see `menu_list.rs`).

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, InteractiveElement as _, IntoElement,
    MouseMoveEvent, ParentElement, Pixels, Refineable as _, RenderOnce, SharedString,
    StatefulInteractiveElement as _, StyleRefinement, Styled, Window, div,
    prelude::FluentBuilder as _, px, rems, transparent_black,
};

use crate::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    icons::ICON,
    interaction::{fade, mix, track_pointer_and_hover, use_interaction},
    motion::Motion,
    shape,
    tokens::{CONTAINER_MENU, FONT_WEIGHT_MEDIUM, OPACITY_MENU_DISABLED},
};

/// The surface's inset: rows stand this far inside its 10px corner.
pub const MENU_INSET: Pixels = shape::MENU.inset;
/// The gap between a trigger and the menu it opens (Radix's `sideOffset`).
pub const MENU_OFFSET: Pixels = px(4.);

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
type HoverHandler = Rc<dyn Fn(&bool, &mut Window, &mut App)>;
type MouseMoveHandler = Rc<dyn Fn(&MouseMoveEvent, &mut Window, &mut App)>;

/// The lift a menu's rows stand on.
#[derive(IntoElement)]
pub struct MenuSurface {
    base: Div,
    children: Vec<AnyElement>,
}

impl MenuSurface {
    pub fn new() -> Self {
        Self {
            base: div(),
            children: Vec::new(),
        }
    }
}

impl Default for MenuSurface {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for MenuSurface {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl Styled for MenuSurface {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl RenderOnce for MenuSurface {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        // The caller's width (a select's trigger width) is refined over these
        // defaults, so it comes after them.
        let mut base = div()
            .relative()
            .flex()
            .flex_col()
            .min_w(rems(9.))
            .max_w(CONTAINER_MENU)
            .p(MENU_INSET)
            .rounded(shape::MENU.radius)
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(palette))
            .text_role(TextRole::Body, cx)
            .text_color(palette.text);
        let mut this = self.base;
        base.style().refine(this.style());
        base.children(self.children)
    }
}

/// One row of a menu or a select's list.
#[derive(IntoElement)]
pub struct MenuItem {
    id: ElementId,
    label: SharedString,
    icon: Option<Icon>,
    shortcut: Option<SharedString>,
    disabled: bool,
    destructive: bool,
    checked: Option<bool>,
    /// A checkable menu's leading 14px gutter, and whether this row's check
    /// shows in it.
    check_gutter: Option<bool>,
    /// The row opens a submenu: a chevron at the end.
    submenu: bool,
    /// A control at the row's end, before the shortcut (the project
    /// switcher's open-in-this-window glyph).
    accessory: Option<AnyElement>,
    highlighted: bool,
    /// The list draws the hover fill (fluid hover): the row draws none, but
    /// a destructive row's own danger wash.
    fluid: bool,
    on_click: Option<ClickHandler>,
    on_hover: Option<HoverHandler>,
    on_mouse_move: Option<MouseMoveHandler>,
}

impl MenuItem {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon: None,
            shortcut: None,
            disabled: false,
            destructive: false,
            checked: None,
            check_gutter: None,
            submenu: false,
            accessory: None,
            highlighted: false,
            fluid: false,
            on_click: None,
            on_hover: None,
            on_mouse_move: None,
        }
    }

    /// Leave the hover fill to the list's fluid hover (`crate::fluid_hover`):
    /// the row paints none of its own, except a destructive row's danger
    /// wash, under the pointer or the keys.
    pub fn fluid(mut self) -> Self {
        self.fluid = true;
        self
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// The keys that run it without the menu, as the command table spells
    /// them (`⌘N`).
    pub fn shortcut(mut self, keys: impl Into<SharedString>) -> Self {
        self.shortcut = Some(keys.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The row that destroys something: the danger ink and wash.
    pub fn destructive(mut self, destructive: bool) -> Self {
        self.destructive = destructive;
        self
    }

    /// A select's option: the chosen one carries a check at the end, and
    /// every option keeps the check's gutter so the labels do not shift.
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = Some(checked);
        self
    }

    /// A row of a menu with checkable items: a 14px gutter before the icon
    /// (`.trellis-menu-check`), holding the check when `Some(true)`, so every
    /// row's label lines up.
    pub fn check_gutter(mut self, checked: Option<bool>) -> Self {
        self.check_gutter = checked;
        self
    }

    /// A control at the row's end, before the shortcut.
    pub fn accessory(mut self, accessory: impl IntoElement) -> Self {
        self.accessory = Some(accessory.into_any_element());
        self
    }

    /// The row opens a submenu: the chevron at its end.
    pub fn submenu(mut self) -> Self {
        self.submenu = true;
        self
    }

    /// The row the keys (or the pointer, through `on_hover`) reached.
    pub fn highlighted(mut self, highlighted: bool) -> Self {
        self.highlighted = highlighted;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    /// The pointer moving over the row, on the row's own element: a wrapper
    /// would take the row's place in the list's layout and measurement.
    pub fn on_mouse_move(
        mut self,
        handler: impl Fn(&MouseMoveEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_mouse_move = Some(Rc::new(handler));
        self
    }

    /// Hand the pointer's hover to the menu, which moves its one highlight
    /// there. A row with this set lights only when `highlighted`, so a
    /// resting pointer never lights a second row while the keys move on.
    pub fn on_hover(mut self, handler: impl Fn(&bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_hover = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for MenuItem {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let disabled = self.disabled;
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        let lit = !disabled
            && if self.fluid {
                self.destructive && (self.highlighted || interaction.pointer.hovered)
            } else {
                self.highlighted || (self.on_hover.is_none() && interaction.pointer.hovered)
            };
        let glow = fade(
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "lit".into()),
            lit,
            Motion::Fast,
            window,
            cx,
        );
        let (ink, icon_ink, wash) = if self.destructive {
            (palette.danger, palette.danger, palette.danger_soft)
        } else {
            (palette.text, palette.text_secondary, palette.accent_soft)
        };
        let row = div().id(self.id);
        let row = if disabled {
            row
        } else {
            let on_hover = self.on_hover;
            track_pointer_and_hover(row, pointer, move |hovered, window, cx| {
                if let Some(on_hover) = &on_hover {
                    on_hover(hovered, window, cx);
                }
            })
        };
        row.relative()
            .flex()
            .items_center()
            .gap(px(10.))
            .pl(px(10.))
            // A select's option keeps a 28px gutter at the end for its check.
            .pr(px(if self.checked.is_some() { 28. } else { 10. }))
            .py(px(6.))
            .rounded(shape::MENU.inner())
            .bg(mix(transparent_black(), wash, glow))
            .text_color(ink)
            .when(disabled, |this| this.opacity(OPACITY_MENU_DISABLED))
            .when_some(self.check_gutter, |this, checked| {
                this.child(
                    div()
                        .flex_none()
                        .w(ICON)
                        .flex()
                        .items_center()
                        .justify_center()
                        .when(checked, |this| {
                            this.child(Icon::CHECK.element(ICON, palette.text))
                        }),
                )
            })
            .when_some(self.icon, |this, icon| {
                this.child(icon.element(ICON, icon_ink))
            })
            .child(div().flex_1().min_w_0().child(self.label))
            .children(self.accessory)
            .when_some(self.shortcut, |this, keys| {
                this.child(
                    div()
                        .flex_none()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(keys),
                )
            })
            .when(self.submenu, |this| {
                this.child(Icon::CHEVRON_RIGHT.element(ICON, palette.text_secondary))
            })
            .when(self.checked == Some(true), |this| {
                this.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .right(px(6.))
                        .w(px(16.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(Icon::CHECK.element(ICON, palette.text)),
                )
            })
            .when_some(self.on_click.filter(|_| !disabled), |this, on_click| {
                this.on_click(move |event, window, cx| on_click(event, window, cx))
            })
            .when_some(self.on_mouse_move, |this, on_move| {
                this.on_mouse_move(move |event, window, cx| on_move(event, window, cx))
            })
    }
}

/// A group's heading inside a menu.
#[derive(IntoElement)]
pub struct MenuLabel {
    label: SharedString,
}

impl MenuLabel {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
        }
    }
}

impl RenderOnce for MenuLabel {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        div()
            .px(px(10.))
            .pt(px(8.))
            .pb(px(4.))
            .text_role(TextRole::Caption, cx)
            .font_weight(FONT_WEIGHT_MEDIUM)
            .text_color(cx.palette().text_secondary)
            .child(self.label)
    }
}

/// A rule between a menu's groups, to the surface's edge.
#[derive(IntoElement, Default)]
pub struct MenuSeparator;

impl RenderOnce for MenuSeparator {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        div()
            .mx(-MENU_INSET)
            .my(px(4.))
            .h(px(1.))
            .bg(cx.palette().line)
    }
}

/// Where the arrow keys send a menu's highlight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Next,
    Previous,
    First,
    Last,
}

/// The row the highlight moves to from `from`, over rows whose `enabled`
/// flag is set: disabled rows, labels and separators are passed over. It
/// stops at the ends rather than wrapping, as the app's menus and selects do
/// (Radix's `loop` is off): with nothing enabled in the key's direction the
/// highlight stays where it is. With nothing highlighted Next lands on the
/// first row and Previous on the last.
pub fn step_highlight(enabled: &[bool], from: Option<usize>, step: Step) -> Option<usize> {
    let first = enabled.iter().position(|on| *on);
    let last = enabled.iter().rposition(|on| *on);
    let stay = |at: usize| first.map(|_| at);
    match (step, from) {
        (Step::First, _) | (Step::Next, None) => first,
        (Step::Last, _) | (Step::Previous, None) => last,
        (Step::Next, Some(at)) => enabled
            .iter()
            .enumerate()
            .skip(at + 1)
            .find(|(_, on)| **on)
            .map(|(ix, _)| ix)
            .or_else(|| stay(at)),
        (Step::Previous, Some(at)) => enabled
            .iter()
            .enumerate()
            .take(at)
            .rev()
            .find(|(_, on)| **on)
            .map(|(ix, _)| ix)
            .or_else(|| stay(at)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A menu like the board's: a label, three items with the third
    // disabled, a separator, and the destructive item.
    const MENU: [bool; 6] = [false, true, true, false, false, true];

    #[test]
    fn arrows_pass_over_labels_separators_and_disabled_rows() {
        assert_eq!(step_highlight(&MENU, Some(2), Step::Next), Some(5));
        assert_eq!(step_highlight(&MENU, Some(5), Step::Previous), Some(2));
        assert_eq!(step_highlight(&MENU, Some(1), Step::Next), Some(2));
    }

    #[test]
    fn the_first_arrow_lands_on_an_end() {
        assert_eq!(step_highlight(&MENU, None, Step::Next), Some(1));
        assert_eq!(step_highlight(&MENU, None, Step::Previous), Some(5));
        assert_eq!(step_highlight(&MENU, Some(5), Step::First), Some(1));
        assert_eq!(step_highlight(&MENU, Some(1), Step::Last), Some(5));
    }

    #[test]
    fn the_highlight_stops_at_the_ends() {
        assert_eq!(step_highlight(&MENU, Some(5), Step::Next), Some(5));
        assert_eq!(step_highlight(&MENU, Some(1), Step::Previous), Some(1));
    }

    #[test]
    fn a_key_with_nothing_enabled_its_way_leaves_the_highlight() {
        // The highlight rests on a disabled last row (the pointer left it
        // there): Down has nowhere to go, and must not jump back up.
        assert_eq!(step_highlight(&[true, false], Some(1), Step::Next), Some(1));
        assert_eq!(
            step_highlight(&[false, true], Some(0), Step::Previous),
            Some(0)
        );
    }

    #[test]
    fn a_menu_with_nothing_enabled_highlights_nothing() {
        let none = [false, false];
        assert_eq!(step_highlight(&none, None, Step::Next), None);
        assert_eq!(step_highlight(&none, Some(0), Step::Next), None);
        assert_eq!(step_highlight(&[], None, Step::Last), None);
    }
}
