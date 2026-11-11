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
//! time. The download's LICENSE.pdf is embedded, unmodified, whenever the
//! faces are, and [`font_license`] hands it out as the Tauri build's
//! `fontLicenseUrl` does.

use std::borrow::Cow;

use gpui::{App, FontFallbacks, SharedString};

/// The build script's decision logic, compiled into the tests so it can be
/// exercised without a Timeless download.
#[cfg(test)]
#[path = "../build.rs"]
#[allow(dead_code)]
mod build_script;

/// The private faces `build.rs` embedded, with their license, or `None` in an
/// open build.
mod private {
    /// The Timeless faces and the license they may not travel without: the
    /// generated `EMBEDDED` can hold the one only with the other.
    pub struct Embedded {
        pub faces: &'static [&'static [u8]],
        pub license: &'static [u8],
    }

    include!(concat!(env!("OUT_DIR"), "/private_fonts.rs"));
}

/// The Timeless license (the download's LICENSE.pdf, unmodified) when this
/// build embeds the Timeless faces, and `None` when it does not.
pub fn font_license() -> Option<&'static [u8]> {
    private::EMBEDDED.as_ref().map(|embedded| embedded.license)
}

/// Timeless Sans runs about 3.5% narrower than Inter with a smaller x-height;
/// the Tauri build scales it by this `size-adjust` so lines wrap and truncate
/// where the Inter build has them. GPUI has no size-adjust, so the type roles
/// multiply their sizes by it instead (leading is unchanged, as in CSS, where
/// the ascent and descent overrides keep the line boxes).
/// The display cut of Timeless Serif, which sets Display and Title, has no
/// size-adjust in the Tauri build, so only the sans is scaled.
const TIMELESS_SANS_SIZE_ADJUST: f32 = 1.04;

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
            private: false,
        }
    }

    /// The roles of a build that embeds Timeless.
    fn timeless() -> Self {
        Self {
            ui: "Timeless Sans".into(),
            display: "Timeless Serif".into(),
            ui_size_adjust: TIMELESS_SANS_SIZE_ADJUST,
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
        let Some(embedded) = private::EMBEDDED.as_ref() else {
            return Self::open();
        };
        let faces = embedded
            .faces
            .iter()
            .map(|bytes| Cow::Borrowed(*bytes))
            .collect();
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
        fs,
        path::{Path, PathBuf},
    };

    use super::{build_script, *};

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

    /// A stand-in for a Timeless download in a fresh temporary folder: the
    /// real file names holding placeholder bytes, never the fonts.
    struct Download(PathBuf);

    impl Download {
        fn new(name: &str, files: impl IntoIterator<Item = &'static str>) -> Self {
            let root = std::env::temp_dir()
                .join(format!("lattice-ui-fonts-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            for file in files {
                let path = root.join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, b"placeholder").unwrap();
            }
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for Download {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn open_build_names_the_bundled_families_unscaled() {
        let fonts = Fonts::open();
        assert_eq!(fonts.ui, "Inter");
        assert_eq!(fonts.display, "Instrument Serif");
        assert_eq!(fonts.editor, "Ioskeley Mono");
        assert_eq!(fonts.ui_size_adjust, 1.0);
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
    fn timeless_build_scales_the_sans() {
        let fonts = Fonts::timeless();
        assert_eq!(fonts.ui, "Timeless Sans");
        assert_eq!(fonts.display, "Timeless Serif");
        assert_eq!(fonts.editor, "Ioskeley Mono");
        assert_eq!(fonts.ui_size_adjust, 1.04);
        assert!(fonts.private);
    }

    #[test]
    fn this_build_embeds_the_listed_faces_with_their_license_or_neither() {
        match private::EMBEDDED.as_ref() {
            Some(embedded) => {
                assert_eq!(embedded.faces.len(), build_script::FACES.len());
                let families: BTreeSet<String> =
                    embedded.faces.iter().map(|bytes| family(bytes)).collect();
                let fonts = Fonts::timeless();
                assert_eq!(
                    families,
                    BTreeSet::from([fonts.ui.to_string(), fonts.display.to_string()])
                );
                let license = font_license().expect("embedded faces carry their license");
                assert!(license.starts_with(b"%PDF-"), "LICENSE.pdf is a PDF");
            }
            None => assert_eq!(font_license(), None),
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
        assert_eq!(build_script::private_fonts_directory(None, None), None);
    }

    #[test]
    fn a_complete_copy_embeds_every_face_and_the_license() {
        let download = Download::new("complete", build_script::required_files());
        let root = fs::canonicalize(&download.0).unwrap();
        for required in [false, true] {
            let embedded = build_script::plan(Some(&download.0), required)
                .unwrap()
                .expect("a complete copy is embedded");
            assert_eq!(embedded.license, root.join("LICENSE.pdf").to_str().unwrap());
            let faces: Vec<PathBuf> = embedded.faces.iter().map(PathBuf::from).collect();
            let expected: Vec<PathBuf> = build_script::FACES
                .iter()
                .map(|face| root.join(face))
                .collect();
            assert_eq!(faces, expected);
            // The generated module, compiled into lattice-ui, reads every
            // face and the license.
            let source = build_script::generated_source(Some(&embedded));
            assert_eq!(
                source.matches("include_bytes!").count(),
                build_script::FACES.len() + 1
            );
            assert!(source.contains(&format!("license: include_bytes!({:?})", embedded.license)));
        }
    }

    #[test]
    fn faces_without_their_license_embed_nothing() {
        let download = Download::new("unlicensed", build_script::FACES.iter().copied());
        assert_eq!(build_script::plan(Some(&download.0), false), Ok(None));
        let source = build_script::generated_source(None);
        assert!(source.contains("pub const EMBEDDED: Option<Embedded> = None;"));
        assert!(!source.contains("include_bytes!"));

        let error = build_script::plan(Some(&download.0), true)
            .expect_err("a required build fails without the license");
        assert!(error.contains("LICENSE.pdf"), "{error}");
    }

    #[test]
    fn a_missing_face_embeds_nothing() {
        let serif = "Serif-Text/static/ttf/TimelessSerif-Regular.ttf";
        let download = Download::new(
            "no-serif",
            build_script::required_files().filter(|file| *file != serif),
        );
        assert_eq!(build_script::plan(Some(&download.0), false), Ok(None));
        let error = build_script::plan(Some(&download.0), true)
            .expect_err("a required build fails without a face");
        assert!(error.contains("TimelessSerif-Regular.ttf"), "{error}");
    }

    #[test]
    fn an_empty_variable_builds_without_them() {
        let download = Download::new("ignored", build_script::required_files());
        let home = download.0.as_os_str();
        let directory = build_script::private_fonts_directory(Some(OsStr::new("")), Some(home));
        assert_eq!(directory, None);
        assert_eq!(build_script::plan(directory.as_deref(), false), Ok(None));
        assert!(build_script::plan(directory.as_deref(), true).is_err());
        assert!(!Path::new(&download.0).join("Downloads").exists());
    }
}
