//! The layout switch's track as the Tauri app drives it
//! (`trellis-workspace-switch.tsx`):
//!
//! - Drag to reorder: a press on a tab moved 4px along the track picks it
//!   up (with two workspaces or more); it then takes the place of every tab
//!   whose middle the pointer passes, the order saved as it goes, drawn at
//!   70% with the grabbing hand. Letting go ends it, and that press switches
//!   nothing.
//! - Keyboard: the project's workspace is the track's one tab stop; ← and →
//!   (round the ends), Home and End move to a workspace and switch to it,
//!   F2 renames it, and ⇧F10 opens its menu under it.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use gpui::{
    App, Bounds, Context, DispatchPhase, FocusHandle, KeyDownEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, Pixels, WeakEntity, Window,
};

use crate::shell::{Shell, workspaces::Workspaces};

/// The tabs' menu: a workspace's id, and whether the project's layout
/// differs from it.
type TabMenu = gpui::Entity<lattice_ui::components::ContextMenu<(String, bool)>>;

/// How far a press moves along the track before it is a drag.
const DRAG_THRESHOLD: f32 = 4.;

/// What the track keeps between frames.
#[derive(Default)]
pub(crate) struct TrackState {
    /// Each workspace tab's keyboard focus, by workspace id.
    focus: Rc<RefCell<HashMap<String, FocusHandle>>>,
    /// Each workspace tab's bounds as last drawn, by workspace id.
    pub(super) bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    /// A press on a tab: its workspace and where along the track it began.
    press: Option<(String, Pixels)>,
    /// The workspace being dragged.
    pub(crate) dragging: Option<String>,
    /// The name typed in the rename field is another workspace's.
    pub(crate) taken: bool,
    /// The tabs' menu, as last drawn (for a scenario's check).
    pub(super) menu: RefCell<Option<TabMenu>>,
}

impl Shell {
    /// Workspace `id`'s tab focus, made the first time it is asked for.
    pub(super) fn workspace_tab_focus(&self, id: &str, cx: &mut App) -> FocusHandle {
        self.layout
            .track
            .focus
            .borrow_mut()
            .entry(id.to_string())
            .or_insert_with(|| cx.focus_handle())
            .clone()
    }

    /// A left press on workspace `id`'s tab.
    pub(super) fn press_workspace(&mut self, id: &str, event: &MouseDownEvent) {
        if event.button == MouseButton::Left {
            self.layout.track.press = Some((id.to_string(), event.position.x));
        }
    }

    /// Whether a click on a tab is the end of a drag, which switches
    /// nothing.
    pub(super) fn tab_click_suppressed(&self) -> bool {
        self.layout.track.dragging.is_some()
    }

    /// The pointer moved with a tab pressed: past the threshold it drags
    /// that workspace, which then takes the place of each tab whose middle
    /// the pointer passes.
    fn drag_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some((id, start)) = self.layout.track.press.clone() else {
            return;
        };
        if event.pressed_button != Some(MouseButton::Left) {
            self.drag_end(cx);
            return;
        }
        let count = Workspaces::global(cx).list().len();
        if self.layout.track.dragging.is_none() {
            if count < 2 || f32::from((event.position.x - start).abs()) < DRAG_THRESHOLD {
                return;
            }
            self.layout.track.dragging = Some(id.clone());
            cx.notify();
        }
        let x = event.position.x;
        let bounds = self.layout.track.bounds.borrow();
        let before = Workspaces::global(cx)
            .list()
            .iter()
            .filter(|entry| entry.id != id)
            .filter(|entry| {
                bounds
                    .get(&entry.id)
                    .is_some_and(|tab| tab.left() + tab.size.width / 2. < x)
            })
            .count();
        drop(bounds);
        if Workspaces::global(cx).index_of(&id) != Some(before) {
            Workspaces::update(cx, |library| library.move_to(&id, before));
            cx.notify();
        }
    }

    /// The pointer let go: a drag ends where it is.
    fn drag_end(&mut self, cx: &mut Context<Self>) {
        let track = &mut self.layout.track;
        track.press = None;
        if track.dragging.take().is_some() {
            cx.notify();
        }
    }

    /// The track's keys on workspace `id`'s tab: ← → Home End switch, F2
    /// renames, ⇧F10 opens the tab's menu (`open_menu`, at the tab's
    /// lower-left corner).
    pub(super) fn workspace_tab_key(
        &mut self,
        id: &str,
        event: &KeyDownEvent,
        open_menu: &dyn Fn(gpui::Point<Pixels>, &mut Window, &mut App),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let keystroke = &event.keystroke;
        let ids: Vec<String> = Workspaces::global(cx)
            .list()
            .iter()
            .map(|entry| entry.id.clone())
            .collect();
        let Some(at) = ids.iter().position(|entry| entry == id) else {
            return;
        };
        let modifiers = keystroke.modifiers;
        let plain = !modifiers.platform && !modifiers.control && !modifiers.alt;
        let target = match keystroke.key.as_str() {
            "left" if plain && !modifiers.shift => Some((at + ids.len() - 1) % ids.len()),
            "right" if plain && !modifiers.shift => Some((at + 1) % ids.len()),
            "home" if plain && !modifiers.shift => Some(0),
            "end" if plain && !modifiers.shift => Some(ids.len() - 1),
            "f2" if plain && !modifiers.shift => {
                cx.stop_propagation();
                self.start_rename(id, window, cx);
                return;
            }
            "f10" if plain && modifiers.shift => {
                cx.stop_propagation();
                if let Some(tab) = self.layout.track.bounds.borrow().get(id).copied() {
                    open_menu(tab.bottom_left(), window, cx);
                }
                return;
            }
            _ => None,
        };
        let Some(target) = target else {
            return;
        };
        cx.stop_propagation();
        let next = ids[target].clone();
        self.switch_workspace(&next, window, cx);
        let focus = self.workspace_tab_focus(&next, cx);
        window.focus(&focus, cx);
    }

    /// The keyboard back on workspace `id`'s tab (after its rename).
    pub(crate) fn focus_workspace_tab(&self, id: &str, window: &mut Window, cx: &mut App) {
        let focus = self.workspace_tab_focus(id, cx);
        window.focus(&focus, cx);
    }
}

/// While a tab is pressed, the window's pointer moves and release drive the
/// drag, wherever the pointer goes (the Tauri app listens on `window`).
/// Called from the track's paint.
pub(super) fn listen_while_pressed(shell: WeakEntity<Shell>, window: &mut Window) {
    let moved = shell.clone();
    window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
        if phase == DispatchPhase::Bubble {
            moved.update(cx, |shell, cx| shell.drag_move(event, cx)).ok();
        }
    });
    window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
        if phase == DispatchPhase::Bubble {
            shell.update(cx, |shell, cx| shell.drag_end(cx)).ok();
        }
    });
}

impl TrackState {
    /// Whether workspace `id` has a tab drawn (not folded into the menu).
    pub(super) fn has_tab(&self, id: &str) -> bool {
        self.bounds.borrow().contains_key(id)
    }
}

impl Shell {
    /// Whether a tab is pressed, so the track listens to the window.
    pub(super) fn workspace_pressed(&self) -> bool {
        self.layout.track.press.is_some()
    }
}

/// What a scenario reads of the track.
#[cfg(any(target_os = "macos", target_os = "windows"))]
impl Shell {
    /// Workspace `id`'s tab as last drawn, in window coordinates.
    pub fn workspace_tab_bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.layout.track.bounds.borrow().get(id).copied()
    }

    /// Whether workspace `id`'s tab has the keyboard.
    pub fn workspace_tab_focused(&self, id: &str, window: &Window) -> bool {
        self.layout
            .track
            .focus
            .borrow()
            .get(id)
            .is_some_and(|focus| focus.is_focused(window))
    }

    /// The workspace whose tab menu is open, if any.
    pub fn workspace_menu_open(&self, cx: &App) -> Option<String> {
        let menu = self.layout.track.menu.borrow().clone()?;
        let menu = menu.read(cx);
        menu.is_open().then(|| menu.target().map(|(id, _)| id.clone())).flatten()
    }

    /// The workspace being renamed, and whether the name typed is taken.
    pub fn workspace_renaming(&self) -> (Option<String>, bool) {
        (self.layout.renaming.clone(), self.layout.track.taken)
    }
}
