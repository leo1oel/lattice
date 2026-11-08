//! Figures kept as a drawing in another program's format: an installed
//! converter renders the drawing, and an entry `.tex` that names it on its
//! first line (docs/editable-figures.md) includes the result. Only programs
//! at their standard install locations run; nothing in a project names one.

use super::editable_figure::ImportedFigure;
use super::paths::{relative_to, safe_path, validate_entry_name};
use crate::util::err;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CONVERT_TIMEOUT: Duration = Duration::from_secs(90);
/// The most of the text block's height a figure may take, leaving room for its caption.
const MAX_TEXT_HEIGHT: f64 = 0.8;

#[derive(Debug, Clone, Copy, PartialEq)]
struct NaturalSize {
    width: f64,
    height: f64,
}

const SOURCE_HEADER: &str = "% editable-figure source: ";

#[derive(Debug, Clone, Copy, PartialEq)]
enum Tool {
    Inkscape,
    DrawIo,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Tool::Inkscape => "Inkscape",
            Tool::DrawIo => "draw.io",
        }
    }
}

fn tool_for(source: &Path) -> Option<Tool> {
    match source.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "svg" => Some(Tool::Inkscape),
        "drawio" | "dio" => Some(Tool::DrawIo),
        _ => None,
    }
}

fn install_locations(tool: Tool) -> Vec<PathBuf> {
    let mut places = Vec::new();
    match tool {
        Tool::Inkscape => {
            places.push("/Applications/Inkscape.app/Contents/MacOS/inkscape".into());
            places.push("/usr/bin/inkscape".into());
            places.push("/usr/local/bin/inkscape".into());
            places.push(r"C:\Program Files\Inkscape\bin\inkscape.exe".into());
        }
        Tool::DrawIo => {
            places.push("/Applications/draw.io.app/Contents/MacOS/draw.io".into());
            places.push("/usr/bin/drawio".into());
            places.push("/opt/drawio/drawio".into());
            places.push(r"C:\Program Files\draw.io\draw.io.exe".into());
        }
    }
    places
}

fn find_tool(tool: Tool) -> Result<PathBuf, String> {
    install_locations(tool)
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("Install {} to update this figure.", tool.name()))
}

fn convert_args(tool: Tool, source: &Path, pdf: &Path, page: u32) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    match tool {
        Tool::Inkscape => {
            args.push(source.into());
            args.push("--export-type=pdf".into());
            args.push("--export-latex".into());
            // The drawing itself, not the whole page it sits on.
            args.push("--export-area-drawing".into());
            let mut output = OsString::from("--export-filename=");
            output.push(pdf);
            args.push(output);
        }
        Tool::DrawIo => {
            for flag in ["-x", "-f", "pdf", "--crop", "-o"] {
                args.push(flag.into());
            }
            args.push(pdf.into());
            args.push("-p".into());
            args.push(page.to_string().into());
            args.push(source.into());
        }
    }
    args
}

/// A name LaTeX takes as it is: no extension, other characters as `_`.
fn figure_stem(name: &OsStr) -> String {
    let name = Path::new(name).file_stem().and_then(OsStr::to_str).unwrap_or("figure");
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    let safe = safe.trim_start_matches(['.', '_']);
    if safe.is_empty() {
        "figure".to_string()
    } else {
        safe.to_string()
    }
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
    Some(NaturalSize { width, height: width * ratio.trim().parse::<f64>().ok()? })
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
            Some(NaturalSize { width: right - left, height: top - bottom })
        }
        _ => None,
    }
}

fn run_tool(tool: Tool, source: &Path, pdf: &Path, page: u32) -> Result<(), String> {
    let mut child = Command::new(find_tool(tool)?)
        .args(convert_args(tool, source, pdf, page))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(err)?;
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.read_to_string(&mut text);
        }
        text
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(err)? {
            break status;
        }
        if started.elapsed() > CONVERT_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{} took too long to convert the figure.", tool.name()));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let detail = reader.join().unwrap_or_default();
    if status.success() && pdf.is_file() {
        return Ok(());
    }
    let tail: String = detail.lines().rev().take(4).collect::<Vec<_>>().join(" ");
    Err(format!("{} could not convert the figure. {tail}", tool.name()))
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

const PAGE_HEADER: &str = "% editable-figure page: ";

/// The page an entry's second line chooses, for a drawing of several; the first by default.
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

/// The names of a draw.io file's pages, in order.
fn diagram_names(drawing: &str) -> Vec<String> {
    drawing
        .split("<diagram ")
        .skip(1)
        .map(|tag| {
            let tag = tag.split('>').next().unwrap_or_default();
            tag.split(" name=\"")
                .nth(1)
                .or_else(|| tag.strip_prefix("name=\""))
                .and_then(|rest| rest.split('"').next())
                .unwrap_or_default()
                .to_string()
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

struct Figure {
    tool: Tool,
    source: PathBuf,
    folder: PathBuf,
    stem: String,
    ours: bool,
    source_name: String,
}

/// The stem a drawing's outputs go under: the one whose entry already names it,
/// else the first with no file in the way, so someone else's files stay as they are.
fn figure_slot(folder: &Path, base: &str, source_name: &str) -> (String, bool) {
    (1..)
        .map(|n| if n == 1 { base.to_string() } else { format!("{base}-{n}") })
        .find_map(|stem| {
            if names_source(&folder.join(format!("{stem}.tex")), source_name) {
                return Some((stem, true));
            }
            let free = ["tex", "pdf", "pdf_tex"]
                .iter()
                .all(|ext| !folder.join(format!("{stem}.{ext}")).exists());
            free.then_some((stem, false))
        })
        .unwrap_or_else(|| (base.to_string(), false))
}

fn figure_of(root: &Path, source: &str) -> Result<Figure, String> {
    let path = safe_path(root, source)?;
    let tool =
        tool_for(&path).ok_or_else(|| format!("{source} is not a drawing Lattice can convert."))?;
    if !path.is_file() {
        return Err(format!("{source} could not be found."));
    }
    let folder =
        path.parent().ok_or_else(|| format!("{source} could not be found."))?.to_path_buf();
    let file_name = path.file_name().ok_or_else(|| format!("{source} could not be found."))?;
    let source_name = file_name.to_string_lossy().to_string();
    let (stem, ours) = figure_slot(&folder, &figure_stem(file_name), &source_name);
    Ok(Figure { tool, stem, ours, source_name, folder, source: path })
}

fn names_source(entry: &Path, source_name: &str) -> bool {
    fs::read_to_string(entry)
        .is_ok_and(|text| text.lines().next() == Some(&format!("{SOURCE_HEADER}{source_name}")))
}

/// Renders a drawing and writes its entry, for a document to include.
pub fn make_editable_figure(root: &Path, source: &str) -> Result<ImportedFigure, String> {
    let figure = figure_of(root, source)?;
    let entry = figure.folder.join(format!("{}.tex", figure.stem));
    let page = fs::read_to_string(&entry).map_or(1, |text| chosen_page(&text));
    run_tool(
        figure.tool,
        &figure.source,
        &figure.folder.join(format!("{}.pdf", figure.stem)),
        page,
    )?;
    let names = match figure.tool {
        Tool::DrawIo => diagram_names(&fs::read_to_string(&figure.source).map_err(err)?),
        Tool::Inkscape => Vec::new(),
    };
    let canonical_root = root.canonicalize().map_err(err)?;
    let directory = relative_to(&canonical_root, &figure.folder.canonicalize().map_err(err)?)?;
    let natural = match figure.tool {
        Tool::Inkscape => {
            fs::read_to_string(figure.folder.join(format!("{}.pdf_tex", figure.stem)))
                .ok()
                .and_then(|text| pdf_tex_size(&text))
        }
        Tool::DrawIo => fs::read(figure.folder.join(format!("{}.pdf", figure.stem)))
            .ok()
            .and_then(|bytes| pdf_size(&bytes)),
    };
    fs::write(
        &entry,
        entry_text(
            figure.tool,
            &figure.source_name,
            &directory,
            &figure.stem,
            &page_line(page, &names),
            natural,
        ),
    )
    .map_err(err)?;
    let packages = match figure.tool {
        Tool::Inkscape => {
            let pdf_tex = figure.folder.join(format!("{}.pdf_tex", figure.stem));
            pdf_tex_packages(&fs::read_to_string(pdf_tex).map_err(err)?)
        }
        Tool::DrawIo => vec!["graphicx".to_string()],
    };
    Ok(ImportedFigure {
        directory,
        entry: format!("{}.tex", figure.stem),
        source: source.to_string(),
        packages,
    })
}

/// A name in `folder` for a drawing, free for it and every file made from it.
fn free_drawing_path(folder: &Path, name: &str) -> PathBuf {
    let original = Path::new(name);
    let base = original.file_stem().and_then(OsStr::to_str).unwrap_or("figure");
    let extension = original.extension().and_then(OsStr::to_str).unwrap_or("svg");
    (1..)
        .map(|n| if n == 1 { name.to_string() } else { format!("{base}-{n}.{extension}") })
        .map(|candidate| folder.join(candidate))
        .find(|path| {
            let stem = figure_stem(path.file_name().unwrap_or_default());
            !path.exists()
                && ["tex", "pdf", "pdf_tex"]
                    .iter()
                    .all(|ext| !folder.join(format!("{stem}.{ext}")).exists())
        })
        .unwrap_or_else(|| folder.join(name))
}

/// Saves a drawing pasted as a file into `figures/`, then makes it a figure.
pub fn import_drawing_file(root: &Path, name: &str, data: &str) -> Result<ImportedFigure, String> {
    let name = validate_entry_name(name)?;
    if tool_for(Path::new(name)).is_none() {
        return Err(format!("{name} is not a drawing Lattice can convert."));
    }
    let bytes = STANDARD.decode(data.trim()).map_err(err)?;
    let target = root.join("figures");
    fs::create_dir_all(&target).map_err(err)?;
    let path = free_drawing_path(&target, name);
    fs::write(&path, bytes).map_err(err)?;
    let canonical_root = root.canonicalize().map_err(err)?;
    let source = relative_to(&canonical_root, &path.canonicalize().map_err(err)?)?;
    make_editable_figure(root, &source)
}

/// A drawing dropped from outside: copied into `figures/`, or used where it is if already in the project.
pub fn import_drawing_path(root: &Path, dropped: &str) -> Result<ImportedFigure, String> {
    let from = Path::new(dropped);
    if tool_for(from).is_none() || !from.is_file() {
        return Err(format!("{dropped} is not a drawing Lattice can convert."));
    }
    let canonical_root = root.canonicalize().map_err(err)?;
    let canonical = from.canonicalize().map_err(err)?;
    if canonical.starts_with(&canonical_root) {
        return make_editable_figure(root, &relative_to(&canonical_root, &canonical)?);
    }
    let name = from.file_name().and_then(OsStr::to_str).unwrap_or("figure.svg");
    let target = root.join("figures");
    fs::create_dir_all(&target).map_err(err)?;
    let path = free_drawing_path(&target, name);
    if let Err(error) = fs::copy(from, &path) {
        let _ = fs::remove_file(&path);
        // A cloud drive answers so for a file it has not downloaded yet.
        if error.raw_os_error() == Some(60) {
            return Err(format!("{name} is not on this computer yet. Download it from your cloud drive and try again."));
        }
        return Err(err(error));
    }
    make_editable_figure(root, &relative_to(&canonical_root, &path.canonicalize().map_err(err)?)?)
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

/// Renders a drawing again when an entry beside it names it; false when none does.
pub fn refresh_figure_source(root: &Path, source: &str) -> Result<bool, String> {
    let figure = figure_of(root, source)?;
    let entry = figure.folder.join(format!("{}.tex", figure.stem));
    if !figure.ours {
        return Ok(false);
    }
    let page = fs::read_to_string(&entry).map_or(1, |text| chosen_page(&text));
    run_tool(
        figure.tool,
        &figure.source,
        &figure.folder.join(format!("{}.pdf", figure.stem)),
        page,
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    #[test]
    fn knows_each_drawing_format_and_no_other() {
        assert_eq!(tool_for(Path::new("a.SVG")), Some(Tool::Inkscape));
        assert_eq!(tool_for(Path::new("a.drawio")), Some(Tool::DrawIo));
        assert_eq!(tool_for(Path::new("a.dio")), Some(Tool::DrawIo));
        assert_eq!(tool_for(Path::new("a.reactio")), None);
        assert_eq!(tool_for(Path::new("a")), None);
    }

    #[test]
    fn builds_each_command_with_paths_as_single_arguments() {
        let args =
            convert_args(Tool::Inkscape, Path::new("/p/a b.svg"), Path::new("/p/a_b.pdf"), 1);
        assert_eq!(args[0], "/p/a b.svg");
        assert!(args.contains(&OsString::from("--export-latex")));
        assert!(args.contains(&OsString::from("--export-area-drawing")));
        assert!(args.contains(&OsString::from("--export-filename=/p/a_b.pdf")));
        let args = convert_args(Tool::DrawIo, Path::new("/p/a.drawio"), Path::new("/p/a.pdf"), 3);
        assert_eq!(args.last().unwrap(), "/p/a.drawio");
        assert!(args.windows(2).any(|pair| pair[0] == "-o" && pair[1] == "/p/a.pdf"));
        assert!(args.windows(2).any(|pair| pair[0] == "-p" && pair[1] == "3"));
    }

    #[test]
    fn writes_the_entry_for_each_tool() {
        assert_eq!(
            entry_text(Tool::DrawIo, "a.drawio", "figures", "a", "", None),
            "% editable-figure source: a.drawio\n\\includegraphics{a.pdf}\n"
        );
        assert_eq!(
            entry_text(Tool::Inkscape, "my a.svg", "figures", "my_a", "", None),
            "% editable-figure source: my a.svg\n\\input{figures/my_a.pdf_tex}\n"
        );
        assert_eq!(figure_stem(OsStr::new("My scheme.v2.drawio")), "My_scheme.v2");
    }

    #[test]
    fn a_pasted_file_must_be_a_drawing_with_a_plain_name() {
        let fixture = Fixture::project("figure-paste-file");
        assert!(import_drawing_file(&fixture.root, "run.command", "eA==").is_err());
        assert!(import_drawing_file(&fixture.root, "../a.svg", "eA==").is_err());
        assert!(!fixture.root.join("figures/run.command").exists());
    }

    #[test]
    fn a_dropped_file_must_be_a_drawing() {
        let fixture = Fixture::project("figure-drop");
        let script = fixture.outside("run.command", "#!/bin/sh");
        assert!(import_drawing_path(&fixture.root, &script.to_string_lossy()).is_err());
        assert!(!fixture.root.join("figures/run.command").exists());
    }

    #[test]
    fn asks_for_colour_packages_only_when_the_text_uses_them() {
        let fallback = "  \\providecommand\\color[2][]{%\n  \\providecommand\\transparent[1]{%\n";
        assert_eq!(pdf_tex_packages(fallback), ["graphicx"]);
        let used = format!("{fallback}\\put(0,0){{\\color[rgb]{{1,0,0}}\\transparent{{0.5}}A}}\n");
        assert_eq!(pdf_tex_packages(&used), ["graphicx", "xcolor", "transparent"]);
    }

    #[test]
    fn reads_a_drawings_pages_and_the_chosen_one() {
        let drawing = r#"<mxfile><diagram id="1" name="First"></diagram><diagram name="Two"></diagram></mxfile>"#;
        let names = diagram_names(drawing);
        assert_eq!(names, ["First", "Two"]);
        let line = page_line(2, &names);
        assert_eq!(line, "% editable-figure page: 2 (of 2: First, Two)\n");
        assert_eq!(chosen_page(&format!("% editable-figure source: a.drawio\n{line}x")), 2);
        assert_eq!(chosen_page("% editable-figure source: a.svg\n\\input{a}"), 1);
        assert_eq!(page_line(1, &names[..1]), "");
    }

    #[test]
    fn keeps_a_figure_inside_the_line_and_the_page() {
        let size =
            pdf_tex_size("\\setlength{\\unitlength}{600bp}%\n\\begin{picture}(1,1.5)%").unwrap();
        assert_eq!(size, NaturalSize { width: 600.0, height: 900.0 });
        assert_eq!(pdf_tex_size("nothing"), None);
        assert_eq!(
            pdf_size(b"x /MediaBox [0 0 612 792] y"),
            Some(NaturalSize { width: 612.0, height: 792.0 })
        );
        assert_eq!(pdf_size(b"nothing"), None);
        let inkscape = entry_text(Tool::Inkscape, "a.svg", "f", "a", "", Some(size));
        assert!(inkscape.contains(
            "\\ifdim\\linewidth<0.5333\\textheight\\linewidth\\else0.5333\\textheight\\fi"
        ));
        assert!(inkscape.contains("\\ifdim 600bp>\\figuremaxwidth\\let\\svgwidth\\figuremaxwidth\\fi\n\\input{f/a.pdf_tex}"));
        let drawio = entry_text(Tool::DrawIo, "a.drawio", "f", "a", "", Some(size));
        assert!(drawio.contains(
            "\\includegraphics[width=\\figuremaxwidth]{a.pdf}\\else\\includegraphics{a.pdf}\\fi"
        ));
    }

    #[test]
    fn leaves_files_of_the_same_name_alone() {
        let fixture = Fixture::project("figure-taken");
        let folder = fixture.root.join("figures");
        fixture.write("figures/a.svg", "<svg/>");
        assert_eq!(figure_slot(&folder, "a", "a.svg"), ("a".to_string(), false));
        for foreign in ["a.pdf", "a.tex", "a.pdf_tex"] {
            fixture.write(&format!("figures/{foreign}"), "someone else's");
            assert_eq!(figure_slot(&folder, "a", "a.svg"), ("a-2".to_string(), false), "{foreign}");
        }
        fixture.write("figures/a-2.tex", "% editable-figure source: a.svg\nx\n");
        assert_eq!(figure_slot(&folder, "a", "a.svg"), ("a-2".to_string(), true));
        fixture.write("figures/b.pdf", "x");
        assert!(free_drawing_path(&folder, "b.svg").ends_with("b-2.svg"));
    }

    #[test]
    fn refreshes_only_a_drawing_an_entry_names_inside_the_project() {
        let fixture = Fixture::project("figure-converters");
        fixture.write("figures/plain.svg", "<svg/>");
        assert_eq!(refresh_figure_source(&fixture.root, "figures/plain.svg"), Ok(false));
        fixture.write("figures/a.tex", "\\section{Not a figure}");
        fixture.write("figures/a.svg", "<svg/>");
        assert_eq!(refresh_figure_source(&fixture.root, "figures/a.svg"), Ok(false));
        assert!(refresh_figure_source(&fixture.root, "../a.svg").is_err());
        assert!(refresh_figure_source(&fixture.root, "figures/a.tex").is_err());
    }
}
