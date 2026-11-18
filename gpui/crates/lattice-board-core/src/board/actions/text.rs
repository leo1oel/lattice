// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Port of Excalidraw `packages/excalidraw/actions/actionTextAutoResize.ts`
//! and the element part of `actionLink.tsx` / `components/hyperlink/Hyperlink.tsx`
//! @ 3a317b5. Opening the link editor (`showHyperlinkPopup`), embeds and
//! element links (`actionElementLink.ts`: copying a link to an element, the
//! link selector dialog) are the app's.

use super::ActionResult;
use crate::board::app_state::AppState;
use crate::board::binding::{BindingHooks, UpdateBoundOpts, update_bound_elements};
use crate::board::history::CaptureUpdateAction;
use crate::board::mutate::new_element_with;
use crate::board::new_element::get_text_anchor_ratios;
use crate::board::selection::{SelectedOpts, get_selected_elements};
use crate::board::text::font_of;
use crate::board::text_measure::{Measure, measure_text};
use crate::board::types::Element;
use crate::board::utils::normalize_link;

/// `actionTextAutoResize`: the text (`target`, else the first selected) goes
/// back to auto width, unwrapped, keeping the point its alignment pins;
/// arrows bound to it follow.
pub fn action_text_auto_resize(
    elements: &[Element],
    a: &AppState,
    target: Option<&str>,
    m: &dyn Measure,
    hooks: &dyn BindingHooks,
) -> ActionResult {
    let sel = get_selected_elements(elements, &a.selected_element_ids, SelectedOpts::default());
    let id = target
        .filter(|id| elements.iter().any(|e| e.id == *id && e.is_text()))
        .or_else(|| sel.first().map(|e| e.id.as_str()));
    let Some(t) = id
        .and_then(|id| elements.iter().find(|e| e.id == id))
        .filter(|e| e.is_text())
    else {
        return ActionResult::none();
    };
    let td = t.text().unwrap();
    let metrics = measure_text(m, &td.original_text, font_of(t), td.line_height);
    let (ax, ay) = get_text_anchor_ratios(td.text_align, td.vertical_align);
    let resized = new_element_with(
        t,
        |n| {
            (n.x, n.y) = (
                t.x + (t.width - metrics.width) * ax,
                t.y + (t.height - metrics.height) * ay,
            );
            (n.width, n.height) = (metrics.width, metrics.height);
            if let Some(d) = n.text_mut() {
                d.auto_resize = true;
                d.text = d.original_text.clone();
            }
        },
        false,
    );
    let mut next: Vec<Element> = elements
        .iter()
        .map(|e| {
            if e.id == resized.id {
                resized.clone()
            } else {
                e.clone()
            }
        })
        .collect();
    if !resized.is_deleted {
        update_bound_elements(&resized.id, &mut next, &UpdateBoundOpts::default(), hooks);
    }
    ActionResult::new(
        Some(next),
        Some(a.clone()),
        CaptureUpdateAction::Immediately,
    )
}

/// The link editor's submit (`Hyperlink.handleSubmit`): sets the element's
/// link, normalized; empty removes it.
pub fn action_set_link(
    elements: &[Element],
    a: &AppState,
    element_id: &str,
    link: &str,
) -> ActionResult {
    let link = Some(normalize_link(link)).filter(|l| !l.is_empty());
    let next = elements
        .iter()
        .map(|e| {
            if e.id == element_id {
                new_element_with(e, |n| n.link = link.clone(), false)
            } else {
                e.clone()
            }
        })
        .collect();
    ActionResult::new(
        Some(next),
        Some(a.clone()),
        CaptureUpdateAction::Immediately,
    )
}
