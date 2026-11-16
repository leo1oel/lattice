//! Sheets and drawers: the two larger surfaces a tool or a long form opens
//! in, and the modal layer that holds either over the window.
//!
//! - A sheet is the app's `SheetDialog` (dialogs.css `.modal.sheet-dialog`):
//!   a dialog of Settings' size, 860 × 640 or the window less 20px a side,
//!   14px corners at the dialog level on the lift. Its title row is the
//!   drawers' 40px header (the title, the icon-only X), its content 14px in
//!   with 12px between sections, and its actions sit at the foot over a
//!   hairline; title and actions stay put while a long form scrolls
//!   between them. It rises 6px into place from 98% and fades on the slow
//!   tier, as a dialog does (`overlays::rise_in`).
//! - A drawer is the app's right-edge `ResizableDrawer` (surfaces.css
//!   `.resizable-drawer`): the window's full height on the input surface at
//!   the floating level, square to the window edge, its content 14px in
//!   under the same 40px header. It travels in 24px from the right and fades
//!   on the slow tier.
//!
//! [`ModalLayer`] holds one over the window on GPUI Kit's headless sheet
//! host (`gpui_kit::base::Sheet`), which owns the focus trap, Escape and the
//! press on the scrim that closes it. The layer is deferred, as Kit's dialogs
//! are, so it is drawn on the window's overlay surface, above a webview
//! island rather than under it. The scrim fades in on the slow tier
//! with its surface: the dialog scrim behind a sheet, the lighter
//! `--scrim-surface` behind a drawer.

use std::{cell::RefCell, collections::HashMap, rc::Rc, time::Instant};

use gpui::{
    AnimationExt as _, AnyElement, App, ElementId, FocusHandle, Hsla, InteractiveElement as _,
    IntoElement, ParentElement, Pixels, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, WeakEntity, Window, deferred, div, hsla, prelude::FluentBuilder as _, px,
};
use gpui_kit::base::Sheet as SheetHost;

use crate::{
    ActiveLattice as _, Elevation,
    components::{PanelHeader, rise_in, sink_out},
    motion::{Exit, Motion},
    tokens::CONTAINER_DIALOG_LARGE,
};

type CloseHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// The edge every sheet and drawer section keeps (`--drawer-content-inset`).
pub const DRAWER_INSET: Pixels = px(14.);
/// The history drawer's width (`min(460px, 100%)`), and the narrowest a
/// drawer is dragged to (`MIN_DRAWER_WIDTH`).
pub const DRAWER_WIDTH: Pixels = px(460.);
pub const DRAWER_MIN_WIDTH: Pixels = px(320.);
/// Settings' height, which a sheet shares (`--dialog-large-height`).
const SHEET_HEIGHT: Pixels = px(640.);

/// The app's `--scrim-surface`, one value in both appearances; it is not in
/// the token export, which holds only the dialog scrim.
fn drawer_scrim() -> Hsla {
    hsla(0., 0., 0., 0.18)
}

/// Wrap a surface so it enters on the slow tier: it fades in and travels the
/// last `(dx, dy)` into place. Keyed by `id`, so it plays once.
fn slide_in(id: ElementId, dx: f32, dy: f32, content: impl IntoElement) -> AnyElement {
    div()
        .relative()
        .size_full()
        .child(content)
        .with_animation(id, Motion::Slow.animation(), move |this, progress| {
            let rest = 1. - progress;
            this.left(px(dx * rest))
                .top(px(dy * rest))
                .opacity(progress.clamp(0., 1.))
        })
        .into_any_element()
}

#[derive(IntoElement)]
pub struct Sheet {
    id: ElementId,
    title: SharedString,
    size: Option<(Pixels, Pixels)>,
    children: Vec<AnyElement>,
    actions: Vec<AnyElement>,
    on_close: Option<CloseHandler>,
}

impl Sheet {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            size: None,
            children: Vec::new(),
            actions: Vec::new(),
            on_close: None,
        }
    }

    /// A size other than Settings' (the gallery draws a smaller one).
    pub fn size(mut self, width: Pixels, height: Pixels) -> Self {
        self.size = Some((width, height));
        self
    }

    /// Actions at the foot, left to right; Cancel first, the answer last.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for Sheet {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Sheet {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        let viewport = window.viewport_size();
        let (width, height) = self.size.unwrap_or_else(|| {
            (
                CONTAINER_DIALOG_LARGE
                    .to_pixels(window.rem_size())
                    .min(viewport.width - px(40.)),
                SHEET_HEIGHT.min(viewport.height - px(40.)),
            )
        });
        let child = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), name.into())
        };
        let header = PanelHeader::new(child("close"), self.title)
            .when_some(self.on_close, |this, on_close| {
                this.on_close(move |_, window, cx| on_close(window, cx))
            });
        let card = div()
            .flex()
            .flex_col()
            .w(width)
            .h(height)
            .rounded(px(14.))
            .overflow_hidden()
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(palette))
            .child(header)
            .child(
                div()
                    .id(child("body"))
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .p(DRAWER_INSET)
                    .children(self.children),
            )
            .when(!self.actions.is_empty(), |this| {
                this.child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .px(DRAWER_INSET)
                        .pt(px(12.))
                        .pb(DRAWER_INSET)
                        .border_t_1()
                        .border_color(palette.line)
                        .children(self.actions),
                )
            });
        div().w(width).h(height).child(rise_in(child("rise"), card))
    }
}

#[derive(IntoElement)]
pub struct Drawer {
    id: ElementId,
    title: SharedString,
    width: Pixels,
    children: Vec<AnyElement>,
    on_close: Option<CloseHandler>,
    scroll: Option<gpui::ScrollHandle>,
}

impl Drawer {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            width: DRAWER_WIDTH,
            children: Vec::new(),
            on_close: None,
            scroll: None,
        }
    }

    /// The handle the drawer's body scrolls by, for its owner to move it.
    pub fn track_scroll(mut self, scroll: &gpui::ScrollHandle) -> Self {
        self.scroll = Some(scroll.clone());
        self
    }

    /// The drawer's width, never under 320px.
    pub fn width(mut self, width: Pixels) -> Self {
        self.width = width.max(DRAWER_MIN_WIDTH);
        self
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for Drawer {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Drawer {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette();
        let child = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), name.into())
        };
        let header = PanelHeader::new(child("close"), self.title)
            .when_some(self.on_close, |this, on_close| {
                this.on_close(move |_, window, cx| on_close(window, cx))
            });
        let panel = div()
            .flex()
            .flex_col()
            .size_full()
            .bg(palette.input)
            .shadow(Elevation::Floating.shadows(palette))
            .child(header)
            .child(
                div()
                    .id(child("body"))
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .when_some(self.scroll, |body, scroll| body.track_scroll(&scroll))
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .p(DRAWER_INSET)
                    .children(self.children),
            );
        div()
            .w(self.width)
            .h_full()
            .child(slide_in(child("slide"), 24., 0., panel))
    }
}

/// Where a [`ModalLayer`] stands its surface.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum LayerPlacement {
    /// Centred, over the dialog scrim: a sheet or a dialog.
    #[default]
    Center,
    /// A small dialog over the dialog scrim, its top at 18% of the window
    /// where the eye already is, and staying put as a list under it grows;
    /// one taller than the room below rises just enough to keep 20px under
    /// it (dialogs.css: `.modal-dialog-content` for a `.modal` that is not a
    /// sheet, a large modal or a confirmation).
    UpperThird,
    /// Against the right edge, the window's height, over the lighter scrim:
    /// a drawer.
    Right,
}

thread_local! {
    // When each layer began leaving, by its window and id: a close comes
    // from an event handler, outside the layer's render, where its keyed
    // state cannot be reached. Main thread only.
    static CLOSING: RefCell<HashMap<(gpui::WindowId, ElementId), Leaving>> =
        RefCell::default();
}

/// A layer's focus state, kept while the layer draws under its id.
type LayerFocus = (FocusHandle, Option<FocusHandle>);

struct Leaving {
    started: Instant,
    /// The layer's keyed state as it last drew while leaving: it lapses
    /// once the layer stops drawing under its id (its owner closed it, or
    /// put up another question under a new id), and the answer then goes
    /// unsent, so it never reaches what took the layer's place.
    drawn: Option<WeakEntity<LayerFocus>>,
}

/// A sheet or drawer held over the whole window, modal: focus stays inside,
/// Escape and a press on the scrim close it and hand focus back to what held
/// it when the layer opened.
#[derive(IntoElement)]
pub struct ModalLayer {
    id: ElementId,
    placement: LayerPlacement,
    surface: AnyElement,
    closable: bool,
    scrim_closable: bool,
    initial_focus: Option<FocusHandle>,
    on_close: CloseHandler,
}

impl ModalLayer {
    pub fn new(
        id: impl Into<ElementId>,
        placement: LayerPlacement,
        surface: impl IntoElement,
        on_close: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            placement,
            surface: surface.into_any_element(),
            closable: true,
            scrim_closable: true,
            initial_focus: None,
            on_close: Rc::new(on_close),
        }
    }

    /// Give focus, when the layer first draws, to this handle inside the
    /// surface (a dialog's field, for typing at once) instead of the layer.
    pub fn initial_focus(mut self, handle: FocusHandle) -> Self {
        self.initial_focus = Some(handle);
        self
    }

    /// Keep a press on the scrim from closing a surface that holds unsaved
    /// input (the app's `dirty`); Escape and the X still close it.
    pub fn closable_by_scrim(mut self, closable: bool) -> Self {
        self.scrim_closable = closable;
        self
    }

    /// Whether the owner takes a close now. One it would refuse (an install
    /// or a save under way) goes straight to the owner, without the exit,
    /// so a layer that stays is never left faded out.
    pub fn closable(mut self, closable: bool) -> Self {
        self.closable = closable;
        self
    }

    /// A click handler for a button of the owner's that closes the layer
    /// `id`: in place of `cx.listener(f)`, it plays the layer's exit, then
    /// runs `f` on the owner ([`ModalLayer::leave`]).
    pub fn closing<T: 'static>(
        id: impl Into<ElementId>,
        cx: &gpui::Context<T>,
        f: impl Fn(&mut T, &mut Window, &mut gpui::Context<T>) + 'static,
    ) -> impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static {
        let view = cx.weak_entity();
        let id = id.into();
        let f = Rc::new(f);
        move |_, window, cx| {
            let view = view.clone();
            let f = f.clone();
            ModalLayer::leave(id.clone(), window, cx, move |window, cx| {
                view.update(cx, |this, cx| f(this, window, cx)).ok();
            });
        }
    }

    /// Close the layer `id` from a button of its owner's (Cancel, Done,
    /// Import): its exit plays as Escape's does, the scrim fading and the
    /// surface sinking on the slow tier's exit, and `then` runs once it has,
    /// as the owner's answer; under reduced motion as soon as the caller
    /// returns. A second call while the layer is leaving does nothing, and a
    /// layer that stopped drawing under `id` during its exit gets no answer.
    pub fn leave(
        id: impl Into<ElementId>,
        window: &mut Window,
        cx: &mut App,
        then: impl FnOnce(&mut Window, &mut App) + 'static,
    ) {
        if cx.reduce_motion() {
            // Deferred, never run here: the caller is often its owner's own
            // handler (a key listener is an update of the owner), and `then`
            // updates the owner again, which GPUI refuses with a panic.
            window.defer(cx, then);
            return;
        }
        let key = (window.window_handle().window_id(), id.into());
        let started = Instant::now();
        let fresh = CLOSING.with(|closing| {
            let mut closing = closing.borrow_mut();
            if closing.contains_key(&key) {
                return false;
            }
            closing.insert(
                key.clone(),
                Leaving {
                    started,
                    drawn: None,
                },
            );
            true
        });
        if !fresh {
            return;
        }
        window.refresh();
        window
            .spawn(cx, async move |cx| {
                cx.background_executor()
                    .timer(Exit::DIALOG.duration())
                    .await;
                cx.update(|window, cx| {
                    let answer = CLOSING.with(|closing| {
                        let mut closing = closing.borrow_mut();
                        let ours = closing
                            .get(&key)
                            .is_some_and(|leaving| leaving.started == started);
                        ours && closing
                            .remove(&key)
                            .and_then(|leaving| leaving.drawn)
                            .is_some_and(|drawn| drawn.upgrade().is_some())
                    });
                    if answer {
                        then(window, cx);
                        window.refresh();
                    }
                })
                .ok();
            })
            .detach();
    }
}

impl RenderOnce for ModalLayer {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let child = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), name.into())
        };
        // The layer takes focus once, when it first draws, so Escape reaches
        // the host; after that focus moves only inside it. What held focus
        // before is kept to be given it back on close.
        let initial = self.initial_focus;
        let state = window.use_keyed_state(child("focus"), cx, |window, cx| {
            let previous = window.focused(cx);
            let focus = cx.focus_handle();
            initial.as_ref().unwrap_or(&focus).focus(window, cx);
            (focus, previous)
        });
        let (focus, previous) = state.read(cx).clone();
        let scrim = match self.placement {
            LayerPlacement::Center | LayerPlacement::UpperThird => cx.palette().scrim,
            LayerPlacement::Right => drawer_scrim(),
        };
        // A close the layer takes itself (Escape, a press on the scrim)
        // plays its exit before its owner hears of it: the scrim fades and
        // the surface sinks on the slow tier's exit (`modal-scrim-out`,
        // `modal-sink`). A close its owner takes with a button of its own
        // plays the same exit through [`ModalLayer::leave`].
        let key = (window.window_handle().window_id(), self.id.clone());
        let leaving = CLOSING.with(|closing| {
            closing.borrow_mut().get_mut(&key).map(|leaving| {
                leaving.drawn = Some(state.downgrade());
                leaving.started.elapsed()
            })
        });
        if leaving.is_some() {
            window.request_animation_frame();
            // Focus goes back to what held it before the layer opened as the
            // layer starts to leave, not after.
            if focus.contains_focused(window, cx) {
                match &previous {
                    Some(previous) => previous.focus(window, cx),
                    None => window.blur(cx),
                }
            }
        }
        let exit = leaving.map(|elapsed| Exit::DIALOG.sample(elapsed).1);
        let overlay = div()
            .absolute()
            .inset_0()
            .bg(scrim)
            .when_some(exit, |this, opacity| this.opacity(opacity))
            .with_animation(child("scrim"), Motion::Slow.animation(), move |this, t| {
                this.opacity(t.clamp(0., 1.) * exit.unwrap_or(1.))
            });
        let surface_content = match leaving {
            Some(elapsed) => sink_out(elapsed, self.surface),
            None => self.surface,
        };
        // Only the surface blocks the pointer; the rest of the wrapper lets
        // a press through to the host's scrim, which closes the layer.
        let surface_element = surface_content;
        let surface = match self.placement {
            LayerPlacement::Center => div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(div().id(child("surface")).occlude().child(surface_element)),
            // The room above shrinks before the dialog would cross the
            // 20px margin below: top = min(18vh, 100vh - height - 20px).
            LayerPlacement::UpperThird => div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .pb(gpui::px(20.))
                .child(div().h(gpui::relative(0.18)).flex_shrink(1.).min_h_0())
                .child(
                    div()
                        .id(child("surface"))
                        .flex_none()
                        .occlude()
                        .child(surface_element),
                ),
            LayerPlacement::Right => div().absolute().inset_0().flex().justify_end().child(
                div()
                    .id(child("surface"))
                    .occlude()
                    .h_full()
                    .child(surface_element),
            ),
        };
        let on_close = self.on_close;
        let closable = self.closable;
        let layer = focus.clone();
        let id = self.id.clone();
        deferred(
            SheetHost::new(cx)
                .focus_handle(focus)
                .overlay_closable(self.scrim_closable && leaving.is_none())
                .request_close(move |window, cx| {
                    if CLOSING.with(|closing| closing.borrow().contains_key(&key)) {
                        return;
                    }
                    if layer.contains_focused(window, cx) {
                        match &previous {
                            Some(previous) => previous.focus(window, cx),
                            None => window.blur(cx),
                        }
                    }
                    if !closable {
                        on_close(window, cx);
                        return;
                    }
                    let on_close = on_close.clone();
                    ModalLayer::leave(id.clone(), window, cx, move |window, cx| {
                        on_close(window, cx)
                    });
                })
                .overlay(overlay)
                .surface(surface),
        )
    }
}
