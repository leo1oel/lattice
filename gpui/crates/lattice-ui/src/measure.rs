//! Reading an element's bounds as it is laid out, without changing its
//! layout: what a ResizeObserver or `offsetTop` gives the Tauri app's motion
//! (the fluid hover's rows, a sliding plate's tabs).

use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Window,
};

/// `child`, laid out and drawn as it is, handing its bounds (window
/// coordinates) to `on_bounds` in prepaint, before anything paints: an
/// element that paints later in the same frame reads them fresh.
pub fn measured(
    child: impl IntoElement,
    on_bounds: impl FnOnce(Bounds<Pixels>, &mut App) + 'static,
) -> AnyElement {
    Measured {
        child: child.into_any_element(),
        on_bounds: Some(Box::new(on_bounds)),
    }
    .into_any_element()
}

type OnBounds = Box<dyn FnOnce(Bounds<Pixels>, &mut App)>;

struct Measured {
    child: AnyElement,
    on_bounds: Option<OnBounds>,
}

impl IntoElement for Measured {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Measured {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        // The child's own layout node: the wrapper adds none.
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(on_bounds) = self.on_bounds.take() {
            on_bounds(bounds, cx);
        }
        self.child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.paint(window, cx);
    }
}
