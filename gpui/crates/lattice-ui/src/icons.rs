//! Icons: Lucide line glyphs, the few chrome marks the app draws outside
//! Lucide's set, and the two-tone file glyphs.
//!
//! The Tauri app imports Lucide through `lucide-react`; GPUI Kit bundles the
//! same set as SVG assets (`icons/<name>.svg`), so the Lucide icons here are
//! paths into Kit's assets. GPUI paints an SVG as a mask in one colour, so a
//! file glyph, a stroke in its hue over a body filled with a tint of it, is
//! two SVGs stacked (`assets/icons/glyph-<kind>-body.svg` under
//! `glyph-<kind>.svg`).
//!
//! Sizes (DESIGN.md, Icons): 14px in the chrome, 16px on a default control,
//! in a dialog or a toast mark, 12px in a meta row or as a chevron beside a
//! label. Secondary ink at rest, primary when on, hovered or current.

use std::borrow::Cow;

use gpui::{
    AnyElement, AssetSource, Hsla, IntoElement, ParentElement as _, Pixels, Result, SharedString,
    Styled as _, Svg, div, px, svg,
};

use crate::{GlyphKind, Palette};

/// An icon: the asset path of its SVG.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Icon(pub &'static str);

impl Icon {
    // Lucide, from GPUI Kit's assets.
    pub const BOOK_OPEN: Icon = Icon("icons/book-open.svg");
    pub const BOT: Icon = Icon("icons/bot.svg");
    pub const CHECK: Icon = Icon("icons/check.svg");
    pub const CHEVRON_DOWN: Icon = Icon("icons/chevron-down.svg");
    pub const CHEVRON_LEFT: Icon = Icon("icons/chevron-left.svg");
    pub const CHEVRON_RIGHT: Icon = Icon("icons/chevron-right.svg");
    pub const CIRCLE_ALERT: Icon = Icon("icons/circle-alert.svg");
    pub const CIRCLE_CHECK: Icon = Icon("icons/circle-check.svg");
    pub const CLIPBOARD_CHECK: Icon = Icon("icons/clipboard-check.svg");
    pub const CLOUD: Icon = Icon("icons/cloud.svg");
    pub const FILE_TEXT: Icon = Icon("icons/file-text.svg");
    pub const FOLDER_TREE: Icon = Icon("icons/folder-tree.svg");
    pub const GLOBE: Icon = Icon("icons/globe.svg");
    pub const HAMMER: Icon = Icon("icons/hammer.svg");
    pub const HARD_DRIVE: Icon = Icon("icons/hard-drive.svg");
    pub const INFO: Icon = Icon("icons/info.svg");
    pub const LAYOUT_PANEL_LEFT: Icon = Icon("icons/layout-panel-left.svg");
    pub const LIBRARY: Icon = Icon("icons/library.svg");
    pub const LIST_TODO: Icon = Icon("icons/list-todo.svg");
    pub const LIST_TREE: Icon = Icon("icons/list-tree.svg");
    pub const LOADER: Icon = Icon("icons/loader-circle.svg");
    pub const LOCATE_FIXED: Icon = Icon("icons/locate-fixed.svg");
    pub const MESSAGE_SQUARE_TEXT: Icon = Icon("icons/message-square-text.svg");
    pub const PLUS: Icon = Icon("icons/plus.svg");
    pub const RECTANGLE_HORIZONTAL: Icon = Icon("icons/rectangle-horizontal.svg");
    pub const REFRESH: Icon = Icon("icons/refresh-cw.svg");
    pub const SEARCH: Icon = Icon("icons/search.svg");
    pub const TRIANGLE_ALERT: Icon = Icon("icons/triangle-alert.svg");
    pub const ZOOM_IN: Icon = Icon("icons/zoom-in.svg");
    pub const ZOOM_OUT: Icon = Icon("icons/zoom-out.svg");
    pub const ELLIPSIS: Icon = Icon("icons/ellipsis.svg");

    // The app's own, from `assets/icons`.
    /// The 1.5-stroke X a panel tab closes with.
    pub const CLOSE: Icon = Icon("lattice/close.svg");
    /// A panel's ⋯ menu: three filled dots.
    pub const DOTS: Icon = Icon("lattice/dots.svg");
    /// The tree's filled disclosure chevron, pointing down (open).
    pub const DISCLOSURE: Icon = Icon("lattice/disclosure.svg");
    /// The build chip's heavier check.
    pub const CHECK_HEAVY: Icon = Icon("lattice/check-heavy.svg");
    /// A checkbox's check: 3.5 stroke, drawn at 10px.
    pub const CHECK_MARK: Icon = Icon("lattice/check-mark.svg");
    /// Titlebar: Annotations, Git, History (Phosphor shapes the app draws).
    pub const ANNOTATIONS: Icon = Icon("lattice/annotations.svg");
    pub const GIT: Icon = Icon("lattice/git.svg");
    pub const HISTORY: Icon = Icon("lattice/history.svg");

    pub fn path(self) -> SharedString {
        self.0.into()
    }

    /// The icon at `size`, painted `color`.
    pub fn element(self, size: Pixels, color: Hsla) -> Svg {
        svg().path(self.0).size(size).flex_none().text_color(color)
    }
}

/// A file glyph: the body in its tint, the strokes in its hue.
pub fn file_glyph(kind: GlyphKind, size: Pixels, palette: &Palette) -> AnyElement {
    let (hue, tint) = palette.glyph(kind);
    let name = glyph_name(kind);
    div()
        .relative()
        .flex_none()
        .size(size)
        .child(
            svg()
                .absolute()
                .size(size)
                .path(format!("lattice/glyph-{name}-body.svg"))
                .text_color(tint),
        )
        .child(
            svg()
                .absolute()
                .size(size)
                .path(format!("lattice/glyph-{name}.svg"))
                .text_color(hue),
        )
        .into_any_element()
}

fn glyph_name(kind: GlyphKind) -> &'static str {
    match kind {
        GlyphKind::Tex => "tex",
        GlyphKind::Style => "style",
        GlyphKind::Bib => "bib",
        GlyphKind::Markdown => "markdown",
        GlyphKind::Pdf => "pdf",
        GlyphKind::Image => "image",
        GlyphKind::Board => "board",
        GlyphKind::Sheet => "sheet",
        GlyphKind::Slides => "slides",
        GlyphKind::Code => "code",
        GlyphKind::Config => "config",
        GlyphKind::Text => "text",
        GlyphKind::Folder => "folder",
    }
}

/// The 14px chrome size.
pub const ICON: Pixels = px(14.);
/// A meta row's or a chevron's 12px.
pub const ICON_SMALL: Pixels = px(12.);
/// A default control's 16px.
pub const ICON_LARGE: Pixels = px(16.);

macro_rules! bundled {
    ($($name:literal),* $(,)?) => {
        &[$((concat!("lattice/", $name), include_bytes!(concat!("../assets/icons/", $name)))),*]
    };
}

const BUNDLED: &[(&str, &[u8])] = bundled![
    "annotations.svg",
    "check-heavy.svg",
    "check-mark.svg",
    "close.svg",
    "disclosure.svg",
    "dots.svg",
    "git.svg",
    "history.svg",
    "glyph-bib-body.svg",
    "glyph-bib.svg",
    "glyph-board-body.svg",
    "glyph-board.svg",
    "glyph-code-body.svg",
    "glyph-code.svg",
    "glyph-config-body.svg",
    "glyph-config.svg",
    "glyph-folder-body.svg",
    "glyph-folder.svg",
    "glyph-image-body.svg",
    "glyph-image.svg",
    "glyph-markdown-body.svg",
    "glyph-markdown.svg",
    "glyph-pdf-body.svg",
    "glyph-pdf.svg",
    "glyph-sheet-body.svg",
    "glyph-sheet.svg",
    "glyph-slides-body.svg",
    "glyph-slides.svg",
    "glyph-style-body.svg",
    "glyph-style.svg",
    "glyph-tex-body.svg",
    "glyph-tex.svg",
    "glyph-text-body.svg",
    "glyph-text.svg",
];

/// The `lattice/…` assets. The app's asset source asks this one first and
/// falls through to Zed's and Kit's for everything else.
pub struct UiAssets;

impl AssetSource for UiAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(BUNDLED
            .iter()
            .find(|(name, _)| *name == path)
            .map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(BUNDLED
            .iter()
            .filter(|(name, _)| name.starts_with(path))
            .map(|(name, _)| (*name).into())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_icon_is_on_disk_and_every_file_is_bundled() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/icons");
        let mut on_disk: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| format!("lattice/{}", entry.file_name().to_string_lossy()))
            .collect();
        on_disk.sort();
        let mut bundled: Vec<String> = BUNDLED.iter().map(|(name, _)| name.to_string()).collect();
        bundled.sort();
        assert_eq!(on_disk, bundled);
    }

    #[test]
    fn every_glyph_kind_has_both_layers() {
        for kind in [
            GlyphKind::Tex,
            GlyphKind::Style,
            GlyphKind::Bib,
            GlyphKind::Markdown,
            GlyphKind::Pdf,
            GlyphKind::Image,
            GlyphKind::Board,
            GlyphKind::Sheet,
            GlyphKind::Slides,
            GlyphKind::Code,
            GlyphKind::Config,
            GlyphKind::Text,
            GlyphKind::Folder,
        ] {
            let name = glyph_name(kind);
            for layer in [
                format!("lattice/glyph-{name}-body.svg"),
                format!("lattice/glyph-{name}.svg"),
            ] {
                assert!(UiAssets.load(&layer).unwrap().is_some(), "{layer}");
            }
        }
    }
}
