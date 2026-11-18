// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Editing lines and arrows point by point. Port of Excalidraw @ 3a317b5:
//! the editing half of `element/src/linearElementEditor.ts` (the geometry
//! half is in bounds.rs, `movePoints` in binding.rs), `element/src/arrows/
//! focus.ts` and `helpers.ts` (dragging a binding's focus point), and the
//! element logic of `excalidraw/actions/actionFinalize.tsx` and
//! `actionLinearEditor.tsx`.
//!
//! The editor is plain state (`LinearElementEditor`); the app's tool state
//! machine calls its handlers with the pointer in scene coordinates, the
//! modifiers and a `LinearCtx` (what upstream reads from `appState` and
//! `app`), and stores the editor they return. Differences from upstream:
//! - upstream compares points by identity (`lastPoint === lastUncommitted
//!   Point`, the finalize check against `lastCommittedPoint`); here by value;
//! - `store.scheduleCapture()` is the caller's: `PointerDownResult::capture`;
//! - the label grab test (`app.arrowText.isBoundTextGrabbable`) is the app's
//!   and comes in as a flag;

use super::binding::*;
use super::bounds::*;
use super::collision::{HitTestArgs, get_hovered_element_for_binding, hit_element_itself};
use super::consts::DRAGGING_THRESHOLD;
use super::deconstruct::deconstruct_linear_or_freedraw_element;
use super::heading::{heading_is_horizontal, vector_to_heading};
use super::math::*;
use super::mutate::new_element_with;
use super::scene::Scene;
use super::shape::toggle_line_polygon_state;
use super::size_helpers::get_locked_linear_cursor_align_size;
use super::types::*;
use super::utils::{ElementsMap, get_grid_point, is_invisibly_small_element, is_path_a_loop};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/// `initialState.segmentMidpoint`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SegmentMidpoint {
    pub value: Option<Point>,
    pub index: Option<usize>,
    pub added: bool,
}

/// `LinearElementEditor["initialState"]`: set on pointer down, read while
/// dragging (also across the clicks of multi-point creation).
#[derive(Clone, Debug, PartialEq)]
pub struct InitialState {
    pub prev_selected_points_indices: Option<Vec<usize>>,
    /// -1: none.
    pub last_clicked_point: isize,
    pub origin: Option<Point>,
    pub segment_midpoint: SegmentMidpoint,
    pub arrow_start_is_inside: bool,
    pub alt_focus_point: Option<Point>,
    pub arrow_other_endpoint_initial_binding: Option<FixedPointBinding>,
}

impl Default for InitialState {
    fn default() -> Self {
        InitialState {
            prev_selected_points_indices: None,
            last_clicked_point: -1,
            origin: None,
            segment_midpoint: SegmentMidpoint::default(),
            arrow_start_is_inside: false,
            alt_focus_point: None,
            arrow_other_endpoint_initial_binding: None,
        }
    }
}

impl InitialState {
    /// The part binding reads (`BindingCtx::drag`).
    pub fn drag_state(&self) -> LinearDragState {
        LinearDragState {
            origin: self.origin,
            arrow_start_is_inside: self.arrow_start_is_inside,
            alt_focus_point: self.alt_focus_point,
            arrow_other_endpoint_initial_binding: self.arrow_other_endpoint_initial_binding.clone(),
        }
    }
}

/// `LinearElementEditor` (`appState.selectedLinearElement`).
#[derive(Clone, Debug, PartialEq)]
pub struct LinearElementEditor {
    pub element_id: String,
    pub selected_points_indices: Option<Vec<usize>>,
    pub initial_state: InitialState,
    /// A point is being dragged.
    pub is_dragging: bool,
    pub last_uncommitted_point: Option<Point>,
    pub last_committed_point: Option<Point>,
    pub pointer_offset: Point,
    /// -1: none.
    pub hover_point_index: isize,
    pub segment_mid_point_hovered_coords: Option<Point>,
    pub hovered_focus_point_binding: Option<StartOrEnd>,
    pub dragged_focus_point_binding: Option<StartOrEnd>,
    pub elbowed: bool,
    pub custom_line_angle: Option<f64>,
    /// The point editor is open (double click / toggle), not just selected.
    pub is_editing: bool,
}

/// `appState.suggestedBinding`: the element an endpoint would bind to, and
/// the outline midpoint it would snap to.
#[derive(Clone, Debug, PartialEq)]
pub struct SuggestedBinding {
    pub element: String,
    pub mid_point: Option<Point>,
}

/// The pointer event's modifiers.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Modifiers {
    pub shift: bool,
    pub alt: bool,
    pub ctrl_or_cmd: bool,
}

impl Modifiers {
    /// `shouldRotateWithDiscreteAngle`.
    pub fn angle_locked(&self) -> bool {
        self.shift
    }
}

/// What the editor reads from the app.
#[derive(Clone, Copy)]
pub struct LinearCtx<'a> {
    pub zoom: f64,
    pub grid_mode_enabled: bool,
    pub grid_size: f64,
    pub is_binding_enabled: bool,
    pub is_midpoint_snapping_enabled: bool,
    pub bind_mode: BindMode,
    /// `appState.newElement` is set: the element is being created.
    pub new_element: bool,
    pub complex_bindings: bool,
    /// `appState.suggestedBinding` as it is.
    pub suggested_binding: Option<&'a SuggestedBinding>,
    pub hooks: &'a dyn BindingHooks,
}

impl Default for LinearCtx<'static> {
    fn default() -> Self {
        LinearCtx {
            zoom: 1.,
            grid_mode_enabled: false,
            grid_size: 20.,
            is_binding_enabled: true,
            is_midpoint_snapping_enabled: true,
            bind_mode: BindMode::Orbit,
            new_element: false,
            complex_bindings: false,
            suggested_binding: None,
            hooks: &NO_BINDING_HOOKS,
        }
    }
}

impl<'a> LinearCtx<'a> {
    pub fn from_app(a: &super::app_state::AppState, new_element: bool) -> LinearCtx<'static> {
        LinearCtx {
            zoom: a.zoom,
            grid_mode_enabled: a.grid_mode_enabled,
            grid_size: a.grid_size,
            is_binding_enabled: a.is_binding_enabled,
            is_midpoint_snapping_enabled: a.is_midpoint_snapping_enabled,
            bind_mode: a.bind_mode,
            new_element,
            ..Default::default()
        }
    }
    /// `app.getEffectiveGridSize()`.
    pub fn effective_grid_size(&self) -> Option<f64> {
        self.grid_mode_enabled.then_some(self.grid_size)
    }
    /// The grid unless Ctrl/Cmd is held.
    fn grid(&self, m: &Modifiers) -> Option<f64> {
        if m.ctrl_or_cmd {
            None
        } else {
            self.effective_grid_size()
        }
    }
    pub fn binding(&self, drag: Option<&'a LinearDragState>) -> BindingCtx<'a> {
        BindingCtx {
            zoom: self.zoom,
            is_binding_enabled: self.is_binding_enabled,
            is_midpoint_snapping_enabled: self.is_midpoint_snapping_enabled,
            grid_mode_enabled: self.grid_mode_enabled,
            grid_size: self.grid_size,
            bind_mode: self.bind_mode,
            complex_bindings: self.complex_bindings,
            drag,
            hooks: self.hooks,
        }
    }
    fn arrow_start_is_inside(&self) -> bool {
        self.new_element && matches!(self.bind_mode, BindMode::Inside | BindMode::Skip)
    }
}

/// What `handlePointerDown` returns.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PointerDownResult {
    pub did_add_point: bool,
    /// The element's id, when a point, midpoint or the label was hit.
    pub hit_element: Option<String>,
    /// The pointer went down on the arrow's label, grabbing it for a drag.
    pub hit_bound_text: bool,
    pub linear_element_editor: Option<LinearElementEditor>,
    /// Upstream's `store.scheduleCapture()`.
    pub capture: bool,
}

/// What `handle_drag` did.
#[derive(Clone, Debug, PartialEq)]
pub enum DragOutcome {
    /// A focus point moved; the new editor.
    FocusPoint(LinearElementEditor),
    /// An elbow arrow's segment moved (fixed).
    Segment(LinearElementEditor),
    /// A midpoint became a point; the next move drags it.
    MidpointAdded(LinearElementEditor),
    /// Points moved, with the binding the dragged end would make.
    Dragged(LinearElementEditor, Option<SuggestedBinding>),
    /// The editor took the move but nothing changed (below the midpoint
    /// threshold, or nothing to drag).
    Ignored,
    /// Not the editor's: the app's selection drag goes on.
    NotHandled,
}

/// What `handle_double_click` did.
#[derive(Clone, Debug, PartialEq)]
pub enum DoubleClickOutcome {
    None,
    ToggleEditor,
    SegmentReleased(LinearElementEditor),
}

fn pts(e: &Element) -> &[Point] {
    e.points().unwrap_or(&[])
}
fn live<'a>(map: &'a dyn ElementsMap, id: &str) -> Option<&'a Element> {
    map.get_element(id).filter(|e| !e.is_deleted)
}
fn binding_updates(
    start: Option<Option<FixedPointBinding>>,
    end: Option<Option<FixedPointBinding>>,
) -> BindingUpdates {
    BindingUpdates {
        start_binding: start,
        end_binding: end,
    }
}

/// `getNormalizedPoints`: points moved so the first is at [0, 0], and the
/// offset.
fn get_normalized_points(points: &[Point]) -> (Vec<Point>, f64, f64) {
    let [ox, oy] = points[0];
    (
        points.iter().map(|p| [p[0] - ox, p[1] - oy]).collect(),
        ox,
        oy,
    )
}

/// `LinearElementEditor.getNormalizeElementPointsAndCoords`: (points, x, y).
pub fn get_normalize_element_points_and_coords(e: &Element) -> (Vec<Point>, f64, f64) {
    let (p, ox, oy) = get_normalized_points(pts(e));
    (p, e.x + ox, e.y + oy)
}

/// `normalizeSelectedPoints`: unique, sorted, without -1; None if empty.
fn normalize_selected_points(points: impl IntoIterator<Item = isize>) -> Option<Vec<usize>> {
    let mut v: Vec<usize> = points
        .into_iter()
        .filter(|&p| p >= 0)
        .map(|p| p as usize)
        .collect();
    v.sort_unstable();
    v.dedup();
    (!v.is_empty()).then_some(v)
}

fn determine_custom_linear_angle(pivot: Point, dragged: Point) -> f64 {
    (dragged[1] - pivot[1]).atan2(dragged[0] - pivot[0])
}

impl LinearElementEditor {
    /// `new LinearElementEditor(element, elementsMap, isEditing)`; a
    /// non-normalized element (first point off [0, 0]) is normalized first.
    pub fn new(id: &str, store: &mut dyn BindingStore, is_editing: bool) -> Option<Self> {
        let e = live(store, id)?.clone();
        if !points_equal(*pts(&e).first()?, [0., 0.], PRECISION) {
            let (p, x, y) = get_normalize_element_points_and_coords(&e);
            store.update(id, &mut |e| {
                if let Some(q) = e.points_mut() {
                    q.clone_from(&p);
                }
                (e.x, e.y) = (x, y);
            });
        }
        Some(LinearElementEditor {
            element_id: id.into(),
            selected_points_indices: None,
            initial_state: InitialState::default(),
            is_dragging: false,
            last_uncommitted_point: None,
            last_committed_point: None,
            pointer_offset: [0., 0.],
            hover_point_index: -1,
            segment_mid_point_hovered_coords: None,
            hovered_focus_point_binding: None,
            dragged_focus_point_binding: None,
            elbowed: e.is_elbow_arrow(),
            custom_line_angle: None,
            is_editing,
        })
    }

    /// `LinearElementEditor.getElement`.
    pub fn get_element<'a>(&self, map: &'a dyn ElementsMap) -> Option<&'a Element> {
        map.get_element(&self.element_id)
    }

    /// `handleBoxSelection`: the points inside the selection box (scene
    /// bounds), plus the selected ones with Shift. None when not editing.
    pub fn handle_box_selection(
        &self,
        selection: Bounds,
        shift: bool,
        map: &dyn ElementsMap,
    ) -> Option<Self> {
        if !self.is_editing {
            return None;
        }
        let e = self.get_element(map)?;
        let [x1, y1, x2, y2] = selection;
        let n = pts(e).len();
        let next: Vec<usize> = get_points_global_coordinates(e, map)
            .iter()
            .enumerate()
            .filter(|(i, p)| {
                (p[0] >= x1 && p[0] <= x2 && p[1] >= y1 && p[1] <= y2)
                    || (shift
                        && self
                            .selected_points_indices
                            .as_ref()
                            .is_some_and(|s| s.contains(i)))
            })
            .map(|(i, _)| i)
            .filter(|&i| !e.is_elbow_arrow() || i == 0 || i == n - 1)
            .collect();
        Some(LinearElementEditor {
            selected_points_indices: (!next.is_empty()).then_some(next),
            ..self.clone()
        })
    }

    /// `handlePointerMove`: drags the last point of an element being created
    /// (point by point). None: the editor state is unchanged.
    pub fn handle_pointer_move(
        &self,
        scene: &mut Scene,
        ctx: &LinearCtx,
        [px, py]: Point,
        mods: &Modifiers,
    ) -> Option<(Self, Option<SuggestedBinding>)> {
        let element = live(scene, &self.element_id)?.clone();
        let points = pts(&element);
        if points.len() < 2 {
            return None;
        }
        let idx = points.len() - 1;
        let (point, pivot) = (points[idx], points[idx - 1]);
        let custom_line_angle = self
            .custom_line_angle
            .unwrap_or_else(|| determine_custom_linear_angle(pivot, points[idx]));
        let angle_locked = mods.angle_locked();
        let [dx, dy] = if angle_locked {
            let [w, h] = get_shift_locked_delta(
                &element,
                scene,
                pivot,
                [px, py],
                ctx.grid(mods),
                Some(custom_line_angle),
            );
            [w + pivot[0] - point[0], h + pivot[1] - point[1]]
        } else {
            let n = create_point_at(
                &element,
                scene,
                px - self.pointer_offset[0],
                py - self.pointer_offset[1],
                ctx.grid(mods),
            );
            [n[0] - point[0], n[1] - point[1]]
        };
        let (positions, updates, hit) = point_dragging_updates(
            &[idx],
            dx,
            dy,
            [px, py],
            scene,
            &element,
            ctx,
            angle_locked,
            mods.alt,
            self,
        );
        let mp = MovePointsOpts {
            is_binding_enabled: Some(ctx.is_binding_enabled),
            is_midpoint_snapping_enabled: Some(
                ctx.is_midpoint_snapping_enabled && !angle_locked && !ctx.grid_mode_enabled,
            ),
            ..Default::default()
        };
        let other = binding_updates(
            updates.as_ref().and_then(|u| u.start_binding.clone()),
            updates.as_ref().and_then(|u| u.end_binding.clone()),
        );
        move_points(
            &self.element_id,
            scene,
            &positions,
            Some(&other),
            &mp,
            ctx.hooks,
        );
        let mut suggested = None;
        if element.is_binding_element(false) && ctx.is_binding_enabled {
            suggested = updates.as_ref().and_then(|u| u.suggested_binding.clone());
        }
        // move the arrow over the bindable in z-order
        if element.is_binding_element(true)
            && let Some(h) = &hit
        {
            move_arrow_above_bindable(&self.element_id, h, scene);
        }
        // perf: no state update if nothing changed
        if self.custom_line_angle == Some(custom_line_angle)
            && self.initial_state.alt_focus_point.is_some()
            && suggested
                .as_ref()
                .is_none_or(|s| ctx.suggested_binding == Some(s))
        {
            return None;
        }
        let element = scene.get_element(&self.element_id)?.clone();
        let start_el = element
            .linear()
            .and_then(|l| l.start_binding.as_ref())
            .filter(|_| element.is_binding_element(true))
            .and_then(|b| scene.get_element(&b.element_id));
        let alt_focus_point = match start_el {
            Some(s)
                if self.initial_state.alt_focus_point.is_none()
                    && updates
                        .as_ref()
                        .and_then(|u| u.suggested_binding.as_ref())
                        .is_none_or(|b| b.element != s.id) =>
            {
                project_fixed_point_onto_diagonal(
                    &element,
                    [element.x, element.y],
                    s,
                    StartOrEnd::Start,
                    scene,
                    ctx.zoom,
                    ctx.is_midpoint_snapping_enabled && !angle_locked && !ctx.grid_mode_enabled,
                )
            }
            _ => self.initial_state.alt_focus_point,
        };
        Some((
            LinearElementEditor {
                custom_line_angle: Some(custom_line_angle),
                initial_state: InitialState {
                    alt_focus_point,
                    ..self.initial_state.clone()
                },
                ..self.clone()
            },
            suggested,
        ))
    }

    /// `handlePointDragging`: drags the selected points (the last clicked
    /// one follows the pointer, the rest by the same delta).
    pub fn handle_point_dragging(
        &self,
        scene: &mut Scene,
        ctx: &LinearCtx,
        [px, py]: Point,
        mods: &Modifiers,
    ) -> Option<(Self, Option<SuggestedBinding>)> {
        let element = live(scene, &self.element_id)?.clone();
        let points = pts(&element).to_vec();
        if points.len() < 2 {
            return None;
        }
        let mut selected = self.selected_points_indices.clone()?;
        let mut last_clicked = self.initial_state.last_clicked_point;
        let last = points.len() - 1;
        if self.elbowed
            && let Some(i) = selected.iter().position(|&p| p > 0 && p != last)
        {
            selected[i] = last;
            last_clicked = last as isize;
        }
        if last_clicked < 0
            || !selected.contains(&(last_clicked as usize))
            || last_clicked as usize > last
        {
            // fall back to the actual last point
            last_clicked = last as isize;
        }
        let lc = last_clicked as usize;
        let dragging_point = points[lc];
        let pivot = points[if lc == 0 { 1 } else { lc - 1 }];
        let single = selected.len() == 1;
        let custom_line_angle = self
            .custom_line_angle
            .unwrap_or_else(|| determine_custom_linear_angle(pivot, points[lc]));
        let (start_sel, end_sel) = (selected.contains(&0), selected.contains(&last));
        let angle_locked = mods.angle_locked() && single;
        let [dx, dy] = if angle_locked {
            let [w, h] = get_shift_locked_delta(
                &element,
                scene,
                pivot,
                [px, py],
                ctx.grid(mods),
                Some(custom_line_angle),
            );
            [
                w + pivot[0] - dragging_point[0],
                h + pivot[1] - dragging_point[1],
            ]
        } else {
            let n = create_point_at(
                &element,
                scene,
                px - self.pointer_offset[0],
                py - self.pointer_offset[1],
                ctx.grid(mods),
            );
            [n[0] - dragging_point[0], n[1] - dragging_point[1]]
        };
        let (positions, updates, hit) = point_dragging_updates(
            &selected,
            dx,
            dy,
            [px, py],
            scene,
            &element,
            ctx,
            angle_locked,
            mods.alt,
            self,
        );
        let mp = MovePointsOpts {
            is_binding_enabled: Some(ctx.is_binding_enabled),
            is_midpoint_snapping_enabled: Some(
                ctx.is_midpoint_snapping_enabled && !angle_locked && !ctx.grid_mode_enabled,
            ),
            ..Default::default()
        };
        let other = binding_updates(
            updates.as_ref().and_then(|u| u.start_binding.clone()),
            updates.as_ref().and_then(|u| u.end_binding.clone()),
        );
        move_points(
            &self.element_id,
            scene,
            &positions,
            Some(&other),
            &mp,
            ctx.hooks,
        );
        let mut suggested = None;
        if element.is_binding_element(false) && ctx.is_binding_enabled && (start_sel || end_sel) {
            suggested = updates.as_ref().and_then(|u| u.suggested_binding.clone());
        }
        let element = scene.get_element(&self.element_id)?.clone();
        // move the arrow over the bindable in z-order
        if element.is_binding_element(true)
            && start_sel != end_sel
            && let Some(h) = &hit
        {
            move_arrow_above_bindable(&self.element_id, h, scene);
        }
        // the label follows
        if get_bound_text_element(&element, scene).is_some() {
            ctx.hooks.handle_bind_text_resize(&self.element_id, scene);
        }
        let element = scene.get_element(&self.element_id)?.clone();
        let n = pts(&element).len();
        // elbow arrows add and remove points as they route
        let new_selected = if self.elbowed {
            vec![if end_sel { n - 1 } else { 0 }]
        } else {
            selected.clone()
        };
        let new_last_clicked = if self.elbowed {
            new_selected[0] as isize
        } else {
            last_clicked
        };
        let mid_hovered = (!start_sel && !end_sel)
            .then(|| get_point_global_coordinates(&element, dragging_point, scene));
        let bound = |s: StartOrEnd| {
            element
                .is_binding_element(true)
                .then(|| binding_of(&element, s).and_then(|b| scene.get_element(&b.element_id)))
                .flatten()
        };
        let suggested_id = updates
            .as_ref()
            .and_then(|u| u.suggested_binding.as_ref())
            .map(|b| b.element.as_str());
        let alt_el = match (bound(StartOrEnd::Start), bound(StartOrEnd::End)) {
            (Some(s), _) if end_sel && suggested_id != Some(s.id.as_str()) => Some(s),
            (_, Some(e)) if start_sel && suggested_id != Some(e.id.as_str()) => Some(e),
            _ => None,
        };
        let alt_focus_point = match alt_el {
            Some(b)
                if self.initial_state.alt_focus_point.is_none()
                    && element.is_binding_element(true) =>
            {
                project_fixed_point_onto_diagonal(
                    &element,
                    [element.x, element.y],
                    b,
                    StartOrEnd::Start,
                    scene,
                    ctx.zoom,
                    ctx.is_midpoint_snapping_enabled && !angle_locked && !ctx.grid_mode_enabled,
                )
            }
            _ => self.initial_state.alt_focus_point,
        };
        Some((
            LinearElementEditor {
                selected_points_indices: Some(new_selected),
                initial_state: InitialState {
                    last_clicked_point: new_last_clicked,
                    alt_focus_point,
                    ..self.initial_state.clone()
                },
                segment_mid_point_hovered_coords: mid_hovered,
                hover_point_index: new_last_clicked,
                is_dragging: true,
                custom_line_angle: Some(custom_line_angle),
                ..self.clone()
            },
            suggested,
        ))
    }

    /// `handlePointerUp`: a dragged end left on the other end closes the loop
    /// (lines become polygons); the selection settles.
    pub fn handle_pointer_up(
        &self,
        shift: bool,
        zoom: f64,
        scene: &mut Scene,
        hooks: &dyn BindingHooks,
    ) -> Self {
        if live(scene, &self.element_id).is_none() {
            return self.clone();
        }
        if self.is_dragging
            && let Some(selected) = &self.selected_points_indices
        {
            for &sp in selected {
                let e = scene.get_element(&self.element_id).unwrap().clone();
                let p = pts(&e);
                if (sp == 0 || sp + 1 == p.len()) && is_path_a_loop(p, zoom) {
                    if e.is_line()
                        && let Some((poly, np)) = toggle_line_polygon_state(&e, true)
                    {
                        scene.mutate_element(&self.element_id, false, |e| {
                            if let Kind::Line { polygon, linear } = &mut e.kind {
                                *polygon = poly;
                                linear.points = np.clone();
                            }
                        });
                    }
                    let e = scene.get_element(&self.element_id).unwrap().clone();
                    let p = pts(&e);
                    let to = if sp == 0 { p[p.len() - 1] } else { p[0] };
                    move_points(
                        &self.element_id,
                        scene,
                        &PointsPositionUpdates::from([(sp, PointUpdate::at(to))]),
                        None,
                        &MovePointsOpts::default(),
                        hooks,
                    );
                }
            }
        }
        let st = &self.initial_state;
        let lc = st.last_clicked_point;
        let has = |v: &Option<Vec<usize>>| {
            lc >= 0 && v.as_ref().is_some_and(|v| v.contains(&(lc as usize)))
        };
        // clicking without dragging, and not holding shift, keeps only the
        // point clicked; holding shift toggles it
        let selected = if self.is_dragging || shift {
            if !self.is_dragging && shift && has(&st.prev_selected_points_indices) {
                self.selected_points_indices
                    .as_ref()
                    .map(|s| s.iter().copied().filter(|&p| p as isize != lc).collect())
            } else {
                self.selected_points_indices.clone()
            }
        } else if has(&self.selected_points_indices) {
            Some(vec![lc as usize])
        } else {
            self.selected_points_indices.clone()
        };
        LinearElementEditor {
            segment_mid_point_hovered_coords: None,
            hover_point_index: -1,
            selected_points_indices: selected,
            is_dragging: false,
            custom_line_angle: None,
            initial_state: InitialState {
                origin: None,
                arrow_start_is_inside: false,
                arrow_other_endpoint_initial_binding: None,
                ..st.clone()
            },
            ..self.clone()
        }
    }

    /// `getSegmentMidpointHitCoords`: the segment midpoint knob under the
    /// pointer.
    pub fn get_segment_midpoint_hit_coords(
        &self,
        pointer: Point,
        zoom: f64,
        is_editing: bool,
        map: &dyn ElementsMap,
    ) -> Option<Point> {
        let e = self.get_element(map)?;
        if !e.is_elbow_arrow() && get_point_index_under_cursor(e, map, zoom, pointer) >= 0 {
            return None;
        }
        if pts(e).len() >= 3 && !is_editing && !e.is_elbow_arrow() {
            return None;
        }
        let threshold = (POINT_HANDLE_SIZE + 1.) / zoom;
        if let Some(h) = self.segment_mid_point_hovered_coords
            && point_distance(h, pointer) <= threshold
        {
            return Some(h);
        }
        get_editor_mid_points(e, map, zoom, is_editing)
            .into_iter()
            .flatten()
            .find(|&m| point_distance(m, pointer) <= threshold)
    }

    /// `getSegmentMidPointIndex`: 1-based index of the segment with that
    /// midpoint, -1 if none.
    pub fn get_segment_mid_point_index(
        &self,
        zoom: f64,
        is_editing: bool,
        mid: Point,
        map: &dyn ElementsMap,
    ) -> isize {
        let Some(e) = self.get_element(map) else {
            return -1;
        };
        get_editor_mid_points(e, map, zoom, is_editing)
            .iter()
            .position(|m| m.is_some_and(|m| points_equal(m, mid, PRECISION)))
            .map_or(-1, |i| i as isize + 1)
    }

    /// `handlePointerDown`: what the pointer went down on (a point, a
    /// midpoint, the label), the new selection, and with Alt while editing,
    /// a point added at the pointer.
    pub fn handle_pointer_down(
        &self,
        scene: &mut Scene,
        ctx: &LinearCtx,
        pointer: Point,
        mods: &Modifiers,
        label_grabbable: bool,
    ) -> PointerDownResult {
        let mut ret = PointerDownResult::default();
        let Some(element) = live(scene, &self.element_id).cloned() else {
            return ret;
        };
        let segment_midpoint =
            self.get_segment_midpoint_hit_coords(pointer, ctx.zoom, self.is_editing, scene);
        let mut segment_midpoint_index = None;
        if let Some(m) = segment_midpoint {
            let i = self.get_segment_mid_point_index(ctx.zoom, self.is_editing, m, scene);
            segment_midpoint_index = (i >= 0).then_some(i as usize);
        } else if mods.alt && self.is_editing {
            if self.last_uncommitted_point.is_none() {
                let p = create_point_at(&element, scene, pointer[0], pointer[1], ctx.grid(mods));
                scene.mutate_element(&self.element_id, true, |e| {
                    if let Some(q) = e.points_mut() {
                        q.push(p)
                    }
                });
                ret.did_add_point = true;
            }
            ret.capture = true;
            let e = scene.get_element(&self.element_id).unwrap();
            ret.linear_element_editor = Some(LinearElementEditor {
                initial_state: InitialState {
                    prev_selected_points_indices: self.selected_points_indices.clone(),
                    last_clicked_point: -1,
                    origin: Some(pointer),
                    segment_midpoint: SegmentMidpoint {
                        value: segment_midpoint,
                        index: segment_midpoint_index,
                        added: false,
                    },
                    arrow_start_is_inside: ctx.arrow_start_is_inside(),
                    alt_focus_point: None,
                    arrow_other_endpoint_initial_binding: element
                        .linear()
                        .and_then(|l| l.start_binding.clone()),
                },
                selected_points_indices: Some(vec![pts(e).len() - 1]),
                last_uncommitted_point: None,
                ..self.clone()
            });
            ret.did_add_point = true;
            return ret;
        }
        let under = get_point_index_under_cursor(&element, scene, ctx.zoom, pointer);
        let is_handle = is_point_handle(&element, under);
        let bound_text = get_bound_text_element(&element, scene).cloned();
        // the midpoint knob keeps precedence over the label on top of it
        let grab = match &bound_text {
            Some(t)
                if !is_handle
                    && segment_midpoint.is_none()
                    && element.is_arrow()
                    && label_grabbable =>
            {
                let [tx, ty] = get_bound_text_element_position(&element, t, scene);
                Some([
                    pointer[0] - (tx + t.width / 2.),
                    pointer[1] - (ty + t.height / 2.),
                ])
            }
            _ => None,
        };
        // a label grab doesn't double as a point click
        let clicked = if grab.is_some() { -1 } else { under };
        ret.hit_bound_text = grab.is_some();
        if clicked >= 0 || segment_midpoint.is_some() || grab.is_some() {
            ret.hit_element = Some(element.id.clone());
        }
        let target = (clicked >= 0).then(|| {
            get_point_global_coordinates(&element, pts(&element)[clicked as usize], scene)
        });
        let next_selected = if clicked > -1 || mods.shift {
            if mods.shift
                || self
                    .selected_points_indices
                    .as_ref()
                    .is_some_and(|s| clicked >= 0 && s.contains(&(clicked as usize)))
            {
                normalize_selected_points(
                    self.selected_points_indices
                        .iter()
                        .flatten()
                        .map(|&i| i as isize)
                        .chain([clicked]),
                )
            } else {
                Some(vec![clicked as usize])
            }
        } else {
            None
        };
        let other_initial = if next_selected.as_ref().is_some_and(|s| s.contains(&0)) {
            binding_of(&element, StartOrEnd::End)
        } else {
            binding_of(&element, StartOrEnd::Start)
        };
        ret.linear_element_editor = Some(LinearElementEditor {
            initial_state: InitialState {
                prev_selected_points_indices: self.selected_points_indices.clone(),
                last_clicked_point: clicked,
                origin: Some(pointer),
                segment_midpoint: SegmentMidpoint {
                    value: segment_midpoint,
                    index: segment_midpoint_index,
                    added: false,
                },
                arrow_start_is_inside: ctx.arrow_start_is_inside(),
                alt_focus_point: None,
                arrow_other_endpoint_initial_binding: other_initial.cloned(),
            },
            selected_points_indices: next_selected,
            pointer_offset: match target {
                Some(t) => [pointer[0] - t[0], pointer[1] - t[1]],
                None => grab.unwrap_or([0., 0.]),
            },
            ..self.clone()
        });
        ret
    }

    /// `handlePointerMoveInEditMode`: with Alt held while editing, a pending
    /// point follows the pointer; released, it goes away. None when not
    /// editing.
    pub fn handle_pointer_move_in_edit_mode(
        &self,
        scene: &mut Scene,
        ctx: &LinearCtx,
        [px, py]: Point,
        mods: &Modifiers,
    ) -> Option<Self> {
        if !self.is_editing {
            return None;
        }
        let Some(element) = live(scene, &self.element_id).cloned() else {
            return Some(self.clone());
        };
        let points = pts(&element);
        let last_point = *points.last()?;
        let is_uncommitted = self.last_uncommitted_point == Some(last_point);
        if !mods.alt {
            if is_uncommitted {
                delete_points(
                    scene,
                    &self.element_id,
                    &[points.len() - 1],
                    Some(self),
                    ctx.hooks,
                );
            }
            return Some(if self.last_uncommitted_point.is_some() {
                LinearElementEditor {
                    last_uncommitted_point: None,
                    ..self.clone()
                }
            } else {
                self.clone()
            });
        }
        let new_point = if mods.angle_locked() && points.len() >= 2 {
            let anchor = points[points.len() - 2];
            let [w, h] =
                get_shift_locked_delta(&element, scene, anchor, [px, py], ctx.grid(mods), None);
            [w + anchor[0], h + anchor[1]]
        } else {
            create_point_at(
                &element,
                scene,
                px - self.pointer_offset[0],
                py - self.pointer_offset[1],
                if element.is_elbow_arrow() {
                    None
                } else {
                    ctx.grid(mods)
                },
            )
        };
        if is_uncommitted {
            move_points(
                &self.element_id,
                scene,
                &PointsPositionUpdates::from([(points.len() - 1, PointUpdate::at(new_point))]),
                None,
                &MovePointsOpts::default(),
                ctx.hooks,
            );
        } else {
            add_points(scene, &self.element_id, &[new_point], ctx.hooks);
        }
        let e = scene.get_element(&self.element_id)?;
        Some(LinearElementEditor {
            last_uncommitted_point: pts(e).last().copied(),
            ..self.clone()
        })
    }

    /// `duplicateSelectedPoints`: each selected point gets a copy halfway to
    /// the next (or 30px on, at the end), which becomes the selection.
    pub fn duplicate_selected_points(
        &self,
        scene: &mut Scene,
        hooks: &dyn BindingHooks,
    ) -> Option<Self> {
        if !self.is_editing {
            return None;
        }
        let selected = self.selected_points_indices.as_ref()?;
        let element = live(scene, &self.element_id)?.clone();
        let points = pts(&element);
        let mut next_selected = vec![];
        let mut added_to_end = false;
        let mut cursor: isize = -1;
        let mut next = vec![];
        for (i, &p) in points.iter().enumerate() {
            cursor += 1;
            next.push(p);
            if selected.contains(&i) {
                let np = points.get(i + 1);
                if np.is_none() {
                    added_to_end = true;
                }
                next.push(np.map_or(p, |n| [(p[0] + n[0]) / 2., (p[1] + n[1]) / 2.]));
                next_selected.push((cursor + 1) as usize);
                cursor += 1;
            }
        }
        scene.mutate_element(&self.element_id, true, |e| {
            if let Some(q) = e.points_mut() {
                *q = next.clone()
            }
        });
        // keep the line from moving when adding at the end
        if added_to_end {
            let e = scene.get_element(&self.element_id)?;
            let n = pts(e).len();
            let lp = pts(e)[n - 1];
            move_points(
                &self.element_id,
                scene,
                &PointsPositionUpdates::from([(
                    n - 1,
                    PointUpdate::at([lp[0] + 30., lp[1] + 30.]),
                )]),
                None,
                &MovePointsOpts::default(),
                hooks,
            );
        }
        Some(LinearElementEditor {
            selected_points_indices: Some(next_selected),
            ..self.clone()
        })
    }

    /// `shouldAddMidpoint`: the pointer went down on a midpoint and moved
    /// far enough (or the editor is open).
    pub fn should_add_midpoint(&self, pointer: Point, zoom: f64, map: &dyn ElementsMap) -> bool {
        let Some(e) = self.get_element(map) else {
            return false;
        };
        // elbow arrows don't take midpoints
        if e.is_elbow_arrow() {
            return false;
        }
        let sm = &self.initial_state.segment_midpoint;
        let Some(origin) = self.initial_state.origin else {
            return false;
        };
        if sm.added || sm.value.is_none() || sm.index.is_none() {
            return false;
        }
        !(!self.is_editing && point_distance(origin, pointer) < DRAGGING_THRESHOLD / zoom)
    }

    /// `addMidpoint`: inserts a point at the pointer into the hit segment;
    /// returns the new initial state and selection.
    pub fn add_midpoint(
        &self,
        pointer: Point,
        snap_to_grid: bool,
        grid_size: Option<f64>,
        scene: &mut Scene,
    ) -> Option<(InitialState, Option<Vec<usize>>)> {
        let e = live(scene, &self.element_id)?.clone();
        let idx = self.initial_state.segment_midpoint.index?;
        let mid = create_point_at(
            &e,
            scene,
            pointer[0],
            pointer[1],
            if snap_to_grid && !e.is_elbow_arrow() {
                grid_size
            } else {
                None
            },
        );
        let mut points = pts(&e).to_vec();
        points.insert(idx.min(points.len()), mid);
        scene.mutate_element(&self.element_id, true, |e| {
            if let Some(q) = e.points_mut() {
                *q = points.clone()
            }
        });
        let st = InitialState {
            segment_midpoint: SegmentMidpoint {
                added: true,
                ..self.initial_state.segment_midpoint.clone()
            },
            last_clicked_point: idx as isize,
            ..self.initial_state.clone()
        };
        Some((st, Some(vec![idx])))
    }

    /// `handleBoundTextDragging`: slides the arrow's label along it.
    pub fn handle_bound_text_dragging(&self, scene: &mut Scene, pointer: Point) -> Option<Self> {
        let e = live(scene, &self.element_id)?.clone();
        let t = get_bound_text_element(&e, scene)?.clone();
        if !e.is_arrow() {
            return None;
        }
        let g = [
            pointer[0] - self.pointer_offset[0],
            pointer[1] - self.pointer_offset[1],
        ];
        let pos = get_path_parameter_at_point(&e, g, scene)?;
        let p = get_point_at_path_parameter(&e, pos, scene)?;
        scene.mutate_element(&t.id, true, |x| {
            if let Some(td) = x.text_mut() {
                td.label_position = Some(Some(pos));
            }
            (x.x, x.y) = (p[0] - t.width / 2., p[1] - t.height / 2.);
        });
        Some(LinearElementEditor {
            is_dragging: true,
            ..self.clone()
        })
    }

    /// `moveFixedSegment`: fixes the elbow arrow's segment `index` where the
    /// pointer drags it.
    pub fn move_fixed_segment(
        &self,
        index: usize,
        x: f64,
        y: f64,
        scene: &mut Scene,
        hooks: &dyn BindingHooks,
    ) -> Self {
        let Some(e) = live(scene, &self.element_id)
            .filter(|e| e.is_elbow_arrow())
            .cloned()
        else {
            return self.clone();
        };
        let p = pts(&e);
        if index == 0 || index >= p.len() {
            return self.clone();
        }
        let horizontal =
            heading_is_horizontal(vector_to_heading(vector_from_point(p[index], p[index - 1])));
        let mut segs: std::collections::BTreeMap<usize, FixedSegment> = e
            .elbow()
            .and_then(|el| el.fixed_segments.clone())
            .unwrap_or_default()
            .into_iter()
            .map(|s| (s.index, s))
            .collect();
        segs.insert(
            index,
            FixedSegment {
                index,
                start: [
                    if !horizontal {
                        x - e.x
                    } else {
                        p[index - 1][0]
                    },
                    if horizontal { y - e.y } else { p[index - 1][1] },
                ],
                end: [
                    if !horizontal { x - e.x } else { p[index][0] },
                    if horizontal { y - e.y } else { p[index][1] },
                ],
            },
        );
        let next: Vec<FixedSegment> = segs.into_values().collect();
        let offset = next.iter().filter(|s| s.index < index).count();
        mutate_elbow_arrow(
            scene,
            &self.element_id,
            &ElbowUpdate {
                fixed_segments: Some(Some(next)),
                ..Default::default()
            },
            &ElbowOptions::default(),
            hooks,
        );
        let e = scene.get_element(&self.element_id).unwrap();
        let Some(s) = e
            .elbow()
            .and_then(|el| el.fixed_segments.as_ref())
            .and_then(|f| f.get(offset))
            .copied()
        else {
            return self.clone();
        };
        let point = [
            e.x + (s.start[0] + s.end[0]) / 2.,
            e.y + (s.start[1] + s.end[1]) / 2.,
        ];
        LinearElementEditor {
            segment_mid_point_hovered_coords: Some(point),
            initial_state: InitialState {
                segment_midpoint: SegmentMidpoint {
                    added: false,
                    index: Some(s.index),
                    value: Some(point),
                },
                ..self.initial_state.clone()
            },
            ..self.clone()
        }
    }

    // App.tsx: the linear editor's share of the pointer handlers

    /// The pointer moved with the button down over the editor (App.tsx's
    /// order): a focus point drag, an elbow segment drag, inserting a
    /// midpoint, waiting for the midpoint drag threshold, or dragging the
    /// clicked points. `label_drag` is the app's label drag
    /// (`arrowText.maybeDragLabel`), which goes before the midpoint.
    pub fn handle_drag(
        &self,
        scene: &mut Scene,
        ctx: &LinearCtx,
        pointer: Point,
        mods: &Modifiers,
    ) -> DragOutcome {
        if self.elbowed
            && self
                .initial_state
                .segment_midpoint
                .index
                .is_some_and(|i| i > 0)
        {
            let [gx, gy] = get_grid_point(pointer[0], pointer[1], ctx.grid(mods));
            let index = self.initial_state.segment_midpoint.index.unwrap();
            let ret = self.move_fixed_segment(index, gx, gy, scene, ctx.hooks);
            return DragOutcome::Segment(LinearElementEditor {
                is_dragging: true,
                segment_mid_point_hovered_coords: ret.segment_mid_point_hovered_coords,
                initial_state: ret.initial_state,
                ..self.clone()
            });
        }
        if self.dragged_focus_point_binding.is_some() {
            self.handle_focus_point_drag(scene, ctx, pointer, ctx.effective_grid_size(), mods.alt);
            return DragOutcome::FocusPoint(LinearElementEditor {
                is_dragging: false,
                selected_points_indices: Some(vec![]),
                initial_state: InitialState {
                    last_clicked_point: -1,
                    ..self.initial_state.clone()
                },
                ..self.clone()
            });
        }
        if self.should_add_midpoint(pointer, ctx.zoom, scene) {
            let Some((st, sel)) =
                self.add_midpoint(pointer, !mods.ctrl_or_cmd, ctx.effective_grid_size(), scene)
            else {
                return DragOutcome::Ignored;
            };
            return DragOutcome::MidpointAdded(LinearElementEditor {
                initial_state: st,
                selected_points_indices: sel,
                segment_mid_point_hovered_coords: None,
                is_dragging: true,
                ..self.clone()
            });
        }
        if self.initial_state.segment_midpoint.value.is_some()
            && !self.initial_state.segment_midpoint.added
        {
            return DragOutcome::Ignored;
        }
        if self.initial_state.last_clicked_point > -1 {
            if live(scene, &self.element_id).is_none() {
                return DragOutcome::Ignored;
            }
            return match self.handle_point_dragging(scene, ctx, pointer, mods) {
                Some((e, s)) => DragOutcome::Dragged(e, s),
                None => DragOutcome::Ignored,
            };
        }
        DragOutcome::NotHandled
    }

    /// A double click on the selected line or arrow: lines (and simple
    /// arrows with Ctrl/Cmd) open the editor; on an elbow arrow's segment
    /// midpoint, the fixed segment there is let go.
    pub fn handle_double_click(
        &self,
        scene: &mut Scene,
        ctx: &LinearCtx,
        pointer: Point,
        mods: &Modifiers,
    ) -> DoubleClickOutcome {
        let Some(e) = live(scene, &self.element_id).cloned() else {
            return DoubleClickOutcome::None;
        };
        if ((mods.ctrl_or_cmd && e.is_simple_arrow()) || e.is_line()) && !self.is_editing {
            return DoubleClickOutcome::ToggleEditor;
        }
        if e.is_elbow_arrow() {
            let hit =
                self.get_segment_midpoint_hit_coords(pointer, ctx.zoom, self.is_editing, scene);
            let mid = hit.map_or(-1, |h| {
                self.get_segment_mid_point_index(ctx.zoom, self.is_editing, h, scene)
            });
            if mid > -1 {
                delete_fixed_segment(scene, &self.element_id, mid as usize, ctx.hooks);
                let probe = LinearElementEditor {
                    segment_mid_point_hovered_coords: None,
                    ..self.clone()
                };
                let next = probe.get_segment_midpoint_hit_coords(
                    pointer,
                    ctx.zoom,
                    self.is_editing,
                    scene,
                );
                let next_index = next
                    .map(|n| self.get_segment_mid_point_index(ctx.zoom, self.is_editing, n, scene))
                    .filter(|&i| i >= 0)
                    .map(|i| i as usize);
                return DoubleClickOutcome::SegmentReleased(LinearElementEditor {
                    initial_state: InitialState {
                        segment_midpoint: SegmentMidpoint {
                            index: next_index,
                            value: hit,
                            added: false,
                        },
                        ..self.initial_state.clone()
                    },
                    segment_mid_point_hovered_coords: next,
                    ..self.clone()
                });
            }
        }
        DoubleClickOutcome::None
    }

    // arrows/focus.ts

    /// `handleFocusPointDrag`: drags the focus point of the binding at
    /// `dragged_focus_point_binding`; `switch_to_inside` (Alt) makes it an
    /// inside binding.
    pub fn handle_focus_point_drag(
        &self,
        scene: &mut Scene,
        ctx: &LinearCtx,
        pointer: Point,
        grid_size: Option<f64>,
        switch_to_inside: bool,
    ) {
        let Some(arrow) = live(scene, &self.element_id).cloned() else {
            return;
        };
        let (Some(_), Some(dragged)) = (
            self.hovered_focus_point_binding,
            self.dragged_focus_point_binding,
        ) else {
            return;
        };
        if !arrow.is_binding_element(true) || arrow.is_elbow_arrow() {
            return;
        }
        let is_start = dragged == StartOrEnd::Start;
        let s = if is_start {
            StartOrEnd::Start
        } else {
            StartOrEnd::End
        };
        let binding = binding_of(&arrow, s).cloned();
        let point = [
            pointer[0] - self.pointer_offset[0],
            pointer[1] - self.pointer_offset[1],
        ];
        let hit = get_hovered_element_for_binding(
            point,
            scene.elements_including_deleted(),
            scene,
            ctx.zoom,
        )
        .map(|e| e.id.clone());
        let enabled = ctx.is_binding_enabled;
        if let (Some(h), true) = (&hit, enabled) {
            // bound to another shape: let go
            if binding.as_ref().is_some_and(|b| &b.element_id != h) {
                unbind_binding_element(&self.element_id, dragged, scene);
            }
            let cur = binding_of(scene.get_element(&self.element_id).unwrap(), s).cloned();
            let new_mode = match cur.as_ref().map(|b| b.mode) {
                Some(BindMode::Orbit) if switch_to_inside => Some(BindMode::Inside),
                Some(BindMode::Inside) if !switch_to_inside => Some(BindMode::Orbit),
                _ => None,
            };
            if cur.is_none() || new_mode.is_some() {
                bind_binding_element(
                    &self.element_id,
                    h,
                    new_mode.unwrap_or(BindMode::Orbit),
                    dragged,
                    scene,
                    ctx.zoom,
                    Some(point),
                    true,
                    true,
                );
            }
            let a = scene.get_element(&self.element_id).unwrap().clone();
            let cur = binding_of(&a, s).cloned();
            let hit_el = scene.get_element(h).unwrap().clone();
            let fp = calculate_fixed_point_for_non_elbow_arrow_binding(
                &a,
                &hit_el,
                dragged,
                scene,
                Some(point),
            );
            let nb = FixedPointBinding {
                element_id: h.clone(),
                mode: new_mode.or(cur.map(|b| b.mode)).unwrap_or(BindMode::Orbit),
                fixed_point: fp,
            };
            scene.mutate_element(&self.element_id, true, |e| {
                if let Some(l) = e.linear_mut() {
                    if is_start {
                        l.start_binding = Some(nb.clone())
                    } else {
                        l.end_binding = Some(nb.clone())
                    }
                }
            });
        } else {
            // over nothing: the end follows
            let idx = if is_start { 0 } else { pts(&arrow).len() - 1 };
            let p = create_point_at(&arrow, scene, point[0], point[1], grid_size);
            move_points(
                &self.element_id,
                scene,
                &PointsPositionUpdates::from([(idx, PointUpdate::at(p))]),
                None,
                &MovePointsOpts::default(),
                ctx.hooks,
            );
            if binding_of(scene.get_element(&self.element_id).unwrap(), s).is_some() {
                unbind_binding_element(&self.element_id, s, scene);
            }
        }
        self.focus_point_update(scene, hit.as_deref(), is_start, ctx, switch_to_inside);
        if let (Some(h), true) = (&hit, enabled) {
            move_arrow_above_bindable(&self.element_id, h, scene);
        }
    }

    /// `focusPointUpdate`: re-places the arrow's ends for its (orbit)
    /// bindings after the focus point moved.
    fn focus_point_update(
        &self,
        scene: &mut Scene,
        bindable: Option<&str>,
        is_start: bool,
        ctx: &LinearCtx,
        switch_to_inside: bool,
    ) {
        let Some(arrow) = scene.get_element(&self.element_id).cloned() else {
            return;
        };
        let (s, o) = if is_start {
            (StartOrEnd::Start, StartOrEnd::End)
        } else {
            (StartOrEnd::End, StartOrEnd::Start)
        };
        let orig_adjacent = self
            .initial_state
            .arrow_other_endpoint_initial_binding
            .as_ref();
        let mut current = binding_of(&arrow, s).cloned();
        let mut adjacent = match (orig_adjacent, binding_of(&arrow, o)) {
            (Some(oa), Some(a)) if oa.mode == BindMode::Orbit && a.mode == BindMode::Inside => {
                Some(oa.clone())
            }
            (_, a) => a.cloned(),
        };
        let mut updates = PointsPositionUpdates::new();
        let n = pts(&arrow).len();
        let bindable_el = bindable.and_then(|b| scene.get_element(b)).cloned();
        if let (Some(c), Some(b)) = (&mut current, &bindable_el) {
            let same = adjacent
                .as_ref()
                .is_some_and(|a| a.element_id == c.element_id);
            c.mode = if switch_to_inside || same {
                BindMode::Inside
            } else {
                BindMode::Orbit
            };
            if let Some(p) = update_bound_point(&arrow, s, Some(c), b, scene, true) {
                updates.insert(if is_start { 0 } else { n - 1 }, PointUpdate::at(p));
            }
        }
        if let Some(a) = adjacent.as_mut().filter(|a| a.mode == BindMode::Orbit)
            && let Some(ab) = scene
                .get_element(&a.element_id)
                .filter(|e| e.is_bindable(true))
                .cloned()
            && ctx.is_binding_enabled
        {
            a.mode = if bindable.is_some_and(|b| a.element_id == b) {
                BindMode::Inside
            } else {
                BindMode::Orbit
            };
            if let Some(p) = update_bound_point(&arrow, o, Some(a), &ab, scene, false) {
                updates.insert(if is_start { n - 1 } else { 0 }, PointUpdate::at(p));
            }
        }
        if !updates.is_empty() {
            let other = if is_start {
                binding_updates(Some(current), Some(adjacent))
            } else {
                binding_updates(Some(adjacent), Some(current))
            };
            move_points(
                &self.element_id,
                scene,
                &updates,
                Some(&other),
                &MovePointsOpts::default(),
                ctx.hooks,
            );
        }
    }

    /// `handleFocusPointPointerUp`: the arrow listed on what it ended up
    /// bound to, and off what it left. Returns the editor with the initial
    /// other-end binding cleared.
    pub fn handle_focus_point_pointer_up(&self, scene: &mut Scene) -> Self {
        let next = LinearElementEditor {
            initial_state: InitialState {
                arrow_other_endpoint_initial_binding: None,
                ..self.initial_state.clone()
            },
            ..self.clone()
        };
        let (Some(dragged), Some(arrow)) = (
            self.dragged_focus_point_binding,
            live(scene, &self.element_id).cloned(),
        ) else {
            return next;
        };
        let other = if dragged == StartOrEnd::Start {
            StartOrEnd::End
        } else {
            StartOrEnd::Start
        };
        let bound_id = binding_of(&arrow, dragged).map(|b| b.element_id.clone());
        let other_id = binding_of(&arrow, other).map(|b| b.element_id.clone());
        if let Some(bid) = &bound_id {
            let old = scene
                .non_deleted_elements()
                .find(|e| {
                    &e.id != bid
                        && Some(&e.id) != other_id.as_ref()
                        && e.is_bindable(true)
                        && e.bound_elements.iter().flatten().any(|b| b.id == arrow.id)
                })
                .map(|e| e.id.clone());
            if let Some(old) = old {
                scene.mutate_element(&old, true, |e| {
                    if let Some(b) = &mut e.bound_elements {
                        b.retain(|b| b.id != arrow.id)
                    }
                });
            }
            if live(scene, bid).is_some() {
                scene.mutate_element(bid, true, |e| {
                    let b = e.bound_elements.get_or_insert_with(Vec::new);
                    b.retain(|b| b.id != arrow.id);
                    b.push(BoundElement {
                        id: arrow.id.clone(),
                        kind: BoundType::Arrow,
                    });
                });
            }
        }
        next
    }

    /// `maybeHandleArrowPointlikeDrag` (arrows/helpers.ts): a modifier change
    /// while dragging re-runs the focus point or point drag at the last
    /// pointer position. Returns whether it did.
    pub fn maybe_handle_arrow_pointlike_drag(
        &self,
        scene: &mut Scene,
        ctx: &LinearCtx,
        last_pointer: Option<Point>,
        mods: &Modifiers,
    ) -> bool {
        let Some(p) = last_pointer else { return false };
        if self.dragged_focus_point_binding.is_some() {
            self.handle_focus_point_drag(scene, ctx, p, ctx.effective_grid_size(), mods.alt);
            return true;
        }
        if self.hover_point_index != -1
            && self.initial_state.last_clicked_point >= 0
            && self.is_dragging
        {
            let _ = self.handle_point_dragging(scene, ctx, p, mods);
            return true;
        }
        false
    }
}

// ---------------------------------------------------------------------------
// static helpers
// ---------------------------------------------------------------------------

/// `getEditorMidPoints`: segment midpoints (None for segments too short to
/// show one). Empty for 3+ point lines outside the editor without a label.
pub fn get_editor_mid_points(
    e: &Element,
    map: &dyn ElementsMap,
    zoom: f64,
    is_editing: bool,
) -> Vec<Option<Point>> {
    let p = pts(e);
    if !e.is_elbow_arrow() && !is_editing && p.len() > 2 && get_bound_text_element(e, map).is_none()
    {
        return vec![];
    }
    (0..p.len().saturating_sub(1))
        .map(|i| {
            (!is_segment_too_short(e, p[i], p[i + 1], i, zoom, map))
                .then(|| get_segment_mid_point(e, i + 1, map))
        })
        .collect()
}

/// `isSegmentTooShort` to show a midpoint knob on.
pub fn is_segment_too_short(
    e: &Element,
    a: Point,
    b: Point,
    index: usize,
    zoom: f64,
    map: &dyn ElementsMap,
) -> bool {
    if e.is_elbow_arrow() {
        return index < pts(e).len() && point_distance(a, b) * zoom < POINT_HANDLE_SIZE / 2.;
    }
    let mut d = point_distance(a, b);
    if pts(e).len() > 2 && e.roundness.is_some() {
        let (_, curves) = deconstruct_linear_or_freedraw_element(e, map);
        if let Some(&c) = curves.get(index) {
            d = curve_length(c);
        }
    }
    d * zoom < POINT_HANDLE_SIZE * 4.
}

/// `isPointHandle`: elbow arrows only expose their ends.
pub fn is_point_handle(e: &Element, index: isize) -> bool {
    index >= 0 && (!e.is_elbow_arrow() || index == 0 || index as usize + 1 == pts(e).len())
}

/// `getPointIndexUnderCursor`: the top-most point handle under the pointer,
/// -1 if none.
pub fn get_point_index_under_cursor(
    e: &Element,
    map: &dyn ElementsMap,
    zoom: f64,
    p: Point,
) -> isize {
    // the last points are drawn over the earlier ones
    get_points_global_coordinates(e, map)
        .iter()
        .rposition(|&h| point_distance(p, h) * zoom < POINT_HANDLE_SIZE + 1.)
        .map_or(-1, |i| i as isize)
}

/// `_getShiftLockedDelta`: the offset from `reference` (local) to the
/// pointer, locked to 15° steps (or the custom angle), in local axes.
pub fn get_shift_locked_delta(
    e: &Element,
    map: &dyn ElementsMap,
    reference: Point,
    pointer: Point,
    grid_size: Option<f64>,
    custom_angle: Option<f64>,
) -> Point {
    let r = get_point_global_coordinates(e, reference, map);
    if e.is_elbow_arrow() {
        return [pointer[0] - r[0], pointer[1] - r[1]];
    }
    let [gx, gy] = get_grid_point(pointer[0], pointer[1], grid_size);
    let (w, h) = get_locked_linear_cursor_align_size(r[0], r[1], gx, gy, custom_angle);
    point_rotate_rads([w, h], [0., 0.], -e.angle)
}

/// `deletePoints`. A polygon stays closed when its start, end or pending
/// point goes.
pub fn delete_points(
    scene: &mut Scene,
    id: &str,
    indices: &[usize],
    editor: Option<&LinearElementEditor>,
    hooks: &dyn BindingHooks,
) {
    let Some(e) = live(scene, id).cloned() else {
        return;
    };
    let p = pts(&e);
    let uncommitted =
        editor.is_some_and(|ed| ed.is_editing && ed.last_uncommitted_point == p.last().copied());
    let mut next: Vec<Point> = p
        .iter()
        .enumerate()
        .filter(|(i, _)| !indices.contains(i))
        .map(|(_, &q)| q)
        .collect();
    if next.is_empty() {
        return;
    }
    if e.is_line_polygon()
        && (uncommitted || indices.contains(&0) || indices.contains(&(p.len() - 1)))
    {
        next[0] = next[next.len() - 1];
    }
    let (np, ox, oy) = get_normalized_points(&next);
    update_points(
        id,
        scene,
        &np,
        [ox, oy],
        None,
        &ElbowOptions::default(),
        hooks,
    );
}

/// `addPoints`: appends points (local), a polygon staying closed.
pub fn add_points(scene: &mut Scene, id: &str, added: &[Point], hooks: &dyn BindingHooks) {
    let Some(e) = live(scene, id).cloned() else {
        return;
    };
    let mut next = pts(&e).to_vec();
    next.extend_from_slice(added);
    if e.is_line_polygon() {
        next[0] = next[next.len() - 1];
    }
    let (np, ox, oy) = get_normalized_points(&next);
    update_points(
        id,
        scene,
        &np,
        [ox, oy],
        None,
        &ElbowOptions::default(),
        hooks,
    );
}

/// The app's `scene.mutateElement(elbowArrow, {})` after a gesture: merges
/// collinear segments and drops short ones.
pub fn renormalize_elbow_arrow(scene: &mut Scene, id: &str, hooks: &dyn BindingHooks) {
    if live(scene, id).is_some_and(|e| e.is_elbow_arrow()) {
        mutate_elbow_arrow(
            scene,
            id,
            &ElbowUpdate::default(),
            &ElbowOptions::default(),
            hooks,
        );
    }
}

/// `deleteFixedSegment`: lets go of the elbow arrow's fixed segment `index`.
pub fn delete_fixed_segment(scene: &mut Scene, id: &str, index: usize, hooks: &dyn BindingHooks) {
    let Some(f) = live(scene, id)
        .and_then(|e| e.elbow())
        .and_then(|e| e.fixed_segments.clone())
    else {
        return;
    };
    let next = f.into_iter().filter(|s| s.index != index).collect();
    mutate_elbow_arrow(
        scene,
        id,
        &ElbowUpdate {
            fixed_segments: Some(Some(next)),
            ..Default::default()
        },
        &ElbowOptions::default(),
        hooks,
    );
}

/// `moveArrowAboveBindable` (zindex.rs) on the scene.
fn move_arrow_above_bindable(arrow_id: &str, hovered_id: &str, scene: &mut Scene) {
    if let Some(next) = super::zindex::move_arrow_above_bindable(
        scene.elements_including_deleted(),
        arrow_id,
        hovered_id,
    ) {
        scene.replace_all_elements(next);
    }
}

/// The binding updates and suggested binding of a point drag.
struct DragUpdates {
    start_binding: Option<Option<FixedPointBinding>>,
    end_binding: Option<Option<FixedPointBinding>>,
    suggested_binding: Option<SuggestedBinding>,
}

/// `pointDraggingUpdates`: where the dragged points go, with the bindings
/// they make or break and the bound ends they move.
#[allow(clippy::too_many_arguments)]
fn point_dragging_updates(
    selected: &[usize],
    dx: f64,
    dy: f64,
    pointer: Point,
    scene: &Scene,
    element: &Element,
    ctx: &LinearCtx,
    angle_locked: bool,
    alt: bool,
    editor: &LinearElementEditor,
) -> (PointsPositionUpdates, Option<DragUpdates>, Option<String>) {
    let points = pts(element);
    let last = points.len() - 1;
    // (elbow arrows can change their point count while dragging)
    let naive: PointsPositionUpdates = selected
        .iter()
        .map(|&i| {
            let p = points.get(i).copied().unwrap_or(points[last]);
            (
                i,
                PointUpdate {
                    point: [p[0] + dx, p[1] + dy],
                    is_dragging: true,
                },
            )
        })
        .collect();
    if !element.is_arrow() {
        return (naive, None, None);
    }
    let (sd, ed) = (selected.contains(&0), selected.contains(&last));
    let drag = editor.initial_state.drag_state();
    let bctx = ctx.binding(Some(&drag));
    let opts = BindOpts {
        new_arrow: ctx.new_element,
        angle_locked,
        alt_key: alt,
        ..Default::default()
    };
    let (start, end) = get_binding_strategy_for_dragging_binding_element_endpoints(
        element,
        &naive,
        pointer,
        scene,
        scene.elements_including_deleted(),
        &bctx,
        &opts,
    );
    let pointer_at = [
        pointer[0] - editor.pointer_offset[0],
        pointer[1] - editor.pointer_offset[1],
    ];
    let suggest = |id: &str, elbowed: bool, snap: bool| {
        scene.get_element(id).map(|b| SuggestedBinding {
            element: id.into(),
            mid_point: if snap {
                get_snap_outline_mid_point(pointer_at, b, scene, ctx.zoom, elbowed)
            } else {
                None
            },
        })
    };
    if element.is_elbow_arrow() {
        let el = if sd {
            start.element()
        } else if ed {
            end.element()
        } else {
            None
        };
        let sb = el.and_then(|id| suggest(id, true, ctx.is_midpoint_snapping_enabled));
        return (
            naive,
            Some(DragUpdates {
                start_binding: None,
                end_binding: None,
                suggested_binding: sb,
            }),
            el.map(String::from),
        );
    }
    // neither end dragged: the bound ends follow their bindings
    if !sd && !ed {
        let mut next = element.clone();
        if let Some(p) = next.points_mut() {
            for (i, u) in &naive {
                if *i < p.len() {
                    p[*i] = u.point;
                }
            }
        }
        let mut positions = naive.clone();
        for (s, i) in [(StartOrEnd::Start, 0), (StartOrEnd::End, last)] {
            let Some(b) = binding_of(element, s) else {
                continue;
            };
            let Some(bindable) = scene.get_element(&b.element_id) else {
                continue;
            };
            if let Some(p) = update_bound_point(&next, s, Some(b), bindable, scene, false) {
                positions.insert(
                    i,
                    PointUpdate {
                        point: p,
                        is_dragging: true,
                    },
                );
            }
        }
        return (positions, None, None);
    }
    if sd == ed {
        return (naive, None, None);
    }
    let mut u = DragUpdates {
        start_binding: None,
        end_binding: None,
        suggested_binding: None,
    };
    for (s, strat, dragged) in [(StartOrEnd::Start, &start, sd), (StartOrEnd::End, &end, ed)] {
        let set: Option<Option<FixedPointBinding>> = match strat {
            BindingStrategy::Unbind => Some(None),
            BindingStrategy::Bind {
                mode,
                element: id,
                focus_point,
            } => {
                let b = scene.get_element(id).unwrap();
                let fp = calculate_fixed_point_for_non_elbow_arrow_binding(
                    element,
                    b,
                    s,
                    scene,
                    Some(*focus_point),
                );
                if dragged && (*mode == BindMode::Orbit || !ctx.complex_bindings) {
                    u.suggested_binding = suggest(id, false, true);
                }
                Some(Some(FixedPointBinding {
                    element_id: id.clone(),
                    mode: *mode,
                    fixed_point: fp,
                }))
            }
            BindingStrategy::Keep => {
                if dragged {
                    u.suggested_binding = ctx.suggested_binding.cloned();
                }
                None
            }
        };
        if s == StartOrEnd::Start {
            u.start_binding = set
        } else {
            u.end_binding = set
        }
    }
    // the arrow as dragged, for the bound point calculation
    let os = if sd {
        [points[0][0] + dx, points[0][1] + dy]
    } else {
        points[0]
    };
    let oe = if ed {
        [points[last][0] + dx, points[last][1] + dy]
    } else {
        points[last]
    };
    let mut next = element.clone();
    if let Some(l) = next.linear_mut() {
        l.points[0] = os;
        l.points[last] = oe;
        if let Some(b) = &u.start_binding {
            l.start_binding = b.clone();
        }
        if let Some(b) = &u.end_binding {
            l.end_binding = b.clone();
        }
    }
    let (eb, sb) = (
        binding_of(element, StartOrEnd::End),
        binding_of(element, StartOrEnd::Start),
    );
    let (nsb, neb) = (
        binding_of(&next, StartOrEnd::Start).cloned(),
        binding_of(&next, StartOrEnd::End).cloned(),
    );
    // an existing arrow dragged over the element its other end is bound to
    let start_over_end = eb.is_some()
        && sd
        && nsb
            .as_ref()
            .is_some_and(|n| Some(&n.element_id) == eb.map(|b| &b.element_id));
    let end_over_start = sb.is_some()
        && ed
        && neb
            .as_ref()
            .is_some_and(|n| Some(&n.element_id) == sb.map(|b| &b.element_id));
    let not_inside = ctx.bind_mode != BindMode::Inside;
    let cx = ctx.complex_bindings;
    // the other end moves too when bound
    let end_bindable = neb
        .as_ref()
        .and_then(|b| {
            end.element()
                .and_then(|id| scene.get_element(id))
                .or_else(|| scene.get_element(&b.element_id))
        })
        .cloned();
    let end_local = if end_over_start && not_inside && cx {
        next.linear().unwrap().points[0]
    } else if let Some(b) = &end_bindable {
        update_bound_point(&next, StartOrEnd::End, neb.as_ref(), b, scene, ed).unwrap_or(oe)
    } else {
        oe
    };
    // keep the simulated arrow up to date: the bound point reads the other end
    if let Some(l) = next.linear_mut() {
        l.points[last] = end_local;
    }
    let start_bindable = nsb
        .as_ref()
        .and_then(|b| {
            start
                .element()
                .and_then(|id| scene.get_element(id))
                .or_else(|| scene.get_element(&b.element_id))
        })
        .cloned();
    let start_local = if end_over_start && cx {
        pts(&next)[0]
    } else if start_over_end && not_inside && cx {
        end_local
    } else if let Some(b) = &start_bindable {
        update_bound_point(&next, StartOrEnd::Start, nsb.as_ref(), b, scene, sd)
            .unwrap_or(pts(&next)[0])
    } else {
        pts(&next)[0]
    };
    let end_changed = !(end_over_start && not_inside && cx) && end_bindable.is_some();
    let start_changed = point_distance(start_local, pts(&next)[0]) != 0.;
    let mut indices: Vec<usize> = vec![];
    for &i in selected {
        if !indices.contains(&i) {
            indices.push(i);
        }
    }
    if start_bindable.is_some() && start_changed && !indices.contains(&0) {
        indices.push(0);
    }
    if end_bindable.is_some() && end_changed && !indices.contains(&last) {
        indices.push(last);
    }
    let positions: PointsPositionUpdates = indices
        .iter()
        .map(|&i| {
            (
                i,
                if i == 0 {
                    PointUpdate {
                        point: start_local,
                        is_dragging: true,
                    }
                } else if i == last {
                    PointUpdate {
                        point: end_local,
                        is_dragging: true,
                    }
                } else {
                    naive[&i]
                },
            )
        })
        .collect();
    let hit = if sd { start.element() } else { end.element() }.map(String::from);
    (positions, Some(u), hit)
}

// ---------------------------------------------------------------------------
// arrows/focus.ts
// ---------------------------------------------------------------------------

/// `isFocusPointVisible`: simple 2-point arrows show a binding's focus
/// point when it's off the end and on the element.
pub fn is_focus_point_visible(
    focus: Point,
    arrow: &Element,
    bindable: &Element,
    map: &dyn ElementsMap,
    is_binding_enabled: bool,
    zoom: f64,
    s: StartOrEnd,
    ignore_overlap: bool,
) -> bool {
    let p = pts(arrow);
    // elbow arrows have their focus point at the end itself
    if arrow.is_elbow_arrow() || !is_binding_enabled || p.len() != 2 {
        return false;
    }
    let size = FOCUS_POINT_SIZE * 1.5 / zoom;
    if !ignore_overlap {
        let assoc =
            if binding_of(arrow, StartOrEnd::Start).is_some_and(|b| b.element_id == bindable.id) {
                0
            } else {
                p.len() as isize - 1
            };
        if point_distance(
            focus,
            get_point_at_index_global_coordinates(arrow, assoc, map),
        ) < size
        {
            return false;
        }
    }
    let ap = get_point_at_index_global_coordinates(
        arrow,
        if s == StartOrEnd::End {
            p.len() as isize - 1
        } else {
            0
        },
        map,
    );
    // dragging the end takes precedence
    point_distance(focus, ap) >= size
        && hit_element_itself(&HitTestArgs {
            override_should_test_inside: true,
            ..HitTestArgs::new(focus, bindable, get_binding_gap(bindable.stroke_width), map)
        })
}

/// The visible focus point of the arrow's end binding within reach of the
/// pointer: (end, focus point).
fn focus_point_at(
    arrow: &Element,
    pointer: Point,
    map: &dyn ElementsMap,
    is_binding_enabled: bool,
    zoom: f64,
) -> Option<(StartOrEnd, Point)> {
    let threshold = FOCUS_POINT_SIZE * 1.5 / zoom;
    for s in [StartOrEnd::Start, StartOrEnd::End] {
        let Some(b) = binding_of(arrow, s) else {
            continue;
        };
        let Some(e) = live(map, &b.element_id).filter(|e| e.is_bindable(true)) else {
            continue;
        };
        let f = get_global_fixed_point_for_bindable_element(b.fixed_point, e, map);
        if is_focus_point_visible(f, arrow, e, map, is_binding_enabled, zoom, s, false)
            && point_distance(pointer, f) <= threshold
        {
            return Some((s, f));
        }
    }
    None
}

/// `handleFocusPointPointerDown`: (the focus point hit, the pointer offset
/// from it, the other end's binding).
pub fn handle_focus_point_pointer_down(
    arrow: &Element,
    origin: Point,
    map: &dyn ElementsMap,
    is_binding_enabled: bool,
    zoom: f64,
) -> (Option<StartOrEnd>, Point, Option<FixedPointBinding>) {
    match focus_point_at(arrow, origin, map, is_binding_enabled, zoom) {
        Some((s, f)) => (
            Some(s),
            [origin[0] - f[0], origin[1] - f[1]],
            binding_of(
                arrow,
                if s == StartOrEnd::Start {
                    StartOrEnd::End
                } else {
                    StartOrEnd::Start
                },
            )
            .cloned(),
        ),
        None => (None, [0., 0.], None),
    }
}

/// `handleFocusPointHover`.
pub fn handle_focus_point_hover(
    arrow: &Element,
    pointer: Point,
    map: &dyn ElementsMap,
    is_binding_enabled: bool,
    zoom: f64,
) -> Option<StartOrEnd> {
    focus_point_at(arrow, pointer, map, is_binding_enabled, zoom).map(|f| f.0)
}

// ---------------------------------------------------------------------------
// actionFinalize.tsx, actionLinearEditor.tsx
// ---------------------------------------------------------------------------

/// The pointer that ends a linear editing gesture (`actionFinalize`'s
/// `data`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FinalizePointer {
    pub scene_coords: Point,
    pub mods: Modifiers,
    pub hit_bound_text: bool,
}

/// `actionFinalize` with pointer data and a selected linear element: the
/// gesture's pointer up, binding the dragged ends where they are, dropping a
/// line's polygon flag when it no longer closes, and deleting the element
/// when it ended up too small. Returns the editor to keep (None when the
/// tool is locked), and whether the element was deleted.
pub fn finalize_linear_gesture(
    editor: &LinearElementEditor,
    scene: &mut Scene,
    ctx: &LinearCtx,
    ptr: &FinalizePointer,
    tool_locked: bool,
) -> (Option<LinearElementEditor>, bool) {
    let Some(element) = live(scene, &editor.element_id).cloned() else {
        return (Some(editor.clone()), false);
    };
    let le = editor.handle_pointer_up(ptr.mods.shift, ctx.zoom, scene, ctx.hooks);
    let element_now = scene.get_element(&editor.element_id).unwrap().clone();
    if element.is_binding_element(true)
        && editor.segment_mid_point_hovered_coords.is_none()
        && !ptr.hit_bound_text
    {
        let n = pts(&element_now).len();
        let selected = if ctx.new_element || editor.selected_points_indices.is_none() {
            vec![n - 1]
        } else {
            editor.selected_points_indices.clone().unwrap()
        };
        let angle_locked = ptr.mods.angle_locked();
        let grid = if ptr.mods.ctrl_or_cmd {
            None
        } else {
            ctx.effective_grid_size()
        };
        let dragged: PointsPositionUpdates = selected
            .iter()
            .filter(|&&i| i < n)
            .map(|&i| {
                (
                    i,
                    PointUpdate::at(if angle_locked {
                        pts(&element_now)[i]
                    } else {
                        create_point_at(
                            &element_now,
                            scene,
                            ptr.scene_coords[0] - le.pointer_offset[0],
                            ptr.scene_coords[1] - le.pointer_offset[1],
                            grid,
                        )
                    }),
                )
            })
            .collect();
        let drag = editor.initial_state.drag_state();
        let bctx = ctx.binding(Some(&drag));
        bind_or_unbind_binding_element(
            &editor.element_id,
            &dragged,
            ptr.scene_coords,
            scene,
            &bctx,
            &BindOpts {
                new_arrow: ctx.new_element,
                alt_key: ptr.mods.alt,
                angle_locked,
                ..Default::default()
            },
        );
    } else if element.is_line()
        && editor.is_editing
        && !ctx.new_element
        && !is_valid_polygon(pts(&element_now))
    {
        scene.mutate_element(&editor.element_id, true, |e| {
            if let Kind::Line { polygon, .. } = &mut e.kind {
                *polygon = false
            }
        });
    }
    // with its ends where they ended up
    super::frame::remove_arrows_without_end_in_frame(
        std::slice::from_ref(&editor.element_id),
        scene,
    );
    let e = scene.get_element(&editor.element_id).unwrap().clone();
    let deleted = pts(&e).len() < 2 || is_invisibly_small_element(&e);
    if deleted {
        scene.mutate_element(&editor.element_id, true, |e| e.is_deleted = true);
    }
    let next = (!tool_locked).then(|| LinearElementEditor {
        selected_points_indices: None,
        is_editing: false,
        initial_state: InitialState {
            last_clicked_point: -1,
            ..le.initial_state.clone()
        },
        pointer_offset: [0., 0.],
        ..le
    });
    (next, deleted)
}

/// What `finalize_element` needs about the element being finished.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FinalizeElement {
    /// It's `appState.multiElement` (created click by click).
    pub multi_element: bool,
    /// The last pointer down was a touch (no hover point to drop).
    pub touch: bool,
}

/// `actionFinalize` without pointer data, for the element being created
/// (`multiElement` / `newElement`) or the one selected: drops the pending
/// point that followed the pointer (rebinding the end), deletes the element
/// when invisibly small, and closes loops. Returns whether the change is to
/// be captured (`captureUpdate`) and, for lines and arrows, the editor to
/// select.
pub fn finalize_element(
    id: &str,
    editor: Option<&LinearElementEditor>,
    f: &FinalizeElement,
    scene: &mut Scene,
    ctx: &LinearCtx,
) -> (bool, Option<LinearElementEditor>) {
    let mut should_commit = true;
    let Some(element) = live(scene, id).cloned() else {
        return (true, editor.cloned());
    };
    // pen and mouse have hover
    if let Some(ed) = editor
        && f.multi_element
        && !element.is_freedraw()
        && !f.touch
    {
        let p = pts(&element);
        if ed.last_committed_point.is_none_or(|c| p.last() != Some(&c)) {
            should_commit = false;
            let np = p[..p.len().saturating_sub(1)].to_vec();
            scene.mutate_element(id, true, |e| {
                if let Some(q) = e.points_mut() {
                    *q = np.clone()
                }
            });
            let e = scene.get_element(id).unwrap().clone();
            // a <2-point arrow may be left
            if e.is_binding_element(true)
                && binding_of(&e, StartOrEnd::End).is_some()
                && pts(&e).len() > 1
            {
                let n = pts(&e).len();
                let dragged =
                    PointsPositionUpdates::from([(n - 1, PointUpdate::at(pts(&e)[n - 1]))]);
                let g = get_point_at_index_global_coordinates(&e, -1, scene);
                let drag = ed.initial_state.drag_state();
                bind_or_unbind_binding_element(
                    id,
                    &dragged,
                    g,
                    scene,
                    &ctx.binding(Some(&drag)),
                    &BindOpts {
                        new_arrow: ctx.new_element,
                        ..Default::default()
                    },
                );
            }
        }
    }
    let e = scene.get_element(id).unwrap().clone();
    if is_invisibly_small_element(&e) {
        scene.mutate_element(id, true, |e| e.is_deleted = true);
    }
    if e.is_linear() || e.is_freedraw() {
        // a multi-point line closing the loop ends on its first point, so it
        // stays closed at any scale
        if is_path_a_loop(pts(&e), ctx.zoom) && (e.is_line() || e.is_freedraw()) {
            let p = pts(&e);
            let first = p[0];
            let np: Vec<Point> = p
                .iter()
                .enumerate()
                .map(|(i, &q)| if i == p.len() - 1 { first } else { q })
                .collect();
            scene.mutate_element(id, true, |x| {
                if let Some(q) = x.points_mut() {
                    *q = np.clone();
                }
                if let Kind::Line { polygon, .. } = &mut x.kind {
                    *polygon = true;
                }
            });
        }
        let e = scene.get_element(id).unwrap();
        if e.is_line() && !is_valid_polygon(pts(e)) {
            scene.mutate_element(id, true, |x| {
                if let Kind::Line { polygon, .. } = &mut x.kind {
                    *polygon = false
                }
            });
        }
    }
    let e = scene.get_element(id).unwrap();
    let next = if e.is_linear() {
        LinearElementEditor::new(id, scene, false)
    } else {
        editor.cloned()
    };
    let next = next.map(|ed| LinearElementEditor {
        is_editing: if ctx.new_element {
            false
        } else {
            ed.is_editing
        },
        initial_state: InitialState {
            last_clicked_point: -1,
            origin: None,
            ..ed.initial_state.clone()
        },
        ..ed
    });
    (should_commit, next)
}

/// `actionToggleLinearEditor`'s predicate: one line or non-elbow arrow
/// selected, its editor closed.
pub fn can_toggle_linear_editor(
    selected: &[&Element],
    editor: Option<&LinearElementEditor>,
) -> bool {
    !editor.is_some_and(|e| e.is_editing)
        && selected.len() == 1
        && selected[0].is_linear()
        && !selected[0].is_elbow_arrow()
}

/// `actionToggleLinearEditor`.
pub fn toggle_linear_editor(editor: &LinearElementEditor) -> LinearElementEditor {
    LinearElementEditor {
        is_editing: !editor.is_editing,
        ..editor.clone()
    }
}

/// `actionTogglePolygon`'s predicate: only lines of 4+ points selected.
pub fn can_toggle_polygon(selected: &[&Element]) -> bool {
    !selected.is_empty() && selected.iter().all(|e| e.is_line() && pts(e).len() >= 4)
}

/// `actionTogglePolygon`: all selected lines become polygons unless all are
/// (then they open up, losing their fill). None if a non-line is selected.
pub fn toggle_polygon(selected: &[&Element]) -> Option<Vec<Element>> {
    if selected.iter().any(|e| !e.is_line()) {
        return None;
    }
    let next = selected.iter().any(|e| !e.is_line_polygon());
    Some(
        selected
            .iter()
            .map(|e| {
                new_element_with(
                    e,
                    |x| {
                        if !next {
                            x.background_color = "transparent".into();
                        }
                        if let Some((poly, np)) = toggle_line_polygon_state(e, next)
                            && let Kind::Line { polygon, linear } = &mut x.kind
                        {
                            *polygon = poly;
                            linear.points = np;
                        }
                    },
                    false,
                )
            })
            .collect(),
    )
}
