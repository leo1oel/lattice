//! Running latexmk on a project the way Lattice does: output beside the
//! document, no previewer, no watching, SyncTeX on, unwrapped log lines.

use std::{
    fs,
    io::{self, BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use crate::{
    discovery,
    log::{Diagnostic, Level, parse_diagnostics},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Engine {
    #[default]
    PdfLatex,
    XeLatex,
    LuaLatex,
}

impl Engine {
    fn latexmk_arg(self) -> &'static str {
        match self {
            Engine::PdfLatex => "-pdf",
            Engine::XeLatex => "-pdfxe",
            Engine::LuaLatex => "-pdflua",
        }
    }

    /// The same engine as a default an rc file's `$pdf_mode` outranks.
    fn latexmk_pdf_default(self) -> &'static str {
        match self {
            Engine::PdfLatex => "$pdf_mode ||= 1;",
            Engine::XeLatex => "$pdf_mode ||= 5;",
            Engine::LuaLatex => "$pdf_mode ||= 4;",
        }
    }

    /// latexmk's engine options for a document in `folder`. Like Lattice, a
    /// project latexmkrc keeps its own engine: `-e` runs after the rc files,
    /// while `-pdf` and its siblings would override them.
    fn latexmk_args(self, folder: &Path) -> Vec<&'static str> {
        if folder.join("latexmkrc").is_file() || folder.join(".latexmkrc").is_file() {
            vec!["-e", self.latexmk_pdf_default()]
        } else {
            vec![self.latexmk_arg()]
        }
    }

    /// `% !TEX program = xelatex` (TeXShop/TeXstudio) or a CJK package in the
    /// preamble picks the engine; pdfLaTeX otherwise.
    pub fn detect(source: &str) -> Self {
        if let Some(engine) = Self::from_magic_comment(source) {
            return engine;
        }
        let head: String = source.lines().take(200).collect::<Vec<_>>().join("\n");
        let lower = head.to_ascii_lowercase();
        if lower.contains("{ctex") || lower.contains("{xecjk}") || lower.contains("{fontspec}") {
            return Engine::XeLatex;
        }
        Engine::PdfLatex
    }

    /// The `program` / `TS-program` magic comment in the first 40 lines, read
    /// the way Lattice reads it (`src-tauri/src/project/manifest.rs`).
    fn from_magic_comment(source: &str) -> Option<Self> {
        let mut engine = None;
        for line in source.lines().take(40) {
            let trimmed = line.trim();
            let Some(rest) = ["% !TEX", "% !TeX", "%!TEX", "%!TeX"]
                .into_iter()
                .find_map(|prefix| trimmed.strip_prefix(prefix))
            else {
                continue;
            };
            let Some((key, value)) = rest.trim().trim_start_matches(':').trim().split_once('=')
            else {
                continue;
            };
            let value = value.trim().trim_matches('"').trim_matches('\'').trim();
            if value.is_empty() {
                continue;
            }
            if matches!(
                key.trim().to_ascii_lowercase().as_str(),
                "program" | "ts-program"
            ) {
                engine = match value.to_ascii_lowercase().as_str() {
                    "xelatex" | "xetex" => Some(Engine::XeLatex),
                    "lualatex" | "luatex" => Some(Engine::LuaLatex),
                    "pdflatex" | "latex" | "pdftex" => Some(Engine::PdfLatex),
                    _ => None,
                };
            }
        }
        engine
    }
}

/// Output beside the document (relative to it, after `-cd`), no previewer, no
/// watching for changes: command-line options outrank every rc file.
const LATEXMK_OVERRIDES: [&str; 4] = ["-outdir=.", "-auxdir=.", "-pv-", "-pvc-"];

#[derive(Debug)]
pub struct BuildOutcome {
    pub succeeded: bool,
    pub pdf: Option<PathBuf>,
    pub diagnostics: Vec<Diagnostic>,
    pub log: String,
    pub duration: Duration,
}

impl BuildOutcome {
    pub fn error_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.level == Level::Error)
            .count()
    }

    pub fn warning_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.level == Level::Warning)
            .count()
    }
}

/// The document a project builds: `main.tex` when present, otherwise the
/// first top-level `.tex` file that declares `\documentclass`.
pub fn find_main_document(root: &Path) -> Option<PathBuf> {
    let main = root.join("main.tex");
    if main.is_file() {
        return Some(main);
    }
    let mut candidates: Vec<PathBuf> = fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "tex"))
        .collect();
    candidates.sort();
    candidates.into_iter().find(|path| {
        fs::read_to_string(path)
            .map(|text| text.contains("\\documentclass"))
            .unwrap_or(false)
    })
}

/// Build `document` with latexmk, calling `on_line` with each output line as
/// it arrives. Blocks until latexmk exits.
pub fn build(document: &Path, mut on_line: impl FnMut(&str)) -> io::Result<BuildOutcome> {
    let started = Instant::now();
    let folder = document
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let source = fs::read_to_string(document).unwrap_or_default();
    let engine = Engine::detect(&source);

    let mut command = discovery::command("latexmk");
    command
        .current_dir(folder)
        .arg("-cd")
        .args(LATEXMK_OVERRIDES)
        .args([
            "-interaction=nonstopmode",
            "-synctex=1",
            "-file-line-error",
            "-f",
        ])
        .args(engine.latexmk_args(folder))
        .arg(document.file_name().unwrap_or(document.as_os_str()))
        .env("max_print_line", "10000")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;

    // Both pipes stream into one channel so a full stderr pipe cannot stall
    // latexmk while stdout is being read.
    let (sender, receiver) = mpsc::channel::<String>();
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        readers.push(spawn_reader(stdout, sender.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(spawn_reader(stderr, sender.clone()));
    }
    drop(sender);

    let mut log = String::new();
    for line in receiver {
        on_line(&line);
        log.push_str(&line);
        log.push('\n');
    }
    for reader in readers {
        let _ = reader.join();
    }
    let status = child.wait()?;

    let pdf = document.with_extension("pdf");
    let pdf = pdf.is_file().then_some(pdf);
    let diagnostics = parse_diagnostics(&log);
    let has_errors = diagnostics
        .iter()
        .any(|diagnostic| diagnostic.level == Level::Error);
    Ok(BuildOutcome {
        succeeded: status.success() && !has_errors && pdf.is_some(),
        pdf,
        diagnostics,
        log,
        duration: started.elapsed(),
    })
}

fn spawn_reader(
    stream: impl io::Read + Send + 'static,
    sender: mpsc::Sender<String>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buffer = Vec::new();
        while reader.read_until(b'\n', &mut buffer).unwrap_or(0) > 0 {
            let line = String::from_utf8_lossy(&buffer);
            if sender
                .send(line.trim_end_matches(['\r', '\n']).to_string())
                .is_err()
            {
                break;
            }
            buffer.clear();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_engine_from_magic_comment_and_packages() {
        assert_eq!(
            Engine::detect("% !TEX program = xelatex\n"),
            Engine::XeLatex
        );
        assert_eq!(Engine::detect("\\usepackage{ctex}"), Engine::XeLatex);
        assert_eq!(Engine::detect("\\documentclass{article}"), Engine::PdfLatex);
    }

    /// The spellings TeXShop and TeXstudio write, which Lattice accepts.
    #[test]
    fn reads_every_magic_comment_spelling_lattice_accepts() {
        assert_eq!(
            Engine::detect("%!TeX program = lualatex\n\\usepackage{luacode}\n"),
            Engine::LuaLatex
        );
        assert_eq!(
            Engine::detect("% !TEX TS-program = lualatex\n\\usepackage{fontspec}\n"),
            Engine::LuaLatex
        );
        assert_eq!(Engine::detect("% !TeX program = xetex\n"), Engine::XeLatex);
        assert_eq!(
            Engine::detect("%!TEX program = pdftex\n\\usepackage{fontspec}\n"),
            Engine::PdfLatex
        );
    }

    /// latexmk's documented `$pdf_mode` values (1 pdfLaTeX, 4 LuaLaTeX,
    /// 5 XeLaTeX), passed as defaults when the project has an rc file.
    #[test]
    fn leaves_the_engine_to_a_project_latexmkrc() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Engine::XeLatex.latexmk_args(dir.path()), ["-pdfxe"]);
        fs::write(dir.path().join(".latexmkrc"), "$pdf_mode = 4;\n").unwrap();
        assert_eq!(
            Engine::XeLatex.latexmk_args(dir.path()),
            ["-e", "$pdf_mode ||= 5;"]
        );
        assert_eq!(
            Engine::LuaLatex.latexmk_args(dir.path()),
            ["-e", "$pdf_mode ||= 4;"]
        );
        fs::remove_file(dir.path().join(".latexmkrc")).unwrap();
        fs::write(dir.path().join("latexmkrc"), "").unwrap();
        assert_eq!(
            Engine::PdfLatex.latexmk_args(dir.path()),
            ["-e", "$pdf_mode ||= 1;"]
        );
    }

    #[test]
    fn prefers_main_tex_then_a_documentclass_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.tex"), "\\section{x}").unwrap();
        fs::write(dir.path().join("paper.tex"), "\\documentclass{article}").unwrap();
        assert_eq!(
            find_main_document(dir.path()),
            Some(dir.path().join("paper.tex"))
        );
        fs::write(dir.path().join("main.tex"), "").unwrap();
        assert_eq!(
            find_main_document(dir.path()),
            Some(dir.path().join("main.tex"))
        );
    }

    /// Needs a TeX installation; run with `cargo test -p tex -- --ignored`.
    #[test]
    #[ignore]
    fn builds_a_document_and_reports_its_error() {
        let dir = tempfile::tempdir().unwrap();
        let document = dir.path().join("main.tex");
        fs::write(
            &document,
            "\\documentclass{article}\n\\begin{document}\nHello \\undefinedmacro\n\\end{document}\n",
        )
        .unwrap();
        let outcome = build(&document, |_| {}).unwrap();
        assert!(outcome.pdf.is_some(), "{}", outcome.log);
        assert_eq!(outcome.error_count(), 1, "{:?}", outcome.diagnostics);
        assert_eq!(outcome.diagnostics[0].line, Some(3));
    }
}
