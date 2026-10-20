//! SyncTeX lookups between the compiled PDF and its sources.

mod records;

use super::{default_root_document, synctex_missing};
use crate::commands;
use crate::latex::PdfSyncTarget;
use crate::models::SyncTexTarget;
use crate::project;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::str::FromStr;

/// Shown for either direction: without the map there is nothing to match.
const NO_SYNCTEX_DATA: &str = "This PDF has no SyncTeX data, so Lattice cannot match it to the \
    source. A PDF compiled outside Lattice leaves it out, and latexmk then reports nothing to do \
    — press Build once to write it.";

pub fn inverse_search(root: &Path, page: u32, x: f64, y: f64) -> Result<SyncTexTarget, String> {
    if page == 0 || !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err("Invalid PDF source position.".to_string());
    }
    let (_, pdf) = synced_pdf(root, "Build the project before locating PDF source.")?;
    let output = run_synctex(
        root,
        &["edit".into(), "-o".into(), format!("{page}:{x:.3}:{y:.3}:{}", pdf.display())],
        "SyncTeX could not locate this PDF position.",
    )?;
    // On a clipped graphic pdfTeX's SyncTeX answers `Line:0` (see
    // `records::source_at`); the records around the point still name the line
    // that placed it, or failing that the nearest one that has a line.
    let pdf = root.join(&pdf);
    let (input, line) = parse_synctex_edit(&output)
        .or_else(|| {
            records::read(&pdf).and_then(|synctex| records::source_at(&synctex, page, (x, y)))
        })
        .ok_or_else(|| "No LaTeX source was found for this PDF position.".to_string())?;
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_input =
        build_folder(&pdf).join(&input).canonicalize().map_err(|error| error.to_string())?;
    let relative = canonical_input
        .strip_prefix(&canonical_root)
        .map_err(|_| "SyncTeX returned a source file outside this project.".to_string())?;
    // Clicking a reference lands in the generated .bbl; redirect to the .bib entry
    // the writer can actually edit. Fall through to the .bbl if we can't resolve it.
    if relative.extension().and_then(|value| value.to_str()) == Some("bbl") {
        if let Ok(Some(target)) = project::bib_target_for_bbl(root, relative, line) {
            return Ok(target);
        }
    }
    Ok(SyncTexTarget { path: relative.to_string_lossy().to_string(), line })
}

pub fn forward_search(
    root: &Path, path: &str, line: u32, column: u32,
) -> Result<Option<PdfSyncTarget>, String> {
    if line == 0 {
        return Err("Choose a source line before locating it in the PDF.".to_string());
    }
    // `safe_path` resolves beneath the canonical root, so strip that: a root
    // reached through a symlink (macOS's /var and /tmp are) is not its prefix.
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let relative = project::safe_path(root, path)?
        .strip_prefix(&canonical_root)
        .map_err(|_| "Source path is outside this project.".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let (document, pdf) = synced_pdf(root, "Build the project before locating source in the PDF.")?;
    let synctex = records::read(&root.join(&pdf));
    // A .bib entry reaches the PDF through the generated .bbl, so look that up.
    let (lookup_path, lookup_line, lookup_column) =
        if Path::new(&relative).extension().and_then(|value| value.to_str()) == Some("bib") {
            let bbl = Path::new(&document).with_extension("bbl");
            let target = project::bbl_target_for_bib(root, Path::new(&relative), &bbl, line)?
                .ok_or_else(|| {
                    "This bibliography entry is not included in the compiled PDF.".to_string()
                })?;
            (target.path, target.line, 0)
        } else {
            (relative, line, column.saturating_sub(1))
        };
    let lookup_path = synctex
        .as_deref()
        .and_then(|synctex| recorded_name(synctex, &root.join(&pdf), &root.join(&lookup_path)))
        .unwrap_or(lookup_path);
    let output = run_synctex(
        root,
        &[
            "view".into(),
            "-i".into(),
            format!("{lookup_line}:{lookup_column}:{lookup_path}"),
            "-o".into(),
            pdf.display().to_string(),
        ],
        "SyncTeX could not locate this source line.",
    )?;
    first_synctex_view_target(&output, |page| {
        synctex.map(|synctex| records::corrections(&synctex, page)).unwrap_or_default()
    })
}

/// The folder TeX ran in, which SyncTeX's relative input names start from:
/// the one holding the PDF, as latexmk `-cd` typesets beside the document.
fn build_folder(pdf: &Path) -> &Path {
    pdf.parent().unwrap_or(pdf)
}

/// The name SyncTeX recorded `source` under. `synctex view` matches the
/// name it is given by its text, and a file the document reached through
/// `..` (`\input{../shared/closing}`) is recorded with the `..` in it, so no
/// project-relative name finds it.
fn recorded_name(synctex: &str, pdf: &Path, source: &Path) -> Option<String> {
    let source = source.canonicalize().ok()?;
    synctex
        .lines()
        .filter_map(|record| record.strip_prefix("Input:")?.split_once(':').map(|(_, name)| name))
        .filter(|name| Path::new(name).file_name() == source.file_name())
        .find(|name| build_folder(pdf).join(name).canonicalize().is_ok_and(|name| name == source))
        .map(str::to_string)
}

/// Source the manuscript's body is read from: all of `path`, or its lines
/// before `before` (where the body ends in it, or the file holding that end
/// is included).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BodySpan {
    pub path: String,
    pub before: Option<u32>,
}

/// How many pages of the compiled PDF the body takes: the last page holding
/// anything typeset from `spans`. References and an appendix that start
/// partway down a page leave that page in the body; ones that open a page do
/// not. `None` when nothing from `spans` is on any page.
pub fn body_pages(root: &Path, spans: &[BodySpan]) -> Result<Option<u32>, String> {
    let (_, pdf) = synced_pdf(root, "Build the project before counting its pages.")?;
    let pdf = root.join(&pdf);
    let Some(synctex) = records::read(&pdf) else { return Ok(None) };
    let spans: Vec<(PathBuf, u32)> = spans
        .iter()
        .filter_map(|span| {
            let path = project::safe_path(root, &span.path).ok()?.canonicalize().ok()?;
            Some((path, span.before.unwrap_or(u32::MAX)))
        })
        .collect();
    // SyncTeX names its inputs as TeX opened them, absolute or from the
    // build's folder.
    Ok(records::last_page_before(&synctex, |input| {
        let input = build_folder(&pdf).join(input);
        // Most inputs are the TeX installation's: only a name a span has is resolved.
        if !spans.iter().any(|(path, _)| path.file_name() == input.file_name()) {
            return None;
        }
        let input = input.canonicalize().ok()?;
        spans.iter().find(|(path, _)| *path == input).map(|(_, before)| *before)
    }))
}

/// A heading the outline lists: its file (relative to the project) and line.
#[derive(Debug, Deserialize)]
pub struct SourceLine {
    pub path: String,
    pub line: u32,
}

/// The page of the compiled PDF each of `headings` is typeset on, in order;
/// `None` for one SyncTeX did not record. One read of the SyncTeX data
/// answers every heading, rather than a `synctex view` run for each.
pub fn heading_pages(root: &Path, headings: &[SourceLine]) -> Result<Vec<Option<u32>>, String> {
    let (_, pdf) = synced_pdf(root, "Build the project before locating its sections.")?;
    let count = headings.len();
    let pdf = root.join(&pdf);
    let Some(synctex) = records::read(&pdf) else { return Ok(vec![None; count]) };
    let headings: Vec<(PathBuf, usize, u32)> = headings
        .iter()
        .enumerate()
        .filter_map(|(index, heading)| {
            let path = project::safe_path(root, &heading.path).ok()?.canonicalize().ok()?;
            Some((path, index, heading.line))
        })
        .collect();
    Ok(records::heading_pages(&synctex, count, |input| {
        // SyncTeX names its inputs as TeX opened them, absolute or from the
        // build's folder; most are the TeX installation's.
        let input = build_folder(&pdf).join(input);
        if !headings.iter().any(|(path, ..)| path.file_name() == input.file_name()) {
            return Vec::new();
        }
        let Ok(input) = input.canonicalize() else { return Vec::new() };
        headings
            .iter()
            .filter(|(path, ..)| *path == input)
            .map(|(_, index, line)| (*index, *line))
            .collect()
    }))
}

/// The default root document and its PDF (relative to `root`), once that PDF
/// exists and has SyncTeX data to search.
fn synced_pdf(root: &Path, unbuilt: &str) -> Result<(String, PathBuf), String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?.path.clone();
    let pdf = Path::new(&document).with_extension("pdf");
    if !root.join(&pdf).is_file() {
        return Err(unbuilt.to_string());
    }
    // Missing SyncTeX data is not "this line is not in the PDF": the whole map
    // is absent, and every line would answer the same. Say so once here rather
    // than sending the reader looking for a paragraph that is on the page.
    if synctex_missing(root) {
        return Err(NO_SYNCTEX_DATA.to_string());
    }
    Ok((document, pdf))
}

/// Run `synctex` and return its stdout, or a readable failure led by `lead`.
fn run_synctex(root: &Path, args: &[String], lead: &str) -> Result<String, String> {
    let output = commands::command("synctex")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|error| format!("Could not start SyncTeX: {error}"))?;
    if !output.status.success() {
        return Err(synctex_failure(&String::from_utf8_lossy(&output.stderr), lead));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Turn a failed `synctex` run into one sentence a writer can act on.
///
/// synctex answers every failure by printing its entire command-line manual to
/// stderr — around fifty lines of `-o page:x:y:file` grammar. The one failure
/// that actually happens has a cause worth naming instead: a PDF built by
/// another tool carries no `.synctex.gz`, because Lattice's own build is what
/// passes `-synctex=1`.
fn synctex_failure(stderr: &str, lead: &str) -> String {
    if stderr.contains("No SyncTeX available") {
        return NO_SYNCTEX_DATA.to_string();
    }
    let reason = stderr
        .lines()
        .take_while(|line| !line.trim_start().starts_with("usage:"))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if reason.is_empty() {
        return lead.to_string();
    }
    // Any other synctex failure is still a tool message, not prose: keep it
    // short enough to read at a glance in the editor's error strip.
    format!("{lead} {}", crate::util::truncate_chars(&reason, 200))
}

/// The source file and line of `synctex edit`'s first result, when it names
/// both.
fn parse_synctex_edit(output: &str) -> Option<(String, u32)> {
    let input = output
        .lines()
        .find_map(|line| line.strip_prefix("Input:"))
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let line = field(output, "Line:").filter(|value| *value > 0)?;
    Some((input.to_string(), line))
}

/// Where a forward search lands in `synctex view` output. Every result must
/// parse; results on page 0 are no match.
///
/// SyncTeX answers one source line with every box it fed, its best guess
/// first, and that first box can be far larger than the place it names: a
/// `\begin{subfigure}` line answers with the box around the whole row of
/// panels. The point the first result gives is the place; the tightest box
/// around that point is the highlight, so a structural line lands on the
/// panel or caption it names when SyncTeX knows one, and only an enclosing
/// box with nothing tighter inside it is shown whole. A box elsewhere on the
/// page (a footnote the line also fed) never wins.
///
/// Each box is first measured as TeX laid it out (`corrections` gives the
/// page's boxes): synctex sizes a box holding a scaled graphic by the
/// graphic's unscaled size.
fn first_synctex_view_target(
    output: &str, corrections: impl FnOnce(u32) -> Vec<records::Correction>,
) -> Result<Option<PdfSyncTarget>, String> {
    // A successful `synctex view` prints only its version banner when the
    // source line has no PDF node (common for declarations in .sty files).
    // That is a valid no-match, not malformed SyncTeX data.
    let mut results = Vec::new();
    for block in output.split("SyncTeX result begin").skip(1) {
        let body = block.split("SyncTeX result end").next().unwrap_or(block);
        // One block lists every result, each opening with its `Output:` line.
        for record in body.split("\nOutput:").filter(|record| !record.trim().is_empty()) {
            results.push(view_result(record)?);
        }
    }
    let Some(page) = results.iter().map(|result| result.target.page).find(|page| *page != 0) else {
        return Ok(None);
    };
    results.retain(|result| result.target.page == page);
    let corrections = corrections(page);
    for result in results.iter_mut().filter(|result| result.boxed) {
        if let Some(correction) =
            corrections.iter().find(|correction| correction.reported.same_box(&result.target))
        {
            result.target = correction.laid_out.clone();
        }
        result.target.y = result.target.y.max(0.0);
    }
    let first = &results[0];
    let boxes: Vec<_> =
        results.iter().filter(|result| result.boxed).map(|result| result.target.clone()).collect();
    Ok(Some(tightest(&boxes, first.point).unwrap_or(&first.target).clone()))
}

/// The smallest of `boxes` around `point`; `min_by` keeps the earliest of
/// equal areas, which is SyncTeX's own order.
fn tightest(boxes: &[PdfSyncTarget], (x, y): (f64, f64)) -> Option<&PdfSyncTarget> {
    boxes
        .iter()
        .filter(|target| target.contains(x, y))
        .min_by(|left, right| left.area().total_cmp(&right.area()))
}

/// One `synctex view` result: the rectangle to highlight, whose `y` is its
/// top edge; the point SyncTeX matched; and whether the rectangle is a real
/// box rather than a marker drawn around that point.
struct ViewResult {
    target: PdfSyncTarget,
    point: (f64, f64),
    boxed: bool,
}

/// `h`/`v` is a box's origin: on its baseline, with the height `H` running up
/// the page from there (`synctex help view`). Drawing from `v` put a tall box
/// — a whole figure — below the place it encloses, so a box starts at `v - H`.
/// A result with no usable box falls back to its `x`/`y` point, also on a
/// baseline, under a line-sized marker that sits on it.
fn view_result(record: &str) -> Result<ViewResult, String> {
    let missing = |prefix: &str| format!("SyncTeX output is missing {prefix}");
    let page: u32 = field(record, "Page:").ok_or_else(|| missing("Page:"))?;
    let (h, v) = (coordinate(record, "h:"), coordinate(record, "v:"));
    let x = coordinate(record, "x:").or(h).ok_or_else(|| missing("x:"))?;
    let y = coordinate(record, "y:").or(v).ok_or_else(|| missing("y:"))?;
    let extent = |prefix: &str| coordinate(record, prefix).filter(|value| *value > 0.0);
    let (target, boxed) = match (h, v, extent("W:"), extent("H:")) {
        (Some(left), Some(baseline), Some(width), Some(height)) => {
            (PdfSyncTarget { page, x: left, y: baseline - height, width, height }, true)
        }
        _ => {
            let (width, height) = (POINT_MARKER_WIDTH, POINT_MARKER_HEIGHT);
            (PdfSyncTarget { page, x, y: y - height, width, height }, false)
        }
    };
    // A box is clamped to the page once it is measured as TeX laid it out.
    let target = if boxed { target } else { PdfSyncTarget { y: target.y.max(0.0), ..target } };
    Ok(ViewResult { target, point: (x, y), boxed })
}

/// The marker for a result that names only a point: about one word of text.
const POINT_MARKER_WIDTH: f64 = 24.0;
const POINT_MARKER_HEIGHT: f64 = 12.0;

impl PdfSyncTarget {
    fn area(&self) -> f64 {
        self.width * self.height
    }

    /// Whether `other` is this box as synctex printed it, to its six digits.
    fn same_box(&self, other: &PdfSyncTarget) -> bool {
        const PRINTED: f64 = 0.01;
        self.page == other.page
            && (self.x - other.x).abs() < PRINTED
            && (self.y - other.y).abs() < PRINTED
            && (self.width - other.width).abs() < PRINTED
            && (self.height - other.height).abs() < PRINTED
    }

    /// Whether the point lies in this rectangle. SyncTeX reports no depth, so
    /// a point on (or a hair under) the baseline still counts as inside.
    fn contains(&self, x: f64, y: f64) -> bool {
        const SLACK: f64 = 0.5;
        x >= self.x - SLACK
            && x <= self.x + self.width + SLACK
            && y >= self.y - SLACK
            && y <= self.y + self.height + SLACK
    }

    /// How far the point lies outside this rectangle; 0 inside it.
    fn distance(&self, x: f64, y: f64) -> f64 {
        let dx = (self.x - x).max(x - (self.x + self.width)).max(0.0);
        let dy = (self.y - y).max(y - (self.y + self.height)).max(0.0);
        dx.hypot(dy)
    }
}

/// The value on the first `prefix` line of a SyncTeX record.
fn field<T: FromStr>(block: &str, prefix: &str) -> Option<T> {
    block.lines().find_map(|line| line.strip_prefix(prefix))?.trim().parse().ok()
}

fn coordinate(block: &str, prefix: &str) -> Option<f64> {
    field(block, prefix).filter(|value: &f64| value.is_finite())
}

#[cfg(test)]
mod tests;
