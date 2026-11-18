// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionCanvas.tsx` @ 3a317b5:
//! background color, clear canvas, and the zoom actions over `viewport.rs`.
//! `actionNavigate` (go to a collaborator) and `toggleTheme` are left out:
//! no collaboration, and the theme is the app's. Image caches, files and
//! "unfollow" are the app's.

use super::{ActionResult, update_active_tool};
use crate::board::app_state::{AppState, ToolType};
use crate::board::bounds::{Bounds, get_common_bounds};
use crate::board::history::CaptureUpdateAction;
use crate::board::mutate::new_element_with;
use crate::board::selection::{SelectedOpts, get_selected_elements};
use crate::board::types::Element;
use crate::board::utils::array_to_map;
use crate::board::viewport::*;

/// `actionChangeViewBackgroundColor`.
pub fn action_change_view_background_color(a: &AppState, color: &str) -> ActionResult {
    ActionResult::new(
        None,
        Some(AppState {
            view_background_color: color.into(),
            ..a.clone()
        }),
        CaptureUpdateAction::Immediately,
    )
}

/// `actionClearCanvas`: everything deleted, the app state back to defaults
/// except the grid (the image tool falls back to selection).
pub fn action_clear_canvas(elements: &[Element], a: &AppState) -> ActionResult {
    let next = elements
        .iter()
        .map(|e| new_element_with(e, |n| n.is_deleted = true, false))
        .collect();
    let active_tool = if a.active_tool.ty == ToolType::Image {
        update_active_tool(a, a.preferred_selection_tool.ty)
    } else {
        a.active_tool.clone()
    };
    let app = AppState {
        grid_size: a.grid_size,
        grid_step: a.grid_step,
        grid_mode_enabled: a.grid_mode_enabled,
        active_tool,
        ..AppState::default()
    };
    ActionResult::new(Some(next), Some(app), CaptureUpdateAction::Immediately)
}

fn with_viewport(a: &AppState, v: Viewport) -> ActionResult {
    let mut app = a.clone();
    app.set_viewport(v);
    ActionResult::new(None, Some(app), CaptureUpdateAction::Eventually)
}

/// `actionZoomIn`. `anchor`: the viewport point kept in place (default: the
/// canvas center).
pub fn action_zoom_in(
    a: &AppState,
    c: Canvas,
    anchor: Option<[f64; 2]>,
    constraints: Option<&ScrollConstraints>,
) -> ActionResult {
    with_viewport(a, zoom_in(a.viewport(), c, anchor, constraints))
}
/// `actionZoomOut`.
pub fn action_zoom_out(
    a: &AppState,
    c: Canvas,
    anchor: Option<[f64; 2]>,
    constraints: Option<&ScrollConstraints>,
) -> ActionResult {
    with_viewport(a, zoom_out(a.viewport(), c, anchor, constraints))
}
/// `actionResetZoom`.
pub fn action_reset_zoom(
    a: &AppState,
    c: Canvas,
    anchor: Option<[f64; 2]>,
    constraints: Option<&ScrollConstraints>,
) -> ActionResult {
    with_viewport(a, reset_zoom(a.viewport(), c, anchor, constraints))
}

/// What zoom to fit fits: the selection (if `selection` and any), the lock
/// box, or all elements.
fn fit_bounds(
    elements: &[Element],
    a: &AppState,
    selection: bool,
    constraints: Option<&ScrollConstraints>,
) -> Bounds {
    let map = array_to_map(elements);
    let sel = if selection {
        get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default())
    } else {
        vec![]
    };
    if !sel.is_empty() {
        return get_common_bounds(sel, &map);
    }
    if let Some(sc) = constraints {
        return scroll_constraints_bounds(sc);
    }
    get_common_bounds(elements.iter().filter(|e| !e.is_deleted), &map)
}

/// `actionZoomToFitSelectionInViewport` (never past 100%).
pub fn action_zoom_to_fit_selection_in_viewport(
    elements: &[Element],
    a: &AppState,
    c: Canvas,
    offsets: Option<Offsets>,
    constraints: Option<&ScrollConstraints>,
) -> ActionResult {
    with_viewport(
        a,
        zoom_to_fit(
            fit_bounds(elements, a, true, constraints),
            Fit::ScaleDown,
            a.viewport(),
            c,
            offsets,
            constraints,
        ),
    )
}
/// `actionZoomToFitSelection` (Shift+3).
pub fn action_zoom_to_fit_selection(
    elements: &[Element],
    a: &AppState,
    c: Canvas,
    offsets: Option<Offsets>,
    constraints: Option<&ScrollConstraints>,
) -> ActionResult {
    with_viewport(
        a,
        zoom_to_fit(
            fit_bounds(elements, a, true, constraints),
            Fit::Contain,
            a.viewport(),
            c,
            offsets,
            constraints,
        ),
    )
}
/// `actionZoomToFit` (Shift+1).
pub fn action_zoom_to_fit(
    elements: &[Element],
    a: &AppState,
    c: Canvas,
    offsets: Option<Offsets>,
    constraints: Option<&ScrollConstraints>,
) -> ActionResult {
    with_viewport(
        a,
        zoom_to_fit(
            fit_bounds(elements, a, false, constraints),
            Fit::ScaleDown,
            a.viewport(),
            c,
            offsets,
            constraints,
        ),
    )
}
