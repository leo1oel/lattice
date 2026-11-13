//! The source gutter, as the Tauri app draws it (`src/editor/source-gutter.ts`,
//! `.cm-lineNumbers` and `.cm-foldGutter` in `editor-workspace.css`): line
//! numbers and fold markers as one quiet column on the editor's ground, with
//! no rule beside it.
//!
//! - The numbers' cell is four digits wide whatever the line count (wider only
//!   past 9,999 lines), with 10px before the digits and 2px after, so the text
//!   never shifts as a document grows; the digits are right-aligned in the
//!   code theme's line-number ink, the caret's line in the code ink.
//! - A fixed 16px fold column follows, then CodeMirror's 6px of line padding
//!   before the text. A line the language can fold shows a 12px chevron
//!   there, quiet until the pointer is over the gutter (an opacity fade on
//!   the fast tier); a folded line keeps its marker, turned to point right,
//!   since otherwise only its placeholder says it is folded. Under the
//!   pointer a marker takes the code ink; a click folds or unfolds.
//! - On a wrapped line the number and the marker sit on its first row.
//!
//! Zed's own gutter sizes itself in whole character widths around its own
//! indicators, so it is turned off (`set_show_gutter(false)`) and the editor
//! element is inset by this column instead: its text starts exactly where
//! CodeMirror's does, and its wrap width (the element's width less two ems)
//! matches CodeMirror's line box less its 6px and 2px of padding.

use std::{ops::Range, rc::Rc};

use editor::{Editor, FoldPlaceholder, display_map::Crease};
use gpui::{
    App, Bounds, Context, CursorStyle, DispatchPhase, ElementId, Font, Hitbox, HitboxBehavior,
    Hsla, InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent,
    ParentElement as _, Pixels, Point, SharedString, StatefulInteractiveElement as _, Styled as _,
    TextAlign, TextRun, WeakEntity, Window, div, point, px, size,
};
use language::BufferSnapshot;
use lattice_ui::{ActiveLattice as _, Motion, editor_theme, interaction::mix, stroke};
use multi_buffer::MultiBufferRow;
use settings::Settings as _;

use super::LatticeEditor;
use crate::{
    folds::{FoldRange, FoldSource},
    geometry::Frame,
};

/// Before the digits and after them (`--space-5`, `--space-1`).
const NUMBER_START: Pixels = px(10.);
const NUMBER_END: Pixels = px(2.);
/// The digits the numbers' cell always has room for.
const MIN_DIGITS: usize = 4;
/// The fold column, and the chevron in it.
const FOLD_COLUMN: Pixels = px(16.);
const MARKER: Pixels = px(12.);
/// CodeMirror's padding before a line's text.
pub(super) const LINE_PADDING: Pixels = px(6.);
/// CodeMirror's padding above the first line and below the last
/// (`.cm-content`'s `4px 0`). Zed's editor has none, so its element stands
/// this far in from the view's top and bottom: at rest the first line sits
/// where CodeMirror's does, and a scrolled line meets the edge 4px sooner.
pub(super) const CONTENT_PADDING: Pixels = px(4.);
/// CodeMirror's padding after a line's text, inside its line box.
const LINE_END_PADDING: Pixels = px(2.);

/// The column's geometry for one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct GutterLayout {
    /// A digit's advance in the buffer font.
    pub ch: Pixels,
    pub digits: usize,
}

impl GutterLayout {
    /// The numbers' cell: the padding and the digits.
    pub fn number_width(&self) -> Pixels {
        NUMBER_START + self.ch * self.digits as f32 + NUMBER_END
    }

    /// The numbers and the fold column, where the line box starts.
    pub fn width(&self) -> Pixels {
        self.number_width() + FOLD_COLUMN
    }

    /// Where the text starts, from the editor's left edge.
    pub fn text_start(&self) -> Pixels {
        self.width() + LINE_PADDING
    }

    /// How far the editor element's right edge stands in from the editor's,
    /// given the room `clearance` the text leaves at the right (the outline
    /// rail's): Zed wraps two ems short of its element's edge, CodeMirror at
    /// its line box less the 2px of padding after the text. Negative when the
    /// element must reach past the editor for the two to agree (the editor
    /// clips it).
    pub fn element_end(&self, clearance: Pixels) -> Pixels {
        line_box_end(clearance) + LINE_END_PADDING - self.ch * 2.
    }
}

/// How far a line box ends short of the editor's right edge, beside
/// `clearance`: where the current line's wash ends. CodeMirror's line box
/// fills the scroller's content box, which the clearance pads.
pub(super) fn line_box_end(clearance: Pixels) -> Pixels {
    clearance
}

/// The digits a document of `lines` lines needs, at least four.
pub(super) fn digits_for(lines: u32) -> usize {
    (lines.max(1).ilog10() as usize + 1).max(MIN_DIGITS)
}

/// The buffer font and size Zed's editor draws the text in.
pub(super) fn buffer_font(cx: &App) -> (Font, Pixels) {
    let settings = theme_settings::ThemeSettings::get_global(cx);
    (settings.buffer_font.clone(), settings.buffer_font_size(cx))
}

/// One line the column drew last frame.
#[derive(Clone, Debug, PartialEq)]
pub struct PaintedLine {
    /// The buffer row, 0-based.
    pub row: u32,
    /// The numbers' cell on the line's first display row.
    pub number: Bounds<Pixels>,
    /// The fold marker's 16px cell, for a line that folds.
    pub fold: Option<Bounds<Pixels>>,
    /// Whether the line is folded.
    pub folded: bool,
    /// The marker's opacity this frame.
    pub marker_opacity: f32,
}

/// What the gutter painted last frame, for the pointer and scripted checks.
#[derive(Clone, Debug, Default)]
pub struct PaintedGutter {
    /// The column's bounds.
    pub bounds: Option<Bounds<Pixels>>,
    /// Where the text starts, in window coordinates.
    pub text_left: Option<Pixels>,
    pub lines: Vec<PaintedLine>,
}

/// The pointer over the column, between frames.
#[derive(Default)]
pub(super) struct GutterPointer {
    /// Over the column: the markers show.
    pub over: bool,
    /// The row whose marker is under the pointer.
    pub marker: Option<u32>,
    /// The row whose marker the pointer last left, still easing back.
    pub left_marker: Option<u32>,
}

/// One frame's eased values, read in render.
#[derive(Clone, Copy, Default)]
pub(super) struct GutterFades {
    /// The markers' opacity while the pointer is over the column.
    pub reveal: f32,
    /// The hovered and the last-hovered markers' ink, toward the code ink.
    pub marker: (Option<u32>, f32),
    pub left_marker: (Option<u32>, f32),
}

impl LatticeEditor {
    /// The fold markers' fades, eased on the fast tier as the app's CSS
    /// transitions `opacity` and `color`.
    pub(super) fn gutter_fades(&self, window: &mut Window, cx: &mut App) -> GutterFades {
        let id = |name: &'static str, extra: u64| {
            ElementId::NamedInteger(
                SharedString::from(format!("lattice-gutter-{name}-{}", self.editor.entity_id())),
                extra,
            )
        };
        let reveal = lattice_ui::interaction::fade(
            id("reveal", 0),
            self.gutter_pointer.over,
            Motion::Fast,
            window,
            cx,
        );
        let marker = self.gutter_pointer.marker.map(|row| {
            (
                row,
                lattice_ui::interaction::fade(
                    id("marker", row as u64),
                    true,
                    Motion::Fast,
                    window,
                    cx,
                ),
            )
        });
        let left_marker = self
            .gutter_pointer
            .left_marker
            .filter(|row| Some(*row) != self.gutter_pointer.marker)
            .map(|row| {
                (
                    row,
                    lattice_ui::interaction::fade(
                        id("marker", row as u64),
                        false,
                        Motion::Fast,
                        window,
                        cx,
                    ),
                )
            });
        GutterFades {
            reveal,
            marker: (marker.map(|(row, _)| row), marker.map_or(0., |(_, t)| t)),
            left_marker: (
                left_marker.map(|(row, _)| row),
                left_marker.map_or(0., |(_, t)| t),
            ),
        }
    }

    /// What `row` folds, from the language's fold source, cached until the
    /// next edit.
    fn fold_at(&self, source: &FoldSource, text: &BufferSnapshot, row: u32) -> Option<FoldRange> {
        if let Some(known) = self.fold_cache.borrow().get(&row) {
            return *known;
        }
        let range = source(text, row);
        self.fold_cache.borrow_mut().insert(row, range);
        range
    }

    /// Lay out the column for this frame: each visible line's number and fold
    /// cell, and the hitboxes the markers take the pointer with.
    pub(super) fn prepaint_gutter(
        &mut self,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<(PaintedGutter, Vec<(u32, Hitbox)>, Hitbox)> {
        let layout = self.gutter_layout?;
        let editor_bounds = self.editor_bounds(bounds)?;
        let frame = Frame::read(&self.editor, editor_bounds, window, cx)?;
        let text = self.buffer.read(cx).snapshot();
        let column = Bounds {
            origin: bounds.origin,
            size: size(layout.width(), bounds.size.height),
        };
        let column_hitbox = window.insert_hitbox(column, HitboxBehavior::Normal);
        let display = frame.display();
        let first = frame.first_visible_row();
        let rows = frame.visible_rows();
        let mut painted = PaintedGutter {
            bounds: Some(column),
            text_left: Some(bounds.left() + layout.text_start()),
            lines: Vec::new(),
        };
        let mut hitboxes = Vec::new();
        for (index, info) in display.row_infos(first).take(rows).enumerate() {
            // Numbered on a line's first display row only.
            let Some(row) = info.buffer_row else {
                continue;
            };
            let top = frame.display_row_top(first.0 + index as u32);
            let number = Bounds {
                origin: point(bounds.left(), top),
                size: size(layout.number_width(), frame.line_height),
            };
            let fold = self
                .folds
                .clone()
                .and_then(|source| self.fold_at(&source, &text, row))
                .map(|_| Bounds {
                    origin: point(bounds.left() + layout.number_width(), top),
                    size: size(FOLD_COLUMN, frame.line_height),
                });
            let folded = display.is_line_folded(MultiBufferRow(row));
            if let Some(cell) = fold {
                hitboxes.push((row, window.insert_hitbox(cell, HitboxBehavior::Normal)));
            }
            painted.lines.push(PaintedLine {
                row,
                number,
                fold,
                folded,
                marker_opacity: 0.,
            });
        }
        Some((painted, hitboxes, column_hitbox))
    }

    /// Paint the numbers and markers laid out in [`Self::prepaint_gutter`],
    /// and follow the pointer over them.
    pub(super) fn paint_gutter(
        &mut self,
        bounds: Bounds<Pixels>,
        prepainted: Option<(PaintedGutter, Vec<(u32, Hitbox)>, Hitbox)>,
        fades: GutterFades,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((mut painted, hitboxes, column_hitbox)) = prepainted else {
            *self.painted_gutter.borrow_mut() = PaintedGutter::default();
            return;
        };
        let lattice = cx.lattice();
        let ink = editor_theme::gutter_ink(lattice.code_theme, &lattice.palette);
        let caret_row = self.caret_row(cx);
        let (font, font_size) = buffer_font(cx);
        let line_height = painted
            .lines
            .first()
            .map_or(px(0.), |line| line.number.size.height);

        for (_, hitbox) in &hitboxes {
            window.set_cursor_style(CursorStyle::PointingHand, hitbox);
        }

        // The numbers scroll under the same edges as the text.
        let text_rows = Bounds {
            origin: point(bounds.left(), bounds.top() + CONTENT_PADDING),
            size: size(
                bounds.size.width,
                (bounds.size.height - CONTENT_PADDING * 2.).max(px(0.)),
            ),
        };
        window.with_content_mask(Some(gpui::ContentMask { bounds: text_rows }), |window| {
            for line in &mut painted.lines {
                let color = if Some(line.row) == caret_row {
                    ink.current
                } else {
                    ink.number
                };
                let label: SharedString = (line.row + 1).to_string().into();
                let run = TextRun {
                    len: label.len(),
                    font: font.clone(),
                    color,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let shaped = window
                    .text_system()
                    .shape_line(label, font_size, &[run], None);
                let digits = Bounds {
                    origin: point(line.number.left() + NUMBER_START, line.number.top()),
                    size: size(
                        line.number.size.width - NUMBER_START - NUMBER_END,
                        line_height,
                    ),
                };
                shaped
                    .paint(
                        digits.origin,
                        line_height,
                        TextAlign::Right,
                        Some(digits.size.width),
                        window,
                        cx,
                    )
                    .ok();

                let Some(cell) = line.fold else {
                    continue;
                };
                // Quiet until the pointer is over the gutter; a folded line
                // keeps its marker.
                let opacity = if line.folded { 1. } else { fades.reveal };
                line.marker_opacity = opacity;
                if opacity <= 0. {
                    continue;
                }
                let toward_ink = if fades.marker.0 == Some(line.row) {
                    fades.marker.1
                } else if fades.left_marker.0 == Some(line.row) {
                    fades.left_marker.1
                } else {
                    0.
                };
                let color = mix(ink.marker, ink.current, toward_ink);
                paint_chevron(cell, line.folded, color.opacity(opacity * color.a), window);
            }
        });

        // The pointer: the column reveals the markers, a marker takes the
        // ink, a press on one folds or unfolds its line.
        let this = cx.weak_entity();
        let markers: Rc<Vec<(u32, Hitbox)>> = Rc::new(hitboxes);
        {
            let markers = markers.clone();
            let column_hitbox = column_hitbox.clone();
            let this = this.clone();
            window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let over = column_hitbox.is_hovered(window);
                let marker = markers
                    .iter()
                    .find(|(_, hitbox)| hitbox.is_hovered(window))
                    .map(|(row, _)| *row);
                this.update(cx, |this, cx| this.set_gutter_pointer(over, marker, cx))
                    .ok();
            });
        }
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
                return;
            }
            let Some(row) = markers
                .iter()
                .find(|(_, hitbox)| hitbox.is_hovered(window))
                .map(|(row, _)| *row)
            else {
                return;
            };
            cx.stop_propagation();
            window.prevent_default();
            this.update(cx, |this, cx| this.toggle_fold(row, window, cx))
                .ok();
        });

        if lattice_ui::parity::enabled() {
            record_parity(&painted, &font, font_size, self.end_clearance, bounds);
        }

        let animating = fades.reveal > 0. && fades.reveal < 1.
            || (fades.marker.1 > 0. && fades.marker.1 < 1.)
            || (fades.left_marker.1 > 0. && fades.left_marker.1 < 1.);
        if animating {
            window.request_animation_frame();
        }
        *self.painted_gutter.borrow_mut() = painted;
    }

    fn set_gutter_pointer(&mut self, over: bool, marker: Option<u32>, cx: &mut Context<Self>) {
        let pointer = &mut self.gutter_pointer;
        if pointer.over == over && pointer.marker == marker {
            return;
        }
        if pointer.marker != marker && pointer.marker.is_some() {
            pointer.left_marker = pointer.marker;
        }
        pointer.over = over;
        pointer.marker = marker;
        cx.notify();
    }

    /// The caret's buffer row.
    fn caret_row(&self, cx: &App) -> Option<u32> {
        use editor::ToPoint as _;
        let editor = self.editor.read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        Some(
            editor
                .selections
                .newest_anchor()
                .head()
                .to_point(&snapshot)
                .row,
        )
    }

    /// Fold `row`'s range, or unfold it when it is folded.
    pub fn toggle_fold(&mut self, row: u32, window: &mut Window, cx: &mut Context<Self>) {
        let Some(source) = self.folds.clone() else {
            return;
        };
        let text = self.buffer.read(cx).snapshot();
        let Some(range) = self.fold_at(&source, &text, row) else {
            return;
        };
        let range = language::Point::new(range.start.0, range.start.1)
            ..language::Point::new(range.end.0, range.end.1);
        let folded = self.is_folded(row, window, cx);
        let placeholder = self.fold_placeholder(cx);
        self.editor.update(cx, |editor, cx| {
            if folded {
                editor.unfold_ranges(std::slice::from_ref(&range), true, false, cx);
            } else {
                editor.fold_creases(vec![Crease::simple(range, placeholder)], false, window, cx);
            }
        });
        cx.notify();
    }

    /// Whether `row` is folded.
    pub fn is_folded(&self, row: u32, window: &mut Window, cx: &mut App) -> bool {
        self.editor.update(cx, |editor, cx| {
            editor
                .snapshot(window, cx)
                .display_snapshot
                .is_line_folded(MultiBufferRow(row))
        })
    }

    /// The folded range's stand-in (`.cm-foldPlaceholder`): an ellipsis on a
    /// 4px-cornered chip of the code ink at 5%, in the markers' ink; a click
    /// unfolds it.
    fn fold_placeholder(&self, cx: &App) -> FoldPlaceholder {
        let lattice = cx.lattice();
        let ink = editor_theme::gutter_ink(lattice.code_theme, &lattice.palette);
        let chip = ink.current.opacity(0.05 * ink.current.a);
        let color = ink.marker;
        let editor: WeakEntity<Editor> = self.editor.downgrade();
        FoldPlaceholder {
            render: std::sync::Arc::new(move |id, range: Range<editor::Anchor>, _| {
                let editor = editor.clone();
                div()
                    .id(id)
                    .mx(px(2.))
                    .px(px(4.))
                    .rounded(px(4.))
                    .bg(chip)
                    .text_color(color)
                    .cursor_pointer()
                    .child("…")
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(move |_, _, cx| {
                        let range = range.clone();
                        editor
                            .update(cx, |editor, cx| {
                                editor.unfold_ranges(&[range.start..range.end], true, true, cx)
                            })
                            .ok();
                    })
                    .into_any_element()
            }),
            constrain_width: false,
            merge_adjacent: true,
            type_tag: None,
            collapsed_text: None,
        }
    }
}

/// The first line's number cell (with its digits' style), fold cell and
/// line box, for the parity harness (`editor/line-number`, `editor/fold`,
/// `editor/line`).
fn record_parity(
    painted: &PaintedGutter,
    font: &Font,
    font_size: Pixels,
    clearance: Pixels,
    view: Bounds<Pixels>,
) {
    use lattice_ui::parity::{Region, TextLook, record};
    let (Some(first), Some(text_left)) = (painted.lines.first(), painted.text_left) else {
        return;
    };
    let mut texts = std::collections::BTreeMap::new();
    texts.insert(
        0,
        TextLook {
            content: Some((first.row + 1).to_string().into()),
            family: font.family.clone(),
            size: f32::from(font_size),
            weight: font.weight.0,
            line_height: f32::from(first.number.size.height),
        },
    );
    record(
        "editor/line-number",
        Region {
            bounds: Some(first.number),
            texts,
        },
    );
    record(
        "editor/fold",
        Region {
            bounds: Some(Bounds {
                origin: point(first.number.right(), first.number.top()),
                size: size(FOLD_COLUMN, first.number.size.height),
            }),
            texts: Default::default(),
        },
    );
    let line_left = text_left - LINE_PADDING;
    record(
        "editor/line",
        Region {
            bounds: Some(Bounds {
                origin: point(line_left, first.number.top()),
                size: size(
                    view.right() - line_box_end(clearance) - line_left,
                    first.number.size.height,
                ),
            }),
            texts: Default::default(),
        },
    );
}

/// CodeMirror's chevron (`M3.25 4.75 6 7.5l2.75-2.75` on a 12-unit grid,
/// 1.5 wide), centred in its cell; turned a quarter to point right on a
/// folded line.
fn paint_chevron(cell: Bounds<Pixels>, folded: bool, color: Hsla, window: &mut Window) {
    let marker = Bounds {
        origin: point(
            cell.left() + (cell.size.width - MARKER) / 2.,
            cell.top() + (cell.size.height - MARKER) / 2.,
        ),
        size: size(MARKER, MARKER),
    };
    let points: Vec<Point<f32>> = [(3.25, 4.75), (6., 7.5), (8.75, 4.75)]
        .into_iter()
        .map(|(x, y)| {
            if folded {
                // Rotated -90° about the grid's centre (6, 6).
                point(y, 12. - x)
            } else {
                point(x, y)
            }
        })
        .collect();
    stroke::paint(&points, 12., marker, 1.5, color, window);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_numbers_keep_four_digits_until_ten_thousand_lines() {
        assert_eq!(digits_for(1), 4);
        assert_eq!(digits_for(9_999), 4);
        assert_eq!(digits_for(10_000), 5);
    }

    #[test]
    fn the_text_starts_where_codemirror_s_does() {
        // Ioskeley Mono at 14px: a digit is 8.4px, so the number cell is
        // 45.6px and the text starts 67.6px in (the Tauri app measures
        // 45.59 and 61.59 + 6).
        let layout = GutterLayout {
            ch: px(8.4),
            digits: 4,
        };
        assert!((f32::from(layout.number_width()) - 45.6).abs() < 0.01);
        assert!((f32::from(layout.width()) - 61.6).abs() < 0.01);
        assert!((f32::from(layout.text_start()) - 67.6).abs() < 0.01);
        // Beside the rail's 36px the element ends 36 + 2 - 16.8 in, so Zed
        // wraps where CodeMirror does (its first line box ends at 901px in a
        // 937px editor).
        assert!((f32::from(layout.element_end(px(36.))) - 21.2).abs() < 0.01);
    }
}
