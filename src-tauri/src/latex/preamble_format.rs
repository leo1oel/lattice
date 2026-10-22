//! A per-project pdfLaTeX format that already holds the document's preamble.
//!
//! mylatexformat dumps everything before `\begin{document}` into a format
//! file; a pdfLaTeX pass started from that format skips the preamble it
//! already holds instead of loading every package again. That is most of a
//! pass for a short paper: on the bundled conference templates a warm rebuild
//! drops from about 0.33 s to 0.19 s, and every pass of a cold build gains
//! the same, so building the format first still comes out ahead.
//!
//! The format is only a cache, and the PDF and SyncTeX it builds must be the
//! ones the plain build writes. So it is keyed on everything that went into
//! it — the engine binary, the preamble text, every file the preamble read
//! (the TeX distribution's own base format among them), the files a package
//! lookup could newly find in the project folder, and the day, for a preamble
//! that captures `\today` — and rebuilt when any of that changes. A project
//! whose build it could alter never uses it (see `eligible` and `verdict`),
//! and a build that fails with it is built again without it.
//!
//! pdfLaTeX only: XeTeX refuses to dump a format once a native font is
//! loaded, and the LaTeX kernel loads Latin Modern OpenType in every
//! preamble, so a XeLaTeX format cannot be made at all.

use super::build::{run_tracked, ActiveBuild};
use super::build_steps::BuildSteps;
use crate::models::ProjectManifest;
use crate::util::sha256_hex;
use crate::{commands, project, wide_event};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Bump when the key or the way the format is built changes, so every format
/// made by an older Lattice is rebuilt rather than trusted.
const VERSION: u32 = 1;
/// The format's job name, so its files are `preamble.fmt`, `.log`, `.fls`.
const JOB: &str = "preamble";
/// The build step that makes the format, as the Build card names it.
pub(super) const STEP: &str = "pdflatex -ini";
/// A project not built for this long has its format removed.
const UNUSED_FOR: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// Extensions of the project-folder files a package lookup in the preamble
/// could pick up. A new one can shadow a distribution file the format holds.
const LOOKUP_EXTENSIONS: &[&str] = &["cfg", "clo", "cls", "def", "fd", "ldf", "ltx", "sty", "tex"];

/// A ready format, and what loading the preamble printed when it was made:
/// a build from the format never prints it again, but the build result's
/// warnings, venue and font checks read it.
pub(super) struct PreambleFormat {
    directory: PathBuf,
    /// pdfLaTeX's terminal output while it loaded the preamble.
    pub output: String,
    /// The TeX log of the same run.
    pub log: String,
}

impl PreambleFormat {
    /// The latexmk option that runs every pdfLaTeX pass from this format.
    /// latexmk hands the command to the shell, so the path is quoted.
    pub fn latexmk_arg(&self) -> String {
        let format = self.directory.join(JOB);
        format!("-pdflatex=pdflatex -fmt='{}' %O %S", format.display())
    }

    /// This format could not build the document the plain build could:
    /// never use it again for the same inputs.
    pub fn reject(&self) {
        if let Some(mut record) = Record::read(&self.directory) {
            record.usable = false;
            record.write(&self.directory);
        }
        let _ = fs::remove_file(self.directory.join(format!("{JOB}.fmt")));
    }
}

pub(super) enum Prepared {
    Ready(PreambleFormat),
    /// Build the project the plain way.
    Plain,
    /// The user stopped the build while the format was being made; the
    /// output so far.
    Cancelled(String),
}

/// What is on disk beside a format: the key it was made from, and whether
/// it may be used.
#[derive(Serialize, Deserialize)]
struct Record {
    version: u32,
    /// Everything known before the format is built; see `head`.
    head: String,
    /// Every file the preamble read, as it was then.
    inputs: Vec<Input>,
    usable: bool,
}

#[derive(Serialize, Deserialize, PartialEq, Eq, Debug)]
struct Input {
    path: PathBuf,
    fingerprint: String,
}

impl Record {
    fn path(directory: &Path) -> PathBuf {
        directory.join("record.json")
    }

    fn read(directory: &Path) -> Option<Self> {
        let record: Self = serde_json::from_slice(&fs::read(Self::path(directory)).ok()?).ok()?;
        (record.version == VERSION).then_some(record)
    }

    fn write(&self, directory: &Path) {
        if let Ok(json) = serde_json::to_vec(self) {
            let _ = fs::write(Self::path(directory), json);
        }
    }

    fn current(&self, head: &str, project: &Path) -> bool {
        self.head == head
            && self
                .inputs
                .iter()
                .all(|input| fingerprint(&input.path, project) == input.fingerprint)
    }
}

/// Whether the project's build is one a format cannot change.
///
/// A latexmkrc may run anything with any engine; a trusted project may run
/// shell commands, whose effects the format would freeze; a root below the
/// project folder is outside what this was measured on. A user's Clean
/// rebuild discards the format before it gets here (`discard`).
fn eligible(root: &Path, manifest: &ProjectManifest, document_path: &str) -> bool {
    project::latexmk_engine_arg(&manifest.engine) == "-pdf"
        && !manifest.trusted
        && !project::has_latexmkrc(root)
        && Path::new(document_path).components().count() == 1
}

/// The preamble a format can stand in for: the text before the line that
/// starts the document. `None` when a format would read the file differently
/// from TeX.
///
/// The format skips the preamble by scanning raw lines for the first one that
/// has `\begin` followed by `document`, or `\endofdump`, comments included,
/// and runs that whole line. It must be the line TeX itself starts the
/// document on, and start with `\begin{document}`, or the two disagree on
/// where the preamble ends. A `%&` first line picks its own format, and
/// `\DocumentMetadata` sets up PDF output before the class: both stay plain.
fn preamble(source: &[u8]) -> Option<&[u8]> {
    let text = std::str::from_utf8(source).ok()?;
    if text.starts_with("%&") || text.contains("\\DocumentMetadata") {
        return None;
    }
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let after_begin = line.find("\\begin").map(|at| &line[at..]);
        if line.contains("endofdump") || after_begin.is_some_and(|rest| rest.contains("document")) {
            return line.trim_start().starts_with("\\begin{document}").then(|| &source[..offset]);
        }
        offset += line.len();
    }
    None
}

/// The key's parts that are known before the format is built.
fn head(preamble: &[u8], root: &Path) -> String {
    let engine = commands::resolve("pdflatex");
    let mut lookups: Vec<String> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            Path::new(name).extension().and_then(|extension| extension.to_str()).is_some_and(
                |extension| LOOKUP_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()),
            )
        })
        .collect();
    lookups.sort();
    let mut key = format!(
        "v{VERSION}\nengine {} {}\nday {}\nlookups {}\n",
        engine.display(),
        stat(&engine),
        chrono::Local::now().date_naive(),
        lookups.join("/"),
    )
    .into_bytes();
    key.extend_from_slice(preamble);
    sha256_hex(key)
}

/// A file as it is now: its contents inside the project, which the user edits
/// without regard to timestamps; its size and modification time elsewhere,
/// which is how a TeX Live update shows and costs a stat, not a read.
fn fingerprint(path: &Path, project: &Path) -> String {
    if path.starts_with(project) {
        fs::read(path).map_or_else(|_| "missing".to_string(), sha256_hex)
    } else {
        stat(path)
    }
}

fn stat(path: &Path) -> String {
    let Ok(metadata) = fs::metadata(path) else { return "missing".to_string() };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    format!("{} {modified}", metadata.len())
}

/// The `.fls` recorder's view of a run: the files it read and wrote, with
/// relative paths resolved against the directory it ran in.
struct Recorded {
    inputs: Vec<PathBuf>,
    outputs: Vec<PathBuf>,
}

fn recorded(fls: &str) -> Recorded {
    let mut working = PathBuf::new();
    let mut recorded = Recorded { inputs: Vec::new(), outputs: Vec::new() };
    for line in fls.lines() {
        if let Some(directory) = line.strip_prefix("PWD ") {
            working = PathBuf::from(directory);
            continue;
        }
        let (list, path) = if let Some(path) = line.strip_prefix("INPUT ") {
            (&mut recorded.inputs, path)
        } else if let Some(path) = line.strip_prefix("OUTPUT ") {
            (&mut recorded.outputs, path)
        } else {
            continue;
        };
        let path: PathBuf = working
            .join(path)
            .components()
            .filter(|component| *component != Component::CurDir)
            .collect();
        if !list.contains(&path) {
            list.push(path);
        }
    }
    recorded
}

/// Whether a format that built may be used, from what its run touched.
///
/// It may not when the preamble wrote a file — mylatexformat replays a plain
/// `\openout` at `\begin{document}`, but anything else written then would be
/// missing from every build — or read one of the document's own build
/// outputs, which change every build, or loaded biblatex, whose Biber
/// pipeline is left to the plain build.
fn verdict(
    recorded: &Recorded, directory: &Path, root_document: &Path,
) -> Result<(), &'static str> {
    let own = |extension: &str| directory.join(format!("{JOB}.{extension}"));
    if recorded.outputs.iter().any(|path| *path != own("fmt") && *path != own("log")) {
        return Err("writes_files");
    }
    let stem = root_document.file_stem();
    let parent = root_document.parent();
    if recorded
        .inputs
        .iter()
        .any(|path| path != root_document && path.parent() == parent && path.file_stem() == stem)
    {
        return Err("reads_build_output");
    }
    if recorded
        .inputs
        .iter()
        .any(|path| path.file_name().is_some_and(|name| name == "biblatex.sty"))
    {
        return Err("biblatex");
    }
    Ok(())
}

/// Where this project's format lives, in Lattice's cache rather than the
/// project, which may be synced to Overleaf or committed.
fn directory(root: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let name = sha256_hex(root.as_os_str().as_encoded_bytes());
    Some(formats_directory().join(&name[..16]))
}

#[cfg(not(test))]
fn formats_directory() -> PathBuf {
    commands::app_cache_dir("preamble-formats", "/tmp/research-writer-preamble-formats")
}

/// Tests that build keep their formats out of the user's cache.
#[cfg(test)]
fn formats_directory() -> PathBuf {
    std::env::temp_dir().join("lattice-test-preamble-formats")
}

/// The project's format file, for tests that spoil it.
#[cfg(test)]
pub(super) fn format_file(root: &Path) -> Option<PathBuf> {
    Some(directory(root)?.join(format!("{JOB}.fmt")))
}

/// Forget the project's format, for a Clean rebuild.
pub(super) fn discard(root: &Path) {
    if let Some(directory) = directory(root) {
        let _ = fs::remove_dir_all(directory);
    }
}

/// The project's format, made first when it is missing or out of date, or
/// `Plain` when this project builds without one.
pub(super) fn prepare(
    root: &Path, manifest: &ProjectManifest, document_path: &str, root_document: &Path,
    active: &ActiveBuild, steps: &BuildSteps,
) -> Prepared {
    if !eligible(root, manifest, document_path) {
        return Prepared::Plain;
    }
    let (Ok(project), Ok(root_document)) = (root.canonicalize(), root_document.canonicalize())
    else {
        return Prepared::Plain;
    };
    let Some(directory) = directory(&project) else { return Prepared::Plain };
    prepare_in(&directory, &project, document_path, &root_document, active, steps)
}

fn prepare_in(
    directory: &Path, project: &Path, document_path: &str, root_document: &Path,
    active: &ActiveBuild, steps: &BuildSteps,
) -> Prepared {
    let Ok(source) = fs::read(root_document) else { return Prepared::Plain };
    let Some(preamble) = preamble(&source) else {
        wide_event::record("preamble_format", "unsupported");
        return Prepared::Plain;
    };
    let head = head(preamble, project);
    if let Some(record) = Record::read(directory).filter(|record| record.current(&head, project)) {
        wide_event::record("preamble_format", if record.usable { "reused" } else { "declined" });
        return if record.usable { ready(directory) } else { Prepared::Plain };
    }
    if !commands::available("pdflatex") {
        return Prepared::Plain;
    }
    let _ = fs::remove_dir_all(directory);
    if fs::create_dir_all(directory).is_err() {
        return Prepared::Plain;
    }
    prune(directory);

    let step = wide_event::step("preamble_format");
    let mut pdflatex = commands::command("pdflatex");
    super::unwrapped_log(&mut pdflatex).current_dir(project).args([
        "-ini",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        "-no-shell-escape",
        "-recorder",
    ]);
    pdflatex
        .arg(format!("-output-directory={}", directory.display()))
        .arg(format!("-jobname={JOB}"))
        .args(["&pdflatex", "mylatexformat.ltx", document_path]);
    steps.begin(STEP, false);
    let ran = run_tracked(
        pdflatex,
        active,
        steps,
        "Could not start pdfLaTeX for the preamble format: ",
        "pdfLaTeX stopped unexpectedly while making the preamble format: ",
    );
    drop(step);
    let Ok((output, cancelled)) = ran else {
        let _ = fs::remove_dir_all(directory);
        return Prepared::Plain;
    };
    let succeeded = output.status.success();
    let output = commands::combined_output(&output);
    if cancelled {
        let _ = fs::remove_dir_all(directory);
        return Prepared::Cancelled(output);
    }
    let fls = fs::read_to_string(directory.join(format!("{JOB}.fls"))).unwrap_or_default();
    let recorded = recorded(&fls);
    // pdfTeX writes a format even when it refuses part of the dump, so only
    // a run that exited cleanly counts.
    let built = succeeded && directory.join(format!("{JOB}.fmt")).is_file();
    let verdict = if built { verdict(&recorded, directory, root_document) } else { Err("failed") };
    wide_event::record("preamble_format", verdict.err().unwrap_or("built"));
    let inputs = recorded
        .inputs
        .into_iter()
        .filter(|path| path != root_document)
        .map(|path| Input { fingerprint: fingerprint(&path, project), path })
        .collect();
    Record { version: VERSION, head, inputs, usable: verdict.is_ok() }.write(directory);
    if verdict.is_err() {
        let _ = fs::remove_file(directory.join(format!("{JOB}.fmt")));
        return Prepared::Plain;
    }
    let _ = fs::write(directory.join(format!("{JOB}.out")), &output);
    ready(directory)
}

fn ready(directory: &Path) -> Prepared {
    let read = |extension: &str| fs::read_to_string(directory.join(format!("{JOB}.{extension}")));
    match (directory.join(format!("{JOB}.fmt")).is_file(), read("out"), read("log")) {
        (true, Ok(output), Ok(log)) => {
            Prepared::Ready(PreambleFormat { directory: directory.to_path_buf(), output, log })
        }
        _ => Prepared::Plain,
    }
}

/// Remove the formats of projects not built for a while: each is a few MiB.
/// The day is part of the key, so a project in use rewrites its directory at
/// least daily; another project's format being made right now is fresh too.
fn prune(keep: &Path) {
    let Ok(entries) = fs::read_dir(formats_directory()) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let stale = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .map_or(true, |modified| now.duration_since(modified).unwrap_or_default() > UNUSED_FOR);
        if path != keep && stale {
            let _ = fs::remove_dir_all(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn the_preamble_ends_where_tex_and_the_format_both_start_the_document() {
        let source = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nHi\n";
        let expected = "\\documentclass{article}\n\\usepackage{amsmath}\n";
        assert_eq!(preamble(source.as_bytes()), Some(expected.as_bytes()));
        let indented = "\\documentclass{article}\n  \\begin{document} Hi\n";
        assert_eq!(preamble(indented.as_bytes()), Some("\\documentclass{article}\n".as_bytes()));

        for declined in [
            // The format's line scan stops at a comment TeX never runs.
            "\\documentclass{article}\n% \\begin{document} later\n\\begin{document}\n",
            "\\documentclass{article}\n\\newcommand\\x{\\begin{center}document}\n\\begin{document}\n",
            // It would run the whole line again, the package with it.
            "\\documentclass{article}\n\\usepackage{x}\\begin{document}\n",
            "\\documentclass{article}\n\\endofdump\n\\begin{document}\n",
            "%&custom\n\\documentclass{article}\n\\begin{document}\n",
            "\\DocumentMetadata{}\n\\documentclass{article}\n\\begin{document}\n",
            "\\documentclass{article}\n\\input{body}\n",
        ] {
            assert_eq!(preamble(declined.as_bytes()), None, "{declined}");
        }
    }

    #[test]
    fn only_untrusted_top_level_pdflatex_projects_without_an_rc_file_are_eligible() {
        let root = TempDir::new("preamble-format");
        let manifest = project::default_manifest("paper");
        assert!(eligible(&root, &manifest, "main.tex"));
        assert!(!eligible(&root, &manifest, "paper/main.tex"));
        for engine in ["xelatex", "lualatex"] {
            let other = ProjectManifest { engine: engine.to_string(), ..manifest.clone() };
            assert!(!eligible(&root, &other, "main.tex"), "{engine}");
        }
        let trusted = ProjectManifest { trusted: true, ..manifest.clone() };
        assert!(!eligible(&root, &trusted, "main.tex"));
        root.write(".latexmkrc", "$pdf_mode = 1;\n");
        assert!(!eligible(&root, &manifest, "main.tex"));
    }

    #[test]
    fn the_recorder_list_resolves_paths_against_the_directory_it_ran_in() {
        let fls = "PWD /p\nINPUT /tex/article.cls\nINPUT ./macros.sty\nINPUT macros.sty\n\
            OUTPUT /cache/preamble.log\nINPUT /tex/article.cls\nOUTPUT /cache/preamble.fmt\n";
        let recorded = recorded(fls);
        let paths =
            |list: &[PathBuf]| list.iter().map(|p| p.display().to_string()).collect::<Vec<_>>();
        assert_eq!(paths(&recorded.inputs), ["/tex/article.cls", "/p/macros.sty"]);
        assert_eq!(paths(&recorded.outputs), ["/cache/preamble.log", "/cache/preamble.fmt"]);
    }

    #[test]
    fn a_format_whose_preamble_writes_reads_its_build_output_or_loads_biblatex_is_declined() {
        let cache = Path::new("/cache");
        let main = Path::new("/p/main.tex");
        let run = |inputs: &[&str], outputs: &[&str]| {
            let list = |paths: &[&str]| paths.iter().map(PathBuf::from).collect();
            verdict(&Recorded { inputs: list(inputs), outputs: list(outputs) }, cache, main)
        };
        let own = ["/cache/preamble.fmt", "/cache/preamble.log"];
        assert_eq!(run(&["/p/main.tex", "/p/macros.sty", "/tex/article.cls"], &own), Ok(()));
        assert_eq!(run(&[], &["/cache/preamble.log", "/p/main.idx"]), Err("writes_files"));
        assert_eq!(run(&["/p/main.tex", "/p/main.aux"], &own), Err("reads_build_output"));
        assert_eq!(run(&["/tex/biblatex/biblatex.sty"], &own), Err("biblatex"));
    }

    #[test]
    fn a_record_is_current_until_a_project_file_it_read_changes() {
        let root = TempDir::new("preamble-format");
        let macros = root.write("macros.sty", "\\def\\x{1}");
        let input = Input { fingerprint: fingerprint(&macros, &root), path: macros.clone() };
        let record =
            Record { version: VERSION, head: "h".into(), inputs: vec![input], usable: true };
        assert!(record.current("h", &root));
        assert!(!record.current("other", &root));
        // Same size, same second: only the contents tell.
        fs::write(&macros, "\\def\\x{2}").unwrap();
        assert!(!record.current("h", &root));
    }

    #[test]
    fn a_new_package_file_in_the_project_folder_changes_the_key() {
        let root = TempDir::new("preamble-format");
        let before = head(b"\\documentclass{article}\n", &root);
        root.write("notes.txt", "");
        assert_eq!(head(b"\\documentclass{article}\n", &root), before);
        root.write("amsmath.sty", "");
        assert_ne!(head(b"\\documentclass{article}\n", &root), before);
        assert_ne!(head(b"\\documentclass{book}\n", &root), before);
    }

    const DOCUMENT: &str =
        "\\documentclass{article}\n\\usepackage{macros}\n\\usepackage{amsmath}\n\
        \\begin{document}\nHello \\greeting.\n\\end{document}\n";

    /// Prepare the format of the project at `root`, kept in its own folder,
    /// and whether that made it anew.
    fn prepare_here(root: &Path) -> (Option<PreambleFormat>, bool) {
        let project = root.canonicalize().unwrap();
        let (main, steps) = (project.join("main.tex"), BuildSteps::silent());
        let active = ActiveBuild::default();
        let prepared =
            prepare_in(&project.join(".format"), &project, "main.tex", &main, &active, &steps);
        let made = steps.take().iter().any(|step| step.tool == STEP);
        match prepared {
            Prepared::Ready(format) => (Some(format), made),
            Prepared::Plain => (None, made),
            Prepared::Cancelled(_) => panic!("nobody cancelled"),
        }
    }

    #[test]
    #[ignore = "requires pdfLaTeX and mylatexformat"]
    fn the_format_is_rebuilt_exactly_when_the_preamble_or_a_file_it_read_changes() {
        let root = TempDir::new("preamble-format");
        root.write("macros.sty", "\\newcommand\\greeting{world}\n");
        root.write("main.tex", DOCUMENT);
        let (format, made) = prepare_here(&root);
        let format = format.expect("a usable format");
        assert!(made && format.log.contains("macros.sty"), "{}", format.log);
        assert!(matches!(prepare_here(&root), (Some(_), false)), "an unchanged preamble reuses it");

        root.write("main.tex", DOCUMENT.replace("Hello", "Goodbye"));
        assert!(matches!(prepare_here(&root), (Some(_), false)), "a body edit reuses it");
        root.write("macros.sty", "\\newcommand\\greeting{there}\n");
        assert!(matches!(prepare_here(&root), (Some(_), true)), "an edited package rebuilds it");
        root.write("main.tex", DOCUMENT.replace("amsmath", "amssymb"));
        assert!(matches!(prepare_here(&root), (Some(_), true)), "an edited preamble rebuilds it");
    }

    #[test]
    #[ignore = "requires pdfLaTeX and mylatexformat"]
    fn a_preamble_that_cannot_be_dumped_safely_builds_plain_without_retrying() {
        let root = TempDir::new("preamble-format");
        root.write("macros.sty", "\\newcommand\\greeting{world}\n");
        // An object written while the format is made would be missing from
        // every PDF built from it.
        root.write(
            "main.tex",
            DOCUMENT.replace("\\usepackage{amsmath}", "\\immediate\\pdfobj{(x)}"),
        );
        assert!(matches!(prepare_here(&root), (None, true)), "a preamble that writes is declined");
        assert!(matches!(prepare_here(&root), (None, false)), "and not tried again");

        root.write("main.tex", DOCUMENT.replace("\\usepackage{amsmath}", "\\undefinedcommand"));
        assert!(matches!(prepare_here(&root), (None, true)), "a preamble error leaves it plain");
    }
}
