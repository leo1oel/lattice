//! Icons: Lucide line glyphs, the few chrome marks the app draws outside
//! Lucide's set, and the two-tone file glyphs.
//!
//! The Tauri app imports Lucide through `lucide-react`; GPUI Kit bundles the
//! same set as SVG assets (`icons/<name>.svg`), so the Lucide icons here are
//! paths into Kit's assets, except the few whose names Zed's icon set
//! shadows, bundled here under `lattice/`. GPUI paints an SVG as a mask in
//! one colour, so a file glyph, a stroke in its hue over a body filled with a
//! tint of it, is two SVGs stacked (`assets/icons/glyph-<kind>-body.svg` under
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

/// Declares each Lucide icon once, as an `Icon` constant and as an entry in
/// [`LUCIDE`] naming its file in Lucide's set.
macro_rules! lucide {
    ($($(#[$meta:meta])* $name:ident = $dir:literal / $file:literal;)*) => {
        impl Icon {
            $($(#[$meta])* pub const $name: Icon = Icon(concat!($dir, "/", $file, ".svg"));)*
        }

        /// Every Lucide icon, with its name in Lucide's set: what it must
        /// draw, whichever asset source answers its path.
        pub const LUCIDE: &[(Icon, &str)] = &[$((Icon::$name, $file)),*];
    };
}

lucide! {
    // From GPUI Kit's assets.
    BOOK_OPEN = "icons" / "book-open";
    BOT = "icons" / "bot";
    CHEVRON_DOWN = "icons" / "chevron-down";
    CHEVRON_LEFT = "icons" / "chevron-left";
    CHEVRON_RIGHT = "icons" / "chevron-right";
    CIRCLE_ALERT = "icons" / "circle-alert";
    CIRCLE_CHECK = "icons" / "circle-check";
    CLIPBOARD_CHECK = "icons" / "clipboard-check";
    CLOUD = "icons" / "cloud";
    FILE_TEXT = "icons" / "file-text";
    FOLDER_TREE = "icons" / "folder-tree";
    GLOBE = "icons" / "globe";
    HAMMER = "icons" / "hammer";
    HARD_DRIVE = "icons" / "hard-drive";
    LAYOUT_PANEL_LEFT = "icons" / "layout-panel-left";
    LIBRARY = "icons" / "library";
    LIST_TODO = "icons" / "list-todo";
    LIST_TREE = "icons" / "list-tree";
    LOADER = "icons" / "loader-circle";
    LOCATE_FIXED = "icons" / "locate-fixed";
    MESSAGE_SQUARE_TEXT = "icons" / "message-square-text";
    RECTANGLE_HORIZONTAL = "icons" / "rectangle-horizontal";
    REFRESH = "icons" / "refresh-cw";
    SEARCH = "icons" / "search";
    TRIANGLE_ALERT = "icons" / "triangle-alert";
    ZOOM_IN = "icons" / "zoom-in";
    ZOOM_OUT = "icons" / "zoom-out";
    ARROW_LEFT = "icons" / "arrow-left";
    ARROW_RIGHT = "icons" / "arrow-right";
    ARROW_RIGHT_LEFT = "icons" / "arrow-right-left";
    BOOK_OPEN_TEXT = "icons" / "book-open-text";
    COLUMNS_2 = "icons" / "columns-2";
    COMPASS = "icons" / "compass";
    EYE_OFF = "icons" / "eye-off";
    FILE_PEN_LINE = "icons" / "file-pen-line";
    FOCUS = "icons" / "focus";
    FOLDER_OPEN = "icons" / "folder-open";
    LAYOUT_DASHBOARD = "icons" / "layout-dashboard";
    MAXIMIZE = "icons" / "maximize-2";
    MINIMIZE = "icons" / "minimize-2";
    PEN_LINE = "icons" / "pen-line";
    PICTURE_IN_PICTURE = "icons" / "picture-in-picture-2";
    ROTATE_CCW = "icons" / "rotate-ccw";
    ROWS_2 = "icons" / "rows-2";
    SAVE = "icons" / "save";
    SUN_MOON = "icons" / "sun-moon";
    UNDO = "icons" / "undo-2";
    X = "icons" / "x";
    CIRCLE_X = "icons" / "circle-x";
    APP_WINDOW = "icons" / "app-window";
    CASE_SENSITIVE = "icons" / "case-sensitive";
    CHEVRON_UP = "icons" / "chevron-up";
    CORNER_UP_LEFT = "icons" / "corner-up-left";
    CORNER_UP_RIGHT = "icons" / "corner-up-right";
    MOON = "icons" / "moon";
    PLAY = "icons" / "play";
    RECTANGLE_VERTICAL = "icons" / "rectangle-vertical";
    SQUARE_ARROW_DOWN_LEFT = "icons" / "square-arrow-down-left";
    SQUARE_ARROW_OUT_UP_RIGHT = "icons" / "square-arrow-out-up-right";
    WHOLE_WORD = "icons" / "whole-word";
    // Names Zed's icon set also has, which the app's asset source finds
    // first: Lucide's own, copied unmodified from GPUI Kit 0.9.1's assets
    // (ISC, `assets/LICENSE-LUCIDE`).
    CHECK = "lattice" / "check";
    COPY = "lattice" / "copy";
    DOWNLOAD = "lattice" / "download";
    ELLIPSIS = "lattice" / "ellipsis";
    EYE = "lattice" / "eye";
    INFO = "lattice" / "info";
    PENCIL = "lattice" / "pencil";
    PLUS = "lattice" / "plus";
    TRASH = "lattice" / "trash";
}

impl Icon {
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
    /// The Build button's idle mark: Lucide's play, filled, as the app
    /// draws it (`<Play fill="currentColor" />`). Lucide's play.svg (ISC,
    /// `assets/LICENSE-LUCIDE`) with its fill set to the ink.
    pub const PLAY_FILLED: Icon = Icon("lattice/play-filled.svg");

    pub fn path(self) -> SharedString {
        self.0.into()
    }

    /// The icon as GPUI Kit's own, for a Kit menu item.
    pub fn kit(self) -> gpui_kit::component::Icon {
        gpui_kit::component::Icon::empty().path(self.0)
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
    // Lucide's `copy` (LICENSE-LUCIDE), whose name Zed's icon set shadows.
    "copy.svg",
    "disclosure.svg",
    "dots.svg",
    "download.svg",
    "ellipsis.svg",
    "git.svg",
    "history.svg",
    "play-filled.svg",
    "check.svg",
    "eye.svg",
    "info.svg",
    "pencil.svg",
    "plus.svg",
    "trash.svg",
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
