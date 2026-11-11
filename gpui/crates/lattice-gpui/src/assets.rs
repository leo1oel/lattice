//! One asset source for every library: Lattice's own (`lattice/…`: the app's
//! chrome marks and file glyphs), Zed's (fonts, editor icons, themes) and
//! GPUI Kit's (its Lucide icon set). A GPUI application has exactly one.

use std::borrow::Cow;

use gpui::{App, AssetSource, Result, SharedString};

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Ok(Some(data)) = lattice_ui::UiAssets.load(path) {
            return Ok(Some(data));
        }
        if let Ok(Some(data)) = assets::Assets.load(path) {
            return Ok(Some(data));
        }
        gpui_kit::assets::AllAssets::new("").load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut entries = lattice_ui::UiAssets.list(path)?;
        entries.extend(assets::Assets.list(path)?);
        entries.extend(gpui_kit::assets::AllAssets::new("").list(path)?);
        entries.sort();
        entries.dedup();
        Ok(entries)
    }
}

/// Register Zed's bundled fonts (Lilex for code, IBM Plex for UI).
pub fn load_fonts(cx: &App) {
    if let Err(error) = assets::Assets.load_fonts(cx) {
        log::warn!("could not load bundled fonts: {error:#}");
    }
}
