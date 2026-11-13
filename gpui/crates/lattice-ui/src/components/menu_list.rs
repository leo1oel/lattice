//! A menu: labelled groups of actions on the menu surface, the one menu every
//! surface opens (design call 4), whether from a button ([`MenuPopover`]),
//! a right-click (`context_menu.rs`) or a panel's ⋯.
//!
//! The rows are `menu.rs`'s: 32px tall (6 + 20 + 6) with no gap between
//! them, a 1px separator 4px clear of the rows, at least 9rem wide. Beyond
//! a plain action an entry can be:
//!
//! - a checkable action: a menu with any checkable entry keeps a 14px check
//!   gutter before every row's icon (`.trellis-menu-check`), so the labels
//!   line up whether or not a row is checked;
//! - a command: [`MenuAction::dispatch`] runs a GPUI action on the focus the
//!   menu interrupted, and shows the keys bound to it there, as the app's
//!   menus show the command table's keys;
//! - a submenu, which opens beside its row when the pointer or the keys
//!   reach it (→, Enter or Space) and closes on ← or Escape;
//! - a secondary action: a small glyph at the row's end that runs something
//!   other than the row (the project switcher's open-in-this-window). The
//!   pointer presses it; the keys reach it with → from its row, go back
//!   with ←, and run it with Enter or Space, as the app's glyph is an item
//!   of its own the keys can land on.
//!
//! A menu taller than the window less 8px each side scrolls inside its
//! surface under Lattice's scrollbar (`ScrollbarFeel::LIST`), as every other
//! list does (design call 3).
//!
//! [`MenuPopover`]: super::MenuPopover

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    Action, AnyElement, App, AsKeystroke as _, Bounds, ElementId, Entity, FocusHandle, Global,
    InteractiveElement as _, IntoElement, KeyContext, KeyDownEvent, MouseButton, MouseMoveEvent,
    ParentElement, Pixels, Point, RenderOnce, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, anchored, canvas, deferred, div, point,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::{base::POPUP_PRIORITY, component::Selectable as _};

use crate::{
    ActiveLattice as _, Icon,
    components::{
        IconButton, MenuItem, MenuLabel, MenuSeparator, MenuSurface, PopFrom, Step, pop_in,
    },
    fluid_hover::{FluidHover, ItemKind},
    icons::ICON_SMALL,
    scrollbar::{FluidScrollbar, ScrollbarFeel},
    shape,
};

use super::menu::{MENU_INSET, step_highlight};

pub(crate) type Action0 = Rc<dyn Fn(&mut Window, &mut App)>;
type BuildSubmenu = Rc<dyn Fn(Menu, &mut Window, &mut App) -> Menu>;

/// How long the pointer may rest on another row, on its way to an open
/// submenu, before that row takes over (Radix's pointer grace).
const SUBMENU_GRACE: Duration = Duration::from_millis(300);

/// Where the pointer last stood on an open submenu's row, and since when it
/// has been on another row on its way to the submenu.
#[derive(Clone, Copy, Default)]
struct Grace {
    origin: Option<Point<Pixels>>,
    since: Option<Instant>,
}

/// Whether `pointer` is on its way from `origin` (where it left the
/// submenu's row) to `submenu`: inside the triangle from `origin` to the
/// submenu's near edge, as Radix's submenus keep open.
fn heading_to_submenu(
    origin: Point<Pixels>,
    submenu: Bounds<Pixels>,
    pointer: Point<Pixels>,
) -> bool {
    let edge = if submenu.left() >= origin.x {
        submenu.left()
    } else {
        submenu.right()
    };
    let (a, b, c) = (
        origin,
        point(edge, submenu.top()),
        point(edge, submenu.bottom()),
    );
    let side = |p: Point<Pixels>, q: Point<Pixels>, r: Point<Pixels>| {
        f32::from(q.x - p.x) * f32::from(r.y - p.y) - f32::from(q.y - p.y) * f32::from(r.x - p.x)
    };
    let (d1, d2, d3) = (
        side(a, b, pointer),
        side(b, c, pointer),
        side(c, a, pointer),
    );
    let negative = d1 < 0. || d2 < 0. || d3 < 0.;
    let positive = d1 > 0. || d2 > 0. || d3 > 0.;
    !(negative && positive)
}

/// Whether an open submenu stays open while another row is lit: only when
/// the pointer lit it, on its way from where it left the submenu's row to
/// the submenu, and has not rested there for the grace yet. A key move
/// switches at once.
fn hold_submenu(
    by_pointer: bool,
    grace: Grace,
    submenu: Option<Bounds<Pixels>>,
    pointer: Point<Pixels>,
) -> bool {
    let waited = grace.since.map_or(Duration::ZERO, |since| since.elapsed());
    by_pointer
        && waited < SUBMENU_GRACE
        && grace.origin.zip(submenu).is_some_and(|(origin, bounds)| {
            pointer != origin && heading_to_submenu(origin, bounds, pointer)
        })
}

/// The room a menu keeps from the window's edges.
const WINDOW_MARGIN: Pixels = px(8.);

/// One of a menu's items: its label, what it runs, and how it looks.
pub struct MenuAction {
    label: SharedString,
    icon: Option<Icon>,
    shortcut: Option<SharedString>,
    command: Option<Box<dyn Action>>,
    command_focus: Option<FocusHandle>,
    checked: Option<bool>,
    secondary: Option<Secondary>,
    disabled: bool,
    destructive: bool,
    run: Action0,
}

/// A row's secondary action: its glyph, the glyph's tooltip, and what it runs.
struct Secondary {
    icon: Icon,
    label: SharedString,
    run: Action0,
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
            command: None,
            command_focus: None,
            checked: None,
            secondary: None,
            disabled: false,
            destructive: false,
            run: Rc::new(run),
        }
    }

    /// An item that runs `command` on the focus the menu interrupted (the
    /// menu closes first, giving it back), its keys shown at the end.
    pub fn dispatch(label: impl Into<SharedString>, command: Box<dyn Action>) -> Self {
        let run = command.boxed_clone();
        let mut this = Self::new(label, move |window, cx| {
            window.dispatch_action(run.boxed_clone(), cx)
        });
        this.command = Some(command);
        this
    }

    /// [`MenuAction::dispatch`] on `focus` rather than the focus the menu
    /// interrupted: a panel's ⋯ item runs on its panel, wherever focus was.
    pub fn dispatch_on(
        label: impl Into<SharedString>,
        command: Box<dyn Action>,
        focus: FocusHandle,
    ) -> Self {
        let run = command.boxed_clone();
        let target = focus.clone();
        let mut this = Self::new(label, move |window, cx| {
            target.focus(window, cx);
            window.dispatch_action(run.boxed_clone(), cx)
        });
        this.command = Some(command);
        this.command_focus = Some(focus);
        this
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn shortcut(mut self, keys: impl Into<SharedString>) -> Self {
        self.shortcut = Some(keys.into());
        self
    }

    /// A second action on the row, `icon` at its end with `label` as its
    /// tooltip. It runs as the row does: the menu closes first.
    pub fn secondary(
        mut self,
        icon: Icon,
        label: impl Into<SharedString>,
        run: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.secondary = Some(Secondary {
            icon,
            label: label.into(),
            run: Rc::new(run),
        });
        self
    }

    /// A checkable item, and whether it is checked now.
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = Some(checked);
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

struct Submenu {
    label: SharedString,
    icon: Option<Icon>,
    build: BuildSubmenu,
}

enum Entry {
    Item(MenuAction),
    Submenu(Submenu),
    Label(SharedString),
    Separator,
}

impl Entry {
    fn enabled(&self) -> bool {
        match self {
            Entry::Item(action) => !action.disabled,
            Entry::Submenu(_) => true,
            Entry::Label(_) | Entry::Separator => false,
        }
    }

    fn is_rule(&self) -> bool {
        matches!(self, Entry::Separator)
    }
}

/// A menu: labelled groups of actions on the menu surface.
///
/// Drawn alone (in the gallery, or by a host that positions it) it is a
/// static list the pointer can still run; opened by a [`super::MenuPopover`]
/// or a context menu it takes focus, and the keys move its highlight.
#[derive(IntoElement)]
pub struct Menu {
    id: ElementId,
    entries: Vec<Entry>,
    focus: Option<FocusHandle>,
    on_dismiss: Option<Action0>,
    on_back: Option<Action0>,
    action_context: Option<FocusHandle>,
    highlighted: Option<usize>,
    min_width: Option<Pixels>,
    submenu_bounds: Option<SubmenuBounds>,
}

/// Where an open menu's submenus stood in the last frame. A submenu opens
/// beside its menu, outside the bounds of what dismisses the menu on a press
/// outside it, so that dismissal lets a press in here through.
#[derive(Clone, Default)]
pub(crate) struct SubmenuBounds(Rc<RefCell<Vec<Bounds<Pixels>>>>);

impl SubmenuBounds {
    /// Forget the last frame's submenus, before the menu draws again.
    pub(crate) fn clear(&self) {
        self.0.borrow_mut().clear();
    }

    pub(crate) fn contains(&self, point: Point<Pixels>) -> bool {
        self.0.borrow().iter().any(|bounds| bounds.contains(&point))
    }
}

impl Menu {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            entries: Vec::new(),
            focus: None,
            on_dismiss: None,
            on_back: None,
            action_context: None,
            highlighted: None,
            min_width: None,
            submenu_bounds: None,
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

    /// A rule between groups. A rule at the very top, or right after
    /// another, is dropped, so a builder can close each group with one
    /// without checking what came before; a trailing one is dropped when the
    /// menu draws.
    pub fn separator(mut self) -> Self {
        if self.entries.last().is_some_and(|last| !last.is_rule()) {
            self.entries.push(Entry::Separator);
        }
        self
    }

    /// A row that opens `build`'s menu beside it.
    pub fn submenu(
        mut self,
        label: impl Into<SharedString>,
        icon: Option<Icon>,
        build: impl Fn(Menu, &mut Window, &mut App) -> Menu + 'static,
    ) -> Self {
        self.entries.push(Entry::Submenu(Submenu {
            label: label.into(),
            icon,
            build: Rc::new(build),
        }));
        self
    }

    /// Whether the menu has nothing in it yet.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The narrowest the surface stands, over the 9rem every menu keeps.
    pub fn min_w(mut self, width: Pixels) -> Self {
        self.min_width = Some(width);
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

    /// The focus a [`MenuAction::dispatch`] item's keys are looked up on:
    /// the one the menu interrupted.
    pub fn action_context(mut self, focus: Option<FocusHandle>) -> Self {
        self.action_context = focus;
        self
    }

    /// Run after an item ran, to close whatever opened the menu.
    pub fn on_dismiss(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_dismiss = Some(Rc::new(handler));
        self
    }

    fn on_dismiss_rc(mut self, handler: Option<Action0>) -> Self {
        self.on_dismiss = handler;
        self
    }

    /// Record where this menu's submenus open, for what dismisses it.
    pub(crate) fn submenu_bounds(mut self, bounds: SubmenuBounds) -> Self {
        self.submenu_bounds = Some(bounds);
        self
    }

    /// ← or Escape in a submenu: back to the menu it opened from.
    fn on_back(mut self, handler: Action0) -> Self {
        self.on_back = Some(handler);
        self
    }
}

/// The menus drawn while a scripted run records them ([`record_menus`]):
/// each menu's latest frame, by its id, the newest last.
#[derive(Default)]
struct MenuProbes(Vec<(ElementId, MenuProbe)>);

impl Global for MenuProbes {}

struct MenuProbe {
    labels: Vec<Option<SharedString>>,
    hover: FluidHover,
    secondary: Entity<Option<usize>>,
}

/// What a menu shows now, for a scripted check.
#[derive(Clone, Debug, Default)]
pub struct MenuSnapshot {
    /// The rows the pointer and keys can reach, laid out in the last frame:
    /// index, label, and bounds in window coordinates.
    pub rows: Vec<(usize, SharedString, Bounds<Pixels>)>,
    /// The row the fill is on.
    pub lit: Option<usize>,
    /// The row whose secondary glyph the keys are on.
    pub on_secondary: Option<usize>,
}

/// Record every menu drawn from now on, for [`menu_snapshot`]. Only a
/// scripted run calls it; a menu records nothing otherwise.
pub fn record_menus(cx: &mut App) {
    if !cx.has_global::<MenuProbes>() {
        cx.set_global(MenuProbes::default());
    }
}

/// The menu drawn last with a row labelled `label`, as it shows now.
pub fn menu_snapshot(label: &str, cx: &App) -> Option<MenuSnapshot> {
    let (_, probe) = cx
        .try_global::<MenuProbes>()?
        .0
        .iter()
        .rev()
        .find(|(_, probe)| {
            probe
                .labels
                .iter()
                .any(|row| row.as_ref().is_some_and(|row| row == label))
        })?;
    let hover = probe.hover.snapshot(cx);
    Some(MenuSnapshot {
        rows: hover
            .rows
            .into_iter()
            .filter_map(|(ix, bounds, _)| {
                let label = probe.labels.get(ix).cloned().flatten()?;
                Some((ix, label, bounds))
            })
            .collect(),
        lit: hover.lit,
        on_secondary: *probe.secondary.read(cx),
    })
}

/// The keys bound to `command` where `context` is focused, else anywhere,
/// spelled as the menus spell them (`⌘B`, `Ctrl+B`).
fn keys_for(
    command: &dyn Action,
    context: Option<&FocusHandle>,
    window: &Window,
) -> Option<String> {
    let binding = context
        .and_then(|focus| window.highest_precedence_binding_for_action_in(command, focus))
        .or_else(|| {
            window.highest_precedence_binding_for_action_in_context(command, KeyContext::default())
        })?;
    let key = binding.keystrokes().first()?;
    Some(gpui_kit::component::kbd::Kbd::format(key.as_keystroke()))
}

impl RenderOnce for Menu {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        while self.entries.last().is_some_and(Entry::is_rule) {
            self.entries.pop();
        }
        let child = |name: &str| {
            ElementId::NamedChild(
                std::sync::Arc::new(self.id.clone()),
                name.to_string().into(),
            )
        };
        let initial = self.highlighted;
        let highlight = window.use_keyed_state(child("highlight"), cx, move |_, _| initial);
        let open_sub = window.use_keyed_state(child("submenu"), cx, |_, _| None::<(usize, bool)>);
        // The row whose secondary action the keys moved onto.
        let on_secondary = window.use_keyed_state(child("secondary"), cx, |_, _| None::<usize>);
        let sub_focus = window
            .use_keyed_state(child("submenu-focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let scroll = window
            .use_keyed_state(child("scroll"), cx, |_, _| ScrollHandle::new())
            .read(cx)
            .clone();
        let current = *highlight.read(cx);
        // One fill for the pointer and the keys, gliding between rows.
        let palette = cx.palette().clone();
        let hover = FluidHover::new(child("fluid"), window, cx)
            .fill(palette.accent_soft)
            .radius(shape::MENU.inner())
            .follow(current, cx);
        let lit = hover.lit(cx);
        let submenus: Rc<[bool]> = self
            .entries
            .iter()
            .map(|entry| matches!(entry, Entry::Submenu(_)))
            .collect();
        let is_submenu = |ix: Option<usize>| ix.is_some_and(|ix| submenus.get(ix) == Some(&true));
        // The pointer on a row opens its submenu, or closes the one open;
        // leaving the menu (for the submenu) keeps it, and so does a row
        // crossed on the way to the submenu, until the pointer rests there.
        let grace = window.use_keyed_state(child("grace"), cx, |_, _| Grace::default());
        let sub_bounds = window
            .use_keyed_state(child("submenu-bounds"), cx, |_, _| {
                Rc::new(Cell::new(None::<Bounds<Pixels>>))
            })
            .read(cx)
            .clone();
        let pointer = window.mouse_position();
        let open_at = open_sub.read(cx).map(|(ix, _)| ix);
        if let Some(at) = lit
            && open_at != Some(at)
        {
            let held = *grace.read(cx);
            if open_at.is_some()
                && hold_submenu(hover.by_pointer(cx), held, sub_bounds.get(), pointer)
            {
                if held.since.is_none() {
                    grace.update(cx, |grace, _| grace.since = Some(Instant::now()));
                    let view = window.current_view();
                    window
                        .spawn(cx, async move |cx| {
                            cx.background_executor().timer(SUBMENU_GRACE).await;
                            cx.update(|_, cx| cx.notify(view)).ok();
                        })
                        .detach();
                }
            } else {
                let next = is_submenu(Some(at)).then_some((at, false));
                open_sub.update(cx, |open, _| *open = next);
                // The move that lit the row came before the submenu opened,
                // so the row's own listener did not see it: a pointer that
                // opens the submenu starts its grace from where it stands.
                let origin = (next.is_some() && hover.by_pointer(cx)).then_some(pointer);
                grace.update(cx, |grace, _| {
                    *grace = Grace {
                        origin,
                        since: None,
                    }
                });
                if sub_focus.contains_focused(window, cx)
                    && let Some(focus) = &self.focus
                {
                    focus.focus(window, cx);
                }
            }
        }
        let enabled: Rc<[bool]> = self.entries.iter().map(Entry::enabled).collect();
        let checks = self
            .entries
            .iter()
            .any(|entry| matches!(entry, Entry::Item(action) if action.checked.is_some()));
        let actions: Rc<[Option<Action0>]> = self
            .entries
            .iter()
            .map(|entry| match entry {
                Entry::Item(action) if !action.disabled => Some(action.run.clone()),
                _ => None,
            })
            .collect();
        let secondaries: Rc<[Option<Action0>]> = self
            .entries
            .iter()
            .map(|entry| match entry {
                Entry::Item(action) if !action.disabled => action
                    .secondary
                    .as_ref()
                    .map(|secondary| secondary.run.clone()),
                _ => None,
            })
            .collect();
        if on_secondary.read(cx).is_some_and(|at| lit != Some(at)) {
            on_secondary.update(cx, |at, _| *at = None);
        }
        let keyed_secondary = *on_secondary.read(cx);
        if cx.has_global::<MenuProbes>() {
            let labels = self
                .entries
                .iter()
                .map(|entry| match entry {
                    Entry::Item(action) => Some(action.label.clone()),
                    Entry::Submenu(submenu) => Some(submenu.label.clone()),
                    Entry::Label(_) | Entry::Separator => None,
                })
                .collect();
            let probe = MenuProbe {
                labels,
                hover: hover.clone(),
                secondary: on_secondary.clone(),
            };
            let probes = &mut cx.global_mut::<MenuProbes>().0;
            probes.retain(|(id, _)| *id != self.id);
            probes.push((self.id.clone(), probe));
        }
        let dismiss = self.on_dismiss.clone();
        // Running an item closes the menu first, so the action finds focus
        // back where it was before the menu opened.
        let run = {
            let highlight = highlight.clone();
            let dismiss = dismiss.clone();
            move |action: &Action0, window: &mut Window, cx: &mut App| {
                highlight.update(cx, |at, _| *at = None);
                if let Some(dismiss) = dismiss.as_ref() {
                    dismiss(window, cx);
                }
                action(window, cx);
            }
        };
        let run = Rc::new(run);
        let open_by_keys = {
            let open_sub = open_sub.clone();
            let sub_focus = sub_focus.clone();
            move |at: usize, window: &mut Window, cx: &mut App| {
                open_sub.update(cx, |open, cx| {
                    *open = Some((at, true));
                    cx.notify();
                });
                sub_focus.focus(window, cx);
            }
        };
        let open_by_keys = Rc::new(open_by_keys);

        // A label or a separator starts a new section: the fill fades across
        // it instead of sliding through.
        let mut section = 0;
        let mut submenu_rows = Vec::new();
        let rows: Vec<AnyElement> = std::mem::take(&mut self.entries)
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
                Entry::Submenu(submenu) => {
                    let id = child(&format!("item-{ix}"));
                    let open_sub = open_sub.clone();
                    let leave = {
                        let (open_sub, grace) = (open_sub.clone(), grace.clone());
                        move |event: &MouseMoveEvent, _: &mut Window, cx: &mut App| {
                            if open_sub.read(cx).is_some_and(|(open, _)| open == ix) {
                                grace.update(cx, |grace, _| {
                                    *grace = Grace {
                                        origin: Some(event.position),
                                        since: None,
                                    }
                                });
                            }
                        }
                    };
                    let item = MenuItem::new(id, submenu.label.clone())
                        .when_some(submenu.icon, MenuItem::icon)
                        .check_gutter(checks.then_some(false))
                        .submenu()
                        .highlighted(hover.lit(cx) == Some(ix))
                        .fluid()
                        .on_mouse_move(leave)
                        .on_click(move |_, _, cx| {
                            open_sub.update(cx, |open, cx| {
                                *open = Some((ix, false));
                                cx.notify();
                            })
                        });
                    submenu_rows.push((ix, submenu));
                    hover.item_as(ix, ItemKind::target().section(section), item)
                }
                Entry::Item(action) => {
                    let id = child(&format!("item-{ix}"));
                    let runner = run.clone();
                    let run_action = action.run.clone();
                    let kind = if action.disabled || action.destructive {
                        ItemKind::skip()
                    } else {
                        ItemKind::target()
                    }
                    .section(section);
                    let shortcut = action.shortcut.clone().or_else(|| {
                        action.command.as_deref().and_then(|command| {
                            let context = action
                                .command_focus
                                .as_ref()
                                .or(self.action_context.as_ref());
                            keys_for(command, context, window).map(Into::into)
                        })
                    });
                    let gutter = checks.then(|| action.checked.unwrap_or(false));
                    let secondary = action.secondary.map(|secondary| {
                        let runner = run.clone();
                        IconButton::new(child(&format!("secondary-{ix}")), secondary.icon)
                            .frame(px(22.), px(22.))
                            .icon_size(ICON_SMALL)
                            .radius(px(4.))
                            .my(px(-1.))
                            .disabled(action.disabled)
                            .selected(keyed_secondary == Some(ix))
                            .tooltip(secondary.label)
                            .on_click(move |_, window, cx| {
                                cx.stop_propagation();
                                runner(&secondary.run, window, cx);
                            })
                    });
                    let item = MenuItem::new(id, action.label)
                        .when_some(action.icon, MenuItem::icon)
                        .when_some(shortcut, MenuItem::shortcut)
                        .check_gutter(gutter)
                        .when_some(secondary, MenuItem::accessory)
                        .disabled(action.disabled)
                        .destructive(action.destructive)
                        .highlighted(hover.lit(cx) == Some(ix))
                        .fluid()
                        .on_click(move |_, window, cx| runner(&run_action, window, cx));
                    hover.item_as(ix, kind, item)
                }
            })
            .collect();

        let submenu_open = *open_sub.read(cx);
        let submenu_layer = submenu_open.and_then(|(at, by_keys)| {
            let (_, submenu) = submenu_rows.iter().find(|(ix, _)| *ix == at)?;
            let row = hover.row_bounds(at, cx)?;
            let back: Action0 = {
                let open_sub = open_sub.clone();
                let focus = self.focus.clone();
                Rc::new(move |window: &mut Window, cx: &mut App| {
                    open_sub.update(cx, |open, cx| {
                        *open = None;
                        cx.notify();
                    });
                    if let Some(focus) = &focus {
                        focus.focus(window, cx);
                    }
                })
            };
            let mut menu = (submenu.build)(Menu::new(child(&format!("sub-{at}"))), window, cx)
                .track_focus(&sub_focus)
                .action_context(self.action_context.clone())
                .on_dismiss_rc(dismiss.clone())
                .on_back(back)
                .when_some(self.submenu_bounds.clone(), Menu::submenu_bounds);
            if by_keys && let Some(first) = menu.entries.iter().position(Entry::enabled) {
                menu = menu.highlighted(first);
            }
            Some(
                deferred(
                    anchored()
                        .position(point(row.right() + MENU_INSET, row.top() - MENU_INSET))
                        .snap_to_window_with_margin(WINDOW_MARGIN)
                        .child(
                            // A press in the submenu is inside the menu: it
                            // must not reach the dismissal of what opened it.
                            div()
                                .id(child(&format!("sub-layer-{at}")))
                                .relative()
                                .occlude()
                                .child({
                                    let own = sub_bounds.clone();
                                    canvas(
                                        move |bounds, _, _| own.set(Some(bounds)),
                                        |_, _, _, _| {},
                                    )
                                    .absolute()
                                    .inset_0()
                                })
                                .when_some(self.submenu_bounds.clone(), |this, record| {
                                    this.child(
                                        canvas(
                                            move |bounds, _, _| record.0.borrow_mut().push(bounds),
                                            |_, _, _, _| {},
                                        )
                                        .absolute()
                                        .inset_0(),
                                    )
                                })
                                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
                                .child(pop_in(
                                    child(&format!("sub-pop-{at}")),
                                    PopFrom::Above,
                                    menu,
                                )),
                        ),
                )
                .with_priority(POPUP_PRIORITY + 1)
                .into_any_element(),
            )
        });

        let keys = {
            let highlight = highlight.clone();
            let hover = hover.clone();
            let back = self.on_back.clone();
            let submenus = submenus.clone();
            let on_secondary = on_secondary.clone();
            move |event: &KeyDownEvent, window: &mut Window, cx: &mut App| {
                // The keys go on from the row the pointer lit, as a menu's
                // roving highlight does in the app.
                let at = hover.lit(cx);
                let on_submenu = at.is_some_and(|at| submenus.get(at).copied().unwrap_or(false));
                let secondary = at.and_then(|at| secondaries.get(at).cloned().flatten());
                let keyed = keyed_secondary.is_some() && keyed_secondary == at;
                let key_to_secondary = |row: Option<usize>, cx: &mut App| {
                    on_secondary.update(cx, |current, cx| {
                        *current = row;
                        cx.notify();
                    });
                };
                let step = match event.keystroke.key.as_str() {
                    "right" if secondary.is_some() && !keyed => {
                        cx.stop_propagation();
                        key_to_secondary(at, cx);
                        return;
                    }
                    "left" if keyed => {
                        cx.stop_propagation();
                        key_to_secondary(None, cx);
                        return;
                    }
                    "enter" | "space" if keyed && secondary.is_some() => {
                        cx.stop_propagation();
                        key_to_secondary(None, cx);
                        if let Some(action) = secondary {
                            run(&action, window, cx);
                        }
                        return;
                    }
                    "down" => Step::Next,
                    "up" => Step::Previous,
                    "home" => Step::First,
                    "end" => Step::Last,
                    "right" if on_submenu => {
                        cx.stop_propagation();
                        open_by_keys(at.unwrap_or_default(), window, cx);
                        return;
                    }
                    "left" | "escape" if back.is_some() => {
                        cx.stop_propagation();
                        if let Some(back) = back.as_ref() {
                            back(window, cx);
                        }
                        return;
                    }
                    "enter" | "space" => {
                        if on_submenu {
                            cx.stop_propagation();
                            open_by_keys(at.unwrap_or_default(), window, cx);
                        } else if let Some(action) =
                            at.and_then(|at| actions.get(at).cloned().flatten())
                        {
                            cx.stop_propagation();
                            run(&action, window, cx);
                        }
                        return;
                    }
                    _ => return,
                };
                cx.stop_propagation();
                key_to_secondary(None, cx);
                let next = step_highlight(&enabled, at, step);
                hover.key_to(next, cx);
                highlight.update(cx, |current, cx| {
                    *current = next;
                    cx.notify();
                });
            }
        };

        let max_height = window.viewport_size().height - WINDOW_MARGIN * 2.;
        let fill = hover.highlight();
        div()
            .id(self.id.clone())
            .when_some(self.focus, |this, focus| {
                this.track_focus(&focus).on_key_down(keys)
            })
            .child(
                MenuSurface::new()
                    .p_0()
                    .max_h(max_height)
                    .when_some(self.min_width, |this, width| this.min_w(width))
                    .child(
                        // The fill and the bar are laid over the rows'
                        // viewport, which clips them; the viewport keeps the
                        // surface's inset, so a separator still runs to the
                        // surface's edge.
                        div()
                            .relative()
                            .flex()
                            .flex_col()
                            .min_h_0()
                            .child(fill)
                            .child(
                                div()
                                    .id(child("rows"))
                                    .flex()
                                    .flex_col()
                                    .p(MENU_INSET)
                                    .max_h(max_height)
                                    .overflow_y_scroll()
                                    .track_scroll(&scroll)
                                    .children(rows),
                            )
                            .child(
                                FluidScrollbar::vertical(child("bar"), &scroll)
                                    .feel(ScrollbarFeel::LIST),
                            ),
                    ),
            )
            .children(submenu_layer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(label: &'static str) -> MenuAction {
        MenuAction::new(label, |_, _| {})
    }

    fn shape(menu: &Menu) -> Vec<&'static str> {
        menu.entries
            .iter()
            .map(|entry| match entry {
                Entry::Item(_) => "item",
                Entry::Submenu(_) => "submenu",
                Entry::Label(_) => "label",
                Entry::Separator => "rule",
            })
            .collect()
    }

    #[test]
    fn the_pointer_keeps_a_submenu_open_on_its_way_there() {
        // A submenu 160 wide beside its row, which the pointer left at
        // (100, 50): the submenu's near edge runs from (110, 40) to (110, 200).
        let submenu = Bounds::new(point(px(110.), px(40.)), gpui::size(px(160.), px(160.)));
        let origin = point(px(100.), px(50.));
        // Down and to the right, toward its third row: on the way.
        assert!(heading_to_submenu(
            origin,
            submenu,
            point(px(105.), px(80.))
        ));
        // Straight down the parent menu, or back left: not.
        assert!(!heading_to_submenu(
            origin,
            submenu,
            point(px(100.), px(90.))
        ));
        assert!(!heading_to_submenu(
            origin,
            submenu,
            point(px(80.), px(60.))
        ));
        // A submenu that opened to the left, against the window's edge.
        let left = Bounds::new(point(px(-70.), px(40.)), gpui::size(px(160.), px(160.)));
        assert!(heading_to_submenu(origin, left, point(px(95.), px(70.))));
        assert!(!heading_to_submenu(origin, left, point(px(105.), px(70.))));
    }

    #[test]
    fn only_the_pointer_on_its_way_holds_a_submenu_open() {
        let submenu = Some(Bounds::new(
            point(px(110.), px(40.)),
            gpui::size(px(160.), px(160.)),
        ));
        let left_row = Grace {
            origin: Some(point(px(100.), px(50.))),
            since: None,
        };
        let on_the_way = point(px(105.), px(80.));
        // The pointer crossing a row toward the submenu holds it.
        assert!(hold_submenu(true, left_row, submenu, on_the_way));
        // The keys moving the highlight there switch at once, as Radix's do.
        assert!(!hold_submenu(false, left_row, submenu, on_the_way));
        // A pointer that rested on that row past the grace switches.
        let rested = Grace {
            since: Some(Instant::now() - SUBMENU_GRACE),
            ..left_row
        };
        assert!(!hold_submenu(true, rested, submenu, on_the_way));
        // With no recorded exit from the submenu's row, nothing holds.
        assert!(!hold_submenu(true, Grace::default(), submenu, on_the_way));
    }

    #[test]
    fn a_rule_never_leads_a_menu_or_doubles_up() {
        // A builder closes each group with a rule without checking what came
        // before (the panel's own items may be none).
        let menu = Menu::new("m")
            .separator()
            .item(action("Float"))
            .separator()
            .separator()
            .item(action("Close"));
        assert_eq!(shape(&menu), ["item", "rule", "item"]);
        assert!(Menu::new("empty").separator().is_empty());
    }

    #[test]
    fn a_command_item_keeps_its_command_and_its_focus() {
        let item = MenuAction::dispatch("Build", Box::new(gpui::NoAction));
        assert!(item.command.is_some());
        assert!(item.command_focus.is_none());
        assert_eq!(item.checked, None);
        assert_eq!(item.checked(true).checked, Some(true));
    }

    #[test]
    fn only_items_and_submenus_take_the_highlight() {
        let menu = Menu::new("m")
            .label("Panels")
            .item(action("Project"))
            .item(action("Agent").disabled(true))
            .separator()
            .submenu("Move to", None, |menu, _, _| menu);
        let enabled: Vec<bool> = menu.entries.iter().map(Entry::enabled).collect();
        assert_eq!(enabled, [false, true, false, false, true]);
    }
}
