//! Export for arXiv, checked first: the source pack a submission needs, made
//! from what the last build read rather than from everything in the folder.
//!
//! The pack is the files TeX read inside the project, from the build's
//! recorder file (`<root>.fls`): the root document, what it inputs, its
//! figures and classes, and the `.bbl` (arXiv does not run BibTeX). Anything
//! TeX also wrote (`.aux`, `.toc`, the PDF) is build output and stays behind;
//! `.research/` and `.git/` never go, whatever the build read. Then the
//! writer's options: `%` comments out, `\input` files merged into the root.
//!
//! The checks run on that pack before anything is written where the writer
//! can see it, the slow one last: the pack built alone, in a temporary
//! folder, the way arXiv will (pdfLaTeX's family, no shell escape, no
//! BibTeX). The export stages the pack again and refuses it when it no longer
//! matches the one checked, so what was checked is what ships.

mod source;

use super::build::{abort, run_tracked, ActiveBuild};
use super::build_log::{pages_written, parse_diagnostics, trim_log};
use super::{default_root_document, latexmk, BuildSteps};
use crate::{commands, project};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

/// arXiv's limit on a submission's files.
const SIZE_LIMIT_BYTES: u64 = 50_000_000;

/// How long the test build may take before it counts as stuck.
const COMPILE_TIME_LIMIT: Duration = Duration::from_secs(120);

/// How often the test build's watchdog looks for a newer check.
const CANCEL_POLL: Duration = Duration::from_millis(100);

/// Comment lines listed for review; the count covers them all.
const LISTED_COMMENTS: usize = 200;

/// Folders that never ship, whatever the build read: app state and VCS.
const PRIVATE_DIRS: &[&str] = &[".research", ".git"];

/// File endings of hand-written TeX sources, whose comments are the writer's
/// notes. Not `.sty`/`.cls` (venue templates), the `.bbl`, or EPS/PS figures,
/// whose `%` lines mean something.
const TEX_SOURCE_EXTENSIONS: &[&str] = &["tex", "tikz", "pgf", "ltx", "inc"];

/// File endings of the figures a paper includes.
const FIGURE_EXTENSIONS: &[&str] =
    &["pdf", "png", "jpg", "jpeg", "eps", "ps", "svg", "gif", "tif", "tiff", "mps"];

/// Endings left out of the "not in the package" list: build output nobody
/// would expect to ship, for files the recorder does not name as written.
const BUILD_OUTPUT_SUFFIXES: &[&str] = &[
    ".aux",
    ".log",
    ".blg",
    ".fdb_latexmk",
    ".fls",
    ".out",
    ".bcf",
    ".run.xml",
    ".toc",
    ".synctex.gz",
    ".synctex",
];

static BIBLIOGRAPHY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\(?:bibliography\s*\{|printbibliography\b)").unwrap());

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArxivOptions {
    pub strip_comments: bool,
    pub merge_inputs: bool,
}

/// What a check found: no pack without a build, else the pack and its checks.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArxivCheck {
    /// The root document has no recorder file: it was never built here.
    /// The enum's `rename_all` renames variants only, not their fields.
    #[serde(rename_all = "camelCase")]
    Unbuilt {
        root_document: String,
    },
    Package(Box<ArxivPackage>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArxivPackage {
    pub root_document: String,
    /// Every file in the pack, by path, with its size.
    pub files: Vec<PackageFile>,
    pub total_bytes: u64,
    pub size_limit_bytes: u64,
    /// What the project has that the pack leaves out: a folder (`slides/`)
    /// when none of it ships, else the files.
    pub left_out: Vec<String>,
    pub figures: Vec<String>,
    /// Files the last build read that are gone now.
    pub missing: Vec<String>,
    pub bibliography: Bibliography,
    pub comments: Comments,
    /// Files merged into the root document, which no longer ship alone.
    pub merged: Vec<String>,
    /// The project's engine, as its manifest names it.
    pub engine: String,
    /// The pack's fingerprint, which the export must match.
    pub digest: String,
    /// The test build; absent until it has run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compile: Option<CompileCheck>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFile {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Bibliography {
    /// The `.bbl` from the last build ships.
    Included { file: String },
    /// The paper cites nothing.
    None,
    /// The paper has a bibliography but no `.bbl` was built for it.
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comments {
    /// Whether the pack has them taken out (the option), else they ship.
    pub removed: bool,
    pub count: usize,
    pub todos: usize,
    /// The comments themselves, TODOs first, up to [`LISTED_COMMENTS`].
    pub lines: Vec<CommentLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentLine {
    pub file: String,
    pub line: u32,
    pub text: String,
    pub todo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileCheck {
    pub outcome: CompileOutcome,
    pub pages: Option<u32>,
    pub duration_ms: u64,
    /// The first error, for a build that failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CompileError>,
    /// The trimmed log, for a build that did not succeed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompileOutcome {
    Ok,
    Failed,
    TimedOut,
    /// A newer check, or the sheet closing, stopped it.
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileError {
    pub message: String,
    pub file: Option<String>,
    pub line: Option<u32>,
}

/// One project's arXiv checks: the latest one's number, and its test build.
/// A new check (or closing the sheet) stops the one before; the lock lets
/// the stopped build exit before the next starts in its place.
#[derive(Default)]
pub struct ArxivChecks {
    latest: AtomicU64,
    build: ActiveBuild,
    turn: Mutex<()>,
}

impl ArxivChecks {
    /// Stop the check under way, if any.
    pub fn cancel(&self) {
        self.begin();
    }

    /// Stop the check under way, and number a new one.
    fn begin(&self) -> u64 {
        let check = self.latest.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = abort(&self.build);
        check
    }

    fn current(&self, check: u64) -> bool {
        self.latest.load(Ordering::SeqCst) == check
    }
}

/// The pack, staged in memory.
struct Staged {
    root_document: String,
    files: BTreeMap<String, Vec<u8>>,
    figures: Vec<String>,
    missing: Vec<String>,
    bibliography: Bibliography,
    comments: Comments,
    merged: Vec<String>,
    left_out: Vec<String>,
    engine: String,
    digest: String,
}

impl Staged {
    fn package(&self) -> ArxivPackage {
        let files: Vec<PackageFile> = (self.files.iter())
            .map(|(path, bytes)| PackageFile { path: path.clone(), bytes: bytes.len() as u64 })
            .collect();
        ArxivPackage {
            root_document: self.root_document.clone(),
            total_bytes: files.iter().map(|file| file.bytes).sum(),
            files,
            size_limit_bytes: SIZE_LIMIT_BYTES,
            left_out: self.left_out.clone(),
            figures: self.figures.clone(),
            missing: self.missing.clone(),
            bibliography: self.bibliography.clone(),
            comments: self.comments.clone(),
            merged: self.merged.clone(),
            engine: self.engine.clone(),
            digest: self.digest.clone(),
            compile: None,
        }
    }
}

/// Stage the pack, report it through `staged`, then build it alone.
pub fn check(
    root: &Path, options: ArxivOptions, checks: &ArxivChecks, staged: impl Fn(&ArxivCheck),
) -> Result<ArxivCheck, String> {
    let check = checks.begin();
    let _turn = checks.turn.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(pack) = stage(root, options)? else {
        let manifest = project::read_manifest(root)?;
        let root_document = default_root_document(&manifest)?.path.clone();
        return Ok(ArxivCheck::Unbuilt { root_document });
    };
    let mut package = pack.package();
    staged(&ArxivCheck::Package(Box::new(package.clone())));
    package.compile = Some(if checks.current(check) {
        test_build(&pack, checks, check)?
    } else {
        CompileCheck::cancelled()
    });
    Ok(ArxivCheck::Package(Box::new(package)))
}

/// Stage the pack again and write it to `zip_path`, provided it is still
/// the pack whose checks had `digest`.
pub fn export(
    root: &Path, options: ArxivOptions, digest: &str, zip_path: &Path,
) -> Result<(), String> {
    let pack = stage(root, options)?
        .ok_or_else(|| "Build the paper before exporting it for arXiv.".to_string())?;
    if pack.digest != digest {
        return Err(
            "The paper changed after it was checked. Check it again, then export.".to_string()
        );
    }
    write_zip(&pack.files, zip_path)
        .map_err(|error| format!("Could not create the ZIP archive: {error}"))
}

/// The pack for the project's root document, or `None` before its first build.
fn stage(root: &Path, options: ArxivOptions) -> Result<Option<Staged>, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let manifest = project::read_manifest(&root)?;
    let document = default_root_document(&manifest)?;
    let root_path = project::safe_path(&root, &document.path)?;
    let Ok(recorder) = fs::read_to_string(root_path.with_extension("fls")) else {
        return Ok(None);
    };
    let Recorded { read, missing, written } = recorded_inputs(&root, &recorder);
    let mut files = BTreeMap::new();
    for path in &read {
        let bytes =
            fs::read(root.join(path)).map_err(|error| format!("Could not read {path}: {error}"))?;
        files.insert(path.clone(), bytes);
    }

    // Comments and merging work on text; a file in another encoding ships as is.
    let mut texts: BTreeMap<String, String> = BTreeMap::new();
    let mut comments = Vec::new();
    let mut cites = false;
    for (path, bytes) in &files {
        if !has_extension(path, TEX_SOURCE_EXTENSIONS) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(bytes) else { continue };
        let stripped = source::strip_comments(text);
        cites |= source::code_matches(&stripped.text, &BIBLIOGRAPHY);
        comments.extend(stripped.comments.into_iter().map(|comment| CommentLine {
            file: path.clone(),
            line: comment.line,
            text: comment.text,
            todo: comment.todo,
        }));
        let text = if options.strip_comments { stripped.text } else { text.to_string() };
        texts.insert(path.clone(), text);
    }
    let mut merged = BTreeSet::new();
    if options.merge_inputs && texts.contains_key(&document.path) {
        let (text, inlined) = source::merge_inputs(&document.path, &texts);
        texts.insert(document.path.clone(), text);
        merged = inlined;
    }
    for (path, text) in texts {
        if merged.contains(&path) {
            files.remove(&path);
        } else {
            files.insert(path, text.into_bytes());
        }
    }

    let bibliography = match files.keys().find(|path| path.ends_with(".bbl")) {
        Some(file) => Bibliography::Included { file: file.clone() },
        None if cites => Bibliography::Missing,
        None => Bibliography::None,
    };
    let figures = files.keys().filter(|path| has_extension(path, FIGURE_EXTENSIONS)).cloned();
    let left_out = left_out(&root, &files, &merged, &written, &root_path);
    Ok(Some(Staged {
        root_document: document.path.clone(),
        figures: figures.collect(),
        missing,
        bibliography,
        comments: comment_summary(comments, options.strip_comments),
        merged: merged.into_iter().collect(),
        left_out,
        engine: manifest.engine.clone(),
        digest: digest(&files),
        files,
    }))
}

/// What the recorder names inside the project, by project-relative path.
struct Recorded {
    /// Files TeX read and did not write, still there.
    read: Vec<String>,
    /// Files TeX read that are gone now.
    missing: Vec<String>,
    /// Files TeX wrote.
    written: BTreeSet<String>,
}

/// The project files TeX read, those of them now gone, and those it wrote.
///
/// The recorder names each file TeX opened, as `INPUT` or `OUTPUT`, relative
/// to its `PWD` line unless absolute. A file TeX wrote is build output even
/// when it was read back; a file outside the project is the TeX distribution's.
fn recorded_inputs(root: &Path, recorder: &str) -> Recorded {
    let mut cwd = root.to_path_buf();
    let mut inputs = BTreeSet::new();
    let mut outputs = BTreeSet::new();
    for line in recorder.lines() {
        if let Some(path) = line.strip_prefix("PWD ") {
            cwd = Path::new(path).canonicalize().unwrap_or_else(|_| PathBuf::from(path));
        } else if let Some(path) = line.strip_prefix("INPUT ") {
            inputs.extend(project_relative(root, &cwd, path));
        } else if let Some(path) = line.strip_prefix("OUTPUT ") {
            outputs.extend(project_relative(root, &cwd, path));
        }
    }
    let (read, missing) = inputs
        .into_iter()
        .filter(|path| !outputs.contains(path) && !private(path))
        .partition(|path| root.join(path).is_file());
    Recorded { read, missing, written: outputs }
}

/// The project files the root document's last compile wrote, by its
/// recorder; none before the first one.
pub(super) fn written_by_build(root: &Path, document: &str) -> Vec<String> {
    let Ok(root) = root.canonicalize() else { return Vec::new() };
    let Ok(document) = project::safe_path(&root, document) else { return Vec::new() };
    let Ok(recorder) = fs::read_to_string(document.with_extension("fls")) else {
        return Vec::new();
    };
    recorded_inputs(&root, &recorder).written.into_iter().collect()
}

/// `path` from the recorder as a `/`-separated path inside `root`, if it is one.
fn project_relative(root: &Path, cwd: &Path, path: &str) -> Option<String> {
    let path = cwd.join(path);
    // Lexically first: a file deleted since the build no longer canonicalizes.
    let path = path.canonicalize().unwrap_or_else(|_| normalize(&path));
    let relative = path.strip_prefix(root).ok()?;
    let parts: Option<Vec<&str>> = relative
        .components()
        .map(|part| match part {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();
    let parts = parts.filter(|parts| !parts.is_empty())?;
    Some(parts.join("/"))
}

fn normalize(path: &Path) -> PathBuf {
    let mut normal = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normal.pop();
            }
            other => normal.push(other),
        }
    }
    normal
}

fn private(path: &str) -> bool {
    let top = path.split('/').next().unwrap_or(path);
    PRIVATE_DIRS.contains(&top)
}

fn has_extension(path: &str, extensions: &[&str]) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extensions.contains(&extension.to_ascii_lowercase().as_str()))
}

/// The project's visible files outside the pack: a top-level folder by name
/// when none of it ships, else file by file. Hidden entries, build output and
/// files merged into the root document are not listed.
fn left_out(
    root: &Path, files: &BTreeMap<String, Vec<u8>>, merged: &BTreeSet<String>,
    written: &BTreeSet<String>, root_path: &Path,
) -> Vec<String> {
    let shipped_dirs: BTreeSet<&str> =
        files.keys().filter_map(|path| path.split_once('/')).map(|(dir, _)| dir).collect();
    let root_pdf = root_path.with_extension("pdf");
    let mut listed = BTreeSet::new();
    let walk = WalkDir::new(root).min_depth(1).sort_by_file_name().into_iter();
    for entry in walk.filter_entry(|entry| !entry.file_name().to_string_lossy().starts_with('.')) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() || entry.path() == root_pdf {
            continue;
        }
        let Some(path) = entry.path().strip_prefix(root).ok().and_then(Path::to_str) else {
            continue;
        };
        if files.contains_key(path)
            || merged.contains(path)
            || written.contains(path)
            || BUILD_OUTPUT_SUFFIXES.iter().any(|suffix| path.ends_with(suffix))
        {
            continue;
        }
        match path.split_once('/') {
            Some((dir, _)) if !shipped_dirs.contains(dir) => listed.insert(format!("{dir}/")),
            _ => listed.insert(path.to_string()),
        };
    }
    listed.into_iter().collect()
}

fn comment_summary(mut lines: Vec<CommentLine>, removed: bool) -> Comments {
    let todos = lines.iter().filter(|line| line.todo).count();
    let count = lines.len();
    lines.sort_by_key(|line| !line.todo);
    lines.truncate(LISTED_COMMENTS);
    Comments { removed, count, todos, lines }
}

fn digest(files: &BTreeMap<String, Vec<u8>>) -> String {
    let mut hash = Sha256::new();
    for (path, bytes) in files {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A temporary folder, removed with everything in it when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let path =
            std::env::temp_dir().join(format!("lattice-arxiv-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Build the pack in a folder of its own, as arXiv will: no shell escape,
/// no BibTeX (the `.bbl` ships instead), and a time limit.
fn test_build(pack: &Staged, checks: &ArxivChecks, check: u64) -> Result<CompileCheck, String> {
    let scratch = Scratch::new()?;
    for (path, bytes) in &pack.files {
        let target = scratch.0.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&target, bytes).map_err(|error| error.to_string())?;
    }
    let mut command = latexmk(&scratch.0);
    command.args([
        "-interaction=nonstopmode",
        "-file-line-error",
        "-halt-on-error",
        "-no-shell-escape",
        "-bibtex-",
        project::latexmk_engine_arg(&pack.engine),
        &pack.root_document,
    ]);
    let started = Instant::now();
    // A watchdog stops a build past the limit, or once a newer check (or the
    // sheet closing) has made this one stale. It keeps looking until the build
    // ends, so a cancel that landed before latexmk started still stops it, as
    // `abort` only reaches a registered build. Dropping `done` releases it.
    let (done, finished) = mpsc::channel::<()>();
    let timed_out = AtomicBool::new(false);
    let steps = BuildSteps::new(|_, _| {});
    let ran = std::thread::scope(|scope| {
        let timed_out = &timed_out;
        scope.spawn(move || {
            while finished.recv_timeout(CANCEL_POLL) == Err(mpsc::RecvTimeoutError::Timeout) {
                if started.elapsed() >= COMPILE_TIME_LIMIT {
                    timed_out.store(true, Ordering::SeqCst);
                    let _ = abort(&checks.build);
                    return;
                }
                if !checks.current(check) {
                    let _ = abort(&checks.build);
                }
            }
        });
        let ran = run_tracked(
            command,
            &checks.build,
            &steps,
            "Could not start latexmk. Install MacTeX or TeX Live. ",
            "latexmk exited unexpectedly: ",
        );
        drop(done);
        ran
    });
    let (output, stopped) = ran?;
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    if stopped {
        let mut result = CompileCheck::cancelled();
        result.duration_ms = duration_ms;
        if timed_out.load(Ordering::SeqCst) && checks.current(check) {
            result.outcome = CompileOutcome::TimedOut;
        }
        return Ok(result);
    }
    let log = commands::combined_output(&output);
    let built = scratch.0.join(&pack.root_document);
    let tex_log = fs::read_to_string(built.with_extension("log")).unwrap_or_default();
    if output.status.success() && built.with_extension("pdf").is_file() {
        return Ok(CompileCheck {
            outcome: CompileOutcome::Ok,
            pages: pages_written(&tex_log),
            duration_ms,
            error: None,
            log: None,
        });
    }
    let error = parse_diagnostics(&log).into_iter().find(|diagnostic| diagnostic.level == "error");
    Ok(CompileCheck {
        outcome: CompileOutcome::Failed,
        pages: None,
        duration_ms,
        error: error.map(|diagnostic| CompileError {
            message: diagnostic.message,
            file: diagnostic.file,
            line: diagnostic.line,
        }),
        log: Some(trim_log(&log)),
    })
}

impl CompileCheck {
    fn cancelled() -> Self {
        Self {
            outcome: CompileOutcome::Cancelled,
            pages: None,
            duration_ms: 0,
            error: None,
            log: None,
        }
    }
}

/// Write `files` to `zip_path` through a sibling temporary file, so a failed
/// export leaves nothing half-written in the writer's folder.
fn write_zip(files: &BTreeMap<String, Vec<u8>>, zip_path: &Path) -> Result<(), String> {
    let file_name = zip_path.file_name().ok_or("Choose where to save the ZIP archive.")?;
    if let Some(parent) = zip_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let partial = zip_path.with_file_name(format!(".{}.partial", file_name.to_string_lossy()));
    let written = (|| -> Result<(), String> {
        let mut writer = ZipWriter::new(File::create(&partial).map_err(|error| error.to_string())?);
        let options = SimpleFileOptions::default()
            .unix_permissions(0o644)
            .last_modified_time(project::zip_time(Some(SystemTime::now())));
        for (path, bytes) in files {
            writer.start_file(path.as_str(), options).map_err(|error| error.to_string())?;
            writer.write_all(bytes).map_err(|error| error.to_string())?;
        }
        writer.finish().map_err(|error| error.to_string())?;
        fs::rename(&partial, zip_path).map_err(|error| error.to_string())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&partial);
    }
    written
}

#[cfg(test)]
mod tests;
