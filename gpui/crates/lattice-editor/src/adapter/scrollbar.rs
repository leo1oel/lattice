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
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    AnyElement, Bounds, Context, IntoElement, Pixels, Point, Size, Window, point, px, size,
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

impl Extent {
    fn overflows(&self) -> bool {
        self.total - self.visible > 0.01
    }
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
    /// When the text last scrolled: the bar shows for its feel's linger.
    scrolled_at: Rc<RefCell<Option<Instant>>>,
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
    /// The text scrolled: the bar counts it as scrolling for its linger.
    pub(super) fn note_scroll(&mut self, _: &mut Context<Self>) {
        *self.scroll.scrolled_at.borrow_mut() = Some(Instant::now());
    }

    /// Whether the scrollbar shows for a scroll: the text overflows, and it
    /// scrolled within the editor feel's linger (180 ms).
    pub fn scrollbar_shown(&mut self, cx: &mut Context<Self>) -> bool {
        let linger: Duration = ScrollbarFeel::EDITOR.linger;
        let scrolling = self
            .scroll
            .scrolled_at
            .borrow()
            .is_some_and(|at| at.elapsed() < linger);
        scrolling && self.extent(cx).overflows()
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
        .into_any_element()
    }
}
