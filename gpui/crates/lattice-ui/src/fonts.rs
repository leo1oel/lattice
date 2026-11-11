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
//! Inter, Ioskeley Mono and Instrument Serif are bundled here as static faces
//! (`script/make-fonts`). Timeless's license forbids putting it in a public
//! repository, so, as the Tauri build does (`scripts/private-fonts.ts`), the
//! build embeds it only when the person building has a copy: `build.rs` reads
//! the faces from `LATTICE_PRIVATE_FONTS_DIR` (by default the download's
//! folder in ~/Downloads; an empty value turns them off) and compiles them
//! into the binary, and release builds set `LATTICE_PRIVATE_FONTS_REQUIRED=1`
//! so a missing copy fails the build. Which faces a build draws is therefore
//! fixed when it is compiled; nothing is read from the user's folders at run
//! time.

use std::borrow::Cow;

use gpui::{App, FontFallbacks, SharedString};

/// The build script's decision logic, compiled into the tests so it can be
/// exercised without a Timeless download.
#[cfg(test)]
#[path = "../build.rs"]
#[allow(dead_code)]
mod build_script;

/// The private faces `build.rs` embedded, or `None` in an open build.
mod private {
    include!(concat!(env!("OUT_DIR"), "/private_fonts.rs"));
}

/// Timeless Sans runs about 3.5% narrower than Inter with a smaller x-height;
/// the Tauri build scales it by this `size-adjust` so lines wrap and truncate
/// where the Inter build has them. GPUI has no size-adjust, so the type roles
/// multiply their sizes by it instead (leading is unchanged, as in CSS, where
/// the ascent and descent overrides keep the line boxes).
const TIMELESS_SANS_SIZE_ADJUST: f32 = 1.04;
/// The display cut of Timeless Serif, which sets Display and Title, is not
/// scaled: the Tauri build gives it no `size-adjust`. Its 105% belongs to the
/// Text cut of the reading surfaces (`--reading-font`), which GPUI does not
/// draw yet.
const TIMELESS_SERIF_SIZE_ADJUST: f32 = 1.0;

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
    include_bytes!("../assets/fonts/instrument-serif/InstrumentSerif-Regular.ttf"),
];

/// Which family each role resolved to in this build.
#[derive(Clone, Debug, PartialEq)]
pub struct Fonts {
    pub ui: SharedString,
    pub display: SharedString,
    pub editor: SharedString,
    /// The factor the interface roles' sizes are multiplied by.
    pub ui_size_adjust: f32,
    /// The factor the serif roles' sizes are multiplied by.
    pub display_size_adjust: f32,
    /// Whether the private Timeless faces were loaded.
    pub private: bool,
}

impl Fonts {
    /// The open faces, without touching the text system: what a build
    /// without Timeless draws.
    pub fn open() -> Self {
        Self {
            ui: "Inter".into(),
            display: "Instrument Serif".into(),
            editor: "Ioskeley Mono".into(),
            ui_size_adjust: 1.0,
            display_size_adjust: 1.0,
            private: false,
        }
    }

    /// The roles of a build that embeds Timeless.
    fn timeless() -> Self {
        Self {
            ui: "Timeless Sans".into(),
            display: "Timeless Serif".into(),
            ui_size_adjust: TIMELESS_SANS_SIZE_ADJUST,
            display_size_adjust: TIMELESS_SERIF_SIZE_ADJUST,
            private: true,
            ..Self::open()
        }
    }

    /// Register the bundled faces, and Timeless when this build embeds it.
    pub fn load(cx: &mut App) -> Self {
        let bundled = BUNDLED.iter().map(|bytes| Cow::Borrowed(*bytes)).collect();
        if let Err(error) = cx.text_system().add_fonts(bundled) {
            log::error!("could not load the bundled fonts: {error:#}");
        }
        let Some(faces) = private::FACES else {
            return Self::open();
        };
        let faces = faces.iter().map(|bytes| Cow::Borrowed(*bytes)).collect();
        match cx.text_system().add_fonts(faces) {
            Ok(()) => Self::timeless(),
            Err(error) => {
                log::warn!("could not load the embedded Timeless faces: {error:#}");
                Self::open()
            }
        }
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

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        ffi::OsStr,
        path::{Path, PathBuf},
    };

    use super::{
        build_script::{self, Decision},
        *,
    };

    /// The family a face reports to the text system: the typographic family
    /// (name ID 16) when it has one, else the legacy family (ID 1), read by
    /// an independent parser.
    fn family(bytes: &[u8]) -> String {
        let face = ttf_parser::Face::parse(bytes, 0).expect("a bundled face parses");
        let name = |id| {
            face.names()
                .into_iter()
                .filter(|name| name.name_id == id)
                .find_map(|name| name.to_string())
        };
        name(ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
            .or_else(|| name(ttf_parser::name_id::FAMILY))
            .expect("a bundled face is named")
    }

    #[test]
    fn open_build_names_the_bundled_families_unscaled() {
        let fonts = Fonts::open();
        assert_eq!(fonts.ui, "Inter");
        assert_eq!(fonts.display, "Instrument Serif");
        assert_eq!(fonts.editor, "Ioskeley Mono");
        assert_eq!(fonts.ui_size_adjust, 1.0);
        assert_eq!(fonts.display_size_adjust, 1.0);
        assert!(!fonts.private);
    }

    #[test]
    fn every_open_role_is_a_family_the_bundle_registers() {
        let bundled: BTreeSet<String> = BUNDLED.iter().map(|bytes| family(bytes)).collect();
        let fonts = Fonts::open();
        let roles: BTreeSet<String> = [&fonts.ui, &fonts.display, &fonts.editor]
            .into_iter()
            .map(|name| name.to_string())
            .collect();
        assert_eq!(bundled, roles);
    }

    #[test]
    fn timeless_build_scales_only_the_sans() {
        let fonts = Fonts::timeless();
        assert_eq!(fonts.ui, "Timeless Sans");
        assert_eq!(fonts.display, "Timeless Serif");
        assert_eq!(fonts.editor, "Ioskeley Mono");
        assert_eq!(fonts.ui_size_adjust, 1.04);
        assert_eq!(fonts.display_size_adjust, 1.0);
        assert!(fonts.private);
    }

    #[test]
    fn embedded_faces_match_the_build_script_list() {
        if let Some(faces) = private::FACES {
            assert_eq!(faces.len(), build_script::FACES.len());
            let families: BTreeSet<String> = faces.iter().map(|bytes| family(bytes)).collect();
            let fonts = Fonts::timeless();
            assert_eq!(
                families,
                BTreeSet::from([fonts.ui.to_string(), fonts.display.to_string()])
            );
        }
    }

    #[test]
    fn directory_follows_the_variable_then_the_download_folder() {
        let home = Some(OsStr::new("/Users/someone"));
        assert_eq!(
            build_script::private_fonts_directory(None, home),
            Some(PathBuf::from(
                "/Users/someone/Downloads/Timeless-Type-Family-1.094"
            ))
        );
        assert_eq!(
            build_script::private_fonts_directory(Some(OsStr::new("/fonts")), home),
            Some(PathBuf::from("/fonts"))
        );
        assert_eq!(
            build_script::private_fonts_directory(Some(OsStr::new("")), home),
            None
        );
        assert_eq!(build_script::private_fonts_directory(None, None), None);
    }

    #[test]
    fn a_complete_copy_is_embedded() {
        let directory = Path::new("/fonts");
        let decision = build_script::decide(Some(directory), true, |_| true);
        assert_eq!(decision, Ok(Decision::Embed(directory.to_path_buf())));
    }

    #[test]
    fn an_incomplete_copy_builds_open_unless_required() {
        let directory = Path::new("/fonts");
        let without_license = |path: &Path| path != directory.join("LICENSE.pdf");
        assert_eq!(
            build_script::decide(Some(directory), false, without_license),
            Ok(Decision::Open)
        );
        let error = build_script::decide(Some(directory), true, without_license)
            .expect_err("a required build fails without the license");
        assert!(error.contains("LICENSE.pdf"), "{error}");

        let without_serif =
            |path: &Path| !path.ends_with("Serif-Text/static/ttf/TimelessSerif-Regular.ttf");
        let error = build_script::decide(Some(directory), true, without_serif)
            .expect_err("a required build fails without a face");
        assert!(error.contains("TimelessSerif-Regular.ttf"), "{error}");
    }

    #[test]
    fn no_directory_builds_open_unless_required() {
        assert_eq!(
            build_script::decide(None, false, |_| true),
            Ok(Decision::Open)
        );
        assert!(build_script::decide(None, true, |_| true).is_err());
    }

    #[test]
    fn generated_module_embeds_exactly_the_given_faces() {
        let open = build_script::generated_source(None);
        assert!(open.contains("pub const FACES: Option<&[&[u8]]> = None;"));
        let faces = ["/a \"quoted\" path/Face.ttf".to_owned()];
        let embedded = build_script::generated_source(Some(&faces));
        assert!(embedded.contains(r#"include_bytes!("/a \"quoted\" path/Face.ttf"),"#));
        assert_eq!(embedded.matches("include_bytes!").count(), 1);
    }
}
