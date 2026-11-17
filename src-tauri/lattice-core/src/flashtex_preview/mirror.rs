//! The copy of a project the host compiles.
//!
//! FlashTeX's host writes each buffer it is sent into its file under the
//! compile's root before compiling ("as saving would"), so pointing it at the
//! project would save the writer's unsaved text behind the editor's back. It
//! works in a copy instead. `fs::copy` clones on APFS, so even a project of
//! large figures copies in moments and costs no disk until a file changes.

use std::fs;
use std::path::{Component, Path};

/// Folders no build reads: version control, packages, and Lattice's own
/// (whose build folder is read separately, `session::latexmk_file`).
const SKIPPED: [&str; 4] = [".git", "node_modules", ".research", ".DS_Store"];

/// Past this many files the project is not one a preview should copy.
const MAX_FILES: usize = 20_000;

/// Whether `relative` (inside the project) is left out of the copy.
pub(super) fn skipped(relative: &Path) -> bool {
    relative.components().any(|part| match part {
        Component::Normal(name) => SKIPPED.iter().any(|skipped| name == *skipped),
        _ => true,
    })
}

/// Copy `project` into `mirror`, which must not exist yet. Links are not
/// followed: one could lead anywhere on the disk.
pub(super) fn copy_project(project: &Path, mirror: &Path) -> Result<(), String> {
    let mut files = 0usize;
    copy_folder(project, mirror, Path::new(""), &mut files)
}

fn copy_folder(
    project: &Path, mirror: &Path, relative: &Path, files: &mut usize,
) -> Result<(), String> {
    let source = project.join(relative);
    fs::create_dir_all(mirror.join(relative))
        .map_err(|error| format!("Could not copy the project for FlashTeX: {error}"))?;
    let entries = fs::read_dir(&source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not read the project: {error}"))?;
        let child = relative.join(entry.file_name());
        if skipped(&child) {
            continue;
        }
        let kind = entry
            .file_type()
            .map_err(|error| format!("Could not read {}: {error}", child.display()))?;
        if kind.is_dir() {
            copy_folder(project, mirror, &child, files)?;
        } else if kind.is_file() {
            *files += 1;
            if *files > MAX_FILES {
                return Err("The project has too many files for the FlashTeX preview.".into());
            }
            fs::copy(project.join(&child), mirror.join(&child))
                .map_err(|error| format!("Could not copy {}: {error}", child.display()))?;
        }
    }
    Ok(())
}

/// Bring `relative` in the copy up to the project's file: copied again, or
/// removed when the project no longer has it.
pub(super) fn sync_file(project: &Path, mirror: &Path, relative: &Path) -> Result<(), String> {
    if skipped(relative) {
        return Ok(());
    }
    let source = project.join(relative);
    let target = mirror.join(relative);
    match fs::symlink_metadata(&source) {
        Ok(metadata) if metadata.file_type().is_file() => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Could not copy {}: {error}", relative.display()))?;
            }
            fs::copy(&source, &target)
                .map(|_| ())
                .map_err(|error| format!("Could not copy {}: {error}", relative.display()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::remove_file(&target) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!("Could not remove {}: {error}", relative.display())),
            }
        }
        Err(error) => Err(format!("Could not read {}: {error}", relative.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn copies_the_sources_but_not_version_control_or_lattice_folders() {
        let project = TempDir::new("flashtex-mirror-project");
        project.write("main.tex", "main");
        project.write("chapters/one.tex", "one");
        project.write("figures/plot.pdf", "pdf");
        project.write(".git/HEAD", "ref");
        project.write(".research/build/main.aux", "aux");
        project.write("node_modules/x/index.js", "x");
        let out = TempDir::new("flashtex-mirror-out");
        let mirror = out.join("project");
        copy_project(&project, &mirror).unwrap();
        assert_eq!(fs::read_to_string(mirror.join("chapters/one.tex")).unwrap(), "one");
        assert!(mirror.join("figures/plot.pdf").is_file());
        assert!(!mirror.join(".git").exists());
        assert!(!mirror.join(".research").exists());
        assert!(!mirror.join("node_modules").exists());
    }

    #[test]
    fn a_synced_file_follows_the_project_and_the_project_never_follows_the_copy() {
        let project = TempDir::new("flashtex-mirror-sync");
        project.write("main.tex", "saved");
        project.write("old.tex", "old");
        let out = TempDir::new("flashtex-mirror-sync-out");
        let mirror = out.join("project");
        copy_project(&project, &mirror).unwrap();
        // The host writes the editor's text into the copy.
        fs::write(mirror.join("main.tex"), "unsaved").unwrap();
        assert_eq!(fs::read_to_string(project.join("main.tex")).unwrap(), "saved");
        project.write("chapters/new.tex", "new");
        fs::remove_file(project.join("old.tex")).unwrap();
        sync_file(&project, &mirror, Path::new("chapters/new.tex")).unwrap();
        sync_file(&project, &mirror, Path::new("old.tex")).unwrap();
        sync_file(&project, &mirror, Path::new("main.tex")).unwrap();
        assert_eq!(fs::read_to_string(mirror.join("chapters/new.tex")).unwrap(), "new");
        assert!(!mirror.join("old.tex").exists());
        assert_eq!(fs::read_to_string(mirror.join("main.tex")).unwrap(), "saved");
        sync_file(&project, &mirror, Path::new(".git/HEAD")).unwrap();
        assert!(!mirror.join(".git").exists());
    }

    #[test]
    fn leaves_out_paths_that_leave_the_project() {
        assert!(skipped(Path::new("../x.tex")));
        assert!(skipped(Path::new("/etc/passwd")));
        assert!(skipped(Path::new("a/.git/config")));
        assert!(!skipped(Path::new("a/b.tex")));
    }
}
