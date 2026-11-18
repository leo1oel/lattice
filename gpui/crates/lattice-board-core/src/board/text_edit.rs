// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The text editor's layout and lifecycle, without the DOM. Port of the
//! non-DOM logic of Excalidraw @ 3a317b5 `packages/excalidraw/wysiwyg/textWysiwyg.tsx`
//! (where the editor box goes and how big it is, container auto-grow /
//! auto-shrink while typing, caret geometry, Tab indenting, what submitting
//! does) and of the editing session in `excalidraw/components/App.text.ts`
//! (`handleTextWysiwyg`'s `updateElement` / `onSubmit`, `getMaxTextWidth`,
//! `getTextWysiwygSnappedToCenterPosition`, the container and position
//! decisions of `startTextEditing`).
//!
//! The GPUI editor owns the text buffer, selection, IME and painting; it
//! calls `TextEditSession` on every change (`on_change`), on scroll / zoom /
//! style changes (`update_style`) and on blur / Escape / Cmd+Enter
//! (`submit`), and paints its box from `EditorLayout`. Upstream re-runs
//! `updateWysiwygStyle` synchronously whenever the scene updates; here
//! `update_style` repeats its pass until no container was resized, which is
//! where those nested runs settle. Upstream's browser bidi caret lookups are
//! replaced by measuring prefixes (`caret_*`). Offsets are byte offsets.
//!
//! Bound arrows are the binding module's: the app runs `updateBoundElements`
//! on the ids results name, and `fixBindingsAfterDeletion` when a submit
//! deleted the text.

use super::consts::*;
use super::math::{Point, point_rotate_rads};
use super::mutate::bump_version;
use super::scene::Scene;
use super::sticky::{StickyNoteLayoutOpts, get_sticky_note_layout};
use super::text::*;
use super::text_measure::{
    Font, Measure, get_approx_min_line_height, get_approx_min_line_width, get_line_height_in_px,
    get_line_width, normalize_text,
};
use super::text_wrapping::{get_wrapped_text_lines, js_space};
use super::types::{BoundElement, BoundType, Element, TextAlign, VerticalAlign};
use super::utils::ElementsMap;
use super::viewport::{Canvas, Viewport, scene_coords_to_viewport_coords};

/// The view the editor sits in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EditView {
    pub viewport: Viewport,
    pub canvas: Canvas,
}

impl EditView {
    /// `getViewportCoords`: scene to canvas-relative screen coordinates.
    pub fn to_view(&self, p: Point) -> Point {
        let [x, y] = scene_coords_to_viewport_coords(p, self.viewport, self.canvas);
        [x - self.canvas.offset_left, y - self.canvas.offset_top]
    }
}

/// `getEditorPlacement`: the editor box (origin top-left, `width` wide in
/// scene units) maps to the screen as
/// `translate(anchor) · rotate(angle) · scale(zoom) · translate(origin_x, 0)`:
/// the text's anchor (the point its alignment grows it away from) is pinned
/// to its place on the canvas, so typing on one line leaves the others still.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EditorPlacement {
    /// Box width: whole px unless it wraps (then the canvas's wrap width).
    pub width: f64,
    pub anchor: Point,
    pub angle: f64,
    pub zoom: f64,
    /// `-width × anchor ratio`.
    pub origin_x: f64,
}

impl EditorPlacement {
    /// Box-local point (scene units) to canvas-relative screen coordinates.
    pub fn to_view(&self, p: Point) -> Point {
        let (s, c) = self.angle.sin_cos();
        let (x, y) = ((p[0] + self.origin_x) * self.zoom, p[1] * self.zoom);
        [
            self.anchor[0] + x * c - y * s,
            self.anchor[1] + x * s + y * c,
        ]
    }
}

fn anchor_ratio(align: TextAlign) -> f64 {
    match align {
        TextAlign::Center => 0.5,
        TextAlign::Right => 1.,
        TextAlign::Left => 0.,
    }
}

/// `getEditorPlacement`. `(x, y)` is the text's unrotated top-left.
pub fn get_editor_placement(
    x: f64,
    y: f64,
    text_width: f64,
    text_height: f64,
    box_width: f64,
    wraps: bool,
    align: TextAlign,
    angle: f64,
    zoom: f64,
    to_view: impl Fn(Point) -> Point,
) -> EditorPlacement {
    let width = if wraps { box_width } else { box_width.ceil() };
    let ratio = anchor_ratio(align);
    // the canvas rotates the text about its center
    let anchor = point_rotate_rads(
        [x + text_width * ratio, y],
        [x + text_width / 2., y + text_height / 2.],
        angle,
    );
    EditorPlacement {
        width,
        anchor: to_view(anchor),
        angle,
        zoom,
        origin_x: -width * ratio,
    }
}

/// The text's box as the editor lays it out (`currentTextLayout`), in scene
/// coordinates: what the caret math works in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub angle: f64,
    pub line_height_px: f64,
    pub align: TextAlign,
    pub font: Font,
}

/// What `updateWysiwygStyle` sets on the editor.
#[derive(Clone, Debug, PartialEq)]
pub struct EditorLayout {
    pub placement: EditorPlacement,
    /// Box height in scene units (the text's, plus a 5% buffer; grow it to
    /// the content if glyphs reach further).
    pub height: f64,
    pub font: Font,
    /// Unitless.
    pub line_height: f64,
    pub text_align: TextAlign,
    pub vertical_align: VerticalAlign,
    /// `white-space: pre-wrap`: the editor wraps at `placement.width`.
    pub wraps: bool,
    pub color: String,
    /// 0..1.
    pub opacity: f64,
    pub text: TextBox,
}

/// `update_style`'s result: the layout (None once the text is gone) and the
/// containers it resized, whose bound arrows need `updateBoundElements`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StyleUpdate {
    pub layout: Option<EditorLayout>,
    pub resized_containers: Vec<String>,
}

/// `on_change`'s result.
#[derive(Clone, Debug, PartialEq)]
pub struct ChangeResult {
    /// The editor's new value: `\r\n` and tabs normalized (keep the caret
    /// near where it was).
    pub value: String,
    /// A growing text just started wrapping: scroll its bounds into view.
    pub started_wrapping: bool,
    /// A sticky note refitted around the text: run `updateBoundElements` on it.
    pub sticky_container: Option<String>,
    pub style: StyleUpdate,
}

/// What submitting did.
#[derive(Clone, Debug, PartialEq)]
pub struct SubmitOutcome {
    /// Empty (or whitespace-only) text is deleted: run
    /// `fixBindingsAfterDeletion` for it.
    pub is_deleted: bool,
    /// Keyboard submit selects the container, or the text if it survived
    /// (unless the tool is locked or autoshape, the app's call).
    pub select_id: Option<String>,
    /// Whether to capture a history entry (`scheduleCapture`).
    pub capture: bool,
    pub sticky_container: Option<String>,
}

/// One editing session (the `textWysiwyg` closure state and
/// `handleTextWysiwyg`'s callbacks).
#[derive(Clone, Debug)]
pub struct TextEditSession {
    pub element_id: String,
    /// The text's container when editing started.
    pub container_id: Option<String>,
    pub is_existing_element: bool,
    /// `white-space: pre-wrap`.
    wraps: bool,
    /// The font the editor last showed (`textPropertiesUpdated`).
    font: Option<Font>,
    done: bool,
}

impl TextEditSession {
    /// Starts editing `element_id` (call `update_element` with its
    /// `originalText` next, as `handleTextWysiwyg` does, then `update_style`).
    pub fn new(scene: &Scene, element_id: &str, is_existing_element: bool) -> TextEditSession {
        let t = scene.get_element(element_id);
        let wraps = t
            .is_some_and(|t| t.is_bound_to_container() || t.text().is_some_and(|d| !d.auto_resize));
        TextEditSession {
            element_id: element_id.into(),
            container_id: t.and_then(|t| t.container_id()).map(str::to_owned),
            is_existing_element,
            wraps,
            font: None,
            done: false,
        }
    }

    pub fn is_done(&self) -> bool {
        self.done
    }
    pub fn wraps(&self) -> bool {
        self.wraps
    }

    /// `updateWysiwygStyle`.
    pub fn update_style(&mut self, scene: &mut Scene, view: &EditView) -> StyleUpdate {
        let mut out = StyleUpdate::default();
        for _ in 0..4 {
            match self.style_pass(scene, view) {
                Pass::Resized(id) => {
                    if !out.resized_containers.contains(&id) {
                        out.resized_containers.push(id);
                    }
                }
                Pass::Done(l) => {
                    out.layout = l;
                    return out;
                }
            }
        }
        out.layout = match self.style_pass(scene, view) {
            Pass::Done(l) => l,
            Pass::Resized(_) => None,
        };
        out
    }

    fn style_pass(&mut self, scene: &mut Scene, view: &EditView) -> Pass {
        let Some(t) = scene
            .get_element(&self.element_id)
            .filter(|t| t.is_text())
            .cloned()
        else {
            return Pass::Done(None);
        };
        let td = t.text().unwrap().clone();
        let [mut cx, mut cy] = [t.x, t.y];
        let container = get_container_element(&t, scene).cloned();
        let (mut width, mut height) = (t.width, t.height);
        if let Some(c) = &container {
            // (arrow labels: `compute_bound_text_position` puts them on the path)
            let max_h = get_bound_text_max_height(c, &t);
            if c.is_sticky_note() {
                // the sticky fit owns the note's height; mirror the label
                [cx, cy] = compute_bound_text_position(c, &t, scene);
            } else {
                let props_updated = self.font.is_some_and(|f| f != font_of(&t));
                let original = if props_updated {
                    update_original_container_cache(&c.id, c.height)
                } else {
                    get_original_container_height_from_cache(&c.id)
                        .unwrap_or_else(|| update_original_container_cache(&c.id, c.height))
                };
                if !c.is_arrow() && height > max_h {
                    // grow the container for the text
                    let h = compute_container_dimension_for_bound_text(height, c.ty());
                    scene.mutate_element(&c.id, true, |e| e.height = h);
                    return Pass::Resized(c.id.clone());
                } else if !c.is_arrow() && c.height > original && height < max_h {
                    // shrink it back as text is removed, down to its original height
                    let h = compute_container_dimension_for_bound_text(height, c.ty());
                    scene.mutate_element(&c.id, true, |e| e.height = h);
                    return Pass::Resized(c.id.clone());
                } else {
                    [cx, cy] = compute_bound_text_position(c, &t, scene);
                }
            }
        }
        let angle = get_text_element_angle(&t, container.as_ref());
        if container.is_some() {
            width += 0.5;
        }
        // a 5% buffer, or the editor jumps
        height *= 1.05;
        let font = font_of(&t);
        let wraps = container.is_some() || !td.auto_resize;
        let placement = get_editor_placement(
            cx,
            cy,
            t.width,
            t.height,
            width,
            wraps,
            td.text_align,
            angle,
            view.viewport.zoom,
            |p| view.to_view(p),
        );
        // a free text that stopped growing wraps from then on, and so does its editor
        if !td.auto_resize {
            self.wraps = true;
        }
        self.font = Some(font);
        let layout = EditorLayout {
            placement,
            height,
            font,
            line_height: td.line_height,
            text_align: td.text_align,
            vertical_align: td.vertical_align,
            wraps: self.wraps,
            color: t.stroke_color.clone(),
            opacity: t.opacity / 100.,
            text: TextBox {
                x: cx,
                y: cy,
                width: t.width,
                height: t.height,
                angle,
                line_height_px: get_line_height_in_px(td.font_size, td.line_height),
                align: td.text_align,
                font,
            },
        };
        scene.mutate_element(&t.id, true, |e| (e.x, e.y) = (cx, cy));
        Pass::Done(Some(layout))
    }

    /// `handleTextWysiwyg`'s `updateElement`: sets the text to `next`
    /// (wrapped and measured; a sticky note refits around it). `max_width`
    /// is `get_max_text_width` for the view. Returns (started wrapping, the
    /// refitted sticky note).
    pub fn update_element(
        &mut self,
        scene: &mut Scene,
        m: &dyn Measure,
        next: &str,
        is_deleted: bool,
        max_width: f64,
    ) -> (bool, Option<String>) {
        let Some(t) = scene
            .get_element(&self.element_id)
            .filter(|t| t.is_text())
            .cloned()
        else {
            return (false, None);
        };
        let container = get_container_element(&t, scene).cloned();
        let sticky = container.as_ref().filter(|c| c.is_sticky_note());
        let layout = sticky.map(|c| {
            get_sticky_note_layout(
                c,
                Some(&t),
                &StickyNoteLayoutOpts {
                    original_text: Some(next.into()),
                    ..Default::default()
                },
                m,
            )
        });
        let dims = if layout.is_none() {
            refresh_text_dimensions(
                &t,
                container.as_ref(),
                scene,
                Some(next),
                Some(max_width),
                m,
            )
        } else {
            None
        };
        if let (Some(c), Some(l)) = (sticky, &layout) {
            scene.mutate_element(&c.id, true, |e| l.container.apply(e));
        }
        scene.mutate_element(&t.id, true, |e| {
            e.is_deleted = is_deleted;
            if let Some(d) = e.text_mut() {
                d.original_text = next.into();
            }
            if let Some(lt) = layout.as_ref().and_then(|l| l.text.as_ref()) {
                lt.apply(e);
            } else if let Some(d) = &dims {
                d.apply(e);
            }
        });
        let now_wraps = scene
            .get_element(&t.id)
            .and_then(|e| e.text())
            .is_some_and(|d| !d.auto_resize);
        (
            t.text().is_some_and(|d| d.auto_resize) && now_wraps && !is_deleted,
            sticky.map(|c| c.id.clone()),
        )
    }

    /// `oninput` → `onChange`: normalizes the value, updates the element and
    /// the editor. The app then runs `updateBoundElements` on the text.
    pub fn on_change(
        &mut self,
        scene: &mut Scene,
        m: &dyn Measure,
        value: &str,
        max_width: f64,
        view: &EditView,
    ) -> ChangeResult {
        let value = normalize_text(value);
        let (started_wrapping, sticky_container) =
            self.update_element(scene, m, &value, false, max_width);
        let style = self.update_style(scene, view);
        ChangeResult {
            value,
            started_wrapping,
            sticky_container,
            style,
        }
    }

    /// `handleSubmit` → `onSubmit`: binds a non-empty label to its container
    /// (or unlists an empty one) and re-lays it out, then sets the final
    /// text; whitespace-only text is deleted. None if already submitted.
    pub fn submit(
        &mut self,
        scene: &mut Scene,
        m: &dyn Measure,
        value: &str,
        via_keyboard: bool,
        max_width: f64,
    ) -> Option<SubmitOutcome> {
        if self.done {
            return None;
        }
        self.done = true;
        let t = scene.get_element(&self.element_id)?.clone();
        let blank = value.trim_matches(js_space).is_empty();
        if let Some(c) = get_container_element(&t, scene).cloned() {
            if !blank {
                if c.bound_text_id() != Some(t.id.as_str()) {
                    scene.mutate_element(&c.id, true, |e| {
                        e.bound_elements
                            .get_or_insert_with(Vec::new)
                            .push(BoundElement {
                                id: t.id.clone(),
                                kind: BoundType::Text,
                            })
                    });
                } else if c.is_arrow() {
                    // a new label may change the arrow's bounds
                    scene.mutate_element(&c.id, true, |e| bump_version(e, None));
                }
            } else {
                scene.mutate_element(&c.id, true, |e| {
                    if let Some(b) = &mut e.bound_elements {
                        b.retain(|b| b.kind != BoundType::Text)
                    }
                });
            }
            if let Some(t) = scene.get_element(&t.id).cloned() {
                redraw_text_bounding_box(scene, &t, Some(&c.id), m);
            }
        }
        let (_, sticky_container) = self.update_element(scene, m, value, blank, max_width);
        Some(SubmitOutcome {
            is_deleted: blank,
            select_id: via_keyboard
                .then(|| {
                    self.container_id
                        .clone()
                        .or_else(|| (!blank).then(|| self.element_id.clone()))
                })
                .flatten(),
            capture: !blank || self.is_existing_element,
            sticky_container,
        })
    }
}

enum Pass {
    Resized(String),
    Done(Option<EditorLayout>),
}

// ---------------------------------------------------------------------------
// caret
// ---------------------------------------------------------------------------

fn line_start_x(m: &dyn Measure, b: &TextBox, line: &str) -> (f64, f64) {
    let w = get_line_width(m, line, b.font);
    (
        match b.align {
            TextAlign::Center => (b.width - w) / 2.,
            TextAlign::Right => b.width - w,
            TextAlign::Left => 0.,
        },
        w,
    )
}

/// `getLineDirection`: the direction of the hard line around `offset`.
fn line_is_rtl(text: &str, offset: usize) -> bool {
    let start = text[..offset.min(text.len())]
        .rfind('\n')
        .map_or(0, |i| i + 1);
    let end = text[offset.min(text.len())..]
        .find('\n')
        .map_or(text.len(), |i| offset + i);
    super::display::is_rtl(&text[start..end])
}

/// `getCaretIndexFromInitialSceneCoords`: the caret offset closest to a
/// scene point (a click that started the edit).
pub fn caret_index_at(
    m: &dyn Measure,
    b: &TextBox,
    value: &str,
    point: Point,
    wraps: bool,
) -> usize {
    let [ux, uy] = point_rotate_rads(point, [b.x + b.width / 2., b.y + b.height / 2.], -b.angle);
    let (lx, ly) = (ux - b.x, uy - b.y);
    let lines = get_wrapped_text_lines(
        m,
        value,
        b.font,
        if wraps { b.width } else { f64::INFINITY },
    );
    let i = ((ly / b.line_height_px).floor().min(lines.len() as f64 - 1.)).max(0.) as usize;
    let line = &lines[i];
    if line.text.is_empty() {
        return line.start;
    }
    let (sx, w) = line_start_x(m, b, &line.text);
    let target = lx - sx;
    let rtl = line_is_rtl(value, line.start);
    let mut best = (0, f64::INFINITY);
    for off in line
        .text
        .char_indices()
        .map(|(i, _)| i)
        .chain([line.text.len()])
    {
        let before = get_line_width(m, &line.text[..off], b.font);
        let x = if rtl { w - before } else { before };
        if (x - target).abs() < best.1 {
            best = (off, (x - target).abs());
        }
    }
    line.start + best.0
}

/// `getCaretViewportBounds`: the caret's line-high stroke on screen
/// (`[left, top, right, bottom]`, via `to_view`).
pub fn caret_viewport_bounds(
    m: &dyn Measure,
    b: &TextBox,
    value: &str,
    caret: usize,
    wraps: bool,
    to_view: impl Fn(Point) -> Point,
) -> [f64; 4] {
    let lines = get_wrapped_text_lines(
        m,
        value,
        b.font,
        if wraps { b.width } else { f64::INFINITY },
    );
    // at a soft break, the caret shows at the start of the next line
    let i = lines.iter().rposition(|l| l.start <= caret).unwrap_or(0);
    let line = &lines[i];
    let (sx, w) = line_start_x(m, b, &line.text);
    let src = value.get(line.start..line.end).unwrap_or(&line.text);
    let off = caret.min(line.end) - line.start;
    let before = get_line_width(m, src.get(..off).unwrap_or(src), b.font);
    let x = sx
        + if line_is_rtl(value, line.start) {
            w - before
        } else {
            before
        };
    let center = [b.x + b.width / 2., b.y + b.height / 2.];
    let [x1, y1] = to_view(point_rotate_rads(
        [b.x + x, b.y + i as f64 * b.line_height_px],
        center,
        b.angle,
    ));
    let [x2, y2] = to_view(point_rotate_rads(
        [b.x + x, b.y + (i + 1) as f64 * b.line_height_px],
        center,
        b.angle,
    ));
    [x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)]
}

// ---------------------------------------------------------------------------
// Tab / Shift+Tab
// ---------------------------------------------------------------------------

pub const TAB_SIZE: usize = 4;

/// `getSelectedLinesStartIndices`: starts of the selected lines, last first.
pub fn get_selected_lines_start_indices(value: &str, start: usize, end: usize) -> Vec<usize> {
    let start = value[..start].rfind('\n').map_or(0, |i| i + 1);
    let mut out = vec![];
    let mut at = start;
    for l in value[start..end.max(start)].split('\n') {
        out.push(at);
        at += l.len() + 1;
    }
    out.reverse();
    out
}

/// `indent`: four spaces at the start of each selected line. Returns the
/// value and the new selection.
pub fn indent(value: &str, start: usize, end: usize) -> (String, usize, usize) {
    let lines = get_selected_lines_start_indices(value, start, end);
    let mut v = value.to_owned();
    for &i in &lines {
        v.insert_str(i, &" ".repeat(TAB_SIZE));
    }
    (v, start + TAB_SIZE, end + TAB_SIZE * lines.len())
}

/// `outdent`: up to four leading spaces off each selected line.
pub fn outdent(value: &str, start: usize, end: usize) -> (String, usize, usize) {
    let mut v = value.to_owned();
    let mut removed = vec![];
    for i in get_selected_lines_start_indices(value, start, end) {
        let n = v.as_bytes()[i..]
            .iter()
            .take(TAB_SIZE)
            .take_while(|&&b| b == b' ')
            .count();
        if n > 0 {
            v.replace_range(i..i + n, "");
            removed.push(i);
        }
    }
    let Some(&last) = removed.last() else {
        return (v, start, end);
    };
    let s = if start > last {
        start.saturating_sub(TAB_SIZE).max(last)
    } else {
        start
    };
    (v, s, s.max(end.saturating_sub(TAB_SIZE * removed.len())))
}

// ---------------------------------------------------------------------------
// App.text.ts
// ---------------------------------------------------------------------------

/// `getMaxTextWidth`: the widest a typed text grows, in scene units: the
/// view between the `left` / `right` offsets (`getTextViewportOffsets`, at
/// least `TEXT_VIEWPORT_PADDING` each), or `TEXT_MAX_WRAP_WIDTH`.
pub fn get_max_text_width(view_width: f64, left: f64, right: f64, zoom: f64) -> f64 {
    let w = view_width - left - right;
    (if w > 0. { w / zoom } else { f64::INFINITY }).min(TEXT_MAX_WRAP_WIDTH)
}

/// `getTextWysiwygSnappedToCenterPosition`: the container's label center
/// (and its screen position) when the point is close enough to snap to it.
pub fn get_text_wysiwyg_snapped_to_center_position(
    x: f64,
    y: f64,
    container: Option<&Element>,
    map: &dyn ElementsMap,
    view: &EditView,
) -> Option<(Point, Point)> {
    let c = get_container_center(container?, map);
    if (x - c[0]).hypot(y - c[1]) >= TEXT_TO_CENTER_SNAP_THRESHOLD {
        return None;
    }
    Some((
        scene_coords_to_viewport_coords(c, view.viewport, view.canvas),
        c,
    ))
}

/// `startTextEditing`'s growth of an empty, non-arrow, non-note container a
/// new label binds to: at least one line high and one character wide.
/// Returns the container's new center (where the label is created).
pub fn grow_container_for_new_label(
    scene: &mut Scene,
    container_id: &str,
    font: Font,
    line_height: f64,
    m: &dyn Measure,
) -> Option<Point> {
    let c = scene.get_element(container_id)?.clone();
    let w = c.width.max(get_approx_min_line_width(m, font, line_height));
    let h = c
        .height
        .max(get_approx_min_line_height(font.size, line_height));
    scene.mutate_element(container_id, true, |e| (e.width, e.height) = (w, h));
    Some([c.x + w / 2., c.y + h / 2.])
}

/// `startTextEditing`'s position for a new free text clicked at a point:
/// the grid cell's top-left with a grid, else the first line centered on
/// the point.
pub fn new_free_text_position(
    x: f64,
    y: f64,
    font_size: f64,
    line_height: f64,
    grid_size: Option<f64>,
) -> Point {
    match grid_size {
        Some(g) => [(x / g).floor() * g, (y / g).floor() * g],
        None => [x, y - get_line_height_in_px(font_size, line_height) / 2.],
    }
}
