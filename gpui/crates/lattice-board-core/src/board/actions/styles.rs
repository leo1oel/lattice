// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionStyles.ts` @ 3a317b5:
//! copy styles (Cmd+Alt+C) and paste styles (Cmd+Alt+V). Upstream keeps the
//! copied elements in a module string; here copying returns them and the app
//! keeps them for pasting. The "styles copied" toast is the app's.

use super::ActionResult;
use crate::board::app_state::AppState;
use crate::board::binding::{BindingHooks, UpdateBoundOpts, update_bound_elements};
use crate::board::consts::{DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE};
use crate::board::elbow::update_elbow_arrow_route;
use crate::board::history::CaptureUpdateAction;
use crate::board::mutate::new_element_with;
use crate::board::new_element::normalize_sticky_note;
use crate::board::selection::{SelectedOpts, get_selected_elements};
use crate::board::sticky::{
    ColorProperty, apply_base_font_size, get_base_font_size, get_color_update,
    is_sticky_note_bound_text, relayout_sticky_notes, sync_sticky_note_ink,
};
use crate::board::text::redraw_text_bounding_box;
use crate::board::text_measure::{Measure, get_line_height};
use crate::board::types::{Element, TextAlign, can_apply_roundness_type, default_roundness_for};
use crate::board::utils::array_to_map;
use rustc_hash::FxHashSet;

/// `actionCopyStyles`: the first selected element (and its label). Empty
/// when nothing is selected (the previous copy stays then).
pub fn action_copy_styles(elements: &[Element], a: &AppState) -> Vec<Element> {
    let Some(e) = elements
        .iter()
        .find(|e| a.selected_element_ids.contains(&e.id))
    else {
        return vec![];
    };
    let mut out = vec![e.clone()];
    if e.has_bound_text()
        && let Some(t) = e
            .bound_text_id()
            .and_then(|id| elements.iter().find(|x| x.id == id && !x.is_deleted))
    {
        out.push(t.clone());
    }
    out
}

/// `actionPasteStyles`: `copied` is what `action_copy_styles` returned.
pub fn action_paste_styles(
    elements: &[Element],
    a: &AppState,
    copied: &[Element],
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let Some(pasted) = copied.first() else {
        return ActionResult::new(
            Some(elements.to_vec()),
            None,
            CaptureUpdateAction::Eventually,
        );
    };
    let bound_text = copied.get(1);
    let selected = get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            ..Default::default()
        },
    );
    let ids: FxHashSet<String> = selected.iter().map(|e| e.id.clone()).collect();
    let map = array_to_map(elements);
    // whether the copied text was a sticky label is decided by the copy
    let copied_map = array_to_map(copied);
    let mut redraw: Vec<(String, Option<String>)> = vec![];
    let styled: Vec<Element> = elements
        .iter()
        .map(|e| {
            if !ids.contains(&e.id) {
                return e.clone();
            }
            let Some(src) = (if e.is_text() && e.container_id().is_some() {
                bound_text
            } else {
                Some(pasted)
            }) else {
                return e.clone();
            };
            let mut n = new_element_with(
                e,
                |n| {
                    n.background_color = src.background_color.clone();
                    n.stroke_width = src.stroke_width;
                    n.stroke_color = src.stroke_color.clone();
                    n.stroke_style = src.stroke_style;
                    n.fill_style = src.fill_style;
                    n.opacity = src.opacity;
                    n.roughness = src.roughness;
                    n.roundness = src
                        .roundness
                        .map(|r| {
                            if can_apply_roundness_type(r.kind, n.ty()) {
                                Some(r)
                            } else {
                                default_roundness_for(n.ty())
                            }
                        })
                        .unwrap_or(None);
                },
                false,
            );
            if n.is_text() {
                let font_size = if src.is_text() {
                    get_base_font_size(src, &copied_map)
                } else {
                    0.
                };
                let font_size = if font_size == 0. {
                    DEFAULT_FONT_SIZE
                } else {
                    font_size
                };
                let st = src.text();
                let family = st
                    .map(|t| t.font_family)
                    .filter(|&f| f != 0)
                    .unwrap_or(DEFAULT_FONT_FAMILY);
                let align = st.map_or(TextAlign::Left, |t| t.text_align);
                let lh = st
                    .map(|t| t.line_height)
                    .filter(|&l| l != 0.)
                    .unwrap_or_else(|| get_line_height(family));
                n = new_element_with(
                    &n,
                    |t| {
                        apply_base_font_size(t, font_size, &map);
                        if let Some(d) = t.text_mut() {
                            d.font_family = family;
                            d.text_align = align;
                            d.line_height = lh;
                        }
                    },
                    false,
                );
                if is_sticky_note_bound_text(&n, &map) {
                    // the copied stroke may be transparent; a note's label never is
                    let (_, c) =
                        get_color_update(&n, ColorProperty::Stroke, &n.stroke_color.clone(), &map);
                    n = new_element_with(&n, |t| t.stroke_color = c, false);
                } else {
                    let container = n
                        .container_id()
                        .filter(|c| ids.contains(*c))
                        .map(String::from);
                    redraw.push((n.id.clone(), container));
                }
            }
            if n.is_arrow()
                && let Some(sl) = src.linear().filter(|_| src.is_arrow())
            {
                let (sa, ea) = (sl.start_arrowhead, sl.end_arrowhead);
                n = new_element_with(
                    &n,
                    |x| {
                        if let Some(l) = x.linear_mut() {
                            l.start_arrowhead = sa;
                            l.end_arrowhead = ea;
                        }
                    },
                    false,
                );
                if n.is_elbow_arrow() {
                    let u = update_elbow_arrow_route(&n, &map);
                    n = new_element_with(&n, |x| u.apply(x), false);
                }
            }
            if e.is_frame_like() {
                n = new_element_with(
                    &n,
                    |x| {
                        x.roundness = None;
                        x.background_color = "transparent".into();
                    },
                    false,
                );
            }
            if n.is_sticky_note() {
                n = normalize_sticky_note(&n);
            }
            n
        })
        .collect();
    // restyled text that isn't a sticky label is laid out again
    let mut styled = styled;
    for (id, container) in redraw {
        let Some(t) = styled.iter().find(|e| e.id == id).cloned() else {
            continue;
        };
        redraw_text_bounding_box(&mut styled, &t, container.as_deref(), m);
    }
    // a restyled note and its label end up with one ink, then are laid out together
    let inked = sync_sticky_note_ink(&styled, &map).unwrap_or(styled);
    let mut next = relayout_sticky_notes(&inked, &ids, Some(&map), m);
    // a restyled note may have grown or shrunk: arrows bound to it follow
    let moved: Vec<String> = next
        .iter()
        .filter(|e| {
            e.is_sticky_note()
                && !e.is_deleted
                && map
                    .get(e.id.as_str())
                    .is_some_and(|p| p.height != e.height || p.x != e.x || p.y != e.y)
        })
        .map(|e| e.id.clone())
        .collect();
    for id in moved {
        update_bound_elements(&id, &mut next, &UpdateBoundOpts::default(), hooks);
    }
    ActionResult::new(Some(next), None, CaptureUpdateAction::Immediately)
}
