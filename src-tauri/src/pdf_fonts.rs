//! Inspect embedded PDF fonts without poppler/`pdffonts`.
//!
//! pdfTeX usually stores font dictionaries inside `/FlateDecode` object streams, so a
//! raw `/BaseFont` scan of the file bytes finds nothing even when Times is embedded.

use flate2::read::ZlibDecoder;
use regex::Regex;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfFontReport {
    pub fonts: Vec<String>,
    pub has_times_like: bool,
    pub has_computer_modern: bool,
    /// True when we positively see Times/NimbusRom. Unknown/inconclusive is also
    /// treated as non-failing so we do not warn on compressed PDFs we cannot parse.
    pub ok_for_conference: bool,
    pub detail: String,
    pub conclusive: bool,
}

pub fn inspect_pdf_bytes(bytes: &[u8]) -> PdfFontReport {
    let mut haystack = Vec::with_capacity(bytes.len().saturating_mul(2));
    haystack.extend_from_slice(bytes);
    for chunk in inflate_flate_streams(bytes) {
        haystack.extend_from_slice(&chunk);
    }
    let fonts = extract_base_fonts(&haystack);
    let times_marker = contains_ascii_ci(&haystack, b"NimbusRom")
        || contains_ascii_ci(&haystack, b"Times-Roman")
        || contains_ascii_ci(&haystack, b"TimesNewRoman");
    let cm_marker = contains_ascii_ci(&haystack, b"/CMR")
        || contains_ascii_ci(&haystack, b"/CMMI")
        || contains_ascii_ci(&haystack, b"/CMBX")
        || contains_ascii_ci(&haystack, b"cmr10");
    summarize_fonts(fonts, times_marker, cm_marker)
}

pub fn inspect_pdf_path(path: &Path) -> Result<PdfFontReport, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(inspect_pdf_bytes(&bytes))
}

fn extract_base_fonts(bytes: &[u8]) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"/BaseFont\s*/([^\s/\[\]()<>]+)").expect("font regex"));
    let text = String::from_utf8_lossy(bytes);
    let mut names = BTreeSet::new();
    for caps in re.captures_iter(&text) {
        let raw = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        // Subset prefixes look like "ABCDEF+NimbusRomNo9L-Regu"
        let name = raw.rsplit('+').next().unwrap_or(raw);
        if !name.is_empty() {
            names.insert(name.to_string());
        }
    }
    names.into_iter().collect()
}

fn inflate_flate_streams(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut search_from = 0;
    while let Some(rel) = find_subslice(&bytes[search_from..], b"stream") {
        let stream_kw = search_from + rel;
        // Only inflate streams whose dict mentions FlateDecode.
        let dict_start = bytes[..stream_kw].iter().rposition(|&b| b == b'<').unwrap_or(0);
        let dict = &bytes[dict_start..stream_kw];
        if !contains_ascii_ci(dict, b"FlateDecode") {
            search_from = stream_kw + 6;
            continue;
        }
        let mut data_start = stream_kw + 6;
        if bytes.get(data_start) == Some(&b'\r') {
            data_start += 1;
        }
        if bytes.get(data_start) == Some(&b'\n') {
            data_start += 1;
        }
        let Some(end_rel) = find_subslice(&bytes[data_start..], b"endstream") else {
            break;
        };
        let mut data_end = data_start + end_rel;
        // Trim a trailing newline before endstream.
        while data_end > data_start && matches!(bytes[data_end - 1], b'\n' | b'\r') {
            data_end -= 1;
        }
        if let Some(inflated) = try_inflate(&bytes[data_start..data_end]) {
            out.push(inflated);
        }
        search_from = data_start + end_rel + 9;
    }
    out
}

fn try_inflate(data: &[u8]) -> Option<Vec<u8>> {
    // PDF Flate streams are zlib-wrapped; raw deflate is uncommon but cheap to try.
    let mut zlib = ZlibDecoder::new(data);
    let mut buf = Vec::new();
    if zlib.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
        return Some(buf);
    }
    use flate2::read::DeflateDecoder;
    let mut raw = DeflateDecoder::new(data);
    buf.clear();
    if raw.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
        return Some(buf);
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn contains_ascii_ci(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    let needle_lower: Vec<u8> = needle.iter().map(u8::to_ascii_lowercase).collect();
    haystack.windows(needle.len()).any(|window| {
        window
            .iter()
            .zip(needle_lower.iter())
            .all(|(a, b)| a.to_ascii_lowercase() == *b)
    })
}

fn summarize_fonts(fonts: Vec<String>, times_marker: bool, cm_marker: bool) -> PdfFontReport {
    let joined = fonts.join(", ");
    let lower = joined.to_ascii_lowercase();
    let has_times_like = times_marker
        || lower.contains("nimbusrom")
        || lower.contains("times-roman")
        || lower.contains("timesnewroman");
    let has_computer_modern = cm_marker
        || lower.split(", ").any(|name| {
            let n = name.trim();
            n.starts_with("cmr")
                || n.starts_with("cmmi")
                || n.starts_with("cmsy")
                || n.starts_with("cmbx")
                || n.starts_with("cmss")
                || n.starts_with("cmtt")
        });

    if fonts.is_empty() && !has_times_like && !has_computer_modern {
        // Inconclusive: do not fail the build. Real pdfTeX PDFs compress font dicts.
        return PdfFontReport {
            fonts,
            has_times_like: false,
            has_computer_modern: false,
            ok_for_conference: true,
            conclusive: false,
            detail: "Could not read embedded font names from this PDF (compressed streams). Not treated as a font failure.".to_string(),
        };
    }

    let ok_for_conference = has_times_like;
    let detail = if ok_for_conference {
        if fonts.is_empty() {
            "Conference Times-like fonts detected in PDF streams (NimbusRom/Times).".to_string()
        } else {
            format!("Conference Times-like fonts embedded: {joined}")
        }
    } else if has_computer_modern {
        format!(
            "PDF still uses Computer Modern{}. Expected NimbusRom/Times — Shift-click Build after Install BasicTeX.",
            if fonts.is_empty() {
                String::new()
            } else {
                format!(" ({joined})")
            }
        )
    } else {
        format!("PDF fonts are not NeurIPS Times ({joined}). Expected NimbusRomNo9L-*.")
    };

    PdfFontReport {
        fonts,
        has_times_like,
        has_computer_modern,
        ok_for_conference,
        conclusive: true,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_nimbus_subset_names() {
        let bytes = br#"
        << /Type /Font /Subtype /Type1 /BaseFont /QSNBTZ+NimbusRomNo9L-Regu >>
        << /Type /Font /Subtype /Type1 /BaseFont /FEUDWU+NimbusRomNo9L-Medi >>
        "#;
        let report = inspect_pdf_bytes(bytes);
        assert!(report.has_times_like);
        assert!(report.ok_for_conference);
        assert!(report.conclusive);
        assert!(report.fonts.iter().any(|f| f.contains("NimbusRom")));
    }

    #[test]
    fn detects_computer_modern() {
        let bytes = br#"<< /BaseFont /CMR10 >> << /BaseFont /CMMI10 >>"#;
        let report = inspect_pdf_bytes(bytes);
        assert!(report.has_computer_modern);
        assert!(!report.ok_for_conference);
        assert!(report.conclusive);
    }

    #[test]
    fn empty_scan_is_inconclusive_not_failure() {
        let bytes = b"%PDF-1.5\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";
        let report = inspect_pdf_bytes(bytes);
        assert!(report.ok_for_conference);
        assert!(!report.conclusive);
    }

    #[test]
    fn inflates_flate_stream_basefont() {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;

        let inner = b"<< /Type /Font /BaseFont /ABCDEF+NimbusRomNo9L-Regu >>";
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(inner).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut pdf = b"%PDF-1.5\n1 0 obj\n<< /Filter /FlateDecode /Length ".to_vec();
        pdf.extend_from_slice(compressed.len().to_string().as_bytes());
        pdf.extend_from_slice(b" >>\nstream\n");
        pdf.extend_from_slice(&compressed);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        let report = inspect_pdf_bytes(&pdf);
        assert!(report.has_times_like, "{}", report.detail);
        assert!(report.ok_for_conference);
        assert!(report.fonts.iter().any(|f| f.contains("NimbusRom")));
    }
}
