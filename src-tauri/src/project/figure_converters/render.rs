//! Running the installed drawing program, and what a drawing may make it read.
//! A drawing can come from anywhere (a paste, a drop, a collaborator's push),
//! so the program is found only at its standard install location, gets its
//! arguments without a shell, writes only into a private scratch folder, and
//! is stopped with everything it started when it takes too long.

use crate::commands::{
    in_new_process_group, signal_process_group, track_process_group, KILL_SIGNAL,
};
use crate::project::paths::{safe_path, NOT_FOUND};
use crate::util::err;
use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CONVERT_TIMEOUT: Duration = Duration::from_secs(90);
/// What of the program's complaints is kept for the error message.
const MAX_STDERR_BYTES: u64 = 64 * 1024;

/// One conversion at a time: a pull that changes many drawings queues them
/// instead of starting a program for each at once.
static CONVERTING: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Tool {
    Inkscape,
    DrawIo,
}

impl Tool {
    pub(super) fn name(self) -> &'static str {
        match self {
            Tool::Inkscape => "Inkscape",
            Tool::DrawIo => "draw.io",
        }
    }
}

pub(super) fn tool_for(source: &Path) -> Option<Tool> {
    match source.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "svg" => Some(Tool::Inkscape),
        "drawio" | "dio" => Some(Tool::DrawIo),
        _ => None,
    }
}

/// Absolute, fixed places only: never `PATH`, never anything a project names.
fn install_locations(tool: Tool) -> &'static [&'static str] {
    match tool {
        Tool::Inkscape => &[
            "/Applications/Inkscape.app/Contents/MacOS/inkscape",
            "/usr/bin/inkscape",
            "/usr/local/bin/inkscape",
            r"C:\Program Files\Inkscape\bin\inkscape.exe",
        ],
        Tool::DrawIo => &[
            "/Applications/draw.io.app/Contents/MacOS/draw.io",
            "/usr/bin/drawio",
            "/opt/drawio/drawio",
            r"C:\Program Files\draw.io\draw.io.exe",
        ],
    }
}

fn find_tool(tool: Tool) -> Result<PathBuf, String> {
    install_locations(tool)
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_absolute() && path.is_file())
        .ok_or_else(|| format!("Install {} to update this figure.", tool.name()))
}

/// Each path is one argument and absolute, so a file named `-x.svg` stays a
/// file name; the page is a number.
pub(super) fn convert_args(tool: Tool, source: &Path, pdf: &Path, page: u32) -> Vec<OsString> {
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

/// Renders `source` to `pdf` (in a scratch folder) with the installed program.
pub(super) fn run_tool(tool: Tool, source: &Path, pdf: &Path, page: u32) -> Result<(), String> {
    // Absolute, so neither can be read as an option (`safe_path` and the scratch folder give these).
    debug_assert!(source.is_absolute() && pdf.is_absolute());
    let program = find_tool(tool)?;
    let _turn = CONVERTING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut command = Command::new(program);
    command
        .args(convert_args(tool, source, pdf, page))
        // Anything the program writes beside its output stays in the scratch folder.
        .current_dir(pdf.parent().unwrap_or(pdf))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // Its own group, so a timeout also stops what it started (draw.io's helpers).
    in_new_process_group(&mut command);
    let mut child = command.spawn().map_err(err)?;
    let _group = track_process_group(&mut child).map_err(err)?;
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut kept = Vec::new();
        if let Some(mut stream) = stderr {
            let _ = (&mut stream).take(MAX_STDERR_BYTES).read_to_end(&mut kept);
            // Keep draining so the program never blocks on a full pipe.
            let _ = io::copy(&mut stream, &mut io::sink());
        }
        String::from_utf8_lossy(&kept).into_owned()
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() <= CONVERT_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(100))
            }
            Ok(None) => break Err(format!("{} took too long to convert the figure.", tool.name())),
            Err(error) => break Err(err(error)),
        }
    };
    // Whatever is left of the group goes too, which also closes the pipe.
    signal_process_group(child.id(), KILL_SIGNAL);
    let _ = child.kill();
    let _ = child.wait();
    let detail = reader.join().unwrap_or_default();
    let status = status?;
    if status.success() && pdf.is_file() {
        return Ok(());
    }
    let tail: String = detail.lines().rev().take(4).collect::<Vec<_>>().join(" ");
    Err(format!("{} could not convert the figure. {tail}", tool.name()))
}

/// `text` with XML's character references and predefined entities read, once,
/// so `&#102;ile:` is checked as `file:`.
fn decode_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        rest = &rest[index..];
        let decoded = rest.find(';').filter(|&end| end <= 12).and_then(|end| {
            let name = &rest[1..end];
            let character = match name {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "amp" => Some('&'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .map(|hex| u32::from_str_radix(hex, 16))
                    .or_else(|| name.strip_prefix('#').map(str::parse))
                    .and_then(Result::ok)
                    .and_then(char::from_u32),
            }?;
            Some((character, end + 1))
        });
        match decoded {
            Some((character, length)) => {
                out.push(character);
                rest = &rest[length..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The value after `at`: `="…"` or `='…'`, when that is what follows.
fn attribute_value(text: &str, at: usize) -> Option<&str> {
    let rest = text[at..].trim_start().strip_prefix('=')?.trim_start();
    let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    rest[1..].split(quote).next()
}

/// Whether the tag open at the end of `before` is a hyperlink (`<a>`), whose
/// target becomes a link in the PDF and is never fetched.
fn in_hyperlink(before: &str) -> bool {
    let Some(open) = before.rfind('<') else { return false };
    let name = before[open + 1..].split(|c: char| c.is_whitespace() || c == '>').next();
    name.is_some_and(|name| name == "a" || name.ends_with(":a"))
}

/// Embedded images Inkscape decodes itself; an embedded SVG or style sheet
/// could carry links of its own, so those are refused.
const EMBEDDED_IMAGES: [&str; 7] = ["png", "jpeg", "jpg", "gif", "webp", "bmp", "tiff"];

/// Whether Inkscape following `link` from the drawing in `folder` reads only
/// the drawing itself, embedded data, or a real file inside the project.
fn link_stays_inside(root: &Path, folder: &str, link: &str) -> bool {
    let link = link.trim();
    if link.is_empty() || link.starts_with('#') {
        return true;
    }
    let lower: String = link.to_ascii_lowercase().split_whitespace().collect();
    if let Some(data) = lower.strip_prefix("data:") {
        return EMBEDDED_IMAGES.iter().any(|kind| {
            data.strip_prefix("image/")
                .and_then(|rest| rest.strip_prefix(kind))
                .is_some_and(|rest| rest.starts_with([';', ',']))
        });
    }
    // A scheme, a drive, an absolute or home path, or an escape Inkscape would decode.
    if link.contains([':', '\\', '%', '?']) || link.starts_with(['/', '~']) {
        return false;
    }
    // `other.svg#shape` reads `other.svg`.
    let file = link.split('#').next().unwrap_or_default();
    let mut parts: Vec<&str> = folder.split('/').filter(|part| !part.is_empty()).collect();
    for part in file.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return false;
                }
            }
            name => parts.push(name),
        }
    }
    if parts.is_empty() {
        return true;
    }
    // Real folders and files only: a link inside the project may lead out of it.
    match safe_path(root, &parts.join("/")) {
        Ok(_) => true,
        Err(error) => error == NOT_FOUND,
    }
}

/// Refuses a drawing that would make Inkscape read a file outside the
/// project, or anything over the network, into the figure: Inkscape embeds
/// a linked image in the PDF it writes, and follows `sodipodi:absref` when the
/// link fails. `folder` is the drawing's folder, relative to the project.
pub(super) fn check_svg_links(root: &Path, folder: &str, svg: &str) -> Result<(), String> {
    const OUTSIDE: &str = "This drawing links to a file outside the project. Embed the image in the drawing, or keep it inside the project.";
    let text = decode_xml(svg);
    let lower = text.to_ascii_lowercase();
    // An entity can name a file for the parser to read into the text.
    if lower.contains("<!entity") {
        return Err(OUTSIDE.to_string());
    }
    let mut links: Vec<&str> = Vec::new();
    for keyword in ["href", "absref"] {
        links.extend(
            lower
                .match_indices(keyword)
                .filter(|(at, _)| !in_hyperlink(&lower[..*at]))
                .filter_map(|(at, _)| attribute_value(&text, at + keyword.len())),
        );
    }
    links.extend(lower.match_indices("url(").filter_map(|(at, _)| {
        let value = text[at + 4..].split(')').next()?;
        Some(value.trim().trim_matches(['"', '\'']))
    }));
    links.extend(lower.match_indices("@import").filter_map(|(at, _)| {
        let rest = text[at + 7..].trim_start();
        let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        rest[1..].split(quote).next()
    }));
    if links.iter().all(|link| link_stays_inside(root, folder, link)) {
        Ok(())
    } else {
        Err(OUTSIDE.to_string())
    }
}
