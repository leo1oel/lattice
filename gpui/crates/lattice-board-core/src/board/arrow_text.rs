// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Text bound to an arrow endpoint: a text element that reads as a label for
//! the tip of an arrow, placed and anchored so the arrow never moves. Port of
//! Excalidraw `element/src/arrowEndpointText.ts` @ 3a317b5. The hover and
//! creation gestures (`App.arrowText.ts`) belong to the app's text tool.

use super::binding::{get_binding_gap, normalize_fixed_point};
use super::bounds::{POINT_HANDLE_SIZE, get_point_at_index_global_coordinates};
use super::heading::*;
use super::math::*;
use super::new_element::get_text_anchor_ratios;
use super::types::{Element, StartOrEnd, TextAlign, VerticalAlign};
use super::utils::ElementsMap;

/// `ArrowEndpoint`.
#[derive(Clone, Debug, PartialEq)]
pub struct ArrowEndpoint {
    pub arrow: String,
    pub start_or_end: StartOrEnd,
}

fn idx(s: StartOrEnd, n: usize) -> (usize, usize) {
    if s == StartOrEnd::Start {
        (0, 1)
    } else {
        (n - 1, n - 2)
    }
}

/// `getUnboundArrowEndpointAtPoint`: a free arrow endpoint under the cursor,
/// front-most first, the end before the start. `elements` in z-order.
pub fn get_unbound_arrow_endpoint_at_point(
    pointer: Point,
    elements: &[Element],
    map: &dyn ElementsMap,
    zoom: f64,
) -> Option<ArrowEndpoint> {
    for e in elements.iter().rev() {
        if e.is_deleted || !e.is_arrow() || e.locked {
            continue;
        }
        let (Some(l), Some(pts)) = (e.linear(), e.points()) else {
            continue;
        };
        if pts.len() < 2 {
            continue;
        }
        for s in [StartOrEnd::End, StartOrEnd::Start] {
            if (if s == StartOrEnd::Start {
                &l.start_binding
            } else {
                &l.end_binding
            })
            .is_some()
            {
                continue;
            }
            // a zero-length tail has no direction to place a text along
            let (i, j) = idx(s, pts.len());
            if points_equal(pts[i], pts[j], PRECISION) {
                continue;
            }
            let p = get_point_at_index_global_coordinates(e, i as isize, map);
            // the reach of a point handle in the linear editor
            if point_distance(pointer, p) * zoom < POINT_HANDLE_SIZE + 1. {
                return Some(ArrowEndpoint {
                    arrow: e.id.clone(),
                    start_or_end: s,
                });
            }
        }
    }
    None
}

/// `getTextBindingForArrowEndpoint`'s result.
#[derive(Clone, Debug, PartialEq)]
pub struct EndpointTextBinding {
    /// The text-local ratio the arrow binds to (a side midpoint).
    pub fixed_point: [f64; 2],
    pub text_align: TextAlign,
    pub vertical_align: VerticalAlign,
    /// Where the text's bound side midpoint goes.
    pub anchor: Point,
}

/// `getTextBindingForArrowEndpoint`: how to create a text so that it labels
/// the endpoint. The arrow stays: the text's side the arrow points at goes
/// to the tip (a binding gap back along the arrow), and the alignment pins
/// that side while the text is typed. `target_stroke_width` is the text's
/// (the gap comes from the bind target). None for a zero-length tail.
pub fn get_text_binding_for_arrow_endpoint(
    arrow: &Element,
    s: StartOrEnd,
    map: &dyn ElementsMap,
    target_stroke_width: f64,
) -> Option<EndpointTextBinding> {
    let (a, b) = if s == StartOrEnd::Start {
        (0, 1)
    } else {
        (-1, -2)
    };
    let endpoint = get_point_at_index_global_coordinates(arrow, a, map);
    let neighbor = get_point_at_index_global_coordinates(arrow, b, map);
    if points_equal(endpoint, neighbor, PRECISION) {
        return None;
    }
    // the travel direction at the tip on its dominant axis, ties horizontal
    // (not `vector_to_heading`, whose 45° tie-break can point backwards)
    let d = vector_from_point(endpoint, neighbor);
    let heading = if d[0].abs() >= d[1].abs() {
        if d[0] >= 0. {
            HEADING_RIGHT
        } else {
            HEADING_LEFT
        }
    } else if d[1] >= 0. {
        HEADING_DOWN
    } else {
        HEADING_UP
    };
    // must match the gap `update_bound_point` resolves with; elbow arrows end
    // on the fixed point itself
    let gap = if arrow.is_elbow_arrow() {
        0.
    } else {
        get_binding_gap(target_stroke_width)
    };
    // back along the arrow (not along the side's normal), so the orbit
    // intersection lands on the tip; the divisor is >= cos 45°
    let away = vector_normalize(vector_from_point(neighbor, endpoint));
    let along = vector_dot(away, heading).abs();
    let anchor = point_from_vector(vector_scale(away, -gap / along), endpoint);
    let (fixed, text_align, vertical_align) = if compare_heading(heading, HEADING_RIGHT) {
        ([0., 0.5], TextAlign::Left, VerticalAlign::Middle)
    } else if compare_heading(heading, HEADING_LEFT) {
        ([1., 0.5], TextAlign::Right, VerticalAlign::Middle)
    } else if compare_heading(heading, HEADING_DOWN) {
        ([0.5, 0.], TextAlign::Center, VerticalAlign::Top)
    } else {
        ([0.5, 1.], TextAlign::Center, VerticalAlign::Bottom)
    };
    Some(EndpointTextBinding {
        fixed_point: normalize_fixed_point(Some(fixed)),
        text_align,
        vertical_align,
        anchor,
    })
}

/// `isEndpointBoundText`: an arrow end is bound to this text (checked on the
/// arrows' bindings, the authoritative side).
pub fn is_endpoint_bound_text(text: &Element, map: &dyn ElementsMap) -> bool {
    text.bound_elements.iter().flatten().any(|b| {
        b.kind == super::types::BoundType::Arrow
            && map
                .get_element(&b.id)
                .filter(|a| a.is_arrow())
                .and_then(|a| a.linear())
                .is_some_and(|l| {
                    l.start_binding
                        .as_ref()
                        .is_some_and(|x| x.element_id == text.id)
                        || l.end_binding
                            .as_ref()
                            .is_some_and(|x| x.element_id == text.id)
                })
    })
}

/// `getEndpointBoundTextDragAnchor`: (anchor ratio, anchor x) a text bound to
/// an arrow endpoint grows away from.
pub fn get_endpoint_bound_text_drag_anchor(text: &Element) -> (f64, f64) {
    let t = text.text().expect("a text element");
    let r = get_text_anchor_ratios(t.text_align, t.vertical_align).0;
    (r, text.x + text.width * r)
}
