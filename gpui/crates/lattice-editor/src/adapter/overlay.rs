//! The overlay over the editor: gutter marks and remote carets painted in
//! the editor's coordinates, and the pointer reported to the hover cards.

use std::{collections::HashMap, time::Instant};

use gpui::{
    App, Bounds, Context, DispatchPhase, Hitbox, MouseMoveEvent, Pixels, Point, SharedString,
    Window,
};
use language::{ToOffset as _, ToPoint as _};

use super::LatticeEditor;
use crate::{
    geometry::{self, Frame},
    gutter, inline_texts, remote_cursors,
};

/// What the overlay painted last frame, for the pointer and for scripted
/// checks.
#[derive(Clone, Debug, Default)]
pub struct Painted {
    /// The editor element's bounds.
    pub bounds: Option<Bounds<Pixels>>,
    pub line_height: Option<Pixels>,
    /// Each gutter mark drawn: its layer, buffer row and bounds.
    pub gutter: Vec<(&'static str, u32, Bounds<Pixels>)>,
    /// Each remote caret drawn: its id, bar, tag, the area that shows its
    /// tag on hover, the tag's opacity and whether the tag is below the
    /// caret.
    pub cursors: Vec<PaintedCursor>,
    /// The open hover card's bounds, once it has been laid out.
    pub card: Option<Bounds<Pixels>>,
    /// Each inline text drawn: its layer, buffer offset and bounds, once for
    /// each display row it takes.
    pub inline: Vec<(&'static str, usize, Bounds<Pixels>)>,
}

#[derive(Clone, Debug)]
pub struct PaintedCursor {
    pub id: SharedString,
    pub bar: Bounds<Pixels>,
    pub label: Bounds<Pixels>,
    pub hover: Bounds<Pixels>,
    pub label_opacity: f32,
    pub label_below: bool,
}

impl LatticeEditor {
    /// The caret rectangle before `offset`, in window coordinates, as of the
    /// last frame's layout.
    pub fn offset_bounds(
        &self,
        offset: usize,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Bounds<Pixels>> {
        let bounds = self.painted.borrow().bounds?;
        let text = self.buffer.read(cx).snapshot();
        geometry::caret_rect(&self.editor, &text, offset, bounds, window, cx)
    }

    /// The top of the display row buffer `row` starts on, in window
    /// coordinates (block widgets above it push it down).
    pub fn line_top(&self, row: u32, window: &mut Window, cx: &mut App) -> Option<Pixels> {
        let bounds = self.painted.borrow().bounds?;
        Frame::read(&self.editor, bounds, window, cx).map(|frame| frame.row_top(row))
    }

    /// Paint gutter marks and remote carets, record where they went, and
    /// follow the pointer for hover cards and caret tags.
    pub(super) fn paint_overlay(
        &mut self,
        bounds: Bounds<Pixels>,
        hitbox: &Hitbox,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // The pointer: hover cards and caret tags. A listener for the
        // window, so the editor's own hitboxes need not let anything through;
        // the hitbox says whether something above the editor has the pointer.
        // Registered every frame, before the early return below: the text's
        // hover cards need it in an editor with no gutter marks or carets.
        let hitbox = hitbox.clone();
        let this = cx.weak_entity();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            let over = hitbox.is_hovered(window);
            let position = event.position;
            this.update(cx, |this, cx| {
                if over {
                    this.update_hovered_cursor(position, cx);
                    this.pointer_moved(position, window, cx);
                } else {
                    if this.hovered_cursor.take().is_some() {
                        cx.notify();
                    }
                    this.pointer_left(cx);
                }
            })
            .ok();
        });

        // The text's frame is the editor element's; gutter marks stand in the
        // view's left edge, in the gutter.
        let view = bounds;
        let bounds = self.editor_bounds(view).unwrap_or(view);
        let mut painted = Painted {
            bounds: Some(bounds),
            card: self.painted.borrow().card,
            ..Painted::default()
        };
        // Most frames have nothing to paint here: leave the editor's layout
        // unread (it costs a display snapshot) while scrolling plain text.
        let has_overlay =
            !self.gutter.is_empty() || !self.cursors.is_empty() || !self.inline.is_empty();
        let frame = has_overlay
            .then(|| Frame::read(&self.editor, bounds, window, cx))
            .flatten();
        let Some(frame) = frame else {
            *self.painted.borrow_mut() = painted;
            return;
        };
        painted.line_height = Some(frame.line_height);
        let text = self.buffer.read(cx).snapshot();
        window.with_content_mask(Some(gpui::ContentMask { bounds: view }), |window| {
            for (layer, marks) in &self.gutter {
                for anchored in marks {
                    let row = anchored.anchor.to_point(&text).row;
                    let top = frame.row_top(row);
                    if !frame.shows_row(top) {
                        continue;
                    }
                    let mark_bounds = gutter::mark_bounds(view.left(), top, frame.line_height);
                    gutter::paint(
                        anchored.mark.shape,
                        mark_bounds,
                        anchored.mark.color,
                        window,
                        cx,
                    );
                    painted.gutter.push((layer, row, mark_bounds));
                }
            }
            if !self.inline.is_empty() {
                let details = self
                    .editor
                    .update(cx, |editor, cx| editor.text_layout_details(window, cx));
                let display = &frame.display().display_snapshot;
                for (layer, items) in &self.inline {
                    let mut spliced: HashMap<usize, usize> = HashMap::new();
                    for anchored in items {
                        let offset = anchored.anchor.to_offset(&text);
                        let skip = spliced.entry(offset).or_default();
                        let before = *skip;
                        *skip += anchored.item.text.len();
                        let Some(caret) =
                            geometry::caret_rect(&self.editor, &text, offset, bounds, window, cx)
                        else {
                            continue;
                        };
                        let (base, rows) = frame.inline_rows(
                            anchored.anchor.to_point(&text),
                            before,
                            anchored.item.text.len(),
                        );
                        let origin = caret.left() - display.x_for_display_point(base, &details);
                        for (from, to) in &rows {
                            let step = from.row().0 - base.row().0;
                            let top = caret.top() + frame.line_height * step as f32;
                            if !frame.shows_row(top) {
                                continue;
                            }
                            let left = origin + display.x_for_display_point(*from, &details);
                            let right = origin + display.x_for_display_point(*to, &details);
                            let drawn = inline_texts::paint(
                                left,
                                top,
                                right - left,
                                frame.line_height,
                                &anchored.item,
                                window,
                            );
                            painted.inline.push((layer, offset, drawn));
                        }
                    }
                }
            }
            let mut animating = false;
            let now = Instant::now();
            for anchored in &self.cursors {
                let offset = anchored.anchor.to_offset(&text);
                let Some(caret) =
                    geometry::caret_rect(&self.editor, &text, offset, bounds, window, cx)
                else {
                    continue;
                };
                if !frame.shows_row(caret.top()) {
                    continue;
                }
                let hovered = self.hovered_cursor.as_ref() == Some(&anchored.cursor.id);
                let elapsed = now.saturating_duration_since(anchored.since);
                let opacity = if hovered {
                    1.
                } else {
                    remote_cursors::label_opacity(elapsed)
                };
                let (label, width) =
                    remote_cursors::shape_label(&anchored.cursor.name, opacity, window, cx);
                let geometry = remote_cursors::caret_geometry(
                    caret.left(),
                    caret.top(),
                    frame.line_height,
                    width,
                    bounds.top(),
                );
                animating |= !hovered && opacity > 0.;
                remote_cursors::paint(
                    &geometry,
                    anchored.cursor.color,
                    &label,
                    opacity,
                    window,
                    cx,
                );
                painted.cursors.push(PaintedCursor {
                    id: anchored.cursor.id.clone(),
                    bar: geometry.bar,
                    label: geometry.label,
                    hover: geometry.hover,
                    label_opacity: opacity,
                    label_below: geometry.label_below,
                });
            }
            if animating {
                window.request_animation_frame();
            }
        });
        *self.painted.borrow_mut() = painted;
    }

    fn update_hovered_cursor(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let hovered = self.painted.borrow().cursors.iter().find_map(|painted| {
            painted
                .hover
                .contains(&position)
                .then(|| painted.id.clone())
        });
        if hovered != self.hovered_cursor {
            self.hovered_cursor = hovered;
            cx.notify();
        }
    }
}
