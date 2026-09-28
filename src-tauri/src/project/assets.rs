//! Binary project files: byte previews for figures and embedded HTML, and
//! converting figures into formats LaTeX can include.

use super::err;
use super::paths::{extension, safe_path};
use super::tree::{
    classify_file_bytes, is_html_path, is_supported_asset, ContentKind, MAX_CLASSIFIED_TEXT_BYTES,
    MAX_LOCAL_HTML_BYTES,
};
use crate::commands;
use crate::models::AssetPreview;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
use std::path::Path;

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

pub fn read_asset(root: &Path, relative: &str) -> Result<AssetPreview, String> {
    let path = safe_path(root, relative)?;
    // SVG is the one supported image format whose bytes classify as text; it
    // is still a figure to preview, not a source file to open in an editor.
    let svg = path.extension().is_some_and(|value| value.eq_ignore_ascii_case("svg"));
    // Project-local HTML can be an authored iframe inside another HTML preview.
    // Return it through this byte-oriented command so the frontend can embed it
    // in the same opaque-origin sandbox instead of exposing a filesystem URL.
    let html = is_html_path(&path);
    if !path.is_file() {
        return Err("Choose a binary project file or an HTML preview resource.".to_string());
    }
    let size = fs::metadata(&path).map_err(err)?.len();
    if size > 50 * 1024 * 1024 {
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
        path: relative.replace('\\', "/"),
        mime_type: asset_mime_type(&path).unwrap_or("application/octet-stream").to_string(),
        base64: STANDARD.encode(bytes),
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;
    use crate::project::tree::{read_file, scan_tree, TreeView};

    #[test]
    fn project_figures_and_html_can_be_previewed_and_prepared_for_latex() {
        let fixture = Fixture::project("preview-assets");
        let root = &fixture.root;
        fixture.write("figures/result.png", b"\x89PNG\r\n\x1a\n");
        let preview = read_asset(root, "figures/result.png").unwrap();
        assert_eq!(
            (preview.path.as_str(), preview.mime_type.as_str(), preview.base64.as_str()),
            ("figures/result.png", "image/png", "iVBORw0KGgo=")
        );
        let html = "<!doctype html><script>Plotly.newPlot('chart', [], {})</script>";
        fixture.write("figures/chart.html", html);
        let preview = read_asset(root, "figures/chart.html").unwrap();
        assert_eq!(
            (preview.path.as_str(), preview.mime_type.as_str()),
            ("figures/chart.html", "text/html")
        );
        assert_eq!(STANDARD.decode(&preview.base64).unwrap(), html.as_bytes());
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

        let preview = read_asset(&fixture.root, "presentation.html").unwrap();
        assert_eq!(preview.mime_type, "text/html");
        assert_eq!(STANDARD.decode(preview.base64).unwrap(), html);
    }
}
