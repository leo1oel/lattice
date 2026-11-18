// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Input on the board canvas, after Excalidraw's `App.tsx` handlers @
//! 3a317b5: `handleCanvasPointerDown` (what the active tool starts),
//! `onPointerMoveFromPointerDownHandler` / `onPointerUpFromPointerDownHandler`
//! (the gesture in progress, `Gesture`), `handleCanvasPointerMove` (hover:
//! cursor, the line being drawn click by click), `handleCanvasDoubleClick`,
//! `handleCanvasContextMenu`, `handleWheel` (`App.wheel.ts`), panning
//! (`App.pan.ts`) and file drops (`handleAppOnDrop`). Hit testing is
//! `getElementAtPosition` / `getElementsAtPosition` / `hitElement`, with an
//! AABB cache per element version in front of core's exact tests.

use super::BoardView;
use super::app_state::ToolType;
use super::bounds::get_element_bounds;
use super::collision::{
    FrameNameBounds, HitTestArgs, hit_element_bound_text, hit_element_bounding_box,
    hit_element_itself,
};
use super::consts::DEFAULT_COLLISION_THRESHOLD;
use super::handles::has_bounding_box;
use super::tools;
use super::types::Element;
use super::viewport::{Viewport, get_normalized_zoom, get_viewport_for_zoom};
use gpui::*;
use rustc_hash::FxHashMap;

/// The gesture in progress, from pointer down to up (`PointerDownState`
/// plus the tool's transients).
pub enum Gesture {
    /// Dragging the canvas: the pointer and scroll it started at.
    Pan {
        from: Point<Pixels>,
        scroll: (f64, f64),
    },
    Select(Box<tools::selection::SelectGesture>),
    Shape(tools::shape::ShapeGesture),
    Linear(tools::linear::LinearGesture),
    FreeDraw(tools::freedraw::FreeDrawGesture),
    Lasso(tools::lasso::LassoGesture),
    Eraser(tools::eraser::EraserGesture),
    /// A new free text being dragged out to a width.
    Text(tools::text::TextDrag),
}

/// Pointer modifiers as upstream reads them off events.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Mods {
    pub shift: bool,
    pub alt: bool,
    pub cmd: bool,
    pub ctrl: bool,
}
impl Mods {
    pub fn of(m: &Modifiers) -> Mods {
        Mods {
            shift: m.shift,
            alt: m.alt,
            cmd: m.platform,
            ctrl: m.control,
        }
    }
    /// `event[KEYS.CTRL_OR_CMD]`.
    pub fn ctrl_or_cmd(&self) -> bool {
        if cfg!(target_os = "macos") {
            self.cmd
        } else {
            self.ctrl
        }
    }
    pub fn linear(&self) -> super::linear::Modifiers {
        super::linear::Modifiers {
            shift: self.shift,
            alt: self.alt,
            ctrl_or_cmd: self.ctrl_or_cmd(),
        }
    }
    pub fn snap(&self) -> Option<super::snapping::SnapModifiers> {
        Some(super::snapping::SnapModifiers {
            ctrl_or_cmd: self.ctrl_or_cmd(),
        })
    }
}

/// The painted canvas: the scene (`render::Painter`), then the overlay.
pub fn canvas_element(me: &BoardView, cx: &mut Context<BoardView>) -> impl IntoElement {
    let (bounds, painter, entity) = (
        me.bounds.clone(),
        me.painter.clone(),
        cx.entity().downgrade(),
    );
    let overlay = super::overlay::build(me);
    let fit = entity.clone();
    canvas(
        // the canvas is the whole view: fit once its size is known, before
        // the first paint
        move |b, _, cx| {
            bounds.set(b);
            if let Some(e) = fit.upgrade() {
                e.update(cx, |v, cx| {
                    if !v.fitted {
                        v.fitted = true;
                        v.zoom_to_fit(cx)
                    }
                });
            }
        },
        move |b, _, window, cx| {
            let Some(e) = entity.upgrade() else { return };
            // borrow the scene for the paint (no clone per frame)
            let (scene, files, faded, view, bg, pending) = e.update(cx, |v, _| {
                let bg = crate::theme::canvas();
                let mut faded = v.faded.clone();
                if let Some(t) = &v.text {
                    faded.insert(t.session.element_id.clone(), 0.);
                }
                // pending flowchart nodes draw as elements, faded (`pendingFlowchartNodes`)
                let pending = v.flowchart.pending_nodes.clone().filter(|n| !n.is_empty());
                for n in pending.iter().flatten() {
                    faded.insert(
                        n.id.clone(),
                        (super::consts::ELEMENT_READY_TO_ERASE_OPACITY / 100.) as f32,
                    );
                }
                painter.borrow_mut().cropping = v.app.cropping_element_id.clone();
                (
                    std::mem::take(&mut v.scene),
                    std::mem::take(&mut v.files),
                    faded,
                    v.view(),
                    bg,
                    pending,
                )
            });
            match pending {
                Some(nodes) => {
                    let mut with = scene.clone();
                    with.insert_elements_at_index(nodes, None);
                    painter
                        .borrow_mut()
                        .paint_scene(&with, &files, bg, &faded, view, b, window, cx);
                }
                None => painter
                    .borrow_mut()
                    .paint_scene(&scene, &files, bg, &faded, view, b, window, cx),
            }
            e.update(cx, |v, _| {
                v.scene = scene;
                v.files = files;
            });
            window.with_content_mask(Some(ContentMask { bounds: b }), |window| {
                overlay.paint(window)
            });
        },
    )
    .absolute()
    .size_full()
}

/// `cursor.ts`: what the gesture or the hover asks for.
pub fn cursor(me: &BoardView) -> CursorStyle {
    match &me.gesture {
        Some(Gesture::Pan { .. }) => CursorStyle::ClosedHand,
        Some(Gesture::Select(s)) if s.resize.is_some() => me.hover_cursor,
        Some(Gesture::Select(s)) if s.arrow_label => CursorStyle::ClosedHand,
        Some(Gesture::Select(s)) if s.dragged => CursorStyle::Arrow,
        _ if me.space || me.app.active_tool.ty == ToolType::Hand => CursorStyle::OpenHand,
        _ => me.hover_cursor,
    }
}

/// A CSS resize cursor name to GPUI's.
pub fn css_cursor(s: &str) -> CursorStyle {
    match s {
        "ns-resize" => CursorStyle::ResizeUpDown,
        "ew-resize" => CursorStyle::ResizeLeftRight,
        "nwse-resize" => CursorStyle::ResizeUpLeftDownRight,
        "nesw-resize" => CursorStyle::ResizeUpRightDownLeft,
        "grab" => CursorStyle::OpenHand,
        _ => CursorStyle::Arrow,
    }
}

/// Upstream's pointer capture: while a gesture runs (a drag, a resize, a
/// selection box, a pan) a transparent layer over the whole board, chrome
/// included, hides everything else from the pointer (nothing hovers), and
/// every move goes to the gesture, wherever the pointer is: over the styles
/// panel or the toolbar, or outside the window (macOS keeps sending a drag
/// to the window it started in). GPUI's `on_mouse_move` only fires over its
/// element, so the layer listens to the window instead. The release reaches
/// the board as `on_mouse_up_out` (the layer hides it); the wheel still scrolls.
pub fn capture_layer(me: &BoardView, cx: &mut Context<BoardView>) -> Option<Div> {
    me.gesture.as_ref()?;
    let view = cx.entity().downgrade();
    let listen = canvas(
        |_, _, _| {},
        move |_, _, window, _| {
            window.on_mouse_event(move |ev: &MouseMoveEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble {
                    let _ = view.update(cx, |me, cx| moved(me, ev, window, cx));
                }
            });
        },
    )
    .absolute()
    .size_full();
    Some(
        div()
            .absolute()
            .inset_0()
            .occlude()
            .cursor(cursor(me))
            .on_scroll(cx.listener(wheel))
            .child(listen),
    )
}

pub fn listeners(d: Stateful<Div>, cx: &mut Context<BoardView>) -> Stateful<Div> {
    d.on_scroll(cx.listener(wheel))
        .on_mouse_down(MouseButton::Left, cx.listener(down))
        .on_mouse_down(MouseButton::Middle, cx.listener(down))
        .on_mouse_down(MouseButton::Right, cx.listener(right_down))
        .on_mouse_move(cx.listener(moved))
        .on_mouse_up(MouseButton::Left, cx.listener(up))
        .on_mouse_up(MouseButton::Middle, cx.listener(up))
        .on_mouse_up_out(MouseButton::Left, cx.listener(up))
        .on_mouse_up_out(MouseButton::Middle, cx.listener(up))
        .on_drop(cx.listener(|me, paths: &ExternalPaths, window, cx| {
            tools::image::drop_files(me, paths.paths().to_vec(), window, cx)
        }))
        .on_key_down(cx.listener(|me, ev: &KeyDownEvent, window, cx| {
            // (a space typed in a field isn't panning)
            if ev.keystroke.key == "space" && !me.space && me.focus.is_focused(window) {
                me.space = true;
                cx.notify();
            }
        }))
        .on_key_up(cx.listener(|me, ev: &KeyUpEvent, window, cx| {
            if ev.keystroke.key == "space" && me.space {
                me.space = false;
                cx.notify();
            }
            tools::flowchart::key_up(me, ev, window, cx);
        }))
        .on_modifiers_changed(cx.listener(|me, ev: &ModifiersChangedEvent, window, cx| {
            tools::flowchart::modifiers_changed(me, ev, window, cx);
            // holding ⌘ / Ctrl inverts the binding preference (`onKeyDown` /
            // `onKeyUp`)
            let cmd = Mods::of(&ev.modifiers).ctrl_or_cmd();
            me.app.is_binding_enabled = me.app.binding_preference != cmd;
            // re-run the hover (binding highlights, the line's next point)
            let p = me.pointer;
            hover(me, p, Mods::of(&ev.modifiers), window, cx);
        }))
}

/// `handleWheel`: GPUI's deltas point the other way from the DOM's.
fn wheel(me: &mut BoardView, ev: &ScrollEvent, _: &mut Window, cx: &mut Context<BoardView>) {
    let (dx, dy) = match ev.delta {
        ScrollDelta::Pixels(p) => (-f32::from(p.x) as f64, -f32::from(p.y) as f64),
        ScrollDelta::Lines(l) => (-l.x as f64 * 40., -l.y as f64 * 40.),
    };
    let v = me.viewport();
    if ev.modifiers.platform || ev.modifiers.control {
        // zoom about the pointer, upstream's curve
        let sign = dy.signum();
        let max_step = super::consts::ZOOM_STEP * 100.;
        let delta = if dy.abs() > max_step {
            max_step * sign
        } else {
            dy
        };
        let mut z = v.zoom - delta / 100.;
        z += v.zoom.max(1.).log10() * -sign * (dy.abs() / 20.).min(1.);
        let next = get_viewport_for_zoom(
            f32::from(ev.position.x) as f64,
            f32::from(ev.position.y) as f64,
            get_normalized_zoom(z),
            v,
            me.canvas(),
        );
        me.set_viewport(next, cx);
        return;
    }
    let (dx, dy) = if ev.modifiers.shift && dx == 0. {
        (dy, 0.)
    } else {
        (dx, dy)
    };
    me.set_viewport(
        Viewport {
            scroll_x: v.scroll_x - dx / v.zoom,
            scroll_y: v.scroll_y - dy / v.zoom,
            ..v
        },
        cx,
    );
}

fn down(me: &mut BoardView, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<BoardView>) {
    me.focus(window, cx);
    me.pointer = ev.position;
    me.menu = None;
    me.help = false;
    me.snap_lines.clear();
    // a click outside the text being edited submits it (the editor's own
    // clicks stop at its element)
    if me.text.is_some() {
        super::text_editor::submit(me, false, window, cx);
        if me.app.active_tool.ty != ToolType::Selection || ev.click_count > 1 {
            cx.notify();
            return;
        }
    }
    // as is a press outside the frame name being edited (its blur)
    if me.frame_name.is_some() {
        super::frame_name::end(me, cx);
    }
    if me.gesture.is_some() {
        return;
    }
    // panning: middle button, space, the hand tool
    if ev.button == MouseButton::Middle || me.space || me.app.active_tool.ty == ToolType::Hand {
        let v = me.viewport();
        me.gesture = Some(Gesture::Pan {
            from: ev.position,
            scroll: (v.scroll_x, v.scroll_y),
        });
        cx.notify();
        return;
    }
    let mods = Mods::of(&ev.modifiers);
    let p = me.scene_point(ev.position);
    if ev.click_count == 2
        && matches!(
            me.app.active_tool.ty,
            ToolType::Selection | ToolType::Lasso | ToolType::Text
        )
        && me.multi.is_none()
    {
        tools::selection::double_click(me, p, mods, window, cx);
        return;
    }
    match me.app.active_tool.ty {
        ToolType::Selection | ToolType::Lasso => tools::selection::down(me, p, mods, window, cx),
        ToolType::Text => tools::text::down(me, p, mods, window, cx),
        ToolType::Arrow | ToolType::Line => tools::linear::down(me, p, mods, window, cx),
        ToolType::FreeDraw => tools::freedraw::down(me, p, mods, cx),
        ToolType::Eraser => tools::eraser::down(me, p, cx),
        ToolType::Image => {}
        ToolType::Rectangle
        | ToolType::Diamond
        | ToolType::Ellipse
        | ToolType::Frame
        | ToolType::MagicFrame
        | ToolType::StickyNote => tools::shape::down(me, p, mods, cx),
        _ => {}
    }
    cx.notify();
}

/// `handleCanvasContextMenu`: selects what's under the pointer (unless it's
/// part of the selection) and opens the menu.
fn right_down(
    me: &mut BoardView,
    ev: &MouseDownEvent,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    me.focus(window, cx);
    me.finish_pending(window, cx);
    let p = me.scene_point(ev.position);
    let hit = me.element_at(p, false, false).map(|e| e.id.clone());
    let on_selection = match hit {
        Some(id) => {
            if !me.app.selected_element_ids.contains(&id) {
                tools::selection::select_only(me, &[id], false);
                me.commit(None, cx);
            }
            true
        }
        None => {
            if !me.app.selected_element_ids.is_empty()
                && !tools::selection::hits_selection_box(me, p)
            {
                me.clear_selection();
                me.set_linear(None);
                me.commit(None, cx);
            }
            !me.app.selected_element_ids.is_empty()
        }
    };
    me.menu = Some((ev.position, on_selection));
    cx.notify();
}

fn moved(
    me: &mut BoardView,
    ev: &MouseMoveEvent,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    me.pointer = ev.position;
    let mods = Mods::of(&ev.modifiers);
    let finished = ev.pressed_button.is_none()
        && me
            .gesture
            .as_ref()
            .is_some_and(|g| !matches!(g, Gesture::Linear(l) if l.multi_click));
    if finished {
        // the button came up outside the window
        let pos = ev.position;
        finish(me, pos, mods, window, cx);
    }
    let Some(g) = me.gesture.take() else {
        // hovering leaves the chrome as it was (it checks the content and
        // app state are); the mark lasts this event's notifications only
        if !finished {
            me.chrome_quiet.set(true);
        }
        hover(me, ev.position, mods, window, cx);
        if !finished {
            end_quiet(cx);
        }
        return;
    };
    let select = matches!(g, Gesture::Select(_));
    let p = me.scene_point(ev.position);
    let g = match g {
        Gesture::Pan { from, scroll } => {
            let v = me.viewport();
            let (dx, dy) = (
                f32::from(ev.position.x - from.x) as f64,
                f32::from(ev.position.y - from.y) as f64,
            );
            me.set_viewport(
                Viewport {
                    scroll_x: scroll.0 + dx / v.zoom,
                    scroll_y: scroll.1 + dy / v.zoom,
                    ..v
                },
                cx,
            );
            Some(Gesture::Pan { from, scroll })
        }
        Gesture::Select(s) => tools::selection::drag(me, *s, p, mods, window, cx),
        Gesture::Shape(s) => tools::shape::drag(me, s, p, mods, cx),
        Gesture::Linear(l) => tools::linear::drag(me, l, p, mods, cx),
        Gesture::FreeDraw(f) => tools::freedraw::drag(me, f, p, cx),
        Gesture::Lasso(l) => tools::lasso::drag(me, l, p, mods, cx),
        Gesture::Eraser(e) => tools::eraser::drag(me, e, p, mods, cx),
        Gesture::Text(t) => tools::text::drag(me, t, p, mods),
    };
    if me.gesture.is_none() {
        me.gesture = g;
    }
    let quiet = select && !finished;
    if quiet {
        me.chrome_quiet.set(true);
    }
    cx.notify();
    if quiet {
        end_quiet(cx);
    }
}

/// `BoardView::chrome_quiet` marks this event's notifications as leaving
/// the chrome as it was (`chrome::ChromeView`): cleared once they've been
/// through (effects run in order, so this runs after their observers).
fn end_quiet(cx: &mut Context<BoardView>) {
    let board = cx.weak_entity();
    cx.defer(move |cx| {
        let _ = board.update(cx, |me, _| me.chrome_quiet.set(false));
    });
}

fn up(me: &mut BoardView, ev: &MouseUpEvent, window: &mut Window, cx: &mut Context<BoardView>) {
    me.pointer = ev.position;
    finish(me, ev.position, Mods::of(&ev.modifiers), window, cx);
}

fn finish(
    me: &mut BoardView,
    pos: Point<Pixels>,
    mods: Mods,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    let Some(g) = me.gesture.take() else { return };
    let p = me.scene_point(pos);
    me.snap_lines.clear();
    me.app.frame_to_highlight = None;
    match g {
        Gesture::Pan { .. } => {}
        Gesture::Select(s) => tools::selection::up(me, *s, p, mods, window, cx),
        Gesture::Shape(s) => tools::shape::up(me, s, p, mods, window, cx),
        Gesture::Linear(l) => tools::linear::up(me, l, p, mods, cx),
        Gesture::FreeDraw(f) => tools::freedraw::up(me, f, p, cx),
        Gesture::Lasso(l) => tools::lasso::up(me, l, cx),
        Gesture::Eraser(e) => tools::eraser::up(me, e, p, cx),
        Gesture::Text(_) => me.commit(None, cx),
    }
    hover(me, pos, mods, window, cx);
    cx.notify();
}

/// `handleCanvasPointerMove` without a button: the line being drawn click
/// by click follows the pointer; the cursor follows what's under it.
pub fn hover(
    me: &mut BoardView,
    pos: Point<Pixels>,
    mods: Mods,
    _: &mut Window,
    cx: &mut Context<BoardView>,
) {
    if me
        .gesture
        .as_ref()
        .is_some_and(|g| !matches!(g, Gesture::Linear(l) if l.multi_click))
    {
        return;
    }
    let p = me.scene_point(pos);
    let cursor = match me.app.active_tool.ty {
        ToolType::Selection | ToolType::Lasso => tools::selection::hover(me, p, mods, cx),
        ToolType::Arrow | ToolType::Line => {
            tools::linear::hover(me, p, mods, cx);
            CursorStyle::Crosshair
        }
        ToolType::Text => tools::text::hover_cursor(me, p, mods),
        ToolType::Hand => CursorStyle::OpenHand,
        ToolType::Image => CursorStyle::Arrow,
        _ => CursorStyle::Crosshair,
    };
    if cursor != me.hover_cursor {
        me.hover_cursor = cursor;
        cx.notify();
    }
}

impl BoardView {
    /// `getElementHitThreshold`.
    pub(crate) fn hit_threshold(&self, e: &Element) -> f64 {
        (e.stroke_width / 2. + 0.1).max(0.85 * (DEFAULT_COLLISION_THRESHOLD / self.app.zoom))
    }

    /// The element's AABB (cached by version), padded for strokes, labels
    /// and frame names: what a hit can't be outside of.
    fn aabb(&self, e: &Element) -> [f64; 4] {
        let mut c = self.aabbs.borrow_mut();
        if let Some((v, n, b)) = c.get(&e.id)
            && *v == e.version
            && *n == e.version_nonce
        {
            return *b;
        }
        let mut b = get_element_bounds(e, &self.scene, false);
        if let Some(t) = e.bound_text_id().and_then(|id| self.scene.get_element(id)) {
            let tb = get_element_bounds(t, &self.scene, false);
            b = [
                b[0].min(tb[0]),
                b[1].min(tb[1]),
                b[2].max(tb[2]),
                b[3].max(tb[3]),
            ];
        }
        if e.is_frame_like() {
            b[1] -= 40.;
        }
        let pad = e.stroke_width + 4.;
        let b = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
        c.insert(e.id.clone(), (e.version, e.version_nonce, b));
        b
    }

    fn frame_name_bounds(&self, e: &Element) -> Option<FrameNameBounds> {
        if !e.is_frame_like() {
            return None;
        }
        // the screen-size label as last rendered (upstream measures its DOM name)
        let (_, b) = self.frame_labels.iter().find(|(id, _)| *id == e.id)?;
        let v = self.view();
        let [x, y] = v.to_scene(b.origin);
        let z = v.zoom as f64;
        Some(FrameNameBounds {
            x,
            y,
            width: f32::from(b.size.width) as f64 / z,
            height: f32::from(b.size.height) as f64 / z,
        })
    }

    /// `hitElement`: selected elements hit on their whole box.
    pub(crate) fn hit_element(&self, p: [f64; 2], e: &Element, consider_bbox: bool) -> bool {
        let t = self.hit_threshold(e);
        let b = self.aabb(e);
        if p[0] < b[0] - t || p[0] > b[2] + t || p[1] < b[1] - t || p[1] > b[3] + t {
            return false;
        }
        if consider_bbox
            && self.app.selected_element_ids.contains(&e.id)
            && has_bounding_box(&[e], self.linear_editing(), false)
            && hit_element_bounding_box(p, e, &self.scene, t)
        {
            return true;
        }
        if hit_element_bound_text(p, e, &self.scene) {
            return true;
        }
        let mut a = HitTestArgs::new(p, e, t, &self.scene);
        a.frame_name_bound = self.frame_name_bounds(e);
        hit_element_itself(&a)
    }

    /// The linear editor is editing points or dragging.
    pub(crate) fn linear_editing(&self) -> bool {
        self.linear
            .as_ref()
            .is_some_and(|l| l.is_editing || l.is_dragging)
    }

    /// `isClippedByFrameAt`.
    fn clipped_by_frame(&self, p: [f64; 2], e: &Element) -> bool {
        let Some(f) = e
            .frame_id
            .as_deref()
            .and_then(|f| self.scene.get_non_deleted_element(f))
        else {
            return false;
        };
        self.app.frame_rendering.enabled
            && self.app.frame_rendering.clip
            && super::bounds::is_frame_clippable(e, &self.scene)
            && !super::frame::is_cursor_in_frame(p[0], p[1], f, &self.scene)
    }

    /// `getElementsAtPosition`: bottom to top.
    pub(crate) fn elements_at(
        &self,
        p: [f64; 2],
        include_bound_text: bool,
        include_locked: bool,
    ) -> Vec<&Element> {
        let keep = |e: &&Element| {
            !e.is_deleted
                && (include_locked || !e.locked)
                && (include_bound_text || !e.is_bound_to_container())
                && self.hit_element(p, e, true)
                && !self.clipped_by_frame(p, e)
        };
        match self.hit_candidates(p) {
            Some(c) => {
                let els = self.scene.elements_including_deleted();
                c.into_iter()
                    .map(|i| &els[i as usize])
                    .filter(keep)
                    .collect()
            }
            None => self.scene.non_deleted_elements().filter(keep).collect(),
        }
    }

    /// The elements (positions in the scene, in order) whose AABB comes
    /// within reach of `p`: a superset of what `hit_element` can hit. None
    /// on the scene's first hit test since it last changed (built on the
    /// second, so a drag that hit-tests once a step doesn't rebuild it).
    fn hit_candidates(&self, p: [f64; 2]) -> Option<Vec<u32>> {
        let key = (
            self.scene.change_nonce(),
            self.scene.elements_including_deleted().len(),
        );
        let mut h = self.hits.borrow_mut();
        if h.key != Some(key) {
            *h = HitIndex {
                key: Some(key),
                ..Default::default()
            };
            return None;
        }
        if !h.built {
            let els = self.scene.elements_including_deleted();
            h.build(
                els.iter()
                    .enumerate()
                    .filter(|(_, e)| !e.is_deleted)
                    .map(|(i, e)| (i as u32, self.aabb(e), e.stroke_width)),
            );
        }
        let t = (h.stroke / 2. + 0.1).max(0.85 * (DEFAULT_COLLISION_THRESHOLD / self.app.zoom));
        h.query(p, t)
    }

    /// `getElementAtPosition`: the top hit, unless that's only its box while
    /// the one below is hit itself.
    pub(crate) fn element_at(
        &self,
        p: [f64; 2],
        include_bound_text: bool,
        include_locked: bool,
    ) -> Option<&Element> {
        let all = self.elements_at(p, include_bound_text, include_locked);
        self.pick_from(p, &all)
    }

    pub(crate) fn pick_from<'a>(&self, p: [f64; 2], all: &[&'a Element]) -> Option<&'a Element> {
        match all.len() {
            0 => None,
            1 => Some(all[0]),
            n => {
                let top = all[n - 1];
                let mut a = HitTestArgs::new(p, top, self.hit_threshold(top) / 2., &self.scene);
                a.frame_name_bound = self.frame_name_bounds(top);
                Some(if hit_element_itself(&a) {
                    top
                } else {
                    all[n - 2]
                })
            }
        }
    }

    /// `getTopLayerFrameAtSceneCoords`: the top frame containing the point.
    pub(crate) fn top_frame_at(
        &self,
        p: [f64; 2],
        exclude: &std::collections::BTreeSet<String>,
    ) -> Option<String> {
        self.scene
            .non_deleted_frame_likes()
            .filter(|f| {
                !exclude.contains(&f.id)
                    && super::frame::is_cursor_in_frame(p[0], p[1], f, &self.scene)
            })
            .last()
            .map(|f| f.id.clone())
    }

    /// `getEffectiveGridSize`.
    pub(crate) fn grid(&self, mods: Mods) -> Option<f64> {
        (self.app.grid_mode_enabled && !mods.ctrl_or_cmd()).then_some(self.app.grid_size)
    }

    pub(crate) fn snap_ctx(&self, dragging: bool) -> super::snapping::SnapCtx<'_> {
        let c = self.canvas();
        super::snapping::SnapCtx {
            app: &self.app,
            width: c.width,
            height: c.height,
            dragging_selection: dragging,
        }
    }
}

/// The scene's element AABBs (`BoardView::aabb`) in a grid of square cells,
/// for `hit_candidates`; elements over more than 64 cells go in `big`.
#[derive(Default)]
pub(crate) struct HitIndex {
    /// The scene it was made for (change nonce, array length).
    key: Option<(i64, usize)>,
    built: bool,
    grid: FxHashMap<(i32, i32), Vec<u32>>,
    big: Vec<u32>,
    /// The widest stroke (the hit threshold's reach).
    stroke: f64,
}

impl HitIndex {
    const CELL: f64 = 256.;
    fn cell(p: [f64; 2]) -> [i32; 2] {
        [
            (p[0] / Self::CELL).floor().clamp(-1e9, 1e9) as i32,
            (p[1] / Self::CELL).floor().clamp(-1e9, 1e9) as i32,
        ]
    }
    fn span(a: [i32; 2], b: [i32; 2]) -> i64 {
        (b[0] as i64 - a[0] as i64 + 1) * (b[1] as i64 - a[1] as i64 + 1)
    }

    /// From (position, AABB, stroke width) of each element.
    fn build(&mut self, items: impl Iterator<Item = (u32, [f64; 4], f64)>) {
        for (i, b, stroke) in items {
            self.stroke = self.stroke.max(stroke);
            let (lo, hi) = (Self::cell([b[0], b[1]]), Self::cell([b[2], b[3]]));
            if !b.iter().all(|v| v.is_finite()) || Self::span(lo, hi) > 64 {
                self.big.push(i);
                continue;
            }
            for x in lo[0]..=hi[0] {
                for y in lo[1]..=hi[1] {
                    self.grid.entry((x, y)).or_default().push(i);
                }
            }
        }
        self.built = true;
    }

    /// The elements whose AABB comes within `t` of `p`, and maybe others;
    /// None when that would be many cells (zoomed far out).
    fn query(&self, p: [f64; 2], t: f64) -> Option<Vec<u32>> {
        let (lo, hi) = (
            Self::cell([p[0] - t, p[1] - t]),
            Self::cell([p[0] + t, p[1] + t]),
        );
        if Self::span(lo, hi) > 64 {
            return None;
        }
        let mut c = self.big.clone();
        for x in lo[0]..=hi[0] {
            for y in lo[1]..=hi[1] {
                if let Some(v) = self.grid.get(&(x, y)) {
                    c.extend_from_slice(v);
                }
            }
        }
        c.sort_unstable();
        c.dedup();
        Some(c)
    }
}

#[cfg(test)]
mod tests {
    use super::HitIndex;

    /// Every box within reach of the point is a candidate, in order.
    #[test]
    fn hit_index_keeps_every_reachable_box() {
        let mut seed = 7u64;
        let mut r = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % 100_000) as f64 / 100_000.
        };
        for _ in 0..20 {
            let boxes: Vec<[f64; 4]> = (0..400)
                .map(|_| {
                    let (x, y) = (r() * 6000. - 3000., r() * 6000. - 3000.);
                    let (w, h) = if r() < 0.05 {
                        (r() * 5000., r() * 5000.)
                    } else {
                        (r() * 300., r() * 300.)
                    };
                    [x, y, x + w, y + h]
                })
                .collect();
            let mut h = HitIndex::default();
            h.build(boxes.iter().enumerate().map(|(i, b)| (i as u32, *b, 2.)));
            for _ in 0..200 {
                let (p, t) = ([r() * 7000. - 3500., r() * 7000. - 3500.], r() * 120.);
                let want: Vec<u32> = boxes
                    .iter()
                    .enumerate()
                    .filter(|(_, b)| {
                        p[0] >= b[0] - t && p[0] <= b[2] + t && p[1] >= b[1] - t && p[1] <= b[3] + t
                    })
                    .map(|(i, _)| i as u32)
                    .collect();
                let got = h.query(p, t).expect("a few cells");
                assert!(got.windows(2).all(|w| w[0] < w[1]));
                assert!(
                    want.iter().all(|i| got.binary_search(i).is_ok()),
                    "{p:?} {t}"
                );
            }
        }
    }
}
