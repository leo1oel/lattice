use crate::commands;
use crate::project;
use crate::project_fs::ProjectDir;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// TeX Live's latexindent is a `#!/usr/bin/env perl` script that needs
/// YAML::Tiny, which only the Perl macOS ships carries (in its Extras). Left to
/// the search path, a Homebrew perl without it could run the script instead.
const SYSTEM_PERL: &str = "/usr/bin/perl";
/// latexindent also needs File::HomeDir, which no macOS Perl ships, for one
/// `my_home` call (where it looks for indentconfig.yaml). This stand-in, under
/// Lattice's Application Support folder, answers it so formatting needs
/// nothing installed.
const HOME_DIR_MODULE: &str = "perl5/File/HomeDir.pm";
const HOME_DIR_STAND_IN: &str = "\
# Lattice's stand-in for File::HomeDir: latexindent only calls my_home.
package File::HomeDir;
use strict;
our $VERSION = '0';
sub my_home { return defined $ENV{HOME} ? $ENV{HOME} : ( getpwuid($<) )[7]; }
1;
";

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
            "latexindent is not installed. Install MacTeX/TeX Live tools, then retry.".to_string()
        );
    }
    let _ = project::safe_path(root, &relative)?;
    let mut child = latexindent()?
        .current_dir(root)
        .args(["-g=/dev/null", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start latexindent: {error}"))?;
    // Taken, so the pipe closes and latexindent sees the end of its input.
    child
        .stdin
        .take()
        .ok_or_else(|| "Could not open latexindent stdin.".to_string())?
        .write_all(text.as_bytes())
        .map_err(|error| format!("Could not write to latexindent: {error}"))?;
    let output =
        child.wait_with_output().map_err(|error| format!("latexindent failed: {error}"))?;
    if !output.status.success() {
        return Err(commands::stderr_or(&output, "latexindent failed."));
    }
    String::from_utf8(output.stdout).map_err(|error| format!("Invalid latexindent output: {error}"))
}

/// latexindent found the way compile finds latexmk: a Finder launch's PATH
/// holds none of the TeX directories.
fn latexindent() -> Result<Command, String> {
    let latexindent = commands::resolve("latexindent");
    if !is_perl_script(&latexindent) || !Path::new(SYSTEM_PERL).is_file() {
        return Ok(commands::command("latexindent"));
    }
    let mut command = commands::with_child_path(Command::new(SYSTEM_PERL));
    command.arg(latexindent).env("PERL5LIB", perl_lib()?);
    Ok(command)
}

fn is_perl_script(path: &Path) -> bool {
    let mut head = [0_u8; 128];
    let length = fs::File::open(path).and_then(|mut file| file.read(&mut head)).unwrap_or(0);
    let first_line = head[..length].split(|byte| *byte == b'\n').next().unwrap_or_default();
    first_line.starts_with(b"#!") && first_line.windows(4).any(|word| word == b"perl")
}

/// Any PERL5LIB the user set comes first, so a File::HomeDir they installed
/// still wins; the stand-in only precedes Perl's own directories.
fn perl_lib() -> Result<OsString, String> {
    let support = commands::app_support_dir()
        .ok_or_else(|| "Could not locate your macOS Application Support folder.".to_string())?;
    if fs::read_to_string(support.join(HOME_DIR_MODULE)).ok().as_deref() != Some(HOME_DIR_STAND_IN)
    {
        fs::create_dir_all(&support)
            .map_err(|error| format!("Could not create {}: {error}", support.display()))?;
        ProjectDir::open(&support)?.atomic_write(HOME_DIR_MODULE, HOME_DIR_STAND_IN.as_bytes())?;
    }
    let mut directories: Vec<PathBuf> =
        env::var_os("PERL5LIB").map(|value| env::split_paths(&value).collect()).unwrap_or_default();
    directories.push(support.join("perl5"));
    env::join_paths(directories).map_err(|error| format!("Invalid PERL5LIB: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_tex_paths() {
        let root = crate::test_support::TempDir::new("format");
        let error = format_document(&root, "notes.md", "hello").unwrap_err();
        assert!(error.contains("supports"));
    }
}
