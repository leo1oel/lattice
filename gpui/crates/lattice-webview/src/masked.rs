//! The page's element as an island draws it: at its full size, but clipped
//! away until the page may be seen.

use gpui::{
    AnyElement, App, Bounds, ContentMask, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, Window,
};

/// The page's element, laid out at its full size but clipped away while
/// `hidden`: gpui-webview keeps a clipped page laid out at its real width and
/// hides its native view, so the page renders unseen.
pub(crate) struct Masked {
    pub(crate) child: AnyElement,
    pub(crate) hidden: bool,
}

impl IntoElement for Masked {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Masked {
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
        let child = self.child.request_layout(window, cx);
        let style = gpui::Style {
            size: gpui::Size::full(),
            position: gpui::Position::Absolute,
            inset: gpui::Edges {
                top: gpui::px(0.).into(),
                right: gpui::px(0.).into(),
                bottom: gpui::px(0.).into(),
                left: gpui::px(0.).into(),
            },
            ..Default::default()
        };
        (window.request_layout(style, [child], cx), ())
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
        let mask = if self.hidden {
            Bounds::new(bounds.origin, gpui::Size::default())
        } else {
            bounds
        };
        window.with_content_mask(Some(ContentMask { bounds: mask }), |window| {
            self.child.prepaint(window, cx)
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let mask = if self.hidden {
            Bounds::new(bounds.origin, gpui::Size::default())
        } else {
            bounds
        };
        window.with_content_mask(Some(ContentMask { bounds: mask }), |window| {
            self.child.paint(window, cx)
        });
    }
}
