//! Sheets and drawers: the two larger surfaces a tool or a long form opens
//! in, and the modal layer that holds either over the window.
//!
//! - A sheet is the app's `SheetDialog` (dialogs.css `.modal.sheet-dialog`):
//!   a dialog of Settings' size, 860 × 640 or the window less 20px a side,
//!   14px corners at the dialog level on the lift. Its title row is the
//!   drawers' 40px header (the title, the icon-only X), its content 14px in
//!   with 12px between sections, and its actions sit at the foot over a
//!   hairline; title and actions stay put while a long form scrolls
//!   between them. It rises 6px into place and fades on the slow tier.
//! - A drawer is the app's right-edge `ResizableDrawer` (surfaces.css
//!   `.resizable-drawer`): the window's full height on the input surface at
//!   the floating level, square to the window edge, its content 14px in
//!   under the same 40px header. It travels in 24px from the right and fades
//!   on the slow tier.
//!
//! [`ModalLayer`] holds one over the window on GPUI Kit's headless sheet
//! host (`gpui_kit::base::Sheet`), which owns the focus trap, Escape and the
//! press on the scrim that closes it. The scrim fades in on the slow tier
//! with its surface: the dialog scrim behind a sheet, the lighter
//! `--scrim-surface` behind a drawer.

use std::rc::Rc;

use gpui::{
    AnimationExt as _, AnyElement, App, ElementId, Hsla, InteractiveElement as _, IntoElement,
    ParentElement, Pixels, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, hsla, prelude::FluentBuilder as _, px,
};
use gpui_kit::base::Sheet as SheetHost;

use crate::{
    ActiveLattice as _, Elevation, components::PanelHeader, motion::Motion,
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
        let header = PanelHeader::new(child("close"), self.title).when_some(
            self.on_close,
            |this, on_close| this.on_close(move |_, window, cx| on_close(window, cx)),
        );
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
        div()
            .w(width)
            .h(height)
            .child(slide_in(child("rise"), 0., 6., card))
    }
}

#[derive(IntoElement)]
pub struct Drawer {
    id: ElementId,
    title: SharedString,
    width: Pixels,
    children: Vec<AnyElement>,
    on_close: Option<CloseHandler>,
}

impl Drawer {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            width: DRAWER_WIDTH,
            children: Vec::new(),
            on_close: None,
        }
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
        let header = PanelHeader::new(child("close"), self.title).when_some(
            self.on_close,
            |this, on_close| this.on_close(move |_, window, cx| on_close(window, cx)),
        );
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
    /// Against the right edge, the window's height, over the lighter scrim:
    /// a drawer.
    Right,
}

/// A sheet or drawer held over the whole window, modal: focus stays inside,
/// Escape and a press on the scrim close it.
#[derive(IntoElement)]
pub struct ModalLayer {
    id: ElementId,
    placement: LayerPlacement,
    surface: AnyElement,
    closable: bool,
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
            on_close: Rc::new(on_close),
        }
    }

    /// Keep a press on the scrim from closing a surface that holds unsaved
    /// input (the app's `dirty`); Escape and the X still close it.
    pub fn closable_by_scrim(mut self, closable: bool) -> Self {
        self.closable = closable;
        self
    }
}

impl RenderOnce for ModalLayer {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let child = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), name.into())
        };
        // The layer takes focus once, when it first draws, so Escape reaches
        // the host; after that focus moves only inside it.
        let focus = window.use_keyed_state(child("focus"), cx, |window, cx| {
            let focus = cx.focus_handle();
            focus.focus(window, cx);
            focus
        });
        let focus = focus.read(cx).clone();
        let scrim = match self.placement {
            LayerPlacement::Center => cx.palette().scrim,
            LayerPlacement::Right => drawer_scrim(),
        };
        let overlay = div()
            .absolute()
            .inset_0()
            .bg(scrim)
            .with_animation(child("scrim"), Motion::Slow.animation(), |this, t| {
                this.opacity(t.clamp(0., 1.))
            });
        // Only the surface blocks the pointer; the rest of the wrapper lets
        // a press through to the host's scrim, which closes the layer.
        let surface = match self.placement {
            LayerPlacement::Center => div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(div().id(child("surface")).occlude().child(self.surface)),
            LayerPlacement::Right => div().absolute().inset_0().flex().justify_end().child(
                div()
                    .id(child("surface"))
                    .occlude()
                    .h_full()
                    .child(self.surface),
            ),
        };
        let on_close = self.on_close;
        SheetHost::new(cx)
            .focus_handle(focus)
            .overlay_closable(self.closable)
            .request_close(move |window, cx| on_close(window, cx))
            .overlay(overlay)
            .surface(surface)
    }
}
