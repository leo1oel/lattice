//! Running the installed drawing program. A drawing can come from anywhere
//! (a paste, a drop, a collaborator's push), so the program is found only at
//! its standard install location, gets its arguments without a shell, writes
//! only into a private scratch folder, and is stopped with everything it
//! started when it takes too long. What a drawing may make the program read
//! is svg_links.rs.

use crate::commands::{
    host_environment, in_new_process_group, signal_process_group, track_process_group, KILL_SIGNAL,
};
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
    host_environment(&mut command)
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
