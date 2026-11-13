//! The editor's overlay scrollbar: lattice-ui's shared one
//! ([`FluidScrollbar`] in the source editor's feel, [`ScrollbarFeel::EDITOR`],
//! as the Tauri app draws its bar over CodeMirror in
//! `src/canvas/codemirror-scrollbar.tsx`), in place of Zed's (turned off in
//! the settings), thumbed in the code ink.
//!
//! Zed's editor scrolls in display rows and answers only inside an update,
//! while the bar reads and moves a pixel offset from its own listeners. So
//! the adapter hands the bar an [`EditorScroll`]: the extent as of the last
//! render, in pixels, and an offset the bar may set, which the next render
//! (the bar notifies this view) gives to Zed.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use gpui::{
    AnyElement, Bounds, Context, IntoElement, Pixels, Point, ScrollDelta, ScrollEvent, Size,
    Window, point, px, size,
};
use gpui_kit::base::ScrollbarHandle;
use lattice_ui::{
    ActiveLattice as _,
    scrollbar::{FluidScrollbar, ScrollbarFeel},
};

use super::LatticeEditor;

/// Where the editor is scrolled, in display rows.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Extent {
    top: f64,
    visible: f64,
    total: f64,
}

#[derive(Debug, Default)]
struct ScrollState {
    viewport: Bounds<Pixels>,
    line_height: Pixels,
    extent: Extent,
    /// A top row the bar asked for, not yet given to Zed.
    pending: Option<f64>,
}

/// The editor's scroll, as the shared scrollbar reads and moves it.
#[derive(Clone, Default)]
pub(super) struct EditorScroll {
    state: Rc<RefCell<ScrollState>>,
    /// The thumb's opacity as the bar last drew it.
    drawn: Rc<Cell<f32>>,
}

impl ScrollbarHandle for EditorScroll {
    fn viewport_bounds(&self) -> Bounds<Pixels> {
        self.state.borrow().viewport
    }

    fn offset(&self) -> Point<Pixels> {
        let state = self.state.borrow();
        let top = state.pending.unwrap_or(state.extent.top);
        point(px(0.), -(state.line_height * top as f32))
    }

    fn set_offset(&self, offset: Point<Pixels>) {
        let mut state = self.state.borrow_mut();
        if state.line_height > px(0.) {
            let max = (state.extent.total - state.extent.visible).max(0.);
            let top = (f64::from(-offset.y / state.line_height)).clamp(0., max);
            state.pending = Some(top);
        }
    }

    fn content_size(&self) -> Size<Pixels> {
        let state = self.state.borrow();
        size(
            state.viewport.size.width,
            state.line_height * state.extent.total as f32,
        )
    }
}

impl LatticeEditor {
    /// The thumb's opacity as the scrollbar last drew it: 0 while it hides.
    pub fn scrollbar_opacity(&self) -> f32 {
        self.scroll.drawn.get()
    }

    /// A wheel the editor element did not take (over the gutter or the
    /// padding above and below the text) scrolls the text all the same.
    pub(super) fn scroll_by_wheel(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        let line_height = self.scroll.state.borrow().line_height;
        let dy = match event.delta {
            ScrollDelta::Pixels(pixels) => pixels.y,
            ScrollDelta::Lines(lines) => line_height * lines.y,
        };
        let before = self.scroll.offset();
        self.scroll.set_offset(point(before.x, before.y + dy));
        if self.scroll.offset() != before {
            cx.stop_propagation();
            cx.notify();
        }
    }

    fn extent(&self, cx: &mut Context<Self>) -> Extent {
        self.editor.update(cx, |editor, cx| Extent {
            top: editor.scroll_position(cx).y,
            visible: editor.visible_line_count().unwrap_or(0.),
            total: editor.max_point(cx).row().0 as f64 + 1.,
        })
    }

    /// Give Zed the offset the bar set since the last frame, read the
    /// extent the bar will draw, and the bar itself, over the view's right
    /// edge.
    pub(super) fn render_scrollbar(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let pending = self.scroll.state.borrow_mut().pending.take();
        if let Some(top) = pending {
            self.editor.update(cx, |editor, cx| {
                let x = editor.scroll_position(cx).x;
                editor.set_scroll_position(point(x, top), window, cx);
            });
        }
        let extent = self.extent(cx);
        let bounds = self.editor_bounds.get();
        let line_height = bounds
            .and_then(|bounds| crate::geometry::Frame::read(&self.editor, bounds, window, cx))
            .map(|frame| frame.line_height);
        {
            let mut state = self.scroll.state.borrow_mut();
            state.extent = extent;
            state.line_height = line_height.unwrap_or(px(0.));
            if let Some(bounds) = bounds {
                state.viewport = bounds;
            }
        }
        let lattice = cx.lattice();
        let ink =
            lattice_ui::editor_theme::gutter_ink(lattice.code_theme, &lattice.palette).current;
        FluidScrollbar::vertical(
            gpui::ElementId::NamedInteger(
                "lattice-editor-scrollbar".into(),
                self.editor.entity_id().as_u64(),
            ),
            &self.scroll,
        )
        .feel(ScrollbarFeel::EDITOR)
        .ink(ink)
        .drawn_opacity(self.scroll.drawn.clone())
        .into_any_element()
    }
}
