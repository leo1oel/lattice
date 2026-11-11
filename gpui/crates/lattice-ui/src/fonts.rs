//! The faces the interface sets type in, loaded once at start-up.
//!
//! The Tauri app's font roles (`src/styles/theme.css`) are:
//!
//! - interface: Timeless Sans (Grotesk) in builds that have it, else Inter,
//!   with PingFang SC for Chinese;
//! - editor: Ioskeley Mono, bundled with the app;
//! - display: Timeless Serif in builds that have it, else Instrument Serif,
//!   with Songti SC for Chinese.
//!
//! Inter and Ioskeley are bundled here as static faces (`script/make-fonts`).
//! Timeless's license forbids putting it in a public repository, so, as the
//! Tauri build does (`scripts/private-fonts.ts`), it is read at run time from
//! `LATTICE_PRIVATE_FONTS_DIR`, by default the download's folder in
//! ~/Downloads, and the set an empty variable turns it off. Only the Grotesk
//! faces are loaded: the family also holds the Sans faces at the same weights,
//! and GPUI matches by family and weight.

use std::{borrow::Cow, path::PathBuf};

use gpui::{App, FontFallbacks, SharedString};

/// Timeless Sans runs about 3.5% narrower than Inter with a smaller x-height;
/// the Tauri build scales it by this `size-adjust` so lines wrap and truncate
/// where the Inter build has them. GPUI has no size-adjust, so the type roles
/// multiply their sizes by it instead (leading is unchanged, as in CSS, where
/// the ascent and descent overrides keep the line boxes).
const TIMELESS_SANS_SIZE_ADJUST: f32 = 1.04;
const PRIVATE_FONTS_ENV: &str = "LATTICE_PRIVATE_FONTS_DIR";
const PRIVATE_FONTS_DEFAULT: &str = "Downloads/Timeless-Type-Family-1.094";

const BUNDLED: &[&[u8]] = &[
    include_bytes!("../assets/fonts/inter/Inter-Regular.ttf"),
    include_bytes!("../assets/fonts/inter/Inter-Medium.ttf"),
    include_bytes!("../assets/fonts/inter/Inter-SemiBold.ttf"),
    include_bytes!("../assets/fonts/inter/Inter-Bold.ttf"),
    include_bytes!("../assets/fonts/ioskeley-mono/IoskeleyMono-Regular.ttf"),
    include_bytes!("../assets/fonts/ioskeley-mono/IoskeleyMono-Medium.ttf"),
    include_bytes!("../assets/fonts/ioskeley-mono/IoskeleyMono-Bold.ttf"),
    include_bytes!("../assets/fonts/ioskeley-mono/IoskeleyMono-Italic.ttf"),
    include_bytes!("../assets/fonts/ioskeley-mono/IoskeleyMono-BoldItalic.ttf"),
];

/// The private faces, relative to the download's root folder.
const TIMELESS_FACES: &[&str] = &[
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskRegular.ttf",
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskRegularItalic.ttf",
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskMedium.ttf",
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskSemibold.ttf",
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskSemiboldItalic.ttf",
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskBold.ttf",
    "Serif-Text/static/ttf/TimelessSerif-Regular.ttf",
];

/// Which family each role resolved to in this run.
#[derive(Clone, Debug, PartialEq)]
pub struct Fonts {
    pub ui: SharedString,
    pub display: SharedString,
    pub editor: SharedString,
    /// The factor the interface roles' sizes are multiplied by.
    pub ui_size_adjust: f32,
    /// Whether the private Timeless faces were loaded.
    pub private: bool,
}

impl Fonts {
    /// The open faces, without touching the text system: what a build
    /// without Timeless draws.
    pub fn open() -> Self {
        Self {
            ui: "Inter".into(),
            // Instrument Serif is not bundled yet; Georgia is the stack's own
            // last named face and is on every Mac and Windows install.
            display: "Georgia".into(),
            editor: "Ioskeley Mono".into(),
            ui_size_adjust: 1.0,
            private: false,
        }
    }

    /// Register the bundled faces, and Timeless when this machine has it.
    pub fn load(cx: &mut App) -> Self {
        let bundled = BUNDLED.iter().map(|bytes| Cow::Borrowed(*bytes)).collect();
        if let Err(error) = cx.text_system().add_fonts(bundled) {
            log::error!("could not load the bundled fonts: {error:#}");
        }
        let mut fonts = Self::open();
        if let Some(faces) = private_faces() {
            match cx.text_system().add_fonts(faces) {
                Ok(()) => {
                    fonts.ui = "Timeless Sans".into();
                    fonts.display = "Timeless Serif".into();
                    fonts.ui_size_adjust = TIMELESS_SANS_SIZE_ADJUST;
                    fonts.private = true;
                }
                Err(error) => log::warn!("could not load the Timeless faces: {error:#}"),
            }
        }
        fonts
    }

    /// Chinese in the interface sets in PingFang SC (Microsoft YaHei on
    /// Windows), as in the Tauri app.
    pub fn ui_fallbacks() -> FontFallbacks {
        FontFallbacks::from_fonts(vec!["PingFang SC".into(), "Microsoft YaHei".into()])
    }

    /// A serif title in Chinese falls to Songti SC, so it stays a serif.
    pub fn display_fallbacks() -> FontFallbacks {
        FontFallbacks::from_fonts(vec!["Songti SC".into(), "SimSun".into()])
    }
}

fn private_faces() -> Option<Vec<Cow<'static, [u8]>>> {
    let dir = match std::env::var_os(PRIVATE_FONTS_ENV) {
        Some(dir) if dir.is_empty() => return None,
        Some(dir) => PathBuf::from(dir),
        None => home_dir()?.join(PRIVATE_FONTS_DEFAULT),
    };
    let faces: Option<Vec<_>> = TIMELESS_FACES
        .iter()
        .map(|face| std::fs::read(dir.join(face)).ok().map(Cow::Owned))
        .collect();
    if faces.is_none() && dir.exists() {
        log::warn!(
            "{} has no complete Timeless download; using the open faces",
            dir.display()
        );
    }
    faces
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}
