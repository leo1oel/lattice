//! Dragging a window's project tabs, as the Tauri app drags them
//! (`use-project-tab-drag.ts`, `project-tab-drag-session.ts`,
//! `project-tab-hit.ts`, `project-tab-drop.ts`, `project-tab-moves.ts`):
//!
//! - A left press on a tab (not its close button, not with ⌃) moved 5px
//!   any way lifts it: drawn at 55% with the grabbing hand, the press's
//!   click then switching nothing. Escape puts it back.
//! - Over its own strip a 2px line shows where it would go, before the
//!   first tab whose middle is past the pointer, or at the end; letting go
//!   there moves it, and only then.
//! - Let go over no window of the app, it gets a window of its own
//!   (`move_project_to_window`); a project alone in its window stays.
//! - Over another window's strip that window draws the line, and letting go
//!   moves the project there, in front, where the line was: the window it
//!   leaves goes on with its right-hand neighbour (else its left) and closes
//!   when it held no other. Each window first asks, while something runs in
//!   its shown project, and saves its edits; a refusal or a failed save
//!   leaves the tab where it was. The editors' places come back through
//!   `place_memory`, the arrangement through the workspaces library.
//! - Let go anywhere else (this window off its strip, another window off
//!   its strip, a window that is not a project window), nothing moves.
//!
//! The active tab's switcher opens its menu on a click rather than on the
//! press, so a press can become a drag: the press is held from it and, when
//! it ends as a click, given back.

use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};

use gpui::{
    AnyWindowHandle, App, Bounds, Context, DispatchPhase, Entity, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, Pixels, PlatformInput, Point, WeakEntity, Window,
};
use lattice_i18n::t;

use super::{Shell, parts::Part, windows};

/// How far a press moves before it is a drag (`DRAG_THRESHOLD`, Euclidean).
const DRAG_THRESHOLD: f32 = 5.;
/// A line drawn for another window's drag goes this long after its last
/// hover (`HOVER_EXPIRY_MS`).
const HOVER_EXPIRY: Duration = Duration::from_millis(350);

/// Where a tab would go: before `before` (the end with none), its line
/// `x` from the strip's left edge.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Slot {
    pub before: Option<PathBuf>,
    pub x: Pixels,
}

/// The strip and its tabs as last drawn, in window coordinates.
#[derive(Default)]
pub(crate) struct StripBounds {
    pub strip: Option<Bounds<Pixels>>,
    pub tabs: Vec<(PathBuf, Bounds<Pixels>)>,
}

impl StripBounds {
    /// The slot at `point`, leaving `dragged` out (`project-tab-hit.ts`):
    /// none off the strip.
    pub(crate) fn slot(&self, point: Point<Pixels>, dragged: Option<&Path>) -> Option<Slot> {
        let strip = self.strip?;
        let inside = point.x >= strip.left()
            && point.x < strip.right()
            && point.y >= strip.top()
            && point.y < strip.bottom();
        if !inside {
            return None;
        }
        let mut last = None;
        for (root, tab) in &self.tabs {
            if Some(root.as_path()) == dragged {
                continue;
            }
            if point.x < tab.left() + tab.size.width / 2. {
                return Some(Slot {
                    before: Some(root.clone()),
                    x: tab.left() - strip.left(),
                });
            }
            last = Some(tab.right() - strip.left());
        }
        Some(Slot {
            before: None,
            x: last.unwrap_or(gpui::px(0.)),
        })
    }
}

/// A press on a tab, and where it began.
struct Press {
    root: PathBuf,
    start: Point<Pixels>,
    /// The press was held from the active tab's switcher, to be given back
    /// when it ends as a click.
    held: Option<MouseDownEvent>,
}

/// What the part keeps between frames.
#[derive(Default)]
pub(crate) struct ProjectTabDrag {
    press: Option<Press>,
    /// The project being dragged.
    pub(crate) dragging: Option<PathBuf>,
    /// The line over this window's strip, for its own drag.
    pub(crate) slot: Option<Slot>,
    /// The line another window's drag draws here, and when it last moved.
    pub(crate) incoming: Option<(Slot, std::time::Instant)>,
    /// The window this drag's line is drawn in, when not this one.
    peer: Option<AnyWindowHandle>,
    /// A press given back to the switcher passes the capture.
    replaying: bool,
    /// The click ending a drag switches nothing.
    pub(crate) suppress_click: bool,
    /// A tab is moving to or from this window ("Moving project tab…").
    pub(crate) moving: bool,
    pub(crate) bounds: Rc<RefCell<StripBounds>>,
    _escape: Option<gpui::Subscription>,
}

/// Where a release lands.
enum Target {
    /// Over no window of the app.
    Desktop,
    /// Over this window, off its strip, or over a window that takes no tab.
    Nowhere,
    /// Over another project window.
    Peer(AnyWindowHandle, Entity<Shell>),
}

impl Shell {
    fn drag(&self) -> &ProjectTabDrag {
        self.parts.get::<ProjectTabDrag>()
    }

    fn drag_mut(&mut self) -> &mut ProjectTabDrag {
        self.parts.get_mut::<ProjectTabDrag>()
    }

    /// The strip's bounds, recorded as it is drawn.
    pub(crate) fn project_strip_bounds(&self) -> Rc<RefCell<StripBounds>> {
        self.drag().bounds.clone()
    }

    /// The project being dragged, the line over this strip (this window's
    /// drag, or another's while fresh), and whether a tab is moving.
    pub(crate) fn project_drag_view(&self) -> (Option<PathBuf>, Option<Slot>, bool) {
        let drag = self.drag();
        let incoming = drag
            .incoming
            .as_ref()
            .filter(|(_, at)| at.elapsed() < HOVER_EXPIRY)
            .map(|(slot, _)| slot.clone());
        (
            drag.dragging.clone(),
            drag.slot.clone().or(incoming),
            drag.moving,
        )
    }

    /// Whether this window takes a dragged tab now (`dragEnabled`).
    pub(crate) fn takes_project_drops(&self, cx: &App) -> bool {
        self.project.is_some() && !self.drag().moving && !self.overlay_writing(cx)
    }

    /// Whether the click ending a drag should switch nothing; it is then
    /// spent.
    pub(crate) fn project_tab_click_suppressed(&mut self) -> bool {
        std::mem::take(&mut self.drag_mut().suppress_click)
    }

    /// A press on `root`'s tab. True when it is held from the tab's own
    /// handlers (the active tab's switcher, which opens on a press).
    pub(crate) fn press_project_tab(
        &mut self,
        root: PathBuf,
        event: &MouseDownEvent,
        active: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        if std::mem::take(&mut self.drag_mut().replaying) {
            return false;
        }
        let drag = self.drag_mut();
        drag.suppress_click = false;
        if event.button != MouseButton::Left
            || event.modifiers.control
            || !self.takes_project_drops(cx)
            || !(self.projects.len() > 1 || windows::other_project_window(cx.entity_id(), cx))
        {
            return false;
        }
        self.drag_mut().press = Some(Press {
            root,
            start: event.position,
            held: active.then(|| event.clone()),
        });
        cx.notify();
        active
    }

    /// Whether a press is under way, so the strip listens to the window.
    pub(crate) fn project_tab_pressed(&self) -> bool {
        self.drag().press.is_some()
    }

    fn project_drag_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(press) = &self.drag().press else {
            return;
        };
        if event.pressed_button != Some(MouseButton::Left) {
            self.end_project_drag(cx);
            return;
        }
        let root = press.root.clone();
        if self.drag().dragging.is_none() {
            let delta = event.position - press.start;
            let distance = (f32::from(delta.x).powi(2) + f32::from(delta.y).powi(2)).sqrt();
            if distance < DRAG_THRESHOLD {
                return;
            }
            let drag = self.drag_mut();
            drag.dragging = Some(root.clone());
            drag.suppress_click = true;
        }
        let slot = self
            .drag()
            .bounds
            .borrow()
            .slot(event.position, Some(&root));
        let peer = if slot.is_none() {
            match drop_target(window, event.position, cx) {
                Target::Peer(handle, shell) => Some((handle, shell)),
                _ => None,
            }
        } else {
            None
        };
        // The other window draws its line; the one it left loses it.
        let screen = window.bounds().origin + event.position;
        let previous = self.drag().peer;
        let now = peer.as_ref().map(|(handle, _)| *handle);
        if previous.is_some() && previous != now {
            clear_incoming(previous, cx);
        }
        if let Some((handle, shell)) = peer {
            hover_peer(handle, shell, screen, &root, cx);
        }
        let drag = self.drag_mut();
        drag.peer = now;
        drag.slot = slot;
        cx.notify();
    }

    fn project_drag_release(
        &mut self,
        event: &MouseUpEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(press) = self.drag_mut().press.take() else {
            return;
        };
        let dragging = self.drag_mut().dragging.take();
        let slot = self.drag_mut().slot.take();
        clear_incoming(self.drag_mut().peer.take(), cx);
        cx.notify();
        let Some(root) = dragging else {
            // A click: the switcher's held press is given back.
            if let Some(held) = press.held {
                give_back(held, event, window, cx);
            }
            return;
        };
        if let Some(slot) = slot {
            self.reorder_project(&root, slot.before.as_deref(), cx);
            return;
        }
        match drop_target(window, event.position, cx) {
            Target::Desktop => self.tear_off_project(root, window, cx),
            Target::Peer(handle, shell) => {
                let screen = window.bounds().origin + event.position;
                self.send_project_tab(root, handle, shell, screen, window, cx)
            }
            Target::Nowhere => {}
        }
    }

    /// Escape, or a release seen nowhere: the drag ends, nothing moved.
    fn end_project_drag(&mut self, cx: &mut Context<Self>) {
        let drag = self.drag_mut();
        drag.press = None;
        drag.dragging = None;
        drag.slot = None;
        let peer = drag.peer.take();
        clear_incoming(peer, cx);
        cx.notify();
    }

    /// `root` put before `before` (at the end with none, or when it is
    /// gone), as `windowProjects.reorder` does.
    pub(crate) fn reorder_project(
        &mut self,
        root: &Path,
        before: Option<&Path>,
        cx: &mut Context<Self>,
    ) {
        if before == Some(root) {
            return;
        }
        let Some(from) = self.projects.iter().position(|p| p.root == root) else {
            return;
        };
        let open = self.projects.remove(from);
        let at = before
            .and_then(|before| self.projects.iter().position(|p| p.root == before))
            .unwrap_or(self.projects.len());
        self.projects.insert(at, open);
        cx.notify();
    }

    /// `root` dropped over no window: a window of its own, unless it is this
    /// window's only project (moving the window is the titlebar's job).
    fn tear_off_project(&mut self, root: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        if self.projects.len() < 2 {
            return;
        }
        self.move_project_to_window(root, window, cx);
    }

    /// `root` dropped on `peer`'s window at `screen`: asked of that window,
    /// once this one has let it go (asked and saved when it is in front).
    fn send_project_tab(
        &mut self,
        root: PathBuf,
        handle: AnyWindowHandle,
        peer: Entity<Shell>,
        screen: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let active = self.root(cx).as_ref() == Some(&root);
        let source = cx.entity().downgrade();
        let go = {
            let (root, peer) = (root.clone(), peer.clone());
            move |window: &mut Window, cx: &mut App| {
                source
                    .update(cx, |shell, cx| {
                        shell.release_project_tab(
                            root.clone(),
                            handle,
                            peer.clone(),
                            screen,
                            window,
                            cx,
                        )
                    })
                    .ok();
            }
        };
        // Asked, it goes on once agreed; else at once, in this update.
        if active && self.confirm_leaving(go, |_| {}, window, cx) {
            return;
        }
        self.release_project_tab(root, handle, peer, screen, window, cx);
    }

    /// The source's half once agreed: the move under way, its edits saved,
    /// then the destination asked.
    fn release_project_tab(
        &mut self,
        root: PathBuf,
        handle: AnyWindowHandle,
        peer: Entity<Shell>,
        screen: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.takes_project_drops(cx) || !self.projects.iter().any(|p| p.root == root) {
            return;
        }
        let active = self.root(cx).as_ref() == Some(&root);
        self.drag_mut().moving = true;
        cx.notify();
        let saved = if active {
            self.save_layout(cx);
            self.save_before_leaving(cx)
        } else {
            None
        };
        let source = cx.entity().downgrade();
        let source_window = window.window_handle();
        cx.spawn_in(window, async move |this, cx| {
            if let Some(saved) = saved
                && !saved.await
            {
                this.update(cx, |this, cx| this.project_move_ended(cx)).ok();
                return;
            }
            let asked = handle.update(cx, |_, window, cx| {
                peer.update(cx, |peer, cx| {
                    peer.receive_project_tab(
                        root.clone(),
                        source.clone(),
                        source_window,
                        screen,
                        window,
                        cx,
                    )
                })
            });
            if asked.is_err() {
                this.update(cx, |this, cx| this.project_move_ended(cx)).ok();
            }
        })
        .detach();
    }

    /// The destination's half: refused while this window takes no tab or no
    /// slot is under `screen`; else asked, while something runs in its shown
    /// project, saved, and the project opened in front, where the line was.
    fn receive_project_tab(
        &mut self,
        root: PathBuf,
        source: WeakEntity<Shell>,
        source_window: AnyWindowHandle,
        screen: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let local = screen - window.bounds().origin;
        let slot = self.drag().bounds.borrow().slot(local, None);
        let refused = source.clone();
        let refuse = move |cx: &mut App| {
            let source = refused.clone();
            source_window
                .update(cx, |_, _, cx| {
                    source
                        .update(cx, |shell, cx| shell.project_move_ended(cx))
                        .ok();
                })
                .ok();
        };
        let (Some(slot), true) = (slot, self.takes_project_drops(cx)) else {
            refuse(cx);
            return;
        };
        let this = cx.entity().downgrade();
        let slot_before = slot.before.clone();
        let accept = {
            let (root, source, refuse) = (root.clone(), source.clone(), refuse.clone());
            move |window: &mut Window, cx: &mut App| {
                let (root, source, before, refuse) = (
                    root.clone(),
                    source.clone(),
                    slot.before.clone(),
                    refuse.clone(),
                );
                let taken = this.update(cx, |shell, cx| {
                    shell.take_project_tab(root, before, source, source_window, window, cx)
                });
                if taken.is_err() {
                    refuse(cx);
                }
            }
        };
        window.activate_window();
        if self.confirm_leaving(accept, refuse, window, cx) {
            return;
        }
        self.take_project_tab(root, slot_before, source, source_window, window, cx);
    }

    /// Agreed: this window saves, opens `root` and puts it before `before`;
    /// the source lets it go.
    fn take_project_tab(
        &mut self,
        root: PathBuf,
        before: Option<PathBuf>,
        source: WeakEntity<Shell>,
        source_window: AnyWindowHandle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.drag_mut().moving = true;
        self.save_layout(cx);
        let saved = self.save_before_leaving(cx);
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let end_source = |cx: &mut gpui::AsyncWindowContext| {
                source_window
                    .update(cx, |_, _, cx| {
                        source
                            .update(cx, |shell, cx| shell.project_move_ended(cx))
                            .ok();
                    })
                    .ok();
            };
            if let Some(saved) = saved
                && !saved.await
            {
                this.update(cx, |this, cx| this.project_move_ended(cx)).ok();
                end_source(cx);
                return;
            }
            let opened = crate::project::open(root.clone(), cx).await;
            let project = match opened {
                Ok(project) => project,
                Err(error) => {
                    cx.update(|_, cx| {
                        crate::notices::error(t!("Could not open the project"), error, cx)
                    })
                    .ok();
                    this.update(cx, |this, cx| this.project_move_ended(cx)).ok();
                    end_source(cx);
                    return;
                }
            };
            // The source still holds it, unchanged: it lets it go first.
            let let_go = source_window
                .update(cx, |_, window, cx| {
                    source
                        .update(cx, |shell, cx| shell.let_project_go(&root, window, cx))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            this.update_in(cx, |this, window, cx| {
                if let_go {
                    this.set_project(project, window, cx);
                    this.reorder_project(&root, before.as_deref(), cx);
                }
                this.project_move_ended(cx);
            })
            .ok();
        })
        .detach();
    }

    /// `root` leaves this window for another: its tab goes; when it was in
    /// front, its right-hand neighbour (else its left) comes in its place,
    /// and the window closes when it held no other. False when the tab is
    /// no longer here.
    fn let_project_go(&mut self, root: &Path, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.drag_mut().moving = false;
        let Some(index) = self.projects.iter().position(|p| p.root == root) else {
            cx.notify();
            return false;
        };
        if self.root(cx).as_deref() != Some(root) {
            self.projects.remove(index);
            cx.notify();
            return true;
        }
        match self.neighbour_of(root) {
            // Already saved: `leave_now` finds nothing to save.
            Some(next) => self.leave_now(next, Some(root.to_path_buf()), window, cx),
            None => window.remove_window(),
        }
        cx.notify();
        true
    }

    /// The move is over, done or refused.
    pub(crate) fn project_move_ended(&mut self, cx: &mut Context<Self>) {
        self.drag_mut().moving = false;
        cx.notify();
    }
}

/// While a tab is pressed, the window's pointer moves, release and Escape
/// drive the drag, wherever the pointer goes. Called from the strip's paint.
pub(crate) fn listen_while_pressed(shell: WeakEntity<Shell>, window: &mut Window) {
    let moved = shell.clone();
    window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
        if phase == DispatchPhase::Bubble {
            moved
                .update(cx, |shell, cx| shell.project_drag_move(event, window, cx))
                .ok();
        }
    });
    window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
        if phase == DispatchPhase::Bubble {
            shell
                .update(cx, |shell, cx| {
                    shell.project_drag_release(event, window, cx)
                })
                .ok();
        }
    });
}

/// Escape while a tab is lifted puts it back, before whatever has the
/// keyboard hears it, wherever the keyboard is (or none has it, as after a
/// press on the titlebar).
fn escape_drag(own: gpui::WindowId, cx: &mut App) -> gpui::Subscription {
    cx.intercept_keystrokes(move |event, window, cx| {
        if event.keystroke.key != "escape" || window.window_handle().window_id() != own {
            return;
        }
        let Some(shell) = windows::shell_of(window.window_handle(), cx) else {
            return;
        };
        shell.update(cx, |shell, cx| {
            if shell.drag().dragging.is_some() {
                cx.stop_propagation();
                shell.end_project_drag(cx);
            }
        });
    })
}

/// The window at `local` (this window's coordinates): the frontmost of the
/// app's windows whose frame holds it.
fn drop_target(window: &mut Window, local: Point<Pixels>, cx: &mut App) -> Target {
    let screen = window.bounds().origin + local;
    let own = window.window_handle();
    let stack = cx.window_stack().unwrap_or_else(|| cx.windows());
    for handle in stack {
        if handle.window_id() == own.window_id() {
            if window.bounds().contains(&screen) {
                return Target::Nowhere;
            }
            continue;
        }
        let Ok(bounds) = handle.update(cx, |_, window, _| window.bounds()) else {
            continue;
        };
        if !bounds.contains(&screen) {
            continue;
        }
        return match windows::shell_of(handle, cx) {
            Some(shell) => Target::Peer(handle, shell),
            None => Target::Nowhere,
        };
    }
    Target::Desktop
}

/// The drag's line drawn in `handle`'s strip, at `screen`, while it is over
/// it; it goes 350 ms after the last hover.
fn hover_peer(
    handle: AnyWindowHandle,
    shell: Entity<Shell>,
    screen: Point<Pixels>,
    root: &Path,
    cx: &mut App,
) {
    let root = root.to_path_buf();
    handle
        .update(cx, |_, window, cx| {
            let local = screen - window.bounds().origin;
            shell.update(cx, |shell, cx| {
                let slot = shell
                    .takes_project_drops(cx)
                    .then(|| shell.drag().bounds.borrow().slot(local, None))
                    .flatten()
                    .filter(|slot| slot.before.as_deref() != Some(root.as_path()));
                shell.drag_mut().incoming = slot.map(|slot| (slot, std::time::Instant::now()));
                cx.notify();
                // Redrawn once it has expired, unless another hover came.
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(HOVER_EXPIRY).await;
                    this.update(cx, |_, cx| cx.notify()).ok();
                })
                .detach();
            });
        })
        .ok();
}

fn clear_incoming(peer: Option<AnyWindowHandle>, cx: &mut App) {
    let Some(handle) = peer else {
        return;
    };
    let Some(shell) = windows::shell_of(handle, cx) else {
        return;
    };
    handle
        .update(cx, |_, _, cx| {
            shell.update(cx, |shell, cx| {
                shell.drag_mut().incoming = None;
                cx.notify();
            })
        })
        .ok();
}

/// A press held from the switcher, given back once it ended as a click: the
/// press and its release again, past the strip's capture.
fn give_back(held: MouseDownEvent, up: &MouseUpEvent, window: &mut Window, cx: &mut App) {
    let up = up.clone();
    window.defer(cx, move |window, cx| {
        if let Some(shell) = windows::shell_of(window.window_handle(), cx) {
            shell.update(cx, |shell, _| shell.drag_mut().replaying = true);
        }
        window.dispatch_event(PlatformInput::MouseDown(held), cx);
        window.dispatch_event(PlatformInput::MouseUp(up), cx);
    });
}

pub(super) const PART: Part = Part {
    install: |window, cx| {
        Box::new(ProjectTabDrag {
            _escape: Some(escape_drag(window.window_handle().window_id(), cx)),
            ..Default::default()
        })
    },
    views: &[],
    actions: |element, _| element,
    commands: super::parts::no_commands,
};

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{bounds, point, px, size};

    fn strip() -> StripBounds {
        let tab = |x: f32| bounds(point(px(x), px(4.)), size(px(100.), px(36.)));
        StripBounds {
            strip: Some(bounds(point(px(0.), px(0.)), size(px(320.), px(40.)))),
            tabs: vec![
                (PathBuf::from("/a"), tab(0.)),
                (PathBuf::from("/b"), tab(102.)),
                (PathBuf::from("/c"), tab(204.)),
            ],
        }
    }

    #[test]
    fn a_slot_is_before_the_first_tab_whose_middle_is_past_the_pointer() {
        // project-tab-hit.ts: x < (left + right) / 2, the dragged tab skipped.
        let strip = strip();
        let at = |x: f32, dragged: Option<&str>| {
            strip
                .slot(point(px(x), px(20.)), dragged.map(Path::new))
                .map(|slot| {
                    (
                        slot.before.map(|p| p.display().to_string()),
                        f32::from(slot.x),
                    )
                })
        };
        assert_eq!(at(10., None), Some((Some("/a".into()), 0.)));
        assert_eq!(at(60., None), Some((Some("/b".into()), 102.)));
        assert_eq!(at(60., Some("/b")), Some((Some("/c".into()), 204.)));
        assert_eq!(at(300., None), Some((None, 304.)));
        assert_eq!(at(300., Some("/c")), Some((None, 202.)));
        // Off the strip: no slot (its right and bottom edges are outside).
        assert_eq!(at(320., None), None);
        assert_eq!(strip.slot(point(px(10.), px(40.)), None), None);
    }
}
