//! The fonts and images display lists draw with, loaded
//! (`FontStore` and `ImageStore` of `src/live-preview/rtex-render.ts`, adapted
//! there from realtime-tex-vsc-plugin's `webview/render.ts`, MIT License,
//! Copyright (c) 2026 Henry Yang; see THIRD_PARTY_NOTICES.md).
//!
//! The stores live on the main thread; a page is drawn on a background
//! thread from a snapshot of them (`Arc`s), so a glyph's outline is cached
//! behind a lock its font carries.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tiny_skia::{Path, PathBuilder, Pixmap};

use super::{
    protocol::{DisplayList, FontDesc, ImageInfo},
    virtual_font::VirtualFont,
};

/// A font resource as read from the TeX tree, before it is drawn with.
pub enum FontResource {
    Sfnt { data: Arc<Vec<u8>>, index: u32 },
    Type1 {
        upem: f64,
        glyphs: HashMap<u32, Path>,
        slant: Option<f64>,
        extend: Option<f64>,
    },
    /// A TeX virtual font: its characters are drawn from the base fonts in
    /// `fonts` (`virtual_font.rs`).
    Virtual { vf: VirtualFont, fonts: Vec<FontResource> },
    Missing(String),
}

pub enum LoadedFont {
    Sfnt {
        upem: f64,
        data: Arc<Vec<u8>>,
        index: u32,
        glyph_count: u16,
        paths: Mutex<HashMap<u16, Option<Path>>>,
    },
    Type1 {
        upem: f64,
        glyphs: HashMap<u32, Path>,
        slant: Option<f64>,
        extend: Option<f64>,
    },
    Virtual {
        vf: VirtualFont,
        fonts: Vec<Arc<LoadedFont>>,
    },
    Missing(String),
}

impl LoadedFont {
    pub fn load(resource: FontResource) -> LoadedFont {
        match resource {
            FontResource::Sfnt { data, index } => match ttf_parser::Face::parse(&data, index) {
                Ok(face) => LoadedFont::Sfnt {
                    upem: f64::from(face.units_per_em()).max(1.),
                    glyph_count: face.number_of_glyphs(),
                    data: data.clone(),
                    index,
                    paths: Mutex::default(),
                },
                Err(error) => LoadedFont::Missing(format!("cannot parse font: {error}")),
            },
            FontResource::Type1 {
                upem,
                glyphs,
                slant,
                extend,
            } => LoadedFont::Type1 {
                upem,
                glyphs,
                slant,
                extend,
            },
            FontResource::Virtual { vf, fonts } => LoadedFont::Virtual {
                vf,
                fonts: fonts
                    .into_iter()
                    .map(|font| Arc::new(LoadedFont::load(font)))
                    .collect(),
            },
            FontResource::Missing(reason) => LoadedFont::Missing(reason),
        }
    }

    /// Outline of a glyph in font units (y up), or `None` when the font lacks
    /// it. An OpenType font is asked by glyph index, a Type 1 one by code.
    pub fn glyph(&self, index: Option<u32>, char: u32) -> Option<Path> {
        match self {
            LoadedFont::Sfnt {
                data,
                index: face_index,
                glyph_count,
                paths,
                ..
            } => {
                let id = u16::try_from(index?).ok().filter(|id| id < glyph_count)?;
                let mut paths = paths.lock().ok()?;
                if let Some(path) = paths.get(&id) {
                    return path.clone();
                }
                let path = ttf_parser::Face::parse(data, *face_index)
                    .ok()
                    .and_then(|face| {
                        let mut outline = Outline(PathBuilder::new());
                        face.outline_glyph(ttf_parser::GlyphId(id), &mut outline)?;
                        outline.0.finish()
                    });
                paths.insert(id, path.clone());
                path
            }
            LoadedFont::Type1 { glyphs, .. } => glyphs.get(&char).cloned(),
            LoadedFont::Virtual { .. } | LoadedFont::Missing(_) => None,
        }
    }

    /// Whether the font can draw this glyph exactly: a virtual one, every
    /// part of it. A glyph with no outline (a space) counts as drawable when
    /// the font holds it.
    pub fn drawable(&self, index: Option<u32>, char: u32) -> bool {
        match self {
            LoadedFont::Missing(_) => false,
            LoadedFont::Virtual { vf, fonts } => vf.chars.get(&char).is_some_and(|parts| {
                parts.iter().all(|part| match part {
                    super::virtual_font::VirtualPart::Rule { .. } => true,
                    super::virtual_font::VirtualPart::Char { font, char, .. } => fonts
                        .get(*font)
                        .is_some_and(|sub| sub.drawable(None, *char)),
                })
            }),
            LoadedFont::Sfnt { glyph_count, .. } => {
                index.is_some_and(|index| index < u32::from(*glyph_count))
            }
            LoadedFont::Type1 { glyphs, .. } => glyphs.contains_key(&char),
        }
    }
}

struct Outline(PathBuilder);

impl ttf_parser::OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.0.quad_to(x1, y1, x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.0.cubic_to(x1, y1, x2, y2, x, y);
    }
    fn close(&mut self) {
        self.0.close();
    }
}

/// The fonts loaded so far, by `FontDesc::key`.
#[derive(Clone, Default)]
pub struct FontStore {
    fonts: HashMap<String, Arc<LoadedFont>>,
}

impl FontStore {
    pub fn has(&self, key: &str) -> bool {
        self.fonts.contains_key(key)
    }

    pub fn add(&mut self, key: String, resource: FontResource) {
        self.fonts.insert(key, Arc::new(LoadedFont::load(resource)));
    }

    /// A font loaded off the main thread.
    pub fn insert(&mut self, key: String, font: Arc<LoadedFont>) {
        self.fonts.insert(key, font);
    }

    pub fn get(&self, desc: &FontDesc) -> Option<&Arc<LoadedFont>> {
        self.fonts.get(&desc.key())
    }

    /// Fonts that could not be loaded, and why: for diagnostics.
    pub fn missing(&self) -> Vec<(String, String)> {
        self.fonts
            .iter()
            .filter_map(|(key, font)| match font.as_ref() {
                LoadedFont::Missing(reason) => Some((key.clone(), reason.clone())),
                _ => None,
            })
            .collect()
    }
}

/// An image a display list draws: decoded into premultiplied pixels, still
/// loading, or not drawable.
#[derive(Clone)]
pub enum LoadedImage {
    Bitmap(Arc<Pixmap>),
    Pending,
    Missing(String),
}

/// The images loaded so far, by project-relative file name.
#[derive(Clone, Default)]
pub struct ImageStore {
    images: HashMap<String, LoadedImage>,
}

impl ImageStore {
    pub fn has(&self, file: &str) -> bool {
        self.images.contains_key(file)
    }

    pub fn get(&self, file: &str) -> Option<&LoadedImage> {
        self.images.get(file)
    }

    pub fn set(&mut self, file: String, image: LoadedImage) {
        self.images.insert(file, image);
    }
}

/// A pixmap from straight-alpha RGBA bytes.
pub fn pixmap_from_rgba(width: u32, height: u32, rgba: &[u8]) -> Option<Pixmap> {
    let mut pixmap = Pixmap::new(width, height)?;
    for (pixel, source) in pixmap
        .pixels_mut()
        .iter_mut()
        .zip(rgba.chunks_exact(4))
    {
        *pixel = tiny_skia::ColorU8::from_rgba(source[0], source[1], source[2], source[3])
            .premultiply();
    }
    Some(pixmap)
}

/// Decode a PNG or JPEG into a pixmap.
pub fn decode_bitmap(bytes: &[u8]) -> Result<Pixmap, String> {
    let image = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let rgba = image.into_rgba8();
    pixmap_from_rgba(rgba.width(), rgba.height(), rgba.as_raw())
        .ok_or_else(|| "the image is empty".to_string())
}

/// The image an image item refers to. Items carry LuaTeX's image index (1,
/// 2, … in creation order) while rtex keys `images_info` by
/// \lastsavedimageresourceindex (an object number); when the key does not
/// match, map by rank: both grow in creation order.
pub fn image_info(dl: &DisplayList, index: u64) -> Option<&ImageInfo> {
    let infos = dl.images_info.as_ref()?;
    if let Some(direct) = infos.get(&index.to_string()) {
        return Some(direct);
    }
    // Cached pictures are not LuaTeX images: leave them out of the ranking.
    let mut keys: Vec<u64> = infos
        .iter()
        .filter(|(_, info)| !info.cached_picture)
        .filter_map(|(key, _)| key.parse().ok())
        .collect();
    keys.sort_unstable();
    let key = keys.get(usize::try_from(index).ok()?.checked_sub(1)?)?;
    infos.get(&key.to_string())
}
