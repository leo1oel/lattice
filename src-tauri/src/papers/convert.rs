//! An arXiv paper as markdown.
//!
//! arXiv renders modern papers to HTML but never went back over the archive,
//! and ar5iv covers most — not all — of the rest. When both renderers fail, the
//! TeX source retains the formula and document semantics that a PDF has already
//! flattened into positioned glyphs. Only papers without usable source reach
//! the deliberately lower-fidelity PDF text-layer fallback.

use super::bundle::{reset_asset_manifest, ANYDOC_CONVERTER};
use super::markdown::{clean_arxiv_source_markdown, markdown_has_body, parse_title};
use super::{
    check_cancelled, ensure_success, http_client, read_capped, send_checked, ARXIV2MD_CACHE_ENV,
    LITERATURE_USER_AGENT,
};
use crate::commands;
use crate::util::err;
use flate2::read::GzDecoder;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use uuid::Uuid;

const MAX_DOWNLOAD_BYTES: usize = 100 * 1024 * 1024;
const CONVERTER_TIMEOUT: Duration = Duration::from_secs(600);

/// Converted markdown, with the converter and `source` label its bundle
/// metadata records.
pub(super) struct Conversion {
    pub(super) markdown: String,
    pub(super) converter: &'static str,
    pub(super) source: &'static str,
}

pub(super) fn convert_paper(
    requested: &str, base: &str, output_dir: &Path, output_path: &Path, cancel: &AtomicBool,
) -> Result<Conversion, String> {
    let mut command = commands::ARXIV2MD.command()?;
    command
        .current_dir(output_dir)
        .env(ARXIV2MD_CACHE_ENV, commands::arxiv2md_cache_dir())
        .arg(requested)
        // Papers are read, not re-exported, and arXiv's own figures are
        // routinely 16-bit-per-channel PNG — depth no screen can show at twice
        // the bytes. WebP (`--compress-assets`) keeps plots and diagrams
        // pixel-exact and costs a 32-paper library 34 MB of figures instead of
        // 216 MB.
        .args(["--frontmatter", "--download-assets", "--compress-assets", "--remove-refs"])
        .args(["--section", "Acknowledgements", "--section", "Acknowledgments", "-o"])
        .arg(output_path);
    let output = commands::bibcite_output_cancellable(&mut command, CONVERTER_TIMEOUT, cancel)?;
    let html_error = match ensure_success("arxiv2md", &output) {
        Ok(()) => {
            if !output_path.is_file() {
                return Err("arxiv2md did not produce paper.md".to_string());
            }
            let markdown = fs::read_to_string(output_path).map_err(err)?;
            if markdown_has_body(&markdown) {
                let converter = commands::ARXIV2MD.requirement;
                return Ok(Conversion { markdown, converter, source: "arxiv-html" });
            }
            // ar5iv serves a paper its LaTeXML conversion choked on as an
            // HTTP 200 stub ("Untitled Document", zero sections), so arxiv2md
            // converts the stub and exits 0. The missing body is the only
            // signal that there was never a usable HTML rendering — treat it
            // exactly like the explicit no-HTML error.
            "arxiv2md produced an empty document from a failed ar5iv rendering.".to_string()
        }
        Err(error) if error.contains("does not have an HTML version") => error,
        Err(error) => return Err(error),
    };
    // The source route stays local and preserves formulas without shipping
    // Pandoc or a TeX distribution; the tiny parser is materialized in uv's
    // cache beside the other literature tools.
    match arxiv_source_markdown(requested, base, output_dir, cancel) {
        Ok(markdown) => Ok(Conversion {
            markdown,
            converter: commands::ARXIV_SOURCE2MD.requirement,
            source: "arxiv-source",
        }),
        Err(source_error) if !cancel.load(Ordering::Acquire) => pdf_fallback(
            requested,
            base,
            output_dir,
            &format!("{html_error}\nThe arXiv source fallback also failed: {source_error}"),
        ),
        Err(error) => Err(error),
    }
}

/// Frontmatter for a fallback conversion. Honesty is the point of `fidelity`:
/// both the reader and the agent read this file raw, so the caveat rides in
/// the file itself rather than in UI state.
fn fallback_markdown(title: &str, base: &str, source: &str, fidelity: &str, body: &str) -> String {
    format!(
        "---\ntitle: \"{}\"\nurl: \"https://arxiv.org/abs/{base}\"\nsource: \"{source}\"\nfidelity: \"{fidelity}\"\n---\n\n{body}",
        title.replace('"', "'"),
    )
}

fn arxiv_source_markdown(
    requested: &str, base: &str, output_dir: &Path, cancel: &AtomicBool,
) -> Result<String, String> {
    let work_dir = output_dir.join(format!(".source-conversion-{}", Uuid::new_v4()));
    let converted_dir = work_dir.join("converted");
    fs::create_dir_all(&converted_dir).map_err(err)?;
    let convert = || -> Result<String, String> {
        let source = download_arxiv_source(requested)?;
        check_cancelled(cancel)?;
        let source_path = work_dir.join(format!("source{}", arxiv_source_extension(&source)?));
        fs::write(&source_path, source).map_err(err)?;

        let mut command = commands::ARXIV_SOURCE2MD.command()?;
        command
            .current_dir(&work_dir)
            .arg(&source_path)
            .arg("--outdir")
            .arg(&converted_dir)
            // Formula and structure fidelity are the reason for this route.
            // Avoiding optional PDFium/Pillow binaries keeps the tool's cache
            // under 2 MB; figures still retain their captions in the text.
            .args(["--no-assets", "--json"]);
        let output = commands::bibcite_output_cancellable(&mut command, CONVERTER_TIMEOUT, cancel)?;
        ensure_success("arxiv source converter", &output)?;
        let document_path = converted_dir.join("document.md");
        if !document_path.is_file() {
            return Err("the converter did not produce document.md".to_string());
        }
        let converted = fs::read_to_string(document_path).map_err(err)?;
        if !markdown_has_body(&converted) {
            return Err("the converter produced a document with no body".to_string());
        }
        reset_asset_manifest(output_dir)?;
        let converted = clean_arxiv_source_markdown(&converted);
        let title = parse_title(&converted).unwrap_or_else(|| format!("arXiv {base}"));
        Ok(fallback_markdown(
            &title,
            base,
            "arxiv-source",
            "Converted from the public arXiv TeX source because no usable HTML rendering was available. Unsupported TeX figures are represented by their captions.",
            &converted,
        ))
    };
    let result = convert();
    let _ = fs::remove_dir_all(work_dir);
    result
}

fn download_arxiv_source(requested: &str) -> Result<Vec<u8>, String> {
    let client = http_client(LITERATURE_USER_AGENT, 120)
        .map_err(|error| format!("Could not create the source download client: {error}"))?;
    let request = client.get(format!("https://arxiv.org/e-print/{requested}"));
    let response = send_checked(request, "Source download failed", |status| {
        format!("arXiv returned HTTP {status} for the source archive.")
    })?;
    read_capped(response, MAX_DOWNLOAD_BYTES)
        .map_err(|error| format!("Source download failed: {error}"))?
        .ok_or_else(|| "The source archive is larger than the 100 MB conversion limit.".to_string())
}

/// arXiv source downloads vary across eras: most are compressed tarballs, but
/// old single-file submissions may be plain or gzipped TeX. Give the converter
/// the suffix that selects its hardened extractor without trusting HTTP names.
fn arxiv_source_extension(bytes: &[u8]) -> Result<&'static str, String> {
    let looks_like_tar = |bytes: &[u8]| bytes.get(257..262) == Some(b"ustar");
    if bytes.starts_with(b"%PDF") {
        return Err("arXiv returned a PDF instead of TeX source".to_string());
    }
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        return Ok(".zip");
    }
    if looks_like_tar(bytes) {
        return Ok(".tar");
    }
    if bytes.starts_with(b"\x1f\x8b") {
        let mut sample = Vec::with_capacity(512);
        GzDecoder::new(bytes)
            .take(512)
            .read_to_end(&mut sample)
            .map_err(|error| format!("The source gzip is unreadable: {error}"))?;
        return Ok(if looks_like_tar(&sample) { ".tar.gz" } else { ".tex.gz" });
    }
    let head = &bytes[..bytes.len().min(4096)];
    let contains = |needle: &[u8]| head.windows(needle.len()).any(|part| part == needle);
    if contains(b"\\documentclass") || contains(b"\\begin{document}") {
        return Ok(".tex");
    }
    Err("arXiv returned an unrecognized source archive".to_string())
}

/// Build the bundle from the PDF text layer after both semantic routes
/// produced nothing usable; `previous_error` preserves both reasons if this
/// final fallback also fails.
fn pdf_fallback(
    requested: &str, base: &str, output_dir: &Path, previous_error: &str,
) -> Result<Conversion, String> {
    let body =
        download_pdf_text(&format!("https://arxiv.org/pdf/{requested}")).map_err(|pdf_error| {
            format!("{previous_error}\nThe PDF fallback also failed: {pdf_error}")
        })?;
    let title = body
        .lines()
        .find_map(|line| {
            let text = line.trim_start_matches('#').trim();
            (line.starts_with('#') && !text.is_empty()).then(|| text.to_string())
        })
        .unwrap_or_else(|| format!("arXiv {base}"));
    // The text layer has no figures, and its equations carry font encoding
    // rather than LaTeX (Computer Modern renders `{W_i}` as `fWig`).
    let markdown = fallback_markdown(
        &title,
        base,
        "pdf-text-layer",
        "Converted from the PDF text layer because arXiv has no HTML rendering. Figures are absent and equations may be garbled by font encoding; verify formulas against the PDF before quoting them.",
        &body,
    );
    // The bundle contract requires an asset manifest, honestly empty here. An
    // abandoned stub conversion may have left assets behind — clear them so
    // the bundle matches its manifest.
    reset_asset_manifest(output_dir)?;
    Ok(Conversion { markdown, converter: ANYDOC_CONVERTER, source: "arxiv-pdf" })
}

pub(super) fn download_pdf_text(url: &str) -> Result<String, String> {
    let bytes = download_pdf_bytes(url)?;
    let body = anydoc::to_markdown_bytes(&bytes, anydoc::Format::Pdf)
        .map_err(|error| format!("PDF conversion failed: {error}"))?;
    if body.trim().len() < 200 {
        return Err(
            "The PDF has almost no text layer; a scanned paper needs OCR, which is not available."
                .to_string(),
        );
    }
    Ok(body)
}

/// Download the complete PDF for import and text extraction. Interactive
/// viewing uses paper_pdf_proxy so it can stream without waiting for this buffer.
fn download_pdf_bytes(url: &str) -> Result<Vec<u8>, String> {
    if !reqwest::Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https")) {
        return Err("Enter an http(s) PDF URL.".to_string());
    }
    let client = http_client("Lattice research writer (paper import)", 120)
        .map_err(|error| format!("Could not create the PDF download client: {error}"))?;
    let response = send_checked(client.get(url), "PDF download failed", |status| {
        format!("The server returned HTTP {status} for the PDF.")
    })?;
    let bytes = read_capped(response, MAX_DOWNLOAD_BYTES)
        .map_err(|error| format!("PDF download failed: {error}"))?
        .ok_or_else(|| "The PDF is larger than the 100 MB conversion limit.".to_string())?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("The URL did not return a PDF document.".to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn recognizes_arxiv_source_archive_formats_without_trusting_the_filename() {
        use std::io::Write as _;
        let gzip = |bytes: &[u8]| {
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        };
        let mut tar = vec![0; 512];
        tar[257..262].copy_from_slice(b"ustar");
        for (bytes, extension) in [
            (tar.clone(), ".tar"),
            (gzip(&tar), ".tar.gz"),
            (gzip(b"\\documentclass{article}"), ".tex.gz"),
            (b"\\documentclass{article}".to_vec(), ".tex"),
            (b"PK\x03\x04zip".to_vec(), ".zip"),
        ] {
            assert_eq!(arxiv_source_extension(&bytes), Ok(extension));
        }
        assert!(arxiv_source_extension(b"%PDF-1.7").is_err());
    }

    #[test]
    fn source_conversion_keeps_captions_but_drops_broken_assets_and_figure_code() {
        let output_dir = TempDir::new("papers");
        output_dir.write("paper_assets/stale.png", b"stale");
        let source = concat!(
            "![Local diagram](figures/diagram.pdf)\n\n",
            "![Remote diagram](https://example.com/diagram.png)\n\n",
            "[PGFPlots figure: Accuracy by epoch]\n\n",
            "<details>\n",
            "<summary>Show PGFPlots source</summary>\n\n",
            "```latex\n\\begin{tikzpicture}\n```\n\n",
            "</details>\n\n",
            "<details>\n<summary>Author note</summary>\nKeep me.\n</details>\n",
        );

        reset_asset_manifest(&output_dir).unwrap();
        let cleaned = clean_arxiv_source_markdown(source);
        assert!(cleaned.contains("> **Figure:** Local diagram"));
        assert!(cleaned.contains("![Remote diagram](https://example.com/diagram.png)"));
        assert!(cleaned.contains("[PGFPlots figure: Accuracy by epoch]"));
        assert!(!cleaned.contains("tikzpicture"), "got: {cleaned}");
        assert!(cleaned.contains("Author note"), "got: {cleaned}");
        assert!(!output_dir.join("paper_assets/stale.png").exists());
        assert_eq!(
            fs::read_to_string(output_dir.join("paper_assets/manifest.json")).unwrap(),
            "{\"schema_version\":1,\"assets\":[]}\n"
        );
    }
}
