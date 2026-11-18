// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionProperties.tsx` and
//! `colorTargets.ts` @ 3a317b5: the properties panel's element changes —
//! stroke / background color, fill style, stroke width and style, roughness
//! (kept in the file, not drawn), freedraw mode, opacity, font size (set,
//! bigger, smaller), font family, text align, vertical align, edges, arrowheads
//! and arrow type — plus `getFormValue`, what the panel shows.
//!
//! Text changes re-lay out the text after the change is in the element list
//! (upstream lays out the uncommitted copy against the scene; same result).
//! Left to the app: palettes, top picks and the picker UI (`ColorTarget`
//! keeps only the kind and the defaults a pick writes), the bucket-fill color
//! (the tool isn't ported), the font family hover preview's restore of the
//! cached elements (`resetAll`, the app keeps the pre-hover elements), font
//! loading (we measure synchronously).

use super::ActionResult;
use crate::board::app_state::{
    AppState, ArrowType, SelectedLinearElement, StrokeRoundness, StrokeWidthKey, ToolType,
};
use crate::board::binding::{
    BindingHooks, UpdateBoundOpts, bind_binding_element, binding_of,
    calculate_fixed_point_for_elbow_arrow_binding, update_bound_elements,
};
use crate::board::binding::{ElbowOptions, ElbowUpdate};
use crate::board::bounds::{get_point_at_index_global_coordinates, point_from_absolute_coords};
use crate::board::elbow::{update_elbow_arrow_points, update_elbow_arrow_route};
use crate::board::history::CaptureUpdateAction;
use crate::board::mutate::new_element_with;
use crate::board::new_element::normalize_sticky_note;
use crate::board::random::random_integer;
use crate::board::selection::{SelectedOpts, get_selected_elements, is_some_element_selected};
use crate::board::shape::toggle_line_polygon_state;
use crate::board::sticky::*;
use crate::board::text::redraw_text_bounding_box;
use crate::board::text_measure::{Measure, get_line_height};
use crate::board::types::*;
use crate::board::utils::{
    array_to_map, has_background, has_fill_style, has_stroke_color, is_transparent,
};
use rustc_hash::FxHashSet;

/// `FONT_SIZE_RELATIVE_INCREASE_STEP`.
pub const FONT_SIZE_RELATIVE_INCREASE_STEP: f64 = 0.1;

/// `changeProperty`: `f` on the selected elements (and the edited text),
/// sticky notes re-normalized.
pub fn change_property(
    elements: &[Element],
    a: &AppState,
    include_bound_text: bool,
    mut f: impl FnMut(&Element) -> Element,
) -> Vec<Element> {
    let ids: FxHashSet<&str> = get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: include_bound_text,
            ..Default::default()
        },
    )
    .into_iter()
    .map(|e| e.id.as_str())
    .collect();
    elements
        .iter()
        .map(|e| {
            if !ids.contains(e.id.as_str()) && a.editing_text_element.as_deref() != Some(&e.id) {
                return e.clone();
            }
            let n = f(e);
            if n.is_sticky_note() {
                normalize_sticky_note(&n)
            } else {
                n
            }
        })
        .collect()
}

/// `reduceToCommonValue`: the value all share, if any.
pub fn reduce_to_common_value<T: PartialEq>(
    values: impl IntoIterator<Item = Option<T>>,
) -> Option<T> {
    let mut common: Option<T> = None;
    for v in values {
        match (v, &common) {
            (Some(v), None) => common = Some(v),
            (Some(v), Some(c)) if v == *c => {}
            _ => return None,
        }
    }
    common
}

/// `getFormValue`: the edited text's value, else the value the (matching)
/// selected elements share, else `default(has_selection)`.
pub fn get_form_value<T: PartialEq>(
    elements: &[Element],
    a: &AppState,
    get: impl Fn(&Element) -> Option<T>,
    pred: impl Fn(&Element) -> bool,
    default: impl FnOnce(bool) -> Option<T>,
) -> Option<T> {
    if let Some(v) = a
        .editing_text_element
        .as_deref()
        .and_then(|id| elements.iter().find(|e| e.id == id))
        .and_then(&get)
    {
        return Some(v);
    }
    if !is_some_element_selected(elements, &a.selected_element_ids) {
        return default(false);
    }
    let sel = get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default());
    reduce_to_common_value(sel.into_iter().filter(|e| pred(e)).map(get)).or_else(|| default(true))
}

// ---------------------------------------------------------------------------
// colors (colorTargets.ts)
// ---------------------------------------------------------------------------

/// `ColorTargetKind`: sticky notes are their own color domain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorTargetKind {
    Regular,
    Sticky,
    Mixed,
}

/// `ColorTarget`, without the palettes (the app's).
#[derive(Clone, Debug, PartialEq)]
pub struct ColorTarget {
    pub kind: ColorTargetKind,
    pub property: ColorProperty,
    pub current_value: String,
}

fn supports(e: &Element, p: ColorProperty) -> bool {
    if p == ColorProperty::Stroke {
        has_stroke_color(e.ty())
    } else {
        has_background(e.ty())
    }
}

/// `resolveColorTarget`: who a pick targets — the selected color-capable
/// elements (with labels, for stroke) and the edited text; with none, the
/// active tool decides.
pub fn resolve_color_target(a: &AppState, elements: &[Element], p: ColorProperty) -> ColorTarget {
    let map = array_to_map(elements);
    let mut targets: Vec<&Element> = get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: p == ColorProperty::Stroke,
            ..Default::default()
        },
    )
    .into_iter()
    .filter(|e| supports(e, p))
    .collect();
    if let Some(ed) = a
        .editing_text_element
        .as_deref()
        .and_then(|id| map.get(id))
        .map(|t| get_color_target_element(t, p, &map))
        && !ed.is_deleted
        && supports(ed, p)
        && !targets.iter().any(|e| e.id == ed.id)
    {
        targets.push(ed);
    }
    let kind = if targets.is_empty() {
        if a.active_tool.ty == ToolType::StickyNote {
            ColorTargetKind::Sticky
        } else {
            ColorTargetKind::Regular
        }
    } else {
        let n = targets
            .iter()
            .filter(|e| e.is_sticky_note() || (e.is_text() && is_sticky_note_bound_text(e, &map)))
            .count();
        if n == 0 {
            ColorTargetKind::Regular
        } else if n == targets.len() {
            ColorTargetKind::Sticky
        } else {
            ColorTargetKind::Mixed
        }
    };
    let sticky = kind == ColorTargetKind::Sticky;
    let current_value = match p {
        ColorProperty::Stroke => {
            if sticky {
                &a.current_item_stickynote_stroke_color
            } else {
                &a.current_item_stroke_color
            }
        }
        ColorProperty::Background => {
            if sticky {
                &a.current_item_stickynote_background_color
            } else {
                &a.current_item_background_color
            }
        }
    }
    .clone();
    ColorTarget {
        kind,
        property: p,
        current_value,
    }
}

/// `getColorTargetAppStateUpdates`: writes the pick to the defaults of the
/// target's domain(s).
pub fn apply_color_target_defaults(a: &mut AppState, t: &ColorTarget, color: &str) {
    let (regular, sticky) = match t.kind {
        ColorTargetKind::Regular => (true, false),
        ColorTargetKind::Sticky => (false, true),
        ColorTargetKind::Mixed => (true, true),
    };
    match t.property {
        ColorProperty::Stroke => {
            if regular {
                a.current_item_stroke_color = color.into();
            }
            if sticky {
                a.current_item_stickynote_stroke_color =
                    normalize_sticky_note_stroke_color(Some(color));
            }
        }
        ColorProperty::Background => {
            if regular {
                a.current_item_background_color = color.into();
            }
            if sticky {
                a.current_item_stickynote_background_color =
                    normalize_sticky_note_background_color(Some(color));
            }
        }
    }
}

fn set_color(
    e: &Element,
    p: ColorProperty,
    color: &str,
    map: &dyn crate::board::utils::ElementsMap,
) -> Element {
    let (prop, c) = get_color_update(e, p, color, map);
    new_element_with(
        e,
        |n| {
            if prop == ColorProperty::Stroke {
                n.stroke_color = c
            } else {
                n.background_color = c
            }
        },
        false,
    )
}

/// `actionChangeStrokeColor`: a note and its label share one ink.
pub fn action_change_stroke_color(elements: &[Element], a: &AppState, color: &str) -> ActionResult {
    let target = resolve_color_target(a, elements, ColorProperty::Stroke);
    let map = array_to_map(elements);
    let changed = change_property(elements, a, true, |e| {
        if has_stroke_color(e.ty()) {
            set_color(e, ColorProperty::Stroke, color, &map)
        } else {
            e.clone()
        }
    });
    let next = sync_sticky_note_ink(&changed, &map).unwrap_or(changed);
    let mut app = a.clone();
    apply_color_target_defaults(&mut app, &target, color);
    ActionResult::new(Some(next), Some(app), CaptureUpdateAction::Immediately)
}

/// `actionChangeBackgroundColor`: lines that can close become polygons with
/// a fill; a note's label passes the pick on to the note.
pub fn action_change_background_color(
    elements: &[Element],
    a: &AppState,
    color: &str,
) -> ActionResult {
    let target = resolve_color_target(a, elements, ColorProperty::Background);
    let map = array_to_map(elements);
    let selected =
        get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default());
    let polygon = !is_transparent(color)
        && !selected.is_empty()
        && selected
            .iter()
            .all(|e| e.is_line() && can_become_polygon(e.points().unwrap_or(&[])));
    let next = if polygon {
        let ids: FxHashSet<&str> = selected.iter().map(|e| e.id.as_str()).collect();
        elements
            .iter()
            .map(|e| {
                if !ids.contains(e.id.as_str()) || !e.is_line() {
                    return e.clone();
                }
                let toggled = toggle_line_polygon_state(e, true);
                new_element_with(
                    e,
                    |n| {
                        n.background_color = color.into();
                        if let (Some((poly, pts)), Kind::Line { linear, polygon }) =
                            (&toggled, &mut n.kind)
                        {
                            *polygon = *poly;
                            linear.points = pts.clone();
                        }
                    },
                    false,
                )
            })
            .collect()
    } else {
        let mut next = change_property(elements, a, false, |e| {
            if get_color_target_element(e, ColorProperty::Background, &map).id == e.id {
                set_color(e, ColorProperty::Background, color, &map)
            } else {
                e.clone()
            }
        });
        // editing a note's label: the pick colors the note
        let editing = a
            .editing_text_element
            .as_deref()
            .and_then(|id| map.get(id))
            .map(|t| {
                (
                    t.id.clone(),
                    get_color_target_element(t, ColorProperty::Background, &map)
                        .id
                        .clone(),
                )
            });
        if let Some((text, target)) = editing
            && text != target
        {
            for e in next.iter_mut().filter(|e| e.id == target) {
                *e = set_color(e, ColorProperty::Background, color, &map);
            }
        }
        next
    };
    let mut app = a.clone();
    apply_color_target_defaults(&mut app, &target, color);
    ActionResult::new(Some(next), Some(app), CaptureUpdateAction::Immediately)
}

// ---------------------------------------------------------------------------
// strokes, fills
// ---------------------------------------------------------------------------

fn changed(next: Vec<Element>, a: AppState) -> ActionResult {
    ActionResult::new(Some(next), Some(a), CaptureUpdateAction::Immediately)
}

/// `actionChangeFillStyle`.
pub fn action_change_fill_style(
    elements: &[Element],
    a: &AppState,
    value: FillStyle,
) -> ActionResult {
    let next = change_property(elements, a, false, |e| {
        if has_fill_style(e.ty()) {
            new_element_with(e, |n| n.fill_style = value, false)
        } else {
            e.clone()
        }
    });
    changed(
        next,
        AppState {
            current_item_fill_style: value,
            ..a.clone()
        },
    )
}

/// `getStrokeWidthKeyForElement`: the key whose width the element has.
pub fn get_stroke_width_key_for_element(e: &Element) -> Option<StrokeWidthKey> {
    [
        StrokeWidthKey::Thin,
        StrokeWidthKey::Medium,
        StrokeWidthKey::Bold,
    ]
    .into_iter()
    .find(|k| k.stroke_width(e.is_freedraw()) == e.stroke_width)
}

/// `actionChangeStrokeWidth` (freedraw strokes at their own widths).
pub fn action_change_stroke_width(
    elements: &[Element],
    a: &AppState,
    value: StrokeWidthKey,
) -> ActionResult {
    let next = change_property(elements, a, false, |e| {
        new_element_with(
            e,
            |n| n.stroke_width = value.stroke_width(n.is_freedraw()),
            false,
        )
    });
    changed(
        next,
        AppState {
            current_item_stroke_width_key: value,
            ..a.clone()
        },
    )
}

/// `actionChangeSloppiness`: kept in the file (we draw at roughness 0); a new
/// seed as upstream.
pub fn action_change_sloppiness(elements: &[Element], a: &AppState, value: f64) -> ActionResult {
    let next = change_property(elements, a, false, |e| {
        new_element_with(
            e,
            |n| {
                n.seed = random_integer();
                n.roughness = value;
            },
            false,
        )
    });
    changed(
        next,
        AppState {
            current_item_roughness: value,
            ..a.clone()
        },
    )
}

/// `actionChangeFreedrawMode`.
pub fn action_change_freedraw_mode(
    elements: &[Element],
    a: &AppState,
    value: StrokeVariability,
) -> ActionResult {
    let next = change_property(elements, a, false, |e| {
        if let Kind::FreeDraw(_) = e.kind {
            new_element_with(
                e,
                |n| {
                    if let Kind::FreeDraw(f) = &mut n.kind {
                        f.stroke_options.variability = value;
                    }
                },
                false,
            )
        } else {
            e.clone()
        }
    });
    changed(
        next,
        AppState {
            current_item_stroke_variability: value,
            ..a.clone()
        },
    )
}

/// `actionChangeStrokeStyle`.
pub fn action_change_stroke_style(
    elements: &[Element],
    a: &AppState,
    value: StrokeStyle,
) -> ActionResult {
    let next = change_property(elements, a, false, |e| {
        new_element_with(e, |n| n.stroke_style = value, false)
    });
    changed(
        next,
        AppState {
            current_item_stroke_style: value,
            ..a.clone()
        },
    )
}

/// `actionChangeOpacity` (labels too).
pub fn action_change_opacity(elements: &[Element], a: &AppState, value: f64) -> ActionResult {
    let next = change_property(elements, a, true, |e| {
        new_element_with(e, |n| n.opacity = value, false)
    });
    changed(
        next,
        AppState {
            current_item_opacity: value,
            ..a.clone()
        },
    )
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

/// Re-lays out the changed texts in `next`; notes whose layout changed get
/// their arrows re-placed.
fn relayout_texts(
    next: &mut Vec<Element>,
    texts: &[String],
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) {
    for id in texts {
        let Some(t) = next.iter().find(|e| e.id == *id).cloned() else {
            continue;
        };
        let container = t
            .container_id()
            .filter(|c| next.iter().any(|e| e.id == *c && !e.is_deleted))
            .map(String::from);
        if redraw_text_bounding_box(next, &t, container.as_deref(), m)
            && let Some(c) = container
        {
            update_bound_elements(&c, next, &UpdateBoundOpts::default(), hooks);
        }
    }
}

/// `offsetElementAfterFontResize`: free auto-resizing text keeps its anchor
/// (left / center / right, vertically centered).
fn offset_after_font_resize(prev: &Element, next: &mut [Element]) {
    let Some(n) = next.iter_mut().find(|e| e.id == prev.id) else {
        return;
    };
    let Some(t) = n.text() else { return };
    if t.container_id.is_some() || !t.auto_resize {
        return;
    }
    let align = prev.text().map_or(TextAlign::Left, |t| t.text_align);
    let x = match align {
        TextAlign::Left => prev.x,
        TextAlign::Center => prev.x + (prev.width - n.width) / 2.,
        TextAlign::Right => prev.x + (prev.width - n.width),
    };
    let y = prev.y + (prev.height - n.height) / 2.;
    crate::board::mutate::mutate_element(n, |e| {
        e.x = x;
        e.y = y;
    });
}

/// `changeFontSize`.
fn change_font_size(
    elements: &[Element],
    a: &AppState,
    mut size: impl FnMut(&Element) -> f64,
    fallback: Option<f64>,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let map = array_to_map(elements);
    let mut sizes: Vec<f64> = vec![];
    let mut texts: Vec<Element> = vec![];
    let mut next = change_property(elements, a, true, |e| {
        if !e.is_text() {
            return e.clone();
        }
        let s = size(e);
        if !sizes.contains(&s) {
            sizes.push(s);
        }
        texts.push(e.clone());
        new_element_with(e, |n| apply_base_font_size(n, s, &map), false)
    });
    for prev in &texts {
        relayout_texts(&mut next, std::slice::from_ref(&prev.id), m, hooks);
        offset_after_font_resize(prev, &mut next);
    }
    // arrows bound to the texts follow
    let sel: Vec<String> = get_selected_elements(
        elements,
        &a.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            ..Default::default()
        },
    )
    .into_iter()
    .filter(|e| e.is_text())
    .map(|e| e.id.clone())
    .collect();
    for id in sel {
        update_bound_elements(&id, &mut next, &UpdateBoundOpts::default(), hooks);
    }
    let current = if sizes.len() == 1 {
        sizes[0]
    } else {
        fallback.unwrap_or(a.current_item_font_size)
    };
    changed(
        next,
        AppState {
            current_item_font_size: current,
            ..a.clone()
        },
    )
}

/// `actionChangeFontSize`.
pub fn action_change_font_size(
    elements: &[Element],
    a: &AppState,
    value: f64,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    change_font_size(elements, a, |_| value, Some(value), m, hooks)
}

/// `actionDecreaseFontSize` (Cmd+Shift+<).
pub fn action_decrease_font_size(
    elements: &[Element],
    a: &AppState,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let map = array_to_map(elements);
    change_font_size(
        elements,
        a,
        |e| {
            crate::board::math::js_round(
                1. / (1. + FONT_SIZE_RELATIVE_INCREASE_STEP) * get_base_font_size(e, &map),
            )
        },
        None,
        m,
        hooks,
    )
}

/// `actionIncreaseFontSize` (Cmd+Shift+>).
pub fn action_increase_font_size(
    elements: &[Element],
    a: &AppState,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let map = array_to_map(elements);
    change_font_size(
        elements,
        a,
        |e| {
            crate::board::math::js_round(
                get_base_font_size(e, &map) * (1. + FONT_SIZE_RELATIVE_INCREASE_STEP),
            )
        },
        None,
        m,
        hooks,
    )
}

/// `actionChangeFontFamily`. `hover`: a preview while hovering a family in
/// the picker (not captured; skipped for more than 200 texts or 5000
/// characters); else the pick, which also sets the default.
pub fn action_change_font_family(
    elements: &[Element],
    a: &AppState,
    family: u32,
    hover: bool,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let mut app = a.clone();
    if !hover {
        app.current_item_font_family = family;
    }
    let capture = if hover {
        CaptureUpdateAction::Eventually
    } else {
        CaptureUpdateAction::Immediately
    };
    if hover {
        let texts: Vec<&Element> = get_selected_elements(
            elements,
            &a.selected_element_ids,
            SelectedOpts {
                include_bound_text_element: true,
                ..Default::default()
            },
        )
        .into_iter()
        .filter(|e| e.is_text())
        .collect();
        let mut chars = 0;
        let skip = texts.len() > 200 || {
            for t in &texts {
                if chars >= 5000 {
                    break;
                }
                chars += t
                    .text()
                    .map_or(0, |t| t.original_text.encode_utf16().count());
            }
            chars > 5000
        };
        if skip {
            return ActionResult::new(None, Some(app), capture);
        }
    }
    let mut ids: Vec<String> = vec![];
    let mut next = change_property(elements, a, true, |e| {
        if !e.text().is_some_and(|t| t.font_family != family || !hover) {
            return e.clone();
        }
        ids.push(e.id.clone());
        new_element_with(
            e,
            |n| {
                if let Some(t) = n.text_mut() {
                    t.font_family = family;
                    t.line_height = get_line_height(family);
                }
            },
            false,
        )
    });
    relayout_texts(&mut next, &ids, m, hooks);
    ActionResult::new(Some(next), Some(app), capture)
}

/// `actionChangeTextAlign`.
pub fn action_change_text_align(
    elements: &[Element],
    a: &AppState,
    value: TextAlign,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let mut ids = vec![];
    let mut next = change_property(elements, a, true, |e| {
        if e.is_text() {
            ids.push(e.id.clone());
            new_element_with(
                e,
                |n| {
                    if let Some(t) = n.text_mut() {
                        t.text_align = value;
                    }
                },
                false,
            )
        } else {
            e.clone()
        }
    });
    relayout_texts(&mut next, &ids, m, hooks);
    changed(
        next,
        AppState {
            current_item_text_align: value,
            ..a.clone()
        },
    )
}

/// `actionChangeVerticalAlign`.
pub fn action_change_vertical_align(
    elements: &[Element],
    a: &AppState,
    value: VerticalAlign,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let mut ids = vec![];
    let mut next = change_property(elements, a, true, |e| {
        if e.is_text() {
            ids.push(e.id.clone());
            new_element_with(
                e,
                |n| {
                    if let Some(t) = n.text_mut() {
                        t.vertical_align = value;
                    }
                },
                false,
            )
        } else {
            e.clone()
        }
    });
    relayout_texts(&mut next, &ids, m, hooks);
    changed(next, a.clone())
}

// ---------------------------------------------------------------------------
// edges, arrows
// ---------------------------------------------------------------------------

/// `actionChangeRoundness` (not elbow arrows).
pub fn action_change_roundness(
    elements: &[Element],
    a: &AppState,
    value: StrokeRoundness,
) -> ActionResult {
    let next = change_property(elements, a, false, |e| {
        if e.is_elbow_arrow() {
            return e.clone();
        }
        let kind = if e.ty().uses_adaptive_radius() {
            roundness::ADAPTIVE_RADIUS
        } else {
            roundness::PROPORTIONAL_RADIUS
        };
        new_element_with(
            e,
            |n| {
                n.roundness =
                    (value == StrokeRoundness::Round).then_some(Roundness { kind, value: None })
            },
            false,
        )
    });
    changed(
        next,
        AppState {
            current_item_roundness: value,
            ..a.clone()
        },
    )
}

/// `actionChangeArrowhead`: elbow arrows re-route.
pub fn action_change_arrowhead(
    elements: &[Element],
    a: &AppState,
    position: StartOrEnd,
    value: Option<Arrowhead>,
) -> ActionResult {
    let map = array_to_map(elements);
    let next = change_property(elements, a, false, |e| {
        if !e.is_linear() {
            return e.clone();
        }
        let n = new_element_with(
            e,
            |n| {
                if let Some(l) = n.linear_mut() {
                    if position == StartOrEnd::Start {
                        l.start_arrowhead = value
                    } else {
                        l.end_arrowhead = value
                    }
                }
            },
            false,
        );
        if n.is_elbow_arrow() {
            let u = update_elbow_arrow_route(&n, &map);
            new_element_with(&n, |x| u.apply(x), false)
        } else {
            n
        }
    });
    let mut app = a.clone();
    if position == StartOrEnd::Start {
        app.current_item_start_arrowhead = value
    } else {
        app.current_item_end_arrowhead = value
    }
    changed(next, app)
}

/// `actionChangeArrowType`: sharp / round / elbow. To elbow: the arrow is
/// rebuilt from its ends, its bindings re-anchored and routed; from elbow or
/// between sharp and round: bindings re-made at its ends.
pub fn action_change_arrow_type(
    elements: &[Element],
    a: &AppState,
    value: ArrowType,
) -> ActionResult {
    let map = array_to_map(elements);
    let elbow = value == ArrowType::Elbow;
    let mut rebind: Vec<String> = vec![];
    let mut next = change_property(elements, a, false, |el| {
        if !el.is_arrow() {
            return el.clone();
        }
        let start = get_point_at_index_global_coordinates(el, 0, &map);
        let end = get_point_at_index_global_coordinates(el, -1, &map);
        let mut flat = el.clone();
        (flat.x, flat.y, flat.angle) = (start[0], start[1], 0.);
        let points = (elbow || el.is_elbow_arrow()).then(|| {
            vec![
                point_from_absolute_coords(&flat, start, &map),
                point_from_absolute_coords(&flat, end, &map),
            ]
        });
        let mut n = new_element_with(
            el,
            |n| {
                if elbow {
                    (n.x, n.y, n.angle) = (start[0], start[1], 0.);
                }
                n.roundness = (value == ArrowType::Round).then_some(Roundness {
                    kind: roundness::PROPORTIONAL_RADIUS,
                    value: None,
                });
                if let Kind::Arrow { elbow: e, .. } = &mut n.kind {
                    *e = if elbow {
                        Some(ElbowData::default())
                    } else {
                        None
                    };
                }
                if let (Some(p), Some(l)) = (&points, n.linear_mut()) {
                    l.points = p.clone();
                }
            },
            false,
        );
        if n.is_elbow_arrow() {
            let s = get_point_at_index_global_coordinates(&n, 0, &map);
            let e = get_point_at_index_global_coordinates(&n, -1, &map);
            let fp = |end: StartOrEnd| {
                binding_of(&n, end)
                    .and_then(|b| map.get(b.element_id.as_str()).map(|t| (b, *t)))
                    .map(|(b, t)| FixedPointBinding {
                        fixed_point: calculate_fixed_point_for_elbow_arrow_binding(
                            &n,
                            t,
                            end,
                            &map,
                            a.zoom,
                            a.is_binding_enabled,
                            true,
                        ),
                        ..b.clone()
                    })
            };
            let (sb, eb) = (fp(StartOrEnd::Start), fp(StartOrEnd::End));
            let u = ElbowUpdate {
                points: Some(vec![[s[0] - n.x, s[1] - n.y], [e[0] - n.x, e[1] - n.y]]),
                start_binding: Some(sb.clone()),
                end_binding: Some(eb.clone()),
                fixed_segments: Some(None),
                ..Default::default()
            };
            let routed = update_elbow_arrow_points(&n, &map, &u, &ElbowOptions::default());
            n = new_element_with(
                &n,
                |x| {
                    if let Some(l) = x.linear_mut() {
                        l.start_binding = sb;
                        l.end_binding = eb;
                    }
                    u.apply(x);
                    routed.apply(x);
                    x.angle = 0.;
                },
                false,
            );
        } else {
            rebind.push(n.id.clone());
        }
        n
    });
    let mode = if a.bind_mode == BindMode::Inside {
        BindMode::Inside
    } else {
        BindMode::Orbit
    };
    for id in rebind {
        let Some(arrow) = next.iter().find(|e| e.id == id).cloned() else {
            continue;
        };
        for s in [StartOrEnd::Start, StartOrEnd::End] {
            if let Some(b) = binding_of(&arrow, s).filter(|b| {
                map.get(b.element_id.as_str())
                    .is_some_and(|t| !t.is_deleted)
            }) {
                bind_binding_element(
                    &id,
                    &b.element_id.clone(),
                    mode,
                    s,
                    &mut next,
                    a.zoom,
                    None,
                    true,
                    true,
                );
            }
        }
    }
    let mut app = AppState {
        current_item_arrow_type: value,
        ..a.clone()
    };
    if let Some(sel) = &a.selected_linear_element
        && next.iter().any(|e| e.id == sel.element_id)
    {
        app.selected_linear_element = Some(SelectedLinearElement {
            element_id: sel.element_id.clone(),
            is_editing: false,
        });
    }
    changed(next, app)
}
