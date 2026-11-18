// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The lasso selection. Port of Excalidraw `packages/excalidraw/lasso/utils.ts`
//! (`getLassoSelectedElementIds` and its frame clipping, enclosure and
//! intersection tests) and the selection half of `lasso/index.ts`
//! (`LassoTrail`) @ 3a317b5. The animated trail is the app's to draw (from
//! `LassoTrail::points`); `boxSelectionMode` isn't in our `AppState`, so it's
//! passed in.

use super::bounds::*;
use super::collision::intersect_element_with_line_segment;
use super::frame::get_frame_children;
use super::groups::select_groups_for_selected_elements;
use super::math::*;
use super::shape::simplify;
use super::text::compute_bound_text_position;
use super::types::Element;
use super::utils::{ElementsMap, array_to_map};
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::{BTreeMap, BTreeSet};

/// `BoxSelectionMode`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BoxSelectionMode {
    #[default]
    Contain,
    Overlap,
}

/// `ElementsSegmentsMap`: element id → its outline segments.
pub type ElementsSegments = FxHashMap<String, Vec<Segment>>;

/// The segments of each element (`getElementLineSegments`).
pub fn elements_segments(elements: &[Element], map: &dyn ElementsMap) -> ElementsSegments {
    elements
        .iter()
        .map(|e| (e.id.clone(), get_element_line_segments(e, map)))
        .collect()
}

/// `getLassoSelectedElementIds`' input.
pub struct LassoQuery<'a> {
    pub lasso_path: &'a [Point],
    /// The candidates (upstream: the visible elements), in z-order.
    pub elements: &'a [Element],
    /// The non-deleted scene (group membership is judged against it).
    pub scene: &'a [Element],
    pub map: &'a dyn ElementsMap,
    pub segments: &'a ElementsSegments,
    pub simplify_distance: Option<f64>,
    pub mode: BoxSelectionMode,
}

/// `getLassoSelectedElementIds`.
pub fn get_lasso_selected_element_ids(q: &LassoQuery) -> Vec<String> {
    let path: Vec<Point> = match q.simplify_distance {
        Some(d) if d != 0. => simplify(q.lasso_path, d),
        _ => q.lasso_path.to_vec(),
    };
    if q.lasso_path.is_empty() {
        return vec![];
    }
    let mut enclosed: Vec<String> = vec![];
    let mut intersected: Vec<String> = vec![];
    let lasso_bounds = q.lasso_path.iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |a, p| {
            [
                a[0].min(p[0]),
                a[1].min(p[1]),
                a[2].max(p[0]),
                a[3].max(p[1]),
            ]
        },
    );
    let polygon = polygon_from_points(&path);
    let contain_bounds = [
        lasso_bounds[0] - PRECISION,
        lasso_bounds[1] - PRECISION,
        lasso_bounds[2] + PRECISION,
        lasso_bounds[3] + PRECISION,
    ];
    // bound text is never selected on its own, its container covers it
    for e in q
        .elements
        .iter()
        .filter(|e| !e.locked && !e.is_bound_to_container())
    {
        let bounds = get_element_bounds(e, q.map, false);
        let clip = get_frame_clip_bounds(e, bounds, q.map);
        let eb = clip_to_bounds(bounds, clip);
        if !do_bounds_intersect(Some(lasso_bounds), Some(eb))
            || intersected.contains(&e.id)
            || enclosed.contains(&e.id)
        {
            continue;
        }
        if q.mode == BoxSelectionMode::Contain && !bounds_contain_bounds(contain_bounds, eb) {
            continue;
        }
        let segments = get_selection_segments(e, q.map, q.segments, clip);
        let is_enclosed = enclosure_test(&polygon, &segments, eb, q.mode);
        if q.mode == BoxSelectionMode::Contain {
            if is_enclosed && !intersection_test(&path, e, q.map, clip) {
                enclosed.push(e.id.clone());
            }
        } else if is_enclosed {
            enclosed.push(e.id.clone());
        } else if intersection_test(&path, e, q.map, clip) {
            intersected.push(e.id.clone());
        }
    }
    if q.mode == BoxSelectionMode::Contain {
        exclude_incomplete_groups(enclosed, q.scene)
    } else {
        intersected.into_iter().chain(enclosed).collect()
    }
}

/// `getFrameClipBounds`: the bounds of the frame clipping the element, None
/// when nothing of it is clipped.
fn get_frame_clip_bounds(e: &Element, eb: Bounds, map: &dyn ElementsMap) -> Option<Bounds> {
    let frame = get_containing_frame(e, map)?;
    if !is_frame_clippable(e, map) {
        return None;
    }
    let fb = get_element_bounds(frame, map, false);
    if bounds_contain_bounds(fb, eb) {
        return None;
    }
    element_overlaps_with_frame(e, frame, map).then_some(fb)
}

fn clip_to_bounds(b: Bounds, clip: Option<Bounds>) -> Bounds {
    match clip {
        Some(c) => [
            b[0].max(c[0]),
            b[1].max(c[1]),
            b[2].min(c[2]),
            b[3].min(c[3]),
        ],
        None => b,
    }
}

/// `getSelectionSegments`: the element's outline with its label's, clipped
/// to its frame.
fn get_selection_segments(
    e: &Element,
    map: &dyn ElementsMap,
    segs: &ElementsSegments,
    clip: Option<Bounds>,
) -> Vec<Segment> {
    let mut out = segs.get(&e.id).cloned().unwrap_or_default();
    if let Some(t) = get_bound_text_element(e, map)
        && let Some(ts) = segs.get(&t.id)
    {
        out.extend_from_slice(ts);
    }
    match clip {
        Some(c) => clip_segments_to_bounds(&out, c),
        None => out,
    }
}

/// `clipSegmentsToBounds` (Liang-Barsky).
fn clip_segments_to_bounds(
    segments: &[Segment],
    [min_x, min_y, max_x, max_y]: Bounds,
) -> Vec<Segment> {
    let mut out = vec![];
    'seg: for &[[x1, y1], [x2, y2]] in segments {
        let (dx, dy) = (x2 - x1, y2 - y1);
        let (mut t0, mut t1) = (0f64, 1f64);
        for (p, q) in [
            (-dx, x1 - min_x),
            (dx, max_x - x1),
            (-dy, y1 - min_y),
            (dy, max_y - y1),
        ] {
            if p == 0. {
                if q < 0. {
                    continue 'seg;
                }
                continue;
            }
            let t = q / p;
            if p < 0. {
                if t > t1 {
                    continue 'seg;
                }
                t0 = t0.max(t);
            } else {
                if t < t0 {
                    continue 'seg;
                }
                t1 = t1.min(t);
            }
        }
        out.push([[x1 + t0 * dx, y1 + t0 * dy], [x1 + t1 * dx, y1 + t1 * dy]]);
    }
    out
}

/// `excludeIncompleteGroups`: in contain mode a group counts only when all
/// its (selectable) members are enclosed.
fn exclude_incomplete_groups(ids: Vec<String>, elements: &[Element]) -> Vec<String> {
    let by_id: FxHashMap<&str, &Element> = elements.iter().map(|e| (e.id.as_str(), e)).collect();
    if !ids.iter().any(|id| {
        by_id
            .get(id.as_str())
            .is_some_and(|e| !e.group_ids.is_empty())
    }) {
        return ids;
    }
    let mut groups: FxHashMap<&str, Vec<&str>> = FxHashMap::default();
    for e in elements {
        let Some(g) = e.group_ids.last() else {
            continue;
        };
        if e.locked || e.is_bound_to_container() {
            continue;
        }
        groups.entry(g).or_default().push(&e.id);
    }
    if groups.is_empty() {
        return ids;
    }
    let selected: FxHashSet<&str> = ids.iter().map(String::as_str).collect();
    ids.iter()
        .filter(|id| {
            let g = by_id
                .get(id.as_str())
                .and_then(|e| e.group_ids.last())
                .and_then(|g| groups.get(g.as_str()));
            g.is_none_or(|g| g.iter().all(|m| selected.contains(m)))
        })
        .cloned()
        .collect()
}

fn enclosure_test(
    polygon: &[Point],
    segments: &[Segment],
    eb: Bounds,
    mode: BoxSelectionMode,
) -> bool {
    let includes = |p: &Point| {
        polygon_includes_point_non_zero(*p, polygon)
            || (mode == BoxSelectionMode::Contain && is_point_on_polygon(*p, polygon))
    };
    // elements without an outline (a freedraw dot) go by their box corners
    if segments.is_empty() {
        let c = [
            [eb[0], eb[1]],
            [eb[2], eb[1]],
            [eb[2], eb[3]],
            [eb[0], eb[3]],
        ];
        return if mode == BoxSelectionMode::Contain {
            c.iter().all(includes)
        } else {
            c.iter().any(includes)
        };
    }
    if mode == BoxSelectionMode::Contain {
        segments.iter().all(|s| s.iter().all(includes))
    } else {
        segments.iter().any(|s| s.iter().any(includes))
    }
}

fn is_point_on_polygon(p: Point, polygon: &[Point]) -> bool {
    polygon
        .windows(2)
        .any(|w| point_on_line_segment(p, [w[0], w[1]], PRECISION))
}

fn intersection_test(
    path: &[Point],
    e: &Element,
    map: &dyn ElementsMap,
    clip: Option<Bounds>,
) -> bool {
    if path.is_empty() {
        return false;
    }
    let mut lasso: Vec<Segment> = path.windows(2).map(|w| [w[0], w[1]]).collect();
    lasso.push([path[path.len() - 1], path[0]]);
    let label = get_bound_text_element(e, map).map(|t| {
        let mut t = t.clone();
        [t.x, t.y] = compute_bound_text_position(e, &t, map);
        t
    });
    // hits on the part clipped away by the frame are invisible
    let hits = |target: &Element, s: Segment| {
        let h = intersect_element_with_line_segment(target, map, s, 0., clip.is_none());
        match clip {
            Some(c) => h.iter().any(|p| point_inside_bounds_inclusive(*p, c)),
            None => !h.is_empty(),
        }
    };
    lasso
        .iter()
        .any(|&s| hits(e, s) || label.as_ref().is_some_and(|t| hits(t, s)))
}

// ---------------------------------------------------------------------------
// the trail (lasso/index.ts)
// ---------------------------------------------------------------------------

/// What the lasso selects: element ids and group ids, plus the linear
/// element to edit when a lone line / arrow is selected.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LassoSelection {
    pub selected_element_ids: BTreeSet<String>,
    pub selected_group_ids: BTreeMap<String, bool>,
    pub selected_linear_element: Option<String>,
}

/// `LassoTrail` minus drawing: the path, the segment cache (rebuilt when the
/// view moves) and the selection rules.
#[derive(Clone, Debug, Default)]
pub struct LassoTrail {
    /// The path as drawn (`originalPoints`), scene coordinates.
    pub points: Vec<Point>,
    segments: Option<ElementsSegments>,
    view: Option<(f64, f64, f64)>,
    pub keep_previous_selection: bool,
}

impl LassoTrail {
    /// `startPath`. Returns whether the selection is to be cleared (when not
    /// keeping it).
    pub fn start_path(&mut self, x: f64, y: f64, keep_previous_selection: bool) -> bool {
        self.end_path();
        self.points.push([x, y]);
        self.keep_previous_selection = keep_previous_selection;
        !keep_previous_selection
    }

    /// `addPointToPath` + `updateSelection`: the selection after adding the
    /// point. `visible`: the visible elements (upstream `app.visibleElements`),
    /// `all`: the non-deleted scene, `prev`: the selection before the lasso.
    pub fn add_point_to_path(
        &mut self,
        x: f64,
        y: f64,
        keep_previous_selection: bool,
        visible: &[Element],
        all: &[Element],
        view: (f64, f64, f64),
        mode: BoxSelectionMode,
        prev: &BTreeSet<String>,
        editing_group_id: Option<&str>,
    ) -> LassoSelection {
        self.points.push([x, y]);
        self.keep_previous_selection = keep_previous_selection;
        if self.segments.is_none() || self.view != Some(view) {
            self.view = Some(view);
            self.segments = Some(elements_segments(visible, &array_to_map(visible)));
        }
        let map = array_to_map(all);
        let ids = get_lasso_selected_element_ids(&LassoQuery {
            lasso_path: &self.points,
            elements: visible,
            scene: all,
            map: &map,
            segments: self.segments.as_ref().unwrap(),
            simplify_distance: Some(5. / view.2),
            mode,
        });
        self.select_elements_from_ids(&ids, all, prev, editing_group_id)
    }

    /// `selectElementsFromIds`: the ids (plus the previous selection when
    /// keeping it), minus children of selected frames, with their groups.
    pub fn select_elements_from_ids(
        &self,
        ids: &[String],
        all: &[Element],
        prev: &BTreeSet<String>,
        editing_group_id: Option<&str>,
    ) -> LassoSelection {
        let mut next: BTreeSet<String> = ids.iter().cloned().collect();
        if self.keep_previous_selection {
            next.extend(prev.iter().cloned());
        }
        let frames: Vec<String> = next
            .iter()
            .filter(|id| {
                all.iter()
                    .any(|e| &e.id == *id && !e.is_deleted && e.is_frame_like())
            })
            .cloned()
            .collect();
        for f in &frames {
            for c in get_frame_children(all, f)
                .into_iter()
                .filter(|e| !e.is_deleted)
            {
                next.remove(&c.id);
            }
        }
        let g = select_groups_for_selected_elements(&next, editing_group_id, all);
        let (selected_element_ids, selected_group_ids) =
            (g.selected_element_ids, g.selected_group_ids);
        let selected_linear_element = (selected_element_ids.len() == 1
            && selected_group_ids.is_empty())
        .then(|| selected_element_ids.iter().next().unwrap())
        .filter(|id| {
            all.iter()
                .any(|e| &&e.id == id && !e.is_deleted && e.is_linear())
        })
        .cloned();
        LassoSelection {
            selected_element_ids,
            selected_group_ids,
            selected_linear_element,
        }
    }

    /// `endPath`.
    pub fn end_path(&mut self) {
        self.points.clear();
        self.segments = None;
        self.view = None;
    }
}
