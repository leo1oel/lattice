// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Text: the text tool and starting an edit, after Excalidraw
//! `components/App.text.ts` (`startTextEditing`,
//! `getSelectedTextEditingContainerAtPosition`) and `App.textTool.ts`
//! (`getTargetAt`: a text under the pointer is edited, an empty container
//! near its center gets a label, else free text, which a drag widens into
//! a wrapping box) @ 3a317b5. The editor
//! itself is `text_editor`.

use super::super::BoardView;
use super::super::app_state::ToolType;
use super::super::canvas::{Gesture, Mods};
use super::super::consts::TEXT_TO_CENTER_SNAP_THRESHOLD;
use super::super::drag::{DragNewOpts, drag_new_element};
use super::super::new_element::{ElementOpts, TextOpts, new_text_element};
use super::super::text::{DEFAULT_BOUND_TEXT_LABEL_POSITION, get_container_center};
use super::super::text_edit::{grow_container_for_new_label, new_free_text_position};
use super::super::text_measure::{Font, get_line_height};
use super::super::types::{BoundElement, BoundType, ElementType, TextAlign, VerticalAlign};
use super::super::utils::get_grid_point;
use gpui::{Context, CursorStyle, Window};
use std::collections::BTreeSet;

/// `getTextElementAtPosition`.
fn text_at(me: &BoardView, p: [f64; 2]) -> Option<String> {
    me.element_at(p, true, false)
        .filter(|e| e.is_text())
        .map(|e| e.id.clone())
}

/// A container near whose center a text-tool click puts a label.
fn container_at(me: &BoardView, p: [f64; 2], mods: Mods) -> Option<String> {
    if mods.ctrl_or_cmd() {
        return None;
    }
    let id = super::selection::text_container_at(me, p)?;
    let c = me.scene.get_element(&id)?;
    let center = get_container_center(c, &me.scene);
    (!c.has_bound_text()
        && (p[0] - center[0]).hypot(p[1] - center[1]) < TEXT_TO_CENTER_SNAP_THRESHOLD)
        .then_some(id)
}

pub fn down(
    me: &mut BoardView,
    p: [f64; 2],
    mods: Mods,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    if me.text.is_some() {
        return;
    }
    if let Some(t) = text_at(me, p) {
        let container = me
            .scene
            .get_element(&t)
            .and_then(|e| e.container_id().map(str::to_owned));
        me.app.selected_element_ids = BTreeSet::from([container.clone().unwrap_or(t)]);
        start_editing(me, p, container, true, Some(p), window, cx);
        return;
    }
    let container = container_at(me, p, mods);
    me.clear_selection();
    let free = container.is_none();
    start_editing(me, p, container, true, None, window, cx);
    // free text is the tool's new element: a drag sizes it
    if free
        && let Some(t) = &me.text
        && !t.session.is_existing_element
    {
        let origin = get_grid_point(p[0], p[1], me.grid(mods));
        me.gesture = Some(Gesture::Text(TextDrag {
            id: t.session.element_id.clone(),
            origin,
        }));
    }
}

/// The text tool's drag (`maybeDragNewGenericElement` with a text
/// `newElement`): the new text widens to the pointer, and wraps there once
/// past `TEXT_AUTOWRAP_THRESHOLD` (`dragNewTextElement`).
pub struct TextDrag {
    pub id: String,
    pub origin: [f64; 2],
}

pub fn drag(me: &mut BoardView, t: TextDrag, p: [f64; 2], mods: Mods) -> Option<Gesture> {
    let g = get_grid_point(p[0], p[1], me.grid(mods));
    let mut o = DragNewOpts::new(ToolType::Text, t.origin, g, me.app.zoom);
    o.resize_from_center = mods.alt;
    let m = me.m.clone();
    drag_new_element(&mut me.scene, &t.id, &o, &*m);
    if let Some(e) = &mut me.text {
        e.restyle = true;
    }
    Some(Gesture::Text(t))
}

pub fn hover_cursor(me: &BoardView, p: [f64; 2], mods: Mods) -> CursorStyle {
    if text_at(me, p).is_some() {
        CursorStyle::IBeam
    } else if container_at(me, p, mods).is_some() {
        CursorStyle::PointingHand
    } else {
        CursorStyle::Crosshair
    }
}

/// `startTextEditing`: edits the selected text (or `container`'s label, or
/// the text at the point), else creates one — bound to `container` when the
/// point is near its center.
pub fn start_editing(
    me: &mut BoardView,
    p: [f64; 2],
    container: Option<String>,
    at_center: bool,
    caret_at: Option<[f64; 2]>,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    let m = me.m.clone();
    let (mut x, mut y) = (p[0], p[1]);
    let container_el = container
        .as_ref()
        .and_then(|c| me.scene.get_non_deleted_element(c))
        .cloned();
    let snapped = at_center
        && container_el.as_ref().is_some_and(|c| {
            let ctr = get_container_center(c, &me.scene);
            (x - ctr[0]).hypot(y - ctr[1]) < TEXT_TO_CENTER_SNAP_THRESHOLD
        });
    let should_bind = snapped
        && container_el.as_ref().is_some_and(|c| {
            c.bound_text_id()
                .and_then(|t| me.scene.get_non_deleted_element(t))
                .is_none()
        });
    // the text to edit
    let sel = me.selected_elements();
    let existing = if sel.len() == 1 && sel[0].is_text() {
        Some(sel[0].id.clone())
    } else {
        None
    }
    .or_else(|| {
        container_el
            .as_ref()
            .and_then(|c| c.bound_text_id())
            .filter(|t| me.scene.get_non_deleted_element(t).is_some())
            .map(str::to_owned)
    })
    .or_else(|| {
        (sel.len() == 1)
            .then(|| {
                sel[0]
                    .bound_text_id()
                    .filter(|t| me.scene.get_non_deleted_element(t).is_some())
                    .map(str::to_owned)
            })
            .flatten()
            .filter(|_| container.is_some())
    })
    .or_else(|| text_at(me, p));
    let existing_el = existing
        .as_ref()
        .and_then(|id| me.scene.get_element(id))
        .cloned();
    let family = existing_el
        .as_ref()
        .and_then(|e| e.text())
        .map_or(me.app.current_item_font_family, |t| t.font_family);
    let line_height = existing_el
        .as_ref()
        .and_then(|e| e.text())
        .map_or_else(|| get_line_height(family), |t| t.line_height);
    let font_size = me.app.current_item_font_size;
    let sticky = container_el.as_ref().is_some_and(|c| c.is_sticky_note());
    if existing.is_none()
        && should_bind
        && let Some(c) = &container_el
        && !c.is_arrow()
        && !sticky
        && let Some(ctr) = grow_container_for_new_label(
            &mut me.scene,
            &c.id,
            Font::new(font_size, family),
            line_height,
            &*m,
        )
    {
        (x, y) = (ctr[0], ctr[1]);
    }
    let center = if should_bind || snapped {
        container
            .as_ref()
            .and_then(|c| me.scene.get_element(c))
            .map(|c| get_container_center(c, &me.scene))
    } else {
        None
    };
    let id = match existing.clone() {
        Some(id) => id,
        None => {
            let pos = match center {
                Some(c) => c,
                None => {
                    new_free_text_position(x, y, font_size, line_height, me.grid(Mods::default()))
                }
            };
            let exclude = BTreeSet::new();
            let frame = me.top_frame_at(pos, &exclude).filter(|f| {
                !should_bind
                    || container_el
                        .as_ref()
                        .is_some_and(|c| c.frame_id.as_ref() == Some(f))
            });
            let mut o = me.current_opts(ElementType::Text, pos[0], pos[1]);
            if should_bind
                && sticky
                && let Some(c) = &container_el
            {
                o.stroke_color = c.stroke_color.clone();
            }
            o.frame_id = frame;
            if should_bind && let Some(c) = &container_el {
                o.group_ids = c.group_ids.clone();
                if !c.is_arrow() {
                    o.angle = c.angle;
                }
            }
            let t = TextOpts {
                text: String::new(),
                original_text: None,
                font_size: Some(font_size),
                font_family: Some(family),
                text_align: Some(if center.is_some() {
                    TextAlign::Center
                } else {
                    me.app.current_item_text_align
                }),
                vertical_align: Some(if center.is_some() {
                    VerticalAlign::Middle
                } else {
                    VerticalAlign::Top
                }),
                container_id: should_bind.then(|| container.clone()).flatten(),
                line_height: Some(line_height),
                auto_resize: None,
                label_position: (should_bind
                    && container_el.as_ref().is_some_and(|c| c.is_arrow()))
                .then_some(DEFAULT_BOUND_TEXT_LABEL_POSITION),
                base_font_size: (should_bind && sticky).then_some(font_size),
            };
            let e = new_text_element(t, ElementOpts { ..o }, &*m);
            let id = e.id.clone();
            if should_bind && let Some(c) = &container_el {
                me.scene.mutate_element(&c.id, true, |x| {
                    x.bound_elements
                        .get_or_insert_with(Vec::new)
                        .push(BoundElement {
                            id: id.clone(),
                            kind: BoundType::Text,
                        })
                });
                let i = me.scene.get_element_index(&c.id).map(|i| i + 1);
                me.scene.insert_elements_at_index(vec![e], i);
            } else {
                me.scene.insert_element(e);
            }
            id
        }
    };
    super::super::text_editor::begin(
        me,
        &id,
        existing.is_some(),
        caret_at.filter(|_| existing.is_some()),
        window,
        cx,
    );
}
