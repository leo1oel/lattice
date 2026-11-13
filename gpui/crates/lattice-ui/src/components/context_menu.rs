//! A [`Menu`] opened by a right-click, where the pointer pressed.
//!
//! The Project tree's rows and its empty area, a project's tab in the
//! titlebar and a workspace chip open the same menu the app's buttons open
//! (`menu_list.rs`), on the pop tier, its top left corner at the pointer and
//! held 8px inside the window. It takes focus while open, so the arrow keys
//! reach it, and gives focus back when it closes: on a press outside it, on
//! Escape, or after an item ran (first, so the item's command runs where
//! focus was).
//!
//! A view keeps one [`ContextMenu`] per kind of menu, whatever it was opened
//! on (`T`, a tree row's path), marks what opens it with
//! [`context_menu_trigger`], and draws [`ContextMenu::layer`] among its
//! children:
//!
//! ```ignore
//! let menu = ContextMenu::<String>::keyed("tree-menu", window, cx);
//! div()
//!     .children(rows.map(|row| context_menu_trigger(row, &menu, path)))
//!     .children(ContextMenu::layer(&menu, window, cx, |menu, path, window, cx| { … }))
//! ```

use gpui::{
    AnyElement, App, Context, ElementId, Empty, Entity, FocusHandle, InteractiveElement,
    IntoElement, KeyDownEvent, MouseButton, ParentElement as _, Pixels, Point, RenderOnce,
    Styled as _, Window, anchored, deferred, div, point, px,
};
use gpui_kit::base::POPUP_PRIORITY;

use crate::components::{Menu, PopFrom, pop_in};

/// Where a context menu is open, and on what.
pub struct ContextMenu<T: Clone + 'static> {
    id: ElementId,
    open: Option<(Point<Pixels>, T)>,
    focus: FocusHandle,
    /// The focus the menu took over, given back when it closes.
    interrupted: Option<FocusHandle>,
}

impl<T: Clone + 'static> ContextMenu<T> {
    /// The menu keyed by `id`, kept while the view draws it.
    pub fn keyed(
        id: impl Into<ElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<ContextMenu<T>> {
        let id = id.into();
        window.use_keyed_state(id.clone(), cx, move |_, cx| ContextMenu {
            id,
            open: None,
            focus: cx.focus_handle(),
            interrupted: None,
        })
    }

    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// Whether the open menu holds keyboard focus.
    pub fn is_focused(&self, window: &Window) -> bool {
        self.open.is_some() && self.focus.is_focused(window)
    }

    /// What the open menu was opened on.
    pub fn target(&self) -> Option<&T> {
        self.open.as_ref().map(|(_, target)| target)
    }

    /// Open the menu on `target` at `at`, in window coordinates.
    pub fn open(
        &mut self,
        at: Point<Pixels>,
        target: T,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.open.is_none() {
            self.interrupted = window.focused(cx).filter(|focus| *focus != self.focus);
        }
        self.open = Some((at, target));
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// Close the menu and give focus back to what it took it from.
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open.take().is_none() {
            return;
        }
        if let Some(focus) = self.interrupted.take()
            && self.focus.contains_focused(window, cx)
        {
            focus.focus(window, cx);
        }
        cx.notify();
        window.refresh();
    }

    /// The open menu, built by `build` for its target: nothing while closed.
    ///
    /// The menu is built when the layer lays out, after the host's render has
    /// returned, so `build` may read the view that draws the layer (the
    /// Project tree reads itself for a row's items).
    pub fn layer(
        this: &Entity<Self>,
        window: &mut Window,
        cx: &mut App,
        build: impl Fn(Menu, &T, &mut Window, &mut App) -> Menu + 'static,
    ) -> Option<AnyElement> {
        let (id, at) = {
            let state = this.read(cx);
            let (at, _) = state.open.as_ref()?;
            (state.id.clone(), *at)
        };
        let child = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(id.clone()), name.into())
        };
        let menu = LazyMenu {
            id: child("menu"),
            state: this.clone(),
            build: Box::new(build),
        };
        let outside = this.clone();
        let escape = this.clone();
        Some(
            deferred(
                anchored().position(point(px(0.), px(0.))).child(
                    // The window under an open menu does not scroll, as
                    // under the app's.
                    div()
                        .id(child("scroll-guard"))
                        .w(window.viewport_size().width)
                        .h(window.viewport_size().height)
                        .on_scroll(|_, _, cx| cx.stop_propagation())
                        .child(
                            anchored()
                                .position(at)
                                .snap_to_window_with_margin(px(8.))
                                .child(
                                    div()
                                        .id(child("layer"))
                                        .occlude()
                                        .on_mouse_down_out(move |_, window, cx| {
                                            outside.update(cx, |menu, cx| menu.close(window, cx))
                                        })
                                        .on_key_down(move |event: &KeyDownEvent, window, cx| {
                                            if event.keystroke.key == "escape" {
                                                cx.stop_propagation();
                                                escape
                                                    .update(cx, |menu, cx| menu.close(window, cx));
                                            }
                                        })
                                        .child(pop_in(child("pop"), PopFrom::Above, menu)),
                                ),
                        ),
                ),
            )
            .with_priority(POPUP_PRIORITY)
            .into_any_element(),
        )
    }
}

type BuildMenu<T> = Box<dyn Fn(Menu, &T, &mut Window, &mut App) -> Menu>;

/// An open context menu, built when it lays out.
#[derive(IntoElement)]
struct LazyMenu<T: Clone + 'static> {
    id: ElementId,
    state: Entity<ContextMenu<T>>,
    build: BuildMenu<T>,
}

impl<T: Clone + 'static> RenderOnce for LazyMenu<T> {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (target, focus, interrupted) = {
            let state = self.state.read(cx);
            (
                state.target().cloned(),
                state.focus.clone(),
                state.interrupted.clone(),
            )
        };
        let Some(target) = target else {
            return Empty.into_any_element();
        };
        let dismiss = self.state.clone();
        (self.build)(Menu::new(self.id), &target, window, cx)
            .track_focus(&focus)
            .action_context(interrupted)
            .on_dismiss(move |window, cx| dismiss.update(cx, |menu, cx| menu.close(window, cx)))
            .into_any_element()
    }
}

/// Open `menu` on `target` where `element` is right-clicked. The press stops
/// here, so a row's menu opens instead of its list's.
pub fn context_menu_trigger<E: InteractiveElement, T: Clone + 'static>(
    element: E,
    menu: &Entity<ContextMenu<T>>,
    target: T,
) -> E {
    let menu = menu.clone();
    element.on_mouse_down(MouseButton::Right, move |event, window, cx| {
        cx.stop_propagation();
        let target = target.clone();
        menu.update(cx, |menu, cx| menu.open(event.position, target, window, cx));
    })
}
