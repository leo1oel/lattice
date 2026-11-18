// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The GPUI backend of the board's display list (docs/design/whiteboard-
//! excalidraw.md, 渲染方案 1). Port of the drawing loop of Excalidraw
//! `renderer/staticScene.ts` @ 3a317b5 (`_renderStaticScene`: canvas fill,
//! visible elements only, frame clips) drawing `display.rs` items: paths with
//! `PathBuilder`, text with the GPUI text system, images through the
//! document picture cache.
//!
//! Caches, per element: its display list (rebuilt when its `version` /
//! `versionNonce`, or its container's for bound text, changes) and its
//! tessellated paths at a zoom bucket (quarter octaves), redrawn by
//! `Path::transformed` while panning and between buckets.
//!
//! Lattice draws with this GPUI painter only: quiet.md's vello_cpu painter
//! for big scenes (a CPU frame uploaded whole every change) is left out.
//!
//! Colors go through upstream's dark-mode filter in the dark theme
//! (`color`, `paint_color`: `color::apply_dark_mode_filter`, as Excalidraw
//! applies `applyDarkModeFilter` to every canvas color, the canvas included);
//! `Paint::CanvasBackground` is the board's canvas color as drawn.
//!
//! Text is in Excalidraw's fonts (`fonts.rs`), each line placed at
//! upstream's alphabetic baseline (`getVerticalOffset`, from the family's
//! `FONT_METADATA`).
//!
//! GPUI can't rotate text or images, nor clip but to axis-aligned
//! rectangles: rotated text is drawn as an SVG sprite (the outlines of the
//! glyphs GPUI shaped) under a rotation matrix; rotated, mirrored or
//! frame-clipped images are resampled on the CPU (`render_geom.rs`, cached
//! per element and resolution octave); frame clips (rotated, rounded) and
//! arrow label holes are cut out of the tessellated paths triangle by
//! triangle. Text in a clipped frame is only clipped to the frame's bounding
//! box.

use super::bounds::get_element_bounds;
use super::color::Rgba as BRgba;
use super::display::{
    self as dl, DisplayItem, ElementDisplay, ImageItem, Paint, RenderOpts, element_display,
    renderable_elements,
};
use super::scene::Scene;
use super::shape::PathCmd;
use super::text_measure::{Font as BFont, Measure};
use super::types::{Element, FileData, TextAlign};
use crate::whiteboard::Board;
use gpui::*;
use rustc_hash::FxHashMap;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::{Arc, LazyLock, Mutex};

#[path = "render_geom.rs"]
mod geom;
/// `LATTICE_BOARD_PROF`: print each paint's element count and time.
fn profiling() -> bool {
    static P: LazyLock<bool> = LazyLock::new(|| std::env::var_os("LATTICE_BOARD_PROF").is_some());
    *P
}

/// Scene → screen: `screen = origin + scene * zoom` (upstream's
/// `(scene + scroll) * zoom + offset`, folded into `origin`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    pub zoom: f32,
    pub origin: Point<Pixels>,
}

impl View {
    pub fn to_screen(&self, p: [f64; 2]) -> Point<Pixels> {
        point(
            self.origin.x + px(p[0] as f32 * self.zoom),
            self.origin.y + px(p[1] as f32 * self.zoom),
        )
    }
    pub fn to_scene(&self, p: Point<Pixels>) -> [f64; 2] {
        [
            (f32::from(p.x - self.origin.x) / self.zoom) as f64,
            (f32::from(p.y - self.origin.y) / self.zoom) as f64,
        ]
    }
    /// The scene rectangle `r` (`[x1, y1, x2, y2]`) puts on screen.
    pub fn rect(&self, r: [f64; 4]) -> Bounds<Pixels> {
        Bounds::from_corners(self.to_screen([r[0], r[1]]), self.to_screen([r[2], r[3]]))
    }
}

fn run(len: usize, font: Font, color: Hsla) -> TextRun {
    TextRun {
        len,
        font,
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    }
}

/// A line's text runs: the family's font, Xiaolai for CJK (`fonts::runs`).
pub fn runs(text: &str, family: u32, color: Hsla) -> Vec<TextRun> {
    super::fonts::runs(text, family)
        .into_iter()
        .map(|(len, f)| run(len, f, color))
        .collect()
}

/// `Measure` with the GPUI text system.
pub struct GpuiMeasure(pub Rc<WindowTextSystem>);

thread_local! {
    /// The one measurer: core's char-width cache keys on its address.
    static MEASURE: std::cell::RefCell<Option<Rc<GpuiMeasure>>> = const { std::cell::RefCell::new(None) };
}

/// The long-lived measurer (made from the first window that asks).
pub fn measure(window: &Window) -> Rc<GpuiMeasure> {
    MEASURE.with(|m| {
        m.borrow_mut()
            .get_or_insert_with(|| Rc::new(GpuiMeasure(window.text_system().clone())))
            .clone()
    })
}
impl Measure for GpuiMeasure {
    fn line_width(&self, text: &str, font: BFont) -> f64 {
        if text.is_empty() {
            return 0.;
        }
        self.0
            .layout_line(
                text,
                px(font.size as f32),
                &runs(text, font.family, black()),
                None,
            )
            .width
            .into()
    }
}

fn hsla(c: BRgba, opacity: f64) -> Hsla {
    let mut h: Hsla = gpui::Rgba {
        r: c.r as f32 / 255.,
        g: c.g as f32 / 255.,
        b: c.b as f32 / 255.,
        a: c.a as f32 / 255.,
    }
    .into();
    h.a *= opacity as f32;
    h
}

/// A board color as drawn: in the dark theme through upstream's
/// `applyDarkModeFilter`, times `opacity`.
pub fn color(c: BRgba, opacity: f64) -> Hsla {
    hsla(
        if crate::theme::dark() {
            super::color::apply_dark_mode_filter(c)
        } else {
            c
        },
        opacity,
    )
}

/// What a display item's paint draws as (`display::theme_color`: a sticky
/// note's shadow and edge stay as they are).
pub fn paint_color(p: Paint, d: &ElementDisplay, canvas: Hsla) -> Hsla {
    match p {
        Paint::Color(c) => hsla(dl::theme_color(c, d.ty, crate::theme::dark()), d.opacity),
        Paint::CanvasBackground => {
            let mut h = canvas;
            h.a *= d.opacity as f32;
            h
        }
    }
}

/// `drawImagePlaceholder`'s box, times `opacity`.
pub fn placeholder_color(opacity: f64) -> Hsla {
    hsla(dl::image_placeholder_color(crate::theme::dark()), opacity)
}

/// The canvas color (`viewBackgroundColor`), as drawn.
pub fn canvas_color(_board: &Board) -> Hsla {
    crate::theme::canvas()
}

/// One tessellated path and what paints it.
struct Built {
    path: Path<Pixels>,
    paint: Paint,
}

struct Cached {
    key: (i64, i64, i64),
    /// The key `display` was made for, and how far the element has moved
    /// since (`moved_by`): `bounds` and `clip` follow at once, `display` and
    /// what's built from it when next painted (`settle`).
    base: (i64, i64, i64),
    off: [f64; 2],
    shown_off: [f64; 2],
    display: Option<Rc<ElementDisplay>>,
    /// Scene AABB, padded for strokes and frame labels.
    bounds: [f64; 4],
    paths: Option<(f32, Vec<Built>)>,
    /// Rotated text sprites (asset path, local box) by item index.
    sprites: Vec<Option<Option<(SharedString, [f64; 4])>>>,
    /// The frame clip as a scene polygon.
    clip: Option<Vec<geom::Pt>>,
    /// A resampled image (`render_geom::transform_image`) at a resolution:
    /// the bitmap and the scene rectangle it covers.
    image: Option<(f64, Option<(Arc<RenderImage>, [f64; 4])>)>,
}

/// Paints one board; owns its scene and caches. One per board view and per
/// thumbnail.
#[derive(Default)]
pub struct Painter {
    scene: Scene,
    version: Option<u64>,
    cache: FxHashMap<String, Cached>,
    /// The scene's bounds, once asked for (`Some(None)`: empty).
    content: Option<Option<[f64; 4]>>,
    /// Data-URL images decoded once, by file id.
    data_images: HashMap<String, Option<Arc<RenderImage>>>,
    /// Image pixels for resampling, by file id.
    sources: Sources,
    /// Resampled images replaced since the last paint (freed from the atlas then).
    trash: Vec<Arc<RenderImage>>,
    /// The live scene's nonce at the last paint.
    live: Option<i64>,
    /// The paint order (element index, bounds, fade) for a scene state.
    order: Option<Order>,
    /// The image being cropped (`appState.croppingElementId`): drawn over
    /// its whole uncropped image, faded. Set by the board canvas.
    pub cropping: Option<String>,
    /// The crop preview's resampled image (as `Cached::image`).
    preview: Option<(f64, Option<(Arc<RenderImage>, [f64; 4])>)>,
    /// A thumbnail (a still picture).
    thumb: bool,
    /// Leave frame names out (the board view draws them as screen-size
    /// labels, like upstream's DOM names; thumbnails draw them as exported).
    pub screen_frame_names: bool,
}

/// The paint order of the last scene state, and what it was built from:
/// while the element array keeps its shape (no element added, removed,
/// reordered or rebound) a few changed elements are patched in place, so
/// dragging one shape doesn't walk the whole board.
struct Order {
    /// Element count and buffer, and the fades.
    key: u64,
    list: Vec<(u32, [f64; 4], f32)>,
    /// Per element index: version and nonce, `order_sig`, place in `list`.
    vers: Vec<(i64, i64)>,
    sigs: Vec<u64>,
    pos: Vec<u32>,
}

/// What decides an element's place in the paint order (`renderable_elements`).
fn order_sig(e: &Element) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut k = rustc_hash::FxHasher::default();
    (
        &e.id,
        e.is_deleted,
        e.container_id(),
        e.bound_text_id(),
        e.is_iframe_like(),
        e.is_frame_like(),
        crate::board::utils::is_invisibly_small_element(e),
    )
        .hash(&mut k);
    k.finish()
}

/// The quarter octave at or below `zoom`: paths are tessellated there.
fn bucket(zoom: f32) -> f32 {
    2f32.powf((zoom.max(1e-3).log2() * 4.).floor() / 4.)
}

impl Painter {
    /// The common bounds of the scene as last synced (None when empty).
    pub fn content_bounds(&mut self) -> Option<[f64; 4]> {
        let s = &self.scene;
        *self.content.get_or_insert_with(|| {
            let els: Vec<&Element> = s.non_deleted_elements().collect();
            (!els.is_empty()).then(|| super::bounds::get_common_bounds(els, s))
        })
    }

    /// Brings the scene up to `board` (a no-op while its version holds).
    pub fn sync(&mut self, board: &Board) {
        let v = board.version();
        if self.version == Some(v) {
            return;
        }
        self.version = Some(v);
        self.scene = Scene::new(board.elements.clone());
        self.content = None;
        let live: std::collections::HashSet<&str> =
            board.elements.iter().map(|e| e.id.as_str()).collect();
        let trash = &mut self.trash;
        self.cache.retain(|id, c| {
            live.contains(id.as_str()) || {
                trash.extend(c.image.take().and_then(|i| i.1).map(|i| i.0));
                false
            }
        });
    }

    fn entry<'a>(
        cache: &'a mut FxHashMap<String, Cached>,
        trash: &mut Vec<Arc<RenderImage>>,
        e: &Element,
        scene: &Scene,
        m: &dyn Measure,
        opts: &RenderOpts,
    ) -> &'a mut Cached {
        let ver = |id: Option<&str>| {
            id.and_then(|c| scene.get_element(c))
                .map_or(0, |c| c.version ^ (c.version_nonce << 20))
        };
        // bound text follows its container, clipped elements their frame
        // arrows their label (the hole follows it)
        let key = (
            e.version,
            e.version_nonce,
            ver(e.container_id())
                ^ ver(e.frame_id.as_deref()).rotate_left(29)
                ^ ver(e.bound_text_id().filter(|_| e.is_arrow())).rotate_left(13),
        );
        let fresh = cache.get_mut(&e.id).is_some_and(|c| {
            c.key == key
                || moved_by(e, c.base, scene).is_some_and(|d| {
                    let s = [d[0] - c.off[0], d[1] - c.off[1]];
                    let b = &mut c.bounds;
                    *b = [b[0] + s[0], b[1] + s[1], b[2] + s[0], b[3] + s[1]];
                    for p in c.clip.iter_mut().flatten() {
                        p[0] += s[0];
                        p[1] += s[1];
                    }
                    (c.key, c.off) = (key, d);
                    true
                })
        });
        if !fresh {
            let display = element_display(e, scene, m, opts).map(Rc::new);
            let mut b = get_element_bounds(e, scene, false);
            let pad = e.stroke_width * 2. + 4.;
            b = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
            if e.is_frame_like() {
                b[1] -= 40.;
                b[2] = b[2].max(b[0] + 400.);
            }
            // arrow labels sit where the arrow puts them
            if let Some(d) = &display
                && e.container_id().is_some()
            {
                let o = d.origin;
                b = [
                    b[0].min(o[0] - pad),
                    b[1].min(o[1] - pad),
                    b[2].max(o[0] + e.width + pad),
                    b[3].max(o[1] + e.height + pad),
                ];
            }
            let n = display.as_ref().map_or(0, |d| d.items.len());
            let clip = display
                .as_ref()
                .and_then(|d| d.clip.as_ref())
                .map(geom::clip_polygon);
            let c = Cached {
                key,
                base: key,
                off: [0., 0.],
                shown_off: [0., 0.],
                display,
                bounds: b,
                paths: None,
                sprites: vec![None; n],
                clip,
                image: None,
            };
            if let Some(old) = cache.insert(e.id.clone(), c) {
                trash.extend(old.image.and_then(|i| i.1).map(|i| i.0));
            }
        }
        cache.get_mut(&e.id).unwrap()
    }

    /// Paints `board` under `view`, clipped to `clip` (which is also what
    /// culling keeps). The caller fills the canvas color.
    pub fn paint(
        &mut self,
        board: &Board,
        view: View,
        clip: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.sync(board);
        let scene = std::mem::take(&mut self.scene);
        self.paint_scene(
            &scene,
            &board.files,
            canvas_color(board),
            &FxHashMap::default(),
            view,
            clip,
            window,
            cx,
        );
        self.scene = scene;
    }

    /// `paint` for a live scene (the open board): `dim` fades elements (0:
    /// hidden, as the text being edited; 0.2: about to be erased).
    #[allow(clippy::too_many_arguments)]
    pub fn paint_scene(
        &mut self,
        scene: &Scene,
        files: &BTreeMap<String, FileData>,
        canvas: Hsla,
        dim: &FxHashMap<String, f32>,
        view: View,
        clip: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let m = measure(window);
        let visible = {
            let a = view.to_scene(clip.origin);
            let b = view.to_scene(clip.bottom_right());
            [a[0], a[1], b[0], b[1]]
        };
        let b = bucket(view.zoom);
        let prof = profiling().then(std::time::Instant::now);
        let opts = RenderOpts {
            frame_name: !self.screen_frame_names,
            ..RenderOpts::default()
        };
        let Painter {
            cache,
            data_images,
            live,
            sources,
            trash,
            order,
            cropping,
            preview,
            ..
        } = self;
        let crop_preview = cropping
            .as_deref()
            .and_then(|id| scene.get_non_deleted_element(id))
            .and_then(|e| crop_preview(e, scene, &*m));
        for im in trash.drain(..) {
            let _ = window.drop_image(im);
        }
        // forget deleted elements' caches now and then
        if cache.len() > scene.elements_including_deleted().len() + 64
            || *live != scene.scene_nonce() && cache.len() > scene.non_deleted_len() * 2 + 64
        {
            cache.retain(|id, c| {
                scene.get_non_deleted_element(id).is_some() || {
                    trash.extend(c.image.take().and_then(|i| i.1).map(|i| i.0));
                    false
                }
            });
        }
        *live = scene.scene_nonce();
        // what shows, in paint order: the paint order and bounds are kept
        // while the scene stays as it was (panning, zooming, hovering)
        let els = scene.elements_including_deleted();
        let okey = {
            use std::hash::{Hash, Hasher};
            let mut k = rustc_hash::FxHasher::default();
            // not the scene nonce: every edit bumps it; a replaced or reshaped
            // array shows in the per-element checks below
            (els.len(), els.as_ptr() as usize).hash(&mut k);
            for (id, f) in dim {
                (id, f.to_bits()).hash(&mut k);
            }
            k.finish()
        };
        let inside = |r: &[f64; 4]| {
            !(r[2] < visible[0] || r[0] > visible[2] || r[3] < visible[1] || r[1] > visible[3])
        };
        // the same array: patch the elements whose version moved (and the
        // container / label whose cache key follows them), unless one moved
        // in the order or is a frame (its children's clips follow it)
        let patched = order.as_mut().filter(|o| o.key == okey).is_some_and(|o| {
            let changed: Vec<usize> = els
                .iter()
                .enumerate()
                .filter(|(i, e)| o.vers[*i] != (e.version, e.version_nonce))
                .map(|(i, _)| i)
                .collect();
            if changed.len() > 64.max(els.len() / 8) {
                return false;
            }
            let mut redo: Vec<usize> = vec![];
            for &i in &changed {
                let e = &els[i];
                if e.is_frame_like() || order_sig(e) != o.sigs[i] {
                    return false;
                }
                redo.push(i);
                redo.extend(
                    e.container_id()
                        .into_iter()
                        .chain(e.bound_text_id())
                        .filter_map(|r| scene.get_element_index(r)),
                );
            }
            redo.sort_unstable();
            redo.dedup();
            for i in redo {
                let e = &els[i];
                let fade = dim.get(&e.id).copied().unwrap_or(1.);
                let c = Self::entry(cache, trash, e, scene, &*m, &opts);
                let p = o.pos[i];
                // in the order iff it has something to draw: a change of that rebuilds
                if (p == u32::MAX) != (c.display.is_none() || fade <= 0.) {
                    return false;
                }
                if p != u32::MAX {
                    o.list[p as usize].1 = c.bounds;
                }
                o.vers[i] = (e.version, e.version_nonce);
            }
            true
        });
        if !patched {
            let range = els.as_ptr_range();
            let (base, size) = (range.start as usize, std::mem::size_of::<Element>().max(1));
            let mut list = Vec::with_capacity(els.len());
            let mut pos = vec![u32::MAX; els.len()];
            let mut whole = true;
            for e in renderable_elements(els, scene) {
                let fade = dim.get(&e.id).copied().unwrap_or(1.);
                if fade <= 0. {
                    continue;
                }
                let c = Self::entry(cache, trash, e, scene, &*m, &opts);
                if c.display.is_none() {
                    continue;
                }
                let p: *const Element = e;
                if range.contains(&p) {
                    let i = (p as usize - base) / size;
                    pos[i] = list.len() as u32;
                    list.push((i as u32, c.bounds, fade));
                } else {
                    whole = false;
                }
            }
            *order = whole.then(|| Order {
                key: okey,
                list,
                vers: els.iter().map(|e| (e.version, e.version_nonce)).collect(),
                sigs: els.iter().map(order_sig).collect(),
                pos,
            });
        }
        let mut shown: Vec<(&Element, f32)> = vec![];
        if let Some(o) = order.as_ref() {
            shown.extend(
                o.list
                    .iter()
                    .filter(|(_, r, _)| inside(r))
                    .map(|(i, _, f)| (&els[*i as usize], *f)),
            );
        } else {
            // elements outside the scene's array (not expected): no reuse
            for e in renderable_elements(els, scene) {
                let fade = dim.get(&e.id).copied().unwrap_or(1.);
                if fade <= 0. {
                    continue;
                }
                let c = Self::entry(cache, trash, e, scene, &*m, &opts);
                if c.display.is_some() && inside(&c.bounds) {
                    shown.push((e, fade));
                }
            }
        }
        window.with_content_mask(Some(ContentMask { bounds: clip }), |window| {
            for (e, fade) in &shown {
                let Some(c) = cache.get_mut(&e.id) else {
                    continue;
                };
                settle(c);
                let Some(d) = c.display.clone() else { continue };
                // the image being cropped: first its whole picture, faded, at its z-level
                if let Some(p) = crop_preview.as_ref().filter(|p| p.id == e.id)
                    && let Some(DisplayItem::Image(img)) = p.items.first()
                {
                    paint_image(
                        img,
                        p,
                        None,
                        preview,
                        files,
                        view,
                        data_images,
                        sources,
                        trash,
                        window,
                        cx,
                    );
                }
                // frame clip: paths and images are cut exactly, text to the box
                let mask = c.clip.as_ref().map(|k| ContentMask {
                    bounds: view.rect(geom::aabb(k)),
                });
                window.with_content_mask(mask, |window| {
                    let mut paint = |window: &mut Window, cx: &mut App| {
                        paint_element(
                            c,
                            &d,
                            files,
                            view,
                            b,
                            canvas,
                            &m,
                            data_images,
                            sources,
                            trash,
                            window,
                            cx,
                        )
                    };
                    if *fade < 1. {
                        window.with_element_opacity(Some(*fade), |window| paint(window, cx))
                    } else {
                        paint(window, cx)
                    }
                });
            }
        });
        if sources.busy() {
            window.request_animation_frame();
        }
        if let Some(t) = prof {
            eprintln!(
                "prof gpui {} shown, patched {patched}, {:.2} ms",
                shown.len(),
                t.elapsed().as_secs_f64() * 1e3
            );
        }
    }
}

/// How far `e` has moved since the state its cache entry was made for
/// (`base`), if moving is all that happened to it and to each element the
/// entry's key follows (container, frame, arrow label) — all by the same
/// amount, so its picture just shifts.
fn moved_by(e: &Element, base: (i64, i64, i64), scene: &Scene) -> Option<[f64; 2]> {
    let t = scene.translation(&e.id)?;
    if t.from != (base.0, base.1) {
        return None;
    }
    let d = [e.x - t.at[0], e.y - t.at[1]];
    let same = |a: [f64; 2]| (a[0] - d[0]).abs() < 1e-9 && (a[1] - d[1]).abs() < 1e-9;
    // `entry`'s key part for a followed element, as it was before the moves
    let was = |id: Option<&str>| -> Option<i64> {
        let Some(r) = id.and_then(|c| scene.get_element(c)) else {
            return Some(0);
        };
        let rt = scene
            .translation(&r.id)
            .filter(|rt| same([r.x - rt.at[0], r.y - rt.at[1]]))?;
        Some(rt.from.0 ^ (rt.from.1 << 20))
    };
    let k = was(e.container_id())?
        ^ was(e.frame_id.as_deref())?.rotate_left(29)
        ^ was(e.bound_text_id().filter(|_| e.is_arrow()))?.rotate_left(13);
    (k == base.2).then_some(d)
}

/// Brings `c.display` (and what's built from it in scene coordinates) to
/// where the element has moved.
fn settle(c: &mut Cached) {
    let s = [c.off[0] - c.shown_off[0], c.off[1] - c.shown_off[1]];
    if s == [0., 0.] {
        return;
    }
    c.shown_off = c.off;
    if let Some(d) = &c.display {
        let mut n = (**d).clone();
        n.origin = [n.origin[0] + s[0], n.origin[1] + s[1]];
        if let Some(k) = &mut n.clip {
            k.rect[0] += s[0];
            k.rect[1] += s[1];
        }
        c.display = Some(Rc::new(n));
    }
    c.paths = None;
    if let Some((_, Some((_, r)))) = &mut c.image {
        *r = [r[0] + s[0], r[1] + s[1], r[2] + s[0], r[3] + s[1]];
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_element(
    c: &mut Cached,
    d: &ElementDisplay,
    files: &BTreeMap<String, FileData>,
    view: View,
    b: f32,
    canvas: Hsla,
    m: &GpuiMeasure,
    data_images: &mut HashMap<String, Option<Arc<RenderImage>>>,
    sources: &mut Sources,
    trash: &mut Vec<Arc<RenderImage>>,
    window: &mut Window,
    cx: &mut App,
) {
    let paint_of = |p: Paint| paint_color(p, d, canvas);
    if c.paths.as_ref().is_none_or(|(at, _)| *at != b) {
        c.paths = Some((b, build_paths(d, b, c.clip.as_deref())));
    }
    let k = view.zoom / b;
    let Cached {
        paths,
        sprites,
        clip,
        image,
        ..
    } = c;
    let mut built = paths.as_ref().map(|p| p.1.iter()).into_iter().flatten();
    for (i, it) in d.items.iter().enumerate() {
        match it {
            // paths come in item order, one or two (fill, stroke) per item
            DisplayItem::Path { fill, stroke, .. } => {
                for _ in 0..(fill.is_some() as usize + stroke.is_some() as usize) {
                    if let Some(p) = built.next() {
                        window.paint_path(transformed(&p.path, k, view.origin), paint_of(p.paint));
                    }
                }
            }
            DisplayItem::Text(t) => {
                let h = paint_of(t.color);
                if d.angle
                    .rem_euclid(std::f64::consts::TAU)
                    .min(std::f64::consts::TAU - d.angle.rem_euclid(std::f64::consts::TAU))
                    < 1e-6
                {
                    paint_text(t, d, view, h, window, cx);
                } else {
                    if sprites[i].is_none() {
                        sprites[i] = Some(text_sprite(t, m));
                    }
                    if let Some(Some((path, r))) = &sprites[i] {
                        paint_rotated_text(path, *r, d, view, h, window, cx);
                    }
                }
            }
            DisplayItem::Image(img) => paint_image(
                img,
                d,
                clip.as_deref(),
                image,
                files,
                view,
                data_images,
                sources,
                trash,
                window,
                cx,
            ),
        }
    }
}

/// `path` scaled by `scale` and moved by `offset`, its tessellation reused
/// (quiet.md's `Path::transformed` patch to gpui, done here on the path's
/// public vertices).
fn transformed(path: &Path<Pixels>, scale: f32, offset: Point<Pixels>) -> Path<Pixels> {
    let map = |p: Point<Pixels>| point(p.x * scale + offset.x, p.y * scale + offset.y);
    let mut out = path.clone();
    for v in &mut out.vertices {
        v.xy_position = map(v.xy_position);
    }
    out.bounds = Bounds {
        origin: map(path.bounds.origin),
        size: path.bounds.size.map(|v| v * scale),
    };
    out
}

fn pt(p: [f64; 2], b: f32) -> Point<Pixels> {
    point(px(p[0] as f32 * b), px(p[1] as f32 * b))
}

/// `d`'s paths in scene units times `b`, in item order (fill before stroke),
/// cut to the frame clip `clip` and around the label hole.
fn build_paths(d: &ElementDisplay, b: f32, clip: Option<&[geom::Pt]>) -> Vec<Built> {
    let keep = clip.map(|k| geom::to_f32(k, b));
    let hole = d.knockout.map(|k| geom::to_f32(&geom::local_quad(d, k), b));
    let cut = |p: Path<Pixels>| {
        if keep.is_none() && hole.is_none() {
            p
        } else {
            geom::clip_path(&p, keep.as_deref(), hole.as_deref())
                .unwrap_or_else(|| Path::new(point(px(0.), px(0.))))
        }
    };
    let mut out = vec![];
    for it in &d.items {
        let DisplayItem::Path { cmds, fill, stroke } = it else {
            continue;
        };
        let trace = |pb: &mut PathBuilder| {
            for c in cmds {
                match *c {
                    PathCmd::MoveTo(p) => pb.move_to(pt(d.to_scene(p), b)),
                    PathCmd::LineTo(p) => pb.line_to(pt(d.to_scene(p), b)),
                    PathCmd::QuadTo(a, p) => {
                        pb.curve_to(pt(d.to_scene(p), b), pt(d.to_scene(a), b))
                    }
                    PathCmd::CubicTo(a, c2, p) => pb.cubic_bezier_to(
                        pt(d.to_scene(p), b),
                        pt(d.to_scene(a), b),
                        pt(d.to_scene(c2), b),
                    ),
                    PathCmd::Close => pb.close(),
                }
            }
        };
        if let Some(f) = fill {
            let rule = if f.rule == dl::FillRule::EvenOdd {
                gpui::FillRule::EvenOdd
            } else {
                gpui::FillRule::NonZero
            };
            let mut pb = PathBuilder::fill().with_style(PathStyle::Fill(
                FillOptions::default()
                    .with_fill_rule(rule)
                    .with_tolerance(0.2),
            ));
            trace(&mut pb);
            match pb.build() {
                Ok(path) => out.push(Built {
                    path: cut(path),
                    paint: f.paint,
                }),
                Err(_) => out.push(Built {
                    path: Path::new(point(px(0.), px(0.))),
                    paint: f.paint,
                }),
            }
        }
        if let Some(s) = stroke {
            let cap = match s.cap {
                dl::LineCap::Butt => lyon::tessellation::LineCap::Butt,
                dl::LineCap::Round => lyon::tessellation::LineCap::Round,
                dl::LineCap::Square => lyon::tessellation::LineCap::Square,
            };
            let join = match s.join {
                dl::LineJoin::Miter => lyon::tessellation::LineJoin::Miter,
                dl::LineJoin::Round => lyon::tessellation::LineJoin::Round,
                dl::LineJoin::Bevel => lyon::tessellation::LineJoin::Bevel,
            };
            let w = (s.width as f32 * b).max(0.01);
            let opts = StrokeOptions::default()
                .with_line_width(w)
                .with_line_cap(cap)
                .with_line_join(join)
                .with_tolerance(0.2);
            let mut pb = PathBuilder::stroke(px(w)).with_style(PathStyle::Stroke(opts));
            if let Some(dash) = &s.dash {
                pb = pb.dash_array(
                    &dash
                        .iter()
                        .map(|v| px((*v as f32 * b).max(0.01)))
                        .collect::<Vec<_>>(),
                );
            }
            trace(&mut pb);
            match pb.build() {
                Ok(path) => out.push(Built {
                    path: cut(path),
                    paint: s.paint,
                }),
                Err(_) => out.push(Built {
                    path: Path::new(point(px(0.), px(0.))),
                    paint: s.paint,
                }),
            }
        }
    }
    out
}

/// Unrotated text: each line shaped at the zoomed size, its baseline on
/// upstream's (`fillText` at `textBaseline = "alphabetic"`).
fn paint_text(
    t: &dl::TextRun,
    d: &ElementDisplay,
    view: View,
    h: Hsla,
    window: &mut Window,
    cx: &mut App,
) {
    let size = t.font_size as f32 * view.zoom;
    if size < 1. {
        return;
    }
    for l in &t.lines {
        if l.text.is_empty() {
            continue;
        }
        let line = window.text_system().shape_line(
            SharedString::from(l.text.clone()),
            px(size),
            &runs(&l.text, t.font_family, h),
            None,
        );
        let at = view.to_screen(d.to_scene([l.x, l.baseline]));
        let x = match t.align {
            TextAlign::Left => at.x,
            TextAlign::Center => at.x - line.width / 2.,
            TextAlign::Right => at.x - line.width,
        };
        // with no leading, GPUI puts the baseline `ascent` below the origin
        let _ = line.paint(
            point(x, at.y - line.ascent),
            line.ascent + line.descent,
            gpui::TextAlign::Left,
            None,
            window,
            cx,
        );
    }
}

pub const SVG_PREFIX: &str = "board-text/";
static SVGS: LazyLock<Mutex<HashMap<String, Vec<u8>>>> = LazyLock::new(Default::default);

/// The generated SVG at an asset path under `SVG_PREFIX`.
pub fn svg_asset(path: &str) -> Option<Vec<u8>> {
    SVGS.lock().ok()?.get(path).cloned()
}

/// A line's glyph outlines as SVG path data, at local scene coordinates
/// (color emoji have none and are left out).
fn glyph_path(
    ts: &WindowTextSystem,
    text: &str,
    family: u32,
    size: f64,
    left: f64,
    baseline: f64,
) -> String {
    use std::fmt::Write;
    let lay = ts.layout_line(text, px(size as f32), &runs(text, family, black()), None);
    let mut d = String::new();
    for r in &lay.runs {
        let k = size / ts.units_per_em(r.font_id).max(1) as f64;
        for g in r.glyphs.iter().filter(|g| !g.is_emoji) {
            let (ox, oy) = (
                left + f32::from(g.position.x) as f64,
                baseline + f32::from(g.position.y) as f64,
            );
            let q = |p: [f32; 2]| (ox + p[0] as f64 * k, oy - p[1] as f64 * k);
            for c in ts.glyph_outline(r.font_id, g.id).unwrap_or_default() {
                let _ = match c {
                    GlyphOutlineCmd::MoveTo(p) => {
                        let p = q(p);
                        write!(d, "M{:.2} {:.2}", p.0, p.1)
                    }
                    GlyphOutlineCmd::LineTo(p) => {
                        let p = q(p);
                        write!(d, "L{:.2} {:.2}", p.0, p.1)
                    }
                    GlyphOutlineCmd::QuadTo(a, p) => {
                        let (a, p) = (q(a), q(p));
                        write!(d, "Q{:.2} {:.2} {:.2} {:.2}", a.0, a.1, p.0, p.1)
                    }
                    GlyphOutlineCmd::CubicTo(a, b, p) => {
                        let (a, b, p) = (q(a), q(b), q(p));
                        write!(
                            d,
                            "C{:.2} {:.2} {:.2} {:.2} {:.2} {:.2}",
                            a.0, a.1, b.0, b.1, p.0, p.1
                        )
                    }
                    GlyphOutlineCmd::Close => write!(d, "Z"),
                };
            }
        }
    }
    d
}

/// A text run as a monochrome SVG (black: `paint_svg` tints it), with its
/// local box `[x, y, w, h]`.
fn text_sprite(t: &dl::TextRun, m: &GpuiMeasure) -> Option<(SharedString, [f64; 4])> {
    let font = BFont::new(t.font_size, t.font_family);
    let (mut x1, mut x2) = (f64::INFINITY, f64::NEG_INFINITY);
    for l in &t.lines {
        let w = m.line_width(&l.text, font);
        let left = match t.align {
            TextAlign::Left => l.x,
            TextAlign::Center => l.x - w / 2.,
            TextAlign::Right => l.x - w,
        };
        (x1, x2) = (x1.min(left), x2.max(left + w));
    }
    let (y1, y2) = (t.lines.first()?.top, t.lines.last()?.top + t.line_height);
    if !x1.is_finite() || x2 <= x1 {
        return None;
    }
    // a little room for glyph overhangs
    let pad = t.font_size * 0.25;
    let r = [x1 - pad, y1 - pad, x2 - x1 + pad * 2., y2 - y1 + pad * 2.];
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{} {} {} {}" width="{}" height="{}">"#,
        r[0], r[1], r[2], r[3], r[2], r[3]
    );
    for l in &t.lines {
        if l.text.is_empty() {
            continue;
        }
        let w = m.line_width(&l.text, font);
        let left = match t.align {
            TextAlign::Left => l.x,
            TextAlign::Center => l.x - w / 2.,
            TextAlign::Right => l.x - w,
        };
        let d = glyph_path(&m.0, &l.text, t.font_family, t.font_size, left, l.baseline);
        svg.push_str(&format!(r##"<path d="{d}" fill="#000"/>"##));
    }
    svg.push_str("</svg>");
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    svg.hash(&mut h);
    let key = format!("{SVG_PREFIX}{:016x}.svg", h.finish());
    if let Ok(mut s) = SVGS.lock() {
        s.entry(key.clone()).or_insert_with(|| svg.into_bytes());
    }
    Some((key.into(), r))
}

fn rotation_about(c: Point<Pixels>, angle: f32, scale: f32) -> TransformationMatrix {
    let c = c.scale(scale);
    TransformationMatrix::unit()
        .translate(c)
        .rotate(radians(angle))
        .translate(point(ScaledPixels(-c.x.0), ScaledPixels(-c.y.0)))
}

fn paint_rotated_text(
    path: &SharedString,
    r: [f64; 4],
    d: &ElementDisplay,
    view: View,
    h: Hsla,
    window: &mut Window,
    cx: &mut App,
) {
    let o = d.origin;
    let bounds = view.rect([
        o[0] + r[0],
        o[1] + r[1],
        o[0] + r[0] + r[2],
        o[1] + r[1] + r[3],
    ]);
    if f32::from(bounds.size.width) < 1. || f32::from(bounds.size.height) < 1. {
        return;
    }
    let center = view.to_screen([o[0] + d.center[0], o[1] + d.center[1]]);
    let m = rotation_about(center, d.angle as f32, window.scale_factor());
    let svg = svg_asset(path);
    let _ = window.paint_svg(bounds, path.clone(), svg.as_deref(), m, h, cx);
}

/// An image file's pixels: the document picture cache for library files,
/// decoded here once for data URLs.
fn image_of(
    fd: &FileData,
    long: f32,
    data_images: &mut HashMap<String, Option<Arc<RenderImage>>>,
    window: &mut Window,
    cx: &mut App,
) -> Option<Arc<RenderImage>> {
    let _ = (long, window, cx);
    let url = fd.data_url.as_deref()?;
    data_images
        .entry(fd.id.clone())
        .or_insert_with(|| decode_data_url(url))
        .clone()
}

fn decode_data_url(url: &str) -> Option<Arc<RenderImage>> {
    use base64::Engine;
    let (_, b64) = url.split_once(";base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    let mut rgba = image::load_from_memory(&bytes).ok()?.into_rgba8();
    for px in rgba.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(vec![image::Frame::new(rgba)])))
}

/// The crop editor's whole uncropped image as drawn under the cropped one
/// (upstream `renderElement` while cropping: opacity 0.1, unclipped).
fn crop_preview(e: &Element, scene: &Scene, m: &dyn Measure) -> Option<ElementDisplay> {
    if e.image().is_none_or(|i| i.crop.is_none()) {
        return None;
    }
    let u = super::crop::get_uncropped_image_element(e, scene);
    let mut d = element_display(&u, scene, m, &RenderOpts::default())?;
    d.opacity *= 0.1;
    d.clip = None;
    Some(d)
}

/// Image file pixels for resampling and for vello, by file id, with the
/// long-edge cap they were decoded at, decoded off the main thread. A board
/// view decodes each file once (at most 4096 px); a thumbnail only as large
/// as it is drawn, rounded up to a power of two, and again when it grows
/// past that or shrinks to under a quarter.
#[derive(Default)]
pub struct Sources {
    map: HashMap<String, Slot>,
    thumb: bool,
    jobs: Arc<std::sync::atomic::AtomicU64>,
}

type Job = Arc<std::sync::Mutex<Option<Option<geom::Src>>>>;

#[derive(Default)]
struct Slot {
    cap: u32,
    src: Option<Arc<geom::Src>>,
    job: Option<(u32, Job)>,
}

/// What `Sources::take` has for the caller.
pub enum Take {
    Same,
    Pending,
    Ready(u32, Option<geom::Src>),
}

impl Sources {
    fn cap(&self, need: f64, have: Option<u32>) -> u32 {
        if !self.thumb || !need.is_finite() {
            return 4096;
        }
        let want = (need.clamp(64., 4096.).ceil() as u32).next_power_of_two();
        match have {
            Some(h) if h >= want && h <= want * 4 => h,
            _ => want,
        }
    }
    /// Starts decoding `fd` at `cap` unless that is under way; its result
    /// once there.
    fn poll(&mut self, fd: &FileData, cap: u32) -> Option<Option<geom::Src>> {
        let slot = self.map.entry(fd.id.clone()).or_default();
        if slot.job.as_ref().is_none_or(|(c, _)| *c != cap) {
            let out: Job = Arc::default();
            let (fd, o, jobs) = (fd.clone(), out.clone(), self.jobs.clone());
            jobs.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            std::thread::spawn(move || {
                let s = source_of(&fd, cap);
                *o.lock().unwrap() = Some(s);
                jobs.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            });
            slot.job = Some((cap, out));
        }
        let r = slot.job.as_ref()?.1.lock().unwrap().take()?;
        slot.job = None;
        Some(r)
    }
    /// `fd`'s pixels for drawing its full image `need` device pixels long:
    /// the last decode while a better one is on its way.
    fn get(&mut self, fd: &FileData, need: f64) -> Option<Arc<geom::Src>> {
        let have = self.map.get(&fd.id).filter(|s| s.cap > 0).map(|s| s.cap);
        let cap = self.cap(need, have);
        if have != Some(cap)
            && let Some(r) = self.poll(fd, cap)
        {
            let slot = self.map.get_mut(&fd.id)?;
            (slot.cap, slot.src) = (cap, r.map(Arc::new));
        }
        self.map.get(&fd.id)?.src.clone()
    }
    /// As `get`, but owned and left out of the cache; `have` is the
    /// caller's cap.
    pub fn take(&mut self, fd: &FileData, need: f64, have: Option<u32>) -> Take {
        let cap = self.cap(need, have);
        if have == Some(cap) {
            return Take::Same;
        }
        if let Some(slot) = self.map.get_mut(&fd.id)
            && slot.cap == cap
            && let Some(s) = slot.src.take()
        {
            slot.cap = 0;
            return Take::Ready(
                cap,
                Some(Arc::try_unwrap(s).unwrap_or_else(|s| (*s).clone())),
            );
        }
        match self.poll(fd, cap) {
            Some(r) => Take::Ready(cap, r),
            None => Take::Pending,
        }
    }
    /// Decodes started and finished, so far (changes when one ends).
    pub fn progress(&self) -> u64 {
        self.jobs.load(std::sync::atomic::Ordering::Relaxed)
    }
    /// Whether a decode is under way (the caller paints again until not).
    pub fn busy(&self) -> bool {
        self.map.values().any(|s| s.job.is_some())
    }
}

/// How many device pixels long `img`'s whole (uncropped) image is drawn at
/// `zoom` device pixels per scene unit.
pub fn need_px(img: &ImageItem, zoom: f64) -> f64 {
    let [_, _, w, h] = img.dest;
    let (fw, fh) = match (img.crop, img.natural_size) {
        (Some(c), Some([nw, nh])) if c[2] > 0. && c[3] > 0. => (w * nw / c[2], h * nh / c[3]),
        _ => (w, h),
    };
    fw.max(fh) * zoom
}

/// An image file's pixels, the long edge at most `cap` (on a worker thread).
fn source_of(fd: &FileData, cap: u32) -> Option<geom::Src> {
    let t = std::time::Instant::now();
    let r = decode_source(fd, cap);
    if profiling() {
        eprintln!(
            "prof decode {} at {cap}: {:.2} ms",
            fd.id,
            t.elapsed().as_secs_f64() * 1e3
        );
    }
    r
}

fn decode_source(fd: &FileData, cap: u32) -> Option<geom::Src> {
    use base64::Engine;
    let (_, b64) = fd.data_url.as_deref()?.split_once(";base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    let mut im = image::load_from_memory(&bytes).ok()?;
    if im.width().max(im.height()) > cap {
        im = im.thumbnail(cap, cap);
    }
    let im = im.into_rgba8();
    Some(geom::Src {
        w: im.width(),
        h: im.height(),
        px: im.into_raw(),
    })
}

/// Whether GPUI can draw `img` itself: upright, not mirrored, and inside
/// its frame clip (if any) but for the rounded corners' reach.
fn plain_image(img: &ImageItem, d: &ElementDisplay) -> bool {
    let upright = d
        .angle
        .rem_euclid(std::f64::consts::TAU)
        .min(std::f64::consts::TAU - d.angle.rem_euclid(std::f64::consts::TAU))
        < 1e-6;
    let inside = d.clip.as_ref().is_none_or(|k| {
        let r = geom::aabb(&geom::local_quad(d, img.dest));
        let i = k.radius;
        k.angle.abs() < 1e-9
            && r[0] >= k.rect[0] + i
            && r[1] >= k.rect[1] + i
            && r[2] <= k.rect[0] + k.rect[2] - i
            && r[3] <= k.rect[1] + k.rect[3] - i
    });
    upright && img.flip == [1., 1.] && inside
}

#[allow(clippy::too_many_arguments)]
fn paint_image(
    img: &ImageItem,
    d: &ElementDisplay,
    clip: Option<&[geom::Pt]>,
    cached: &mut Option<(f64, Option<(Arc<RenderImage>, [f64; 4])>)>,
    files: &BTreeMap<String, FileData>,
    view: View,
    data_images: &mut HashMap<String, Option<Arc<RenderImage>>>,
    sources: &mut Sources,
    trash: &mut Vec<Arc<RenderImage>>,
    window: &mut Window,
    cx: &mut App,
) {
    let [x, y, w, h] = img.dest;
    let o = d.origin;
    let dest = view.rect([o[0] + x, o[1] + y, o[0] + x + w, o[1] + y + h]);
    let fd = img.file_id.as_deref().and_then(|id| files.get(id));
    let placeholder = |window: &mut Window| {
        // upstream's placeholder: a light box
        if plain_image(img, d) {
            window.paint_quad(fill(dest, placeholder_color(d.opacity)));
            return;
        }
        let mut pb = PathBuilder::fill();
        let q = geom::local_quad(d, img.dest);
        for (i, p) in q.iter().enumerate() {
            let s = view.to_screen(*p);
            if i == 0 { pb.move_to(s) } else { pb.line_to(s) }
        }
        pb.close();
        if let Ok(p) = pb.build() {
            window.paint_path(p, placeholder_color(d.opacity));
        }
    };
    if !plain_image(img, d) {
        let Some(src) = fd.and_then(|fd| {
            sources.get(
                fd,
                need_px(img, view.zoom as f64 * window.scale_factor() as f64),
            )
        }) else {
            placeholder(window);
            return;
        };
        // resolution: the screen's at the zoom octave above, at most the file's
        let full_w = match (img.crop, img.natural_size) {
            (Some(cr), Some([nw, _])) if cr[2] > 0. => nw * w / cr[2],
            _ => w,
        };
        let natural = src.w as f64 / full_w.max(1e-6);
        let screen = 2f64.powf(
            (view.zoom as f64 * window.scale_factor() as f64)
                .max(1e-3)
                .log2()
                .ceil(),
        );
        let mut res = natural.min(screen);
        let long = (w.max(h) * 1.5) * res;
        if long > 4096. {
            res *= 4096. / long;
        }
        if cached.as_ref().is_none_or(|(r, _)| *r != res) {
            let made = geom::transform_image(&src, img, d, clip, res).map(|(w, h, px, r)| {
                let buf = image::RgbaImage::from_raw(w, h, px).expect("size");
                (Arc::new(RenderImage::new(vec![image::Frame::new(buf)])), r)
            });
            if let Some((_, Some((old, _)))) = cached.replace((res, made)) {
                trash.push(old);
            }
        }
        if let Some((_, Some((im, r)))) = cached {
            let _ = window.with_element_opacity(Some(d.opacity as f32), |window| {
                let at = view.rect(*r);
                window.paint_image(at, at, Corners::default(), im.clone(), 0, false)
            });
        }
        return;
    }
    let long = f32::from(dest.size.width).max(f32::from(dest.size.height));
    let Some(im) = fd.and_then(|fd| image_of(fd, long, data_images, window, cx)) else {
        placeholder(window);
        return;
    };
    // the whole image, placed so the crop lands on `dest`
    let full = match (img.crop, img.natural_size) {
        (Some(c), Some([nw, nh])) if c[2] > 0. && c[3] > 0. => {
            let (sx, sy) = (w / c[2], h / c[3]);
            let (fx, fy) = (o[0] + x - c[0] * sx, o[1] + y - c[1] * sy);
            view.rect([fx, fy, fx + nw * sx, fy + nh * sy])
        }
        _ => dest,
    };
    let r = px(img.corner_radius as f32 * view.zoom);
    window.with_content_mask(Some(ContentMask { bounds: dest }), |window| {
        let _ = window.with_element_opacity(Some(d.opacity as f32), |window| {
            window.paint_image(full, full, Corners::all(r), im, 0, false)
        });
    });
}

/// A static picture of `board` (thumbnails): the scene fit into `bounds`
/// less `pad`, never enlarged past 100%, centered.
pub fn paint_fit(
    painter: &mut Painter,
    board: &Board,
    bounds: Bounds<Pixels>,
    pad: f32,
    window: &mut Window,
    cx: &mut App,
) {
    painter.thumb = true;
    painter.sources.thumb = true;
    painter.sync(board);
    let Some(c) = painter.content_bounds() else {
        return;
    };
    let (w, h) = (
        f32::from(bounds.size.width) - pad * 2.,
        f32::from(bounds.size.height) - pad * 2.,
    );
    let (cw, ch) = ((c[2] - c[0]).max(1.) as f32, (c[3] - c[1]).max(1.) as f32);
    let zoom = (w / cw).min(h / ch).min(1.);
    if zoom.is_nan() || zoom <= 0. {
        return;
    }
    let mid = bounds.center();
    let origin = point(
        mid.x - px(((c[0] + c[2]) / 2.) as f32 * zoom),
        mid.y - px(((c[1] + c[3]) / 2.) as f32 * zoom),
    );
    painter.paint(board, View { zoom, origin }, bounds, window, cx);
}

thread_local! {
    /// 主页 cards: painters by board version, the last few.
    static CARDS: std::cell::RefCell<Vec<(u64, Painter)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// `paint_fit` for a 主页 card, with a painter kept per board version.
pub fn paint_card(board: &Board, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    let v = board.version();
    CARDS.with(|c| {
        let mut c = c.borrow_mut();
        let i = match c.iter().position(|(k, _)| *k == v) {
            Some(i) => i,
            None => {
                if c.len() >= 16 {
                    c.remove(0);
                }
                c.push((v, Painter::default()));
                c.len() - 1
            }
        };
        paint_fit(&mut c[i].1, board, bounds, 4., window, cx);
    });
}
