//! Binary project files: byte previews for figures and embedded HTML, and
//! converting figures into formats LaTeX can include.

use super::paths::{extension, safe_path, NOT_FOUND};
use super::tree::{
    classify_file_bytes, is_html_path, is_supported_asset, ContentKind, MAX_CLASSIFIED_TEXT_BYTES,
    MAX_LOCAL_HTML_BYTES,
};
use crate::commands;
use crate::util::err;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::UNIX_EPOCH;

pub(super) fn asset_mime_type(path: &Path) -> Option<&'static str> {
    match extension(path).as_deref()? {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "svg" => Some("image/svg+xml"),
        "webp" => Some("image/webp"),
        "pdf" => Some("application/pdf"),
        "eps" => Some("application/postscript"),
        "html" => Some("text/html"),
        _ => None,
    }
}

/// Inline previews are base64 inside one IPC reply, so they stay bounded.
const MAX_INLINE_ASSET_BYTES: u64 = 50 * 1024 * 1024;
/// PDF readers accept the `%PDF-` header anywhere in the first kilobyte.
const PDF_HEADER_WINDOW: u64 = 1024;
/// The most one range read returns; the frontend asks in smaller pieces.
const MAX_ASSET_RANGE_BYTES: u64 = 16 * 1024 * 1024;
const FILE_CHANGED: &str = "This PDF changed on disk.";

/// One version of one file: device, inode, length and modification time.
/// Range reads are served only from the exact file `read_asset` checked, so a
/// file replaced since then (or a link swapped in for it) is refused instead
/// of being spliced into the open document.
fn file_version(metadata: &Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{:x}-{:x}-{:x}-{modified:x}", metadata.dev(), metadata.ino(), metadata.len())
}

/// Open a file `safe_path` resolved, without following a link swapped in since.
fn open_resolved(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path)
}

pub fn read_asset(root: &Path, relative: &str) -> Result<AssetPreview, String> {
    let path = safe_path(root, relative)?;
    // SVG is the one supported image format whose bytes classify as text; it
    // is still a figure to preview, not a source file to open in an editor.
    let svg = path.extension().is_some_and(|value| value.eq_ignore_ascii_case("svg"));
    // Project-local HTML can be an authored iframe inside another HTML preview.
    // Return it through this byte-oriented command so the frontend can embed it
    // in the same opaque-origin sandbox instead of exposing a filesystem URL.
    let html = is_html_path(&path);
    if !path.exists() {
        return Err(NOT_FOUND.to_string());
    }
    if !path.is_file() {
        return Err("Choose a binary project file or an HTML preview resource.".to_string());
    }
    let size = fs::metadata(&path).map_err(err)?.len();
    let mime_type = asset_mime_type(&path).unwrap_or("application/octet-stream");
    let display_path = relative.replace('\\', "/");
    if mime_type == "application/pdf" {
        // No size limit: PDF.js reads only the byte ranges its pages need,
        // through `read_asset_range`.
        let file = open_resolved(&path).map_err(err)?;
        let metadata = file.metadata().map_err(err)?;
        let mut head = Vec::new();
        (&file).take(PDF_HEADER_WINDOW).read_to_end(&mut head).map_err(err)?;
        if !head.windows(5).any(|window| window == b"%PDF-") {
            return Err("This file is not a PDF.".to_string());
        }
        return Ok(AssetPreview {
            path: display_path,
            mime_type: mime_type.to_string(),
            content: AssetContent::Ranges {
                length: metadata.len(),
                version: file_version(&metadata),
            },
        });
    }
    if size > MAX_INLINE_ASSET_BYTES {
        return Err(
            "This figure is too large to preview inside Lattice (50 MB maximum).".to_string()
        );
    }
    if html && size > MAX_LOCAL_HTML_BYTES {
        return Err("This HTML file is too large to open (32 MB maximum).".to_string());
    }
    let bytes = fs::read(&path).map_err(err)?;
    let is_text = classify_file_bytes(&bytes) == ContentKind::Text;
    if (html && !is_text) || (!svg && !html && size <= MAX_CLASSIFIED_TEXT_BYTES && is_text) {
        return Err("Choose a binary project file.".to_string());
    }
    Ok(AssetPreview {
        path: display_path,
        mime_type: mime_type.to_string(),
        content: AssetContent::Base64(STANDARD.encode(bytes)),
    })
}

/// Bytes `[start, end)` of the project PDF `relative`, at the `version`
/// [`read_asset`] reported. Only a PDF inside the project, through no link,
/// at exactly that version, and at most [`MAX_ASSET_RANGE_BYTES`] at a time.
pub fn read_asset_range(
    root: &Path, relative: &str, version: &str, start: u64, end: u64,
) -> Result<Vec<u8>, String> {
    let path = safe_path(root, relative)?;
    if asset_mime_type(&path) != Some("application/pdf") {
        return Err("Only project PDFs are read in ranges.".to_string());
    }
    if end <= start || end - start > MAX_ASSET_RANGE_BYTES {
        return Err("This byte range cannot be read.".to_string());
    }
    let file = match open_resolved(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(NOT_FOUND.into()),
        Err(error) => return Err(err(error)),
    };
    let checked = || -> Result<u64, String> {
        let metadata = file.metadata().map_err(err)?;
        if !metadata.is_file() || file_version(&metadata) != version {
            return Err(FILE_CHANGED.to_string());
        }
        Ok(metadata.len())
    };
    if end > checked()? {
        return Err("This byte range is outside the file.".to_string());
    }
    let mut bytes = vec![0; (end - start) as usize];
    match file.read_exact_at(&mut bytes, start) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            return Err(FILE_CHANGED.to_string())
        }
        Err(error) => return Err(err(error)),
    }
    // A writer that truncated and rewrote the file during the read changed its version.
    checked()?;
    Ok(bytes)
}

/// Save the project PDF `relative`, at the `version` [`read_asset`] reported,
/// to `destination` without its bytes passing through the webview.
pub fn save_asset_copy(
    root: &Path, relative: &str, version: &str, destination: &Path,
) -> Result<String, String> {
    copy_checked_version(root, relative, version, destination, |source, output| {
        io::copy(source, output)
    })
}

/// [`save_asset_copy`], with the byte copy itself as a seam for tests.
///
/// The copy is staged in a temporary file beside the destination and renamed
/// over it only once the source still has the checked version and every
/// checked byte arrived. A writer that rewrites or truncates the source
/// meanwhile (pdfTeX writes in place), or a failed write, therefore leaves
/// any existing export as it was instead of a mixed or partial PDF.
fn copy_checked_version(
    root: &Path, relative: &str, version: &str, destination: &Path,
    copy: impl FnOnce(&mut File, &mut File) -> io::Result<u64>,
) -> Result<String, String> {
    let path = safe_path(root, relative)?;
    if asset_mime_type(&path) != Some("application/pdf") {
        return Err("Only project PDFs are saved as copies.".to_string());
    }
    let destination = crate::export::destination(destination, &crate::export::PDF)?;
    let saved_to = Ok(destination.to_string_lossy().to_string());
    // Replace what a link points at, as writing through it did, not the link.
    let destination = match fs::canonicalize(&destination) {
        Ok(resolved) => resolved,
        Err(error) if error.kind() == io::ErrorKind::NotFound => destination,
        Err(error) => return Err(err(error)),
    };
    let mut file = match open_resolved(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(NOT_FOUND.into()),
        Err(error) => return Err(err(error)),
    };
    let checked = |file: &File| -> Result<Metadata, String> {
        let metadata = file.metadata().map_err(err)?;
        if !metadata.is_file() || file_version(&metadata) != version {
            return Err(FILE_CHANGED.to_string());
        }
        Ok(metadata)
    };
    let metadata = checked(&file)?;
    let existing = match fs::metadata(&destination) {
        Ok(existing) => Some(existing),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(err(error)),
    };
    if let Some(existing) = &existing {
        // Saved over itself, it already holds this version.
        if existing.dev() == metadata.dev() && existing.ino() == metadata.ino() {
            return saved_to;
        }
        if !existing.is_file() {
            return Err("Choose a file to save the PDF to.".to_string());
        }
    }

    let staged = StagedFile::create(&destination)?;
    let mut output = staged.file.try_clone().map_err(err)?;
    if let Some(existing) = &existing {
        output.set_permissions(existing.permissions()).map_err(err)?;
    }
    let copied = copy(&mut file, &mut output).map_err(err)?;
    if copied != metadata.len() {
        return Err(FILE_CHANGED.to_string());
    }
    checked(&file)?;
    output.sync_all().map_err(err)?;
    staged.commit(&destination)?;
    saved_to
}

/// A temporary file beside a destination, removed unless committed.
struct StagedFile {
    path: std::path::PathBuf,
    file: File,
    committed: bool,
}

impl StagedFile {
    fn create(destination: &Path) -> Result<Self, String> {
        let directory = destination.parent().unwrap_or_else(|| Path::new("."));
        let name =
            destination.file_name().map_or_else(Default::default, |name| name.to_string_lossy());
        let path = directory.join(format!(".{name}.{}.lattice-tmp", uuid::Uuid::new_v4().simple()));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(err)?;
        Ok(Self { path, file, committed: false })
    }

    /// Atomically replace `destination` with the staged bytes.
    fn commit(mut self, destination: &Path) -> Result<(), String> {
        fs::rename(&self.path, destination).map_err(err)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// A path LaTeX can `\includegraphics`: the figure itself, or a converted
/// `<stem>-converted.pdf` (SVG) / `.png` (WebP) beside it.
pub fn prepare_latex_figure(root: &Path, relative: &str) -> Result<String, String> {
    let source = safe_path(root, relative)?;
    if !source.is_file() || !is_supported_asset(&source) {
        return Err("Choose an image or PDF from the project.".to_string());
    }
    match extension(&source).as_deref() {
        Some("svg") => convert_figure(root, relative, &source, "pdf"),
        Some("webp") => convert_figure(root, relative, &source, "png"),
        _ => Ok(relative.replace('\\', "/")),
    }
}

fn convert_figure(
    root: &Path, relative: &str, source: &Path, target_extension: &str,
) -> Result<String, String> {
    let relative_path = Path::new(relative);
    let stem = relative_path.file_stem().and_then(|value| value.to_str()).unwrap_or("figure");
    let converted_relative = relative_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(format!("{stem}-converted.{target_extension}"));
    let destination = safe_path(root, &converted_relative.to_string_lossy())?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let modified = |path: &Path| fs::metadata(path).and_then(|value| value.modified()).ok();
    let current = destination.exists() && modified(&destination) >= modified(source);
    if !current {
        let svg = extension(source).as_deref() == Some("svg");
        let mut command = if svg && commands::available("rsvg-convert") {
            let mut command = commands::command("rsvg-convert");
            command.args(["-f", "pdf", "-o"]).arg(&destination).arg(source);
            command
        } else if commands::available("magick") {
            let mut command = commands::command("magick");
            command.arg(source).arg(&destination);
            command
        } else if svg {
            return Err("SVG insertion needs rsvg-convert or ImageMagick. The figure can still be previewed in Lattice.".to_string());
        } else {
            let mut command = commands::command("sips");
            command.args(["-s", "format", "png"]).arg(source).arg("--out").arg(&destination);
            command
        };
        let output = command.output().map_err(err)?;
        if !output.status.success() || !destination.is_file() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                "Lattice could not convert this figure for LaTeX.".to_string()
            } else {
                format!("Lattice could not convert this figure for LaTeX. {detail}")
            });
        }
    }
    Ok(converted_relative.to_string_lossy().replace('\\', "/"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPreview {
    pub path: String,
    pub mime_type: String,
    #[serde(flatten)]
    pub content: AssetContent,
}

/// How an asset's bytes reach the frontend: inline for figures and HTML, which
/// become `data:` URLs, or for PDFs as the file's length and version, which
/// PDF.js reads a range at a time through `read_project_asset_range`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetContent {
    Base64(String),
    Ranges { length: u64, version: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;
    use crate::project::tree::{read_file, scan_tree, TreeView};

    /// The preview `relative` reads as, with its inline bytes decoded.
    fn inline(root: &Path, relative: &str) -> (String, String, Vec<u8>) {
        match read_asset(root, relative).unwrap() {
            AssetPreview { path, mime_type, content: AssetContent::Base64(base64) } => {
                (path, mime_type, STANDARD.decode(base64).unwrap())
            }
            _ => panic!("{relative} should be previewed inline"),
        }
    }

    #[test]
    fn project_figures_and_html_can_be_previewed_and_prepared_for_latex() {
        let fixture = Fixture::project("preview-assets");
        let root = &fixture.root;
        fixture.write("figures/result.png", b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            inline(root, "figures/result.png"),
            ("figures/result.png".into(), "image/png".into(), b"\x89PNG\r\n\x1a\n".to_vec())
        );
        let html = "<!doctype html><script>Plotly.newPlot('chart', [], {})</script>";
        fixture.write("figures/chart.html", html);
        assert_eq!(
            inline(root, "figures/chart.html"),
            ("figures/chart.html".into(), "text/html".into(), html.as_bytes().to_vec())
        );
        assert_eq!(prepare_latex_figure(root, "figures/result.png").unwrap(), "figures/result.png");

        fixture.write(
            "figures/diagram.svg",
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>"#,
        );
        if commands::available("rsvg-convert") || commands::available("magick") {
            let converted = prepare_latex_figure(root, "figures/diagram.svg").unwrap();
            assert_eq!(converted, "figures/diagram-converted.pdf");
            assert!(fixture.path(&converted).is_file());
        }

        // Oversized HTML stays editable locally.
        let mut html = b"<!doctype html><html><body>".to_vec();
        html.resize(MAX_CLASSIFIED_TEXT_BYTES as usize + 1, b'x');
        html.extend_from_slice(b"</body></html>\n");
        fixture.write("presentation.html", &html);

        let project_files = scan_tree(&fixture.root, TreeView::Project).unwrap();
        let node = project_files.iter().find(|node| node.path == "presentation.html").unwrap();
        assert_eq!((node.kind.as_str(), node.content_kind.as_str()), ("text", "text"));
        assert_eq!(read_file(&fixture.root, "presentation.html").unwrap().as_bytes(), html);

        let (_, mime_type, bytes) = inline(&fixture.root, "presentation.html");
        assert_eq!((mime_type.as_str(), bytes), ("text/html", html));
    }

    /// The length and version `relative` is read in ranges at.
    fn ranges(root: &Path, relative: &str) -> (u64, String) {
        match read_asset(root, relative) {
            Ok(AssetPreview { content: AssetContent::Ranges { length, version }, .. }) => {
                (length, version)
            }
            other => panic!("{relative} should be read in ranges: {:?}", other.map(|_| ())),
        }
    }

    #[test]
    fn project_pdfs_are_read_in_ranges_whatever_their_size() {
        let fixture = Fixture::project("preview-pdfs");
        let root = &fixture.root;
        // Past the inline limit: only the header is read up front.
        let mut pdf = b"%PDF-1.7\n".to_vec();
        pdf.resize(MAX_INLINE_ASSET_BYTES as usize + 1, 7);
        fixture.write("figures/scan.pdf", &pdf);
        let (length, version) = ranges(root, "figures/scan.pdf");
        assert_eq!(length, pdf.len() as u64);
        let tail = length - 3;
        assert_eq!(
            read_asset_range(root, "figures/scan.pdf", &version, 0, 8).unwrap(),
            b"%PDF-1.7"
        );
        assert_eq!(
            read_asset_range(root, "figures/scan.pdf", &version, tail, length).unwrap(),
            [7; 3]
        );

        // PDF readers tolerate a short preamble before the header.
        fixture.write("preamble.pdf", b"\x00\x00garbage%PDF-1.4\n");
        ranges(root, "preamble.pdf");
        fixture.write("notes.pdf", "plain text that only claims to be a PDF");
        assert_eq!(read_asset(root, "notes.pdf").err().unwrap(), "This file is not a PDF.");

        // Everything else is still bounded by one IPC reply.
        fixture.write("figures/huge.png", vec![0_u8; MAX_INLINE_ASSET_BYTES as usize + 1]);
        assert!(read_asset(root, "figures/huge.png").err().unwrap().contains("50 MB maximum"));
    }

    #[test]
    fn pdf_ranges_come_only_from_the_checked_version_of_a_project_pdf() {
        let fixture = Fixture::project("pdf-ranges");
        let root = &fixture.root;
        fixture.write("paper.pdf", b"%PDF-1.4 the checked version");
        fixture.write("notes.md", b"# not a PDF");
        let (length, version) = ranges(root, "paper.pdf");
        let read = |path: &str, version: &str, start: u64, end: u64| {
            read_asset_range(root, path, version, start, end)
        };
        assert_eq!(
            read("paper.pdf", &version, 0, length).unwrap(),
            b"%PDF-1.4 the checked version"
        );

        // Outside the project, through a link, or not a PDF.
        let outside = fixture.root.parent().unwrap().join("outside.pdf");
        fs::write(&outside, b"%PDF-1.4 outside").unwrap();
        std::os::unix::fs::symlink(&outside, fixture.path("linked.pdf")).unwrap();
        for path in ["../outside.pdf", outside.to_str().unwrap(), "linked.pdf", "notes.md", "", "."]
        {
            assert!(read(path, &version, 0, 4).is_err(), "{path} must be refused");
        }

        // Empty, inverted, oversized and out-of-file ranges.
        for (start, end) in [(4, 4), (5, 2), (0, MAX_ASSET_RANGE_BYTES + 1), (0, length + 1)] {
            assert!(read("paper.pdf", &version, start, end).is_err(), "{start}..{end}");
        }

        // A guessed version, or the file replaced or deleted since it was checked.
        assert_eq!(read("paper.pdf", "0-0-0-0", 0, 4).err().unwrap(), FILE_CHANGED);
        fixture.write("paper.pdf", b"%PDF-1.4 a later version, longer");
        assert_eq!(read("paper.pdf", &version, 0, 4).err().unwrap(), FILE_CHANGED);
        // Checking the rewritten file again serves its new version.
        let (replaced_length, replaced) = ranges(root, "paper.pdf");
        assert_ne!(replaced, version);
        assert_eq!(
            read("paper.pdf", &replaced, 0, replaced_length).unwrap(),
            b"%PDF-1.4 a later version, longer"
        );
        // Gone, and told apart from changed: the file, or the folder it was in.
        fs::remove_file(fixture.path("paper.pdf")).unwrap();
        assert_eq!(read("paper.pdf", &replaced, 0, 4).err().unwrap(), NOT_FOUND);
        assert_eq!(read_asset(root, "paper.pdf").err().unwrap(), NOT_FOUND);
        assert_eq!(read("gone/paper.pdf", &replaced, 0, 4).err().unwrap(), NOT_FOUND);
        assert_eq!(read_asset(root, "gone/paper.pdf").err().unwrap(), NOT_FOUND);
    }

    #[test]
    fn a_range_read_while_the_file_is_rewritten_is_refused_not_spliced() {
        use std::io::Write;
        use std::sync::atomic::{AtomicBool, Ordering};
        let fixture = Fixture::project("pdf-range-race");
        let root = &fixture.root;
        let contents = |fill: u8| {
            let mut pdf = b"%PDF-1.4\n".to_vec();
            pdf.resize(256 * 1024, fill);
            pdf
        };
        let length = contents(b'a').len() as u64;
        fixture.write("paper.pdf", contents(b'a'));
        let path = fixture.path("paper.pdf");
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                // Truncate and rewrite the same file, as pdfTeX does.
                for fill in (0..400).map(|round| if round % 2 == 0 { b'b' } else { b'a' }) {
                    let mut file =
                        OpenOptions::new().write(true).truncate(true).open(&path).unwrap();
                    file.write_all(&contents(fill)).unwrap();
                }
                done.store(true, Ordering::SeqCst);
            });
            while !done.load(Ordering::SeqCst) {
                let Ok(AssetPreview {
                    content: AssetContent::Ranges { length: seen, version },
                    ..
                }) = read_asset(root, "paper.pdf")
                else {
                    continue;
                };
                if seen != length {
                    continue;
                }
                match read_asset_range(root, "paper.pdf", &version, 9, length) {
                    Ok(bytes) => assert!(
                        bytes.iter().all(|&byte| byte == bytes[0]) && bytes[0] != 0,
                        "bytes from more than one version"
                    ),
                    Err(error) => assert_eq!(error, FILE_CHANGED),
                }
            }
        });
    }

    #[test]
    fn saves_a_copy_of_only_the_checked_version_of_a_project_pdf() {
        let fixture = Fixture::project("pdf-save");
        let root = &fixture.root;
        let saved = &fixture.parent;
        fixture.write("paper.pdf", b"%PDF-1.4 the checked version");
        fixture.write("notes.md", b"# not a PDF");
        let (_, version) = ranges(root, "paper.pdf");

        let destination =
            save_asset_copy(root, "paper.pdf", &version, &saved.join("copy")).unwrap();
        assert_eq!(destination, saved.join("copy.pdf").to_string_lossy());
        assert_eq!(fs::read(&destination).unwrap(), b"%PDF-1.4 the checked version");
        assert!(save_asset_copy(root, "paper.pdf", &version, &saved.join("copy.txt")).is_err());

        // Outside the project, through a link, or not a PDF.
        let outside = saved.join("outside.pdf");
        fs::write(&outside, b"%PDF-1.4 outside").unwrap();
        std::os::unix::fs::symlink(&outside, fixture.path("linked.pdf")).unwrap();
        for path in ["../outside.pdf", outside.to_str().unwrap(), "linked.pdf", "notes.md"] {
            assert!(
                save_asset_copy(root, path, &version, &saved.join("refused.pdf")).is_err(),
                "{path} must be refused"
            );
        }
        assert!(!saved.join("refused.pdf").exists());

        // Rewritten since it was checked: nothing is written.
        fixture.write("paper.pdf", b"%PDF-1.4 a later version, longer");
        let stale = save_asset_copy(root, "paper.pdf", &version, &saved.join("stale.pdf"));
        assert_eq!(stale.err().unwrap(), FILE_CHANGED);
        assert!(!saved.join("stale.pdf").exists());

        // Saved over itself, the file is left whole.
        let (_, current) = ranges(root, "paper.pdf");
        save_asset_copy(root, "paper.pdf", &current, &fixture.path("paper.pdf")).unwrap();
        assert_eq!(
            fs::read(fixture.path("paper.pdf")).unwrap(),
            b"%PDF-1.4 a later version, longer"
        );

        fs::remove_file(fixture.path("paper.pdf")).unwrap();
        let gone = save_asset_copy(root, "paper.pdf", &current, &saved.join("gone.pdf"));
        assert_eq!(gone.err().unwrap(), NOT_FOUND);
    }

    #[test]
    fn a_pdf_changed_or_a_copy_failed_midway_leaves_the_existing_export_whole() {
        use std::io::{Seek, Write};
        let fixture = Fixture::project("pdf-save-race");
        let root = &fixture.root;
        let exports = fixture.parent.join("exports");
        fs::create_dir_all(&exports).unwrap();
        let export = exports.join("paper.pdf");
        let source = fixture.path("paper.pdf");
        let original = b"%PDF-1.4 the checked version";
        let previous = b"%PDF-1.4 last week's export";
        let save = |copy: &dyn Fn(&mut File, &mut File) -> io::Result<u64>| {
            fixture.write("paper.pdf", original);
            fs::write(&export, previous).unwrap();
            let (_, version) = ranges(root, "paper.pdf");
            copy_checked_version(root, "paper.pdf", &version, &export, copy)
        };
        let exported = || {
            let mut names = fs::read_dir(&exports)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>();
            names.sort();
            (names, fs::read(&export).unwrap())
        };
        let untouched = (vec!["paper.pdf".to_string()], previous.to_vec());

        // Rewritten in place, as pdfTeX does, while the copy runs: the same
        // length, so only the version check after copying can tell.
        let rewritten = save(&|source_file, output| {
            fs::write(&source, b"%PDF-1.4 the changed version").unwrap();
            io::copy(source_file, output)
        });
        assert_eq!(rewritten.err().unwrap(), FILE_CHANGED);
        assert_eq!(exported(), untouched);

        // Truncated while the copy runs.
        let truncated = save(&|source_file, output| {
            OpenOptions::new().write(true).open(&source).unwrap().set_len(9).unwrap();
            io::copy(source_file, output)
        });
        assert_eq!(truncated.err().unwrap(), FILE_CHANGED);
        assert_eq!(exported(), untouched);

        // The disk fills up after part of the copy was written.
        let failed = save(&|source_file, output| {
            let mut head = [0; 8];
            source_file.read_exact(&mut head)?;
            output.write_all(&head)?;
            Err(io::Error::other("No space left on device"))
        });
        assert!(failed.err().unwrap().contains("No space left on device"));
        assert_eq!(exported(), untouched);

        // A copy of the checked version replaces the export.
        let replaced = save(&|source_file, output| {
            source_file.rewind()?;
            io::copy(source_file, output)
        });
        assert_eq!(replaced.unwrap(), export.to_string_lossy());
        assert_eq!(exported(), (vec!["paper.pdf".to_string()], original.to_vec()));
    }

    #[test]
    fn a_pdf_is_saved_only_to_a_regular_file() {
        let fixture = Fixture::project("pdf-save-target");
        let root = &fixture.root;
        fixture.write("paper.pdf", b"%PDF-1.4 the checked version");
        let (_, version) = ranges(root, "paper.pdf");

        let folder = fixture.parent.join("folder.pdf");
        fs::create_dir(&folder).unwrap();
        let fifo = fixture.parent.join("pipe.pdf");
        let fifo_path = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
        for target in [&folder, &fifo] {
            let refused = save_asset_copy(root, "paper.pdf", &version, target);
            assert_eq!(refused.err().unwrap(), "Choose a file to save the PDF to.", "{target:?}");
        }

        // Through a link, the file it points at is replaced and the link kept.
        let target = fixture.parent.join("target.pdf");
        fs::write(&target, b"%PDF-1.4 old").unwrap();
        let link = fixture.parent.join("link.pdf");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        save_asset_copy(root, "paper.pdf", &version, &link).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"%PDF-1.4 the checked version");
    }
}
