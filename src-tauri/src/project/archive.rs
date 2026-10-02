//! ZIP source packs: exporting for Overleaf/arXiv and importing an Overleaf
//! download as a new project.

use super::manifest::open;
use super::paths::available_path;
use crate::models::ProjectSnapshot;
use crate::util::err;
use chrono::{Datelike, Local, NaiveDate, TimeZone, Timelike};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

/// Folders (relative to the project root) left out of an export whole: VCS
/// and app state.
const EXPORT_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    ".research/history",
    ".research/sessions",
    ".research/omp-sessions",
    ".research/omp-session-map",
    ".research/omp-runtime",
    ".research/checkpoints",
    ".research/cache",
];

/// File-name endings left out of an export at any depth: build output.
const EXPORT_EXCLUDED_SUFFIXES: &[&str] = &[
    ".aux",
    ".log",
    ".bbl",
    ".blg",
    ".fdb_latexmk",
    ".fls",
    ".out",
    ".bcf",
    ".run.xml",
    "-SAVE-ERROR",
    ".synctex.gz",
    ".pdf",
];

/// Export the project as a ZIP suitable for Overleaf / arXiv source packs.
pub fn export_project_zip(root: &Path, zip_path: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(err)?;
    if !root.is_dir() {
        return Err("Open a project before exporting.".to_string());
    }
    if let Some(parent) = zip_path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    if zip_path.exists() {
        fs::remove_file(zip_path).map_err(err)?;
    }
    let written = File::create(zip_path)
        .map_err(err)
        .and_then(|file| write_project_zip(&root, file))
        .map_err(|error| format!("Could not create the ZIP archive: {error}"));
    if written.is_err() {
        let _ = fs::remove_file(zip_path);
    }
    written
}

/// Add everything under `root` except the export exclusions, following
/// symbolic links, with each entry's permissions and modification time.
/// Like `zip -r`, a dangling symbolic link or a link loop is skipped with a
/// warning rather than failing the export.
fn write_project_zip(root: &Path, file: File) -> Result<(), String> {
    // The archive may be written inside the project (possibly through a
    // symlinked folder); it must not contain itself.
    let archive = file.metadata().map_err(err)?;
    let mut writer = ZipWriter::new(file);
    let walk = WalkDir::new(root).follow_links(true).sort_by_file_name().into_iter();
    for entry in walk.filter_entry(|entry| !excluded_dir(root, entry.path())) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if unreadable_link(&error) => {
                log::warn!(target: "lattice::project", "Skipping {error} in the ZIP export");
                continue;
            }
            Err(error) => return Err(err(error)),
        };
        let relative = entry.path().strip_prefix(root).map_err(err)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let name = (relative.to_str())
            .ok_or_else(|| format!("{} is not a UTF-8 path.", relative.display()))?;
        let metadata = entry.metadata().map_err(err)?;
        let options = SimpleFileOptions::default()
            .unix_permissions(metadata.permissions().mode())
            .last_modified_time(zip_time(metadata.modified().ok()))
            .large_file(metadata.len() >= u64::from(u32::MAX));
        if metadata.is_dir() {
            writer.add_directory(format!("{name}/"), options).map_err(err)?;
        } else if !excluded_file(name)
            && (metadata.dev(), metadata.ino()) != (archive.dev(), archive.ino())
        {
            writer.start_file(name, options).map_err(err)?;
            io::copy(&mut File::open(entry.path()).map_err(err)?, &mut writer).map_err(err)?;
        }
    }
    writer.finish().map_err(err)?;
    Ok(())
}

/// A walk error for a symbolic link whose target is missing or leads back
/// into one of its own ancestors.
fn unreadable_link(error: &walkdir::Error) -> bool {
    error.loop_ancestor().is_some()
        || (error.io_error().is_some_and(|io| io.kind() == io::ErrorKind::NotFound)
            && error.path().is_some_and(|path| path.is_symlink()))
}

fn excluded_dir(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .is_ok_and(|relative| EXPORT_EXCLUDED_DIRS.iter().any(|dir| relative == Path::new(dir)))
}

fn excluded_file(name: &str) -> bool {
    EXPORT_EXCLUDED_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

/// `time` as a ZIP (DOS, local-time) timestamp; the format's epoch when it is
/// unknown or out of the format's 1980-2107 range.
fn zip_time(time: Option<SystemTime>) -> zip::DateTime {
    time.map(chrono::DateTime::<Local>::from)
        .and_then(|local| {
            zip::DateTime::from_date_and_time(
                u16::try_from(local.year()).ok()?,
                local.month() as u8,
                local.day() as u8,
                local.hour() as u8,
                local.minute() as u8,
                local.second() as u8,
            )
            .ok()
        })
        .unwrap_or_default()
}

/// The local time a ZIP timestamp stands for.
fn system_time(time: zip::DateTime) -> Option<SystemTime> {
    let naive =
        NaiveDate::from_ymd_opt(time.year().into(), time.month().into(), time.day().into())?
            .and_hms_opt(time.hour().into(), time.minute().into(), time.second().into())?;
    Local.from_local_datetime(&naive).earliest().map(SystemTime::from)
}

/// The entry's name, `/`-separated, when it stays inside the folder it is
/// extracted to: relative, no `..` or empty segments, not a symbolic link.
pub(crate) fn safe_zip_entry_name<R: Read + ?Sized>(
    file: &zip::read::ZipFile<'_, R>,
) -> Option<String> {
    let name = file.name().replace('\\', "/");
    let trimmed = name.strip_suffix('/').filter(|_| file.is_dir()).unwrap_or(&name);
    let unsafe_path = file.is_symlink()
        || file.enclosed_name().is_none()
        || trimmed.starts_with('/')
        || trimmed.split('/').any(|part| part == ".." || part.is_empty());
    (!unsafe_path).then(|| trimmed.to_string())
}

/// Extract an Overleaf (or similar) ZIP into `parent` and open it as a Lattice project.
pub fn import_project_zip(zip_path: &Path, parent: &Path) -> Result<ProjectSnapshot, String> {
    if !zip_path.is_file() {
        return Err("Choose a ZIP file to import.".to_string());
    }
    let parent = parent.canonicalize().map_err(err)?;
    if !parent.is_dir() {
        return Err("Choose a folder to extract the project into.".to_string());
    }
    let stem = zip_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("overleaf-project")
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>();
    let stem = if stem.is_empty() { "overleaf-project".to_string() } else { stem };
    let dest = available_path(&parent, &stem, false, &Default::default());
    fs::create_dir_all(&dest).map_err(err)?;
    if let Err(error) = extract_zip(zip_path, &dest) {
        let _ = fs::remove_dir_all(&dest);
        return Err(format!("Could not extract the ZIP archive: {error}"));
    }
    open(&unwrap_single_nested_folder(&dest)?)
}

/// Extract every entry of `zip_path` beneath `dest`, keeping file permissions
/// and modification times. Symbolic-link entries are skipped with a warning;
/// the whole archive is refused when any other entry would land outside
/// `dest`.
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let mut archive = ZipArchive::new(File::open(zip_path).map_err(err)?).map_err(err)?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(err)?;
        if file.is_symlink() {
            log::warn!(target: "lattice::project", "Skipping symbolic link {} in the ZIP import", file.name());
            continue;
        }
        let name = safe_zip_entry_name(&file)
            .ok_or_else(|| format!("refusing unsafe path {}", file.name()))?;
        let target = dest.join(&name);
        if file.is_dir() {
            fs::create_dir_all(&target).map_err(err)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let mut out = File::create(&target).map_err(err)?;
        io::copy(&mut file, &mut out).map_err(err)?;
        if let Some(modified) = file.last_modified().and_then(system_time) {
            let _ = out.set_modified(modified);
        }
        if let Some(mode) = file.unix_mode().map(|mode| mode & 0o777).filter(|&mode| mode != 0) {
            fs::set_permissions(&target, fs::Permissions::from_mode(mode | 0o600)).map_err(err)?;
        }
    }
    Ok(())
}

/// Overleaf downloads often wrap everything in one top-level folder; open
/// that folder instead when nothing `.tex` sits beside it.
fn unwrap_single_nested_folder(root: &Path) -> Result<PathBuf, String> {
    let mut children = fs::read_dir(root)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && name != "__MACOSX"
        })
        .map(|entry| entry.path());
    if let (Some(only), None) = (children.next(), children.next()) {
        let has_tex_here = WalkDir::new(root)
            .max_depth(1)
            .into_iter()
            .filter_map(Result::ok)
            .any(|entry| entry.path().extension().is_some_and(|ext| ext == "tex"));
        if only.is_dir() && !has_tex_here {
            return Ok(only);
        }
    }
    Ok(root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;
    use std::io::Write;
    use std::time::Duration;

    fn names(zip_path: &Path) -> Vec<String> {
        let archive = ZipArchive::new(File::open(zip_path).unwrap()).unwrap();
        let mut names = archive.file_names().map(str::to_string).collect::<Vec<_>>();
        names.sort();
        names
    }

    #[test]
    fn export_keeps_sources_and_leaves_out_app_state_vcs_and_build_output() {
        let fixture = Fixture::empty("export-zip");
        for path in [
            "main.tex",
            "main.log",
            "main.synctex.gz",
            "figures/plot.pdf",
            "figures/plot.tikz",
            "chapters/intro.aux",
            "chapters/intro.tex",
            ".latexmkrc",
            ".git/HEAD",
            ".research/history/1.json",
            ".research/notes.md",
            "vendor/.git/HEAD",
            "draft.tex-SAVE-ERROR",
        ] {
            fixture.write(path, "x\n");
        }
        fs::create_dir_all(fixture.root.join("empty")).unwrap();
        // Exporting into the project must not put the archive inside itself.
        let zip_path = fixture.root.join("exports/paper.zip");
        export_project_zip(&fixture.root, &zip_path).unwrap();
        assert_eq!(
            names(&zip_path),
            [
                ".latexmkrc",
                ".research/",
                ".research/notes.md",
                "chapters/",
                "chapters/intro.tex",
                "empty/",
                "exports/",
                "figures/",
                "figures/plot.tikz",
                "main.tex",
                "vendor/",
                "vendor/.git/",
                "vendor/.git/HEAD",
            ]
        );
    }

    #[test]
    fn export_skips_dangling_links_and_link_loops() {
        let fixture = Fixture::empty("export-zip-links");
        fixture.write("a.tex", "x\n");
        std::os::unix::fs::symlink("nowhere", fixture.path("dangling")).unwrap();
        std::os::unix::fs::symlink(".", fixture.path("loop")).unwrap();
        let exports = Fixture::empty("export-zip-links-out");
        let zip_path = exports.path("paper.zip");
        export_project_zip(&fixture.root, &zip_path).unwrap();
        assert_eq!(names(&zip_path), ["a.tex"]);
    }

    #[test]
    fn export_into_a_symlinked_folder_does_not_include_itself() {
        let fixture = Fixture::empty("export-zip-symlinked-out");
        fixture.write("main.tex", "x\n");
        let elsewhere = Fixture::empty("export-zip-elsewhere");
        std::os::unix::fs::symlink(&elsewhere.root, fixture.path("out")).unwrap();
        let zip_path = fixture.root.join("out/paper.zip");
        export_project_zip(&fixture.root, &zip_path).unwrap();
        assert_eq!(names(&zip_path), ["main.tex", "out/"]);
    }

    #[test]
    fn import_keeps_owner_access_when_an_entry_stores_no_mode() {
        let scratch = Fixture::empty("zip-zero-mode");
        let zip_path = scratch.path("paper.zip");
        let mut writer = ZipWriter::new(File::create(&zip_path).unwrap());
        writer.start_file("main.tex", SimpleFileOptions::default().unix_permissions(0)).unwrap();
        writer.write_all(b"ok").unwrap();
        writer.finish().unwrap();

        let parent = Fixture::empty("zip-zero-mode-parent");
        let snapshot = import_project_zip(&zip_path, &parent.root).unwrap();
        let main = PathBuf::from(&snapshot.root).join("main.tex");
        assert_eq!(fs::read_to_string(&main).unwrap(), "ok");
        assert_eq!(fs::metadata(&main).unwrap().permissions().mode() & 0o600, 0o600);
    }

    #[test]
    fn import_skips_symbolic_link_entries() {
        let scratch = Fixture::empty("zip-symlink-entry");
        let zip_path = scratch.path("paper.zip");
        let mut writer = ZipWriter::new(File::create(&zip_path).unwrap());
        writer.start_file("main.tex", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"ok").unwrap();
        writer.add_symlink("secrets", "/etc", SimpleFileOptions::default()).unwrap();
        writer.finish().unwrap();

        let parent = Fixture::empty("zip-symlink-entry-parent");
        let snapshot = import_project_zip(&zip_path, &parent.root).unwrap();
        let project = PathBuf::from(&snapshot.root);
        assert_eq!(fs::read_to_string(project.join("main.tex")).unwrap(), "ok");
        assert!(fs::symlink_metadata(project.join("secrets")).is_err());
    }

    #[test]
    fn import_round_trips_an_export_with_permissions_and_times() {
        let fixture = Fixture::empty("zip-round-trip");
        fixture.write("paper/main.tex", "\\documentclass{article}\n");
        fixture.write("paper/build.sh", "#!/bin/sh\n");
        let script = fixture.path("paper/build.sh");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let old = SystemTime::now() - Duration::from_secs(86_400 * 30);
        File::options().write(true).open(&script).unwrap().set_modified(old).unwrap();
        let exports = Fixture::empty("zip-round-trip-out");
        let zip_path = exports.path("My Paper.zip");
        export_project_zip(&fixture.root, &zip_path).unwrap();

        let parent = Fixture::empty("zip-round-trip-in");
        let snapshot = import_project_zip(&zip_path, &parent.root).unwrap();
        // The single `paper/` folder is opened as the project.
        let project = PathBuf::from(&snapshot.root);
        assert_eq!(project, parent.root.canonicalize().unwrap().join("My-Paper/paper"));
        let main = fs::read_to_string(project.join("main.tex")).unwrap();
        assert_eq!(main, "\\documentclass{article}\n");
        let script = fs::metadata(project.join("build.sh")).unwrap();
        assert_eq!(script.permissions().mode() & 0o777, 0o755);
        let drift = script.modified().unwrap().duration_since(old).unwrap_or_default();
        assert!(drift <= Duration::from_secs(2), "{drift:?}");
    }

    #[test]
    fn import_refuses_entries_that_leave_the_project_and_cleans_up() {
        for bad in ["../escape.tex", "/abs.tex", "a//b.tex"] {
            let scratch = Fixture::empty("zip-slip");
            let zip_path = scratch.path("evil.zip");
            let mut writer = ZipWriter::new(File::create(&zip_path).unwrap());
            writer.start_file("main.tex", SimpleFileOptions::default()).unwrap();
            writer.write_all(b"ok").unwrap();
            writer.start_file(bad, SimpleFileOptions::default()).unwrap();
            writer.write_all(b"bad").unwrap();
            writer.finish().unwrap();

            let parent = Fixture::empty("zip-slip-parent");
            let error = import_project_zip(&zip_path, &parent.root).unwrap_err();
            assert!(error.contains("unsafe path"), "{bad}: {error}");
            assert_eq!(fs::read_dir(&parent.root).unwrap().count(), 0, "{bad}");
            assert!(!scratch.root.join("escape.tex").exists());
        }
    }
}
