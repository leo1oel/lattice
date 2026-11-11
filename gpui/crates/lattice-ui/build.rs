//! Embeds the Timeless type family (timeless.co) into lattice-ui when the
//! person building has a copy of it, and leaves the build on the bundled open
//! faces when they do not: the GPUI counterpart of the Tauri build's
//! `scripts/private-fonts.ts`, with the same variables and the same rules.
//!
//! The Timeless Free Font License allows embedding the fonts in an application
//! but forbids putting them on a public repository or redistributing them, so
//! they are never in this repository and never copied into the tree: the
//! faces are read, unmodified, from `LATTICE_PRIVATE_FONTS_DIR` (default: the
//! download's folder in ~/Downloads) by `include_bytes!` in a file generated
//! into `OUT_DIR`, and so live only inside the built binary. Set the variable
//! to an empty string to build without them. Nothing reads a user folder when
//! the app runs.
//!
//! The copy is all or nothing, as in the Tauri build: a partial one would mix
//! faces and metrics, and the fonts may go to no one without their license, so
//! the download's LICENSE.pdf must be there too. Release builds set
//! `LATTICE_PRIVATE_FONTS_REQUIRED=1`, which turns a missing or incomplete
//! copy into a build error instead of a quiet fallback.
//!
//! Cargo reruns this script when either variable or the home folder changes,
//! and when a face of an embedded copy (or any file of an incomplete one)
//! does. A folder that does not exist yet cannot be watched (Cargo would rerun
//! the script, and rebuild the crate, on every build), so a download added
//! after a build without it is picked up on the next change to the variable,
//! or after `cargo clean -p lattice-ui`.

use std::{
    env,
    ffi::OsStr,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
    process,
};

const PRIVATE_FONTS_ENV: &str = "LATTICE_PRIVATE_FONTS_DIR";
const PRIVATE_FONTS_REQUIRED_ENV: &str = "LATTICE_PRIVATE_FONTS_REQUIRED";
/// The download's folder, relative to the home folder.
const DEFAULT_DIRECTORY: [&str; 2] = ["Downloads", "Timeless-Type-Family-1.094"];
/// The license, beside the fonts in the download's root folder.
const LICENSE_FILE: &str = "LICENSE.pdf";
const GENERATED: &str = "private_fonts.rs";

/// The faces embedded, relative to the download's root folder. GPUI picks a
/// face by family and weight, so the interface's Timeless Sans comes as the
/// Grotesk style's static cuts at the weights the type roles use, with the
/// two italics the Tauri build embeds; the Sans style's faces share the
/// family name and weights, and are left out so they cannot be matched
/// instead. Display and Title set in the display cut of Timeless Serif, the
/// Tauri build's `--display-font`.
pub const FACES: &[&str] = &[
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskRegular.ttf",
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskRegularItalic.ttf",
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskMedium.ttf",
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskSemibold.ttf",
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskSemiboldItalic.ttf",
    "Sans-Grotesk/static/ttf/TimelessSans-GroteskBold.ttf",
    "Serif-Text/static/ttf/TimelessSerif-Regular.ttf",
];

/// What the build does with the private fonts.
#[derive(Debug, PartialEq)]
pub enum Decision {
    /// Embed the faces from this folder.
    Embed(PathBuf),
    /// Build with the open faces only.
    Open,
}

/// The folder the private fonts are looked for in, or `None` when the build
/// goes without them: the variable when it is set (an empty value turns the
/// fonts off), else the download's folder in the home folder.
pub fn private_fonts_directory(
    configured: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Option<PathBuf> {
    match configured {
        Some(directory) if directory.is_empty() => None,
        Some(directory) => Some(PathBuf::from(directory)),
        None => home.filter(|home| !home.is_empty()).map(|home| {
            DEFAULT_DIRECTORY
                .iter()
                .fold(PathBuf::from(home), |path, part| path.join(part))
        }),
    }
}

/// The license and the faces, relative to the download's root folder.
pub fn required_files() -> impl Iterator<Item = &'static str> {
    std::iter::once(LICENSE_FILE).chain(FACES.iter().copied())
}

/// Embed from `directory` when every required file is in it (`exists` says
/// whether one is); otherwise build open, or, when the build requires the
/// fonts, fail with the message to show.
pub fn decide(
    directory: Option<&Path>,
    required: bool,
    exists: impl Fn(&Path) -> bool,
) -> Result<Decision, String> {
    let missing: Vec<&str> = match directory {
        Some(directory) => required_files()
            .filter(|file| !exists(&directory.join(file)))
            .collect(),
        None => required_files().collect(),
    };
    match directory {
        Some(directory) if missing.is_empty() => Ok(Decision::Embed(directory.to_path_buf())),
        _ if !required => Ok(Decision::Open),
        None => Err(format!(
            "{PRIVATE_FONTS_REQUIRED_ENV}=1, but {PRIVATE_FONTS_ENV} is empty (or unset with no home folder), so there are no Timeless fonts to embed"
        )),
        Some(directory) => Err(format!(
            "{PRIVATE_FONTS_REQUIRED_ENV}=1, but {PRIVATE_FONTS_ENV} ({}) does not hold {LICENSE_FILE} and every embedded face; missing: {}",
            directory.display(),
            missing.join(", ")
        )),
    }
}

/// The generated module: `FACES`, the embedded faces' bytes, or `None`.
/// `faces` are absolute paths, which `include_bytes!` reads at compile time.
pub fn generated_source(faces: Option<&[String]>) -> String {
    let mut source = String::from("// Generated by lattice-ui's build.rs; see its module docs.\n");
    match faces {
        Some(faces) => {
            source.push_str("pub const FACES: Option<&[&[u8]]> = Some(&[\n");
            for face in faces {
                // A `str`'s Debug form is a Rust string literal.
                writeln!(source, "    include_bytes!({face:?}),").unwrap();
            }
            source.push_str("]);\n");
        }
        None => source.push_str("pub const FACES: Option<&[&[u8]]> = None;\n"),
    }
    source
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    for variable in [
        PRIVATE_FONTS_ENV,
        PRIVATE_FONTS_REQUIRED_ENV,
        "HOME",
        "USERPROFILE",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    let configured = env::var_os(PRIVATE_FONTS_ENV);
    let required = env::var_os(PRIVATE_FONTS_REQUIRED_ENV).is_some_and(|value| value == "1");
    let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"));
    let directory = private_fonts_directory(configured.as_deref(), home.as_deref());

    let faces = match decide(directory.as_deref(), required, Path::is_file) {
        Ok(Decision::Embed(directory)) => Some(embedded_faces(&directory, required)),
        Ok(Decision::Open) => {
            if let Some(directory) = directory.as_deref().filter(|directory| directory.is_dir()) {
                // Watch an incomplete copy, so completing it rebuilds.
                println!("cargo:rerun-if-changed={}", directory.display());
                println!(
                    "cargo:warning={} holds no complete Timeless download ({LICENSE_FILE} and every embedded face); building with the open fonts",
                    directory.display()
                );
            }
            None
        }
        Err(message) => fail(&message),
    };

    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
    if let Err(error) = fs::write(out.join(GENERATED), generated_source(faces.as_deref())) {
        fail(&format!(
            "could not write {GENERATED} into OUT_DIR: {error}"
        ));
    }
}

/// The absolute paths of the faces to embed, each watched for changes. The
/// license is watched too: removing it makes the copy incomplete.
fn embedded_faces(directory: &Path, required: bool) -> Vec<String> {
    let directory = match fs::canonicalize(directory) {
        Ok(directory) => directory,
        Err(error) => fail(&format!(
            "could not resolve {}: {error}",
            directory.display()
        )),
    };
    for file in required_files() {
        println!("cargo:rerun-if-changed={}", directory.join(file).display());
    }
    FACES
        .iter()
        .map(|face| {
            let path = directory.join(face);
            match path.to_str() {
                Some(path) => path.to_owned(),
                None => fail(&format!(
                    "{} is not valid UTF-8, which include_bytes! needs; move the Timeless download{}",
                    path.display(),
                    if required { "" } else { ", or set LATTICE_PRIVATE_FONTS_DIR= to build without it" }
                )),
            }
        })
        .collect()
}

fn fail(message: &str) -> ! {
    eprintln!("error: {message}");
    process::exit(1);
}
