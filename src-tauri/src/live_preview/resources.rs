//! The files rtex's display lists refer to, read for the window's renderer:
//! font outlines from the TeX tree, project images, and the fallback PDF of
//! a layout. Each reader accepts only its own kind of file, from its own
//! place.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Fonts and what the renderer needs to read TeX's own: Type 1 encodings, the
/// map file that ties TFM names to outlines, and virtual fonts with the
/// metrics of the fonts they draw from.
const FONT_EXTENSIONS: [&str; 10] =
    ["otf", "ttf", "ttc", "otc", "pfb", "pfa", "enc", "map", "vf", "tfm"];
const IMAGE_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "pdf"];
const MAX_BYTES: u64 = 64 * 1024 * 1024;

fn has_extension(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| allowed.contains(&extension.to_ascii_lowercase().as_str()))
}

fn read_capped(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err(format!("{} is not a file the live preview can read.", path.display()));
    }
    std::fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))
}

/// A font, encoding or map file, by the absolute path a display list gives or
/// by the bare name kpsewhich finds in the user's TeX tree.
pub(crate) fn read_font_file(name: &str) -> Result<Vec<u8>, String> {
    let path = Path::new(name);
    if !has_extension(path, &FONT_EXTENSIONS) {
        return Err(format!("{name} is not a font file."));
    }
    if path.is_absolute() && path.is_file() {
        return read_capped(path);
    }
    let bare = path.file_name().and_then(|name| name.to_str()).ok_or("Invalid font name.")?;
    let found =
        kpsewhich(bare).ok_or_else(|| format!("{bare} is not in your TeX installation."))?;
    read_capped(&found)
}

/// kpsewhich answers in tens of milliseconds and a page names the same few
/// fonts again and again, so each answer, found or not, is kept for the
/// life of the process.
fn kpsewhich(name: &str) -> Option<PathBuf> {
    static FOUND: OnceLock<Mutex<HashMap<String, Option<PathBuf>>>> = OnceLock::new();
    let cache = FOUND.get_or_init(Mutex::default);
    if let Some(found) = cache.lock().ok()?.get(name) {
        return found.clone();
    }
    let output = crate::commands::command("kpsewhich").arg(name).output().ok()?;
    let found = output
        .status
        .success()
        .then(|| {
            String::from_utf8_lossy(&output.stdout).lines().next().map(str::trim).map(PathBuf::from)
        })
        .flatten()
        .filter(|path| path.is_absolute());
    cache.lock().ok()?.insert(name.to_string(), found.clone());
    found
}

/// An image a display list draws: a PNG, JPEG or PDF inside the project.
pub(crate) fn read_image_file(root: &Path, file: &str) -> Result<Vec<u8>, String> {
    let path = root.join(file);
    if !has_extension(&path, &IMAGE_EXTENSIONS) {
        return Err(format!("{file} is not an image the live preview draws."));
    }
    let inside = |path: &Path| {
        let (Ok(path), Ok(root)) = (path.canonicalize(), root.canonicalize()) else { return false };
        path.starts_with(root)
    };
    if !inside(&path) {
        return Err(format!("{file} is not in the project."));
    }
    read_capped(&path)
}

/// The PDF rtex wrote for a layout with pages it could not describe exactly,
/// which must be a PDF in the session's own build folder.
pub(crate) fn read_fallback_pdf(build_dir: &Path, file: &str) -> Result<Vec<u8>, String> {
    let path = build_dir.join(file);
    let inside = match (path.canonicalize(), build_dir.canonicalize()) {
        (Ok(path), Ok(build_dir)) => path.starts_with(build_dir),
        _ => false,
    };
    if !inside || !has_extension(&path, &["pdf"]) {
        return Err("The live preview PDF is not in its build folder.".into());
    }
    read_capped(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn fonts_must_be_font_files() {
        assert!(read_font_file("/etc/passwd").unwrap_err().contains("not a font"));
        assert!(read_font_file("secrets.txt").unwrap_err().contains("not a font"));
        let dir = TempDir::new("live-font");
        let font = dir.write("fonts/x.otf", b"OTTO");
        assert_eq!(read_font_file(font.to_str().unwrap()).unwrap(), b"OTTO");
    }

    #[test]
    fn images_must_be_inside_the_project() {
        let project = TempDir::new("live-image");
        project.write("figures/a.png", b"png");
        let outside = TempDir::new("live-image-outside");
        outside.write("b.png", b"png");
        assert_eq!(read_image_file(&project, "figures/a.png").unwrap(), b"png");
        let escape = format!("../{}/b.png", outside.file_name().unwrap().to_str().unwrap());
        assert!(read_image_file(&project, &escape).is_err());
        assert!(read_image_file(&project, outside.join("b.png").to_str().unwrap()).is_err());
        project.write("notes.txt", b"x");
        assert!(read_image_file(&project, "notes.txt").is_err());
    }

    #[test]
    fn fallback_pdfs_must_come_from_the_build_folder() {
        let build = TempDir::new("live-build");
        let pdf = build.write("pass/layout-3.pdf", b"%PDF-");
        assert_eq!(read_fallback_pdf(&build, pdf.to_str().unwrap()).unwrap(), b"%PDF-");
        assert_eq!(read_fallback_pdf(&build, "pass/layout-3.pdf").unwrap(), b"%PDF-");
        let other = TempDir::new("live-build-other");
        let stray = other.write("x.pdf", b"%PDF-");
        assert!(read_fallback_pdf(&build, stray.to_str().unwrap()).is_err());
        build.write("pass/log.txt", b"x");
        assert!(read_fallback_pdf(&build, "pass/log.txt").is_err());
    }
}
