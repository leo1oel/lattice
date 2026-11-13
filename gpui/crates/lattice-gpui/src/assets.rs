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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_lucide_icon_draws_gpui_kits_lucide_file() {
        let kit = gpui_kit::assets::AllAssets::new("");
        for (icon, name) in lattice_ui::icons::LUCIDE {
            let lucide = format!("icons/{name}.svg");
            let expected = kit.load(&lucide).unwrap().expect(&lucide);
            let loaded = Assets.load(icon.0).unwrap().expect(icon.0);
            assert!(
                loaded == expected,
                "{} does not draw Lucide's {name}.svg",
                icon.0
            );
        }
    }
}
