// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Flipping. Port of Excalidraw `packages/excalidraw/actions/actionFlip.ts`
//! @ 3a317b5: `flipSelectedElements` / `flipElements` (the shortcuts,
//! Shift+H and Shift+V, are the app's).

use super::ActionResult;
use crate::board::app_state::AppState;
use crate::board::binding::{
    BindingCtx, BindingHooks, ElbowUpdate, bind_or_unbind_binding_elements,
};
use crate::board::bounds::get_common_bounding_box;
use crate::board::frame::{FrameState, update_frame_membership_of_selected_elements};
use crate::board::handles::HandleType;
use crate::board::history::CaptureUpdateAction;
use crate::board::mutate::new_element_with;
use crate::board::resize::{MultiOpts, resize_multiple_elements};
use crate::board::scene::Scene;
use crate::board::selection::{SelectedOpts, get_selected_elements};
use crate::board::text_measure::Measure;
use crate::board::types::Element;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlipDirection {
    Horizontal,
    Vertical,
}

/// `flipElements`: arrows that are all bound swap their arrowheads; anything
/// else is mirrored around the selection's center (as a centered,
/// proportional resize with a flip), re-binds its arrows, and is moved back
/// so repeated flips don't drift. Changes `scene`.
pub fn flip_elements(
    ids: &[String],
    scene: &mut Scene,
    dir: FlipDirection,
    ctx: &BindingCtx,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) {
    let selected: Vec<Element> = ids
        .iter()
        .filter_map(|id| scene.get_non_deleted_element(id).cloned())
        .collect();
    if selected.iter().all(|e| {
        e.is_arrow()
            && e.linear()
                .is_some_and(|l| l.start_binding.is_some() || l.end_binding.is_some())
    }) {
        for e in &selected {
            let mut flipped = new_element_with(
                e,
                |n| {
                    if let Some(l) = n.linear_mut() {
                        std::mem::swap(&mut l.start_arrowhead, &mut l.end_arrowhead);
                    }
                },
                false,
            );
            if flipped.is_elbow_arrow() {
                // `updateElbowArrowRoute`
                let p = flipped.points().unwrap_or(&[]);
                let u = ElbowUpdate {
                    points: Some(vec![p[0], p[p.len() - 1]]),
                    ..Default::default()
                };
                let route =
                    hooks.update_elbow_arrow_points(&flipped, scene, &u, &Default::default());
                flipped = new_element_with(&flipped, |n| route.apply(n), false);
            }
            scene.map_elements(|x| (x.id == flipped.id).then(|| flipped.clone()));
        }
        return;
    }
    let bb = get_common_bounding_box(selected.iter(), &*scene);
    let original: Vec<Element> = scene.non_deleted_elements().cloned().collect();
    let o = MultiOpts {
        flip_by_x: dir == FlipDirection::Horizontal,
        flip_by_y: dir == FlipDirection::Vertical,
        resize_from_center: true,
        maintain_aspect_ratio: true,
        ..Default::default()
    };
    resize_multiple_elements(ids, HandleType::Nw, scene, &original, &o, m, hooks);
    let arrows: Vec<String> = ids
        .iter()
        .filter(|id| scene.get_element(id).is_some_and(|e| e.is_arrow()))
        .cloned()
        .collect();
    bind_or_unbind_binding_elements(&arrows, scene, ctx);
    // arrows bumping against the selection's "wall" move it: center it back
    let latest: Vec<Element> = ids
        .iter()
        .filter_map(|id| scene.get_element(id).cloned())
        .collect();
    let nb = get_common_bounding_box(latest.iter(), &*scene);
    let (dx, dy) = (bb.mid_x - nb.mid_x, bb.mid_y - nb.mid_y);
    // the others first, then the elbow arrows (as upstream)
    for elbow in [false, true] {
        for e in latest.iter().filter(|e| e.is_elbow_arrow() == elbow) {
            let (x, y) = (e.x + dx, e.y + dy);
            scene.mutate_element(&e.id, true, |n| (n.x, n.y) = (x, y));
        }
    }
}

/// `flipSelectedElements` + `updateFrameMembershipOfSelectedElements`.
fn flip_selected(
    elements: &[Element],
    a: &AppState,
    dir: FlipDirection,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let ids: Vec<String> = get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            include_elements_in_frames: true,
        },
    )
    .into_iter()
    .map(|e| e.id.clone())
    .collect();
    let mut scene = Scene::new(elements.to_vec());
    let ctx = BindingCtx {
        hooks,
        ..BindingCtx::from_app(a)
    };
    flip_elements(&ids, &mut scene, dir, &ctx, m, hooks);
    let mut next = scene.into_elements();
    update_frame_membership_of_selected_elements(&mut next, &FrameState::new(a, false));
    ActionResult::new(
        Some(next),
        Some(a.clone()),
        CaptureUpdateAction::Immediately,
    )
}

/// `actionFlipHorizontal`.
pub fn action_flip_horizontal(
    elements: &[Element],
    a: &AppState,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    flip_selected(elements, a, FlipDirection::Horizontal, m, hooks)
}
/// `actionFlipVertical`.
pub fn action_flip_vertical(
    elements: &[Element],
    a: &AppState,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    flip_selected(elements, a, FlipDirection::Vertical, m, hooks)
}
