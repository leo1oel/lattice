//! A source editor as a drop target, as the Tauri app's `.source-editor`
//! is one (`src/canvas/document-canvas.tsx`, `src/editor/drop-cursor.ts`):
//!
//! - A figure's row dragged from the Project tree lights the editor
//!   (`figure-drop-active`: a 1px inset ring in the accent at 24%), draws
//!   the drop caret where the pointer is, in the editor's caret colour and
//!   width (`.cm-dropCursor`), and goes in as a figure at the start of that
//!   line.
//! - Files dragged in from Finder light it the same way when they are
//!   figures it takes into its text (`nativeFigureDropActive`), or with the
//!   ring at 30% and a soft inner glow when it would import and open them
//!   (`file-drop-active`); the shell routes the drop (`shell/drops.rs`).
//!
//! The marks are painted from what the drag's moves last saw, and only while
//! a row or Finder's files are being dragged, so a drag that ends anywhere
//! leaves none behind, and another kind of drag shows none.

use std::{cell::RefCell, path::PathBuf, rc::Rc};

use gpui::{
    App, Bounds, Context, Div, EntityInputHandler as _, ExternalPaths, Hsla,
    InteractiveElement as _, IntoElement, Pixels, Point, Styled as _, Window, canvas, fill, point,
    px, size,
};
use language::OffsetUtf16;
use lattice_ui::ActiveLattice as _;

use super::{EditorPanel, EditorPanelEvent};
use crate::{
    file_tree::DraggedEntry,
    shell::drops::{EditorTake, classify, editor_take},
};

/// How the editor is lit under a drag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropLit {
    /// Figures it takes into its text: a tree figure, Finder figures.
    Insert,
    /// Files it imports and opens.
    Open,
}

/// What the drag over the editor last saw.
#[derive(Default)]
pub struct DropHover {
    lit: Option<DropLit>,
    /// The drop caret, in window coordinates (a tree figure's drag only).
    caret: Option<Bounds<Pixels>>,
}

pub type SharedDropHover = Rc<RefCell<DropHover>>;

impl EditorPanel {
    /// The byte offset of the character under `position` (window
    /// coordinates), from Zed's editor as the input method asks it.
    fn offset_under(
        &self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<usize> {
        let editor = self.editor().clone();
        let utf16 = editor.update(cx, |editor, cx| {
            editor.character_index_for_point(position, window, cx)
        })?;
        let buffer = editor.read(cx).buffer().read(cx).snapshot(cx);
        let text = buffer.as_singleton()?;
        Some(text.offset_utf16_to_offset(OffsetUtf16(utf16)))
    }

    /// The caret rectangle before `offset`, in window coordinates.
    fn caret_before(
        &self,
        offset: usize,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Bounds<Pixels>> {
        let editor = self.editor().clone();
        let bounds = *editor.read(cx).last_bounds()?;
        let buffer = editor.read(cx).buffer().read(cx).snapshot(cx);
        let text = buffer.as_singleton()?;
        let utf16 = language::ToOffsetUtf16::to_offset_utf16(&offset.min(text.len()), text).0;
        editor.update(cx, |editor, cx| {
            editor.bounds_for_range(utf16..utf16, bounds, window, cx)
        })
    }

    /// The middle of the caret before `offset`, in window coordinates: where
    /// a scenario aims a drop at that place.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn point_before(
        &self,
        offset: usize,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Point<Pixels>> {
        self.caret_before(offset, window, cx)
            .map(|caret| point(caret.left() + px(1.), caret.center().y))
    }

    /// Whether a drag over the editor lights it now, and draws a drop
    /// caret, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn drop_lit(&self, cx: &App) -> (Option<DropLit>, bool) {
        let hover = self.drop_hover.borrow();
        (
            hover.lit.filter(|_| DraggedEntry::dropping(cx)),
            hover.caret.is_some(),
        )
    }

    /// The editor's drop handlers, on its root element.
    pub(super) fn wire_drops(&self, element: Div, cx: &mut Context<Self>) -> Div {
        let hover = self.drop_hover.clone();
        let entry_hover = hover.clone();
        let paths_hover = hover.clone();
        let inserts = self.inserts_figures();
        element
            .on_drag_move(cx.listener(
                move |this, event: &gpui::DragMoveEvent<DraggedEntry>, window, cx| {
                    let inside = event.bounds.contains(&event.event.position);
                    let figure = event.drag(cx).figure().is_some();
                    let mut hover = entry_hover.borrow_mut();
                    if !inside || !figure || !inserts {
                        *hover = DropHover::default();
                        return;
                    }
                    hover.lit = Some(DropLit::Insert);
                    hover.caret = this
                        .offset_under(event.event.position, window, cx)
                        .and_then(|offset| this.caret_before(offset, window, cx));
                },
            ))
            .on_drag_move(cx.listener(
                move |_, event: &gpui::DragMoveEvent<ExternalPaths>, _, cx| {
                    let inside = event.bounds.contains(&event.event.position);
                    let kind = classify(event.drag(cx).paths());
                    let mut hover = paths_hover.borrow_mut();
                    hover.caret = None;
                    hover.lit = match editor_take(kind, inserts) {
                        _ if !inside => None,
                        EditorTake::Insert => Some(DropLit::Insert),
                        EditorTake::Open => Some(DropLit::Open),
                        EditorTake::Refuse => None,
                    };
                },
            ))
            // A figure dragged from the Project tree goes in as a figure, at
            // the start of the line under the pointer (`beginFigureDrag`).
            .on_drop(cx.listener(|this, dragged: &DraggedEntry, window, cx| {
                *this.drop_hover.borrow_mut() = DropHover::default();
                if let Some(path) = dragged.figure()
                    && this.inserts_figures()
                {
                    let at = this.offset_under(window.mouse_position(), window, cx);
                    cx.emit(EditorPanelEvent::InsertFigures(vec![path.to_string()], at));
                }
            }))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                cx.stop_propagation();
                *this.drop_hover.borrow_mut() = DropHover::default();
                let at = this.offset_under(window.mouse_position(), window, cx);
                let paths: Vec<PathBuf> = paths.paths().to_vec();
                cx.emit(EditorPanelEvent::DropFiles(paths, at));
            }))
    }

    /// The marks a drag over the editor puts up: its ring and the drop caret.
    pub(super) fn drop_marks(&self, cx: &App) -> impl IntoElement {
        let hover = self.drop_hover.clone();
        let palette = cx.palette().clone();
        let caret_color = lattice_ui::editor_theme::caret(cx.lattice().code_theme, &palette);
        canvas(
            |_, _, _| {},
            move |bounds, _, window, cx| {
                if !DraggedEntry::dropping(cx) {
                    return;
                }
                let hover = hover.borrow();
                let Some(lit) = hover.lit else { return };
                let (ring, glow) = match lit {
                    DropLit::Insert => (0.24, 0.),
                    DropLit::Open => (0.30, 0.04),
                };
                paint_ring(window, bounds, palette.accent, ring, glow);
                if let Some(caret) = hover.caret {
                    // `--editor-caret-width`, centred on the caret's left.
                    let width = px(2.);
                    window.paint_quad(fill(
                        Bounds::new(
                            point(caret.left() - width / 2., caret.top()),
                            size(width, caret.size.height),
                        ),
                        caret_color,
                    ));
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

/// `inset 0 0 0 1px` in `accent` at `ring`, and `inset 0 0 24px` at
/// `glow`: GPUI has no inset shadow, so the glow is drawn as 1px rings, one
/// per pixel in from the edge, fading as a blur's falloff does.
fn paint_ring(window: &mut Window, bounds: Bounds<Pixels>, accent: Hsla, ring: f32, glow: f32) {
    window.paint_quad(gpui::outline(
        bounds,
        accent.opacity(ring),
        gpui::BorderStyle::Solid,
    ));
    if glow <= 0. {
        return;
    }
    const BLUR: usize = 24;
    for step in 1..BLUR {
        let inset = px(step as f32);
        let inner = Bounds::new(
            bounds.origin + point(inset, inset),
            size(
                bounds.size.width - inset * 2.,
                bounds.size.height - inset * 2.,
            ),
        );
        if inner.size.width <= px(0.) || inner.size.height <= px(0.) {
            break;
        }
        let falloff = 1. - step as f32 / BLUR as f32;
        window.paint_quad(gpui::outline(
            inner,
            accent.opacity(glow * falloff * falloff),
            gpui::BorderStyle::Solid,
        ));
    }
}
