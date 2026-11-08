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
use serde::{Deserialize, Serialize};
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
            destination
                .strip_prefix(&canonical_root)
                .map_err(err)?
                .to_string_lossy()
                .replace('\\', "/"),
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

/// What an import does with a top-level item whose name the target folder
/// already has. Nothing in the project is ever deleted: a replaced folder is
/// merged into, and an item whose kind differs from what it would replace (a
/// file over a folder) keeps both instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NameConflict {
    /// Land beside it under the next free numbered name (`data-2.csv`).
    KeepBoth,
    /// Overwrite same-named files; merge into a same-named folder.
    Replace,
    /// Leave it alone and import the rest.
    Skip,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImport {
    /// Names the target already has, when the import was asked without a
    /// policy: nothing was imported, and the caller decides how to go on.
    pub conflicts: Vec<String>,
    pub files: Vec<ImportedProjectFile>,
    /// The project paths of the top-level files and folders that landed.
    pub entries: Vec<String>,
    /// Names left out under `NameConflict::Skip`.
    pub skipped: Vec<String>,
}

/// One import into the project tree: Finder drops onto it, Import files…, and
/// the tree's own copy and paste.
#[derive(Clone, Copy)]
pub struct ImportRequest<'a> {
    pub sources: &'a [String],
    pub target_directory: &'a str,
    /// Duplicate sources already inside the project (paste) instead of only
    /// registering them (a Finder drop of a project file).
    pub copy_existing: bool,
    /// `None` asks first: a name conflict returns the names and imports nothing.
    pub conflict: Option<NameConflict>,
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
        // A replaced folder merges, so a file inside it can meet a folder of
        // its name; refusing here keeps the whole batch from half-landing.
        if destination.as_deref().is_some_and(Path::is_dir) {
            return Err(format!("{relative} is already a folder in this project."));
        }
        // The transaction log records the text it replaces, so a text file
        // replacing one that is not text is copied verbatim instead.
        let replaces_binary = destination
            .as_deref()
            .is_some_and(|path| path.is_file() && fs::read_to_string(path).is_err());
        let planned = match destination {
            None => Planned::Existing,
            Some(_) if text && !replaces_binary => {
                Planned::Text { content: fs::read_to_string(source).map_err(err)? }
            }
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
                if let Some(path) = entry_destination.as_deref().filter(|path| path.is_file()) {
                    let relative = relative_to(self.canonical_root, path)?;
                    return Err(format!("{relative} is already a file in this project."));
                }
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

/// Any mix of files and folders. Folder imports preserve their hierarchy under
/// one top-level name; hidden entries are omitted and symbolic links are not
/// followed. Content — not extension — decides each file's route. UTF-8 text
/// lands through the undoable transaction log like `import_sources`; figures
/// keep the `import_assets` copy route and classify as "binary" (SVG is text
/// bytes but a figure); everything else is copied verbatim. Files already
/// inside the project are registered without copying unless `copy_existing`.
/// `progress` hears (files written, files planned) as the copy goes.
pub fn import_files(
    root: &Path, request: ImportRequest, progress: &mut dyn FnMut(usize, usize),
) -> Result<ProjectImport, String> {
    let ImportRequest { sources, target_directory, copy_existing, conflict } = request;
    if sources.is_empty() {
        return Err("Drop one or more files or folders first.".to_string());
    }
    let (canonical_root, target) =
        drop_target(root, target_directory, "Drop files and folders onto a project folder.")?;

    // Asked without a policy, a taken name stops the import before anything
    // is read, so the answer can come back with the same sources.
    let Some(conflict) = conflict else {
        let mut conflicts = Vec::new();
        for source in sources {
            let requested = Path::new(source);
            let registers_in_place = !copy_existing
                && requested.canonicalize().is_ok_and(|path| path.starts_with(&canonical_root));
            let name = file_name(requested, "An imported file")?;
            if !registers_in_place && target.join(name).exists() {
                conflicts.push(name.to_string());
            }
        }
        if !conflicts.is_empty() {
            return Ok(ProjectImport { conflicts, ..ProjectImport::default() });
        }
        return import_files(
            root,
            ImportRequest { conflict: Some(NameConflict::KeepBoth), ..request },
            progress,
        );
    };

    let mut plan =
        ImportPlan { canonical_root: &canonical_root, directories: Vec::new(), files: Vec::new() };
    let mut entries = Vec::new();
    let mut skipped = Vec::new();
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
            entries.push(relative_to(&canonical_root, &canonical_source)?);
            continue;
        }
        let file_name = file_name(requested, "An imported file")?;
        validate_entry_name(file_name)?;
        if file_type.is_dir() && canonical_root.starts_with(&canonical_source) {
            return Err(format!(
                "{name} contains the current project and cannot be imported into it."
            ));
        }
        let taken = target.join(file_name);
        // Two sources of one name in the same batch never replace each other.
        let destination = if !taken.exists() || reserved.contains(&taken) {
            available_path(&target, file_name, !file_type.is_dir(), &reserved)
        } else {
            match conflict {
                NameConflict::Skip => {
                    skipped.push(file_name.to_string());
                    continue;
                }
                NameConflict::Replace if taken.is_dir() == file_type.is_dir() => taken,
                _ => available_path(&target, file_name, !file_type.is_dir(), &reserved),
            }
        };
        reserved.insert(destination.clone());
        entries.push(relative_to(&canonical_root, &destination)?);
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
    let total = plan.files.len();
    let mut written = 0;
    let mut edits = Vec::new();
    for (file, planned) in &plan.files {
        match planned {
            Planned::Existing => written += 1,
            Planned::Text { content } => edits.push((file.path.clone(), content.clone())),
            Planned::Binary { source, destination } => {
                fs::copy(source, destination).map_err(err)?;
                written += 1;
                progress(written, total);
            }
        }
    }
    if !edits.is_empty() {
        apply_transaction(root, &import_label(&edits, "files"), edits)?;
    }
    progress(total, total);
    Ok(ProjectImport {
        conflicts: Vec::new(),
        files: plan.files.into_iter().map(|(file, _)| file).collect(),
        entries,
        skipped,
    })
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
mod tests;
