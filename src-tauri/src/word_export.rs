//! Editable Word export through Pandoc. No shell, filters or TeX execution.
use crate::{commands, export};
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordExport {
    pub path: String,
    pub warnings: String,
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn export_word(
    root: &Path, relative: &str, bibliography: &str, destination: &Path,
) -> Result<WordExport, String> {
    let destination = export::destination(destination, &export::DOCX)?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let source = inside(&root, relative)?;
    if source.extension().and_then(|e| e.to_str()) != Some("tex") {
        return Err("Word export requires a main .tex document.".into());
    }
    // Converting to a temporary file preserves any previous export on failure.
    let scratch =
        Scratch(std::env::temp_dir().join(format!("lattice-word-{}", uuid::Uuid::new_v4())));
    fs::create_dir(&scratch.0).map_err(|e| e.to_string())?;
    let output = scratch.0.join("paper.docx");
    let diagnostics = scratch.0.join("pandoc.log");
    let log = fs::File::create(&diagnostics).map_err(|e| e.to_string())?;
    let mut command = commands::command("pandoc");
    command
        .current_dir(&root)
        .args(["--from=latex", "--to=docx", "--standalone", "--citeproc"])
        .arg("--resource-path")
        .arg(
            std::env::join_paths([root.as_path(), source.parent().unwrap_or(&root)])
                .map_err(|e| e.to_string())?,
        )
        .arg("--output")
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
    if !bibliography.is_empty() && root.join(bibliography).exists() {
        command.arg("--bibliography").arg(inside(&root, bibliography)?);
    }
    command.arg(&source);
    let mut child = command.spawn().map_err(|e| format!("Could not start Word export: {e}. Install Pandoc from https://pandoc.org/installing.html and restart Lattice."))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(120) => {
                std::thread::sleep(Duration::from_millis(100))
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(e) => e.to_string(),
                    _ => "Word export exceeded two minutes. The previous export was preserved."
                        .into(),
                });
            }
        }
    };
    let mut warnings = String::new();
    fs::File::open(diagnostics)
        .map_err(|e| e.to_string())?
        .take(32768)
        .read_to_string(&mut warnings)
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("Word export failed ({status}).\n{warnings}"));
    }
    if fs::metadata(&output).map_err(|e| e.to_string())?.len() > 100 * 1024 * 1024 {
        return Err("The Word document exceeds 100 MB.".into());
    }
    let bytes = fs::read(output).map_err(|e| e.to_string())?;
    let path = export::save(&destination, &bytes, &export::DOCX)?;
    Ok(WordExport { path, warnings })
}

fn inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = root.join(relative).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("Word export source must be a file inside the project.".into());
    }
    Ok(path)
}
