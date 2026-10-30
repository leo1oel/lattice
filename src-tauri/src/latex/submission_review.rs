//! What a double-blind venue's reviewers, and its proceedings' checks, would
//! catch in a submission, found before it is sent: a template still set to
//! show the authors, source that names them (acknowledgements, a `\thanks`, a
//! link to their own repository, "our previous work"), a name in the PDF's
//! metadata, and fonts a proceedings check refuses (Type 3, or not embedded).
//!
//! The anonymity checks follow the conference template the document loads,
//! not the manifest's venue (see `venue.rs`), and stop once that template is
//! switched to its camera-ready copy: that paper is past review, and naming
//! its authors is the point. The font checks hold for any paper.
//!
//! Only what TeX typesets counts. Comments and verbatim text are skipped, and
//! so is anything inside a conditional whose test names a camera-ready or
//! review switch (`\ificlrfinal`, `\ifdefined\isaccepted`, a writer's own
//! `\ifcameraready`), or inside `\iffalse`: which branch typesets is that
//! switch's business, and either way the writer has already gated it.

use super::arxiv::code_lines;
use super::build_log::conference_template_venue;
use super::{default_root, document_venue};
use crate::pdf_fonts::{self, PdfText};
use crate::project;
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

/// The conference templates whose review is double-blind.
const DOUBLE_BLIND: [&str; 3] = ["NeurIPS", "ICML", "ICLR"];

/// Files read at most, so a cycle or a huge tree of inputs cannot stall the checklist.
const MAX_FILES: usize = 64;

const EXCERPT_CHARS: usize = 120;

/// A control word, as TeX reads it: letters (and `@`) after a backslash.
static CONTROL_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\([A-Za-z@]+)").unwrap());
static BRACED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\{([^{}]+)\}").unwrap());
static PACKAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:usepackage|documentclass)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}").unwrap()
});
/// A conditional's test that names a camera-ready or review switch.
static SWITCH_TEST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)final|accepted|camera|anonym|review|blind|submission|preprint").unwrap()
});
static ACKNOWLEDGEMENTS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\\(?:(?:sub)*section|paragraph|chapter)\*?\s*(?:\[[^\]]*\])?\s*\{\s*acknowledge?ments?\b|\\begin\s*\{\s*(?:acknowledge?ments?|acks?)\s*\}",
    )
    .unwrap()
});
/// A code host's page for one account, or a `~user` home page.
static ACCOUNT_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|huggingface\.co)/([A-Za-z0-9][A-Za-z0-9_.-]*)[^\s{}\\%,;)]*|https?://[^\s{}\\%]*/~[A-Za-z][^\s{}\\%,;)]*",
    )
    .unwrap()
});
static SELF_CITATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:our|my)\s+(?:own\s+)?(?:previous|prior|earlier|recent|past|preceding)\s+(?:work|paper|stud(?:y|ies)|publication|research|approach|method|system)s?\b|\bwe\s+(?:have\s+)?(?:previously|earlier)\s+(?:show|shown|showed|propose|proposed|introduce|introduced|present|presented|report|reported|demonstrate|demonstrated|describe|described)\b",
    )
    .unwrap()
});
static PDF_AUTHOR_OPTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"pdfauthor\s*=").unwrap());
/// etoolbox tests that take their branches as arguments and so close with no `\fi`.
const ARGUMENT_TESTS: [&str; 10] = [
    "ifdef",
    "ifundef",
    "ifdefempty",
    "ifdefvoid",
    "ifdefmacro",
    "ifdefstring",
    "ifdefequal",
    "ifdefstrequal",
    "ifbool",
    "iftoggle",
];

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionReview {
    /// The conference template the document loads ("NeurIPS"), if any.
    pub venue: Option<&'static str>,
    /// How that template is set for review; `None` when its review is not double-blind.
    pub mode: Option<ReviewMode>,
    /// Whether a compiled PDF was read.
    pub pdf: bool,
    /// Whether that PDF named any font, so its font checks settle anything.
    pub fonts_read: bool,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewMode {
    /// The template prints "Anonymous Authors" in place of the authors.
    Anonymous,
    /// A preprint or non-anonymous option prints the authors.
    AuthorsShown,
    /// The camera-ready switch is on.
    CameraReady,
    /// The template's options were not found (it is loaded through a wrapper).
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Check {
    AuthorsShown,
    Acknowledgements,
    Thanks,
    IdentifyingLink,
    SelfCitation,
    PdfAuthor,
    Type3Font,
    UnembeddedFont,
}

/// One thing to fix, with where in the source it is when it is anywhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub check: Check,
    pub file: Option<String>,
    pub line: Option<u32>,
    /// The source line, the link, the name in the metadata or the font.
    pub text: String,
}

/// The review of the project's default root document and the PDF beside it.
pub fn review_submission(root: &Path) -> SubmissionReview {
    let manifest = project::read_manifest(root).ok();
    match manifest.as_ref().and_then(default_root) {
        Some(document) => review_document(root, &document.path),
        None => SubmissionReview::default(),
    }
}

fn review_document(root: &Path, document: &str) -> SubmissionReview {
    let venue = document_venue(root, document);
    let mut review = SubmissionReview { venue, ..SubmissionReview::default() };
    let mut pdf_author_at = None;
    if let Some(venue) = venue.filter(|venue| DOUBLE_BLIND.contains(venue)) {
        let mut scan = SourceScan::new(root, venue);
        scan.file(document);
        pdf_author_at = scan.pdf_author_at.take();
        let (mode, findings) = scan.finish();
        review.mode = Some(mode);
        review.findings = findings;
    }
    let pdf = project::safe_path(root, document)
        .ok()
        .and_then(|path| fs::read(path.with_extension("pdf")).ok());
    let Some(pdf) = pdf else { return review };
    review.pdf = true;
    let text = pdf_fonts::pdf_text(&pdf);
    let dictionaries = pdf_fonts::dictionaries(&text.objects);
    if review.mode.is_some_and(|mode| mode != ReviewMode::CameraReady) {
        let (file, line) =
            pdf_author_at.map_or((None, None), |at: At| (Some(at.file), Some(at.line)));
        review.findings.extend(pdf_authors(&text, &dictionaries).into_iter().map(|name| Finding {
            check: Check::PdfAuthor,
            file: file.clone(),
            line,
            text: name,
        }));
    }
    let fonts = pdf_fonts::font_embedding(&dictionaries);
    review.fonts_read = fonts.read;
    let font =
        |check: Check| move |name: String| Finding { check, file: None, line: None, text: name };
    review.findings.extend(fonts.type3.into_iter().map(font(Check::Type3Font)));
    review.findings.extend(fonts.unembedded.into_iter().map(font(Check::UnembeddedFont)));
    review
}

struct At {
    file: String,
    line: u32,
    text: String,
}

/// The manuscript read in TeX's order, `\input` files where they are input,
/// so a file input inside a camera-ready conditional is gated with it.
struct SourceScan<'a> {
    root: &'a Path,
    venue: &'static str,
    seen: HashSet<String>,
    /// The conditionals open at this point, each marked when it gates.
    conditionals: Vec<bool>,
    /// Inside NeurIPS's `ack` environment, which its style hides under review.
    in_ack: bool,
    /// `\author` was read and its argument has not opened yet.
    author_pending: bool,
    /// The brace depth inside `\author{…}`, while in it.
    author_depth: Option<u32>,
    mode: Option<(ReviewMode, At)>,
    iclr_final: Option<At>,
    pdf_author_at: Option<At>,
    findings: Vec<Finding>,
}

impl<'a> SourceScan<'a> {
    fn new(root: &'a Path, venue: &'static str) -> Self {
        Self {
            root,
            venue,
            seen: HashSet::new(),
            conditionals: Vec::new(),
            in_ack: false,
            author_pending: false,
            author_depth: None,
            mode: None,
            iclr_final: None,
            pdf_author_at: None,
            findings: Vec::new(),
        }
    }

    fn gated(&self) -> bool {
        self.in_ack || self.conditionals.iter().any(|&gates| gates)
    }

    /// TeX resolves `\input` against the project folder, adding `.tex` when
    /// the name as written is not a file.
    fn file(&mut self, relative: &str) {
        let read = |relative: &str| {
            project::safe_path(self.root, relative)
                .ok()
                .and_then(|path| fs::read_to_string(path).ok())
        };
        let relative = relative.trim().trim_start_matches("./");
        let with_tex = format!("{relative}.tex");
        let Some((relative, text)) = [relative, with_tex.as_str()]
            .into_iter()
            .find_map(|name| Some((name.to_string(), read(name)?)))
        else {
            return;
        };
        if self.seen.len() >= MAX_FILES || !self.seen.insert(relative.clone()) {
            return;
        }
        for (line, code) in code_lines(&text) {
            self.line(&relative, line, code);
        }
    }

    fn line(&mut self, file: &str, line: u32, code: &str) {
        let at = || At { file: file.to_string(), line, text: excerpt(code) };
        let mut gated = self.gated();
        let mut declaring = false;
        for word in CONTROL_WORD.captures_iter(code) {
            let (name, rest) = (&word[1], &code[word.get(0).unwrap().end()..]);
            match name {
                "newif" => declaring = true,
                _ if name.starts_with("if") && std::mem::take(&mut declaring) => {}
                _ if name.starts_with("if") => {
                    if rest.trim_start().starts_with('{') || ARGUMENT_TESTS.contains(&name) {
                        continue;
                    }
                    // The test runs to the first space: `\ifdefined\isaccepted`, not the text after it.
                    let test = &code[word.get(0).unwrap().start()..];
                    let test = &test[..test
                        .find(|c: char| c.is_whitespace() || c == '{')
                        .unwrap_or(test.len())];
                    self.conditionals.push(name == "iffalse" || SWITCH_TEST.is_match(test));
                }
                "fi" => {
                    self.conditionals.pop();
                }
                "begin" | "end"
                    if self.venue == "NeurIPS"
                        && BRACED.captures(rest).is_some_and(|arg| arg[1].trim() == "ack") =>
                {
                    self.in_ack = name == "begin";
                }
                "iclrfinalcopy" if self.venue == "ICLR" => self.iclr_final = Some(at()),
                "input" | "include" => {
                    if let Some(argument) = BRACED.captures(rest) {
                        self.file(&argument[1]);
                    }
                }
                _ => {}
            }
            gated |= self.gated();
        }
        if self.mode.is_none() {
            if let Some(mode) = self.template_mode(code) {
                self.mode = Some((mode, at()));
            }
        }
        let thanks = self.thanks_outside_author(code);
        if gated {
            return;
        }
        let mut found = |check, text: String| {
            self.findings.push(Finding {
                check,
                file: Some(file.to_string()),
                line: Some(line),
                text,
            });
        };
        if ACKNOWLEDGEMENTS.is_match(code) {
            found(Check::Acknowledgements, excerpt(code));
        }
        if thanks {
            found(Check::Thanks, excerpt(code));
        }
        for link in ACCOUNT_LINK.captures_iter(code) {
            if !link
                .get(1)
                .is_some_and(|account| account.as_str().eq_ignore_ascii_case("anonymous"))
            {
                found(Check::IdentifyingLink, link[0].trim_end_matches('.').to_string());
            }
        }
        if SELF_CITATION.is_match(code) {
            found(Check::SelfCitation, excerpt(code));
        }
        if self.pdf_author_at.is_none() && PDF_AUTHOR_OPTION.is_match(code) {
            self.pdf_author_at = Some(at());
        }
    }

    /// The review mode this line's `\usepackage` of the venue's template sets.
    fn template_mode(&self, code: &str) -> Option<ReviewMode> {
        let package = PACKAGE.captures_iter(code).find(|package| {
            package[2]
                .split(',')
                .any(|name| conference_template_venue(name.trim()) == Some(self.venue))
        })?;
        let options: Vec<&str> = package
            .get(1)
            .map_or("", |options| options.as_str())
            .split(',')
            .map(str::trim)
            .collect();
        let has = |names: &[&str]| options.iter().any(|option| names.contains(option));
        // What each style's own options do: NeurIPS's `final` and ICML's
        // `accepted` are the camera-ready copy; their preprint and
        // non-anonymous tracks print the authors under review.
        Some(match self.venue {
            "NeurIPS" if has(&["final"]) => ReviewMode::CameraReady,
            "NeurIPS"
                if has(&[
                    "preprint",
                    "nonanonymous",
                    "sglblindworkshop",
                    "creativeai",
                    "education",
                ]) =>
            {
                ReviewMode::AuthorsShown
            }
            "ICML" if has(&["accepted"]) => ReviewMode::CameraReady,
            "ICML" if has(&["preprint"]) => ReviewMode::AuthorsShown,
            _ => ReviewMode::Anonymous,
        })
    }

    /// Whether `code` holds a `\thanks` outside `\author{…}`, which the
    /// templates replace whole under review; one in the title still prints.
    fn thanks_outside_author(&mut self, code: &str) -> bool {
        let bytes = code.as_bytes();
        let mut found = false;
        let mut at = 0;
        while at < bytes.len() {
            match bytes[at] {
                b'\\' => {
                    let word = code[at + 1..].bytes().take_while(u8::is_ascii_alphabetic).count();
                    if self.author_depth.is_none() {
                        match &code[at + 1..at + 1 + word] {
                            "author" => self.author_pending = true,
                            "thanks" => found = true,
                            _ => {}
                        }
                    }
                    // An escaped brace is no brace.
                    at += 1 + word.max(1);
                    continue;
                }
                b'{' => match &mut self.author_depth {
                    Some(depth) => *depth += 1,
                    None if std::mem::take(&mut self.author_pending) => self.author_depth = Some(1),
                    None => {}
                },
                b'}' => {
                    self.author_depth = self
                        .author_depth
                        .and_then(|depth| depth.checked_sub(1))
                        .filter(|&depth| depth > 0);
                }
                _ => {}
            }
            at += 1;
        }
        found
    }

    fn finish(mut self) -> (ReviewMode, Vec<Finding>) {
        if let Some(at) = self.iclr_final.take() {
            self.mode = Some((ReviewMode::CameraReady, at));
        }
        match self.mode {
            None => (ReviewMode::Unknown, self.findings),
            Some((ReviewMode::CameraReady, _)) => (ReviewMode::CameraReady, Vec::new()),
            Some((ReviewMode::AuthorsShown, at)) => {
                let shown = Finding {
                    check: Check::AuthorsShown,
                    file: Some(at.file),
                    line: Some(at.line),
                    text: at.text,
                };
                (ReviewMode::AuthorsShown, std::iter::once(shown).chain(self.findings).collect())
            }
            Some((mode, _)) => (mode, self.findings),
        }
    }
}

fn excerpt(code: &str) -> String {
    let code = code.trim();
    match code.char_indices().nth(EXCERPT_CHARS) {
        Some((at, _)) => format!("{}…", &code[..at]),
        None => code.to_string(),
    }
}

/// The names in the PDF's `/Author` entries and its XMP `dc:creator`, the
/// figures' own included. A blank one, or the templates' "Anonymous
/// Authors", names nobody.
fn pdf_authors(text: &PdfText, dictionaries: &[Vec<u8>]) -> Vec<String> {
    static CREATOR: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?s)<dc:creator>(.*?)</dc:creator>").unwrap());
    static ITEM: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<rdf:li[^>]*>([^<]*)</rdf:li>").unwrap());
    let info = dictionaries.iter().filter_map(|dictionary| {
        let at = dictionary.windows(7).position(|window| window == b"/Author")? + 7;
        let start = at + dictionary[at..].iter().position(|byte| !byte.is_ascii_whitespace())?;
        pdf_string(&dictionary[start..])
    });
    let xmp = String::from_utf8_lossy(&text.metadata);
    let creators = CREATOR.captures_iter(&xmp).flat_map(|creator| {
        ITEM.captures_iter(&creator[1]).map(|item| xml_text(&item[1])).collect::<Vec<_>>()
    });
    let mut names: Vec<String> = Vec::new();
    for name in info.chain(creators) {
        let name = name.trim().to_string();
        if !name.is_empty()
            && !name.to_lowercase().starts_with("anonymous")
            && !names.contains(&name)
        {
            names.push(name);
        }
    }
    names
}

/// A PDF string object at the start of `bytes`, literal `(…)` or hex `<…>`,
/// as text: UTF-16 after its byte-order mark, else PDFDocEncoding, read as
/// Latin-1 (they differ in no letter a name uses).
fn pdf_string(bytes: &[u8]) -> Option<String> {
    let raw: Vec<u8> = match bytes.first()? {
        b'(' => {
            let end = pdf_fonts::literal_string_end(bytes, 0);
            let body = &bytes[1..end.saturating_sub(1).max(1)];
            let mut out = Vec::with_capacity(body.len());
            let mut at = 0;
            while at < body.len() {
                if body[at] != b'\\' || at + 1 == body.len() {
                    out.push(body[at]);
                    at += 1;
                    continue;
                }
                let escaped = body[at + 1];
                at += 2;
                match escaped {
                    b'n' => out.push(b'\n'),
                    b'r' => out.push(b'\r'),
                    b't' => out.push(b'\t'),
                    // Up to three octal digits, the first one just read.
                    b'0'..=b'7' => {
                        let mut value = u32::from(escaped - b'0');
                        for _ in 0..2 {
                            let Some(&digit @ b'0'..=b'7') = body.get(at) else { break };
                            value = value * 8 + u32::from(digit - b'0');
                            at += 1;
                        }
                        out.push(u8::try_from(value & 0xff).unwrap_or(0));
                    }
                    b'\n' | b'\r' => {}
                    other => out.push(other),
                }
            }
            out
        }
        b'<' => {
            let end = bytes.iter().position(|&byte| byte == b'>')?;
            let digits: Vec<u8> =
                bytes[1..end].iter().copied().filter(u8::is_ascii_hexdigit).collect();
            digits
                .chunks(2)
                .map(|pair| {
                    let digit = |at: usize| {
                        pair.get(at).map_or(0, |&b| (b as char).to_digit(16).unwrap_or(0))
                    };
                    u8::try_from(digit(0) * 16 + digit(1)).unwrap_or(0)
                })
                .collect()
        }
        _ => return None,
    };
    Some(match raw.strip_prefix(&[0xfe, 0xff]) {
        Some(utf16) => {
            let units: Vec<u16> = utf16
                .chunks(2)
                .map(|pair| u16::from_be_bytes([pair[0], *pair.get(1).unwrap_or(&0)]))
                .collect();
            String::from_utf16_lossy(&units)
        }
        None => raw.iter().map(|&byte| char::from(byte)).collect(),
    })
}

fn xml_text(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests;
