//! Inspect embedded PDF fonts without poppler/`pdffonts`.
//!
//! pdfTeX usually stores font dictionaries inside `/FlateDecode` object streams, so a
//! raw `/BaseFont` scan of the file bytes finds nothing even when Times is embedded.

use flate2::read::{DeflateDecoder, ZlibDecoder};
use regex::Regex;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfFontReport {
    /// True when we positively see Times/NimbusRom. Unknown/inconclusive is also
    /// treated as non-failing so we do not warn on compressed PDFs we cannot parse.
    pub ok_for_conference: bool,
    pub detail: String,
    pub conclusive: bool,
    /// The embedded font names, comma-separated.
    pub fonts: String,
}

pub fn inspect_pdf_bytes(bytes: &[u8]) -> PdfFontReport {
    let haystack = font_metadata(bytes);
    let mentions = |markers: &[&str]| {
        markers.iter().any(|marker| contains_ascii_ci(&haystack, marker.as_bytes()))
    };
    let times_marker = mentions(&["NimbusRom", "Times-Roman", "TimesNewRoman"]);
    let cm_marker = mentions(&["/CMR", "/CMMI", "/CMBX", "cmr10"]);
    summarize_fonts(extract_base_fonts(&haystack), times_marker, cm_marker)
}

pub fn inspect_pdf_path(path: &Path) -> Result<PdfFontReport, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(inspect_pdf_bytes(&bytes))
}

fn extract_base_fonts(bytes: &[u8]) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"/BaseFont\s*/([^\s/\[\]()<>]+)").expect("font regex"));
    let text = String::from_utf8_lossy(bytes);
    // Subset prefixes look like "ABCDEF+NimbusRomNo9L-Regu"
    let names = re
        .captures_iter(&text)
        .filter_map(|caps| caps.get(1)?.as_str().rsplit('+').next())
        .filter(|name| !name.is_empty())
        .collect::<BTreeSet<_>>();
    names.into_iter().map(str::to_string).collect()
}

fn font_metadata(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len().min(1024 * 1024));
    let mut search_from = 0;
    while let Some(rel) = find_subslice(&bytes[search_from..], b"stream") {
        let stream_kw = search_from + rel;
        let Some(data_start) = stream_data_start(bytes, stream_kw) else {
            search_from = stream_kw + 6;
            continue;
        };
        // Font dictionaries can be hidden in compressed PDF object streams.
        // Image and page-content streams cannot contain PDF objects, and
        // inflating them made a figure-heavy paper spend tens of seconds and
        // hundreds of MiB on a font check after typesetting had already ended.
        let dict_start = bytes[..stream_kw].iter().rposition(|&b| b == b'<').unwrap_or(0);
        let dict = &bytes[dict_start..stream_kw];
        let Some(end_rel) = find_subslice(&bytes[data_start..], b"endstream") else {
            break;
        };
        let mut data_end = data_start + end_rel;
        // Trim a trailing newline before endstream.
        while data_end > data_start && matches!(bytes[data_end - 1], b'\n' | b'\r') {
            data_end -= 1;
        }
        out.extend_from_slice(&bytes[search_from..data_start]);
        if contains_ascii_ci(dict, b"/ObjStm") {
            if contains_ascii_ci(dict, b"FlateDecode") {
                if let Some(inflated) = try_inflate(&bytes[data_start..data_end]) {
                    out.extend_from_slice(&inflated);
                }
            } else {
                out.extend_from_slice(&bytes[data_start..data_end]);
            }
        }
        out.push(b'\n');
        search_from = data_start + end_rel + 9;
    }
    out.extend_from_slice(&bytes[search_from..]);
    out
}

fn stream_data_start(bytes: &[u8], stream_kw: usize) -> Option<usize> {
    let mut dict_end = stream_kw;
    while dict_end > 0 && bytes[dict_end - 1].is_ascii_whitespace() {
        dict_end -= 1;
    }
    if dict_end < 2 || &bytes[dict_end - 2..dict_end] != b">>" {
        return None;
    }
    match bytes.get(stream_kw + 6..stream_kw + 8) {
        Some(b"\r\n") => Some(stream_kw + 8),
        _ if matches!(bytes.get(stream_kw + 6), Some(b'\n' | b'\r')) => Some(stream_kw + 7),
        _ => None,
    }
}

/// PDF Flate streams are zlib-wrapped; raw deflate is uncommon but cheap to try.
fn try_inflate(data: &[u8]) -> Option<Vec<u8>> {
    let decoders: [Box<dyn Read + '_>; 2] =
        [Box::new(ZlibDecoder::new(data)), Box::new(DeflateDecoder::new(data))];
    decoders.into_iter().find_map(|mut decoder| {
        let mut inflated = Vec::new();
        (decoder.read_to_end(&mut inflated).is_ok() && !inflated.is_empty()).then_some(inflated)
    })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn contains_ascii_ci(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack.windows(needle.len()).any(|window| window.eq_ignore_ascii_case(needle))
}

fn summarize_fonts(fonts: Vec<String>, times_marker: bool, cm_marker: bool) -> PdfFontReport {
    let joined = fonts.join(", ");
    let lower = joined.to_ascii_lowercase();
    let times_like = times_marker
        || ["nimbusrom", "times-roman", "timesnewroman"].iter().any(|name| lower.contains(name));
    let computer_modern = cm_marker
        || lower.split(", ").any(|name| {
            let name = name.trim();
            ["cmr", "cmmi", "cmsy", "cmbx", "cmss", "cmtt"].iter().any(|cm| name.starts_with(cm))
        });
    let (conclusive, detail) = if fonts.is_empty() && !times_like && !computer_modern {
        // Inconclusive: do not fail the build. Real pdfTeX PDFs compress font dicts.
        (false, "Could not read embedded font names from this PDF (compressed streams). Not treated as a font failure.".to_string())
    } else if times_like && fonts.is_empty() {
        (true, "Conference Times-like fonts detected in PDF streams (NimbusRom/Times).".to_string())
    } else if times_like {
        (true, format!("Conference Times-like fonts embedded: {joined}"))
    } else if computer_modern {
        let names = if fonts.is_empty() { String::new() } else { format!(" ({joined})") };
        (true, format!("PDF uses Computer Modern{names}, not Times."))
    } else {
        (true, format!("PDF fonts are not Times ({joined})."))
    };
    let ok_for_conference = times_like || !conclusive;
    PdfFontReport { ok_for_conference, conclusive, detail, fonts: joined }
}

/// Why a document that loaded a conference template is not typeset in
/// Times. Each names the one change that brings Times back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimesCause {
    /// `lmodern` loaded after the last Times package, replacing it.
    Lmodern,
    /// `fontspec` (XeLaTeX/LuaLaTeX) loaded after Times and made Latin Modern
    /// the main font.
    Fontspec,
    /// XeLaTeX/LuaLaTeX asked for Times in their Unicode (TU) encoding, which
    /// the Times package has no fonts for, so LaTeX fell back to Latin Modern.
    UnicodeEncoding,
    /// LaTeX asked for Times and found no fonts for it: Times is not installed.
    FontsMissing,
    /// Nothing in the build asked for Times.
    NotLoaded,
    /// The PDF is not in Times and the log does not say why.
    Unknown,
}

/// What in a TeX log makes Times the text font, lowercase: its packages, the
/// font definitions LaTeX loads the first time it sets Times, and fontspec's
/// note of a Times main font.
const TIMES_MARKERS: [&str; 8] = [
    "times.sty",
    "mathptmx.sty",
    "newtxtext.sty",
    "tgtermes.sty",
    "ptm.fd",
    "font family 'times",
    "font family 'texgyretermes",
    "font family 'nimbusrom",
];

/// What kept a conference document out of Times, or `None` when it is in
/// Times. `log` is the TeX log of the build that wrote the PDF. What it shows
/// replacing Times decides on its own, because a scan of the PDF alone passes
/// a Latin Modern paper whose figures embed their own Times-Roman; without
/// such evidence the PDF's fonts decide.
pub fn times_problem(report: &PdfFontReport, log: &str) -> Option<TimesCause> {
    let pdf_not_times = report.conclusive && !report.ok_for_conference;
    match TimesCause::from_log(log) {
        // Times may come from a package this list does not know.
        Some(TimesCause::NotLoaded) => pdf_not_times.then_some(TimesCause::NotLoaded),
        Some(cause) => Some(cause),
        None => pdf_not_times.then_some(TimesCause::Unknown),
    }
}

impl TimesCause {
    /// What the log shows replaced Times, if it shows anything. A log of a
    /// run that never finished typesetting shows nothing.
    fn from_log(log: &str) -> Option<Self> {
        let log = crate::latex::unwrap_log_lines(log).to_ascii_lowercase();
        if !log.contains("output written on") {
            return None;
        }
        let last = |needle: &str| log.rfind(needle);
        let times = TIMES_MARKERS.iter().filter_map(|marker| last(marker)).max();
        let after_times = |package: &str| last(package).is_some_and(|at| Some(at) > times);
        // Only the upright shape: one missing variant (small-caps italic,
        // say) falls back to another Times shape, not to another family.
        let undefined =
            |encoding: &str| log.contains(&format!("font shape `{encoding}/ptm/m/n' undefined"));
        if after_times("/lmodern.sty") {
            Some(Self::Lmodern)
        } else if after_times("/fontspec.sty") {
            Some(Self::Fontspec)
        } else if undefined("tu") {
            Some(Self::UnicodeEncoding)
        } else if undefined("t1") || undefined("ot1") {
            Some(Self::FontsMissing)
        } else if times.is_none() {
            Some(Self::NotLoaded)
        } else {
            None
        }
    }

    /// The message code's `cause` parameter.
    pub fn code(self) -> &'static str {
        match self {
            Self::Lmodern => "lmodern",
            Self::Fontspec => "fontspec",
            Self::UnicodeEncoding => "unicode-encoding",
            Self::FontsMissing => "fonts-missing",
            Self::NotLoaded => "not-loaded",
            Self::Unknown => "unknown",
        }
    }

    fn fix(self) -> &'static str {
        match self {
            Self::Lmodern => "The document loads lmodern after Times, which replaces it with Latin Modern: remove \\usepackage{lmodern}, then Build.",
            Self::Fontspec => "The document loads fontspec, which makes Latin Modern the main font: add \\setmainfont{Times New Roman} after it, or build with pdfLaTeX.",
            Self::UnicodeEncoding => "XeLaTeX and LuaLaTeX have no Times in their default encoding, so LaTeX fell back to Latin Modern: add \\usepackage[T1]{fontenc} after the template, or build with pdfLaTeX.",
            Self::FontsMissing => "Times is not installed, so LaTeX fell back to Computer Modern: click Install required tools in the TeX doctor, then Shift-click Build.",
            Self::NotLoaded => "The document never loads Times: add \\usepackage{times} after the template, then Build.",
            Self::Unknown => "Expected NimbusRomNo9L-*.",
        }
    }
}

/// The English text of a `pdf-fonts-not-times` message: a document that
/// loaded `venue`'s template, typeset in `fonts` because of `cause`.
pub fn not_times_detail(venue: &str, fonts: &str, cause: TimesCause) -> String {
    let fonts = if fonts.is_empty() { String::new() } else { format!(" ({fonts})") };
    format!("PDF fonts are not the Times that {venue} requires{fonts}. {}", cause.fix())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::ZlibEncoder;
    use std::io::Write;

    /// A one-object PDF whose `dict` stream holds `content`, Flate-compressed.
    fn pdf_with_compressed_stream(dict: &str, content: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(content).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut pdf = format!(
            "%PDF-1.5\n1 0 obj\n<< {dict} /Filter /FlateDecode /Length {} >>\nstream\n",
            compressed.len()
        )
        .into_bytes();
        pdf.extend_from_slice(&compressed);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        pdf
    }

    #[test]
    fn classifies_embedded_fonts() {
        let nimbus = b"<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+NimbusRomNo9L-Regu >>";
        let computer_modern = b"<< /BaseFont /CMR10 >> << /BaseFont /CMMI10 >>";
        // (case, pdf, ok for a conference, conclusive, what the detail names)
        let cases = [
            ("subset Nimbus names", nimbus.to_vec(), true, true, "NimbusRomNo9L-Regu"),
            ("Computer Modern", computer_modern.to_vec(), false, true, "Computer Modern"),
            (
                "nothing readable is inconclusive, not a failure",
                b"%PDF-1.5\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n".to_vec(),
                true,
                false,
                "Not treated as a font failure",
            ),
            (
                "fonts inside a compressed object stream",
                pdf_with_compressed_stream("/Type /ObjStm", nimbus),
                true,
                true,
                "NimbusRomNo9L-Regu",
            ),
            // Image streams cannot hold PDF objects, so they are not inflated.
            (
                "an image stream",
                pdf_with_compressed_stream("/Type /XObject /Subtype /Image", computer_modern),
                true,
                false,
                "Not treated as a font failure",
            ),
            (
                "the words stream and endstream in text",
                b"%PDF-1.5\n(mention stream and endstream)\n<< /BaseFont /CMR10 >>\n%%EOF\n"
                    .to_vec(),
                false,
                true,
                "Computer Modern",
            ),
        ];
        for (case, pdf, ok_for_conference, conclusive, named) in cases {
            let report = inspect_pdf_bytes(&pdf);
            assert_eq!(report.ok_for_conference, ok_for_conference, "{case}: {}", report.detail);
            assert_eq!(report.conclusive, conclusive, "{case}: {}", report.detail);
            assert!(report.detail.contains(named), "{case}: {}", report.detail);
        }
    }
}
