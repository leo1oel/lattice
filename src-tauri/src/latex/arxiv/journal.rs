//! Export for a journal: each editable figure (docs/editable-figures.md) as
//! the files a journal asks for, named by function (`Scheme1.pdf`,
//! `Figure2.tiff`), with the text the document sets over the drawing (compound
//! numbers) in them, and the paper itself as a source pack that includes those
//! files instead of the figures' entry files.
//!
//! A drawing's own PDF has no numbers: the entry sets them over it in the
//! document's build. So the paper is typeset once more, in a scratch folder,
//! with a file read first that records where each entry's box lands on which
//! page and in which float (journal/hook.rs); each figure is then cut out of
//! that PDF (journal/figures.rs). The source pack is the arXiv pack (the files
//! the last build read, `\input` files merged) with each entry's text replaced
//! by the exported file and the entry's marks in an unprinted box, so every
//! compound keeps its number in the text; it is built alone to check it.
//! Nothing in the project changes.

mod figures;
mod hook;
#[cfg(test)]
mod tests;

use super::super::build::{run_tracked, ActiveBuild};
use super::super::{default_root_document, BuildSteps};
use super::{stage_with, test_build_keeping, ArxivChecks, ArxivOptions, CompileCheck, Scratch};
use crate::project;
use hook::Placed;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use walkdir::WalkDir;

/// The first line of an editable figure's entry file.
const SOURCE_HEADER: &str = "% editable-figure source: ";
/// The folder the export makes, and the file in it that says Lattice made it.
const MARKER: &str = ".lattice-journal-export";
/// A project's `.tex` files read looking for entries.
const MAX_TEX_FILES: usize = 5000;
/// Line art at 1200 dpi is the most a journal asks for; far more would only
/// fill memory with a bitmap nobody takes.
const MAX_DPI: u32 = 2400;
const IMAGE_EXTENSIONS: [&str; 5] = ["", ".pdf", ".png", ".jpg", ".eps"];

static MARK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\(?:rcmpd|cmpd)\*?(?:\[[^\]]*\])?\{[^{}]*\}").unwrap());
static GRAPHICS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}").unwrap());

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalOptions {
    /// Also draw each figure as a TIFF, at `dpi`.
    pub tiff: bool,
    pub dpi: u32,
    /// Also write the paper as a source pack that includes the exported figures.
    pub article: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalExport {
    /// The folder written, absolute.
    pub folder: String,
    /// The figures, by the names they were given.
    pub figures: Vec<String>,
    /// What went wrong without stopping the export.
    pub problems: Vec<String>,
    /// The source pack's test build, when the pack was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub article: Option<CompileCheck>,
}

/// Write the export into a new folder in `parent`, named after the project.
pub fn export(
    root: &Path, parent: &Path, options: JournalOptions,
) -> Result<JournalExport, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let manifest = project::read_manifest(&root)?;
    let document = default_root_document(&manifest)?.path.clone();
    let entries = entry_files(&root);
    if entries.is_empty() {
        return Err("This paper has no figure made from a drawing to export.".to_string());
    }
    let scratch = Scratch::new()?;
    let (pdf, placed) = typeset(&root, &document, &manifest.engine, &entries, &scratch.0)?;
    if placed.is_empty() {
        return Err("No figure made from a drawing was found in the typeset paper.".to_string());
    }
    let names = hook::submission_names(&placed);
    let folder = output_folder(&root, parent)?;
    let document_dir = Path::new(&document).parent().map(Path::to_path_buf).unwrap_or_default();
    let mut problems = Vec::new();
    let mut figure_files = BTreeMap::new();
    for (figure, name) in placed.iter().zip(&names) {
        let bytes = figures::crop(&pdf, figure)?;
        let target = folder.join(&document_dir).join(format!("{name}.pdf"));
        write(&target, &bytes)?;
        figure_files.insert(project_path(&document_dir, &format!("{name}.pdf")), bytes);
        if options.tiff {
            let tiff = target.with_extension("tiff");
            if let Err(problem) =
                figures::render_tiff(&target, &tiff, options.dpi.clamp(72, MAX_DPI), &scratch.0)
            {
                problems.push(format!("{name}: {problem}"));
            }
        }
    }
    let article = if options.article {
        article(&root, &document, &entries, &placed, &names, figure_files, &folder, &mut problems)?
    } else {
        None
    };
    Ok(JournalExport {
        folder: folder.to_string_lossy().into_owned(),
        figures: names,
        problems,
        article,
    })
}

/// The project's entry files, by project path, with their text.
fn entry_files(root: &Path) -> BTreeMap<String, String> {
    let walk = WalkDir::new(root).min_depth(1).sort_by_file_name().into_iter();
    let tex = walk
        .filter_entry(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file() && entry.path().extension().is_some_and(|ext| ext == "tex")
        })
        .take(MAX_TEX_FILES);
    let mut entries = BTreeMap::new();
    for entry in tex {
        let Ok(file) = fs::File::open(entry.path()) else { continue };
        let mut first = String::new();
        if BufReader::new(file.take(1024)).read_line(&mut first).is_err()
            || !first.starts_with(SOURCE_HEADER)
        {
            continue;
        }
        let (Ok(text), Ok(relative)) =
            (fs::read_to_string(entry.path()), entry.path().strip_prefix(root))
        else {
            continue;
        };
        entries.insert(relative.to_string_lossy().replace('\\', "/"), text);
    }
    entries
}

/// Typeset the paper in `scratch` with the hook read first: its PDF and the figures it placed.
fn typeset(
    root: &Path, document: &str, engine: &str, entries: &BTreeMap<String, String>, scratch: &Path,
) -> Result<(Vec<u8>, Vec<Placed>), String> {
    let source = project::safe_path(root, document)?;
    let directory = source.parent().unwrap_or(root).to_path_buf();
    let stem = source.file_stem().and_then(|stem| stem.to_str()).unwrap_or("paper");
    let job = format!("{stem}-journal");
    // `\include` writes an `.aux` per chapter, in a folder the output must have.
    for folder in WalkDir::new(&directory)
        .min_depth(1)
        .into_iter()
        .filter_entry(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_dir())
    {
        if let Ok(relative) = folder.path().strip_prefix(&directory) {
            fs::create_dir_all(scratch.join(relative)).map_err(|error| error.to_string())?;
        }
    }
    // The last build's references and bibliography, so pages break as they did.
    for extension in ["aux", "bbl"] {
        let _ =
            fs::copy(source.with_extension(extension), scratch.join(format!("{job}.{extension}")));
    }
    let names: Vec<String> =
        entries.keys().map(|path| path.rsplit('/').next().unwrap_or(path).to_string()).collect();
    let hook_file = scratch.join("lattice-journal.tex");
    fs::write(&hook_file, hook::hook(&names)).map_err(|error| error.to_string())?;
    let program = match engine.trim().to_ascii_lowercase().as_str() {
        "xelatex" => "xelatex",
        "lualatex" => "lualatex",
        _ => "pdflatex",
    };
    let file_name = source.file_name().and_then(|name| name.to_str()).unwrap_or(document);
    let mut command = crate::commands::command(program);
    command
        .current_dir(&directory)
        .env("max_print_line", "10000")
        .args(["-interaction=nonstopmode", "-file-line-error", "-no-shell-escape"])
        .arg(format!("-output-directory={}", tex_path(scratch)))
        .arg(format!("-jobname={job}"))
        .arg(format!("\\input{{{}}}\\input{{{file_name}}}", tex_path(&hook_file)));
    let (_, stopped) = run_tracked(
        command,
        &ActiveBuild::default(),
        &BuildSteps::new(|_, _| {}),
        "Could not start TeX. Install MacTeX or TeX Live. ",
        "TeX exited unexpectedly: ",
    )?;
    if stopped {
        return Err("Typesetting the paper for the export stopped.".to_string());
    }
    let pdf = fs::read(scratch.join(format!("{job}.pdf")))
        .map_err(|_| "The paper did not typeset. Build it in Lattice to see why.".to_string())?;
    let record = fs::read_to_string(scratch.join(format!("{job}.figures"))).unwrap_or_default();
    // Only boxes of the entry files listed: the document can write this file too.
    let placed =
        hook::parse(&record).into_iter().filter(|figure| names.contains(&figure.file)).collect();
    Ok((pdf, placed))
}

#[cfg(windows)]
fn tex_path(path: &Path) -> String {
    crate::host_paths::tex_path(path)
}

#[cfg(not(windows))]
fn tex_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `<parent>/<project>-journal`, new, or one an earlier export made (emptied).
fn output_folder(root: &Path, parent: &Path) -> Result<PathBuf, String> {
    let name = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "paper".into());
    let folder = parent.join(format!("{name}-journal"));
    if folder.starts_with(root) {
        return Err("Choose a folder outside the project for the export.".to_string());
    }
    if folder.exists() {
        if !folder.join(MARKER).is_file() {
            return Err(format!(
                "{} already exists and was not made by this export.",
                folder.display()
            ));
        }
        fs::remove_dir_all(&folder).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    fs::write(
        folder.join(MARKER),
        "Made by Lattice's Export for a journal; the next export replaces this folder.\n",
    )
    .map_err(|error| error.to_string())?;
    Ok(folder)
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, bytes).map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn project_path(directory: &Path, name: &str) -> String {
    let directory = directory.to_string_lossy().replace('\\', "/");
    if directory.is_empty() {
        name.to_string()
    } else {
        format!("{directory}/{name}")
    }
}

/// What an entry becomes in the source pack: the exported figure, then its
/// marks in a box that is never printed, so the numbers they take stay theirs.
fn replacement(entry_text: &str, name: &str) -> String {
    let code = super::source::strip_comments(entry_text).text;
    let marks: String = MARK.find_iter(&code).map(|found| found.as_str()).collect();
    if marks.is_empty() {
        format!("\\includegraphics{{{name}}}%\n")
    } else {
        format!("\\includegraphics{{{name}}}\\begingroup\\setbox0\\hbox{{{marks}}}\\endgroup%\n")
    }
}

/// A merged `\input` ends in `\space` on a line of its own, for the space the
/// line after the command makes. A figure's line ends in `%`, so that space is
/// the line end's alone: `\includegraphics{Scheme1}` followed by its line's
/// end typesets the same, and reads as an author would write it.
fn tidy_merged_figures<'a>(
    files: &mut BTreeMap<String, Vec<u8>>, replacements: impl Iterator<Item = &'a String>,
) {
    let pairs: Vec<(String, String)> = replacements
        .filter_map(|text| {
            let bare = text.strip_suffix("%\n")?;
            Some((format!("{text}\\space"), bare.to_string()))
        })
        .collect();
    for (path, bytes) in files.iter_mut() {
        if !path.ends_with(".tex") {
            continue;
        }
        let Ok(text) = std::str::from_utf8(bytes) else { continue };
        let mut tidy = text.to_string();
        for (merged, bare) in &pairs {
            tidy = tidy.replace(merged.as_str(), bare);
        }
        if tidy != text {
            *bytes = tidy.into_bytes();
        }
    }
}

/// The source pack in `folder`, built alone; its PDF beside it when it builds.
#[allow(clippy::too_many_arguments)]
fn article(
    root: &Path, document: &str, entries: &BTreeMap<String, String>, placed: &[Placed],
    names: &[String], figure_files: BTreeMap<String, Vec<u8>>, folder: &Path,
    problems: &mut Vec<String>,
) -> Result<Option<CompileCheck>, String> {
    let mut replaced = BTreeMap::new();
    for (path, text) in entries {
        let file = path.rsplit('/').next().unwrap_or(path);
        if let Some(index) = placed
            .iter()
            .position(|figure| figure.file == file || figure.file.ends_with(&format!("/{file}")))
        {
            replaced.insert(path.clone(), replacement(text, &names[index]));
        }
    }
    let options = ArxivOptions { strip_comments: false, merge_inputs: true };
    let Some(mut pack) = stage_with(root, options, &replaced)? else {
        problems.push("Build the paper once in Lattice to export it as a source pack.".to_string());
        return Ok(None);
    };
    // The drawings without numbers that the entries set text over: the exported figures replace them.
    let document_dir = Path::new(document).parent().map(Path::to_path_buf).unwrap_or_default();
    for (path, text) in entries.iter().filter(|(path, _)| replaced.contains_key(*path)) {
        let entry_dir = Path::new(path).parent().map(Path::to_path_buf).unwrap_or_default();
        for found in GRAPHICS.captures_iter(&super::source::strip_comments(text).text) {
            for dir in [&entry_dir, &document_dir] {
                for extension in IMAGE_EXTENSIONS {
                    pack.files
                        .remove(&project_path(dir, &format!("{}{extension}", found[1].trim())));
                }
            }
        }
    }
    tidy_merged_figures(&mut pack.files, replaced.values());
    pack.files.extend(figure_files);
    for (path, bytes) in &pack.files {
        write(&folder.join(path), bytes)?;
    }
    let checks = ArxivChecks::default();
    let check = checks.begin();
    let built = folder.join(document).with_extension("pdf");
    let result = test_build_keeping(&pack, &checks, check, Some(&built))?;
    if result.error.is_some() || !built.is_file() {
        problems.push("The source pack did not build on its own; see its log.".to_string());
    }
    Ok(Some(result))
}
