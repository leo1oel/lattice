//! Loading the font and image files display lists refer to
//! (`src/live-preview/rtex-resources.ts`, adapted there from
//! realtime-tex-vsc-plugin's `src/resources.ts`, MIT License, Copyright (c)
//! 2026 Henry Yang; see THIRD_PARTY_NOTICES.md).
//!
//! lattice-core reads the files (`live_preview::read_font_file`, which finds
//! TeX fonts with kpsewhich and refuses anything that is not a font, an
//! encoding, a map file or a virtual font's metrics; `read_image_file`, a
//! project image), and this module turns the bytes into what the renderer
//! draws. Everything here blocks: it runs on a background thread.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};

use lattice_core::live_preview::{read_font_file, read_image_file};

use super::{
    fonts::FontResource,
    protocol::{DisplayList, FontDesc},
    type1::{MapEntry, parse_enc_file, parse_map_file, type1_outlines},
    virtual_font::{parse_tfm, parse_virtual_font, virtual_font_names},
};

/// What an image file holds, before it is decoded or rasterized.
pub enum ImageResource {
    Bitmap(Vec<u8>),
    /// A PDF figure, drawn by PDFium at the page it names.
    Pdf {
        data: Vec<u8>,
        page: u32,
    },
    Missing(String),
}

/// The fonts `dls` need that `have` does not hold, by `FontDesc::key`.
pub fn fonts_wanted(
    dls: &[Arc<DisplayList>],
    have: &dyn Fn(&str) -> bool,
) -> Vec<(String, FontDesc)> {
    let mut want: HashMap<String, FontDesc> = HashMap::new();
    for dl in dls {
        for desc in dl.fonts.values() {
            let key = desc.key();
            if !have(&key) && !want.contains_key(&key) {
                want.insert(key, desc.clone());
            }
        }
    }
    want.into_iter().collect()
}

/// The image files `dls` draw that `have` does not hold, with the page of
/// each. Cached pictures live in the pass PDF, which draws their (degraded)
/// page.
pub fn images_wanted(dls: &[Arc<DisplayList>], have: &dyn Fn(&str) -> bool) -> Vec<(String, u32)> {
    let mut want: HashMap<String, u32> = HashMap::new();
    for dl in dls {
        for info in dl.images_info.iter().flat_map(HashMap::values) {
            if !info.file.is_empty() && !info.cached_picture && !have(&info.file) {
                want.insert(info.file.clone(), info.page.unwrap_or(1));
            }
        }
    }
    want.into_iter().collect()
}

/// pdftex.map, read once for the life of the process: it ties TFM names to
/// outlines. Without it, Type 1 (TFM) fonts are drawn from the PDF instead.
fn map() -> &'static HashMap<String, MapEntry> {
    static MAP: OnceLock<HashMap<String, MapEntry>> = OnceLock::new();
    MAP.get_or_init(|| {
        read_font_file("pdftex.map")
            .map(|bytes| parse_map_file(&String::from_utf8_lossy(&bytes)))
            .unwrap_or_default()
    })
}

/// A Type 1 font's outlines, read once per file and encoding for the life
/// of the process: several TFM names share one .pfb.
fn type1(file: &str, entry: Option<&MapEntry>) -> Result<FontResource, String> {
    type Outlines = Arc<super::type1::Type1Outlines>;
    static CACHE: OnceLock<Mutex<HashMap<(String, Option<String>), Outlines>>> = OnceLock::new();
    let enc = entry.and_then(|entry| entry.enc_file.clone());
    let key = (file.to_string(), enc.clone());
    let cache = CACHE.get_or_init(Mutex::default);
    let cached = cache.lock().ok().and_then(|cache| cache.get(&key).cloned());
    let outlines = match cached {
        Some(outlines) => outlines,
        None => {
            let encoding = enc.and_then(|enc| read_font_file(&enc).ok()).map(|bytes| {
                parse_enc_file(&bytes.iter().map(|b| char::from(*b)).collect::<String>())
            });
            let outlines = Arc::new(type1_outlines(&read_font_file(file)?, encoding.as_deref()));
            if let Ok(mut cache) = cache.lock() {
                cache.insert(key, outlines.clone());
            }
            outlines
        }
    };
    Ok(FontResource::Type1 {
        upem: outlines.upem,
        glyphs: outlines.glyphs.clone(),
        slant: entry.and_then(|entry| entry.slant),
        extend: entry.and_then(|entry| entry.extend),
    })
}

/// The resource of one display-list font.
pub fn load_font(desc: &FontDesc) -> FontResource {
    let loaded = match &desc.filename {
        Some(file) => {
            let lower = file.to_ascii_lowercase();
            if [".otf", ".ttf", ".ttc", ".otc"]
                .iter()
                .any(|ext| lower.ends_with(ext))
            {
                // LuaTeX numbers a collection's faces from 1.
                let collection = lower.ends_with(".ttc") || lower.ends_with(".otc");
                let index = if collection {
                    desc.subfont.unwrap_or(1).max(1) as u32 - 1
                } else {
                    0
                };
                read_font_file(file).map(|data| FontResource::Sfnt {
                    data: Arc::new(data),
                    index,
                })
            } else if lower.ends_with(".pfb") || lower.ends_with(".pfa") {
                let entry = desc.name.as_ref().and_then(|name| map().get(name));
                type1(file, entry)
            } else {
                Err(format!("unsupported font format: {file}"))
            }
        }
        None => Ok(load_tfm_font(desc.name.as_deref().unwrap_or_default(), 0)),
    };
    loaded.unwrap_or_else(FontResource::Missing)
}

/// A font TeX knows by its TFM name: an outline pdftex.map names, else a
/// virtual font over such fonts.
fn load_tfm_font(name: &str, depth: usize) -> FontResource {
    if let Some(entry) = map().get(name)
        && let Some(file) = &entry.font_file
    {
        let lower = file.to_ascii_lowercase();
        if lower.ends_with(".otf") || lower.ends_with(".ttf") {
            return FontResource::Missing(format!("TFM font mapped to OpenType ({file})"));
        }
        return type1(file, Some(entry)).unwrap_or_else(FontResource::Missing);
    }
    let vf = (depth < 3)
        .then(|| read_font_file(&format!("{name}.vf")).ok())
        .flatten();
    let Some(vf) = vf else {
        return FontResource::Missing(format!("no outline font for {name} in pdftex.map"));
    };
    let names = match virtual_font_names(&vf) {
        Ok(names) => names,
        Err(error) => return FontResource::Missing(error),
    };
    let widths: Vec<_> = names
        .iter()
        .map(|font| {
            read_font_file(&format!("{font}.tfm"))
                .ok()
                .and_then(|bytes| parse_tfm(&bytes).ok())
        })
        .collect();
    match parse_virtual_font(&vf, &|font| widths.get(font).cloned().flatten()) {
        Ok(virtual_font) => {
            let fonts = virtual_font
                .fonts
                .iter()
                .map(|font| load_tfm_font(&font.name, depth + 1))
                .collect();
            FontResource::Virtual {
                vf: virtual_font,
                fonts,
            }
        }
        Err(error) => FontResource::Missing(error),
    }
}

/// The bytes of a project image a display list draws.
pub fn load_image(root: &Path, file: &str, page: u32) -> ImageResource {
    let extension = file
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "pdf") {
        return ImageResource::Missing(format!("unsupported image format .{extension}"));
    }
    match read_image_file(root, file) {
        Ok(data) if extension == "pdf" => ImageResource::Pdf { data, page },
        Ok(data) => ImageResource::Bitmap(data),
        Err(error) => ImageResource::Missing(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desc(name: &str, filename: Option<&str>) -> FontDesc {
        FontDesc {
            name: Some(name.into()),
            filename: filename.map(str::to_string),
            ..FontDesc::default()
        }
    }

    #[test]
    fn only_fonts_and_images_not_held_are_wanted() {
        let dl: DisplayList = serde_json::from_str(
            r#"{"fonts":{"1":{"id":1,"name":"cmr10"},"2":{"id":2,"name":"x","filename":"/a.otf","subfont":1},"3":{"id":3,"name":"cmr10"}},
                "images_info":{"5":{"file":"fig.png"},"6":{"file":"tikz.pdf","cached_picture":true}}}"#,
        )
        .unwrap();
        let dls = [Arc::new(dl)];
        let mut fonts: Vec<String> = fonts_wanted(&dls, &|key| key == "file:/a.otf#1")
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        fonts.sort();
        assert_eq!(fonts, ["tfm:cmr10"]);
        assert_eq!(
            images_wanted(&dls, &|_| false),
            [("fig.png".to_string(), 1)]
        );
        assert!(images_wanted(&dls, &|file| file == "fig.png").is_empty());
    }

    #[test]
    fn an_unknown_format_is_missing_not_an_error() {
        assert!(matches!(
            load_font(&desc("x", Some("/fonts/x.woff2"))),
            FontResource::Missing(_)
        ));
        assert!(matches!(
            load_image(Path::new("/nowhere"), "figure.svg", 1),
            ImageResource::Missing(_)
        ));
    }

    /// Computer Modern by its TFM name, through pdftex.map, from the TeX
    /// tree.
    #[test]
    fn a_tfm_font_is_found_through_the_map_file() {
        if read_font_file("pdftex.map").is_err() {
            return;
        }
        assert!(matches!(
            load_font(&desc("cmr10", None)),
            FontResource::Type1 { upem: 1000., .. }
        ));
        // Times in T1 is virtual over Times in TeX's base encoding.
        if read_font_file("ptmr8t.vf").is_ok() {
            assert!(matches!(
                load_font(&desc("ptmr8t", None)),
                FontResource::Virtual { .. }
            ));
        }
    }
}
