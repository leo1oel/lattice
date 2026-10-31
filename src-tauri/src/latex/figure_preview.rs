//! One figure typeset on its own, for the agent to look at before it puts
//! the figure in the paper.
//!
//! The agent drafts TikZ and PGFPlots blind: a label on top of a curve or a
//! legend over the data only shows once the figure is drawn. This typesets
//! the figure's body in a scratch folder, in a document that starts with the
//! paper's own preamble (its class, packages, macros and colours), inside a
//! minipage as wide as the paper's column, and ships that box alone as a
//! one-page PDF cropped to it. The agent sees the figure as the paper will
//! draw it, not as a stand-in class would.
//!
//! The paper is never touched. TeX runs in the scratch folder under its own
//! job name, so the preview's `.aux`, `.log` and PDF are its own, the
//! document's folder is only searched for inputs (`TEXINPUTS`), writes stay
//! in the scratch folder (`openout_any=p`), there is no shell escape, and the
//! folder is removed when the preview ends, finished, failed or timed out.
//!
//! A preamble that does not typeset here (a package that needs the shell, a
//! hook that wants the paper's `.aux`) is not the figure's fault, so a build
//! that stops before the body is tried once more on a plain `article`, and
//! the result says so.

use super::build::{abort, run_tracked, ActiveBuild};
use super::build_log::parse_diagnostics;
use super::BuildSteps;
use super::{default_root, unwrapped_log, venue::strip_comment};
use crate::{commands, project};
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The figure body, at most; PGFPlots tables inline make it longer than a drawing.
const MAX_CODE_BYTES: usize = 256 * 1024;
const MAX_PREAMBLE_BYTES: usize = 32 * 1024;
/// The PDF handed back, at most: a figure that needs more is not a figure.
const MAX_PDF_BYTES: usize = 8 * 1024 * 1024;
/// One pass of a heavy preamble and a dense PGFPlots axis takes a few
/// seconds; a figure still running after this is looping.
const TIMEOUT: Duration = Duration::from_secs(45);
const JOB: &str = "lattice-figure";
/// Printed first thing in the body: a log without it stopped in the preamble.
const BODY_MARKER: &str = "LATTICE-FIGURE-BODY";
/// White space around the figure on its page, so a stroke on the edge shows,
/// and the two of it a side of the page adds.
const MARGIN: &str = "2pt";
const MARGINS: &str = "4pt";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FigurePreviewRequest {
    /// What goes inside the `figure` environment: a `tikzpicture`, an `axis`,
    /// `\includegraphics`, subfigures.
    pub code: String,
    /// Preamble lines the figure needs beyond the paper's (`\usetikzlibrary`).
    #[serde(default)]
    pub preamble: Option<String>,
    /// Project-relative `.tex` whose preamble to use; the root document by default.
    #[serde(default)]
    pub document: Option<String>,
    /// The width the figure is typeset in: `\columnwidth` by default, or
    /// `\textwidth` for a `figure*`, or a length such as `3.25in`.
    #[serde(default)]
    pub line_width: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FigurePreview {
    /// The figure as a one-page PDF, base64; absent when it did not typeset.
    pub pdf: Option<String>,
    /// Each error with where it is: `code line 4`, `preamble line 2`, or a
    /// document's own `file:line`.
    pub errors: Vec<String>,
    /// What typeset but will not look right: a line wider than the column.
    pub warnings: Vec<String>,
    /// The document whose preamble the figure was typeset with; absent for a
    /// plain `article`.
    pub preamble_from: Option<String>,
    /// Why that document's preamble was not used, when it was meant to be.
    pub preamble_fallback: Option<String>,
    /// Lines of the request's preamble that the document's preamble lacks:
    /// the paper needs them too once the figure is in it.
    pub preamble_to_add: Vec<String>,
    pub line_width: String,
    pub engine: String,
    pub duration_ms: u128,
}

/// Typeset `request.code` as a figure of the project at `root`.
pub fn preview_figure(
    root: &Path, request: &FigurePreviewRequest,
) -> Result<FigurePreview, String> {
    let started = Instant::now();
    validate(request)?;
    let line_width = line_width(request.line_width.as_deref())?;
    let manifest = project::read_manifest(root)?;
    let document = match request.document.as_deref() {
        Some(path) => Some(path.to_string()),
        None => default_root(&manifest).map(|document| document.path.replace('\\', "/")),
    };
    let source = match &document {
        Some(path) => Some(read_document(root, path)?),
        None => None,
    };
    let paper_preamble = source.as_deref().and_then(preamble);
    let extra = request.preamble.as_deref().unwrap_or("");
    let engine = engine_binary(&manifest.engine);
    let inputs = document
        .as_deref()
        .and_then(|path| project::safe_path(root, path).ok())
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| root.to_path_buf());

    // One figure at a time: each is a TeX run, and the agent waits on it.
    static RUNNING: Mutex<()> = Mutex::new(());
    let _running = RUNNING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut fallback = None;
    let mut attempt = match paper_preamble {
        Some(head) => {
            let source = Source::new(head, document.as_deref(), extra, &request.code, &line_width);
            let first = typeset(engine, &inputs, &source, TIMEOUT)?;
            if first.reached_body || first.timed_out {
                Some(first)
            } else {
                fallback = Some(first.errors.first().cloned().unwrap_or_else(|| {
                    "it stopped before the figure without naming an error".to_string()
                }));
                None
            }
        }
        None => None,
    };
    if attempt.is_none() {
        let plain = Source::new(PLAIN_PREAMBLE, None, extra, &request.code, &line_width);
        attempt = Some(typeset(engine, &inputs, &plain, TIMEOUT)?);
    }
    let attempt = attempt.expect("one attempt ran");
    let errors = match (&fallback, attempt.pdf.is_none()) {
        // A plain article cannot know the paper's macros, so its errors may
        // only be the paper's preamble missing; say why it was missing.
        (Some(reason), true) => std::iter::once(format!(
            "The paper's preamble did not typeset on its own here ({reason}), so this preview used a plain article."
        ))
        .chain(attempt.errors)
        .collect(),
        _ => attempt.errors,
    };
    let used_paper = paper_preamble.is_some() && fallback.is_none();
    Ok(FigurePreview {
        pdf: attempt.pdf.map(|bytes| STANDARD.encode(bytes)),
        errors,
        warnings: attempt.warnings,
        preamble_from: if used_paper { document.clone() } else { None },
        preamble_fallback: fallback,
        preamble_to_add: missing_lines(extra, paper_preamble.unwrap_or("")),
        line_width,
        engine: engine.to_string(),
        duration_ms: started.elapsed().as_millis(),
    })
}

const PLAIN_PREAMBLE: &str = "\\documentclass{article}\n";

fn validate(request: &FigurePreviewRequest) -> Result<(), String> {
    if request.code.trim().is_empty() {
        return Err("The figure code is empty.".to_string());
    }
    if request.code.len() > MAX_CODE_BYTES {
        return Err(format!("The figure code is over {} KiB.", MAX_CODE_BYTES / 1024));
    }
    if request.preamble.as_ref().is_some_and(|preamble| preamble.len() > MAX_PREAMBLE_BYTES) {
        return Err(format!("The figure preamble is over {} KiB.", MAX_PREAMBLE_BYTES / 1024));
    }
    let code: String = request.code.lines().map(strip_comment).collect::<Vec<_>>().join("\n");
    let document =
        Regex::new(r"\\(?:documentclass|begin\s*\{document\}|end\s*\{document\})").unwrap();
    if document.is_match(&code) {
        return Err("Pass only the figure's body as code, not a whole document: the paper's preamble is used, and extra packages go in preamble.".to_string());
    }
    if Regex::new(r"\\(?:usepackage|RequirePackage|usetikzlibrary|usepgfplotslibrary)\b")
        .unwrap()
        .is_match(&code)
    {
        return Err(
            "Packages and libraries load in the preamble: move them from code to preamble."
                .to_string(),
        );
    }
    let float = Regex::new(r"\\begin\s*\{(figure\*?|table\*?|wrapfigure)\}").unwrap();
    if let Some(found) = float.captures(&code) {
        return Err(format!(
            "Pass what goes inside the {} environment as code, without the environment itself; its caption and label are added when it is inserted.",
            &found[1]
        ));
    }
    Ok(())
}

/// The width as TeX reads it: a length, or a multiple of the paper's widths.
fn line_width(requested: Option<&str>) -> Result<String, String> {
    let Some(width) = requested.map(str::trim).filter(|width| !width.is_empty()) else {
        return Ok("\\columnwidth".to_string());
    };
    let pattern = Regex::new(
        r"^(?:\d+(?:\.\d+)?\s*(?:pt|bp|mm|cm|in|pc|dd|cc|em|ex)|(?:\d*\.?\d+\s*)?\\(?:columnwidth|textwidth|linewidth))$",
    )
    .unwrap();
    if pattern.is_match(width) {
        Ok(width.to_string())
    } else {
        Err(format!(
            "lineWidth {width:?} is not a length such as 3.25in, 0.8\\columnwidth or \\textwidth."
        ))
    }
}

fn read_document(root: &Path, document: &str) -> Result<String, String> {
    if !document.to_ascii_lowercase().ends_with(".tex") {
        return Err(format!("{document} is not a LaTeX document."));
    }
    let path = project::safe_path(root, document)?;
    fs::read_to_string(&path).map_err(|error| format!("Could not read {document}: {error}"))
}

/// Everything before the line that starts the document, when there is a
/// class to typeset with. Kept from the first line, so its line numbers are
/// the document's own.
fn preamble(source: &str) -> Option<&str> {
    let mut offset = 0;
    let mut class = false;
    for line in source.split_inclusive('\n') {
        let code = strip_comment(line);
        if code.contains("\\begin{document}") {
            return class.then_some(&source[..offset]);
        }
        class |= code.contains("\\documentclass");
        offset += line.len();
    }
    None
}

fn engine_binary(engine: &str) -> &'static str {
    match engine.trim().to_ascii_lowercase().as_str() {
        "xelatex" => "xelatex",
        "lualatex" => "lualatex",
        _ => "pdflatex",
    }
}

/// The lines of `extra` that `preamble` does not already have, spacing aside.
fn missing_lines(extra: &str, preamble: &str) -> Vec<String> {
    let squeeze = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let have: Vec<String> = preamble.lines().map(|line| squeeze(strip_comment(line))).collect();
    extra
        .lines()
        .map(|line| strip_comment(line).trim())
        .filter(|line| !line.is_empty() && !have.contains(&squeeze(line)))
        .map(str::to_string)
        .collect()
}

/// The generated document, and where its parts start in it.
struct Source {
    text: String,
    /// 1-based first lines of the request's preamble and of the code.
    extra_line: u32,
    code_line: u32,
    code_lines: u32,
    /// The document the head is the preamble of, line for line.
    head: Option<String>,
}

impl Source {
    fn new(head: &str, document: Option<&str>, extra: &str, code: &str, line_width: &str) -> Self {
        let count = |text: &str| u32::try_from(text.lines().count()).unwrap_or(u32::MAX);
        let mut text = head.to_string();
        if !text.ends_with('\n') {
            text.push('\n');
        }
        let extra_line = count(&text) + 1;
        text.push_str(extra.trim_end_matches('\n'));
        text.push('\n');
        // `lrbox` rather than `\sbox`: an argument is read whole before it
        // runs, so TeX would place every error in the code on its last line.
        // The box is shipped as the only page, sized to it: `\shipout` skips
        // the output routine, so no running head, line numbers or page number.
        text.push_str(&format!(
            "\\begin{{document}}\n\\typeout{{{BODY_MARKER}}}\n\\newsavebox\\LatticeFigure\n\\begin{{lrbox}}{{\\LatticeFigure}}\\begin{{minipage}}{{{line_width}}}%\n"
        ));
        let code_line = count(&text) + 1;
        text.push_str(code.trim_end_matches('\n'));
        text.push('\n');
        text.push_str(&format!(
            "\\end{{minipage}}\\end{{lrbox}}%\n\
             \\setlength{{\\paperwidth}}{{\\dimexpr\\wd\\LatticeFigure+{MARGINS}\\relax}}%\n\
             \\setlength{{\\paperheight}}{{\\dimexpr\\ht\\LatticeFigure+\\dp\\LatticeFigure+{MARGINS}\\relax}}%\n\
             \\ifdefined\\pdfpagewidth\\pdfpagewidth=\\paperwidth\\pdfpageheight=\\paperheight\\fi\n\
             \\ifdefined\\pagewidth\\pagewidth=\\paperwidth\\pageheight=\\paperheight\\fi\n\
             \\hoffset=-1in\\voffset=-1in\n\
             \\shipout\\vbox{{\\kern{MARGIN}\\hbox{{\\kern{MARGIN}\\usebox\\LatticeFigure\\kern{MARGIN}}}\\kern{MARGIN}}}%\n\
             \\end{{document}}\n"
        ));
        Self {
            text,
            extra_line,
            code_line,
            code_lines: count(code),
            head: document.map(str::to_string),
        }
    }

    /// Where line `line` of the generated document came from.
    fn place(&self, line: u32) -> String {
        if line >= self.code_line && line < self.code_line + self.code_lines {
            format!("code line {}", line - self.code_line + 1)
        } else if line >= self.extra_line && line < self.code_line {
            format!("preamble line {}", line - self.extra_line + 1)
        } else if let Some(document) = self.head.as_deref().filter(|_| line < self.extra_line) {
            format!("{document}:{line}")
        } else {
            "the figure's wrapper".to_string()
        }
    }
}

struct Attempt {
    pdf: Option<Vec<u8>>,
    errors: Vec<String>,
    warnings: Vec<String>,
    reached_body: bool,
    timed_out: bool,
}

fn typeset(
    engine: &str, inputs: &Path, source: &Source, timeout: Duration,
) -> Result<Attempt, String> {
    let scratch = Scratch::new()?;
    let tex = scratch.0.join(format!("{JOB}.tex"));
    fs::write(&tex, &source.text).map_err(|error| error.to_string())?;
    let mut command = commands::command(engine);
    unwrapped_log(&mut command).current_dir(&scratch.0);
    // The scratch folder first, so the document's folder can hold a file
    // named like the job; the trailing separator keeps TeX's own trees.
    let inputs = inputs.to_string_lossy();
    command.env(
        "TEXINPUTS",
        if inputs.contains(':') { ".:".to_string() } else { format!(".:{inputs}:") },
    );
    command.env("openout_any", "p");
    command
        .args([
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
            "-no-shell-escape",
        ])
        .arg(format!("{JOB}.tex"));

    let active = ActiveBuild::default();
    let steps = BuildSteps::new(|_, _| {});
    let (done, finished) = mpsc::channel::<()>();
    let watchdog = {
        let active = active.clone();
        std::thread::spawn(move || {
            if finished.recv_timeout(timeout) == Err(mpsc::RecvTimeoutError::Timeout) {
                let _ = abort(&active);
            }
        })
    };
    let ran = run_tracked(
        command,
        &active,
        &steps,
        &format!("Could not start {engine}. Install MacTeX or TeX Live. "),
        &format!("{engine} exited unexpectedly: "),
    );
    let _ = done.send(());
    let _ = watchdog.join();
    let (output, timed_out) = ran?;
    let log = fs::read_to_string(scratch.0.join(format!("{JOB}.log")))
        .unwrap_or_else(|_| commands::combined_output(&output));
    let reached_body = log.contains(BODY_MARKER);
    if timed_out {
        return Ok(Attempt {
            pdf: None,
            errors: vec![format!(
                "The figure was still typesetting after {} seconds and was stopped. Look for a loop, or a plot with far too many samples.",
                timeout.as_secs()
            )],
            warnings: Vec::new(),
            reached_body,
            timed_out,
        });
    }
    let pdf_path = scratch.0.join(format!("{JOB}.pdf"));
    let pdf = if output.status.success() && pdf_path.is_file() {
        let bytes = fs::read(&pdf_path).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_PDF_BYTES {
            return Err(format!(
                "The figure's PDF is over {} MiB; draw it with fewer elements or samples.",
                MAX_PDF_BYTES / 1024 / 1024
            ));
        }
        Some(bytes)
    } else {
        None
    };
    let mut errors = located_errors(&log, source);
    if pdf.is_none() && errors.is_empty() {
        errors = unlocated_errors(&log);
    }
    Ok(Attempt { warnings: overfull_lines(&log, source), pdf, errors, reached_body, timed_out })
}

/// The errors TeX names a line for, each with the source text it stopped at
/// (`l.12 \draw (0,0) -- (1,\x`), which says more than the message alone.
fn located_errors(log: &str, source: &Source) -> Vec<String> {
    static ERROR: OnceLock<Regex> = OnceLock::new();
    let error =
        ERROR.get_or_init(|| Regex::new(r"(?m)^(\S[^\n:]*\.[A-Za-z0-9]+):(\d+): (.+)$").unwrap());
    let context = Regex::new(r"(?m)^l\.\d+ (.*)$").unwrap();
    let mut errors: Vec<String> = Vec::new();
    for found in error.captures_iter(log).take(20) {
        let message = found[3].trim();
        let boilerplate = message == "Emergency stop." || message.starts_with("==> Fatal error");
        if boilerplate || message.contains("Warning:") {
            continue;
        }
        let file = found[1].trim_start_matches("./");
        let line: u32 = found[2].parse().unwrap_or(0);
        let place = if file == format!("{JOB}.tex") {
            source.place(line)
        } else {
            format!("{file}:{line}")
        };
        let after = &log[found.get(0).map_or(0, |whole| whole.end())..];
        let near: String = after.lines().take(12).collect::<Vec<_>>().join("\n");
        let at = context
            .captures(&near)
            .map(|line| line[1].trim().to_string())
            .filter(|text| !text.is_empty())
            .map(|text| format!(" (at `{text}`)"))
            .unwrap_or_default();
        let described = format!("{place}: {message}{at}");
        if !errors.contains(&described) {
            errors.push(described);
        }
    }
    errors
}

/// What the build reported when TeX located nothing: a missing class or
/// package, else the end of the log.
fn unlocated_errors(log: &str) -> Vec<String> {
    let errors: Vec<String> = parse_diagnostics(log)
        .into_iter()
        .filter(|diagnostic| diagnostic.level == "error")
        .map(|diagnostic| diagnostic.message)
        .collect();
    if !errors.is_empty() {
        return errors;
    }
    let tail: Vec<&str> =
        log.lines().rev().filter(|line| !line.trim().is_empty()).take(12).collect();
    let tail: Vec<&str> = tail.into_iter().rev().collect();
    vec![format!("The figure did not typeset. The end of TeX's log:\n{}", tail.join("\n"))]
}

/// Lines of the code that ran past the width, as TeX measured them.
fn overfull_lines(log: &str, source: &Source) -> Vec<String> {
    let overfull = Regex::new(
        r"(?m)^Overfull \\hbox \((\d+(?:\.\d+)?)pt too wide\) (?:in paragraph|detected) at lines? (\d+)",
    )
    .unwrap();
    let mut warnings = Vec::new();
    for found in overfull.captures_iter(log).take(10) {
        let line: u32 = found[2].parse().unwrap_or(0);
        let place = source.place(line);
        if !place.starts_with("code line") {
            continue;
        }
        let warning = format!(
            "{place}: {}pt wider than the line width, so it runs into the margin.",
            &found[1]
        );
        if !warnings.contains(&warning) {
            warnings.push(warning);
        }
    }
    warnings
}

/// A private folder for one preview, removed when it ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("lattice-figure-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn request(code: &str) -> FigurePreviewRequest {
        FigurePreviewRequest {
            code: code.to_string(),
            preamble: None,
            document: None,
            line_width: None,
        }
    }

    const PAPER: &str = "\\documentclass[11pt]{article}\n% \\begin{document} in a comment\n\\usepackage{tikz}\n\\newcommand{\\loss}{\\mathcal{L}}\n\\definecolor{accent}{RGB}{200,40,40}\n\\begin{document}\nBody.\n\\end{document}\n";

    fn project(main: &str) -> TempDir {
        let root = TempDir::new("figure-preview");
        project::write_manifest(&root, &project::default_manifest("paper")).unwrap();
        root.write("main.tex", main);
        root
    }

    #[test]
    fn only_a_figure_body_is_accepted_as_code() {
        assert!(validate(&request("\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}"))
            .is_ok());
        // A commented-out environment is not one.
        assert!(validate(&request("% \\begin{figure}\n\\draw (0,0) circle (1);")).is_ok());
        for (code, says) in [
            ("  ", "empty"),
            ("\\documentclass{article}", "not a whole document"),
            ("\\end{document}", "not a whole document"),
            ("\\usetikzlibrary{arrows.meta}", "move them from code to preamble"),
            ("\\begin{figure}[t]\\centering x\\end{figure}", "inside the figure environment"),
            ("\\begin{figure*}x\\end{figure*}", "inside the figure* environment"),
        ] {
            let error = validate(&request(code)).unwrap_err();
            assert!(error.contains(says), "{code}: {error}");
        }
        let long = request(&"x".repeat(MAX_CODE_BYTES + 1));
        assert!(validate(&long).unwrap_err().contains("KiB"));
    }

    #[test]
    fn the_width_is_a_length_or_a_multiple_of_the_paper_s_widths() {
        assert_eq!(line_width(None).unwrap(), "\\columnwidth");
        assert_eq!(line_width(Some(" ")).unwrap(), "\\columnwidth");
        for width in
            ["3.25in", "345pt", "8.5 cm", "\\textwidth", "0.48\\linewidth", ".5\\columnwidth"]
        {
            assert_eq!(line_width(Some(width)).unwrap(), width);
        }
        for width in ["wide", "3.25", "\\textwidth}\\input{x", "-1in", "\\hsize"] {
            assert!(line_width(Some(width)).is_err(), "{width}");
        }
    }

    #[test]
    fn the_preamble_ends_where_the_document_begins_and_keeps_its_lines() {
        let head = preamble(PAPER).unwrap();
        assert!(head.starts_with("\\documentclass[11pt]{article}\n"));
        assert!(head.ends_with("\\definecolor{accent}{RGB}{200,40,40}\n"), "{head}");
        // A file with no class, such as a chapter, has no preamble to use.
        assert_eq!(preamble("\\section{Intro}\n\\begin{document}\n"), None);
        assert_eq!(preamble("\\documentclass{article}\n"), None);
    }

    #[test]
    fn preamble_lines_the_paper_lacks_are_listed_for_it() {
        let extra = "\\usetikzlibrary{arrows.meta}\n\n\\usepackage{tikz} % again\n\\definecolor{accent}{RGB}{200,40,40}";
        assert_eq!(
            missing_lines(extra, preamble(PAPER).unwrap()),
            ["\\usetikzlibrary{arrows.meta}"]
        );
        assert_eq!(missing_lines("  \\usepackage{pgfplots}  ", ""), ["\\usepackage{pgfplots}"]);
    }

    #[test]
    fn a_line_of_the_generated_document_is_named_by_the_part_it_came_from() {
        let head = preamble(PAPER).unwrap();
        let source = Source::new(
            head,
            Some("main.tex"),
            "\\usetikzlibrary{calc}",
            "a\nb\nc\n",
            "\\columnwidth",
        );
        let lines: Vec<&str> = source.text.lines().collect();
        assert_eq!(lines[source.extra_line as usize - 1], "\\usetikzlibrary{calc}");
        assert_eq!(
            &lines[source.code_line as usize - 1..source.code_line as usize + 2],
            ["a", "b", "c"]
        );
        assert_eq!(source.place(3), "main.tex:3");
        assert_eq!(source.place(source.extra_line), "preamble line 1");
        assert_eq!(source.place(source.code_line + 2), "code line 3");
        assert_eq!(source.place(source.code_line + 3), "the figure's wrapper");
        let plain = Source::new(PLAIN_PREAMBLE, None, "", "a", "3in");
        assert_eq!(plain.place(1), "the figure's wrapper");
        assert!(plain.text.contains("\\begin{minipage}{3in}"));
    }

    #[test]
    fn errors_and_overfull_lines_are_placed_in_the_figure_s_code() {
        let source = Source::new(
            PLAIN_PREAMBLE,
            None,
            "",
            "\\begin{tikzpicture}\n\\draw (0,0) -- (1,\\x);\n\\end{tikzpicture}",
            "\\columnwidth",
        );
        let line = source.code_line + 1;
        let log = format!(
            "Overfull \\hbox (12.5pt too wide) in paragraph at lines {line}--{line}\n\
             ./lattice-figure.tex:{line}: Undefined control sequence.\n\
             <recently read> \\x \n\
             \n\
             l.{line} \\draw (0,0) -- (1,\\x\n\
             ./lattice-figure.tex:{line}: Emergency stop.\n\
             /Users/me/paper/macros.tex:4: LaTeX Error: Missing \\begin{{document}}.\n"
        );
        assert_eq!(
            located_errors(&log, &source),
            [
                "code line 2: Undefined control sequence. (at `\\draw (0,0) -- (1,\\x`)",
                "/Users/me/paper/macros.tex:4: LaTeX Error: Missing \\begin{document}.",
            ]
        );
        assert_eq!(
            overfull_lines(&log, &source),
            ["code line 2: 12.5pt wider than the line width, so it runs into the margin."]
        );
    }

    #[test]
    fn a_figure_outside_a_project_is_refused_before_tex_runs() {
        let root = project(PAPER);
        let mut asked = request("x");
        asked.document = Some("../elsewhere.tex".to_string());
        assert!(preview_figure(&root, &asked).is_err());
        asked.document = Some("notes.md".to_string());
        assert!(preview_figure(&root, &asked).unwrap_err().contains("not a LaTeX document"));
    }

    const TIKZ: &str = "\\centering\n\\begin{tikzpicture}\n\\draw[accent, thick] (0,0) -- (2,1) node[right] {$\\loss$};\n\\end{tikzpicture}";

    /// The one page's width and height, in points.
    fn page_size(pdf: &[u8]) -> (f32, f32) {
        let document = lopdf::Document::load_mem(pdf).unwrap();
        let pages = document.get_pages();
        assert_eq!(pages.len(), 1);
        let page = document.get_dictionary(pages[&1]).unwrap();
        let media = page.get(b"MediaBox").unwrap().as_array().unwrap();
        let number = |index: usize| media[index].as_float().unwrap();
        (number(2) - number(0), number(3) - number(1))
    }

    #[test]
    #[ignore = "requires pdfLaTeX with TikZ"]
    fn a_figure_is_typeset_with_the_paper_s_preamble_and_leaves_the_project_alone() {
        let root = project(PAPER);
        let before: Vec<_> =
            fs::read_dir(&*root).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        let mut asked = request(TIKZ);
        asked.preamble = Some("\\usetikzlibrary{arrows.meta}".to_string());
        let preview = preview_figure(&root, &asked).unwrap();
        assert!(preview.errors.is_empty(), "{:?}", preview.errors);
        assert_eq!(preview.preamble_from.as_deref(), Some("main.tex"));
        assert_eq!(preview.preamble_fallback, None);
        assert_eq!(preview.preamble_to_add, ["\\usetikzlibrary{arrows.meta}"]);
        assert_eq!(preview.engine, "pdflatex");
        let pdf = STANDARD.decode(preview.pdf.unwrap()).unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        // One column of an 11pt article (360pt), plus the margins; one page.
        let (width, height) = page_size(&pdf);
        assert!((width - 364.0).abs() < 1.5, "{width}");
        assert!(height > 20.0 && height < 120.0, "{height}");
        let after: Vec<_> =
            fs::read_dir(&*root).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(before, after);

        asked.line_width = Some("2in".to_string());
        let narrow = STANDARD.decode(preview_figure(&root, &asked).unwrap().pdf.unwrap()).unwrap();
        assert!((page_size(&narrow).0 - 148.54).abs() < 1.5);
    }

    #[test]
    #[ignore = "requires pdfLaTeX with TikZ"]
    fn errors_name_the_code_line_and_a_broken_preamble_falls_back_to_a_plain_article() {
        let root = project(PAPER);
        let broken =
            request("\\begin{tikzpicture}\n\\draw (0,0) -- \\nowhere;\n\\end{tikzpicture}");
        let preview = preview_figure(&root, &broken).unwrap();
        assert!(preview.pdf.is_none());
        assert!(
            preview.errors[0].starts_with("code line 2: Undefined control sequence"),
            "{:?}",
            preview.errors
        );

        let root = project(&PAPER.replace(
            "\\usepackage{tikz}",
            "\\usepackage{tikz}\n\\usepackage{no-such-package-here}",
        ));
        let mut asked = request("\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}");
        asked.preamble = Some("\\usepackage{tikz}".to_string());
        let preview = preview_figure(&root, &asked).unwrap();
        assert!(preview.pdf.is_some(), "{:?}", preview.errors);
        assert_eq!(preview.preamble_from, None);
        assert!(preview.preamble_fallback.unwrap().contains("no-such-package-here"));

        // The paper's macros are missing from a plain article, and the
        // preview says why it had to use one.
        let preview = preview_figure(&root, &request(TIKZ)).unwrap();
        assert!(preview.pdf.is_none());
        assert!(preview.errors[0].contains("did not typeset on its own"), "{:?}", preview.errors);
    }

    #[test]
    #[ignore = "requires pdfLaTeX"]
    fn a_runaway_figure_is_stopped_at_the_timeout() {
        let root = TempDir::new("figure-timeout");
        let source = Source::new(PLAIN_PREAMBLE, None, "", "\\def\\x{\\x}\\x", "\\columnwidth");
        let attempt = typeset("pdflatex", &root, &source, Duration::from_secs(2)).unwrap();
        assert!(attempt.timed_out && attempt.pdf.is_none());
        assert!(attempt.errors[0].contains("still typesetting after 2 seconds"));
    }
}
