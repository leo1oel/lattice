//! What a project folder contains: the file tree each view shows, content
//! classification, and reading text files.

use super::paths::{extension, safe_path};
use crate::models::FileNode;
use crate::util::err;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// Content classification reads at most this many bytes. Larger files are
/// visible but conservatively binary/unknown, avoiding unbounded scans.
pub(super) const MAX_CLASSIFIED_TEXT_BYTES: u64 = 8 * 1024 * 1024;
/// Standalone HTML often embeds Plotly or image data and legitimately exceeds
/// the general text-scan limit. Keep its local editor/preview path bounded too.
pub(super) const MAX_LOCAL_HTML_BYTES: u64 = 32 * 1024 * 1024;

/// Extensions of the files a LaTeX run leaves beside its source and nobody
/// edits by hand. The `.gitignore` lines of new and adopted projects, the
/// tree's artifact filter ([`is_build_artifact`]), and the outputs deleted when
/// a `.tex` file moves ([`tex_build_outputs`]) all derive from this list. Kept
/// aligned with `ARTIFACT_SUFFIXES` in `overleaf/files.rs`: a file sync refuses to upload
/// should not sit in the tree pretending to be project content.
const LATEX_ARTIFACT_EXTENSIONS: &[&str] = &[
    "aux",
    "bbl",
    "bcf",
    "blg",
    "brf",
    "dvi",
    "fdb_latexmk",
    "fls",
    "idx",
    "ilg",
    "ind",
    "lof",
    "log",
    "lot",
    "nav",
    "out",
    "run.xml",
    "snm",
    "synctex",
    "synctex.gz",
    "toc",
    "vrb",
    "xdv",
];

/// `.gitignore` entries for what a LaTeX run leaves beside the source. The
/// agent's per-turn checkpoints are built on version tracking, and these large,
/// rewritten-every-build files would otherwise stall and bury every turn diff.
pub(super) fn build_artifact_ignore_lines() -> impl Iterator<Item = String> {
    LATEX_ARTIFACT_EXTENSIONS
        .iter()
        .map(|extension| format!("*.{extension}"))
        .chain(["*-SAVE-ERROR".to_string()])
}

/// Extensions of the stale outputs a moved `.tex` file leaves behind. Spelled
/// out from the shared list rather than the tree filter: that one hides a bare
/// `.gz`, and deleting someone's `main.gz` because they renamed `main.tex`
/// would be data loss.
pub(super) fn tex_build_outputs() -> impl Iterator<Item = &'static str> {
    ["pdf", "bbl-SAVE-ERROR", "bcf-SAVE-ERROR"]
        .into_iter()
        .chain(LATEX_ARTIFACT_EXTENSIONS.iter().copied())
}

/// Files a LaTeX run drops next to the source that nobody edits by hand.
///
/// Matched against the whole file name rather than [`Path::extension`],
/// because the ones that used to leak through are not single extensions —
/// biblatex writes `main.run.xml`, and latexmk parks a run it could not finish
/// at `main.bbl-SAVE-ERROR` (its `$save_error_suffix`).
pub(super) fn is_build_artifact(path: &Path) -> bool {
    if path.extension().is_some_and(|ext| ext == "pdf") && path.with_extension("tex").exists() {
        return true;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let lowercased = name.to_ascii_lowercase();
    // latexmk renames instead of deleting whenever biber leaves behind a file
    // it cannot trust, so every artifact has a `-SAVE-ERROR` twin.
    let stem = lowercased.strip_suffix("-save-error").unwrap_or(&lowercased);
    // A bare `.gz` is broader than `.synctex.gz` on purpose: the extension
    // check this replaced already hid it, and narrowing it would surface
    // archives no project has ever shown. SyncTeX appends `(busy)` while
    // writing, then renames the completed file.
    ["gz", "synctex(busy)", "synctex.gz(busy)"]
        .iter()
        .chain(LATEX_ARTIFACT_EXTENSIONS)
        .any(|extension| stem.ends_with(&format!(".{extension}")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ContentKind {
    Text,
    Binary,
}

pub(super) fn classify_file_bytes(bytes: &[u8]) -> ContentKind {
    // Binary formats can have an ASCII-only prefix and no early NULs. Known
    // signatures keep routing content-based without trusting the extension.
    let binary_signature = [
        &b"%PDF-"[..],
        b"\x89PNG\r\n\x1a\n",
        b"\xff\xd8\xff",
        b"GIF87a",
        b"GIF89a",
        b"PK\x03\x04",
        b"\x7fELF",
    ]
    .iter()
    .any(|signature| bytes.starts_with(signature))
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"));
    if bytes.contains(&0) || binary_signature || std::str::from_utf8(bytes).is_err() {
        ContentKind::Binary
    } else {
        ContentKind::Text
    }
}

pub(super) fn is_html_path(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("html"))
}

/// Largest file the local editor and tree treat as text.
fn local_text_limit(path: &Path) -> u64 {
    if is_html_path(path) {
        MAX_LOCAL_HTML_BYTES
    } else {
        MAX_CLASSIFIED_TEXT_BYTES
    }
}

fn classify_with_limit(
    path: &Path, metadata: &fs::Metadata, maximum: u64,
) -> Result<ContentKind, String> {
    if !metadata.file_type().is_file() || metadata.len() > maximum {
        return Ok(ContentKind::Binary);
    }
    Ok(classify_file_bytes(&fs::read(path).map_err(err)?))
}

/// Content kind under the general text limit, never following links.
pub(super) fn classify_regular_file(path: &Path) -> Result<ContentKind, String> {
    let metadata = fs::symlink_metadata(path).map_err(err)?;
    classify_with_limit(path, &metadata, MAX_CLASSIFIED_TEXT_BYTES)
}

/// (mtime, len) → kind memo consulted by the tree scan. The frontend polls
/// `refresh_project` every 2 seconds and classification is the only part of
/// the scan that reads file contents, so without it every tick re-read the
/// whole project. Content cannot change without the metadata pair changing
/// (`atomic_write` replaces the file, bumping mtime). Keyed on absolute path;
/// cleared wholesale past the bound — the working set is one project tree.
type ClassifyCacheEntry = (SystemTime, u64, ContentKind);
static CLASSIFY_CACHE: LazyLock<Mutex<HashMap<PathBuf, ClassifyCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const CLASSIFY_CACHE_MAX_ENTRIES: usize = 65_536;

fn classify_tree_file(path: &Path, metadata: &fs::Metadata) -> Result<ContentKind, String> {
    let Ok(modified) = metadata.modified() else {
        return classify_with_limit(path, metadata, local_text_limit(path));
    };
    let len = metadata.len();
    if let Some((cached_mtime, cached_len, kind)) = CLASSIFY_CACHE.lock().unwrap().get(path) {
        if *cached_mtime == modified && *cached_len == len {
            return Ok(*kind);
        }
    }
    let kind = classify_with_limit(path, metadata, local_text_limit(path))?;
    let mut cache = CLASSIFY_CACHE.lock().unwrap();
    if cache.len() >= CLASSIFY_CACHE_MAX_ENTRIES {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), (modified, len, kind));
    Ok(kind)
}

/// Cached literature under `.research/papers/`.
pub(super) fn is_paper_library_path(relative: &str) -> bool {
    relative == ".research/papers" || relative.starts_with(".research/papers/")
}

/// Why sync and search never see a path; `None` means it is project content.
fn exclusion_reason(relative: &Path, name: &str, path: &Path) -> Option<&'static str> {
    let normalized = relative.to_string_lossy().replace('\\', "/");
    if normalized == ".git" || normalized.starts_with(".git/") {
        return Some("git-internals");
    }
    if normalized == ".research" || normalized.starts_with(".research/") {
        return Some("app-private-state");
    }
    if matches!(name, ".DS_Store" | "Thumbs.db" | "desktop.ini" | ".Spotlight-V100" | ".Trashes") {
        return Some("os-junk");
    }
    if matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | "__pycache__"
            | ".pytest_cache"
            | ".mypy_cache"
    ) {
        return Some("generated-directory");
    }
    if is_build_artifact(path)
        || name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".tmp")
    {
        return Some("transient-artifact");
    }
    None
}

/// [`exclusion_reason`] plus what the Project pane hides from people: dotted
/// paths and agent configuration.
fn project_tree_exclusion_reason(relative: &Path, name: &str, path: &Path) -> Option<&'static str> {
    exclusion_reason(relative, name, path).or_else(|| {
        let normalized = relative.to_string_lossy().replace('\\', "/");
        (normalized.split('/').any(|segment| segment.starts_with('.')) || name == "opencode.json")
            .then_some("hidden-project-config")
    })
}

pub(crate) fn project_tree_path_visible(root: &Path, relative: &Path) -> bool {
    let Some(name) = relative.file_name() else {
        return false;
    };
    project_tree_exclusion_reason(relative, &name.to_string_lossy(), &root.join(relative)).is_none()
}

/// Which slice of the folder a tree scan returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TreeView {
    /// Everything sync and search may see: VCS, app state, junk, and build
    /// output are left out.
    Inventory,
    /// The Project pane (and search index): additionally hides dotted paths
    /// and agent configuration.
    Project,
    /// The navigator's expanded view: dotfiles and build output come back,
    /// `.git` and `.research` never do. Never used by sync or search.
    ProjectWithHidden,
}

pub(crate) fn scan_tree(root: &Path, view: TreeView) -> Result<Vec<FileNode>, String> {
    scan_directory(root, root, view)
}

fn scan_directory(root: &Path, directory: &Path, view: TreeView) -> Result<Vec<FileNode>, String> {
    let show_hidden = view == TreeView::ProjectWithHidden;
    let mut nodes = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = path.strip_prefix(root).map_err(err)?.to_string_lossy().to_string();
        let excluded = if view == TreeView::Inventory {
            exclusion_reason(Path::new(&relative), &name, &path)
        } else {
            project_tree_exclusion_reason(Path::new(&relative), &name, &path)
        };
        if excluded.is_some_and(|reason| {
            !show_hidden || !matches!(reason, "transient-artifact" | "hidden-project-config")
        }) || (show_hidden && matches!(name.as_str(), ".git" | ".research"))
        {
            continue;
        }
        let metadata = fs::symlink_metadata(&path).map_err(err)?;
        let file_type = metadata.file_type();
        let (kind, content_kind, size, children) = if file_type.is_symlink() {
            ("symlink", "symlink", 0, Vec::new())
        } else if file_type.is_dir() {
            ("directory", "directory", 0, scan_directory(root, &path, view)?)
        } else if file_type.is_file() {
            let (kind, content_kind) = match classify_tree_file(&path, &metadata)? {
                ContentKind::Text => (file_kind(&path), "text"),
                ContentKind::Binary if is_supported_asset(&path) => ("figure", "binary"),
                ContentKind::Binary => ("binary", "binary"),
            };
            (kind, content_kind, metadata.len(), Vec::new())
        } else {
            continue;
        };
        nodes.push(FileNode {
            name,
            path: relative,
            kind: kind.to_string(),
            content_kind: content_kind.to_string(),
            size,
            children,
        });
    }
    nodes.sort_by(|a, b| {
        (b.kind == "directory")
            .cmp(&(a.kind == "directory"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            // Case-colliding names can coexist on case-sensitive hosts.
            // Keep both and use raw name/path as deterministic tie-breaks.
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(nodes)
}

/// Every non-directory node of a scanned tree, depth first in tree order.
pub(crate) fn tree_files(nodes: &[FileNode]) -> Vec<&FileNode> {
    let mut files = Vec::new();
    for node in nodes {
        if node.kind == "directory" {
            files.extend(tree_files(&node.children));
        } else {
            files.push(node);
        }
    }
    files
}

fn file_kind(path: &Path) -> &'static str {
    match extension(path).as_deref() {
        Some("tex") => "tex",
        Some("bib") => "bib",
        Some("md") => "markdown",
        Some("tldr") => "tldr",
        Some("lattice-sheet") => "spreadsheet",
        Some("png" | "jpg" | "jpeg" | "pdf" | "svg" | "eps" | "webp") => "figure",
        _ => "text",
    }
}

/// Figures LaTeX can include (after conversion for SVG and WebP).
pub(super) fn is_supported_asset(path: &Path) -> bool {
    matches!(
        extension(path).as_deref(),
        Some("png" | "jpg" | "jpeg" | "pdf" | "svg" | "eps" | "webp")
    )
}

const NOT_EDITABLE: &str =
    "This is a binary or unsupported file and cannot be opened in the source editor.";

pub fn read_file(root: &Path, relative: &str) -> Result<String, String> {
    let path = safe_path(root, relative)?;
    // One read serves classification and content.
    let metadata = fs::symlink_metadata(&path).map_err(err)?;
    if !metadata.file_type().is_file() || metadata.len() > local_text_limit(&path) {
        return Err(NOT_EDITABLE.to_string());
    }
    let bytes = fs::read(&path).map_err(err)?;
    if classify_file_bytes(&bytes) != ContentKind::Text {
        return Err(NOT_EDITABLE.to_string());
    }
    String::from_utf8(bytes).map_err(|_| "This is not lossless UTF-8 text.".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileStat {
    pub exists: bool,
    pub mtime_ms: u128,
}

pub fn stat_file(root: &Path, relative: &str) -> Result<ProjectFileStat, String> {
    let path = safe_path(root, relative)?;
    if !path.is_file() {
        return Ok(ProjectFileStat { exists: false, mtime_ms: 0 });
    }
    let modified = path.metadata().and_then(|meta| meta.modified()).map_err(err)?;
    let mtime_ms =
        modified.duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis());
    Ok(ProjectFileStat { exists: true, mtime_ms })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::manifest::open;
    use crate::project::paths::creation_path;
    use crate::project::test_support::Fixture;

    fn paths(nodes: &[FileNode]) -> Vec<&str> {
        nodes.iter().map(|node| node.path.as_str()).collect()
    }

    #[test]
    fn inventory_classifies_content_without_extension_and_hides_project_config() {
        let fixture = Fixture::empty("inventory-content");
        let root = &fixture.root;
        let text = ["README", "known.bin", ".env.example", ".ignore", "opencode.json", "bom.txt"];
        let scripts = ["source.tsx", "source.ts", "source.jsx", "source.js"];
        for (path, contents) in [
            ("README", &b"plain utf-8\r\n"[..]),
            ("known.bin", b"still text\n"),
            (".env.example", b"SAFE=value\n"),
            (".ignore", b"private\n"),
            ("opencode.json", b"{}\n"),
            ("bom.txt", b"\xef\xbb\xbfhello\r\n"),
            ("nul.txt", b"hello\0world"),
            ("unknown.dat", &[0xff, 0xfe, 0x01]),
            // Native script sources stay text without admitting binary content.
            ("source.tsx", b"export default 1;\n"),
            ("source.ts", b"export default 1;\n"),
            ("source.jsx", b"export default 1;\n"),
            ("source.js", b"export default 1;\n"),
            ("binary.tsx", b"export\0binary"),
            (".vscode/settings.json", b"{}\n"),
            (".pi/extensions/extension.ts", b"hidden\n"),
            (".research/cache/private", b"private"),
            ("node_modules/generated.js", b"generated"),
        ] {
            fixture.write(path, contents);
        }

        let files = scan_tree(root, TreeView::Inventory).unwrap();
        // The tree classifies by content, not by extension.
        let kind =
            |path: &str| files.iter().find(|node| node.path == path).unwrap().content_kind.as_str();
        for path in text.into_iter().chain(scripts) {
            assert_eq!(kind(path), "text", "{path}");
        }
        for path in ["nul.txt", "unknown.dat", "binary.tsx"] {
            assert_eq!(kind(path), "binary", "{path}");
        }
        assert!(!paths(&files).contains(&"node_modules"));
        let project_tree = scan_tree(root, TreeView::Project).unwrap();
        for hidden in [".env.example", ".ignore", ".vscode", ".pi", ".research", "opencode.json"] {
            assert!(!paths(&project_tree).contains(&hidden), "{hidden}");
        }
        assert_eq!(read_file(root, "bom.txt").unwrap().as_bytes(), b"\xef\xbb\xbfhello\r\n");
        assert!(read_file(root, "nul.txt").is_err());
    }

    #[test]
    fn expanded_tree_shows_hidden_files_without_changing_inventory() {
        let fixture = Fixture::empty("expanded-tree");
        let root = &fixture.root;
        let files = ["main.tex", "main.fls", "main.pdf", "journal.sty", "refs.bst", ".env.example"];
        for name in files {
            fixture.write(name, b"content");
        }
        for directory in
            [".config", ".git", ".research", "node_modules", ".config/.git", ".config/node_modules"]
        {
            fixture.write(&format!("{directory}/settings.txt"), b"content");
        }
        fixture.write("references.bib", b"@article{x, title={X}}\n");
        fixture.write(".research/papers/2401.00001/paper_assets/figure.png", b"\x89PNG\r\n\x1a\n");

        let expanded = scan_tree(root, TreeView::ProjectWithHidden).unwrap();
        for name in files.into_iter().chain([".config"]) {
            assert!(paths(&expanded).contains(&name), "{name}");
        }
        for name in [".git", ".research", "node_modules"] {
            assert!(!paths(&expanded).contains(&name), "{name}");
        }
        let config = expanded.iter().find(|node| node.path == ".config").unwrap();
        assert_eq!(paths(&config.children), vec![".config/settings.txt"]);
        let normal = scan_tree(root, TreeView::Project).unwrap();
        for name in ["main.fls", "main.pdf", ".env.example", ".config"] {
            assert!(!paths(&normal).contains(&name), "{name}");
        }
        let inventory = scan_tree(root, TreeView::Inventory).unwrap();
        let listed: Vec<&str> =
            tree_files(&inventory).into_iter().map(|file| file.path.as_str()).collect();
        for (path, expected) in [
            ("main.fls", false),
            ("journal.sty", true),
            ("refs.bst", true),
            ("references.bib", true),
        ] {
            assert_eq!(listed.contains(&path), expected, "{path}");
        }
        assert!(!listed.iter().any(|path| path.starts_with(".research")));
    }

    #[test]
    fn symlinks_are_visible_but_never_followed() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::empty("inventory-links");
        let outside = Fixture::empty("inventory-links-outside");
        outside.write("secret", b"secret");
        symlink(outside.path("secret"), fixture.path("outside-link")).unwrap();
        symlink(&outside.root, fixture.path("outside-directory")).unwrap();
        let files = scan_tree(&fixture.root, TreeView::Inventory).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|node| node.content_kind == "symlink"));
        assert!(read_file(&fixture.root, "outside-link").is_err());
        assert!(creation_path(&fixture.root, "outside-directory/new").is_err());
    }

    #[test]
    fn build_artifacts_are_hidden_from_the_source_tree() {
        let fixture = Fixture::empty("build-artifacts");
        for (name, contents) in [
            ("main.tex", "source"),
            ("references.bib", "@article{a,}"),
            // A compiled PDF hides beside its source; a reading PDF does not.
            ("main.pdf", "%PDF-binary"),
            ("reading.pdf", "%PDF-binary"),
            // biblatex writes these two on every single build.
            ("main.bcf", "<control/>"),
            ("main.run.xml", "<requests/>"),
            // latexmk saves rather than deletes what it cannot trust.
            ("main.bbl-SAVE-ERROR", "stale"),
            ("main.toc", "contents"),
            // SyncTeX output, finished or still being written.
            ("main.synctex", "SyncTeX data"),
            ("main.synctex.gz", "SyncTeX data"),
            ("main.synctex(busy)", "SyncTeX data"),
            ("main.synctex.gz(busy)", "SyncTeX data"),
            // Neither a human's .xml nor a user file containing `(busy)` is an artifact.
            ("data.xml", "<rows/>"),
            ("notes(busy)", "notes"),
        ] {
            fixture.write(name, contents);
        }
        // `open` is the desktop's refresh_project entry point.
        let files = open(&fixture.root).unwrap().files;
        let visible = ["data.xml", "main.tex", "notes(busy)", "reading.pdf", "references.bib"];
        assert_eq!(paths(&files), visible);
        assert!(fixture.path("main.synctex(busy)").exists(), "hiding must not delete it");
    }

    #[test]
    fn classification_cache_tracks_content_changes() {
        let fixture = Fixture::empty("classify-cache");
        let file = fixture.path("note.md");
        for (contents, kind) in
            [(&b"text\n"[..], ContentKind::Text), (b"a\0b", ContentKind::Binary)]
        {
            // A rewrite changes (mtime, len), so the cached kind must not stick.
            fs::write(&file, contents).unwrap();
            let metadata = fs::symlink_metadata(&file).unwrap();
            assert_eq!(classify_tree_file(&file, &metadata).unwrap(), kind);
        }
    }
}
