// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Copy and paste. Port of Excalidraw `packages/excalidraw/clipboard.ts`
//! (the `excalidraw/clipboard` JSON, parsing pasted text / HTML) and the
//! data half of `components/App.clipboard.ts` (routing a paste, pasting text
//! as text elements), `App.addElementsFromPasteOrLibrary` and
//! `App.duplicate.duplicateAtSceneCoords` (placing pasted elements), the
//! drop routing of `App.handleAppOnDrop`, and `actions/actionClipboard.tsx`
//! (`actionCopy`'s selection) @ 3a317b5.
//!
//! The system clipboard and drag-and-drop plumbing are the app's: it hands
//! over the plain text, the HTML and the files, and writes what
//! `copy_to_clipboard` returns. Not ported: spreadsheets (charts), Mermaid,
//! embeddable URLs (no embeds on our board), fetching pasted image URLs, the
//! stats panel and scroll-into-view tweaks of text paste, the host's
//! `onPaste` / `onDuplicate`.

use super::app_state::AppState;
use super::binding::BindingHooks;
use super::bounds::get_common_bounds;
use super::consts::*;
use super::duplicate::{DuplicateMode, duplicate_elements};
use super::fractional_index::sync_moved_indices;
use super::frame::{add_elements_to_frame, filter_elements_eligible_as_frame_children};
use super::image::{is_supported_image_file_type, mime};
use super::json::{element_to_json, file_to_json};
use super::math::Point;
use super::mutate::{mutate_element, new_element_with};
use super::new_element::{ElementOpts, TextOpts, new_text_element};
use super::restore::{LoadError, RestoreOpts, SceneData, load_from_blob, restore_elements};
use super::scene::Scene;
use super::selection::{
    SelectedOpts, SelectionState, exclude_elements_in_frames_from_selection, get_selected_elements,
    get_selection_state_for_elements,
};
use super::text::redraw_text_bounding_box;
use super::text_measure::{
    Font, Measure, get_line_height, get_line_height_in_px, measure_text, normalize_text,
};
use super::text_wrapping::wrap_text;
use super::types::{Element, FileData, TextAlign, VerticalAlign};
use super::utils::{ElementsMap, array_to_map, get_grid_point};
use html5ever::tendril::TendrilSink;
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use rustc_hash::FxHashSet;
use serde_json::Value;
use std::collections::BTreeMap;

/// `EXPORT_DATA_TYPES.excalidrawClipboardWithAPI`: elements as skeletons.
pub const EXPORT_DATA_TYPE_CLIPBOARD_WITH_API: &str = "excalidraw-api/clipboard";

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

/// `actionCopy`'s elements: the selection with bound text and frame
/// children.
pub fn get_elements_to_copy<'a>(elements: &'a [Element], app: &AppState) -> Vec<&'a Element> {
    get_selected_elements(
        elements,
        &app.selected_element_ids,
        SelectedOpts {
            include_bound_text_element: true,
            include_elements_in_frames: true,
        },
    )
}

/// `serializeAsClipboardJSON`: `{"type":"excalidraw/clipboard","elements":
/// […],"files":{…}}`. Elements in a frame that isn't copied lose their
/// `frameId`; `files` (when given) keeps those of the copied images.
pub fn serialize_as_clipboard_json(
    elements: &[&Element],
    files: Option<&BTreeMap<String, FileData>>,
) -> String {
    let map: rustc_hash::FxHashMap<&str, &Element> =
        elements.iter().map(|e| (e.id.as_str(), *e)).collect();
    let frames: FxHashSet<&str> = elements
        .iter()
        .filter(|e| e.is_frame_like())
        .map(|e| e.id.as_str())
        .collect();
    let mut out = format!(
        "{{\"type\":{},\"elements\":[",
        Value::from(EXPORT_DATA_TYPE_CLIPBOARD)
    );
    for (i, e) in elements.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        // `getContainingFrame` looks the frame up among the copied elements
        // (pasting drops a frameId whose frame isn't pasted along)
        let outside = e
            .frame_id
            .as_deref()
            .is_some_and(|f| map.contains_key(f) && !frames.contains(f));
        if outside {
            let mut c = (*e).clone();
            mutate_element(&mut c, |c| c.frame_id = None);
            out.push_str(&element_to_json(&c));
        } else {
            out.push_str(&element_to_json(e));
        }
    }
    out.push(']');
    if let Some(files) = files {
        out.push_str(",\"files\":{");
        let mut first = true;
        let mut seen = FxHashSet::default();
        for e in elements.iter().filter(|e| e.is_initialized_image()) {
            let id = e.image().and_then(|i| i.file_id.as_deref()).unwrap();
            let Some(f) = files.get(id) else { continue };
            if !seen.insert(id) {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&format!("{}:{}", Value::from(id), file_to_json(f)));
        }
        out.push('}');
    }
    out.push('}');
    out
}

/// `copyToClipboard`: what to put on the system clipboard, by mime type
/// (the excalidraw clipboard type and plain text, the same JSON).
pub fn copy_to_clipboard(
    elements: &[&Element],
    files: Option<&BTreeMap<String, FileData>>,
) -> Vec<(&'static str, String)> {
    let json = serialize_as_clipboard_json(elements, files);
    vec![
        (mime::EXCALIDRAW_CLIPBOARD, json.clone()),
        (mime::TEXT, json),
    ]
}

// ---------------------------------------------------------------------------
// parsing a paste
// ---------------------------------------------------------------------------

/// `PastedMixedContent` items.
#[derive(Clone, Debug, PartialEq)]
pub enum MixedItem {
    Text(String),
    ImageUrl(String),
}

/// `ClipboardData`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClipboardData {
    /// The raw `elements` array (skeletons when `programmatic_api`).
    pub elements: Option<Value>,
    pub files: Option<Value>,
    pub text: Option<String>,
    pub mixed_content: Option<Vec<MixedItem>>,
    pub programmatic_api: bool,
}

/// `parseHTMLTree` over the HTML's body: trimmed text nodes and `http`
/// image sources, in document order.
pub fn parse_html_mixed_content(html: &str) -> Vec<MixedItem> {
    let Ok(dom) = html5ever::parse_document(RcDom::default(), Default::default())
        .from_utf8()
        .read_from(&mut html.as_bytes())
    else {
        return vec![];
    };
    fn find(n: &Handle, tag: &str) -> Option<Handle> {
        if let NodeData::Element { name, .. } = &n.data
            && &*name.local == tag
        {
            return Some(n.clone());
        }
        n.children.borrow().iter().find_map(|c| find(c, tag))
    }
    fn walk(n: &Handle, out: &mut Vec<MixedItem>) {
        for c in n.children.borrow().iter() {
            match &c.data {
                NodeData::Text { contents } => {
                    let t = contents.borrow().trim().to_string();
                    if !t.is_empty() {
                        out.push(MixedItem::Text(t));
                    }
                }
                NodeData::Element { name, attrs, .. } if &*name.local == "img" => {
                    if let Some(a) = attrs.borrow().iter().find(|a| &*a.name.local == "src")
                        && a.value.starts_with("http")
                    {
                        out.push(MixedItem::ImageUrl(a.value.to_string()));
                    }
                }
                _ => walk(c, out),
            }
        }
    }
    let body = find(&dom.document, "body").unwrap_or_else(|| dom.document.clone());
    let mut out = vec![];
    walk(&body, &mut out);
    out
}

/// `parseClipboardEventTextData` + `parseClipboard`: excalidraw elements in
/// the text, else mixed content from the HTML (unless all text), else text.
pub fn parse_clipboard(
    text: Option<&str>,
    html: Option<&str>,
    is_plain_paste: bool,
) -> ClipboardData {
    let mixed = if is_plain_paste {
        None
    } else {
        html.map(parse_html_mixed_content).filter(|m| !m.is_empty())
    };
    let value = match mixed {
        Some(m) if m.iter().all(|i| matches!(i, MixedItem::Text(_))) => match text {
            Some(t) => t.to_string(),
            None => m
                .iter()
                .map(|i| {
                    if let MixedItem::Text(t) = i {
                        t.as_str()
                    } else {
                        ""
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string(),
        },
        Some(m) => {
            return ClipboardData {
                mixed_content: Some(m),
                ..Default::default()
            };
        }
        None => text.unwrap_or("").trim().to_string(),
    };
    if let Ok(v) = serde_json::from_str::<Value>(&value) {
        let ty = v.get("type").and_then(Value::as_str);
        let contains = matches!(
            ty,
            Some(EXPORT_DATA_TYPE_EXCALIDRAW)
                | Some(EXPORT_DATA_TYPE_CLIPBOARD)
                | Some(EXPORT_DATA_TYPE_CLIPBOARD_WITH_API)
        ) && v.get("elements").is_some_and(Value::is_array);
        if contains {
            return ClipboardData {
                text: is_plain_paste
                    .then(|| serde_json::to_string_pretty(&v["elements"]).unwrap_or_default()),
                elements: v.get("elements").cloned(),
                files: v.get("files").cloned(),
                programmatic_api: ty == Some(EXPORT_DATA_TYPE_CLIPBOARD_WITH_API),
                mixed_content: None,
            };
        }
    }
    ClipboardData {
        text: Some(value),
        ..Default::default()
    }
}

/// What a paste inserts (`insertClipboardContent`'s routing).
#[derive(Clone, Debug, PartialEq)]
pub enum PasteContent {
    /// Text and image URLs from HTML (no files pasted).
    MixedContent(Vec<MixedItem>),
    /// The pasted image files (by index into what the app passed).
    ImageFiles(Vec<usize>),
    /// SVG code pasted as text, inserted as an SVG image.
    SvgText(String),
    /// Excalidraw elements, raw (`skeletons`: to convert with
    /// `transform::convert_to_excalidraw_elements` first), and their files.
    Elements {
        elements: Value,
        files: Option<Value>,
        skeletons: bool,
    },
    Text(String),
    Nothing,
}

/// `insertClipboardContent`'s routing. `image_files`: the mime types of
/// the pasted files.
pub fn route_paste(
    data: &ClipboardData,
    image_files: &[&str],
    is_plain_paste: bool,
) -> PasteContent {
    if image_files.is_empty()
        && !is_plain_paste
        && let Some(m) = &data.mixed_content
    {
        return PasteContent::MixedContent(m.clone());
    }
    let images: Vec<usize> = image_files
        .iter()
        .enumerate()
        .filter(|(_, m)| is_supported_image_file_type(m))
        .map(|(i, _)| i)
        .collect();
    if !images.is_empty() {
        return PasteContent::ImageFiles(images);
    }
    if image_files.is_empty()
        && !is_plain_paste
        && let Some(t) = &data.text
    {
        let t = t.trim();
        if t.starts_with("<svg") && t.ends_with("</svg>") {
            return PasteContent::SvgText(t.into());
        }
    }
    if let Some(e) = &data.elements {
        return PasteContent::Elements {
            elements: e.clone(),
            files: data.files.clone(),
            skeletons: data.programmatic_api,
        };
    }
    match &data.text {
        Some(t) if !t.is_empty() => PasteContent::Text(t.clone()),
        _ => PasteContent::Nothing,
    }
}

// ---------------------------------------------------------------------------
// placing pasted elements
// ---------------------------------------------------------------------------

/// `addElementsFromPasteOrLibrary`' restore step: pasted raw elements as
/// elements (invisible ones deleted, bindings not repaired).
pub fn restore_pasted_elements(raw: &Value) -> Vec<Element> {
    restore_elements(
        Some(raw),
        None,
        &RestoreOpts {
            delete_invisible_elements: true,
            ..Default::default()
        },
    )
}

/// Options of a paste / library insert.
pub struct PasteOpts<'a> {
    /// Where to center the elements (the cursor, or the view's center).
    pub scene_point: Point,
    /// `getEffectiveGridSize`.
    pub grid_size: Option<f64>,
    /// Keep the seeds (plain paste, a scene dropped at a point).
    pub retain_seed: bool,
    pub preserve_frame_children_order: bool,
    /// The top-layer frame under the point (`getTopLayerFrameAtSceneCoords`).
    pub top_layer_frame: Option<&'a str>,
    pub measure: &'a dyn Measure,
    pub hooks: &'a dyn BindingHooks,
}

/// What a paste did: the duplicates' ids and the selection to set.
#[derive(Clone, Debug, PartialEq)]
pub struct PasteResult {
    pub duplicated: Vec<String>,
    pub selection: SelectionState,
}

/// `addElementsFromPasteOrLibrary` + `duplicateAtSceneCoords`: duplicates
/// `elements` centered on the point (snapped to the grid) into the scene,
/// into the frame there, relays labels, adds missing files and returns the
/// selection (the duplicates, not those inside duplicated frames). None if
/// nothing to paste.
pub fn add_elements_from_paste_or_library(
    scene: &mut Scene,
    files_store: &mut BTreeMap<String, FileData>,
    elements: &[Element],
    files: Option<&BTreeMap<String, FileData>>,
    app: &AppState,
    o: &PasteOpts,
) -> Option<PasteResult> {
    if elements.is_empty() {
        return None;
    }
    let map = array_to_map(elements);
    let [min_x, min_y, max_x, max_y] = get_common_bounds(elements.iter(), &map);
    let (dx, dy) = (
        o.scene_point[0] - (max_x - min_x) / 2.,
        o.scene_point[1] - (max_y - min_y) / 2.,
    );
    let [gx, gy] = get_grid_point(dx, dy, o.grid_size);
    let moved: Vec<Element> = elements
        .iter()
        .map(|e| {
            new_element_with(
                e,
                |e| {
                    e.x += gx - min_x;
                    e.y += gy - min_y;
                },
                false,
            )
        })
        .collect();
    let dup = duplicate_elements(
        &moved,
        DuplicateMode::Everything {
            preserve_frame_children_order: o.preserve_frame_children_order,
        },
        !o.retain_seed,
        None,
        o.hooks,
    );
    let duplicated = dup.duplicated_elements;
    let ids: Vec<String> = duplicated.iter().map(|e| e.id.clone()).collect();
    let set: FxHashSet<String> = ids.iter().cloned().collect();
    let mut next: Vec<Element> = scene.elements_including_deleted().to_vec();
    next.extend(duplicated.iter().cloned());
    sync_moved_indices(&mut next, &set);
    if let Some(frame_id) = o.top_layer_frame
        && let Some(frame) = scene.get_element(frame_id).cloned()
    {
        let eligible: Vec<String> = {
            let m = array_to_map(&next);
            filter_elements_eligible_as_frame_children(&duplicated, &frame, &m)
                .iter()
                .map(|e| e.id.clone())
                .collect()
        };
        add_elements_to_frame(&mut next, &eligible, frame_id);
    }
    scene.replace_all_elements(next);
    for id in &ids {
        let Some(t) = scene
            .get_element(id)
            .filter(|e| e.is_text() && e.is_bound_to_container())
            .cloned()
        else {
            continue;
        };
        let c = t.container_id().map(str::to_owned);
        redraw_text_bounding_box(scene, &t, c.as_deref(), o.measure);
    }
    if let Some(files) = files {
        add_missing_files(files_store, files);
    }
    let all = scene.elements_including_deleted();
    let dups: Vec<&Element> = ids
        .iter()
        .filter_map(|id| all.iter().find(|e| &e.id == id))
        .collect();
    let targets = exclude_elements_in_frames_from_selection(&dups);
    let selection = get_selection_state_for_elements(&targets, all, app, false);
    Some(PasteResult {
        duplicated: ids,
        selection,
    })
}

/// `addMissingFiles`: files not known yet (or known without data) are added.
pub fn add_missing_files(
    store: &mut BTreeMap<String, FileData>,
    files: &BTreeMap<String, FileData>,
) {
    for (id, f) in files {
        if store
            .get(id)
            .is_none_or(|s| s.data_url.is_none() && s.path.is_none())
        {
            store.insert(id.clone(), f.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// pasting text
// ---------------------------------------------------------------------------

/// `addTextFromPaste`'s elements: one text element per non-empty line
/// (the whole text when `is_plain_paste`), centered on the point and
/// stacked 10px apart (a blank line leaves a line's space), wrapped past
/// `max_text_width` (`getMaxTextWidth`). `frame_at`: the top-layer frame at
/// a point.
pub fn text_elements_from_paste(
    text: &str,
    is_plain_paste: bool,
    at: Point,
    app: &AppState,
    max_text_width: f64,
    m: &dyn Measure,
    frame_at: &dyn Fn(Point) -> Option<String>,
) -> Vec<Element> {
    const LINE_GAP: f64 = 10.;
    let font = Font::new(app.current_item_font_size, app.current_item_font_family);
    let line_height = get_line_height(font.family);
    let lines: Vec<&str> = if is_plain_paste {
        vec![text]
    } else {
        text.split('\n').collect()
    };
    let mut y = at[1];
    let mut out = vec![];
    for (i, line) in lines.iter().enumerate() {
        let original = normalize_text(line).trim().to_string();
        if original.is_empty() {
            // a paragraph, but no more than one empty line
            if i > 0 && !lines[i - 1].trim().is_empty() {
                y += get_line_height_in_px(font.size, line_height) + LINE_GAP;
            }
            continue;
        }
        let mut metrics = measure_text(m, &original, font, line_height);
        let unwrapped = metrics.width > max_text_width;
        let text = if unwrapped {
            wrap_text(m, &original, font, max_text_width)
        } else {
            original.clone()
        };
        if unwrapped {
            metrics = measure_text(m, &text, font, line_height);
        }
        let e = new_text_element(
            TextOpts {
                text,
                original_text: Some(original),
                font_size: Some(font.size),
                font_family: Some(font.family),
                line_height: Some(line_height),
                text_align: Some(TextAlign::Left),
                vertical_align: Some(VerticalAlign::Top),
                auto_resize: Some(!unwrapped),
                ..Default::default()
            },
            ElementOpts {
                x: at[0] - metrics.width / 2.,
                y: y - metrics.height / 2.,
                stroke_color: app.current_item_stroke_color.clone(),
                background_color: app.current_item_background_color.clone(),
                fill_style: app.current_item_fill_style,
                stroke_width: app.current_item_stroke_width(false),
                stroke_style: app.current_item_stroke_style,
                roundness: None,
                roughness: app.current_item_roughness,
                opacity: app.current_item_opacity,
                locked: false,
                frame_id: frame_at([at[0], y]),
                ..Default::default()
            },
            m,
        );
        y += e.height + LINE_GAP;
        out.push(e);
    }
    out
}

// ---------------------------------------------------------------------------
// dropping files
// ---------------------------------------------------------------------------

/// A dropped file.
#[derive(Clone, Copy, Debug)]
pub struct DroppedFile<'a> {
    pub name: &'a str,
    pub mime_type: &'a str,
    pub bytes: &'a [u8],
}

/// What a drop does (`handleAppOnDrop`'s routing for files).
#[derive(Clone, Debug, PartialEq)]
pub enum DropContent {
    /// A lone PNG / SVG with a scene in it: replaces the scene (or, with a
    /// drop position, is pasted there with `retain_seed`).
    Scene(SceneData),
    /// Image files to insert (indices).
    Images(Vec<usize>),
    /// The first file, to load as a scene file (`loadFileToCanvas`).
    SceneFile(SceneData),
    Error(LoadError),
    Nothing,
}

/// `handleAppOnDrop` for files. Mime types are normalized as
/// `normalizeFile` does.
pub fn route_drop(files: &[DroppedFile], local_elements: Option<&dyn ElementsMap>) -> DropContent {
    let mimes: Vec<String> = files
        .iter()
        .map(|f| super::image::normalize_file_mime_type(f.name, f.mime_type, f.bytes))
        .collect();
    let opts = RestoreOpts::load();
    if files.len() == 1 && (mimes[0] == mime::PNG || mimes[0] == mime::SVG) {
        match load_from_blob(
            files[0].bytes,
            &mimes[0],
            files[0].name,
            None,
            local_elements,
            &opts,
        ) {
            Ok(s) => return DropContent::Scene(s),
            // an image without a scene: inserted as an image below
            Err(LoadError::ImageWithoutScene) => {}
            Err(e) => return DropContent::Error(e),
        }
    }
    let images: Vec<usize> = mimes
        .iter()
        .enumerate()
        .filter(|(_, m)| is_supported_image_file_type(m))
        .map(|(i, _)| i)
        .collect();
    if !images.is_empty() {
        return DropContent::Images(images);
    }
    let Some(f) = files.first() else {
        return DropContent::Nothing;
    };
    match load_from_blob(f.bytes, &mimes[0], f.name, None, local_elements, &opts) {
        Ok(s) => DropContent::SceneFile(s),
        Err(e) => DropContent::Error(e),
    }
}
