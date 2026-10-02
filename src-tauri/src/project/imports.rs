//! Bringing content into a project — Finder drops, pasted
//! images, Open Slide byte writes — and the agent composer's read-only relay
//! of dropped files.

use super::assets::asset_mime_type;
use super::history::apply_transaction;
use super::paths::{
    available_path, display_name, extension, file_name, relative_to, safe_path, source_kind,
    validate_entry_name, validate_user_entry,
};
use super::tree::{classify_regular_file, is_paper_library_path, is_supported_asset, ContentKind};
use crate::project_fs::ProjectDir;
use crate::util::err;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Where a drop lands: a folder row or a file's parent folder, or `None` for
/// the project pane background ("").
fn drop_folder(root: &Path, target_directory: &str) -> Result<Option<PathBuf>, String> {
    let target_directory = target_directory.trim().trim_end_matches(['/', '\\']);
    if target_directory.is_empty() {
        return Ok(None);
    }
    validate_user_entry(target_directory)?;
    safe_path(root, target_directory).map(Some)
}

/// The canonical root and the folder a drop lands in, which may not exist yet
/// but must not be a file.
fn drop_target(
    root: &Path, target_directory: &str, not_folder: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let target = drop_folder(root, target_directory)?;
    let canonical_root = root.canonicalize().map_err(err)?;
    let target = target.unwrap_or_else(|| canonical_root.clone());
    if target.exists() && !target.is_dir() {
        return Err(not_folder.to_string());
    }
    Ok((canonical_root, target))
}

/// `Import <path>` for one text file, `Import N <noun>` for several.
fn import_label(edits: &[(String, String)], noun: &str) -> String {
    match edits {
        [(path, _)] => format!("Import {path}"),
        _ => format!("Import {} {noun}", edits.len()),
    }
}

pub fn import_image_bytes(
    root: &Path, target_directory: &str, file_name: &str, base64_data: &str,
) -> Result<String, String> {
    validate_user_entry(target_directory)?;
    let name = file_name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Choose a simple image file name.".to_string());
    }
    let extension = extension(name).unwrap_or_default();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("Clipboard images must be saved as PNG, JPEG, or WebP.".to_string());
    }
    let target = safe_path(root, target_directory)?;
    fs::create_dir_all(&target).map_err(err)?;
    let bytes = STANDARD
        .decode(base64_data.trim())
        .map_err(|error| format!("Could not decode the clipboard image: {error}"))?;
    if bytes.is_empty() {
        return Err("The clipboard image was empty.".to_string());
    }
    let looks_valid = match extension.as_str() {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
    };
    if !looks_valid {
        return Err("The clipboard data is not a valid image.".to_string());
    }
    let destination = available_path(&target, name, true, &BTreeSet::new());
    fs::write(&destination, bytes).map_err(err)?;
    relative_to(&root.canonicalize().map_err(err)?, &destination)
}

pub fn import_assets(
    root: &Path, sources: &[String], target_directory: &str,
) -> Result<Vec<String>, String> {
    if sources.is_empty() {
        return Err("Drop one or more image files first.".to_string());
    }
    let (canonical_root, target) =
        drop_target(root, target_directory, "Drop images onto a project folder.")?;
    let mut files = Vec::with_capacity(sources.len());
    for source in sources {
        let source = Path::new(source);
        if !source.is_file() || !is_supported_asset(source) {
            return Err(format!("{} is not a supported image or PDF file.", display_name(source)));
        }
        files.push((source, file_name(source, "An imported image")?));
    }

    // Dropped-on folders can be brand new (the "figures" default for editor
    // drops, or a tree folder deleted on disk mid-drag): create, don't refuse.
    fs::create_dir_all(&target).map_err(err)?;
    let mut imported = Vec::new();
    for (source, file_name) in files {
        let destination = available_path(&target, file_name, true, &BTreeSet::new());
        fs::copy(source, &destination).map_err(err)?;
        imported.push(
            destination.strip_prefix(&canonical_root).map_err(err)?.to_string_lossy().to_string(),
        );
    }
    Ok(imported)
}

/// Matches the per-file cap the embedded agent panel enforces when it
/// validates the composer-files bridge message; keep the two in sync.
const MAX_AGENT_COMPOSER_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentComposerFile {
    pub name: String,
    pub mime_type: String,
    pub bytes_base64: String,
}

/// Read OS-dropped files for relay into the embedded agent composer. The
/// sources are native paths outside the project root by design (Finder drops),
/// so this mirrors `import_assets`/`import_sources` validation but never
/// touches the project. Accepts both figure files and text source files —
/// the composer attaches images as images and everything else as documents.
pub fn read_agent_composer_files(sources: &[String]) -> Result<Vec<AgentComposerFile>, String> {
    if sources.is_empty() {
        return Err("Drop one or more files first.".to_string());
    }
    let mut files = Vec::new();
    for source in sources {
        let source = Path::new(source);
        let mime_type = asset_mime_type(source).or_else(|| source_kind(source)?.mime);
        let Some(mime_type) = mime_type.filter(|_| source.is_file()) else {
            let name = display_name(source);
            return Err(format!("{name} is not an image, PDF, or text file the agent can read."));
        };
        let name = file_name(source, "A dropped file")?;
        if fs::metadata(source).map_err(err)?.len() > MAX_AGENT_COMPOSER_FILE_BYTES {
            return Err(format!("{name} is larger than the 64 MB limit for agent attachments."));
        }
        files.push(AgentComposerFile {
            name: name.to_string(),
            mime_type: mime_type.to_string(),
            bytes_base64: STANDARD.encode(fs::read(source).map_err(err)?),
        });
    }
    Ok(files)
}

pub fn import_sources(
    root: &Path, sources: &[String], target_directory: &str,
) -> Result<Vec<String>, String> {
    if sources.is_empty() {
        return Err("Drop one or more source files first.".to_string());
    }
    let target = drop_folder(root, target_directory)?.unwrap_or_else(|| root.to_path_buf());
    if !target.is_dir() {
        return Err("Choose an existing project folder.".to_string());
    }

    let canonical_root = root.canonicalize().map_err(err)?;
    let mut imported = Vec::with_capacity(sources.len());
    let mut edits = Vec::new();
    let mut reserved = BTreeSet::new();
    for source in sources {
        let requested_source = Path::new(source);
        let name = display_name(requested_source);
        if !requested_source.is_file() || source_kind(requested_source).is_none() {
            return Err(format!("{name} is not a supported source file."));
        }
        if requested_source.metadata().map_err(err)?.len() > 10 * 1024 * 1024 {
            return Err(format!("{name} is larger than the 10 MB source-file limit."));
        }
        let canonical_source = requested_source.canonicalize().map_err(err)?;
        if let Ok(relative) = canonical_source.strip_prefix(&canonical_root) {
            let relative = relative.to_string_lossy().replace('\\', "/");
            validate_user_entry(&relative)?;
            imported.push(relative);
            continue;
        }

        let file_name = file_name(requested_source, "An imported source")?;
        validate_entry_name(file_name)?;
        let content = fs::read_to_string(&canonical_source).map_err(|error| {
            if error.kind() == std::io::ErrorKind::InvalidData {
                format!("{file_name} is not a UTF-8 text file.")
            } else {
                error.to_string()
            }
        })?;
        let destination = available_path(&target, file_name, true, &reserved);
        reserved.insert(destination.clone());
        let relative = relative_to(root, &destination)?;
        edits.push((relative.clone(), content));
        imported.push(relative);
    }

    if !edits.is_empty() {
        apply_transaction(root, &import_label(&edits, "source files"), edits)?;
    }
    Ok(imported)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedProjectFile {
    pub path: String,
    /// How the file was classified: "text", "board", "spreadsheet", or "binary".
    pub kind: String,
}

/// One Finder drop, any mix of files and folders. Folder imports preserve their
/// hierarchy under one collision-free top-level name; hidden entries are
/// omitted and symbolic links are not followed. Content — not extension —
/// decides each file's route. UTF-8 text lands through the undoable transaction
/// log like `import_sources`; figures keep the `import_assets` copy route and
/// classify as "binary" (SVG is text bytes but a figure); everything else is
/// copied verbatim. Files already inside the
/// project are registered without copying.
pub fn import_files(
    root: &Path, sources: &[String], target_directory: &str,
) -> Result<Vec<ImportedProjectFile>, String> {
    import_files_with_copy(root, sources, target_directory, false)
}

/// What an import does with one file once the whole drop has been checked.
enum Planned {
    /// Already inside the project: register it, copy nothing.
    Existing,
    /// UTF-8 text: written through the transaction log.
    Text { content: String },
    /// Everything else: copied byte for byte.
    Binary { source: PathBuf, destination: PathBuf },
}

/// Every folder and file a drop will create, gathered (with text content
/// read) before the project is touched, so a bad entry anywhere in the batch
/// aborts the whole drop instead of half-landing.
struct ImportPlan<'a> {
    canonical_root: &'a Path,
    directories: Vec<PathBuf>,
    files: Vec<(ImportedProjectFile, Planned)>,
}

impl ImportPlan<'_> {
    /// `destination` is `None` for a file registered in place.
    fn file(&mut self, source: &Path, destination: Option<PathBuf>) -> Result<(), String> {
        // classify_regular_file caps text at 8 MB, so oversized text files
        // take the verbatim copy route rather than the transaction log.
        let text =
            !is_supported_asset(source) && classify_regular_file(source)? == ContentKind::Text;
        let kind = match extension(source).as_deref() {
            _ if !text => "binary",
            Some("tldr") => "board",
            Some("lattice-sheet") => "spreadsheet",
            _ => "text",
        };
        let relative = relative_to(self.canonical_root, destination.as_deref().unwrap_or(source))?;
        validate_user_entry(&relative)?;
        let planned = match destination {
            None => Planned::Existing,
            Some(_) if text => Planned::Text { content: fs::read_to_string(source).map_err(err)? },
            Some(destination) => Planned::Binary { source: source.to_path_buf(), destination },
        };
        self.files.push((ImportedProjectFile { path: relative, kind: kind.into() }, planned));
        Ok(())
    }

    fn directory(&mut self, source: &Path, destination: Option<&Path>) -> Result<(), String> {
        if let Some(destination) = destination {
            self.directories.push(destination.to_path_buf());
        }
        // Hidden files cannot be addressed in the Project tree and commonly
        // include large VCS/cache state. Symlinks are emitted by WalkDir but
        // never traversed, keeping a dropped folder within its visible tree.
        let walker =
            WalkDir::new(source).follow_links(false).sort_by_file_name().into_iter().filter_entry(
                |entry| entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.'),
            );
        for entry in walker.skip(1) {
            let entry = entry.map_err(err)?;
            let file_type = fs::symlink_metadata(entry.path()).map_err(err)?.file_type();
            if file_type.is_symlink() {
                continue;
            }
            let name = entry
                .file_name()
                .to_str()
                .ok_or_else(|| "An imported folder contains an invalid file name.".to_string())?;
            validate_entry_name(name)?;
            let suffix = entry.path().strip_prefix(source).map_err(err)?;
            let entry_destination = destination.map(|target| target.join(suffix));
            if file_type.is_dir() {
                self.directories.extend(entry_destination);
            } else if file_type.is_file() {
                self.file(entry.path(), entry_destination)?;
            } else {
                return Err(format!("{name} is not a regular file Lattice can import."));
            }
        }
        Ok(())
    }
}

/// Explicit tree copies duplicate in-project sources; ordinary drops only register them.
pub fn import_files_with_copy(
    root: &Path, sources: &[String], target_directory: &str, copy_existing: bool,
) -> Result<Vec<ImportedProjectFile>, String> {
    if sources.is_empty() {
        return Err("Drop one or more files or folders first.".to_string());
    }
    let (canonical_root, target) =
        drop_target(root, target_directory, "Drop files and folders onto a project folder.")?;

    let mut plan =
        ImportPlan { canonical_root: &canonical_root, directories: Vec::new(), files: Vec::new() };
    let mut reserved = BTreeSet::new();
    for source in sources {
        let requested = Path::new(source);
        let name = display_name(requested);
        let file_type = fs::symlink_metadata(requested).map_err(err)?.file_type();
        if file_type.is_symlink() {
            return Err(format!("{name} is a symbolic link and cannot be imported."));
        }
        if !file_type.is_file() && !file_type.is_dir() {
            return Err(format!("{name} is not a regular file or folder Lattice can import."));
        }
        let canonical_source = requested.canonicalize().map_err(err)?;
        if copy_existing && file_type.is_dir() && target.starts_with(&canonical_source) {
            return Err("A folder cannot be copied inside itself.".to_string());
        }
        if canonical_source.starts_with(&canonical_root) && !copy_existing {
            if file_type.is_dir() {
                validate_user_entry(&relative_to(&canonical_root, &canonical_source)?)?;
                plan.directory(&canonical_source, None)?;
            } else {
                plan.file(&canonical_source, None)?;
            }
            continue;
        }
        let file_name = file_name(requested, "An imported file")?;
        validate_entry_name(file_name)?;
        if file_type.is_dir() && canonical_root.starts_with(&canonical_source) {
            return Err(format!(
                "{name} contains the current project and cannot be imported into it."
            ));
        }
        let destination = available_path(&target, file_name, !file_type.is_dir(), &reserved);
        reserved.insert(destination.clone());
        if file_type.is_dir() {
            plan.directory(&canonical_source, Some(&destination))?;
        } else {
            plan.file(&canonical_source, Some(destination))?;
        }
    }

    fs::create_dir_all(&target).map_err(err)?;
    for directory in &plan.directories {
        fs::create_dir_all(directory).map_err(err)?;
    }
    let mut edits = Vec::new();
    for (file, planned) in &plan.files {
        match planned {
            Planned::Existing => {}
            Planned::Text { content } => edits.push((file.path.clone(), content.clone())),
            Planned::Binary { source, destination } => {
                fs::copy(source, destination).map_err(err)?;
            }
        }
    }
    if !edits.is_empty() {
        apply_transaction(root, &import_label(&edits, "files"), edits)?;
    }
    Ok(plan.files.into_iter().map(|(file, _)| file).collect())
}

/// `.research` paths raw byte writes never touch.
const UNSYNCED_RESEARCH_PREFIXES: &[&str] = &[
    ".research/history/",
    ".research/sessions/",
    ".research/omp-",
    ".research/checkpoints/",
    ".research/cache/",
];

/// Write raw bytes (base64) to a project-relative path, for Open Slide's
/// binary edits. Allows `.research/project.json`, `.research/brief.md`, and
/// normal project files; never app state or the paper library.
pub fn write_bytes(root: &Path, relative: &str, base64_data: &str) -> Result<(), String> {
    let relative = relative.trim().replace('\\', "/");
    if relative.is_empty() || relative.contains("..") {
        return Err("Choose a valid project-relative path.".to_string());
    }
    if UNSYNCED_RESEARCH_PREFIXES.iter().any(|prefix| relative.starts_with(prefix))
        || is_paper_library_path(&relative)
    {
        return Err("That path cannot be written directly.".to_string());
    }
    if relative.starts_with('.') && !relative.starts_with(".research/") {
        return Err("Hidden paths outside .research cannot be written.".to_string());
    }
    if relative.starts_with(".research/")
        && relative != ".research/project.json"
        && relative != ".research/brief.md"
    {
        return Err("Only project sidecar files can be written under .research.".to_string());
    }
    let bytes = STANDARD
        .decode(base64_data.trim())
        .map_err(|error| format!("Could not decode file bytes: {error}"))?;
    if bytes.len() > 15 * 1024 * 1024 {
        return Err("Binary files written this way must be 15 MB or smaller.".to_string());
    }
    ProjectDir::open(root)?.atomic_write(&relative, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    fn paths<P: AsRef<Path>>(files: impl IntoIterator<Item = P>) -> Vec<String> {
        files.into_iter().map(|path| path.as_ref().to_string_lossy().to_string()).collect()
    }

    fn routes(files: &[ImportedProjectFile]) -> Vec<(&str, &str)> {
        files.iter().map(|file| (file.path.as_str(), file.kind.as_str())).collect()
    }

    #[test]
    fn imported_assets_are_copied_renamed_on_collision_and_follow_the_drop_target() {
        let fixture = Fixture::project("import-assets");
        let root = &fixture.root;
        let source = fixture.outside("result.png", b"png-bytes");
        let sources = paths([source]);
        // Dropping on a folder the project does not have yet (opened projects
        // are not guaranteed a "figures" skeleton) creates it; the Project
        // pane background is the project root.
        for (target, imported) in [
            ("figures", "figures/result.png"),
            ("figures", "figures/result-2.png"),
            ("assets", "assets/result.png"),
            ("", "result.png"),
            ("assets/", "assets/result-2.png"),
        ] {
            assert_eq!(import_assets(root, &sources, target).unwrap(), vec![imported], "{target}");
        }
        for target in ["main.tex", ".research"] {
            assert!(import_assets(root, &sources, target).is_err(), "{target}");
        }
        let unsupported = paths([fixture.outside("notes.txt", b"text")]);
        assert!(import_assets(root, &unsupported, "figures").is_err());
    }

    #[test]
    fn agent_composer_files_carry_bytes_for_figures_and_text_sources() {
        let fixture = Fixture::empty("agent-composer-files");
        let sources = paths([
            fixture.outside("plot.png", b"png-bytes"),
            fixture.outside("notes.md", b"# Notes"),
        ]);
        let files = read_agent_composer_files(&sources).unwrap();
        let summary = files
            .iter()
            .map(|file| (file.name.as_str(), file.mime_type.as_str(), file.bytes_base64.clone()))
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            vec![
                ("plot.png", "image/png", STANDARD.encode(b"png-bytes")),
                ("notes.md", "text/markdown", STANDARD.encode(b"# Notes")),
            ]
        );
        let error = read_agent_composer_files(&paths([fixture.outside("archive.zip", b"zip")]))
            .unwrap_err();
        assert!(error.contains("archive.zip"), "{error}");
        assert!(read_agent_composer_files(&[]).is_err());
    }

    #[test]
    fn copied_project_entries_duplicate_contents_without_overwriting_sources() {
        let fixture = Fixture::project("copy-project-entries");
        let root = &fixture.root;
        fs::create_dir_all(fixture.path("notes/empty")).unwrap();
        fixture.write("notes/draft.tex", "Original draft");
        fixture.write("notes/image.png", [0, 255, 42]);
        let source = paths([fixture.path("notes")]);
        let copied = import_files_with_copy(root, &source, "", true).unwrap();
        assert_eq!(
            routes(&copied),
            vec![("notes-2/draft.tex", "text"), ("notes-2/image.png", "binary")]
        );
        assert_eq!(fixture.read("notes-2/draft.tex"), "Original draft");
        assert_eq!(fs::read(fixture.path("notes-2/image.png")).unwrap(), [0, 255, 42]);
        assert!(fixture.path("notes-2/empty").is_dir());
        assert_eq!(fixture.read("notes/draft.tex"), "Original draft");
        let file = paths([fixture.path("notes/draft.tex")]);
        for (target, copy) in [("notes", "notes/draft-2.tex"), ("notes-2", "notes-2/draft-2.tex")] {
            assert_eq!(import_files_with_copy(root, &file, target, true).unwrap()[0].path, copy);
        }
        let error = import_files_with_copy(root, &source, "notes/empty", true).unwrap_err();
        assert!(error.contains("inside itself"), "{error}");
        assert!(!fixture.path("notes/empty/notes").exists());
    }

    #[test]
    fn imported_files_route_by_content_and_keep_figures_binary() {
        let fixture = Fixture::project("import-any-files");
        let root = &fixture.root;
        let all = paths([
            fixture.outside("data.csv", "a,b\n1,2\n"),
            fixture.outside("bundle.zip", b"PK\x03\x04rest"),
            fixture.outside("sketch.tldr", "{\"tldrawFileFormatVersion\":1}"),
            fixture.outside("data.lattice-sheet", "{}\n"),
            // Text bytes under a figure extension stay on the figure route.
            fixture.outside("diagram.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
        ]);

        let imported = import_files(root, &all, "data").unwrap();
        assert_eq!(
            routes(&imported),
            vec![
                ("data/data.csv", "text"),
                ("data/bundle.zip", "binary"),
                ("data/sketch.tldr", "board"),
                ("data/data.lattice-sheet", "spreadsheet"),
                ("data/diagram.svg", "binary"),
            ]
        );
        assert_eq!(fixture.read("data/data.csv"), "a,b\n1,2\n");
        assert!(fixture.path("data/bundle.zip").is_file());

        // Collisions rename; files already inside the project only register.
        assert_eq!(import_files(root, &all[..1], "data").unwrap()[0].path, "data/data-2.csv");
        let inside = paths([fixture.path("data/data.csv")]);
        assert_eq!(import_files(root, &inside, "").unwrap()[0].path, "data/data.csv");
        assert!(!fixture.path("data.csv").exists());
        for target in [".research", "main.tex"] {
            assert!(import_files(root, &all[..1], target).is_err(), "{target}");
        }
    }

    #[test]
    fn imported_folders_keep_their_visible_hierarchy_without_following_links() {
        let fixture = Fixture::project("import-folder");
        let root = &fixture.root;
        let source =
            fixture.outside("dataset.v1/README.md", "# Dataset\n").parent().unwrap().to_path_buf();
        fs::create_dir_all(source.join("nested/empty")).unwrap();
        fixture.outside("dataset.v1/nested/results.csv", "score\n1\n");
        fixture.outside("dataset.v1/nested/archive.zip", b"PK\x03\x04rest");
        fixture.outside("dataset.v1/.DS_Store", b"metadata");
        fixture.outside("dataset.v1/.cache/private.txt", "private");

        let sources = paths([source]);
        let imported = import_files(root, &sources, "sections").unwrap();
        assert_eq!(
            routes(&imported),
            vec![
                ("sections/dataset.v1/README.md", "text"),
                ("sections/dataset.v1/nested/archive.zip", "binary"),
                ("sections/dataset.v1/nested/results.csv", "text"),
            ]
        );
        assert_eq!(fixture.read("sections/dataset.v1/nested/results.csv"), "score\n1\n");
        assert!(fixture.path("sections/dataset.v1/nested/empty").is_dir());
        assert!(!fixture.path("sections/dataset.v1/.DS_Store").exists());
        assert!(!fixture.path("sections/dataset.v1/.cache").exists());

        let imported_again = import_files(root, &sources, "sections").unwrap();
        assert!(imported_again.iter().all(|file| file.path.starts_with("sections/dataset.v1-2/")));
        assert!(fixture.path("sections/dataset.v1-2/nested/empty").is_dir());

        let error = import_files(root, &paths([&fixture.parent]), "").unwrap_err();
        assert!(error.contains("contains the current project"), "{error}");

        // Symbolic links are never followed, inside a folder or at the top.
        use std::os::unix::fs::symlink;
        let source =
            fixture.outside("dataset/visible.txt", "visible").parent().unwrap().to_path_buf();
        let secret = fixture.outside("outside/secret.txt", "secret");
        symlink(secret.parent().unwrap(), source.join("linked-directory")).unwrap();
        symlink(&secret, source.join("linked-file")).unwrap();

        let imported = import_files(root, &paths([&source]), "").unwrap();
        assert_eq!(routes(&imported), vec![("dataset/visible.txt", "text")]);
        assert!(!fixture.path("dataset/linked-directory").exists());
        assert!(!fixture.path("dataset/linked-file").exists());

        let top_level_link = fixture.parent.join("linked-dataset");
        symlink(&source, &top_level_link).unwrap();
        let error = import_files(root, &paths([top_level_link]), "").unwrap_err();
        assert!(error.contains("symbolic link"), "{error}");
    }

    #[test]
    fn imported_sources_are_transactional_and_renamed_on_collision() {
        let fixture = Fixture::project("import-sources");
        let root = &fixture.root;
        let source = paths([fixture.outside("notes.tex", "\\section{Imported}\n")]);

        assert_eq!(import_sources(root, &source, "").unwrap(), vec!["notes.tex"]);
        assert_eq!(import_sources(root, &source, "").unwrap(), vec!["notes-2.tex"]);
        assert_eq!(fixture.read("notes.tex"), "\\section{Imported}\n");
        let inside = paths([fixture.path("notes.tex")]);
        assert_eq!(import_sources(root, &inside, "").unwrap(), vec!["notes.tex"]);

        // Boards are text (tldraw JSON) and must import like other sources;
        // the frontend offers them to this path.
        for (name, contents) in
            [("sketch.tldr", "{\"tldrawFileFormatVersion\":1}"), ("data.lattice-sheet", "{}\n")]
        {
            let source = paths([fixture.outside(name, contents)]);
            assert_eq!(import_sources(root, &source, "").unwrap(), vec![name]);
        }
        let unsupported = paths([fixture.outside("result.png", b"png")]);
        assert!(import_sources(root, &unsupported, "").is_err());
        let invalid_utf8 = paths([fixture.outside("invalid.bib", [0xff, 0xfe])]);
        assert!(import_sources(root, &invalid_utf8, "").is_err());
    }

    #[test]
    fn clipboard_images_are_saved_and_byte_writes_skip_paper_bundles() {
        let fixture = Fixture::project("clipboard-image");
        let png = [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D];
        let path = import_image_bytes(&fixture.root, "figures", "paste.png", &STANDARD.encode(png))
            .unwrap();
        assert_eq!(path, "figures/paste.png");
        assert!(fixture.path("figures/paste.png").is_file());

        let error = write_bytes(
            &fixture.root,
            ".research/papers/2401.00001/paper_assets/figure.png",
            "QQ==",
        )
        .unwrap_err();
        assert!(error.contains("cannot be written directly"));
    }
}
