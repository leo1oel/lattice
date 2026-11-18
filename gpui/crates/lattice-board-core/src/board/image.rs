// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Image elements and their files. Port of Excalidraw
//! `packages/element/src/image.ts` @ 3a317b5, with the data half of image
//! insertion from `excalidraw/components/App.tsx` (`newImagePlaceholder`,
//! `getImageNaturalDimensions`, `insertImages`' layout via
//! `element/src/positionElementsOnGrid.ts`) and the file helpers of
//! `excalidraw/data/blob.ts` (`getMimeType`, `generateIdFromFile`,
//! `getDataURL_sync`, `dataURLToFile`, `normalizeFile`'s mime sniffing,
//! `isSupportedImageFileType`) and `common/src/constants.ts` (MIME types).
//!
//! Decoding pixels is the app's: `ImageCache` takes a decoder (upstream
//! loads an `HTMLImageElement`), and the natural size comes from it.
//! `normalizeSVG` works on the root tag's text instead of a DOM.
//! `resizeImageFile` (pica downscaling) is the app's too.

use super::app_state::AppState;
use super::bounds::get_common_bounds;
use super::mutate::new_element_with;
use super::new_element::{ElementOpts, new_image_element};
use super::types::{Element, FileData, ImageStatus};
use super::utils::get_grid_point;
use base64::Engine;
use regex::Regex;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BTreeMap;

/// `MIME_TYPES` (the ones the board reads or writes).
pub mod mime {
    pub const TEXT: &str = "text/plain";
    pub const HTML: &str = "text/html";
    pub const JSON: &str = "application/json";
    pub const EXCALIDRAW: &str = "application/vnd.excalidraw+json";
    pub const EXCALIDRAW_CLIPBOARD: &str = "application/vnd.excalidraw.clipboard+json";
    pub const EXCALIDRAWLIB: &str = "application/vnd.excalidrawlib+json";
    pub const BINARY: &str = "application/octet-stream";
    pub const SVG: &str = "image/svg+xml";
    pub const PNG: &str = "image/png";
    pub const JPG: &str = "image/jpeg";
    pub const GIF: &str = "image/gif";
    pub const WEBP: &str = "image/webp";
    pub const BMP: &str = "image/bmp";
    pub const ICO: &str = "image/x-icon";
    pub const AVIF: &str = "image/avif";
    pub const JFIF: &str = "image/jfif";
}

/// `IMAGE_MIME_TYPES`.
pub const IMAGE_MIME_TYPES: [&str; 9] = [
    mime::SVG,
    mime::PNG,
    mime::JPG,
    mime::GIF,
    mime::WEBP,
    mime::BMP,
    mime::ICO,
    mime::AVIF,
    mime::JFIF,
];
pub const SVG_NS: &str = "http://www.w3.org/2000/svg";

/// `isSupportedImageFileType`.
pub fn is_supported_image_file_type(t: &str) -> bool {
    IMAGE_MIME_TYPES.contains(&t)
}

/// `getMimeType` for a file name.
pub fn get_mime_type(name: &str) -> &'static str {
    let n = name;
    if n.ends_with(".excalidraw") || n.ends_with(".json") {
        mime::JSON
    } else if n.ends_with(".png") {
        mime::PNG
    } else if n.ends_with(".jpg") || n.ends_with(".jpeg") {
        mime::JPG
    } else if n.ends_with(".svg") {
        mime::SVG
    } else if n.ends_with(".excalidrawlib") {
        mime::EXCALIDRAWLIB
    } else {
        ""
    }
}

/// `getActualMimeTypeFromImage`: png / jpg / gif / webp by leading bytes.
pub fn sniff_image_mime_type(bytes: &[u8]) -> Option<&'static str> {
    let b = |p: &[u8]| bytes.starts_with(p);
    if b(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        Some(mime::PNG)
    } else if b(&[255, 216, 255]) {
        Some(mime::JPG)
    } else if b(&[71, 73, 70, 56, 57, 97]) {
        Some(mime::GIF)
    } else if bytes.len() >= 15 && b(b"RIFF") && &bytes[8..15] == b"WEBPVP8" {
        Some(mime::WEBP)
    } else {
        None
    }
}

/// `normalizeFile`: the mime type a dropped / pasted file is treated as.
/// `.excalidraw(lib)` by name; images (or no type) by their leading bytes.
pub fn normalize_file_mime_type(name: &str, declared: &str, bytes: &[u8]) -> String {
    if name.ends_with(".excalidrawlib") {
        return mime::EXCALIDRAWLIB.into();
    }
    if name.ends_with(".excalidraw") {
        return mime::EXCALIDRAW.into();
    }
    if (declared.is_empty() || declared.starts_with("image/"))
        && let Some(m) = sniff_image_mime_type(bytes)
    {
        return m.into();
    }
    declared.into()
}

/// `generateIdFromFile`: the SHA-1 digest of the file, hex.
pub fn generate_id_from_file(bytes: &[u8]) -> String {
    sha1_smol::Sha1::from(bytes).digest().to_string()
}

/// `getDataURL_sync`.
pub fn get_data_url(bytes: &[u8], mime_type: &str) -> String {
    format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// `dataURLToFile`: (mime type, bytes); None if it isn't a base64 data URL.
pub fn data_url_to_bytes(url: &str) -> Option<(String, Vec<u8>)> {
    let (head, data) = url.split_once(',')?;
    let mime = head.strip_prefix("data:")?.split(';').next()?.to_string();
    if head.ends_with(";base64") {
        Some((
            mime,
            base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .ok()?,
        ))
    } else {
        Some((mime, percent_decode(data)))
    }
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Some(v) = std::str::from_utf8(&b[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// `getInitializedImageElements`.
pub fn get_initialized_image_elements(elements: &[Element]) -> Vec<&Element> {
    elements
        .iter()
        .filter(|e| e.is_initialized_image())
        .collect()
}

/// `normalizeSVG`: an SVG with `xmlns`, a width and height (not `%` or
/// `auto`; from the viewBox, else 50) and a viewBox. Err if there's no
/// `<svg>` root.
pub fn normalize_svg(svg: &str) -> Result<String, String> {
    let open = Regex::new(r"(?s)<svg\b([^>]*)>").unwrap();
    let Some(m) = open.captures(svg) else {
        return Err("Invalid SVG".into());
    };
    let attrs_src = m.get(1).unwrap();
    let (start, end) = (attrs_src.start(), attrs_src.end());
    let mut attrs = attrs_src.as_str().to_string();
    let self_closing = attrs.trim_end().ends_with('/');
    if self_closing {
        attrs = attrs.trim_end().trim_end_matches('/').to_string();
    }
    let attr_re = |name: &str| {
        Regex::new(&format!(
            r#"(?s)(^|\s){}\s*=\s*("([^"]*)"|'([^']*)')"#,
            regex::escape(name)
        ))
        .unwrap()
    };
    let get = |attrs: &str, name: &str| {
        attr_re(name).captures(attrs).map(|c| {
            c.get(3)
                .or(c.get(4))
                .map_or(String::new(), |v| v.as_str().to_string())
        })
    };
    let set = |attrs: &mut String, name: &str, value: &str| {
        let re = attr_re(name);
        if re.is_match(attrs) {
            *attrs = re
                .replace(attrs, |c: &regex::Captures| {
                    format!("{}{}=\"{}\"", &c[1], name, value)
                })
                .into_owned();
        } else {
            attrs.push_str(&format!(" {name}=\"{value}\""));
        }
    };
    if get(&attrs, "xmlns").is_none() {
        set(&mut attrs, "xmlns", SVG_NS);
    }
    let valid = |v: Option<String>| v.filter(|v| !v.is_empty() && !v.contains('%') && v != "auto");
    let mut width = valid(get(&attrs, "width"));
    let mut height = valid(get(&attrs, "height"));
    let view_box = get(&attrs, "viewBox");
    if width.is_none() || height.is_none() {
        let (mut w, mut h) = (
            width.unwrap_or_else(|| "50".into()),
            height.unwrap_or_else(|| "50".into()),
        );
        if let Some(vb) = &view_box
            && let Some(c) = Regex::new(r"\d+ +\d+ +(\d+(?:\.\d+)?) +(\d+(?:\.\d+)?)")
                .unwrap()
                .captures(vb)
        {
            (w, h) = (c[1].to_string(), c[2].to_string());
        }
        set(&mut attrs, "width", &w);
        set(&mut attrs, "height", &h);
        (width, height) = (Some(w), Some(h));
    }
    if view_box.is_none() {
        set(
            &mut attrs,
            "viewBox",
            &format!("0 0 {} {}", width.unwrap(), height.unwrap()),
        );
    }
    if self_closing {
        attrs.push_str(" /");
    }
    Ok(format!("{}{}{}", &svg[..start], attrs, &svg[end..]))
}

// ---------------------------------------------------------------------------
// image cache
// ---------------------------------------------------------------------------

/// An `imageCache` entry: the decoded image and its file's mime type.
#[derive(Clone, Debug, PartialEq)]
pub struct CachedImage<T> {
    pub image: T,
    pub mime_type: String,
}

/// `AppClassProperties["imageCache"]`, file id → decoded image.
#[derive(Clone, Debug)]
pub struct ImageCache<T> {
    pub map: FxHashMap<String, CachedImage<T>>,
}
impl<T> Default for ImageCache<T> {
    fn default() -> Self {
        ImageCache {
            map: FxHashMap::default(),
        }
    }
}

/// What `updateImageCache` reports.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ImageCacheUpdate {
    /// Includes errored files, whose cache was updated nonetheless.
    pub updated_files: FxHashSet<String>,
    /// Files that failed to decode.
    pub errored_files: FxHashSet<String>,
}

impl<T> ImageCache<T> {
    pub fn get(&self, id: &str) -> Option<&CachedImage<T>> {
        self.map.get(id)
    }
    pub fn has(&self, id: &str) -> bool {
        self.map.contains_key(id)
    }

    /// `updateImageCache`: (re)decodes the files with these ids (even if
    /// cached). Binary files are errors; `decode` gets the file as stored.
    pub fn update(
        &mut self,
        file_ids: &[&str],
        files: &BTreeMap<String, FileData>,
        mut decode: impl FnMut(&FileData) -> Result<T, String>,
    ) -> ImageCacheUpdate {
        let mut r = ImageCacheUpdate::default();
        for &id in file_ids {
            let Some(f) = files.get(id) else { continue };
            if !r.updated_files.insert(id.into()) {
                continue;
            }
            let image = if f.mime_type == mime::BINARY {
                Err("Only images can be added to ImageCache".into())
            } else {
                decode(f)
            };
            match image {
                Ok(image) => {
                    self.map.insert(
                        id.into(),
                        CachedImage {
                            image,
                            mime_type: f.mime_type.clone(),
                        },
                    );
                }
                Err(_) => {
                    r.errored_files.insert(id.into());
                }
            }
        }
        r
    }
}

/// `App.updateImageCache`'s follow-up: image elements whose file failed get
/// `status: "error"`. Returns whether any changed.
pub fn mark_errored_images(elements: &mut [Element], errored: &FxHashSet<String>) -> bool {
    let mut changed = false;
    for e in elements.iter_mut() {
        let hit = e
            .image()
            .and_then(|i| i.file_id.as_deref())
            .is_some_and(|f| errored.contains(f));
        if hit && e.is_initialized_image() {
            *e = new_element_with(
                e,
                |e| {
                    if let Some(i) = e.image_mut() {
                        i.status = ImageStatus::Error
                    }
                },
                false,
            );
            changed = true;
        }
    }
    changed
}

/// `addNewImagesToImageCache`' selection: file ids of non-deleted
/// initialized images not cached yet.
pub fn uncached_image_file_ids<'a, T>(
    elements: &'a [Element],
    cache: &ImageCache<T>,
) -> Vec<&'a str> {
    let mut seen = FxHashSet::default();
    elements
        .iter()
        .filter(|e| !e.is_deleted && e.is_initialized_image())
        .filter_map(|e| e.image().and_then(|i| i.file_id.as_deref()))
        .filter(|f| !cache.has(f) && seen.insert(*f))
        .collect()
}

// ---------------------------------------------------------------------------
// insertion
// ---------------------------------------------------------------------------

/// `newImagePlaceholder`: a 100px (on screen) placeholder centered on the
/// scene point, snapped to `grid_size`. `frame_id`: the top-layer frame
/// there, which the app looks up.
pub fn new_image_placeholder(
    app: &AppState,
    scene_x: f64,
    scene_y: f64,
    grid_size: Option<f64>,
    frame_id: Option<String>,
) -> Element {
    let [gx, gy] = get_grid_point(scene_x, scene_y, grid_size);
    let size = 100. / app.zoom;
    new_image_element(
        ElementOpts {
            stroke_color: app.current_item_stroke_color.clone(),
            background_color: app.current_item_background_color.clone(),
            fill_style: app.current_item_fill_style,
            stroke_width: app.current_item_stroke_width(false),
            stroke_style: app.current_item_stroke_style,
            roughness: app.current_item_roughness,
            roundness: None,
            opacity: app.current_item_opacity,
            locked: false,
            frame_id,
            x: gx - size / 2.,
            y: gy - size / 2.,
            width: size,
            height: size,
            ..Default::default()
        },
        None,
        None,
        None,
        None,
    )
}

/// `getImageNaturalDimensions`: the image's size once loaded (at most half
/// the view height, and its natural size), centered where the placeholder
/// was. Returns (x, y, width, height); the crop resets.
pub fn get_image_natural_dimensions(
    e: &Element,
    natural_width: f64,
    natural_height: f64,
    view_height: f64,
    zoom: f64,
) -> (f64, f64, f64, f64) {
    let min_height = (view_height - 120.).max(160.);
    let max_height = min_height.min((view_height * 0.5).floor() / zoom);
    let height = natural_height.min(max_height);
    let width = height * (natural_width / natural_height);
    (
        e.x + e.width / 2. - width / 2.,
        e.y + e.height / 2. - height / 2.,
        width,
        height,
    )
}

/// Initializes a placeholder (`initializeImage`'s element half): the file
/// id, and the natural dimensions once decoded.
pub fn initialize_image_element(
    placeholder: &Element,
    file_id: &str,
    natural: Option<(f64, f64)>,
    view_height: f64,
    zoom: f64,
) -> Element {
    new_element_with(
        placeholder,
        |e| {
            if let Some((nw, nh)) = natural {
                let (x, y, w, h) = get_image_natural_dimensions(e, nw, nh, view_height, zoom);
                (e.x, e.y, e.width, e.height) = (x, y, w, h);
                if let Some(i) = e.image_mut() {
                    i.crop = None;
                }
            }
            if let Some(i) = e.image_mut() {
                i.file_id = Some(file_id.into());
            }
        },
        false,
    )
}

/// `positionElementsOnGrid`: lays out units (an element, or elements kept
/// together) in a roughly square grid centered on the point, `padding` apart.
pub fn position_elements_on_grid(
    units: &[Vec<Element>],
    center_x: f64,
    center_y: f64,
    padding: f64,
) -> Vec<Element> {
    if units.is_empty() {
        return vec![];
    }
    let cols = ((units.len() as f64).sqrt().ceil() as usize).max(1);
    let rows: Vec<&[Vec<Element>]> = units.chunks(cols).collect();
    let mut total_h = 0.;
    let props: Vec<(Vec<([f64; 4], f64, f64)>, f64, f64)> = rows
        .iter()
        .map(|row| {
            let ub: Vec<_> = row
                .iter()
                .map(|u| {
                    let b = get_common_bounds(u.iter(), u);
                    (b, b[2] - b[0], b[3] - b[1])
                })
                .collect();
            let w =
                ub.iter().map(|u| u.1).sum::<f64>() + padding * (ub.len().saturating_sub(1)) as f64;
            let h = ub.iter().map(|u| u.2).fold(0., f64::max);
            total_h += h;
            (ub, w, h)
        })
        .collect();
    let mut y = center_y - (total_h + (rows.len() - 1) as f64 * padding) / 2.;
    let mut res = vec![];
    for (row, (ub, rw, rh)) in rows.iter().zip(props) {
        let mut x = center_x - rw / 2.;
        for (unit, (b, w, _)) in row.iter().zip(ub) {
            let (dx, dy) = (x - b[0], y - b[1]);
            res.extend(unit.iter().map(|e| {
                new_element_with(
                    e,
                    |e| {
                        e.x += dx;
                        e.y += dy;
                    },
                    false,
                )
            }));
            x += w + padding;
        }
        y += rh + padding;
    }
    res
}
