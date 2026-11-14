//! Drawing rtex display lists (realtime-tex `docs/display-list.md`) into a
//! page's pixels: the `Painter` of `src/live-preview/rtex-render.ts`
//! (adapted there from realtime-tex-vsc-plugin's `webview/render.ts`, MIT
//! License, Copyright (c) 2026 Henry Yang; see THIRD_PARTY_NOTICES.md), on a
//! tiny-skia pixmap where the Tauri app draws on a 2D canvas, and the page
//! composition of `live-preview-layer.tsx`.
//!
//! Runs on a background thread, from a snapshot of the model's page and
//! the stores (`PageJob`).

use std::{collections::HashSet, sync::Arc};

use tiny_skia::{
    Color, FillRule, FilterQuality, Paint, Pixmap, PixmapPaint, Rect as SkRect, Transform,
};

use super::{
    fonts::{FontStore, ImageStore, LoadedFont, LoadedImage, image_info},
    model::{OverlayRow, PageOverlay, Rect, cached_picture_moves},
    protocol::{DisplayList, Item, Line, PT, PageUpdate},
    virtual_font::VirtualPart,
};

/// How far past a row's box its clearing reaches sideways: glyphs a line
/// hangs into the margin (microtype's protrusion, a hyphen) sit outside the
/// box, and were left behind at 1 pt. Columns stand farther apart than this.
const ROW_SIDE: f64 = 4. * PT;

/// Paper: rendered pages stay white in both themes (dark pages are the
/// viewer's filter, applied to the whole layer after).
const PAPER: Color = Color::WHITE;

/// Affine map [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat([f64; 6]);

impl Mat {
    pub const IDENTITY: Mat = Mat([1., 0., 0., 1., 0., 0.]);

    pub fn scale(k: f64) -> Mat {
        Mat([k, 0., 0., k, 0., 0.])
    }

    /// `self` after `other`: `other` applies first.
    pub fn mul(self, other: Mat) -> Mat {
        let [a, b, c, d, e, f] = self.0;
        let [g, h, i, j, k, l] = other.0;
        Mat([
            a * g + c * h,
            b * g + d * h,
            a * i + c * j,
            b * i + d * j,
            a * k + c * l + e,
            b * k + d * l + f,
        ])
    }

    fn skia(self) -> Transform {
        let [a, b, c, d, e, f] = self.0.map(|v| v as f32);
        Transform::from_row(a, b, c, d, e, f)
    }

    fn apply(self, x: f64, y: f64) -> (f64, f64) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }
}

/// The colour of the fill (else stroke) operator in a PDF colour string
/// ("1 0 0 rg 1 0 0 RG").
fn pdf_color(data: &str) -> Option<Color> {
    let tokens: Vec<&str> = data.split_whitespace().collect();
    let (mut fill, mut stroke) = (None, None);
    for (i, op) in tokens.iter().enumerate() {
        let take = |n: usize| -> Option<Vec<f32>> {
            (i >= n)
                .then(|| tokens[i - n..i].iter().map(|v| v.parse().ok()).collect())
                .flatten()
        };
        let color = match *op {
            "g" | "G" => take(1).map(|v| rgb(v[0], v[0], v[0])),
            "rg" | "RG" => take(3).map(|v| rgb(v[0], v[1], v[2])),
            "k" | "K" => take(4).map(|v| {
                let [c, m, y, k] = [v[0], v[1], v[2], v[3]];
                rgb((1. - c) * (1. - k), (1. - m) * (1. - k), (1. - y) * (1. - k))
            }),
            _ => continue,
        };
        let Some(color) = color else { continue };
        if op.chars().all(|ch| ch.is_ascii_lowercase()) {
            fill.get_or_insert(color);
        } else {
            stroke.get_or_insert(color);
        }
    }
    fill.or(stroke)
}

fn rgb(r: f32, g: f32, b: f32) -> Color {
    Color::from_rgba(r.clamp(0., 1.), g.clamp(0., 1.), b.clamp(0., 1.), 1.).unwrap_or(Color::BLACK)
}

/// Why a display list cannot be drawn exactly (`None` when it can), over
/// `lines` (all of its lines when `None`) and the items outside them.
pub fn inexact_reason<'a>(
    dl: &DisplayList,
    fonts: &FontStore,
    images: &ImageStore,
    lines: Option<&mut dyn Iterator<Item = &'a Line>>,
) -> Option<String> {
    let flags = dl.flag_names();
    if !flags.is_empty() {
        return Some(format!(
            "contains material the live renderer cannot draw ({})",
            flags.join(", ")
        ));
    }
    let check = |items: &[Item]| -> Option<String> {
        for item in items {
            match item {
                Item::Glyph {
                    font, char, index, ..
                } => {
                    let desc = dl.fonts.get(&font.to_string())?;
                    let Some(loaded) = fonts.get(desc) else {
                        return Some("fonts are loading".into());
                    };
                    if let LoadedFont::Missing(reason) = loaded.as_ref() {
                        return Some(reason.clone());
                    }
                    if !loaded.drawable(*index, *char) {
                        return Some(format!(
                            "a glyph is missing from {}",
                            desc.psname.as_deref().or(desc.name.as_deref()).unwrap_or("a font")
                        ));
                    }
                }
                Item::Image { index, .. } => {
                    let Some(info) = image_info(dl, *index) else {
                        return Some("an image has no source file".into());
                    };
                    match images.get(&info.file) {
                        None => {
                            return Some("images are loading".into());
                        }
                        Some(LoadedImage::Missing(reason)) => return Some(reason.clone()),
                        Some(LoadedImage::Bitmap(_)) => {}
                    }
                }
                Item::Literal | Item::Unknown { .. } => {
                    return Some(
                        "contains drawing commands (e.g. TikZ) the live renderer cannot draw"
                            .into(),
                    );
                }
                _ => {}
            }
        }
        None
    };
    if let Some(reason) = check(&dl.other) {
        return Some(reason);
    }
    match lines {
        Some(lines) => {
            for line in lines {
                if let Some(reason) = check(&line.items) {
                    return Some(reason);
                }
            }
            None
        }
        None => dl.lines.iter().find_map(|line| check(&line.items)),
    }
}

/// Whether `reason` only waits for a load (fonts or images): the next draw
/// may be exact.
pub fn only_loading(reason: &str) -> bool {
    reason.ends_with("are loading")
}

/// Draws display-list items onto a pixmap whose base transform maps sp to
/// device pixels.
pub struct Painter<'a> {
    pixmap: &'a mut Pixmap,
    base: Mat,
    fonts: &'a FontStore,
    images: &'a ImageStore,
    stacks: std::collections::HashMap<u64, Vec<String>>,
    color: Color,
    matrices: Vec<Mat>,
    current: Mat,
}

impl<'a> Painter<'a> {
    pub fn new(pixmap: &'a mut Pixmap, base: Mat, fonts: &'a FontStore, images: &'a ImageStore) -> Self {
        Self {
            pixmap,
            base,
            fonts,
            images,
            stacks: Default::default(),
            color: Color::BLACK,
            matrices: Vec::new(),
            current: Mat::IDENTITY,
        }
    }

    fn paint(&self) -> Paint<'static> {
        let mut paint = Paint::default();
        paint.set_color(self.color);
        paint.anti_alias = true;
        paint
    }

    fn fill_rect(&mut self, matrix: Mat, x: f64, y: f64, w: f64, h: f64, color: Color) {
        let Some(rect) = SkRect::from_xywh(x as f32, y as f32, w as f32, h as f32) else {
            return;
        };
        let mut paint = Paint::default();
        paint.set_color(color);
        paint.anti_alias = true;
        self.pixmap.fill_rect(rect, &paint, matrix.skia(), None);
    }

    /// Draw `items` of `dl` translated by (dx, dy) sp.
    pub fn draw(&mut self, dl: &DisplayList, items: &[Item], dx: f64, dy: f64) {
        for item in items {
            match item {
                Item::Glyph {
                    font,
                    char,
                    index,
                    x,
                    y,
                    ef,
                } => {
                    let Some(desc) = dl.fonts.get(&font.to_string()) else {
                        continue;
                    };
                    let size = desc.size.unwrap_or(655_360.);
                    let Some(loaded) = self.fonts.get(desc).cloned() else {
                        continue;
                    };
                    // A glyph that cannot be drawn exactly is left out: a
                    // page or a paragraph holding one is not drawn at all
                    // (`inexact_reason`).
                    if !loaded.drawable(*index, *char) {
                        continue;
                    }
                    let extend = desc.extend.filter(|extend| *extend != 0.).map_or(1., |e| e / 1000.);
                    let hx = (1. + ef / 1_000_000.) * extend;
                    let slant = desc.slant.unwrap_or(0.) / 1000.;
                    self.glyph(&loaded, *index, *char, size, x + dx, y + dy, hx, slant);
                }
                Item::Rule { x, y_top, w, h } => {
                    let m = self.base.mul(self.current);
                    // Keep hairlines visible: at least 0.75 device px.
                    let min_w = 0.75 / m.0[0].hypot(m.0[1]);
                    let min_h = 0.75 / m.0[2].hypot(m.0[3]);
                    let color = self.color;
                    self.fill_rect(m, x + dx, y_top + dy, w.max(min_w), h.max(min_h), color);
                }
                Item::Color { stack, cmd, data } => self.color_op(*stack, *cmd, data),
                Item::Image {
                    index,
                    x,
                    y_top,
                    w,
                    h,
                } => {
                    let m = self.base.mul(self.current);
                    let image = image_info(dl, *index).and_then(|info| self.images.get(&info.file));
                    match image {
                        Some(LoadedImage::Bitmap(bitmap)) => {
                            let bitmap = bitmap.clone();
                            let (pw, ph) = (f64::from(bitmap.width()), f64::from(bitmap.height()));
                            let place = Mat([w / pw, 0., 0., h / ph, x + dx, y_top + dy]);
                            let paint = PixmapPaint {
                                quality: FilterQuality::Bicubic,
                                ..PixmapPaint::default()
                            };
                            self.pixmap
                                .draw_pixmap(0, 0, bitmap.as_ref().as_ref(), &paint, m.mul(place).skia(), None);
                        }
                        _ => {
                            let grey = Color::from_rgba(0.5, 0.5, 0.5, 0.15).unwrap_or(Color::TRANSPARENT);
                            self.fill_rect(m, x + dx, y_top + dy, *w, *h, grey);
                        }
                    }
                }
                Item::Matrix { op, x, y, data } => match op.as_str() {
                    "save" => self.matrices.push(self.current),
                    "restore" => self.current = self.matrices.pop().unwrap_or(Mat::IDENTITY),
                    _ => {
                        let v: Vec<f64> = data.split_whitespace().filter_map(|v| v.parse().ok()).collect();
                        if let [a, b, c, d] = v[..] {
                            // PDF matrices are y-up; display lists are y-down:
                            // conjugate by the flip.
                            let (a, b, c, d) = (a, -b, -c, d);
                            let (px, py) = (x + dx, y + dy);
                            self.current = self.current.mul(Mat([
                                a,
                                b,
                                c,
                                d,
                                px - (a * px + c * py),
                                py - (b * px + d * py),
                            ]));
                        }
                    }
                },
                Item::Literal | Item::Unknown { .. } | Item::Other => {}
            }
        }
    }

    /// One glyph of `font` at `size` sp with its baseline origin at (x, y);
    /// a virtual font's parts in turn.
    #[allow(clippy::too_many_arguments)]
    fn glyph(
        &mut self,
        font: &Arc<LoadedFont>,
        index: Option<u32>,
        char: u32,
        size: f64,
        x: f64,
        y: f64,
        hx: f64,
        slant: f64,
    ) {
        if let LoadedFont::Virtual { vf, fonts } = font.as_ref() {
            for part in vf.chars.get(&char).into_iter().flatten() {
                match part {
                    VirtualPart::Rule { h, v, width, height } => {
                        let m = self.base.mul(self.current);
                        let color = self.color;
                        self.fill_rect(
                            m,
                            x + h * size * hx,
                            y + (v - height) * size,
                            width * size * hx,
                            height * size,
                            color,
                        );
                    }
                    VirtualPart::Char { font: sub, char, h, v } => {
                        let scale = vf.fonts.get(*sub).map_or(1., |font| font.scale);
                        if let Some(sub) = fonts.get(*sub).cloned() {
                            self.glyph(&sub, None, *char, size * scale, x + h * size * hx, y + v * size, hx, slant);
                        }
                    }
                }
            }
            return;
        }
        let Some(path) = font.glyph(index, char) else {
            return;
        };
        let (upem, mut stretch, mut shear) = match font.as_ref() {
            LoadedFont::Sfnt { upem, .. } => (*upem, hx, slant),
            LoadedFont::Type1 {
                upem,
                slant: font_slant,
                extend,
                ..
            } => {
                let stretch = extend.map_or(hx, |extend| hx * extend);
                let shear = match font_slant {
                    Some(font_slant) if slant == 0. => *font_slant,
                    _ => slant,
                };
                (*upem, stretch, shear)
            }
            _ => return,
        };
        if !stretch.is_finite() {
            stretch = 1.;
        }
        if !shear.is_finite() {
            shear = 0.;
        }
        let s = size / upem;
        let m = self
            .base
            .mul(self.current)
            .mul(Mat([s * stretch, 0., s * shear, -s, x, y]));
        let paint = self.paint();
        self.pixmap.fill_path(&path, &paint, FillRule::Winding, m.skia(), None);
    }

    /// Paint the boxes of `rows` (translated) with paper, enlarged by `pad` sp
    /// vertically and `side` sp horizontally.
    pub fn clear_lines(&mut self, rows: &[(&Line, f64, f64)], pad: f64, side: f64) {
        let base = self.base;
        for (line, dx, dy) in rows {
            self.fill_rect(
                base,
                line.x + dx - side,
                line.y + dy - line.h - pad,
                line.w + 2. * side,
                line.h + line.d + 2. * pad,
                PAPER,
            );
        }
    }

    /// Fill rectangles [x0, y0, x1, y1] given in sp with paper.
    pub fn clear_rects(&mut self, rects: &[[f64; 4]]) {
        let base = self.base;
        for [x0, y0, x1, y1] in rects {
            self.fill_rect(base, *x0, *y0, x1 - x0, y1 - y0, PAPER);
        }
    }

    fn color_op(&mut self, stack: u64, cmd: Option<u64>, data: &str) {
        let entries = self.stacks.entry(stack).or_default();
        // LuaTeX reports the colorstack command in `cmd` (0 set, 1 push, 2
        // pop, 3 current); when it is absent, a non-empty data string is a
        // push and an empty one a pop.
        let op = match cmd {
            Some(cmd) if cmd <= 3 => cmd,
            _ if !data.trim().is_empty() => 1,
            _ => 2,
        };
        match op {
            0 => match entries.last_mut() {
                Some(top) => *top = data.to_string(),
                None => entries.push(data.to_string()),
            },
            1 => entries.push(data.to_string()),
            2 => {
                entries.pop();
            }
            _ => return,
        }
        self.color = entries.last().and_then(|top| pdf_color(top)).unwrap_or(Color::BLACK);
    }
}

/// Where a page's drawing comes from, for one draw.
pub enum JobSource {
    /// The base PDF's own page, under the live paragraphs; `page` is rtex's
    /// layout of it as of the base, whose rows the paragraphs clear.
    Base { page: Option<Arc<PageUpdate>> },
    DisplayList(Arc<PageUpdate>),
    /// rtex's fallback PDF of the layout, drawn by PDFium: straight BGRA
    /// pixels at the job's size, or `None` when it could not be drawn.
    Fallback {
        page: Arc<PageUpdate>,
        pixels: Option<Vec<u8>>,
    },
}

/// One page's live layer to draw, as the main thread found it.
pub struct PageJob {
    pub width_px: u32,
    pub height_px: u32,
    /// Device pixels per sp.
    pub k: f64,
    pub source: JobSource,
    /// The live paragraphs drawn on the page, exactly drawable, each with
    /// the page lines it replaces.
    pub overlays: Vec<(PageOverlay, HashSet<usize>)>,
    pub fonts: FontStore,
    pub images: ImageStore,
}

/// Device-pixel rectangle of an sp rectangle under the page's base matrix
/// (scale only).
fn device_rect(base: Mat, rect: Rect) -> (i32, i32, i32, i32) {
    let (x0, y0) = base.apply(rect.x, rect.y);
    let (x1, y1) = base.apply(rect.x + rect.w, rect.y + rect.h);
    let (x, y) = (x0.round() as i32, y0.round() as i32);
    (x, y, (x1.round() as i32 - x).max(0), (y1.round() as i32 - y).max(0))
}

/// Rectangles [x0, y0, x1, y1] (sp) covering each overlay row and the gap
/// above it.
fn row_bands(rows: &[OverlayRow]) -> Vec<[f64; 4]> {
    let mut out = Vec::with_capacity(rows.len());
    let mut previous: Option<(f64, f64)> = None;
    for row in rows {
        let line = &row.line;
        let baseline = line.y + row.dy;
        let own_top = baseline - line.h - PT;
        let top = match previous {
            Some((bottom, base))
                if baseline > base && baseline - base < 4. * (line.h + line.d + 2. * PT) =>
            {
                own_top.min(bottom)
            }
            _ => own_top,
        };
        let bottom = baseline + line.d.max(3. * PT);
        out.push([line.x + row.dx - ROW_SIDE, top, line.x + row.dx + line.w + ROW_SIDE, bottom]);
        previous = Some((bottom, baseline));
    }
    out
}

/// Draw one page's live layer: `None` when there is nothing to draw (a
/// display-list page that cannot be drawn exactly shows the PDF under it).
/// The pixels are premultiplied RGBA; transparent where the base PDF shows
/// through.
pub fn compose(job: PageJob) -> Option<Pixmap> {
    let mut pixmap = Pixmap::new(job.width_px.max(1), job.height_px.max(1))?;
    let base = Mat::scale(job.k);
    let hidden: HashSet<usize> = job.overlays.iter().flat_map(|(_, own)| own.iter().copied()).collect();
    let mut snaps: Vec<(Pixmap, Rect)> = Vec::new();
    match &job.source {
        JobSource::DisplayList(page) => {
            let mut lines = page.dl.lines.iter().enumerate().filter(|(ix, _)| !hidden.contains(ix)).map(|(_, l)| l);
            // A font still loading or missing would draw approximately: the
            // page shows the PDF under it until everything it needs is in.
            if inexact_reason(&page.dl, &job.fonts, &job.images, Some(&mut lines)).is_some() {
                return None;
            }
            pixmap.fill(PAPER);
            let mut painter = Painter::new(&mut pixmap, base, &job.fonts, &job.images);
            painter.draw(&page.dl, &page.dl.other, 0., 0.);
            for (ix, line) in page.dl.lines.iter().enumerate() {
                if !hidden.contains(&ix) {
                    painter.draw(&page.dl, &line.items, 0., 0.);
                }
            }
        }
        JobSource::Fallback { page, pixels } => {
            if let Some(pixels) = pixels {
                for (pixel, bgra) in pixmap.pixels_mut().iter_mut().zip(pixels.chunks_exact(4)) {
                    *pixel = tiny_skia::ColorU8::from_rgba(bgra[2], bgra[1], bgra[0], bgra[3]).premultiply();
                }
                for (overlay, own) in &job.overlays {
                    for (src, dst) in cached_picture_moves(&page.dl, &overlay.rows, own) {
                        let (x, y, w, h) = device_rect(base, src);
                        if w < 1 || h < 1 {
                            continue;
                        }
                        let rect = tiny_skia::IntRect::from_xywh(x, y, w as u32, h as u32);
                        if let Some(snap) = rect.and_then(|rect| pixmap.clone_rect(rect)) {
                            snaps.push((snap, dst));
                        }
                    }
                }
            }
            let rows: Vec<(&Line, f64, f64)> = page
                .dl
                .lines
                .iter()
                .enumerate()
                .filter(|(ix, _)| hidden.contains(ix))
                .map(|(_, line)| (line, 0., 0.))
                .collect();
            Painter::new(&mut pixmap, base, &job.fonts, &job.images).clear_lines(&rows, PT, ROW_SIDE);
        }
        JobSource::Base { page } => {
            // The base PDF's page is rtex's page as of the base: clear the
            // rows the live paragraphs held there.
            if let Some(page) = page {
                let rows: Vec<(&Line, f64, f64)> = page
                    .dl
                    .lines
                    .iter()
                    .enumerate()
                    .filter(|(ix, _)| hidden.contains(ix))
                    .map(|(_, line)| (line, 0., 0.))
                    .collect();
                Painter::new(&mut pixmap, base, &job.fonts, &job.images).clear_lines(&rows, PT, ROW_SIDE);
            }
        }
    }
    // Live units: clear the bands their rows occupy now (they may reach
    // into following material until the next layout), put their cached
    // pictures back, then draw their rows, so a picture never covers live
    // text and no clear erases a picture already placed.
    for (overlay, _) in &job.overlays {
        Painter::new(&mut pixmap, base, &job.fonts, &job.images).clear_rects(&row_bands(&overlay.rows));
    }
    for (snap, dst) in &snaps {
        let (x, y, _, _) = device_rect(base, *dst);
        pixmap.draw_pixmap(x, y, snap.as_ref(), &PixmapPaint::default(), Transform::identity(), None);
    }
    for (overlay, _) in &job.overlays {
        let mut painter = Painter::new(&mut pixmap, base, &job.fonts, &job.images);
        let dl = &overlay.overlay.dl;
        painter.draw(dl, &dl.other, 0., 0.);
        for row in &overlay.rows {
            painter.draw(dl, &row.line.items, row.dx, row.dy);
        }
    }
    Some(pixmap)
}

/// The pixmap as straight-alpha BGRA, the order GPUI uploads, turned dark
/// with the viewer's page filter when `dark` (`pdf/dark.rs`).
pub fn to_bgra(pixmap: &Pixmap, dark: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixmap.data().len());
    for pixel in pixmap.pixels() {
        let color = pixel.demultiply();
        let (mut r, mut g, mut b) = (color.red(), color.green(), color.blue());
        if dark && color.alpha() > 0 {
            let [dr, dg, db] = crate::pdf::dark_filter([r, g, b].map(|c| f32::from(c) / 255.))
                .map(|c| (c * 255.).round() as u8);
            (r, g, b) = (dr, dg, db);
        }
        out.extend([b, g, r, color.alpha()]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_preview::protocol::FontDesc;

    #[test]
    fn matrices_compose_with_the_right_one_first() {
        let scale = Mat::scale(2.);
        let shift = Mat([1., 0., 0., 1., 10., 0.]);
        assert_eq!(scale.mul(shift).apply(1., 1.), (22., 2.));
        assert_eq!(shift.mul(scale).apply(1., 1.), (12., 2.));
    }

    #[test]
    fn pdf_colors_take_the_fill_operator() {
        let red = pdf_color("1 0 0 rg 0 0 1 RG").unwrap();
        assert_eq!((red.red(), red.green(), red.blue()), (1., 0., 0.));
        let stroke = pdf_color("0 0 1 RG").unwrap();
        assert_eq!(stroke.blue(), 1.);
        let grey = pdf_color("0.5 g").unwrap();
        assert_eq!(grey.green(), 0.5);
        let cyan = pdf_color("1 0 0 0 k").unwrap();
        assert_eq!((cyan.red(), cyan.green()), (0., 1.));
        assert!(pdf_color("").is_none());
    }

    fn page_with_rule() -> PageUpdate {
        PageUpdate {
            page: 1,
            exact: true,
            dl: DisplayList {
                lines: vec![Line {
                    x: 10. * PT,
                    y: 20. * PT,
                    w: 30. * PT,
                    h: 5. * PT,
                    d: 0.,
                    items: vec![
                        Item::Color { stack: 0, cmd: Some(1), data: "1 0 0 rg".into() },
                        Item::Rule { x: 10. * PT, y_top: 15. * PT, w: 30. * PT, h: 5. * PT },
                    ],
                    ..Line::default()
                }],
                ..DisplayList::default()
            },
        }
    }

    #[test]
    fn a_display_list_page_is_drawn_whole_on_paper() {
        let page = Arc::new(page_with_rule());
        let pixmap = compose(PageJob {
            width_px: 100,
            height_px: 100,
            k: 1. / PT,
            source: JobSource::DisplayList(page),
            overlays: Vec::new(),
            fonts: FontStore::default(),
            images: ImageStore::default(),
        })
        .unwrap();
        let at = |x: u32, y: u32| pixmap.pixel(x, y).unwrap();
        // Paper everywhere, and the red rule where the list puts it.
        assert_eq!((at(2, 2).red(), at(2, 2).green(), at(2, 2).alpha()), (255, 255, 255));
        let rule = at(20, 17);
        assert_eq!((rule.red(), rule.green(), rule.blue()), (255, 0, 0));
    }

    #[test]
    fn a_page_needing_a_font_still_loading_is_not_drawn() {
        let mut page = page_with_rule();
        page.dl.fonts.insert(
            "1".into(),
            FontDesc { id: 1, name: Some("cmr10".into()), ..FontDesc::default() },
        );
        page.dl.lines[0].items.push(Item::Glyph { font: 1, char: 65, index: None, x: 0., y: 0., ef: 0. });
        let job = PageJob {
            width_px: 10,
            height_px: 10,
            k: 1. / PT,
            source: JobSource::DisplayList(Arc::new(page)),
            overlays: Vec::new(),
            fonts: FontStore::default(),
            images: ImageStore::default(),
        };
        assert!(compose(job).is_none());
    }

    #[test]
    fn a_base_page_is_transparent_but_for_the_live_rows() {
        let page = Arc::new(page_with_rule());
        let overlay = crate::live_preview::model::Overlay {
            par_id: 1,
            dl: Arc::new(page.dl.clone()),
            fragments: Vec::new(),
            revision: 2,
        };
        let row = OverlayRow { line: page.dl.lines[0].clone(), dx: 0., dy: 40. * PT };
        let pixmap = compose(PageJob {
            width_px: 100,
            height_px: 100,
            k: 1. / PT,
            source: JobSource::Base { page: Some(page) },
            overlays: vec![(PageOverlay { overlay, rows: vec![row] }, HashSet::from([0]))],
            fonts: FontStore::default(),
            images: ImageStore::default(),
        })
        .unwrap();
        let at = |x: u32, y: u32| pixmap.pixel(x, y).unwrap();
        // Far from both rows the PDF shows through.
        assert_eq!(at(95, 95).alpha(), 0);
        // The old row is cleared to paper, the new one drawn red.
        let old = at(20, 17);
        assert_eq!((old.red(), old.green(), old.alpha()), (255, 255, 255));
        let new = at(20, 57);
        assert_eq!((new.red(), new.green()), (255, 0));
        let bgra = to_bgra(&pixmap, false);
        let ix = (57 * 100 + 20) * 4;
        assert_eq!(&bgra[ix..ix + 4], &[0, 0, 255, 255]);
    }

    #[test]
    fn rows_close_together_clear_the_gap_between_them() {
        let row = |y: f64| OverlayRow {
            line: Line { x: 0., y, w: 10. * PT, h: 7. * PT, d: 2. * PT, ..Line::default() },
            dx: 0.,
            dy: 0.,
        };
        let bands = row_bands(&[row(20. * PT), row(32. * PT)]);
        assert_eq!(bands[1][1], bands[0][3]);
    }
}
