use crate::commands;
use crate::project;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

pub fn format_document(root: &Path, relative_path: &str, text: &str) -> Result<String, String> {
    // Validate the input before checking tooling, so an unsupported path always
    // reports the same reason whether or not latexindent happens to be installed.
    let relative = relative_path.trim().replace('\\', "/");
    if relative.is_empty()
        || !(relative.ends_with(".tex") || relative.ends_with(".cls") || relative.ends_with(".sty"))
    {
        return Err("Format currently supports .tex, .cls, and .sty files.".to_string());
    }
    if !commands::available("latexindent") {
        return Err(
            "latexindent is not installed. Install MacTeX/TeX Live tools, then retry.".to_string(),
        );
    }
    let _ = project::safe_path(root, &relative)?;
    let mut child = Command::new("latexindent")
        .current_dir(root)
        .args(["-g=/dev/null", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start latexindent: {error}"))?;
    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "Could not open latexindent stdin.".to_string())?;
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| format!("Could not write to latexindent: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("latexindent failed: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "latexindent failed.".to_string()
        } else {
            stderr
        });
    }
    String::from_utf8(output.stdout).map_err(|error| format!("Invalid latexindent output: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_non_tex_paths() {
        let root = std::env::temp_dir().join(format!("lattice-format-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let error = format_document(&root, "notes.md", "hello").unwrap_err();
        assert!(error.contains("supports"));
        let _ = fs::remove_dir_all(root);
    }
}
