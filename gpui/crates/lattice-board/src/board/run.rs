// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! `BoardView::run`: every `BoardAction` through core's `actions/*` (one
//! function per upstream action), recorded per its `captureUpdate`, plus
//! what upstream's action manager does around them: undo / redo with the
//! history hooks, the clipboard (`actionClipboard.tsx`, `App.clipboard.ts`:
//! the `excalidraw/clipboard` JSON as text, which excalidraw.com pastes;
//! pasted text, HTML and images), copy / paste styles, grid and snapping.

use super::BoardView;
use super::action::{BoardAction, End, Layer};
use super::actions::*;
use super::align::Alignment;
use super::app_state::{StrokeRoundness, StrokeWidthKey, ToolType};
use super::binding::BindingHistoryHooks;
use super::clipboard::{
    PasteContent, PasteOpts, add_elements_from_paste_or_library, copy_to_clipboard,
    get_elements_to_copy, parse_clipboard, restore_pasted_elements, route_paste,
    text_elements_from_paste,
};
use super::history::CaptureUpdateAction;
use super::selection::{SelectedOpts, get_selected_elements};
use super::text::TextHooks;
use super::text::get_text_from_elements;
use super::types::StartOrEnd;
use super::{FIT_OFFSETS, Hooks};
use gpui::*;

pub fn run(me: &mut BoardView, a: BoardAction, window: &mut Window, cx: &mut Context<BoardView>) {
    // viewport-only actions: no element copy, no store commit (its diff is
    // linear in the scene; the viewport isn't recorded anyway)
    match a {
        BoardAction::ZoomIn => return me.zoom_in(cx),
        BoardAction::ZoomOut => return me.zoom_out(cx),
        BoardAction::ResetZoom => return me.reset_zoom(cx),
        BoardAction::ZoomToFit => return me.zoom_to_fit(cx),
        BoardAction::ZoomToSelection => {
            let r = action_zoom_to_fit_selection(
                me.scene.elements_including_deleted(),
                &me.app,
                me.canvas(),
                Some(FIT_OFFSETS),
                None,
            );
            if let Some(n) = r.app_state {
                me.set_viewport(n.viewport(), cx);
            }
            return;
        }
        BoardAction::FindOnCanvas => return me.toggle_search(window, cx),
        BoardAction::ExportImage => return me.toggle_export_image(cx),
        BoardAction::ShowHelp => {
            me.help = !me.help;
            cx.notify();
            return;
        }
        _ => {}
    }
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    // style changes reach the text being edited; others end it first
    let style = matches!(
        a,
        BoardAction::StrokeColor(_)
            | BoardAction::BackgroundColor(_)
            | BoardAction::FontSize(_)
            | BoardAction::FontFamily(_)
            | BoardAction::TextAlign(_)
            | BoardAction::VerticalAlign(_)
            | BoardAction::Opacity(_)
    );
    if !style {
        me.finish_pending(window, cx);
    }
    // a pick applies to the elements as they were, not the preview
    if matches!(a, BoardAction::FontFamily(_)) {
        font_restore(me, cx);
    }
    let (els, app) = (
        me.scene.elements_including_deleted().to_vec(),
        me.app.clone(),
    );
    let r = match a {
        BoardAction::Undo | BoardAction::Redo => {
            history(me, a == BoardAction::Undo, cx);
            return;
        }
        BoardAction::SelectAll => action_select_all(&els, &app),
        BoardAction::Deselect => action_deselect(&els, &app),
        BoardAction::Delete => action_delete_selected(&els, &app, false),
        BoardAction::Duplicate => action_duplicate_selection(&els, &app, &hooks),
        BoardAction::Copy => {
            copy(me, cx);
            return;
        }
        BoardAction::CopyAsSvg => {
            copy_picture(me, false, cx);
            return;
        }
        BoardAction::CopyAsPng => {
            copy_picture(me, true, cx);
            return;
        }
        BoardAction::Cut => {
            copy(me, cx);
            action_delete_selected(&els, &app, false)
        }
        BoardAction::Paste => {
            paste(me, false, window, cx);
            return;
        }
        BoardAction::CopyStyles => {
            me.copied_styles = action_copy_styles(&els, &app);
            return;
        }
        BoardAction::PasteStyles => {
            action_paste_styles(&els, &app, &me.copied_styles.clone(), &*m, &hooks)
        }
        BoardAction::Group => action_group(&els, &app),
        BoardAction::Ungroup => action_ungroup(&els, &app),
        BoardAction::Layer(Layer::Forward) => action_bring_forward(&els, &app),
        BoardAction::Layer(Layer::Backward) => action_send_backward(&els, &app),
        BoardAction::Layer(Layer::Front) => action_bring_to_front(&els, &app),
        BoardAction::Layer(Layer::Back) => action_send_to_back(&els, &app),
        BoardAction::Align(axis, position) => {
            action_align(&els, &app, Alignment { position, axis }, &hooks)
        }
        BoardAction::Distribute(axis) => action_distribute(&els, &app, axis, &hooks),
        BoardAction::FlipHorizontal => action_flip_horizontal(&els, &app, &*m, &hooks),
        BoardAction::FlipVertical => action_flip_vertical(&els, &app, &*m, &hooks),
        BoardAction::ToggleLock => action_toggle_element_lock(&els, &app),
        BoardAction::UnlockAll => action_unlock_all_elements(&els, &app),
        BoardAction::ToggleCrop => {
            // `actionToggleCropEditor`
            let sel = me.selected_elements();
            if me.app.cropping_element_id.is_some() || sel.len() != 1 || !sel[0].is_image() {
                return;
            }
            let mut a = app.clone();
            (a.is_cropping, a.cropping_element_id) = (false, Some(sel[0].id.clone()));
            ActionResult::new(None, Some(a), CaptureUpdateAction::Immediately)
        }
        BoardAction::FrameFromSelection => action_wrap_selection_in_frame(&els, &app),
        BoardAction::RemoveFromFrame => action_remove_all_elements_from_frame(&els, &app),
        BoardAction::StrokeColor(c) => action_change_stroke_color(&els, &app, &c),
        BoardAction::BackgroundColor(c) => action_change_background_color(&els, &app, &c),
        BoardAction::ViewBackgroundColor(c) => action_change_view_background_color(&app, &c),
        BoardAction::CopyText => {
            let sel: Vec<_> = get_selected_elements(
                &els,
                &app.selected_element_ids,
                SelectedOpts {
                    include_bound_text_element: true,
                    ..Default::default()
                },
            )
            .into_iter()
            .cloned()
            .collect();
            write_clipboard(get_text_from_elements(&sel, "\n\n"), cx);
            return;
        }
        BoardAction::SelectAllInFrame => action_select_all_elements_in_frame(&els, &app),
        BoardAction::TextAutoResize => action_text_auto_resize(&els, &app, None, &*m, &hooks),
        BoardAction::UnbindText | BoardAction::BindText | BoardAction::WrapTextInContainer => {
            bound_text(me, a, cx);
            return;
        }
        BoardAction::FillStyle(f) => action_change_fill_style(&els, &app, f),
        BoardAction::StrokeWidth(w) => action_change_stroke_width(
            &els,
            &app,
            if w <= 1. {
                StrokeWidthKey::Thin
            } else if w <= 2. {
                StrokeWidthKey::Medium
            } else {
                StrokeWidthKey::Bold
            },
        ),
        BoardAction::StrokeStyle(s) => action_change_stroke_style(&els, &app, s),
        BoardAction::Roughness(r) => action_change_sloppiness(&els, &app, r),
        BoardAction::ClearCanvas => action_clear_canvas(&els, &app),
        BoardAction::Opacity(o) => action_change_opacity(&els, &app, o),
        BoardAction::FontSize(s) => action_change_font_size(&els, &app, s, &*m, &hooks),
        BoardAction::FontFamily(f) => action_change_font_family(&els, &app, f, false, &*m, &hooks),
        BoardAction::TextAlign(t) => action_change_text_align(&els, &app, t, &*m, &hooks),
        BoardAction::VerticalAlign(v) => action_change_vertical_align(&els, &app, v, &*m, &hooks),
        BoardAction::Roundness(r) => action_change_roundness(
            &els,
            &app,
            if r {
                StrokeRoundness::Round
            } else {
                StrokeRoundness::Sharp
            },
        ),
        BoardAction::Arrowhead(end, h) => action_change_arrowhead(
            &els,
            &app,
            if end == End::Start {
                StartOrEnd::Start
            } else {
                StartOrEnd::End
            },
            h,
        ),
        BoardAction::ArrowType(t) => action_change_arrow_type(&els, &app, t),
        BoardAction::ZoomIn
        | BoardAction::ZoomOut
        | BoardAction::ResetZoom
        | BoardAction::ZoomToFit
        | BoardAction::ZoomToSelection
        | BoardAction::ShowHelp
        | BoardAction::FindOnCanvas
        | BoardAction::ExportImage => unreachable!(),
        BoardAction::ToggleGrid => {
            let mut a = app.clone();
            a.grid_mode_enabled = !a.grid_mode_enabled;
            a.objects_snap_mode_enabled = false;
            ActionResult::new(None, Some(a), CaptureUpdateAction::Eventually)
        }
        BoardAction::ToggleSnap => {
            let mut a = app.clone();
            a.objects_snap_mode_enabled = !a.objects_snap_mode_enabled;
            a.grid_mode_enabled = false;
            ActionResult::new(None, Some(a), CaptureUpdateAction::Eventually)
        }
        BoardAction::ToggleArrowBinding => {
            let mut a = app.clone();
            a.binding_preference = !a.binding_preference;
            a.is_binding_enabled = a.binding_preference;
            ActionResult::new(None, Some(a), CaptureUpdateAction::Never)
        }
        BoardAction::ToggleMidpointSnapping => {
            let mut a = app.clone();
            a.is_midpoint_snapping_enabled = !a.is_midpoint_snapping_enabled;
            ActionResult::new(None, Some(a), CaptureUpdateAction::Never)
        }
        BoardAction::ToggleToolLock => {
            // `toggleLock`: locking a selection tool switches to it (upstream
            // locks the current tool, and never the eraser / hand / lasso)
            let mut a = app.clone();
            a.active_tool.locked = !a.active_tool.locked;
            ActionResult::new(None, Some(a), CaptureUpdateAction::Eventually)
        }
        BoardAction::InsertImage => {
            me.set_tool(super::action::Tool::Image, window, cx);
            return;
        }
        BoardAction::ToggleLinearEditor => {
            let sel = me.selected_elements();
            if !super::linear::can_toggle_linear_editor(&sel, me.linear.as_ref())
                && !me.linear.as_ref().is_some_and(|l| l.is_editing)
            {
                return;
            }
            let id = me
                .linear
                .as_ref()
                .map(|l| l.element_id.clone())
                .or_else(|| sel.first().map(|e| e.id.clone()));
            let l = me.linear.clone().or_else(|| {
                id.and_then(|id| super::linear::LinearElementEditor::new(&id, &mut me.scene, false))
            });
            me.set_linear(l.map(|l| super::linear::toggle_linear_editor(&l)));
            me.commit(Some(CaptureUpdateAction::Immediately), cx);
            return;
        }
    };
    let mut r = r;
    if me.sliding() {
        r.capture_update = CaptureUpdateAction::Eventually;
    }
    me.apply(r, cx);
    // the editor follows style changes
    if style && let Some(t) = &mut me.text {
        t.restyle = true;
    }
}

/// The font list's hover (`onHover` / `onLeave`): back to the elements as
/// they were when it opened, then (`Some`) the hovered family previewed on
/// the selection, uncaptured.
pub(crate) fn font_preview(me: &mut BoardView, family: Option<u32>, cx: &mut Context<BoardView>) {
    font_restore(me, cx);
    let Some(f) = family else { return };
    if me.font_cache.is_none() {
        return;
    }
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let r = action_change_font_family(
        me.scene.elements_including_deleted(),
        &me.app,
        f,
        true,
        &*m,
        &hooks,
    );
    me.apply(r, cx);
    me.font_previewing = true;
}

/// Undoes a preview: the elements it changed go back to their cached state.
pub(crate) fn font_restore(me: &mut BoardView, cx: &mut Context<BoardView>) {
    if !std::mem::take(&mut me.font_previewing) {
        return;
    }
    let Some(cache) = me.font_cache.as_ref() else {
        return;
    };
    let changed: Vec<super::types::Element> = cache
        .iter()
        .filter(|c| {
            me.scene
                .get_element(&c.id)
                .is_some_and(|e| e.version != c.version || e.version_nonce != c.version_nonce)
        })
        .cloned()
        .collect();
    for c in changed {
        me.scene
            .mutate_element(&c.id.clone(), true, move |e| *e = c);
    }
    me.commit(Some(CaptureUpdateAction::Eventually), cx);
}

/// `actionBoundText.tsx`: unbind the selection's labels (the freed texts
/// join the selection), bind a text to a container, or wrap free texts in
/// new rectangles (selected).
fn bound_text(me: &mut BoardView, a: BoardAction, cx: &mut Context<BoardView>) {
    use super::text::{
        bind_text_pair, bind_text_to_container, can_bind_text, unbind_text,
        wrap_texts_in_containers,
    };
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let sel: Vec<String> = me
        .selected_elements()
        .iter()
        .map(|e| e.id.clone())
        .collect();
    let select: Vec<String> = match a {
        BoardAction::UnbindText => {
            let mut freed = vec![];
            for id in &sel {
                let sticky = me.scene.get_element(id).is_some_and(|e| e.is_sticky_note());
                if let Some(t) = unbind_text(&mut me.scene, id, &*m) {
                    freed.push(t);
                    if sticky {
                        super::binding::update_bound_elements(
                            id,
                            &mut me.scene,
                            &Default::default(),
                            &hooks,
                        );
                    }
                }
            }
            if freed.is_empty() {
                return;
            }
            sel.into_iter().chain(freed).collect()
        }
        BoardAction::BindText => {
            let pair = {
                let s = me.selected_elements();
                can_bind_text(&s, &me.scene)
                    .then(|| bind_text_pair(&s))
                    .flatten()
            };
            let Some((t, c)) = pair else { return };
            bind_text_to_container(&mut me.scene, &t, &c, &*m);
            vec![c]
        }
        _ => {
            let texts: Vec<String> = me
                .selected_elements()
                .iter()
                .filter(|e| e.is_text() && !e.is_bound_to_container())
                .map(|e| e.id.clone())
                .collect();
            if texts.is_empty() {
                return;
            }
            // upstream rounds per the default app state, not the current item's
            wrap_texts_in_containers(
                &mut me.scene,
                &texts,
                super::app_state::AppState::default().current_item_roundness
                    == StrokeRoundness::Round,
                &*m,
            )
        }
    };
    let els = me.scene.elements_including_deleted().to_vec();
    let targets: Vec<&super::types::Element> = select
        .iter()
        .filter_map(|id| els.iter().find(|e| e.id == *id && !e.is_deleted))
        .collect();
    if a == BoardAction::WrapTextInContainer {
        me.app.selected_element_ids = select.iter().cloned().collect();
        me.app.selected_group_ids.clear();
    } else {
        super::selection::get_selection_state_for_elements(&targets, &els, &me.app, false)
            .apply(&mut me.app);
    }
    me.sync_linear();
    me.commit(Some(CaptureUpdateAction::Immediately), cx);
}

/// ⌘Z / ⇧⌘Z: not mid-gesture or while editing text.
fn history(me: &mut BoardView, undo: bool, cx: &mut Context<BoardView>) {
    if me.gesture.is_some() || me.text.is_some() || me.multi.is_some() {
        return;
    }
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let mut hh = BindingHistoryHooks {
        text: TextHooks(&*m),
        hooks: &hooks,
    };
    let els = me.scene.elements_including_deleted().to_vec();
    let out = if undo {
        me.history.undo(&mut me.store, &els, &me.app, &mut hh)
    } else {
        me.history.redo(&mut me.store, &els, &me.app, &mut hh)
    };
    let Some((next, app)) = out else { return };
    me.scene.replace_all_elements(next);
    // undo restores the observed part (selection, editing group, line editor)
    let vp = me.app.viewport();
    let keep = me.app.clone();
    me.app = super::app_state::AppState {
        active_tool: keep.active_tool,
        scroll_x: vp.scroll_x,
        scroll_y: vp.scroll_y,
        zoom: vp.zoom,
        ..app
    };
    me.sync_linear();
    me.commit(Some(CaptureUpdateAction::Never), cx);
}

/// Writes text where the next paste reads it: the harness's stand-in
/// clipboard when a script set one, else the system clipboard.
fn write_clipboard(text: String, cx: &mut Context<BoardView>) {
    cx.write_to_clipboard(ClipboardItem::new_string(text));
}

/// `actionCopy`: the selection (with labels and frame children) and its
/// files as `excalidraw/clipboard` JSON.
fn copy(me: &mut BoardView, cx: &mut Context<BoardView>) {
    let els = me.scene.elements_including_deleted();
    let sel = get_elements_to_copy(els, &me.app);
    if sel.is_empty() {
        return;
    }
    let out = copy_to_clipboard(&sel, Some(&me.files));
    if let Some((_, json)) = out
        .into_iter()
        .find(|(t, _)| *t == super::image::mime::TEXT)
    {
        write_clipboard(json, cx);
    }
}

/// `actionCopyAsSvg` / `actionCopyAsPng` (`exportCanvas("clipboard-svg" |
/// "clipboard")`): the selection with its labels and frame children, or
/// the whole board, as an SVG (text) or a 2× PNG (image). Unlike upstream's
/// clipboard copies the scene goes along (the SVG `<metadata>` payload, the
/// PNG `tEXt` chunk, as its file exports embed it), so pasting the picture
/// back gives the elements.
fn copy_picture(me: &mut BoardView, png: bool, cx: &mut Context<BoardView>) {
    let selected = !me.app.selected_element_ids.is_empty();
    let Some((svg, scene)) = picture(me, selected, true, false) else {
        return;
    };
    if !png {
        write_clipboard(embed_in_svg(&svg, &scene), cx);
        return;
    }
    let Some(bytes) = rasterize(&svg, 2., false)
        .and_then(|p| super::encode::encode_png_metadata(&p, &scene).ok())
    else {
        return;
    };
    let img = Image::from_bytes(ImageFormat::Png, bytes);
    cx.write_to_clipboard(ClipboardItem::new_image(&img));
}

/// \`svg\` with \`scene\` in its \`<metadata>\` (\`exportEmbedScene\`).
pub(crate) fn embed_in_svg(svg: &str, scene: &str) -> String {
    svg.replacen(
        "<metadata></metadata>",
        &format!(
            "<metadata>{}</metadata>",
            super::encode::encode_svg_base64_payload(scene)
        ),
        1,
    )
}

/// The selection with its labels and frame children (\`selected\`), or the
/// whole board, as an SVG (\`exportToSvg\`; \`background\`: the canvas color
/// painted, \`dark\`: upstream's dark filter on the root) and its scene JSON;
/// None when there is nothing to draw.
pub(crate) fn picture(
    me: &BoardView,
    selected: bool,
    background: bool,
    dark: bool,
) -> Option<(String, String)> {
    let all = me.scene.elements_including_deleted();
    let els: Vec<super::types::Element> = if selected {
        get_elements_to_copy(all, &me.app)
            .into_iter()
            .cloned()
            .collect()
    } else {
        me.scene.non_deleted_elements().cloned().collect()
    };
    if els.is_empty() {
        return None;
    }
    let used: rustc_hash::FxHashSet<&str> = els
        .iter()
        .filter_map(|e| e.image().and_then(|i| i.file_id.as_deref()))
        .collect();
    let files: std::collections::BTreeMap<_, _> = me
        .files
        .iter()
        .filter(|(k, _)| used.contains(k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let bd = crate::whiteboard::Board {
        elements: els,
        files,
        app: me.app.for_export(),
    };
    let href = |f: &super::types::FileData| -> Option<String> { f.data_url.clone() };
    let scene = super::json::serialize_as_json(
        &bd.elements,
        &bd.app,
        &bd.files,
        crate::whiteboard::FILE_SOURCE,
    );
    let opts = super::export_svg::SvgExportOpts {
        background: bd.app.view_background_color.clone(),
        paint_background: background,
        dark,
        image_href: Some(&href),
        ..Default::default()
    };
    Some((
        super::export_svg::export_to_svg(&bd.elements, &bd.files, &*me.m, &opts),
        scene,
    ))
}

/// An SVG drawn at `scale` as PNG bytes; `dark`: through upstream's dark
/// filter, pixel by pixel (`applyDarkModeFilter`, as the export canvas's
/// `filter` draws it).
pub(crate) fn rasterize(svg: &str, scale: f32, dark: bool) -> Option<Vec<u8>> {
    let mut o = resvg::usvg::Options::default();
    o.fontdb_mut().load_system_fonts();
    super::fonts::load_into(o.fontdb_mut());
    let tree = resvg::usvg::Tree::from_str(svg, &o).ok()?;
    let size = tree.size();
    let mut pm = resvg::tiny_skia::Pixmap::new(
        (size.width() * scale).ceil() as u32,
        (size.height() * scale).ceil() as u32,
    )?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pm.as_mut(),
    );
    // tiny-skia keeps premultiplied pixels
    let px: Vec<u8> = pm
        .pixels()
        .iter()
        .flat_map(|p| {
            let c = p.demultiply();
            if dark {
                let d = super::color::apply_dark_mode_filter(super::color::Rgba {
                    r: c.red(),
                    g: c.green(),
                    b: c.blue(),
                    a: c.alpha(),
                });
                return [d.r, d.g, d.b, d.a];
            }
            [c.red(), c.green(), c.blue(), c.alpha()]
        })
        .collect();
    let img = image::RgbaImage::from_raw(pm.width(), pm.height(), px)?;
    let mut out = std::io::Cursor::new(vec![]);
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// A scene from a file or a picture put in at `at` (`addElementsFromPasteOrLibrary`).
pub fn insert_scene(
    me: &mut BoardView,
    els: &[super::types::Element],
    files: Option<&std::collections::BTreeMap<String, super::types::FileData>>,
    at: [f64; 2],
    retain_seed: bool,
    cx: &mut Context<BoardView>,
) {
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let frame = me.top_frame_at(at, &Default::default());
    let o = PasteOpts {
        scene_point: at,
        grid_size: me.grid(Default::default()),
        retain_seed,
        preserve_frame_children_order: false,
        top_layer_frame: frame.as_deref(),
        measure: &*m,
        hooks: &hooks,
    };
    let app = me.app.clone();
    if let Some(r) =
        add_elements_from_paste_or_library(&mut me.scene, &mut me.files, els, files, &app, &o)
    {
        r.selection.apply(&mut me.app);
        me.sync_linear();
        me.app.active_tool = update_active_tool(&me.app, ToolType::Selection);
        me.commit(Some(CaptureUpdateAction::Immediately), cx);
    }
}

/// The scene embedded in a pasted PNG or SVG (`loadFromBlob`), if any.
fn embedded_scene(bytes: &[u8], mime: &str) -> Option<super::restore::SceneData> {
    super::restore::load_from_blob(
        bytes,
        mime,
        "",
        None,
        None,
        &super::restore::RestoreOpts::load(),
    )
    .ok()
}

/// ⌘V (⇧⌘V: text as one element): elements, images, text.
pub fn paste(me: &mut BoardView, plain: bool, window: &mut Window, cx: &mut Context<BoardView>) {
    me.finish_pending(window, cx);
    // GPUI reads no HTML from the clipboard, so a paste is its text and images
    let item = cx.read_from_clipboard();
    let text = item.as_ref().and_then(|i| i.text());
    let images: Vec<Image> = item
        .map(|i| {
            i.entries()
                .iter()
                .filter_map(|e| {
                    if let ClipboardEntry::Image(img) = e {
                        Some(img.clone())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let html: Option<String> = None;
    let data = parse_clipboard(text.as_deref(), html.as_deref(), plain);
    let mimes: Vec<&str> = images.iter().map(|i| i.format.mime_type()).collect();
    let at = me.scene_point(me.pointer);
    let at = if me.bounds.get().contains(&me.pointer) {
        at
    } else {
        let c = me.canvas();
        me.scene_point(point(
            px((c.offset_left + c.width / 2.) as f32),
            px((c.offset_top + c.height / 2.) as f32),
        ))
    };
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    match route_paste(&data, &mimes, plain) {
        PasteContent::Elements {
            elements,
            files,
            skeletons,
        } => {
            let els = if skeletons {
                super::transform::convert_to_excalidraw_elements(
                    &elements,
                    &super::transform::TransformOpts {
                        regenerate_ids: true,
                        measure: &*m,
                        hooks: &hooks,
                    },
                )
                .unwrap_or_default()
            } else {
                restore_pasted_elements(&elements)
            };
            let files = files
                .as_ref()
                .map(|f| super::restore::restore_files(Some(f)));
            insert_scene(me, &els, files.as_ref(), at, plain, cx);
        }
        PasteContent::ImageFiles(ix) => {
            // a lone PNG with a scene in it pastes the scene (`insertClipboardContent`)
            if let [i] = ix.as_slice()
                && let Some(img) = images.get(*i).filter(|i| i.format == ImageFormat::Png)
                && let Some(s) = embedded_scene(&img.bytes, super::image::mime::PNG)
            {
                insert_scene(me, &s.elements, Some(&s.files), at, false, cx);
                return;
            }
            let imgs: Vec<(Vec<u8>, String, Option<String>)> = ix
                .into_iter()
                .filter_map(|i| images.get(i))
                .map(|img| {
                    (
                        img.bytes.clone(),
                        img.format
                            .mime_type()
                            .rsplit('/')
                            .next()
                            .unwrap_or("png")
                            .replace("jpeg", "jpg")
                            .replace("svg+xml", "svg"),
                        None,
                    )
                })
                .collect();
            super::tools::image::insert_images(me, imgs, at, window, cx);
        }
        PasteContent::Text(t) => paste_text(me, &t, plain, at, cx),
        PasteContent::MixedContent(items) => {
            let t: Vec<String> = items
                .into_iter()
                .filter_map(|i| {
                    if let super::clipboard::MixedItem::Text(t) = i {
                        Some(t)
                    } else {
                        None
                    }
                })
                .collect();
            paste_text(me, &t.join("\n"), plain, at, cx);
        }
        PasteContent::SvgText(t) => match embedded_scene(t.as_bytes(), super::image::mime::SVG) {
            Some(s) => insert_scene(me, &s.elements, Some(&s.files), at, false, cx),
            // (upstream inserts other SVG code as an SVG image, which our pictures can't show)
            None => paste_text(me, &t, true, at, cx),
        },
        PasteContent::Nothing => {}
    }
}

fn paste_text(me: &mut BoardView, t: &str, plain: bool, at: [f64; 2], cx: &mut Context<BoardView>) {
    let m = me.m.clone();
    let pad = super::consts::TEXT_VIEWPORT_PADDING;
    let max = super::text_edit::get_max_text_width(me.canvas().width, pad, pad, me.app.zoom);
    let frames = |p: [f64; 2]| me.top_frame_at(p, &Default::default());
    let els = text_elements_from_paste(t, plain, at, &me.app, max, &*m, &frames);
    if els.is_empty() {
        return;
    }
    let ids: Vec<String> = els.iter().map(|e| e.id.clone()).collect();
    me.scene.insert_elements_at_index(els, None);
    super::tools::selection::select_only(me, &ids, false);
    me.app.active_tool = update_active_tool(&me.app, ToolType::Selection);
    me.commit(Some(CaptureUpdateAction::Immediately), cx);
}

/// ⇧⌘> / ⇧⌘<.
pub fn font_step(
    me: &mut BoardView,
    bigger: bool,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) {
    let _ = window;
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let els = me.scene.elements_including_deleted().to_vec();
    let r = if bigger {
        action_increase_font_size(&els, &me.app, &*m, &hooks)
    } else {
        action_decrease_font_size(&els, &me.app, &*m, &hooks)
    };
    me.apply(r, cx);
}
