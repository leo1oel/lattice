//! Figures kept as a drawing in another program's format: an installed
//! converter renders the drawing, and an entry `.tex` that names it on its
//! first line (docs/editable-figures.md) includes the result. Only programs
//! at their standard install locations run; nothing in a project names one.
//!
//! The program writes into a scratch folder, never the project: its files
//! come in the way a pasted figure's do (editable_figure.rs), as new files
//! that never follow a link or take over a file someone else made. Only a
//! figure's own files, those an entry naming the drawing sits beside, are
//! replaced, and then by renaming over the name rather than writing through it.

mod render;
mod svg_links;
#[cfg(test)]
mod tests;

use super::editable_figure::{
    numbered, taken, write_new, ImportedFigure, MAX_NAME_NUMBER, NO_FREE_NAME,
};
use super::manifest::read_manifest;
use super::paths::{relative_to, safe_path, validate_entry_name};
use crate::util::err;
use base64::{engine::general_purpose::STANDARD, Engine};
use render::{run_tool, tool_for, Tool};
use serde::Serialize;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use svg_links::check_svg_links;
use uuid::Uuid;

/// The most of the text block's height a figure may take, leaving room for its caption.
const MAX_TEXT_HEIGHT: f64 = 0.8;
/// The largest drawing, or rendered file, taken in.
const MAX_DRAWING_BYTES: u64 = 64 * 1024 * 1024;
/// An entry is a few lines; a larger file is not one.
const MAX_ENTRY_BYTES: u64 = 64 * 1024;
/// Tries before giving up on a name that keeps being taken while writing.
const WRITE_ATTEMPTS: usize = 8;
const TOO_LARGE: &str = "The drawing is too large to convert.";

#[derive(Debug, Clone, Copy, PartialEq)]
struct NaturalSize {
    width: f64,
    height: f64,
}

const SOURCE_HEADER: &str = "% editable-figure source: ";
const PAGE_HEADER: &str = "% editable-figure page: ";

/// The renderer: the installed program, or a stand-in in tests.
type Render<'a> = &'a dyn Fn(Tool, &Path, &Path, u32) -> Result<(), String>;

/// A name LaTeX takes as it is: no extension, other characters as `_`.
fn figure_stem(name: &OsStr) -> String {
    let name = Path::new(name).file_stem().and_then(OsStr::to_str).unwrap_or("figure");
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    let safe = safe.trim_start_matches(['.', '_', '-']);
    if safe.is_empty() {
        "figure".to_string()
    } else {
        safe.to_string()
    }
}

/// Text that stays on its comment line: a line break would end the comment
/// and make the rest of the name TeX the entry runs on every build.
fn stays_on_line(text: &str) -> bool {
    !text.chars().any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
}

/// A folder name `\input{…}` takes as it is.
fn tex_safe(text: &str) -> bool {
    stays_on_line(text) && !text.contains(['\\', '{', '}', '%', '#', '$', '^', '&', '~'])
}

/// The entry file: its source on the first line, then what includes the drawing.
fn entry_text(
    tool: Tool, source_name: &str, directory: &str, stem: &str, page_line: &str,
    natural: Option<NaturalSize>,
) -> String {
    let folder = if directory.is_empty() { String::new() } else { format!("{directory}/") };
    let limit = natural.map(|size| {
        let share = (MAX_TEXT_HEIGHT * size.width / size.height * 10_000.0).round() / 10_000.0;
        let width = size.width;
        let bound = format!(
            "\\edef\\figuremaxwidth{{\\the\\dimexpr\\ifdim\\linewidth<{share}\\textheight\\linewidth\\else{share}\\textheight\\fi\\relax}}\n"
        );
        (bound, width)
    });
    let body = match (tool, limit) {
        (Tool::Inkscape, Some((bound, width))) => format!(
            "{bound}\\ifdim {width}bp>\\figuremaxwidth\\let\\svgwidth\\figuremaxwidth\\fi\n\\input{{{folder}{stem}.pdf_tex}}"
        ),
        (Tool::Inkscape, None) => format!("\\input{{{folder}{stem}.pdf_tex}}"),
        (Tool::DrawIo, Some((bound, width))) => format!(
            "{bound}\\ifdim {width}bp>\\figuremaxwidth\\includegraphics[width=\\figuremaxwidth]{{{stem}.pdf}}\\else\\includegraphics{{{stem}.pdf}}\\fi"
        ),
        (Tool::DrawIo, None) => format!("\\includegraphics{{{stem}.pdf}}"),
    };
    format!("{SOURCE_HEADER}{source_name}\n{page_line}{body}\n")
}

/// An Inkscape export's size in big points, from its `.pdf_tex`.
fn pdf_tex_size(pdf_tex: &str) -> Option<NaturalSize> {
    let rest = pdf_tex.split("\\setlength{\\unitlength}{").nth(1)?;
    let width: f64 = rest.split("bp").next()?.trim().parse().ok()?;
    let ratio = pdf_tex.split("\\begin{picture}(1,").nth(1)?.split(')').next()?;
    let size = NaturalSize { width, height: width * ratio.trim().parse::<f64>().ok()? };
    (size.width.is_finite() && size.height.is_finite() && size.width > 0.0 && size.height > 0.0)
        .then_some(size)
}

/// A PDF's first page size in big points, when its page box is written plainly.
fn pdf_size(pdf: &[u8]) -> Option<NaturalSize> {
    let text = String::from_utf8_lossy(pdf);
    let rest = text.split("/MediaBox").nth(1)?;
    let numbers: Vec<f64> = rest
        .trim_start()
        .strip_prefix('[')?
        .split(']')
        .next()?
        .split_whitespace()
        .filter_map(|value| value.parse().ok())
        .collect();
    match numbers[..] {
        [left, bottom, right, top] if right > left && top > bottom => {
            let size = NaturalSize { width: right - left, height: top - bottom };
            (size.width.is_finite() && size.height.is_finite()).then_some(size)
        }
        _ => None,
    }
}

/// The packages a figure's Inkscape text needs: `.pdf_tex` stops with an error
/// if it colours text with no colour package, or fades it with no `transparent`.
fn pdf_tex_packages(pdf_tex: &str) -> Vec<String> {
    let used = |command: &str| {
        pdf_tex.lines().any(|line| {
            !line.trim_start().starts_with("\\providecommand") && line.contains(command)
        })
    };
    let mut packages = vec!["graphicx".to_string()];
    if used("\\color[") {
        packages.push("xcolor".to_string());
    }
    if used("\\transparent{") {
        packages.push("transparent".to_string());
    }
    packages
}

/// The page an entry's second line chooses, for a drawing of several; the
/// first by default. Only the number is read: nothing else reaches the program.
fn chosen_page(entry: &str) -> u32 {
    entry
        .lines()
        .nth(1)
        .and_then(|line| line.strip_prefix(PAGE_HEADER))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|number| number.parse().ok())
        .filter(|page| *page >= 1)
        .unwrap_or(1)
}

/// The names of a draw.io file's pages, in order, each kept on one line.
fn diagram_names(drawing: &str) -> Vec<String> {
    drawing
        .split("<diagram ")
        .skip(1)
        .map(|tag| {
            let tag = tag.split('>').next().unwrap_or_default();
            let name = tag
                .split(" name=\"")
                .nth(1)
                .or_else(|| tag.strip_prefix("name=\""))
                .and_then(|rest| rest.split('"').next())
                .unwrap_or_default();
            name.chars().map(|c| if stays_on_line(&c.to_string()) { c } else { ' ' }).collect()
        })
        .collect()
}

/// The line that says which page is used, when a drawing has a choice: edit its number to change it.
fn page_line(page: u32, names: &[String]) -> String {
    if names.len() < 2 {
        return String::new();
    }
    format!("{PAGE_HEADER}{page} (of {}: {})\n", names.len(), names.join(", "))
}

/// A regular file's text, never through a link and never more than `limit` bytes.
fn read_plain(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let metadata = path.symlink_metadata().ok()?;
    if !metadata.is_file() || metadata.len() > limit {
        return None;
    }
    let mut bytes = Vec::new();
    File::open(path).ok()?.take(limit).read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

fn entry_of(path: &Path) -> Option<String> {
    read_plain(path, MAX_ENTRY_BYTES).and_then(|bytes| String::from_utf8(bytes).ok())
}

fn names_source(entry: &Path, source_name: &str) -> bool {
    entry_of(entry)
        .is_some_and(|text| text.lines().next() == Some(&format!("{SOURCE_HEADER}{source_name}")))
}

/// The files a drawing renders to, under `stem`.
fn rendered_names(tool: Tool, stem: &str) -> Vec<String> {
    match tool {
        Tool::Inkscape => vec![format!("{stem}.pdf"), format!("{stem}.pdf_tex")],
        Tool::DrawIo => vec![format!("{stem}.pdf")],
    }
}

#[derive(Debug)]
struct Figure {
    tool: Tool,
    source: PathBuf,
    folder: PathBuf,
    /// `folder`, relative to the project.
    directory: String,
    stem: String,
    /// Whether the entry under `stem` already names this drawing.
    ours: bool,
    source_name: String,
}

/// The stem a drawing's outputs go under: the one whose entry already names it,
/// else the first with no file in the way, so someone else's files stay as they
/// are. LaTeX looks in the project root first, so a name taken there counts too.
fn figure_slot(
    root: &Path, folder: &Path, base: &str, source_name: &str,
) -> Result<(String, bool), String> {
    std::iter::once(base.to_string())
        .chain((2..MAX_NAME_NUMBER).map(|n| format!("{base}-{n}")))
        .find_map(|stem| {
            if names_source(&folder.join(format!("{stem}.tex")), source_name) {
                return Some((stem, true));
            }
            let free = ["tex", "pdf", "pdf_tex"].iter().all(|ext| {
                let name = format!("{stem}.{ext}");
                !taken(&folder.join(&name)) && !taken(&root.join(&name))
            });
            free.then_some((stem, false))
        })
        .ok_or_else(|| NO_FREE_NAME.to_string())
}

fn not_a_drawing(what: &str) -> String {
    format!("{what} is not a drawing Lattice can convert.")
}

fn figure_of(root: &Path, source: &str) -> Result<Figure, String> {
    // A real file inside the project: links are refused on every component.
    let path = safe_path(root, source)?;
    let tool = tool_for(&path).ok_or_else(|| not_a_drawing(source))?;
    let metadata = path.symlink_metadata().map_err(|_| format!("{source} could not be found."))?;
    if !metadata.is_file() {
        return Err(format!("{source} could not be found."));
    }
    if metadata.len() > MAX_DRAWING_BYTES {
        return Err(TOO_LARGE.to_string());
    }
    let folder =
        path.parent().ok_or_else(|| format!("{source} could not be found."))?.to_path_buf();
    let source_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| format!("{source} could not be found."))?
        .to_string();
    let directory = relative_to(&root.canonicalize().map_err(err)?, &folder)?;
    if !stays_on_line(&source_name) || !tex_safe(&directory) {
        return Err(format!("Rename {source}: a figure's file and folder names cannot hold line breaks or TeX's special characters."));
    }
    let (stem, ours) =
        figure_slot(root, &folder, &figure_stem(OsStr::new(&source_name)), &source_name)?;
    Ok(Figure { tool, stem, ours, source_name, directory, folder, source: path })
}

/// A private folder the program writes into, removed when dropped.
struct Scratch(PathBuf);

/// The figure is the project's, and `/tmp` is shared on Linux, so the folder
/// is the user's own. Windows gives each user their own temp folder already.
#[cfg(unix)]
fn create_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir(path)
}

impl Scratch {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("lattice-figure-{}", Uuid::new_v4()));
        create_private_dir(&path).map_err(err)?;
        Ok(Self(path))
    }

    /// A file the program made, as bytes.
    fn read(&self, name: &str) -> Result<Vec<u8>, String> {
        read_plain(&self.0.join(name), MAX_DRAWING_BYTES)
            .ok_or_else(|| "The converted figure could not be read.".to_string())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Renders the figure's drawing into a scratch folder.
fn render_figure(
    root: &Path, figure: &Figure, page: u32, render: Render,
) -> Result<Scratch, String> {
    if figure.tool == Tool::Inkscape {
        let svg = read_plain(&figure.source, MAX_DRAWING_BYTES).ok_or(TOO_LARGE)?;
        check_svg_links(root, &figure.directory, &svg)?;
    }
    let scratch = Scratch::new()?;
    render(figure.tool, &figure.source, &scratch.0.join(format!("{}.pdf", figure.stem)), page)?;
    Ok(scratch)
}

/// Puts `bytes` at `folder/name` by renaming a new file over the name: a link
/// there is replaced, never written through.
fn replace(folder: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let part = folder.join(format!(".{name}.{}.part", Uuid::new_v4()));
    let written = write_new(&part, bytes).and_then(|()| fs::rename(&part, folder.join(name)));
    if written.is_err() {
        let _ = fs::remove_file(&part);
    }
    written
}

enum InstallFailure {
    NameTaken,
    Other(String),
}

/// Writes a figure's files: over its own, or all new, or none of them.
fn install(figure: &Figure, files: &[(String, Vec<u8>)]) -> Result<(), InstallFailure> {
    if figure.ours {
        for (name, bytes) in files {
            replace(&figure.folder, name, bytes)
                .map_err(|error| InstallFailure::Other(err(error)))?;
        }
        return Ok(());
    }
    let mut created = Vec::with_capacity(files.len());
    for (name, bytes) in files {
        let path = figure.folder.join(name);
        match write_new(&path, bytes) {
            Ok(()) => created.push(path),
            Err(error) => {
                if error.kind() != io::ErrorKind::AlreadyExists {
                    // A file may exist half written.
                    let _ = fs::remove_file(&path);
                }
                for path in created {
                    let _ = fs::remove_file(path);
                }
                return Err(if error.kind() == io::ErrorKind::AlreadyExists {
                    InstallFailure::NameTaken
                } else {
                    InstallFailure::Other(err(error))
                });
            }
        }
    }
    Ok(())
}

fn page_of(figure: &Figure) -> u32 {
    if !figure.ours {
        return 1;
    }
    entry_of(&figure.folder.join(format!("{}.tex", figure.stem)))
        .map_or(1, |text| chosen_page(&text))
}

fn convert(root: &Path, source: &str, render: Render) -> Result<ImportedFigure, String> {
    for _ in 0..WRITE_ATTEMPTS {
        let figure = figure_of(root, source)?;
        let page = page_of(&figure);
        let scratch = render_figure(root, &figure, page, render)?;
        let mut files = Vec::new();
        for name in rendered_names(figure.tool, &figure.stem) {
            let bytes = scratch.read(&name)?;
            files.push((name, bytes));
        }
        let (natural, packages, names) = match figure.tool {
            Tool::Inkscape => {
                let pdf_tex = String::from_utf8_lossy(&files[1].1).into_owned();
                (pdf_tex_size(&pdf_tex), pdf_tex_packages(&pdf_tex), Vec::new())
            }
            Tool::DrawIo => {
                let drawing = read_plain(&figure.source, MAX_DRAWING_BYTES).ok_or(TOO_LARGE)?;
                let names = diagram_names(&String::from_utf8_lossy(&drawing));
                (pdf_size(&files[0].1), vec!["graphicx".to_string()], names)
            }
        };
        let entry = format!("{}.tex", figure.stem);
        let text = entry_text(
            figure.tool,
            &figure.source_name,
            &figure.directory,
            &figure.stem,
            &page_line(page, &names),
            natural,
        );
        files.push((entry.clone(), text.into_bytes()));
        match install(&figure, &files) {
            Ok(()) => {
                return Ok(ImportedFigure {
                    directory: figure.directory,
                    entry,
                    source: source.to_string(),
                    packages,
                })
            }
            // Something took a name since it was chosen: choose again.
            Err(InstallFailure::NameTaken) => continue,
            Err(InstallFailure::Other(message)) => return Err(message),
        }
    }
    Err(NO_FREE_NAME.to_string())
}

/// Renders a drawing and writes its entry, for a document to include. The
/// user asked for this one, so later changes to that drawing may render on
/// their own (`may_render_unattended`).
pub fn make_editable_figure(root: &Path, source: &str) -> Result<ImportedFigure, String> {
    let figure = convert(root, source, &run_tool)?;
    remember_hand_rendered(root, source);
    Ok(figure)
}

/// Drawings someone at this computer has turned into a figure, by the
/// project-tree action, a paste or a drop. The list lives in `.research`,
/// which never travels with the project, so a drawing that arrived from an
/// Overleaf collaborator or a clone is not handed to a drawing program until
/// someone here asks for it once.
const RENDERED_BY_HAND: &str = ".research/figure-drawings.json";

fn hand_rendered(root: &Path) -> std::collections::BTreeSet<String> {
    fs::read_to_string(root.join(RENDERED_BY_HAND))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn remember_hand_rendered(root: &Path, source: &str) {
    let mut known = hand_rendered(root);
    if !known.insert(source.to_string()) {
        return;
    }
    // Losing this record only means asking again, so a failure is not an error
    // the user needs: the figure itself was made.
    if let Ok(text) = serde_json::to_string(&known) {
        let _ = fs::create_dir_all(root.join(".research"));
        let _ = fs::write(root.join(RENDERED_BY_HAND), text);
    }
}

/// What came of a request to render a figure's drawing again.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FigureRefresh {
    /// No entry beside the drawing names it, so it is no figure's source.
    NoFigure,
    /// The drawing changed, but running a program on it needs the user's word:
    /// the project is not trusted, or nothing here has rendered this drawing.
    AwaitingConsent,
    Rendered,
}

/// Whether a changed drawing may go to a program with no one asked. A drawing
/// is a program's untrusted input, and a project can be a clone or an Overleaf
/// collaborator's, so this holds to the same line as shell escape: trusted
/// projects only, and only a drawing someone here rendered by hand.
fn may_render_unattended(root: &Path, source: &str) -> bool {
    read_manifest(root).is_ok_and(|manifest| manifest.trusted)
        && hand_rendered(root).contains(source)
}

/// A rendered update waiting to be written. Rendering takes no project lease:
/// it reads the drawing and writes only into its scratch folder, and a program
/// that may take 90 seconds must not hold up an Overleaf sync (`install`).
pub struct PreparedRefresh {
    source: String,
    stem: String,
    tool: Tool,
    scratch: Scratch,
    /// Whether the watcher asked for this render rather than the user.
    unattended: bool,
}

/// What a refresh request comes to before anything is written.
pub enum RefreshPlan {
    NoFigure,
    AwaitingConsent,
    Ready(PreparedRefresh),
}

fn prepare(
    root: &Path, source: &str, unattended: bool, render: Render,
) -> Result<RefreshPlan, String> {
    let figure = figure_of(root, source)?;
    if !figure.ours {
        return Ok(RefreshPlan::NoFigure);
    }
    if unattended && !may_render_unattended(root, source) {
        return Ok(RefreshPlan::AwaitingConsent);
    }
    let scratch = render_figure(root, &figure, page_of(&figure), render)?;
    Ok(RefreshPlan::Ready(PreparedRefresh {
        source: source.to_string(),
        stem: figure.stem,
        tool: figure.tool,
        scratch,
        unattended,
    }))
}

/// Writes what the program rendered. The figure is looked up again, since the
/// project may have moved on during the render: the files go in only where an
/// entry still names this drawing under the same name.
fn install_prepared(root: &Path, prepared: &PreparedRefresh) -> Result<FigureRefresh, String> {
    let figure = figure_of(root, &prepared.source)?;
    if !figure.ours || figure.stem != prepared.stem || figure.tool != prepared.tool {
        return Ok(FigureRefresh::NoFigure);
    }
    for name in rendered_names(figure.tool, &figure.stem) {
        replace(&figure.folder, &name, &prepared.scratch.read(&name)?).map_err(err)?;
    }
    if !prepared.unattended {
        // The user asked for this one, so later changes to the drawing may
        // follow on their own in a trusted project.
        remember_hand_rendered(root, &prepared.source);
    }
    Ok(FigureRefresh::Rendered)
}

/// Stage one of rendering a figure's drawing again: everything but the write,
/// so the caller holds the project's lease only for `install_figure_refresh`.
/// `unattended` is a change the watcher noticed rather than a user's click.
pub fn prepare_figure_refresh(
    root: &Path, source: &str, unattended: bool,
) -> Result<RefreshPlan, String> {
    prepare(root, source, unattended, &run_tool)
}

/// Stage two: the write, under the project's lease.
pub fn install_figure_refresh(
    root: &Path, prepared: &PreparedRefresh,
) -> Result<FigureRefresh, String> {
    install_prepared(root, prepared)
}

/// Both stages at once, as a user's click runs them: the tests' way in.
#[cfg(test)]
fn refresh(root: &Path, source: &str, render: Render) -> Result<FigureRefresh, String> {
    match prepare(root, source, false, render)? {
        RefreshPlan::Ready(prepared) => install_prepared(root, &prepared),
        RefreshPlan::NoFigure => Ok(FigureRefresh::NoFigure),
        RefreshPlan::AwaitingConsent => Ok(FigureRefresh::AwaitingConsent),
    }
}

/// A copied-in drawing's name: no line breaks, TeX specials or leading dot or dash.
fn copy_name(name: &str) -> String {
    let path = Path::new(name);
    let extension = path.extension().and_then(OsStr::to_str).unwrap_or("svg");
    let stem = path.file_stem().and_then(OsStr::to_str).unwrap_or_default();
    let safe: String =
        stem.chars().map(|c| if tex_safe(&c.to_string()) && c != '/' { c } else { '_' }).collect();
    let safe = safe.trim_start_matches(['.', '-', ' ']);
    let safe = if safe.is_empty() { "figure" } else { safe };
    format!("{safe}.{}", extension.to_ascii_lowercase())
}

/// The `figures/` folder, made when missing; a link there is refused.
fn figures_folder(root: &Path) -> Result<PathBuf, String> {
    let folder = safe_path(root, "figures")?;
    match fs::create_dir(&folder) {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => return Err(err(error)),
        _ => {}
    }
    if !folder.symlink_metadata().map_err(err)?.is_dir() {
        return Err("A project path component is not a folder.".to_string());
    }
    Ok(folder)
}

/// Saves a copied-in drawing under `figures/`, at a name free for it and every
/// file made from it, and returns its path relative to the project.
fn save_drawing(root: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let folder = figures_folder(root)?;
    let name = copy_name(name);
    for candidate in numbered(&name) {
        let stem = figure_stem(OsStr::new(&candidate));
        let path = folder.join(&candidate);
        let blocked = ["tex", "pdf", "pdf_tex"]
            .iter()
            .any(|ext| taken(&folder.join(format!("{stem}.{ext}"))));
        if blocked || taken(&path) {
            continue;
        }
        match write_new(&path, bytes) {
            Ok(()) => return relative_to(&root.canonicalize().map_err(err)?, &path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                let _ = fs::remove_file(&path);
                return Err(err(error));
            }
        }
    }
    Err(NO_FREE_NAME.to_string())
}

/// Saves a drawing pasted as a file into `figures/`, then makes it a figure.
pub fn import_drawing_file(root: &Path, name: &str, data: &str) -> Result<ImportedFigure, String> {
    let name = validate_entry_name(name)?;
    if tool_for(Path::new(name)).is_none() {
        return Err(not_a_drawing(name));
    }
    let data = data.trim();
    // Checked before decoding, so an oversized paste is never held twice.
    if (data.len() / 4 * 3) as u64 > MAX_DRAWING_BYTES + 3 {
        return Err(TOO_LARGE.to_string());
    }
    let bytes = STANDARD.decode(data).map_err(err)?;
    if bytes.len() as u64 > MAX_DRAWING_BYTES {
        return Err(TOO_LARGE.to_string());
    }
    let source = save_drawing(root, name, &bytes)?;
    make_editable_figure(root, &source)
}

/// A drawing dropped from outside: copied into `figures/`, or used where it is if already in the project.
pub fn import_drawing_path(root: &Path, dropped: &str) -> Result<ImportedFigure, String> {
    let from = Path::new(dropped);
    let regular = fs::metadata(from).is_ok_and(|metadata| metadata.is_file());
    if !from.is_absolute() || tool_for(from).is_none() || !regular {
        return Err(not_a_drawing(dropped));
    }
    let canonical_root = root.canonicalize().map_err(err)?;
    let canonical = from.canonicalize().map_err(err)?;
    if canonical.starts_with(&canonical_root) {
        return make_editable_figure(root, &relative_to(&canonical_root, &canonical)?);
    }
    let name = from.file_name().and_then(OsStr::to_str).unwrap_or("figure.svg");
    let mut bytes = Vec::new();
    let read =
        File::open(from).and_then(|file| file.take(MAX_DRAWING_BYTES + 1).read_to_end(&mut bytes));
    if let Err(error) = read {
        // A cloud drive answers so for a file it has not downloaded yet.
        if error.raw_os_error() == Some(60) {
            return Err(format!("{name} is not on this computer yet. Download it from your cloud drive and try again."));
        }
        return Err(err(error));
    }
    if bytes.len() as u64 > MAX_DRAWING_BYTES {
        return Err(TOO_LARGE.to_string());
    }
    let source = save_drawing(root, name, &bytes)?;
    make_editable_figure(root, &source)
}

/// The path of the one file copied in the system's file manager. A webview's
/// paste gives its name, but on macOS it cannot read the file.
pub fn clipboard_file_path() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", "POSIX path of (the clipboard as \u{ab}class furl\u{bb})"])
        .output()
        .ok()?;
    let path = String::from_utf8(output.stdout).ok()?;
    let path = path.trim_end_matches('\n');
    (output.status.success() && !path.is_empty()).then(|| path.to_string())
}
