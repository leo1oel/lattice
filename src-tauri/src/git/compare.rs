//! Any two versions side by side: which files changed between them, one
//! file's text at each, and either version written out whole for a build (the
//! PDF with changes marked typesets the newer one with the older beside it).
//!
//! A side is a commit hash, or `None` for the files as they are now, so the
//! newer side of a comparison can include what has not been saved as a
//! version yet.

use super::parse::parse_name_status_z;
use super::{
    ensure_repository, git_command, git_output, is_binary_path, is_internal_path,
    normalize_relative, nul_separated, show_blob_bytes, validate_rev, GitFileDiff, GitLogFile,
};
use crate::project;
use std::fs;
use std::path::Path;
use std::process::Stdio;

/// The files that differ between `from` and `to` (now, when `None`). Against
/// now, files git does not track yet but would record in the next version
/// count as added.
pub fn compare_files(root: &Path, from: &str, to: Option<&str>) -> Result<Vec<GitLogFile>, String> {
    ensure_repository(root)?;
    let from = validate_rev(from)?;
    let to = to.map(validate_rev).transpose()?;
    let mut args =
        vec!["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", from.as_str()];
    args.extend(to.as_deref());
    args.push("--");
    let mut files = parse_name_status_z(&git_output(root, &args)?);
    if to.is_none() {
        let untracked = git_output(root, &["ls-files", "-z", "--others", "--exclude-standard"])?;
        files.extend(nul_separated(&untracked).filter(|path| !is_internal_path(path)).map(
            |path| GitLogFile { path: path.to_string(), kind: "added".to_string(), old_path: None },
        ));
    }
    Ok(files)
}

/// One file as `from` left it (at `from_path`, when it was renamed since) and
/// as `to` (or the disk, when `None`) has it; a side where the file does not
/// exist is `None`.
pub fn compare_file(
    root: &Path, from: &str, to: Option<&str>, path: &str, from_path: Option<&str>,
) -> Result<GitFileDiff, String> {
    ensure_repository(root)?;
    let from = validate_rev(from)?;
    let to = to.map(validate_rev).transpose()?;
    let relative = normalize_relative(path)?;
    let from_relative = from_path.map(normalize_relative).transpose()?.unwrap_or(relative.clone());
    let on_disk = project::safe_path(root, &relative)?;
    if is_binary_path(&relative) {
        return Ok(GitFileDiff { before: None, after: None, binary: true });
    }
    let before = show_blob_bytes(root, &format!("{from}:{from_relative}"));
    let after = match to {
        Some(to) => show_blob_bytes(root, &format!("{to}:{relative}")),
        None => fs::read(on_disk).ok(),
    };
    Ok(GitFileDiff::from_blobs(before, after))
}

/// Write the project's files as `rev` left them, or as they are now when
/// `None`, under `destination`: what git records, without Lattice's own state
/// or anything the project ignores (build output among it).
pub fn write_version(root: &Path, rev: Option<&str>, destination: &Path) -> Result<(), String> {
    ensure_repository(root)?;
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    match rev {
        Some(rev) => {
            let rev = validate_rev(rev)?;
            // Streamed: a project's figures can run to hundreds of megabytes.
            let mut child = git_command(root)
                .args(["archive", "--format=tar", &rev])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| format!("Could not run git: {error}"))?;
            let unpacked =
                child.stdout.take().map(|stdout| tar::Archive::new(stdout).unpack(destination));
            let output =
                child.wait_with_output().map_err(|error| format!("Could not run git: {error}"))?;
            if !output.status.success() {
                return Err(crate::commands::stderr_or(&output, "git archive failed."));
            }
            unpacked
                .unwrap_or(Ok(()))
                .map_err(|error| format!("Could not unpack the version: {error}"))
        }
        None => {
            let listed = git_output(
                root,
                &["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            )?;
            for name in nul_separated(&listed).filter(|name| !is_internal_path(name)) {
                let source = root.join(name);
                // Listed by the index but deleted on disk since: not in the version now.
                if !source.is_file() {
                    continue;
                }
                let target = destination.join(name);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::copy(&source, &target)
                    .map_err(|error| format!("Could not copy {name}: {error}"))?;
            }
            Ok(())
        }
    }
}
