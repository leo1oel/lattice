// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Standalone SVG from the display list, for Markdown / HTML export and
//! thumbnails. Port of the SVG half of Excalidraw `excalidraw/scene/
//! export.ts` (`exportToSvg`, `configExportDimension`, frame labels and clip
//! paths) and `excalidraw/renderer/staticSvgScene.ts` @ 3a317b5, drawing
//! `display.rs` items instead of rough.js nodes.
//!
//! Same layout as upstream: the common bounds of the root elements (and
//! frame labels) plus `padding` on each side, `viewBox` and size at scale 1,
//! the `svg-source:excalidraw` comment, a background rect unless transparent,
//! one `<g transform="translate(x y) rotate(deg cx cy)">` per element (inside
//! a `clip-path` group for frame children, in an `<a>` when linked), path
//! data rounded to `MAX_DECIMALS_FOR_SVG_EXPORT`, text as `<text>` lines with
//! the font family names, images as `<symbol>` + `<use>`, the fonts inlined
//! as `@font-face` data URLs (`font_faces`). Differences: fonts are TrueType
//! subsets (`font_subset.rs`), not woff2, the scene isn't
//! embedded as metadata (the `.excalidraw` file travels alongside), and
//! element opacity is multiplied into each paint's opacity.

use super::bounds::{get_common_bounds, get_element_absolute_coords};
use super::color::{Rgba, color_or_black};
use super::consts::{DEFAULT_EXPORT_PADDING, FrameStyle, MAX_DECIMALS_FOR_SVG_EXPORT};
use super::display::*;
use super::json::js_number;
use super::shape::PathCmd;
use super::text_measure::{Measure, get_font_family_string};
use super::types::{Element, FileData, TextAlign};
use super::utils::{ElementsMap, hash_string, is_invisibly_small_element, normalize_link};
use rustc_hash::FxHashMap;
use std::collections::BTreeMap;
use std::fmt::Write;

pub struct SvgExportOpts<'a> {
    /// Space around the content (`DEFAULT_EXPORT_PADDING`).
    pub padding: f64,
    /// The canvas color (`viewBackgroundColor`): fills the `*_outline`
    /// arrowheads, and the background when `paint_background`.
    pub background: String,
    pub paint_background: bool,
    pub frames: RenderOpts,
    /// What an image's `href` is; defaults to the file's data URL. Images
    /// without one aren't drawn, as upstream.
    pub image_href: Option<&'a dyn Fn(&FileData) -> Option<String>>,
    /// \`exportWithDarkMode\`: the root carries upstream's \`THEME_FILTER\`.
    pub dark: bool,
}

impl Default for SvgExportOpts<'_> {
    fn default() -> Self {
        SvgExportOpts {
            padding: DEFAULT_EXPORT_PADDING,
            background: "#ffffff".into(),
            paint_background: true,
            frames: RenderOpts::default(),
            image_href: None,
            dark: false,
        }
    }
}

/// `MAX_DECIMALS_FOR_SVG_EXPORT` rounding (`+n.toFixed(2)`).
fn num(v: f64) -> String {
    let m = 10f64.powi(MAX_DECIMALS_FOR_SVG_EXPORT);
    let r = (v * m).round() / m;
    js_number(if r == 0. { 0. } else { r })
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

/// Ids made safe for `url(#…)`.
fn id_of(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn path_data(cmds: &[PathCmd]) -> String {
    let mut d = String::new();
    for c in cmds {
        if !d.is_empty() {
            d.push(' ');
        }
        match *c {
            PathCmd::MoveTo(p) => {
                let _ = write!(d, "M{} {}", num(p[0]), num(p[1]));
            }
            PathCmd::LineTo(p) => {
                let _ = write!(d, "L{} {}", num(p[0]), num(p[1]));
            }
            PathCmd::QuadTo(a, p) => {
                let _ = write!(
                    d,
                    "Q{} {}, {} {}",
                    num(a[0]),
                    num(a[1]),
                    num(p[0]),
                    num(p[1])
                );
            }
            PathCmd::CubicTo(a, b, p) => {
                let _ = write!(
                    d,
                    "C{} {}, {} {}, {} {}",
                    num(a[0]),
                    num(a[1]),
                    num(b[0]),
                    num(b[1]),
                    num(p[0]),
                    num(p[1])
                );
            }
            PathCmd::Close => d.push('Z'),
        }
    }
    d
}

struct Ctx<'a> {
    background: Rgba,
    opacity: f64,
    files: &'a BTreeMap<String, FileData>,
    href: Option<&'a dyn Fn(&FileData) -> Option<String>>,
    defs: &'a mut String,
    symbols: &'a mut FxHashMap<String, ()>,
}

impl Ctx<'_> {
    fn rgba(&self, p: Paint) -> Rgba {
        match p {
            Paint::Color(c) => c,
            Paint::CanvasBackground => self.background,
        }
    }
    fn paint_attrs(&self, out: &mut String, kind: &str, p: Paint) {
        let c = self.rgba(p);
        let _ = write!(out, r#" {kind}="{}""#, c.hex_rgb());
        let a = c.alpha() * self.opacity;
        if a < 1. {
            let _ = write!(out, r#" {kind}-opacity="{}""#, js_number(a));
        }
    }
}

fn write_item(o: &mut String, it: &DisplayItem, cx: &mut Ctx, ed: &ElementDisplay) {
    match it {
        DisplayItem::Path { cmds, fill, stroke } => {
            let _ = write!(o, r#"<path d="{}""#, path_data(cmds));
            match fill {
                Some(f) => {
                    cx.paint_attrs(o, "fill", f.paint);
                    if f.rule == FillRule::EvenOdd {
                        o.push_str(r#" fill-rule="evenodd""#);
                    }
                }
                None => o.push_str(r#" fill="none""#),
            }
            match stroke {
                Some(s) => {
                    cx.paint_attrs(o, "stroke", s.paint);
                    let _ = write!(o, r#" stroke-width="{}""#, js_number(s.width));
                    if let Some(d) = &s.dash {
                        let _ = write!(
                            o,
                            r#" stroke-dasharray="{}""#,
                            d.iter()
                                .map(|v| js_number(*v))
                                .collect::<Vec<_>>()
                                .join(" ")
                        );
                    }
                    let cap = match s.cap {
                        LineCap::Butt => "butt",
                        LineCap::Round => "round",
                        LineCap::Square => "square",
                    };
                    let join = match s.join {
                        LineJoin::Miter => "miter",
                        LineJoin::Round => "round",
                        LineJoin::Bevel => "bevel",
                    };
                    let _ = write!(o, r#" stroke-linecap="{cap}" stroke-linejoin="{join}""#);
                }
                None => o.push_str(r#" stroke="none""#),
            }
            o.push_str("></path>");
        }
        DisplayItem::Text(t) => {
            let anchor = if t.align == TextAlign::Center {
                "middle"
            } else if t.align == TextAlign::Right || t.rtl {
                "end"
            } else {
                "start"
            };
            let family = esc(&get_font_family_string(t.font_family));
            for l in &t.lines {
                let _ = write!(
                    o,
                    r#"<text x="{}" y="{}" font-family="{family}" font-size="{}px""#,
                    js_number(l.x),
                    js_number(l.baseline),
                    js_number(t.font_size)
                );
                cx.paint_attrs(o, "fill", t.color);
                let _ = write!(
                    o,
                    r#" text-anchor="{anchor}" style="white-space: pre;" direction="{}" dominant-baseline="alphabetic">{}</text>"#,
                    if t.rtl { "rtl" } else { "ltr" },
                    esc(&l.text)
                );
            }
        }
        DisplayItem::Image(img) => write_image(o, img, cx, ed),
    }
}

fn write_image(o: &mut String, img: &ImageItem, cx: &mut Ctx, ed: &ElementDisplay) {
    let Some(fd) = img.file_id.as_deref().and_then(|id| cx.files.get(id)) else {
        return;
    };
    let Some(href) = cx.href.map_or_else(|| fd.data_url.clone(), |f| f(fd)) else {
        return;
    };
    let [_, _, w, h] = img.dest;
    let (uw, uh, ncx, ncy) = match (img.crop, img.natural_size) {
        (Some(c), Some([nw, nh])) => {
            let (uw, uh) = (w / (c[2] / nw), h / (c[3] / nh));
            (uw, uh, c[0] / (nw / uw), c[1] / (nh / uh))
        }
        _ => (w, h, 0., 0.),
    };
    let cropped = img.crop.is_some();
    let symbol = if cropped {
        format!(
            "image-crop-{}-{}",
            id_of(&fd.id),
            hash_string(&format!("{}x{}", js_number(uw), js_number(uh)))
        )
    } else {
        format!("image-{}", id_of(&fd.id))
    };
    if cx.symbols.insert(symbol.clone(), ()).is_none() {
        let (sw, sh) = if cropped {
            (js_number(uw), js_number(uh))
        } else {
            ("100%".into(), "100%".into())
        };
        let _ = write!(
            cx.defs,
            r#"<symbol id="{symbol}"><image href="{}" preserveAspectRatio="none" width="{sw}" height="{sh}"></image></symbol>"#,
            esc(&href)
        );
    }
    let (rw, rh) = (w.round(), h.round());
    let mut attrs = String::new();
    if cropped {
        let mask = format!("mask-image-crop-{}", id_of(&ed.id));
        let _ = write!(
            cx.defs,
            r##"<mask id="{mask}" fill="#fff"><rect x="{}" y="{}" width="{}" height="{}"></rect></mask>"##,
            js_number(ncx),
            js_number(ncy),
            js_number(rw),
            js_number(rh)
        );
        let _ = write!(attrs, r#" mask="url(#{mask})""#);
    }
    if img.corner_radius > 0. {
        let clip = format!("image-clipPath-{}", id_of(&ed.id));
        let r = js_number(img.corner_radius);
        let _ = write!(
            cx.defs,
            r#"<clipPath id="{clip}" clipPathUnits="userSpaceOnUse"><rect x="{}" y="{}" width="{}" height="{}" rx="{r}" ry="{r}"></rect></clipPath>"#,
            js_number(ncx),
            js_number(ncy),
            js_number(w),
            js_number(h)
        );
        let _ = write!(attrs, r#" clip-path="url(#{clip})""#);
    }
    // the element group's transform, shifted by the crop
    let (acx, acy) = (ed.center[0] + ncx, ed.center[1] + ncy);
    let _ = write!(
        o,
        r#"<g transform="translate({} {}) rotate({} {} {})"{attrs}>"#,
        js_number(ed.origin[0] - ncx),
        js_number(ed.origin[1] - ncy),
        js_number(ed.angle.to_degrees()),
        js_number(acx),
        js_number(acy)
    );
    let _ = write!(
        o,
        r##"<use href="#{symbol}" width="{}" height="{}" opacity="{}""##,
        js_number(rw + ncx),
        js_number(rh + ncy),
        js_number(cx.opacity)
    );
    if img.flip != [1., 1.] {
        let _ = write!(
            o,
            r#" transform="translate({} {}) scale({} {}) translate({} {})""#,
            js_number(acx),
            js_number(acy),
            js_number(img.flip[0]),
            js_number(img.flip[1]),
            js_number(-acx),
            js_number(-acy)
        );
    }
    o.push_str("></use></g>");
}

fn write_element(o: &mut String, ed: &ElementDisplay, offset: [f64; 2], cx: &mut Ctx) {
    cx.opacity = ed.opacity;
    let mut close = vec![];
    if let Some(l) = &ed.link {
        let _ = write!(o, r#"<a href="{}">"#, esc(&normalize_link(l)));
        close.push("</a>");
    }
    if let Some(c) = &ed.clip {
        let _ = write!(o, r#"<g clip-path="url(#clip-{})">"#, id_of(&c.frame_id));
        close.push("</g>");
    }
    let is_image = ed.items.iter().any(|i| matches!(i, DisplayItem::Image(_)));
    if is_image {
        // images carry their own (crop-shifted) group
        let shifted = ElementDisplay {
            origin: [ed.origin[0] + offset[0], ed.origin[1] + offset[1]],
            ..ed.clone()
        };
        for it in &ed.items {
            write_item(o, it, cx, &shifted);
        }
    } else {
        let _ = write!(
            o,
            r#"<g transform="translate({} {}) rotate({} {} {})""#,
            js_number(ed.origin[0] + offset[0]),
            js_number(ed.origin[1] + offset[1]),
            js_number(ed.angle.to_degrees()),
            js_number(ed.center[0]),
            js_number(ed.center[1])
        );
        if let Some([kx, ky, kw, kh]) = ed.knockout {
            let mask = format!("mask-{}", id_of(&ed.id));
            let _ = write!(
                cx.defs,
                r##"<mask id="{mask}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><rect x="-100000" y="-100000" width="200000" height="200000" fill="#fff"></rect><rect x="{}" y="{}" width="{}" height="{}" fill="#000"></rect></mask>"##,
                js_number(kx),
                js_number(ky),
                js_number(kw),
                js_number(kh)
            );
            let _ = write!(o, r#" mask="url(#{mask})""#);
        }
        o.push('>');
        for it in &ed.items {
            write_item(o, it, cx, ed);
        }
        o.push_str("</g>");
    }
    for c in close.into_iter().rev() {
        o.push_str(c);
    }
}

/// The inlined fonts (`Fonts.generateFontFaceDeclarations` in
/// `excalidraw/fonts/Fonts.ts`): per text family in scene order, its font
/// cut down to the characters its texts use; Xiaolai first, with
/// Excalifont's characters, when those hold CJK. Families without a bundled
/// font (Helvetica, Liberation Sans) are left out, as upstream's local ones.
fn font_faces(elements: &[Element]) -> String {
    use super::text_measure::{
        XIAOLAI_FALLBACK, font_or_fallback_name, font_source, get_font_family_fallbacks,
    };
    let mut families: Vec<u32> = vec![];
    let mut chars: FxHashMap<u32, Vec<char>> = FxHashMap::default();
    for t in elements.iter().filter_map(|e| e.text()) {
        if !families.contains(&t.font_family) {
            families.push(t.font_family);
        }
        let set = chars.entry(t.font_family).or_default();
        for c in t.original_text.chars() {
            if !set.contains(&c) {
                set.push(c);
            }
        }
    }
    if let Some(&f) = families
        .iter()
        .find(|&&f| get_font_family_fallbacks(f).contains(&XIAOLAI_FALLBACK))
        && super::text_wrapping::contains_cjk(&chars[&f].iter().collect::<String>())
    {
        chars.insert(XIAOLAI_FALLBACK, chars[&f].clone());
        families.insert(0, XIAOLAI_FALLBACK);
    }
    let mut faces = vec![];
    for f in families {
        let (Some(name), Some(font)) = (font_or_fallback_name(f), font_source(f)) else {
            continue;
        };
        let Some(sub) = super::font_subset::subset(font, &chars[&f], f != XIAOLAI_FALLBACK) else {
            continue;
        };
        use base64::Engine;
        faces.push(format!(
            "@font-face {{ font-family: {name}; src: url(data:font/ttf;base64,{}); }}",
            base64::engine::general_purpose::STANDARD.encode(sub)
        ));
    }
    let delimiter = "\n      ";
    format!(
        r#"<style class="style-fonts">{delimiter}{}</style>"#,
        faces.join(delimiter)
    )
}

/// `exportToSvg`: the non-deleted `elements` as a standalone SVG document.
pub fn export_to_svg(
    elements: &[Element],
    files: &BTreeMap<String, FileData>,
    m: &dyn Measure,
    opts: &SvgExportOpts,
) -> String {
    let live: Vec<Element> = elements
        .iter()
        .filter(|e| !e.is_deleted && !is_invisibly_small_element(e))
        .cloned()
        .collect();
    let map: FxHashMap<&str, &Element> = live.iter().map(|e| (e.id.as_str(), e)).collect();
    let list = scene_display(&live, &map, m, &opts.frames);
    // getRootElements: bound text goes with its container
    let roots = live
        .iter()
        .filter(|e| !e.container_id().is_some_and(|c| map.has_element(c)));
    let mut b = get_common_bounds(roots, &map);
    if opts.frames.frame_name {
        for f in live.iter().filter(|e| e.is_frame_like()) {
            let (_, [x, y, w, h]) = frame_label(f, m);
            b = [b[0].min(x), b[1].min(y), b[2].max(x + w), b[3].max(y + h)];
        }
    }
    if live.is_empty() {
        b = [0., 0., 0., 0.];
    }
    let p = opts.padding;
    let (w, h) = ((b[2] - b[0]).abs() + p * 2., (b[3] - b[1]).abs() + p * 2.);
    let offset = [-(b[0] - p), -(b[1] - p)];

    let mut defs = String::new();
    let mut symbols = FxHashMap::default();
    // frame clip paths
    for f in live.iter().filter(|e| e.is_frame_like()) {
        let id = format!("clip-{}", id_of(&f.id));
        let [x1, y1, x2, y2, ..] = get_element_absolute_coords(f, &map, false);
        let (cx, cy) = ((x2 - x1) / 2. - (f.x - x1), (y2 - y1) / 2. - (f.y - y1));
        let _ = write!(
            defs,
            r#"<clipPath id="{id}"><rect transform="translate({} {}) rotate({} {} {})" width="{}" height="{}" rx="{r}" ry="{r}"></rect></clipPath>"#,
            js_number(f.x + offset[0]),
            js_number(f.y + offset[1]),
            js_number(f.angle.to_degrees()),
            js_number(cx),
            js_number(cy),
            js_number(f.width),
            js_number(f.height),
            r = js_number(FrameStyle::RADIUS)
        );
    }
    defs.push_str(&font_faces(&live));

    let mut body = String::new();
    {
        let mut cx = Ctx {
            background: color_or_black(&opts.background),
            opacity: 1.,
            files,
            href: opts.image_href,
            defs: &mut defs,
            symbols: &mut symbols,
        };
        for ed in &list {
            write_element(&mut body, ed, offset, &mut cx);
        }
    }

    let (ws, hs) = (js_number(w), js_number(h));
    let filter = if opts.dark {
        r#" filter="invert(93%) hue-rotate(180deg)""#
    } else {
        ""
    };
    let mut out = format!(
        r#"<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {ws} {hs}" width="{ws}" height="{hs}"{filter}><!-- svg-source:excalidraw --><metadata></metadata><defs>{defs}</defs>"#
    );
    if opts.paint_background && !color_or_black(&opts.background).is_transparent() {
        let bg = color_or_black(&opts.background);
        let _ = write!(
            out,
            r#"<rect x="0" y="0" width="{ws}" height="{hs}" fill="{}""#,
            bg.hex_rgb()
        );
        if bg.a < 255 {
            let _ = write!(out, r#" fill-opacity="{}""#, js_number(bg.alpha()));
        }
        out.push_str("></rect>");
    }
    out.push_str(&body);
    out.push_str("</svg>");
    out
}
