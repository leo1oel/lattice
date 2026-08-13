use crate::commands;
use crate::models::{
    AssetPreview, CitationInfo, EditorComment, EditorCommentsFile, FileChange, FileNode,
    HistoryItem, PdfMark, PdfMarksFile, ProjectManifest, ProjectSearchResult, ProjectSnapshot,
    ReferenceInfo, RenameSymbolResult, ReplaceMatch, ReplacePreview, ReplaceResult,
    ResolvedCitation, RootDocument, SymbolOccurrence, SyncTexTarget, TodoHit, TransactionRecord,
    UnusedSymbols,
};
use crate::project_fs::ProjectDir;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;
use uuid::Uuid;
use walkdir::WalkDir;

const MANIFEST_PATH: &str = ".research/project.json";
const PDF_MARKS_PATH: &str = ".research/pdf-annotations.json";
const EDITOR_COMMENTS_PATH: &str = ".research/editor-comments.json";
const MATERIALIZATION_INDEX_PATH: &str = ".research/cache/materialization-index-v1.json";
/// Inventory classification reads at most this many bytes. Larger files are
/// visible but conservatively binary/unknown, avoiding unbounded scans.
const MAX_CLASSIFIED_TEXT_BYTES: u64 = 8 * 1024 * 1024;
const RESEARCH_GITIGNORE: &str = "history/\nsessions/\ncheckpoints/\ncache/\n";
const MAX_HISTORY_ENTRIES: usize = 100;
const MAX_CHECKPOINTS_PER_SESSION: usize = 100;
const MAX_CHECKPOINT_BYTES: u64 = 256 * 1024 * 1024;
const EDIT_COALESCE_SECS: i64 = 45;
const HISTORY_SCHEMA_VERSION: u32 = 2;
const NEURIPS_2026_MAIN: &str = include_str!("../templates/neurips-2026/main.tex");
const NEURIPS_2026_STYLE: &str = include_str!("../templates/neurips-2026/neurips_2026.sty");
const ICML_2026_MAIN: &str = include_str!("../templates/icml-2026/main.tex");
const ICML_2026_STYLE: &str = include_str!("../templates/icml-2026/icml2026.sty");
const ICML_2026_BST: &str = include_str!("../templates/icml-2026/icml2026.bst");
const ICLR_2026_MAIN: &str = include_str!("../templates/iclr-2026/main.tex");
const ICLR_2026_STYLE: &str = include_str!("../templates/iclr-2026/iclr2026_conference.sty");
const ICLR_2026_BST: &str = include_str!("../templates/iclr-2026/iclr2026_conference.bst");
const TUTORIAL_MAIN: &str = include_str!("../templates/tutorial/main.tex");
const TUTORIAL_NOTES: &str = include_str!("../templates/tutorial/notes.md");
const TUTORIAL_HTML: &str = include_str!("../templates/tutorial/attention-demo.html");
const TUTORIAL_BOARD: &str = include_str!("../templates/tutorial/attention-map.tldr");
const TUTORIAL_TOML: &str = include_str!("../templates/tutorial/project.toml");
const TUTORIAL_REFERENCES: &str = include_str!("../templates/tutorial/references.bib");
const TUTORIAL_FIGURE_ATTRIBUTION: &str =
    include_str!("../templates/tutorial/figures/ATTRIBUTION.md");
const TUTORIAL_SCALED_ATTENTION_PNG: &[u8] =
    include_bytes!("../templates/tutorial/figures/scaled-dot-product-attention.png");
const TUTORIAL_MULTI_HEAD_ATTENTION_PNG: &[u8] =
    include_bytes!("../templates/tutorial/figures/multi-head-attention.png");
const TUTORIAL_ATTENTION_FIGURE_PDF: &[u8] =
    include_bytes!("../templates/tutorial/figures/attention-figure-2.pdf");
const TUTORIAL_PROJECT_NAME: &str = "Understanding Attention";
const TUTORIAL_V2_SVG_MD5: &str = "5208e75172b7e7b5bbf2faee51da289a";
const TUTORIAL_V2_PDF_MD5: &str = "52a33c6af6420aaf86e642cd24a8f466";

/// Local-only durable state for the future v2 catalog/materializer. This is
/// deliberately not wired to collaboration and lives under excluded cache.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct MaterializationIndex {
    pub schema_version: u32,
    pub files: BTreeMap<String, MaterializedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct MaterializedFile {
    pub path: String,
    pub document_epoch: u64,
    pub applied_revision: u64,
    pub durable_revision: u64,
    pub content_sha256: String,
}

#[allow(dead_code)]
pub fn read_materialization_index(root: &Path) -> Result<MaterializationIndex, String> {
    let path = root.join(MATERIALIZATION_INDEX_PATH);
    if !path.exists() {
        return Ok(MaterializationIndex {
            schema_version: 1,
            files: BTreeMap::new(),
        });
    }
    let index: MaterializationIndex =
        serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
    if index.schema_version != 1 {
        return Err("Unsupported materialization index schema.".to_string());
    }
    Ok(index)
}

#[allow(dead_code)]
pub fn write_materialization_index(
    root: &Path,
    index: &MaterializationIndex,
) -> Result<(), String> {
    if index.schema_version != 1 {
        return Err("Unsupported materialization index schema.".to_string());
    }
    let path = root.join(MATERIALIZATION_INDEX_PATH);
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid materialization index path.".to_string())?;
    fs::create_dir_all(parent).map_err(err)?;
    let temporary = parent.join(format!(".materialization-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create(&temporary).map_err(err)?;
        file.write_all(&serde_json::to_vec_pretty(index).map_err(err)?)
            .map_err(err)?;
        file.write_all(b"\n").map_err(err)?;
        file.sync_all().map_err(err)?;
        fs::rename(&temporary, &path).map_err(err)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Venue {
    Neurips,
    Icml,
    Iclr,
}

impl Venue {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "neurips" | "nips" => Ok(Self::Neurips),
            "icml" => Ok(Self::Icml),
            "iclr" => Ok(Self::Iclr),
            other => Err(format!(
                "Unknown venue “{other}”. Choose neurips, icml, or iclr."
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Neurips => "neurips",
            Self::Icml => "icml",
            Self::Iclr => "iclr",
        }
    }
}

#[derive(Debug, Clone)]
struct HistoryContext {
    actor: &'static str,
    kind: &'static str,
    source: &'static str,
    thread_id: Option<String>,
    checkpoint_ref: Option<String>,
    undo_of: Option<String>,
}

impl HistoryContext {
    fn user(kind: &'static str, source: &'static str) -> Self {
        Self {
            actor: "user",
            kind,
            source,
            thread_id: None,
            checkpoint_ref: None,
            undo_of: None,
        }
    }

    fn restore(source: &TransactionRecord) -> Self {
        Self {
            actor: "user",
            kind: "restore",
            source: "history",
            thread_id: source.thread_id.clone(),
            checkpoint_ref: source.checkpoint_ref.clone(),
            undo_of: Some(source.id.clone()),
        }
    }
}

fn new_transaction(
    label: &str,
    changes: Vec<FileChange>,
    context: HistoryContext,
) -> TransactionRecord {
    TransactionRecord {
        schema_version: HISTORY_SCHEMA_VERSION,
        id: format!(
            "{}-{}",
            Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
            Uuid::new_v4()
        ),
        label: label.to_string(),
        timestamp: Utc::now().to_rfc3339(),
        actor: Some(context.actor.to_string()),
        kind: Some(context.kind.to_string()),
        source: Some(context.source.to_string()),
        thread_id: context.thread_id,
        checkpoint_ref: context.checkpoint_ref,
        undo_of: context.undo_of,
        changes,
    }
}

fn inferred_history_metadata(record: &TransactionRecord) -> (&str, &str, &str) {
    if let (Some(actor), Some(kind), Some(source)) = (
        record.actor.as_deref(),
        record.kind.as_deref(),
        record.source.as_deref(),
    ) {
        return (actor, kind, source);
    }
    let label = record.label.to_ascii_lowercase();
    if label.starts_with("agent:") || label == "agent edit" {
        ("agent", "agent", "agent")
    } else if label.starts_with("cite ")
        || label.starts_with("remove ")
        || label == "upgrade bibliography"
    {
        ("citation", "citation", "citation")
    } else if label.starts_with("restore ") {
        ("user", "restore", "history")
    } else if label.starts_with("edit ") {
        ("user", "edit", "editor")
    } else {
        ("user", "project", "project")
    }
}

pub fn default_manifest(name: &str) -> ProjectManifest {
    default_manifest_with_venue(name, Venue::Neurips)
}

fn default_manifest_with_venue(name: &str, venue: Venue) -> ProjectManifest {
    let (word_budget, page_budget) = venue_budgets(venue);
    ProjectManifest {
        schema_version: 1,
        project_id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        root_documents: vec![RootDocument {
            path: "main.tex".to_string(),
            name: "Main paper".to_string(),
            is_default: true,
        }],
        primary_bibliography: "references.bib".to_string(),
        trusted: false,
        engine: "pdf".to_string(),
        venue: venue.as_str().to_string(),
        word_budget,
        page_budget,
        spelling_words: Vec::new(),
    }
}

fn venue_budgets(venue: Venue) -> (Option<u32>, Option<u32>) {
    match venue {
        Venue::Neurips => (Some(5500), Some(9)),
        Venue::Icml => (Some(5500), Some(8)),
        Venue::Iclr => (Some(5500), Some(9)),
    }
}

/// NeurIPS default used by unit tests across the crate.
pub fn create(parent: &Path, name: &str) -> Result<PathBuf, String> {
    create_with_venue(parent, name, Venue::Neurips)
}

fn validate_new_project_name(name: &str) -> Result<&str, String> {
    let safe_name = name.trim();
    if safe_name.is_empty()
        || safe_name.contains('/')
        || safe_name.contains('\\')
        || safe_name == "."
        || safe_name == ".."
    {
        return Err("Choose a simple project name without path separators.".to_string());
    }
    Ok(safe_name)
}

/// `.gitignore` entries for what a LaTeX run leaves beside the source.
///
/// Version tracking is what the agent's per-turn checkpoints are built on, so
/// anything git watches here ends up inside a turn diff. A build rewrites all
/// of these on every compile, and they are large and machine-generated — one
/// `main.log` ran to 50 KB — which is enough to stall the review panel while it
/// tries to render them, and enough to bury the actual edit the turn made.
const BUILD_ARTIFACT_IGNORE_LINES: &[&str] = &[
    "*.aux",
    "*.bbl",
    "*.bcf",
    "*.blg",
    "*.brf",
    "*.dvi",
    "*.fdb_latexmk",
    "*.fls",
    "*.idx",
    "*.ilg",
    "*.ind",
    "*.lof",
    "*.log",
    "*.lot",
    "*.nav",
    "*.out",
    "*.run.xml",
    "*.snm",
    "*.synctex",
    "*.synctex.gz",
    "*.toc",
    "*.vrb",
    "*.xdv",
    "*-SAVE-ERROR",
];

fn prepare_project_skeleton(root: &Path) -> Result<(), String> {
    if root.exists() && fs::read_dir(root).map_err(err)?.next().is_some() {
        return Err("That folder already exists and is not empty.".to_string());
    }
    fs::create_dir_all(root.join(".research/papers")).map_err(err)?;
    fs::create_dir_all(root.join(".research/history")).map_err(err)?;
    fs::create_dir_all(root.join(".research/sessions")).map_err(err)?;
    fs::create_dir_all(root.join(".research/licenses")).map_err(err)?;
    fs::create_dir_all(root.join("figures")).map_err(err)?;
    fs::write(root.join(".research/.gitignore"), RESEARCH_GITIGNORE).map_err(err)?;
    let ignore = [
        ".research/history/",
        ".research/sessions/",
        ".research/checkpoints/",
        ".research/cache/",
        "/main.pdf",
    ]
    .into_iter()
    .chain(BUILD_ARTIFACT_IGNORE_LINES.iter().copied())
    .map(|line| format!("{line}\n"))
    .collect::<String>();
    fs::write(root.join(".gitignore"), ignore).map_err(err)?;
    Ok(())
}

pub fn create_with_venue(parent: &Path, name: &str, venue: Venue) -> Result<PathBuf, String> {
    let safe_name = validate_new_project_name(name)?;
    let root = parent.join(safe_name);
    prepare_project_skeleton(&root)?;

    let manifest = default_manifest_with_venue(safe_name, venue);
    write_manifest(&root, &manifest)?;
    fs::write(root.join(".research/brief.md"), default_brief(safe_name)).map_err(err)?;
    let title = latex_title(safe_name);
    for (relative, body) in venue_template_files(venue, &title) {
        fs::write(root.join(relative), body).map_err(err)?;
    }
    fs::write(root.join("references.bib"), "").map_err(err)?;
    Ok(root)
}

/// Recreate the stable sample project used by the in-app tutorial.
/// The managed tutorial is disposable: every launch starts from the bundled baseline.
pub fn create_tutorial(parent: &Path) -> Result<PathBuf, String> {
    let root = parent.join(TUTORIAL_PROJECT_NAME);
    if root.exists() {
        let managed = fs::read(root.join(".research/tutorial.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|marker| {
                marker
                    .get("id")
                    .and_then(|id| id.as_str())
                    .map(str::to_string)
            })
            .is_some_and(|id| id == "understanding-attention");
        if !managed {
            return Err(format!(
                "A folder named “{TUTORIAL_PROJECT_NAME}” already exists in Lattice Tutorials. Move it, then try again."
            ));
        }
        fs::remove_dir_all(&root).map_err(err)?;
    }

    prepare_project_skeleton(&root)?;
    let mut manifest = default_manifest(TUTORIAL_PROJECT_NAME);
    manifest.venue = "tutorial".to_string();
    manifest.word_budget = None;
    manifest.page_budget = None;
    write_manifest(&root, &manifest)?;
    fs::write(
        root.join(".research/brief.md"),
        "# Understanding Attention\n\n## Goal\n\nLearn the Lattice workflow with an original short paper about attention.\n\n## Evidence\n\nImport arXiv:1706.03762 from the Papers panel before asking an Agent to make factual changes.\n\n## Constraints\n\n- Keep claims conservative.\n- Cite the original paper for architecture and reported results.\n",
    )
    .map_err(err)?;
    fs::write(
        root.join(".research/tutorial.json"),
        "{\n  \"id\": \"understanding-attention\",\n  \"version\": 5\n}\n",
    )
    .map_err(err)?;
    fs::write(root.join("main.tex"), TUTORIAL_MAIN).map_err(err)?;
    fs::write(root.join("notes.md"), TUTORIAL_NOTES).map_err(err)?;
    fs::write(root.join("attention-demo.html"), TUTORIAL_HTML).map_err(err)?;
    fs::write(root.join("attention-map.tldr"), TUTORIAL_BOARD).map_err(err)?;
    fs::write(root.join("project.toml"), TUTORIAL_TOML).map_err(err)?;
    fs::write(root.join("references.bib"), TUTORIAL_REFERENCES).map_err(err)?;
    install_tutorial_assets(&root)?;
    Ok(root)
}

fn install_tutorial_assets(root: &Path) -> Result<(), String> {
    let style = NEURIPS_2026_STYLE.replacen(
        "\\ProvidesPackage{neurips_2026}",
        "\\ProvidesPackage{neurips}",
        1,
    );
    remove_unchanged_tutorial_asset(&root.join("figures/attention-map.svg"), TUTORIAL_V2_SVG_MD5)?;
    remove_unchanged_tutorial_asset(&root.join("figures/attention-map.pdf"), TUTORIAL_V2_PDF_MD5)?;
    for (path, contents) in [
        (root.join("neurips.sty"), style.into_bytes()),
        (
            root.join("figures/scaled-dot-product-attention.png"),
            TUTORIAL_SCALED_ATTENTION_PNG.to_vec(),
        ),
        (
            root.join("figures/multi-head-attention.png"),
            TUTORIAL_MULTI_HEAD_ATTENTION_PNG.to_vec(),
        ),
        (
            root.join("figures/attention-figure-2.pdf"),
            TUTORIAL_ATTENTION_FIGURE_PDF.to_vec(),
        ),
        (
            root.join("figures/ATTRIBUTION.md"),
            TUTORIAL_FIGURE_ATTRIBUTION.as_bytes().to_vec(),
        ),
    ] {
        if !path.exists() {
            fs::write(path, contents).map_err(err)?;
        }
    }
    Ok(())
}

fn remove_unchanged_tutorial_asset(path: &Path, expected_md5: &str) -> Result<(), String> {
    let Ok(contents) = fs::read(path) else {
        return Ok(());
    };
    if format!("{:x}", md5::compute(contents)) == expected_md5 {
        fs::remove_file(path).map_err(err)?;
    }
    Ok(())
}

/// Empty workspace for joining a live share — no conference template files.
/// Guests keep their own projects untouched; shared files materialize here.
pub fn create_blank(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let safe_name = validate_new_project_name(name)?;
    let root = parent.join(safe_name);
    prepare_project_skeleton(&root)?;

    let mut manifest = default_manifest_with_venue(safe_name, Venue::Neurips);
    manifest.venue = "shared".to_string();
    write_manifest(&root, &manifest)?;
    fs::write(
        root.join(".research/brief.md"),
        format!("# {safe_name}\n\nLive collaboration workspace. Your other local projects were not modified.\n"),
    )
    .map_err(err)?;
    // The body must not be empty. pdflatex writes no PDF at all for a document
    // with no pages, and latexmk records that as "failed to create output file"
    // in main.fdb_latexmk. Because the placeholder source does not change
    // afterwards, every later build reports the target up to date and replays
    // that stored failure — a build a guest can never get out of without
    // deleting the auxiliary files, on a project whose real content is still
    // arriving.
    fs::write(
        root.join("main.tex"),
        "% Waiting for shared project files…\n\\documentclass{article}\n\\begin{document}\nWaiting for the shared project files to arrive…\n\\end{document}\n",
    )
    .map_err(err)?;
    fs::write(root.join("references.bib"), "").map_err(err)?;
    Ok(root)
}

fn venue_template_files(venue: Venue, title: &str) -> Vec<(&'static str, String)> {
    match venue {
        Venue::Neurips => vec![
            (
                "main.tex",
                NEURIPS_2026_MAIN.replace("LATTICE_PROJECT_TITLE", title),
            ),
            (
                "neurips.sty",
                NEURIPS_2026_STYLE.replacen(
                    "\\ProvidesPackage{neurips_2026}",
                    "\\ProvidesPackage{neurips}",
                    1,
                ),
            ),
        ],
        Venue::Icml => vec![
            (
                "main.tex",
                ICML_2026_MAIN.replace("LATTICE_PROJECT_TITLE", title),
            ),
            ("icml2026.sty", ICML_2026_STYLE.to_string()),
            ("icml2026.bst", ICML_2026_BST.to_string()),
        ],
        Venue::Iclr => vec![
            (
                "main.tex",
                ICLR_2026_MAIN.replace("LATTICE_PROJECT_TITLE", title),
            ),
            ("iclr2026_conference.sty", ICLR_2026_STYLE.to_string()),
            ("iclr2026_conference.bst", ICLR_2026_BST.to_string()),
        ],
    }
}

pub fn open(root: &Path) -> Result<ProjectSnapshot, String> {
    let root = root.canonicalize().map_err(err)?;
    if !root.is_dir() {
        return Err("The selected path is not a folder.".to_string());
    }

    fs::create_dir_all(root.join(".research/history")).map_err(err)?;
    fs::create_dir_all(root.join(".research/papers")).map_err(err)?;
    fs::create_dir_all(root.join(".research/sessions")).map_err(err)?;
    if let Err(error) = prune_conversation_checkpoints(
        &root,
        MAX_CHECKPOINTS_PER_SESSION,
        MAX_CHECKPOINT_BYTES,
        None,
        None,
    ) {
        eprintln!("Could not prune old conversation checkpoints: {error}");
    }
    let research_ignore = root.join(".research/.gitignore");
    if research_ignore.exists() {
        ensure_ignore_line(&research_ignore, "checkpoints/")?;
    } else {
        fs::write(&research_ignore, RESEARCH_GITIGNORE).map_err(err)?;
    }
    ensure_ignore_line(&root.join(".gitignore"), ".research/checkpoints/")?;
    ensure_ignore_line(&root.join(".gitignore"), ".research/cache/")?;
    ensure_ignore_line(&root.join(".research/.gitignore"), "cache/")?;
    // A folder Lattice did not create gets the same artifact ignores a new
    // project is born with. Version tracking usually starts here, so without
    // them the first commit adopts every .log and .fls in the folder, and from
    // then on each build dirties them and each agent turn diffs them.
    for line in BUILD_ARTIFACT_IGNORE_LINES {
        ensure_ignore_line(&root.join(".gitignore"), line)?;
    }

    let manifest = if root.join(MANIFEST_PATH).exists() {
        read_manifest(&root)?
    } else {
        let name = root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Research project");
        let mut manifest = default_manifest(name);
        // A folder Lattice did not create may hold no LaTeX at all — a folder of
        // Markdown notes, say. `default_manifest` names main.tex because that is
        // what `create` writes, but claiming it here invents a root document
        // that does not exist, and opening the folder then greeted the reader
        // with "Root document not found: main.tex" for a project that simply has
        // nothing to compile. Record the absence instead; callers ask.
        match detect_root_document(&root) {
            Some(relative) => {
                let stem = Path::new(&relative)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Root")
                    .to_string();
                manifest.root_documents[0].path = relative;
                manifest.root_documents[0].name = stem;
            }
            None => manifest.root_documents.clear(),
        }
        if !root.join("references.bib").exists() {
            if let Some(entry) = WalkDir::new(&root)
                .max_depth(3)
                .into_iter()
                .filter_map(Result::ok)
                .find(|entry| entry.path().extension().is_some_and(|ext| ext == "bib"))
            {
                manifest.primary_bibliography = entry
                    .path()
                    .strip_prefix(&root)
                    .map_err(err)?
                    .to_string_lossy()
                    .to_string();
            }
        }
        fs::create_dir_all(root.join(".research")).map_err(err)?;
        write_manifest(&root, &manifest)?;
        if !root.join(".research/brief.md").exists() {
            fs::write(root.join(".research/brief.md"), default_brief(name)).map_err(err)?;
        }
        manifest
    };

    let mut manifest = manifest;
    // Retire a root document that was never there. Folders opened before this
    // check inherited `default_manifest`'s main.tex whether or not they held any
    // LaTeX, and that written-down claim outlived the fix that stopped making
    // it — the folder still opened onto "Root document not found: main.tex".
    // Only a folder with no .tex anywhere qualifies: a root document that is
    // merely absent right now (mid-checkout, renamed, on a detached branch) is
    // still the project's, and forgetting it would lose the reader's setting.
    if !manifest.root_documents.is_empty()
        && !manifest
            .root_documents
            .iter()
            .any(|document| safe_path(&root, &document.path).is_ok_and(|path| path.is_file()))
        && detect_root_document(&root).is_none()
    {
        manifest.root_documents.clear();
        write_manifest(&root, &manifest)?;
    }
    if apply_tex_magic_comments(&root, &mut manifest)? {
        write_manifest(&root, &manifest)?;
    }
    if manifest.word_budget.is_none() && manifest.page_budget.is_none() {
        if let Ok(venue) = Venue::parse(&manifest.venue) {
            let (words, pages) = venue_budgets(venue);
            manifest.word_budget = words;
            manifest.page_budget = pages;
            write_manifest(&root, &manifest)?;
        }
    }

    Ok(ProjectSnapshot {
        root: root.to_string_lossy().to_string(),
        manifest,
        files: scan_project_tree(&root)?,
    })
}

/// Honor `% !TEX root=` / `% !TEX program=` style magic comments when present.
pub fn apply_tex_magic_comments(
    root: &Path,
    manifest: &mut ProjectManifest,
) -> Result<bool, String> {
    let seed = manifest
        .root_documents
        .iter()
        .find(|document| document.is_default)
        .or_else(|| manifest.root_documents.first())
        .map(|document| document.path.clone())
        .unwrap_or_else(|| "main.tex".to_string());
    let absolute = match safe_path(root, &seed) {
        Ok(path) if path.is_file() => path,
        _ => return Ok(false),
    };
    let content = fs::read_to_string(absolute).unwrap_or_default();
    let hints = parse_tex_magic_comments(&content);
    let mut changed = false;
    if let Some(magic_root) = hints.root {
        let relative = magic_root.replace('\\', "/");
        if let Ok(path) = safe_path(root, &relative) {
            if path.is_file() {
                if !manifest
                    .root_documents
                    .iter()
                    .any(|document| document.path == relative)
                {
                    let name = Path::new(&relative)
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Root")
                        .to_string();
                    manifest.root_documents.push(RootDocument {
                        path: relative.clone(),
                        name,
                        is_default: false,
                    });
                    changed = true;
                }
                for document in &mut manifest.root_documents {
                    let next = document.path == relative;
                    if document.is_default != next {
                        document.is_default = next;
                        changed = true;
                    }
                }
            }
        }
    }
    if let Some(engine) = hints.engine {
        if manifest.engine != engine {
            manifest.engine = engine;
            changed = true;
        }
    }
    Ok(changed)
}

#[derive(Debug, Default, PartialEq, Eq)]
struct TexMagicHints {
    root: Option<String>,
    engine: Option<String>,
}

fn parse_tex_magic_comments(content: &str) -> TexMagicHints {
    let mut hints = TexMagicHints::default();
    for line in content.lines().take(40) {
        let trimmed = line.trim();
        let Some(rest) = trimmed
            .strip_prefix("% !TEX")
            .or_else(|| trimmed.strip_prefix("% !TeX"))
            .or_else(|| trimmed.strip_prefix("%!TEX"))
            .or_else(|| trimmed.strip_prefix("%!TeX"))
        else {
            continue;
        };
        let rest = rest.trim().trim_start_matches(':').trim();
        let Some((key, value)) = rest.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();
        if value.is_empty() {
            continue;
        }
        match key.as_str() {
            "root" => hints.root = Some(value.replace('\\', "/")),
            "program" | "ts-program" => {
                hints.engine = match value.to_ascii_lowercase().as_str() {
                    "xelatex" | "xetex" => Some("xelatex".to_string()),
                    "lualatex" | "luatex" => Some("lualatex".to_string()),
                    "pdflatex" | "latex" | "pdftex" => Some("pdf".to_string()),
                    _ => None,
                };
            }
            _ => {}
        }
    }
    hints
}

pub fn has_latexmkrc(root: &Path) -> bool {
    root.join("latexmkrc").is_file() || root.join(".latexmkrc").is_file()
}

/// Collapse `.` / `..` segments lexically. `safe_path` refuses `..` outright,
/// but a `% !TEX root = ../main.tex` written in a chapter file is the normal
/// way to name a root one directory up — resolve it here first, and refuse
/// only paths that climb above the project root (`pop` on an empty stack).
fn normalize_relative(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

/// Which document should a build compile while `open_path` is the file in the
/// editor? Overleaf's rule, extended with TeX magic comments: a `% !TEX root=`
/// in the open file wins, then the open file itself if it declares a document
/// class. `None` means the open file casts no vote (a chapter, a style file,
/// Markdown) and the manifest default stands.
pub fn resolve_compile_root(root: &Path, open_path: &str) -> Option<String> {
    let relative = open_path.trim().replace('\\', "/");
    if !relative.to_ascii_lowercase().ends_with(".tex") {
        return None;
    }
    let absolute = safe_path(root, &relative).ok()?;
    if !absolute.is_file() {
        return None;
    }
    let content = fs::read_to_string(&absolute).ok()?;
    if let Some(magic_root) = parse_tex_magic_comments(&content).root {
        let magic = magic_root.replace('\\', "/");
        let parent = Path::new(&relative)
            .parent()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        // The TeX convention resolves the magic path against the file that
        // declares it; project-root-relative comes second because that is what
        // `apply_tex_magic_comments` has always accepted.
        let candidates = [
            normalize_relative(&format!("{parent}/{magic}")),
            normalize_relative(&magic),
        ];
        for candidate in candidates.into_iter().flatten() {
            if candidate.to_ascii_lowercase().ends_with(".tex")
                && safe_path(root, &candidate).is_ok_and(|path| path.is_file())
            {
                return Some(candidate);
            }
        }
    }
    if declares_document_class(&content) {
        return Some(relative);
    }
    None
}

/// A `\documentclass` on any line, ignoring what follows an unescaped `%` so a
/// commented-out preamble in a chapter file does not turn it into a root.
fn declares_document_class(content: &str) -> bool {
    content.lines().any(|line| {
        line.split('%')
            .next()
            .unwrap_or("")
            .contains("\\documentclass")
    })
}

/// Record `path` as the document builds compile from now on, upserting it into
/// the root-documents list. Written to the manifest rather than kept as a
/// one-shot override so everything that resolves the default root — the PDF
/// preview, SyncTeX, clean, the outline, the next session — follows the
/// document that was actually built.
pub fn set_compile_root(root: &Path, path: &str) -> Result<ProjectManifest, String> {
    let relative = path.trim().replace('\\', "/");
    let mut manifest = read_manifest(root)?;
    if manifest
        .root_documents
        .iter()
        .any(|document| document.is_default && document.path == relative)
    {
        return Ok(manifest);
    }
    if !manifest
        .root_documents
        .iter()
        .any(|document| document.path == relative)
    {
        let name = Path::new(&relative)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(&relative)
            .to_string();
        manifest.root_documents.push(RootDocument {
            path: relative.clone(),
            name,
            is_default: false,
        });
    }
    for document in &mut manifest.root_documents {
        document.is_default = document.path == relative;
    }
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

/// Pick the best root `.tex` for foreign / Overleaf-style trees.
fn detect_root_document(root: &Path) -> Option<String> {
    // Honor `% !TEX root=` first when it points at a real file.
    for entry in WalkDir::new(root)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "tex") {
            continue;
        }
        let content = fs::read_to_string(path).unwrap_or_default();
        if let Some(magic_root) = parse_tex_magic_comments(&content).root {
            let candidate = magic_root.replace('\\', "/");
            if safe_path(root, &candidate)
                .map(|path| path.is_file())
                .unwrap_or(false)
            {
                return Some(candidate);
            }
        }
    }

    let mut best: Option<(i32, String)> = None;
    for entry in WalkDir::new(root)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "tex") {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if relative.split('/').any(|part| part.starts_with('.')) {
            continue;
        }
        let content = fs::read_to_string(path).unwrap_or_default();
        let mut score = 0;
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if file_name == "main.tex" {
            score += 120;
        } else if matches!(
            file_name.as_str(),
            "paper.tex" | "manuscript.tex" | "root.tex" | "article.tex"
        ) {
            score += 90;
        }
        if content.contains("\\documentclass") {
            score += 80;
        }
        // A conflict copy is byte-identical to the real file when it is made,
        // so on score alone it can win the tie and quietly become the document
        // that gets compiled — edits to the real file then never reach the PDF.
        if crate::overleaf::is_conflict_copy(&file_name) {
            score -= 500;
        }
        if content.contains("\\begin{document}") {
            score += 20;
        }
        // Prefer shallower files when scores tie.
        score -= relative.matches('/').count() as i32 * 3;
        match &best {
            Some((best_score, _)) if *best_score >= score => {}
            _ => best = Some((score, relative)),
        }
    }
    best.map(|(_, path)| path)
}

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
    let status = std::process::Command::new("zip")
        .current_dir(&root)
        .arg("-r")
        .arg("-q")
        .arg(zip_path)
        .arg(".")
        .args([
            "-x",
            ".git/*",
            "-x",
            ".research/history/*",
            "-x",
            ".research/sessions/*",
            "-x",
            ".research/omp-sessions/*",
            "-x",
            ".research/omp-session-map/*",
            "-x",
            ".research/omp-runtime/*",
            "-x",
            ".research/checkpoints/*",
            "-x",
            ".research/cache/*",
            "-x",
            "*.aux",
            "-x",
            "*.log",
            "-x",
            "*.bbl",
            "-x",
            "*.blg",
            "-x",
            "*.fdb_latexmk",
            "-x",
            "*.fls",
            "-x",
            "*.out",
            "-x",
            "*.bcf",
            "-x",
            "*.run.xml",
            "-x",
            "*-SAVE-ERROR",
            "-x",
            "*.synctex.gz",
            "-x",
            "*.pdf",
        ])
        .status()
        .map_err(|error| format!("Could not run zip: {error}"))?;
    if !status.success() {
        let _ = fs::remove_file(zip_path);
        return Err("Could not create the ZIP archive.".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileStat {
    pub exists: bool,
    pub mtime_ms: u128,
}

pub fn stat_file(root: &Path, relative: &str) -> Result<ProjectFileStat, String> {
    let path = safe_path(root, relative)?;
    if !path.is_file() {
        return Ok(ProjectFileStat {
            exists: false,
            mtime_ms: 0,
        });
    }
    let modified = path
        .metadata()
        .and_then(|meta| meta.modified())
        .map_err(err)?;
    let mtime_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    Ok(ProjectFileStat {
        exists: true,
        mtime_ms,
    })
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
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let stem = if stem.is_empty() {
        "overleaf-project".to_string()
    } else {
        stem
    };
    let mut dest = parent.join(&stem);
    let mut suffix = 2;
    while dest.exists() {
        dest = parent.join(format!("{stem}-{suffix}"));
        suffix += 1;
    }
    fs::create_dir_all(&dest).map_err(err)?;
    let status = std::process::Command::new("unzip")
        .arg("-q")
        .arg(zip_path)
        .arg("-d")
        .arg(&dest)
        .status()
        .map_err(|error| format!("Could not run unzip: {error}"))?;
    if !status.success() {
        let _ = fs::remove_dir_all(&dest);
        return Err("Could not extract the ZIP archive.".to_string());
    }
    let project_root = unwrap_single_nested_folder(&dest)?;
    open(&project_root)
}

fn unwrap_single_nested_folder(root: &Path) -> Result<PathBuf, String> {
    let mut children = fs::read_dir(root)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && name != "__MACOSX"
        })
        .collect::<Vec<_>>();
    if children.len() == 1 {
        let only = children.remove(0).path();
        if only.is_dir() {
            let has_tex_here = WalkDir::new(root)
                .max_depth(1)
                .into_iter()
                .filter_map(Result::ok)
                .any(|entry| entry.path().extension().is_some_and(|ext| ext == "tex"));
            if !has_tex_here {
                return Ok(only);
            }
        }
    }
    Ok(root.to_path_buf())
}

pub fn read_manifest(root: &Path) -> Result<ProjectManifest, String> {
    let raw = fs::read_to_string(root.join(MANIFEST_PATH)).map_err(err)?;
    serde_json::from_str(&raw).map_err(err)
}

fn write_pretty_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(err)?;
    fs::write(path, format!("{raw}\n")).map_err(err)
}

pub fn write_manifest(root: &Path, manifest: &ProjectManifest) -> Result<(), String> {
    write_pretty_json(&root.join(MANIFEST_PATH), manifest)
}

pub fn read_pdf_marks(root: &Path) -> Result<Vec<PdfMark>, String> {
    let path = root.join(PDF_MARKS_PATH);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(err)?;
    let file: PdfMarksFile = serde_json::from_str(&raw).map_err(err)?;
    Ok(file.annotations)
}

pub fn write_pdf_marks(root: &Path, annotations: Vec<PdfMark>) -> Result<(), String> {
    let file = PdfMarksFile {
        schema_version: 1,
        annotations,
    };
    write_pretty_json(&root.join(PDF_MARKS_PATH), &file)
}

pub fn read_editor_comments(root: &Path) -> Result<Vec<EditorComment>, String> {
    let path = root.join(EDITOR_COMMENTS_PATH);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(err)?;
    let file: EditorCommentsFile = serde_json::from_str(&raw).map_err(err)?;
    Ok(file.comments)
}

pub fn write_editor_comments(root: &Path, comments: Vec<EditorComment>) -> Result<(), String> {
    let file = EditorCommentsFile {
        schema_version: 1,
        comments,
    };
    write_pretty_json(&root.join(EDITOR_COMMENTS_PATH), &file)
}

pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    resolve_project_path(root, relative, false)
}

pub(crate) fn creation_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    resolve_project_path(root, relative, true)
}

fn resolve_project_path(
    root: &Path,
    relative: &str,
    create_parents: bool,
) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.as_os_str().is_empty()
        || relative_path.is_absolute()
        || relative_path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("The requested path is outside the project.".to_string());
    }
    let canonical_root = root.canonicalize().map_err(err)?;
    let mut cursor = canonical_root.clone();
    let components = relative_path.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            continue;
        };
        cursor.push(name);
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(
                        "Symbolic links cannot be used for project file operations.".to_string()
                    );
                }
                if index + 1 < components.len() && !metadata.is_dir() {
                    return Err("A project path component is not a folder.".to_string());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !create_parents && index + 1 < components.len() {
                    return Err(error.to_string());
                }
                if create_parents && index + 1 < components.len() {
                    fs::create_dir(&cursor).map_err(err)?;
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(cursor)
}

pub fn read_file(root: &Path, relative: &str) -> Result<String, String> {
    let path = safe_path(root, relative)?;
    // One read serves classification and content; this used to read the file
    // twice (a full classify_regular_file pass, then the content pass).
    let metadata = fs::symlink_metadata(&path).map_err(err)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CLASSIFIED_TEXT_BYTES {
        return Err(
            "This is a binary or unsupported file and cannot be opened in the source editor."
                .to_string(),
        );
    }
    let bytes = fs::read(&path).map_err(err)?;
    if classify_file_bytes(&bytes) != ContentKind::Text {
        return Err(
            "This is a binary or unsupported file and cannot be opened in the source editor."
                .to_string(),
        );
    }
    String::from_utf8(bytes).map_err(|_| "This is not lossless UTF-8 text.".to_string())
}

pub fn citation_keys(root: &Path) -> Result<Vec<String>, String> {
    Ok(citations(root)?
        .into_iter()
        .map(|citation| citation.key)
        .collect())
}

pub fn citations(root: &Path) -> Result<Vec<CitationInfo>, String> {
    let mut citations = Vec::new();
    for (_path, bibliography) in iter_bibliography_sources(root)? {
        citations.extend(parse_bibliography(&bibliography));
    }
    citations.sort_by_key(|citation| citation.key.to_lowercase());
    citations.dedup_by(|left, right| left.key.eq_ignore_ascii_case(&right.key));
    Ok(citations)
}

/// A reverse SyncTeX click on a rendered reference lands in the generated `.bbl`,
/// which the writer never edits. Follow the `\bibitem` there back to its source
/// `.bib` entry so "jump to source" opens something editable.
pub fn bib_target_for_bbl(
    root: &Path,
    bbl_relative: &Path,
    line: u32,
) -> Result<Option<SyncTexTarget>, String> {
    let contents = fs::read_to_string(root.join(bbl_relative)).map_err(err)?;
    let Some(key) = bibitem_key_at(&contents, line) else {
        return Ok(None);
    };
    for (relative, source) in iter_bibliography_sources(root)? {
        if let Some(entry_line) = bib_entry_line(&source, &key) {
            return Ok(Some(SyncTexTarget {
                path: relative,
                line: entry_line,
            }));
        }
    }
    Ok(None)
}

/// A forward SyncTeX lookup cannot start from a `.bib` source because TeX reads
/// the generated `.bbl` instead. Resolve the entry under the cursor to its
/// `\bibitem` and return that generated source position.
pub fn bbl_target_for_bib(
    root: &Path,
    bib_relative: &Path,
    bbl_relative: &Path,
    line: u32,
) -> Result<Option<SyncTexTarget>, String> {
    let bibliography = fs::read_to_string(root.join(bib_relative)).map_err(err)?;
    let Some(key) = bib_entry_key_at(&bibliography, line) else {
        return Ok(None);
    };
    let bbl_path = root.join(bbl_relative);
    if !bbl_path.is_file() {
        return Ok(None);
    }
    let bbl = fs::read_to_string(bbl_path).map_err(err)?;
    let Some(item_line) = bibitem_line(&bbl, &key) else {
        return Ok(None);
    };
    Ok(Some(SyncTexTarget {
        path: bbl_relative.to_string_lossy().replace('\\', "/"),
        line: item_line,
    }))
}

fn parse_bibitem_key(after_bibitem: &str) -> Option<String> {
    let after = after_bibitem.trim_start();
    // Skip natbib's optional [label] argument.
    let after = if let Some(rest) = after.strip_prefix('[') {
        let close = rest.find(']')?;
        rest[close + 1..].trim_start()
    } else {
        after
    };
    let rest = after.strip_prefix('{')?;
    let close = rest.find('}')?;
    let key = rest[..close].trim();
    if key.is_empty() {
        None
    } else {
        Some(key.to_string())
    }
}

/// The citation key of the `\bibitem` that governs `line` (1-based) in a `.bbl`.
fn bibitem_key_at(contents: &str, line: u32) -> Option<String> {
    // Byte offset just past the end of the target line, so a click on the
    // `\bibitem` line itself still finds it.
    let mut offset = 0usize;
    let mut boundary = contents.len();
    for (index, text) in contents.lines().enumerate() {
        offset += text.len() + 1;
        if index as u32 + 1 == line {
            boundary = offset.min(contents.len());
            break;
        }
    }
    let item_start = contents[..boundary].rfind("\\bibitem")?;
    parse_bibitem_key(&contents[item_start + "\\bibitem".len()..])
}

/// The 1-based line containing the generated `\bibitem` for `key`.
fn bibitem_line(contents: &str, key: &str) -> Option<u32> {
    let mut cursor = 0usize;
    while let Some(relative) = contents[cursor..].find("\\bibitem") {
        let start = cursor + relative;
        if parse_bibitem_key(&contents[start + "\\bibitem".len()..])
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(key))
        {
            return Some(
                contents[..start]
                    .bytes()
                    .filter(|byte| *byte == b'\n')
                    .count() as u32
                    + 1,
            );
        }
        cursor = start + "\\bibitem".len();
    }
    None
}

/// The citation key of the `.bib` entry containing `line` (1-based).
fn bib_entry_key_at(contents: &str, line: u32) -> Option<String> {
    if line == 0 {
        return None;
    }
    let mut target_start = 0usize;
    let mut target_end = 0usize;
    let mut found_line = false;
    for (index, text) in contents.lines().enumerate() {
        if index as u32 + 1 == line {
            target_end = (target_start + text.len()).min(contents.len());
            found_line = true;
            break;
        }
        target_start = (target_start + text.len() + 1).min(contents.len());
    }
    if !found_line {
        return None;
    }
    bibliography_entry_spans(contents)
        .into_iter()
        .find(|(_, start, end)| target_end >= *start && target_start < *end)
        .map(|(key, _, _)| key)
}

/// The 1-based line where `@type{key,` is defined in a `.bib` source.
fn bib_entry_line(contents: &str, key: &str) -> Option<u32> {
    let (start, _) = bib_entry_span(contents, key)?;
    Some(
        contents[..start]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count() as u32
            + 1,
    )
}

fn iter_bibliography_sources(root: &Path) -> Result<Vec<(String, String)>, String> {
    let manifest = read_manifest(root)?;
    let mut sources = Vec::new();
    let mut seen = BTreeSet::new();
    let mut push_bib = |relative: String| -> Result<(), String> {
        if !seen.insert(relative.clone()) {
            return Ok(());
        }
        let path = safe_path(root, &relative)?;
        if !path.is_file() {
            return Ok(());
        }
        let contents = fs::read_to_string(&path).map_err(err)?;
        sources.push((relative, contents));
        Ok(())
    };
    push_bib(manifest.primary_bibliography)?;
    let mut collected = Vec::new();
    collect_bibliography_paths(&scan_files(root)?, &mut collected);
    for relative in collected {
        push_bib(relative)?;
    }
    Ok(sources)
}

fn collect_bibliography_paths(nodes: &[FileNode], out: &mut Vec<String>) {
    for node in nodes {
        if node.kind == "directory" {
            collect_bibliography_paths(&node.children, out);
        } else if node.kind == "bib" {
            out.push(node.path.clone());
        }
    }
}

pub fn references(root: &Path) -> Result<Vec<ReferenceInfo>, String> {
    let mut references = Vec::new();
    for (path, source) in iter_tex_sources(root)? {
        let relative = Path::new(&path);
        references.extend(parse_latex_references(root, relative, &path, &source));
    }
    // Keep duplicate labels so the editor can warn across files; go-to uses the first match.
    references.sort_by(|left, right| {
        left.label
            .to_lowercase()
            .cmp(&right.label.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.line.cmp(&right.line))
    });
    Ok(references)
}

const REFERENCE_COMMANDS: &[&str] = &["ref", "eqref", "pageref", "autoref", "cref", "Cref"];
const CITATION_COMMANDS: &[&str] = &[
    "cite",
    "nocite",
    "citep",
    "citet",
    "citeyear",
    "citeyearpar",
    "citealp",
    "citealt",
    "citeauthor",
    "supercite",
    "parencite",
    "smartcite",
    "textcite",
    "autocite",
    "footcite",
    "fullcite",
];

fn iter_tex_sources(root: &Path) -> Result<Vec<(String, String)>, String> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root)
        .max_depth(8)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "tex")
        })
        .filter(|entry| {
            !entry.path().strip_prefix(root).is_ok_and(|path| {
                path.components()
                    .any(|part| part.as_os_str() == ".research")
            })
        })
    {
        let relative = entry.path().strip_prefix(root).map_err(err)?;
        let path = relative.to_string_lossy().replace('\\', "/");
        let source = fs::read_to_string(entry.path()).map_err(err)?;
        files.push((path, source));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn validate_symbol_name(kind: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Enter a {kind} name."));
    }
    if value.chars().count() > 120 {
        return Err(format!("Keep the {kind} under 120 characters."));
    }
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, ':' | '_' | '-' | '.' | '+')
    }) {
        return Err(format!("Use letters, numbers, and :_-.+ in the {kind}."));
    }
    Ok(())
}

fn line_snippet(source: &str, offset: usize) -> String {
    let line = source
        .lines()
        .nth(line_number_at(source, offset).saturating_sub(1) as usize)
        .unwrap_or("")
        .trim();
    let snippet = line.chars().take(160).collect::<String>();
    if line.chars().count() > 160 {
        format!("{snippet}…")
    } else {
        snippet
    }
}

#[derive(Debug)]
struct ParsedCommandArgument {
    command_from: usize,
    command_to: usize,
    content_from: usize,
    content_to: usize,
    keys: Vec<(usize, usize, String)>,
}

/// Byte mask for LaTeX regions where command-looking text is literal. Symbol
/// search and destructive citation edits must agree on this mask so examples
/// in comments, `\verb`, and verbatim-like environments never become edits.
fn latex_literal_mask(source: &str) -> Vec<bool> {
    let bytes = source.as_bytes();
    let mut masked = vec![false; bytes.len()];

    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let mut slashes = 0usize;
            let mut before = index;
            while before > 0 && bytes[before - 1] == b'\\' {
                slashes += 1;
                before -= 1;
            }
            if slashes.is_multiple_of(2) {
                let end = source[index..]
                    .find('\n')
                    .map(|offset| index + offset)
                    .unwrap_or(bytes.len());
                masked[index..end].fill(true);
                index = end;
                continue;
            }
        }
        index += 1;
    }

    for environment in ["verbatim", "verbatim*", "lstlisting", "minted"] {
        let opening = format!("\\begin{{{environment}}}");
        let closing = format!("\\end{{{environment}}}");
        let mut cursor = 0usize;
        while let Some(relative) = source[cursor..].find(&opening) {
            let start = cursor + relative;
            if masked[start] {
                cursor = start + opening.len();
                continue;
            }
            let finish = source[start + opening.len()..]
                .find(&closing)
                .map(|offset| start + opening.len() + offset + closing.len())
                .unwrap_or(bytes.len());
            masked[start..finish].fill(true);
            cursor = finish;
        }
    }

    let mut cursor = 0usize;
    while let Some(relative) = source[cursor..].find("\\verb") {
        let start = cursor + relative;
        if masked[start] {
            cursor = start + "\\verb".len();
            continue;
        }
        let mut delimiter_at = start + "\\verb".len();
        if bytes.get(delimiter_at) == Some(&b'*') {
            delimiter_at += 1;
        }
        let Some(&delimiter) = bytes.get(delimiter_at) else {
            break;
        };
        if delimiter.is_ascii_alphabetic() || delimiter.is_ascii_whitespace() {
            cursor = delimiter_at;
            continue;
        }
        let Some(relative_end) = bytes[delimiter_at + 1..]
            .iter()
            .position(|byte| *byte == delimiter)
        else {
            break;
        };
        let finish = delimiter_at + 1 + relative_end + 1;
        masked[start..finish].fill(true);
        cursor = finish;
    }

    masked
}

fn find_command_arguments(source: &str, commands: &[&str]) -> Vec<ParsedCommandArgument> {
    let mut arguments = Vec::new();
    let bytes = source.as_bytes();
    let literal = latex_literal_mask(source);
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'\\' || literal[index] {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let mut name_end = name_start;
        while name_end < bytes.len()
            && (bytes[name_end].is_ascii_alphabetic() || bytes[name_end] == b'*')
        {
            name_end += 1;
        }
        if name_end == name_start {
            index += 1;
            continue;
        }
        let mut name = &source[name_start..name_end];
        if let Some(stripped) = name.strip_suffix('*') {
            name = stripped;
        }
        if !commands.contains(&name) {
            index = name_end;
            continue;
        }
        let mut cursor = name_end;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        while bytes.get(cursor) == Some(&b'[') {
            let Some(close) = source[cursor + 1..].find(']') else {
                break;
            };
            cursor += close + 2;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
        }
        let Some((argument, end)) = command_argument_at(source, cursor) else {
            index = name_end;
            continue;
        };
        let content_start = end - 1 - argument.len();
        let mut keys = Vec::new();
        let parts = argument.split(',').collect::<Vec<_>>();
        let mut offset = 0usize;
        for (index_in_list, part) in parts.iter().enumerate() {
            let leading = part.len() - part.trim_start().len();
            let key = part.trim();
            if !key.is_empty() {
                let from = content_start + offset + leading;
                keys.push((from, from + key.len(), key.to_string()));
            }
            offset += part.len();
            if index_in_list + 1 < parts.len() {
                offset += 1;
            }
        }
        arguments.push(ParsedCommandArgument {
            command_from: index,
            command_to: end,
            content_from: content_start,
            content_to: end - 1,
            keys,
        });
        index = end;
    }
    arguments
}

fn find_command_argument_keys(source: &str, commands: &[&str]) -> Vec<(usize, usize, String)> {
    find_command_arguments(source, commands)
        .into_iter()
        .flat_map(|argument| argument.keys)
        .collect()
}

/// One in-place edit to a `\label`/`\cite` reference: (path, from, to, line, old, new).
type ReferenceEdit = (String, usize, usize, u32, String, String);
/// A whole-file citation edit: (relative path, expected contents, new contents).
pub(crate) type PreparedFileEdit = (String, String, String);

fn collect_label_edits(root: &Path, label: &str) -> Result<Vec<ReferenceEdit>, String> {
    let mut edits = Vec::new();
    for (path, source) in iter_tex_sources(root)? {
        for (from, to, key) in find_command_argument_keys(&source, &["label"]) {
            if key != label {
                continue;
            }
            edits.push((
                path.clone(),
                from,
                to,
                line_number_at(&source, from),
                "definition".to_string(),
                line_snippet(&source, from),
            ));
        }
        for (from, to, key) in find_command_argument_keys(&source, REFERENCE_COMMANDS) {
            if key != label {
                continue;
            }
            edits.push((
                path.clone(),
                from,
                to,
                line_number_at(&source, from),
                "reference".to_string(),
                line_snippet(&source, from),
            ));
        }
    }
    Ok(edits)
}

fn collect_citation_edits(root: &Path, key: &str) -> Result<Vec<ReferenceEdit>, String> {
    let mut edits = Vec::new();
    for (path, source) in iter_tex_sources(root)? {
        for (from, to, found) in find_command_argument_keys(&source, CITATION_COMMANDS) {
            if !found.eq_ignore_ascii_case(key) {
                continue;
            }
            edits.push((
                path.clone(),
                from,
                to,
                line_number_at(&source, from),
                "reference".to_string(),
                line_snippet(&source, from),
            ));
        }
    }
    for (relative, bibliography) in iter_bibliography_sources(root)? {
        if let Some(from) = bibliography_key_offset(&bibliography, key) {
            edits.push((
                relative,
                from,
                from + key.len(),
                line_number_at(&bibliography, from),
                "definition".to_string(),
                line_snippet(&bibliography, from),
            ));
        }
    }
    Ok(edits)
}

/// Build manuscript edits that remove one citation key without touching disk.
/// Multi-key commands keep their other keys; a command whose only key is the
/// removed one disappears entirely. The caller can commit these edits beside
/// the bibliography update as one citation history transaction.
pub(crate) fn remove_citation_usages(
    root: &Path,
    key: &str,
) -> Result<(Vec<PreparedFileEdit>, u32), String> {
    validate_symbol_name("citation key", key)?;
    let key = key.trim();
    let mut file_edits = Vec::new();
    let mut occurrence_count = 0u32;
    for (path, source) in iter_tex_sources(root)? {
        let mut next = source.clone();
        let mut arguments = find_command_arguments(&source, CITATION_COMMANDS)
            .into_iter()
            .filter_map(|argument| {
                let removed = argument
                    .keys
                    .iter()
                    .filter(|(_, _, found)| found.eq_ignore_ascii_case(key))
                    .count() as u32;
                (removed > 0).then_some((argument, removed))
            })
            .collect::<Vec<_>>();
        arguments.sort_by_key(|(argument, _)| std::cmp::Reverse(argument.command_from));
        for (argument, removed) in arguments {
            occurrence_count += removed;
            let remaining = argument
                .keys
                .iter()
                .filter(|(_, _, found)| !found.eq_ignore_ascii_case(key))
                .filter_map(|(from, to, _)| source.get(*from..*to))
                .collect::<Vec<_>>();
            if remaining.is_empty() {
                let mut command_to = argument.command_to;
                // Preserve one word boundary when a prose citation sat between
                // spaces, rather than leaving a visibly doubled gap.
                if source[..argument.command_from].ends_with(' ')
                    && source[command_to..].starts_with(' ')
                {
                    command_to += 1;
                }
                next.replace_range(argument.command_from..command_to, "");
            } else {
                next.replace_range(
                    argument.content_from..argument.content_to,
                    &remaining.join(", "),
                );
            }
        }
        if next != source {
            file_edits.push((path, source, next));
        }
    }
    Ok((file_edits, occurrence_count))
}

fn bibliography_key_offset(source: &str, key: &str) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'@' {
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_alphabetic() {
            cursor += 1;
        }
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'{') {
            index += 1;
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let key_start = cursor;
        while cursor < bytes.len()
            && !matches!(bytes[cursor], b',' | b'}')
            && !bytes[cursor].is_ascii_whitespace()
        {
            cursor += 1;
        }
        if &source[key_start..cursor] == key {
            return Some(key_start);
        }
        index = key_start.max(index + 1);
    }
    None
}

pub fn find_label_occurrences(root: &Path, label: &str) -> Result<Vec<SymbolOccurrence>, String> {
    validate_symbol_name("label", label)?;
    Ok(collect_label_edits(root, label.trim())?
        .into_iter()
        .map(|(path, _, _, line, role, snippet)| SymbolOccurrence {
            kind: "label".to_string(),
            symbol: label.trim().to_string(),
            role,
            path,
            line,
            snippet,
        })
        .collect())
}

pub fn find_citation_occurrences(root: &Path, key: &str) -> Result<Vec<SymbolOccurrence>, String> {
    validate_symbol_name("citation key", key)?;
    Ok(collect_citation_edits(root, key.trim())?
        .into_iter()
        .map(|(path, _, _, line, role, snippet)| SymbolOccurrence {
            kind: "citation".to_string(),
            symbol: key.trim().to_string(),
            role,
            path,
            line,
            snippet,
        })
        .collect())
}

/// Manuscript uses that make removing a bibliography key unsafe. A wildcard
/// `\nocite{*}` applies to every key, unlike rename/find operations where `*`
/// must never be treated as the requested symbol.
pub fn find_citation_usages(root: &Path, key: &str) -> Result<Vec<SymbolOccurrence>, String> {
    validate_symbol_name("citation key", key)?;
    let key = key.trim();
    let mut edits = collect_citation_edits(root, key)?;
    edits.extend(collect_citation_edits(root, "*")?);
    Ok(edits
        .into_iter()
        .filter(|(_, _, _, _, role, _)| role == "reference")
        .map(|(path, _, _, line, role, snippet)| SymbolOccurrence {
            kind: "citation".to_string(),
            symbol: key.to_string(),
            role,
            path,
            line,
            snippet,
        })
        .collect())
}

pub fn unused_symbols(root: &Path) -> Result<UnusedSymbols, String> {
    let mut defined_labels = BTreeSet::new();
    let mut referenced_labels = BTreeSet::new();
    let mut cited_keys = BTreeSet::new();
    for (_path, source) in iter_tex_sources(root)? {
        for (_from, _to, key) in find_command_argument_keys(&source, &["label"]) {
            defined_labels.insert(key);
        }
        for (_from, _to, key) in find_command_argument_keys(&source, REFERENCE_COMMANDS) {
            referenced_labels.insert(key);
        }
        for (_from, _to, key) in find_command_argument_keys(&source, CITATION_COMMANDS) {
            cited_keys.insert(key);
        }
    }
    let labels = defined_labels
        .into_iter()
        .filter(|label| !referenced_labels.contains(label))
        .collect::<Vec<_>>();
    let bibliography_keys = citations(root)?
        .into_iter()
        .map(|citation| citation.key)
        .collect::<BTreeSet<_>>();
    let citations = bibliography_keys
        .into_iter()
        .filter(|key| !cited_keys.contains(key))
        .collect::<Vec<_>>();
    Ok(UnusedSymbols { labels, citations })
}

pub fn update_manifest_settings(
    root: &Path,
    engine: Option<String>,
    default_root: Option<String>,
    trusted: Option<bool>,
    word_budget: Option<Option<u32>>,
    page_budget: Option<Option<u32>>,
    spelling_words: Option<Vec<String>>,
) -> Result<ProjectManifest, String> {
    let mut manifest = read_manifest(root)?;
    if let Some(engine) = engine {
        let normalized = engine.trim().to_ascii_lowercase();
        if !matches!(normalized.as_str(), "pdf" | "xelatex" | "lualatex") {
            return Err("Choose pdf, xelatex, or lualatex.".to_string());
        }
        manifest.engine = normalized;
    }
    if let Some(default_root) = default_root {
        let path = default_root.trim().to_string();
        if !manifest
            .root_documents
            .iter()
            .any(|document| document.path == path)
        {
            return Err("That root document is not listed in the project manifest.".to_string());
        }
        for document in &mut manifest.root_documents {
            document.is_default = document.path == path;
        }
    }
    if let Some(trusted) = trusted {
        manifest.trusted = trusted;
    }
    if let Some(word_budget) = word_budget {
        manifest.word_budget = word_budget;
    }
    if let Some(page_budget) = page_budget {
        manifest.page_budget = page_budget;
    }
    if let Some(spelling_words) = spelling_words {
        let mut normalized = Vec::new();
        for word in spelling_words {
            let word = word.trim();
            if word.is_empty() {
                continue;
            }
            if word.chars().count() > 80 || word.chars().any(char::is_whitespace) {
                return Err(
                    "Project dictionary terms must be single words of at most 80 characters."
                        .to_string(),
                );
            }
            if !normalized
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(word))
            {
                normalized.push(word.to_string());
            }
        }
        normalized.sort_by_key(|word| word.to_ascii_lowercase());
        manifest.spelling_words = normalized;
    }
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

pub fn add_root_document(
    root: &Path,
    path: &str,
    name: Option<String>,
    make_default: bool,
) -> Result<ProjectManifest, String> {
    let relative = path.trim().replace('\\', "/");
    if relative.is_empty() {
        return Err("Choose a .tex file to add as a root document.".to_string());
    }
    if !relative.ends_with(".tex") {
        return Err("Root documents must be .tex files.".to_string());
    }
    let absolute = safe_path(root, &relative)?;
    if !absolute.is_file() {
        return Err(format!("File not found: {relative}"));
    }
    let mut manifest = read_manifest(root)?;
    if manifest
        .root_documents
        .iter()
        .any(|document| document.path == relative)
    {
        return Err("That file is already listed as a root document.".to_string());
    }
    let display_name = name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            Path::new(&relative)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(&relative)
                .to_string()
        });
    if make_default || manifest.root_documents.is_empty() {
        for document in &mut manifest.root_documents {
            document.is_default = false;
        }
    }
    manifest.root_documents.push(RootDocument {
        path: relative,
        name: display_name,
        is_default: make_default || manifest.root_documents.is_empty(),
    });
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

pub fn remove_root_document(root: &Path, path: &str) -> Result<ProjectManifest, String> {
    let relative = path.trim().replace('\\', "/");
    let mut manifest = read_manifest(root)?;
    if manifest.root_documents.len() <= 1 {
        return Err("Keep at least one root document.".to_string());
    }
    let removed_default = manifest
        .root_documents
        .iter()
        .any(|document| document.path == relative && document.is_default);
    let before = manifest.root_documents.len();
    manifest
        .root_documents
        .retain(|document| document.path != relative);
    if manifest.root_documents.len() == before {
        return Err("That root document is not listed in the project manifest.".to_string());
    }
    if removed_default
        || !manifest
            .root_documents
            .iter()
            .any(|document| document.is_default)
    {
        if let Some(first) = manifest.root_documents.first_mut() {
            first.is_default = true;
        }
    }
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

pub fn latexmk_engine_arg(engine: &str) -> &'static str {
    match engine.trim().to_ascii_lowercase().as_str() {
        "xelatex" => "-pdfxe",
        "lualatex" => "-pdflua",
        _ => "-pdf",
    }
}

/// First `limit` characters, not bytes.
///
/// Slicing a `&str` at a byte offset panics when the offset lands inside a
/// character, and every one of these strings is a line of someone's writing —
/// an em dash or an accent anywhere near the cut took the whole command down.
fn truncate_chars(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((offset, _)) => format!("{}…", &text[..offset]),
        None => text.to_string(),
    }
}

fn apply_symbol_rename(
    root: &Path,
    label: &str,
    edits: Vec<(String, usize, usize, u32, String, String)>,
    old: &str,
    new: &str,
) -> Result<RenameSymbolResult, String> {
    if edits.is_empty() {
        return Err(format!("No occurrences of “{old}” were found."));
    }
    let mut by_path: BTreeMap<String, Vec<(usize, usize)>> = BTreeMap::new();
    for (path, from, to, _, _, _) in &edits {
        by_path.entry(path.clone()).or_default().push((*from, *to));
    }
    let mut file_edits = Vec::new();
    for (path, ranges) in by_path {
        let mut source = read_file(root, &path)?;
        let mut ranges = ranges;
        // Descending by start offset, so edits apply back-to-front.
        ranges.sort_by_key(|range| std::cmp::Reverse(range.0));
        for (from, to) in ranges {
            if source.get(from..to) != Some(old) {
                return Err(format!(
                    "Could not rename “{old}” in {path}; the file changed."
                ));
            }
            source.replace_range(from..to, new);
        }
        file_edits.push((path, source));
    }
    let changed_files = file_edits
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    let occurrence_count = edits.len() as u32;
    let transaction = apply_transaction(root, label, file_edits)?
        .ok_or_else(|| "The rename did not change any files.".to_string())?;
    Ok(RenameSymbolResult {
        changed_files,
        occurrence_count,
        transaction_id: transaction.id,
    })
}

pub fn rename_label(
    root: &Path,
    old_label: &str,
    new_label: &str,
) -> Result<RenameSymbolResult, String> {
    validate_symbol_name("label", old_label)?;
    validate_symbol_name("label", new_label)?;
    let old = old_label.trim();
    let new = new_label.trim();
    if old == new {
        return Err("Choose a different label.".to_string());
    }
    if references(root)?.iter().any(|item| item.label == new) {
        return Err(format!("The label “{new}” already exists."));
    }
    let edits = collect_label_edits(root, old)?;
    apply_symbol_rename(
        root,
        &format!("Rename label {old} → {new}"),
        edits,
        old,
        new,
    )
}

pub fn rename_citation_key(
    root: &Path,
    old_key: &str,
    new_key: &str,
) -> Result<RenameSymbolResult, String> {
    validate_symbol_name("citation key", old_key)?;
    validate_symbol_name("citation key", new_key)?;
    let old = old_key.trim();
    let new = new_key.trim();
    if old == new {
        return Err("Choose a different citation key.".to_string());
    }
    if citation_keys(root)?.iter().any(|key| key == new) {
        return Err(format!("The citation key “{new}” already exists."));
    }
    let edits = collect_citation_edits(root, old)?;
    apply_symbol_rename(
        root,
        &format!("Rename citation {old} → {new}"),
        edits,
        old,
        new,
    )
}

fn parse_latex_references(
    root: &Path,
    source_path: &Path,
    display_path: &str,
    source: &str,
) -> Vec<ReferenceInfo> {
    let environments = [
        ("figure", "figure"),
        ("figure*", "figure"),
        ("table", "table"),
        ("table*", "table"),
        ("equation", "equation"),
        ("equation*", "equation"),
        ("align", "equation"),
        ("align*", "equation"),
        ("gather", "equation"),
        ("gather*", "equation"),
        ("multline", "equation"),
        ("multline*", "equation"),
    ];
    let mut references = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = source[cursor..].find("\\label") {
        let position = cursor + offset;
        let Some((label, end)) = command_argument_at(source, position + "\\label".len()) else {
            cursor = position + "\\label".len();
            continue;
        };
        cursor = end;
        let label = label.trim();
        if label.is_empty() {
            continue;
        }

        let environment = environments
            .iter()
            .filter_map(|(name, kind)| {
                enclosing_environment(source, position, name)
                    .map(|(start, finish)| (*kind, start, finish))
            })
            .max_by_key(|(_, start, _)| *start);
        let (kind, title, snippet, image_path) = if let Some((kind, start, finish)) = environment {
            let body = &source[start..finish];
            let caption = command_argument(body, "\\caption")
                .map(|value| compact_inline_tex(&value))
                .filter(|value| !value.is_empty());
            let image_path = (kind == "figure")
                .then(|| includegraphics_argument(body))
                .flatten()
                .and_then(|value| resolve_graphics_path(root, source_path, &value));
            let title = caption.unwrap_or_else(|| match kind {
                "figure" => "Figure".to_string(),
                "table" => "Table".to_string(),
                _ => "Equation".to_string(),
            });
            let snippet = environment_snippet(body, kind);
            (kind.to_string(), title, snippet, image_path)
        } else if let Some(title) = nearest_section_title(source, position) {
            ("section".to_string(), title, String::new(), None)
        } else {
            (
                "reference".to_string(),
                label.to_string(),
                String::new(),
                None,
            )
        };
        references.push(ReferenceInfo {
            label: label.to_string(),
            kind,
            title,
            snippet,
            path: display_path.to_string(),
            line: line_number_at(source, position),
            image_path,
        });
    }
    references
}

fn line_number_at(source: &str, offset: usize) -> u32 {
    let clamped = offset.min(source.len());
    source[..clamped]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count() as u32
        + 1
}

fn enclosing_environment(source: &str, position: usize, name: &str) -> Option<(usize, usize)> {
    let opening = format!("\\begin{{{name}}}");
    let closing = format!("\\end{{{name}}}");
    let start = source.get(..position)?.rfind(&opening)?;
    if source
        .get(..position)?
        .rfind(&closing)
        .is_some_and(|end| end > start)
    {
        return None;
    }
    let finish = position + source.get(position..)?.find(&closing)? + closing.len();
    Some((start, finish))
}

fn command_argument(source: &str, command: &str) -> Option<String> {
    let position = source.find(command)? + command.len();
    command_argument_at(source, position).map(|(value, _)| value)
}

fn command_argument_at(source: &str, mut position: usize) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    while bytes.get(position).is_some_and(u8::is_ascii_whitespace) {
        position += 1;
    }
    if bytes.get(position) != Some(&b'{') {
        return None;
    }
    let start = position + 1;
    let mut depth = 1usize;
    position += 1;
    while position < bytes.len() {
        match bytes[position] {
            b'\\' => position += 2,
            b'{' => {
                depth += 1;
                position += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((source[start..position].to_string(), position + 1));
                }
                position += 1;
            }
            _ => position += 1,
        }
    }
    None
}

fn includegraphics_argument(source: &str) -> Option<String> {
    let command = "\\includegraphics";
    let mut position = source.find(command)? + command.len();
    let bytes = source.as_bytes();
    if bytes.get(position) == Some(&b'*') {
        position += 1;
    }
    while bytes.get(position).is_some_and(u8::is_ascii_whitespace) {
        position += 1;
    }
    if bytes.get(position) == Some(&b'[') {
        position += 1;
        let mut depth = 1usize;
        while position < bytes.len() && depth > 0 {
            match bytes[position] {
                b'[' => depth += 1,
                b']' => depth -= 1,
                _ => {}
            }
            position += 1;
        }
    }
    command_argument_at(source, position).map(|(value, _)| value.trim().to_string())
}

fn resolve_graphics_path(root: &Path, source_path: &Path, value: &str) -> Option<String> {
    let value = normalized_graphics_path(value)?;
    let requested = Path::new(&value);
    if requested.is_absolute() {
        return None;
    }
    let source_parent = source_path.parent().unwrap_or_else(|| Path::new(""));
    let bases = [
        root.join(source_parent).join(requested),
        root.join(requested),
    ];
    let extensions = ["png", "jpg", "jpeg", "svg", "webp", "pdf"];
    for base in bases {
        let candidates = if base.extension().is_some() {
            vec![base]
        } else {
            extensions
                .iter()
                .map(|extension| base.with_extension(extension))
                .collect()
        };
        for candidate in candidates {
            let Ok(canonical) = candidate.canonicalize() else {
                continue;
            };
            let Ok(canonical_root) = root.canonicalize() else {
                continue;
            };
            if canonical.is_file() && canonical.starts_with(&canonical_root) {
                return canonical
                    .strip_prefix(&canonical_root)
                    .ok()
                    .map(|path| path.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    None
}

fn normalized_graphics_path(value: &str) -> Option<String> {
    let value = value.trim();
    if !value.starts_with("\\detokenize") {
        return (!value.is_empty()).then(|| value.to_string());
    }
    let (path, end) = command_argument_at(value, "\\detokenize".len())?;
    (end == value.len() && !path.trim().is_empty()).then(|| path.trim().to_string())
}

fn nearest_section_title(source: &str, position: usize) -> Option<String> {
    let before = source.get(..position)?;
    [
        "\\part",
        "\\chapter",
        "\\section",
        "\\subsection",
        "\\subsubsection",
        "\\paragraph",
    ]
    .into_iter()
    .filter_map(|command| {
        let start = before.rfind(command)?;
        let argument_start = start + command.len();
        let (title, _) = command_argument_at(source, argument_start)?;
        (position.saturating_sub(start) < 1_200).then_some((start, compact_inline_tex(&title)))
    })
    .max_by_key(|(start, _)| *start)
    .map(|(_, title)| title)
}

fn compact_inline_tex(source: &str) -> String {
    source.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn environment_snippet(source: &str, kind: &str) -> String {
    let mut lines = source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('%'))
        .filter(|line| {
            !line.starts_with("\\begin")
                && !line.starts_with("\\end")
                && !line.starts_with("\\caption")
                && !line.starts_with("\\label")
                && *line != "\\centering"
                && (kind != "figure" || !line.starts_with("\\includegraphics"))
        })
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    if lines.chars().count() > 480 {
        lines = lines.chars().take(479).collect::<String>() + "…";
    }
    lines
}

pub(crate) fn parse_bibliography(bibliography: &str) -> Vec<CitationInfo> {
    let bytes = bibliography.as_bytes();
    let mut cursor = 0;
    let mut citations = Vec::new();
    while cursor < bytes.len() {
        let Some(relative_start) = bibliography[cursor..].find('@') else {
            break;
        };
        let mut position = cursor + relative_start + 1;
        let entry_type_start = position;
        while position < bytes.len() && bytes[position].is_ascii_alphabetic() {
            position += 1;
        }
        let entry_type = bibliography[entry_type_start..position].to_ascii_lowercase();
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        let Some(&opening) = bytes
            .get(position)
            .filter(|value| **value == b'{' || **value == b'(')
        else {
            cursor = position.saturating_add(1);
            continue;
        };
        let closing = if opening == b'{' { b'}' } else { b')' };
        position += 1;
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        let key_start = position;
        while position < bytes.len() && bytes[position] != b',' && bytes[position] != closing {
            position += 1;
        }
        if position >= bytes.len() || bytes[position] != b',' {
            cursor = position.saturating_add(1);
            continue;
        }
        let key = bibliography[key_start..position].trim().to_string();
        position += 1;
        let body_start = position;
        let mut depth = 1usize;
        let mut quoted = false;
        while position < bytes.len() {
            let byte = bytes[position];
            if byte == b'"' && (position == 0 || bytes[position - 1] != b'\\') {
                quoted = !quoted;
            } else if !quoted && byte == opening {
                depth += 1;
            } else if !quoted && byte == closing {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            position += 1;
        }
        cursor = position.saturating_add(1);
        if key.is_empty() || matches!(entry_type.as_str(), "comment" | "preamble" | "string") {
            continue;
        }
        let fields = parse_bibliography_fields(&bibliography[body_start..position]);
        citations.push(CitationInfo {
            key,
            title: fields.get("title").cloned().unwrap_or_default(),
            authors: fields.get("author").cloned().unwrap_or_default(),
            year: fields.get("year").cloned().unwrap_or_default(),
            venue: fields
                .get("journal")
                .or_else(|| fields.get("booktitle"))
                .or_else(|| fields.get("publisher"))
                .cloned()
                .unwrap_or_default(),
            arxiv_id: bibliography_arxiv_id(&fields),
            doi: fields.get("doi").and_then(|value| normalize_doi(value)),
            url: fields
                .get("url")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        });
    }
    citations
}

/// Canonical DOI spelling used as the cache and Crossref lookup identity.
/// DOI matching is case-insensitive; resolver prefixes are presentation only.
pub(crate) fn normalize_doi(value: &str) -> Option<String> {
    let mut value = value.trim();
    for prefix in [
        "https://doi.org/",
        "http://doi.org/",
        "http://dx.doi.org/",
        "doi:",
    ] {
        if value
            .get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
        {
            value = value[prefix.len()..].trim();
            break;
        }
    }
    let value = value.to_ascii_lowercase();
    let valid = Regex::new(r"^10\.\d{4,9}/\S+$").ok()?;
    valid.is_match(&value).then_some(value)
}

/// arXiv preprints reach a .bib in several shapes. Extract them all here so
/// every bibliography consumer sees the same identifier.
fn bibliography_arxiv_id(fields: &BTreeMap<String, String>) -> Option<String> {
    let pattern = Regex::new(
        r"(?ix)(?:
            ^\s* |
            arxiv\s*(?:preprint\s*)?(?::|\.)\s* |
            arxiv\.org/(?:abs|pdf)/ |
            10\.48550/arxiv\.
        )
        (?P<id>\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?)
        (?:\.pdf)?(?:\s*$|[^a-z0-9./])",
    )
    .ok()?;
    [
        "eprint",
        "url",
        "doi",
        "journal",
        "note",
        "booktitle",
        "howpublished",
    ]
    .iter()
    .filter_map(|field| fields.get(*field))
    .find_map(|value| {
        pattern
            .captures(value)
            .and_then(|capture| capture.name("id"))
            .map(|id| id.as_str().to_string())
    })
}

fn parse_bibliography_fields(body: &str) -> BTreeMap<String, String> {
    let bytes = body.as_bytes();
    let mut fields = BTreeMap::new();
    let mut position = 0;
    while position < bytes.len() {
        while position < bytes.len()
            && (bytes[position].is_ascii_whitespace() || bytes[position] == b',')
        {
            position += 1;
        }
        let name_start = position;
        while position < bytes.len()
            && (bytes[position].is_ascii_alphanumeric() || matches!(bytes[position], b'_' | b'-'))
        {
            position += 1;
        }
        if name_start == position {
            position += 1;
            continue;
        }
        let name = body[name_start..position].to_ascii_lowercase();
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        if bytes.get(position) != Some(&b'=') {
            continue;
        }
        position += 1;
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        let value = match bytes.get(position) {
            Some(b'{') => parse_braced_bibliography_value(body, &mut position),
            Some(b'"') => parse_quoted_bibliography_value(body, &mut position),
            Some(_) => {
                let value_start = position;
                while position < bytes.len() && bytes[position] != b',' {
                    position += 1;
                }
                body[value_start..position].to_string()
            }
            None => String::new(),
        };
        fields.insert(name, clean_bibliography_value(&value));
    }
    fields
}

fn parse_braced_bibliography_value(body: &str, position: &mut usize) -> String {
    let bytes = body.as_bytes();
    *position += 1;
    let start = *position;
    let mut depth = 1usize;
    while *position < bytes.len() {
        match bytes[*position] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    let value = body[start..*position].to_string();
                    *position += 1;
                    return value;
                }
            }
            _ => {}
        }
        *position += 1;
    }
    body[start..].to_string()
}

fn parse_quoted_bibliography_value(body: &str, position: &mut usize) -> String {
    let bytes = body.as_bytes();
    *position += 1;
    let start = *position;
    while *position < bytes.len() {
        if bytes[*position] == b'"' && (*position == start || bytes[*position - 1] != b'\\') {
            let value = body[start..*position].to_string();
            *position += 1;
            return value;
        }
        *position += 1;
    }
    body[start..].to_string()
}

fn clean_bibliography_value(value: &str) -> String {
    value
        .replace(['{', '}'], "")
        .replace("\\&", "&")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn search_files(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    match crate::fts::search(root, query) {
        Ok(results) => Ok(results),
        Err(_) => search_files_linear(root, query),
    }
}

pub(crate) fn list_files_for_search(root: &Path) -> Result<Vec<FileNode>, String> {
    scan_project_tree(root)
}

fn search_files_linear(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    let terms = search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    search_file_nodes_multi(root, &list_files_for_search(root)?, &terms, &mut results)?;
    results.truncate(200);
    Ok(results)
}

fn search_file_nodes_multi(
    root: &Path,
    nodes: &[FileNode],
    terms: &[String],
    results: &mut Vec<ProjectSearchResult>,
) -> Result<(), String> {
    for node in nodes {
        if node.kind == "directory" {
            search_file_nodes_multi(root, &node.children, terms, results)?;
            continue;
        }
        let content = if searchable_text_path(&node.path) {
            fs::read_to_string(safe_path(root, &node.path)?).unwrap_or_default()
        } else {
            String::new()
        };
        let path_haystack = node.path.replace(['\\', '/', '.', '-', '_'], " ");
        if matches_search(&format!("{} {}", node.path, path_haystack), terms) {
            results.push(ProjectSearchResult {
                kind: "file".to_string(),
                path: node.path.clone(),
                title: node.name.clone(),
                snippet: node.path.clone(),
                line: Some(1),
                arxiv_id: None,
                file_kind: Some(node.kind.clone()),
            });
        }
        for (line_number, line) in searchable_text_lines(&node.path, &content) {
            if !matches_search(&line, terms) {
                continue;
            }
            let snippet = {
                let trimmed = line.trim();
                let clipped = trimmed.chars().take(180).collect::<String>();
                if trimmed.chars().count() > 180 {
                    format!("{clipped}…")
                } else {
                    clipped
                }
            };
            results.push(ProjectSearchResult {
                kind: "file".to_string(),
                path: node.path.clone(),
                title: node.name.clone(),
                snippet,
                line: Some(line_number),
                arxiv_id: None,
                file_kind: Some(node.kind.clone()),
            });
            if results.len() >= 200 {
                return Ok(());
            }
        }
    }
    Ok(())
}

pub(crate) fn search_terms(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect()
}

pub(crate) fn matches_search(content: &str, terms: &[String]) -> bool {
    let content = content.to_lowercase();
    terms.iter().all(|term| content.contains(term))
}

/// Returns a 1-based line number and a short snippet for the first matching line.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn matching_hit(content: &str, terms: &[String]) -> Option<(u32, String)> {
    let mut fallback: Option<(u32, String)> = None;
    for (index, line) in content.lines().enumerate() {
        let line_number = (index + 1) as u32;
        let snippet = {
            let trimmed = line.trim();
            let clipped = trimmed.chars().take(180).collect::<String>();
            if trimmed.chars().count() > 180 {
                format!("{clipped}…")
            } else {
                clipped
            }
        };
        if matches_search(line, terms) {
            return Some((line_number, snippet));
        }
        if fallback.is_none() && terms.iter().any(|term| line.to_lowercase().contains(term)) {
            fallback = Some((line_number, snippet));
        }
    }
    fallback
}

pub(crate) fn searchable_text_path(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("tex" | "bib" | "sty" | "cls" | "md" | "txt" | "html")
    )
}

static HTML_BODY_OPEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<body\b[^>]*>").expect("valid HTML body regex"));
static HTML_BODY_CLOSE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)</body\s*>").expect("valid HTML body regex"));
static HTML_NON_TEXT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)<!--.*?(?:-->|$)|<head\b[^>]*>.*?(?:</head\s*>|$)|<script\b[^>]*>.*?(?:</script\s*>|$)|<style\b[^>]*>.*?(?:</style\s*>|$)|<template\b[^>]*>.*?(?:</template\s*>|$)|<noscript\b[^>]*>.*?(?:</noscript\s*>|$)|<[^>]+>",
    )
    .expect("valid HTML visible-text regex")
});

/// Searchable source lines with HTML reduced to text a reader can see.
/// Source line numbers stay attached so opening a result still lands in the
/// original file rather than an intermediate plain-text representation.
pub(crate) fn searchable_text_lines(path: &str, content: &str) -> Vec<(u32, String)> {
    let is_html = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html"));
    if !is_html {
        return content
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(index, line)| (index as u32 + 1, line.to_string()))
            .collect();
    }

    let (body, first_line) = if let Some(open) = HTML_BODY_OPEN_RE.find(content) {
        let after_open = &content[open.end()..];
        let end = HTML_BODY_CLOSE_RE
            .find(after_open)
            .map_or(content.len(), |close| open.end() + close.start());
        (
            &content[open.end()..end],
            content[..open.end()]
                .bytes()
                .filter(|byte| *byte == b'\n')
                .count() as u32
                + 1,
        )
    } else {
        (content, 1)
    };

    // Replace markup with spaces instead of deleting it so line numbers and
    // word boundaries survive multi-line comments and raw-text elements.
    let mut visible = body.as_bytes().to_vec();
    for found in HTML_NON_TEXT_RE.find_iter(body) {
        for byte in &mut visible[found.range()] {
            if !matches!(*byte, b'\n' | b'\r') {
                *byte = b' ';
            }
        }
    }
    let visible =
        String::from_utf8(visible).expect("replacing HTML bytes with ASCII preserves UTF-8");
    visible
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let decoded = html_escape::decode_html_entities(line);
            let text = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
            (!text.is_empty()).then(|| (first_line + index as u32, text))
        })
        .collect()
}

pub fn create_entry(root: &Path, relative: &str, kind: &str) -> Result<String, String> {
    validate_user_entry(relative)?;
    let normalized = match kind {
        "file" => normalize_source_path(relative)?,
        "folder" => relative.trim().to_string(),
        _ => return Err("Choose a source file or folder.".to_string()),
    };
    let path = creation_path(root, &normalized)?;
    if path.exists() {
        return Err("A file or folder already exists at that path.".to_string());
    }
    match kind {
        "file" => {
            let content = seed_content_for_path(&normalized);
            apply_transaction(
                root,
                &format!("Create {normalized}"),
                vec![(normalized.clone(), content)],
            )?;
            Ok(normalized)
        }
        "folder" => {
            fs::create_dir_all(path).map_err(err)?;
            Ok(normalized)
        }
        _ => unreachable!(),
    }
}

pub fn rename_entry(root: &Path, relative: &str, new_name: &str) -> Result<String, String> {
    validate_user_entry(relative)?;
    let requested_name = validate_entry_name(new_name)?;
    let source = safe_path(root, relative)?;
    if !source.exists() {
        return Err("That file or folder no longer exists.".to_string());
    }

    let normalized_name = if source.is_file() && Path::new(requested_name).extension().is_none() {
        match source.extension().and_then(|extension| extension.to_str()) {
            Some(extension) => format!("{requested_name}.{extension}"),
            None => requested_name.to_string(),
        }
    } else {
        requested_name.to_string()
    };
    let parent = Path::new(relative)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let destination_relative = parent.join(&normalized_name).to_string_lossy().to_string();
    relocate_entry(root, relative, &destination_relative)
}

pub fn move_entry(root: &Path, relative: &str, target_directory: &str) -> Result<String, String> {
    validate_user_entry(relative)?;
    let source = safe_path(root, relative)?;
    if !source.exists() {
        return Err("That file or folder no longer exists.".to_string());
    }
    let file_name = Path::new(relative)
        .file_name()
        .ok_or_else(|| "Choose a file or folder to move.".to_string())?;
    let target_directory = target_directory.trim().trim_end_matches(['/', '\\']);
    if !target_directory.is_empty() {
        validate_user_entry(target_directory)?;
    }
    let target = if target_directory.is_empty() {
        root.to_path_buf()
    } else {
        safe_path(root, target_directory)?
    };
    if !target.is_dir() {
        return Err("Choose an existing project folder.".to_string());
    }
    let destination_relative = if target_directory.is_empty() {
        file_name.to_string_lossy().to_string()
    } else {
        Path::new(target_directory)
            .join(file_name)
            .to_string_lossy()
            .to_string()
    };
    relocate_entry(root, relative, &destination_relative)
}

fn relocate_entry(
    root: &Path,
    relative: &str,
    destination_relative: &str,
) -> Result<String, String> {
    if destination_relative == relative {
        return Ok(destination_relative.to_string());
    }
    validate_user_entry(destination_relative)?;
    let source = safe_path(root, relative)?;
    if !source.exists() {
        return Err("That file or folder no longer exists.".to_string());
    }
    if source.is_dir() && Path::new(destination_relative).starts_with(Path::new(relative)) {
        return Err("A folder cannot be moved inside itself.".to_string());
    }
    let destination = safe_path(root, destination_relative)?;
    if destination.exists() {
        return Err("A file or folder already exists with that name.".to_string());
    }
    let moved_tex_file = source.is_file()
        && source
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("tex"));

    let original_manifest = read_manifest(root)?;
    let mut updated_manifest = original_manifest.clone();
    for document in &mut updated_manifest.root_documents {
        document.path = renamed_relative_path(&document.path, relative, destination_relative);
    }
    updated_manifest.primary_bibliography = renamed_relative_path(
        &updated_manifest.primary_bibliography,
        relative,
        destination_relative,
    );

    ProjectDir::open(root)?.rename(relative, destination_relative)?;
    if let Err(error) = write_manifest(root, &updated_manifest) {
        if let Ok(project) = ProjectDir::open(root) {
            let _ = project.rename(destination_relative, relative);
        }
        let _ = write_manifest(root, &original_manifest);
        return Err(error);
    }
    if moved_tex_file {
        // A compiled PDF stops looking like a build artifact as soon as its
        // neighboring .tex file moves away, which previously exposed stale
        // outputs such as root/main.pdf in the project tree. Outputs at both
        // paths are invalid after a source move, so force the next build to
        // recreate them in the correct location.
        for source_path in [relative, destination_relative] {
            if let Err(error) = remove_tex_build_artifacts(root, source_path) {
                eprintln!("Could not remove stale build outputs for {source_path}: {error}");
            }
        }
    }
    Ok(destination_relative.to_string())
}

fn remove_tex_build_artifacts(root: &Path, relative: &str) -> Result<(), String> {
    let tex_path = root.join(relative);
    // Spelled out rather than derived from BUILD_ARTIFACT_SUFFIXES: that list
    // carries a bare `.gz` for tree-hiding purposes, and deleting someone's
    // `main.gz` because they renamed `main.tex` would be data loss.
    for extension in [
        "pdf",
        "aux",
        "bbl",
        "bbl-SAVE-ERROR",
        "bcf",
        "bcf-SAVE-ERROR",
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
    ] {
        let artifact = tex_path.with_extension(extension);
        match fs::remove_file(&artifact) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn renamed_relative_path(path: &str, old_path: &str, new_path: &str) -> String {
    let path = Path::new(path);
    let old_path = Path::new(old_path);
    match path.strip_prefix(old_path) {
        Ok(suffix) if suffix.as_os_str().is_empty() => new_path.to_string(),
        Ok(suffix) => Path::new(new_path)
            .join(suffix)
            .to_string_lossy()
            .to_string(),
        Err(_) => path.to_string_lossy().to_string(),
    }
}

pub fn import_image_bytes(
    root: &Path,
    target_directory: &str,
    file_name: &str,
    base64_data: &str,
) -> Result<String, String> {
    validate_user_entry(target_directory)?;
    let name = file_name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Choose a simple image file name.".to_string());
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("Clipboard images must be saved as PNG, JPEG, or WebP.".to_string());
    }
    let target = safe_path(root, target_directory)?;
    if !target.is_dir() {
        fs::create_dir_all(&target).map_err(err)?;
    }
    let bytes = STANDARD
        .decode(base64_data.trim())
        .map_err(|error| format!("Could not decode the clipboard image: {error}"))?;
    if bytes.is_empty() {
        return Err("The clipboard image was empty.".to_string());
    }
    let looks_valid = match extension.as_str() {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if !looks_valid {
        return Err("The clipboard data is not a valid image.".to_string());
    }
    let destination = available_asset_path(&target, name);
    fs::write(&destination, bytes).map_err(err)?;
    let canonical_root = root.canonicalize().map_err(err)?;
    Ok(destination
        .strip_prefix(canonical_root)
        .map_err(err)?
        .to_string_lossy()
        .replace('\\', "/"))
}

pub fn resolve_citation_query(query: &str) -> Result<ResolvedCitation, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Enter a DOI, arXiv id, or paper title.".to_string());
    }
    let output = run_bibcite_get(query)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            "bibcite could not resolve that query.".to_string()
        } else {
            stderr
        });
    }
    let value: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|error| format!("bibcite returned invalid JSON: {error}\n{stdout}"))?;
    let bibtex = value
        .get("bibtex")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    if bibtex.trim().is_empty() {
        return Err("bibcite did not return BibTeX for that query.".to_string());
    }
    let key = value
        .get("key")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    Ok(citation_from_bibtex(&bibtex, &key))
}

fn run_bibcite_get(query: &str) -> Result<std::process::Output, String> {
    let mut command = commands::BIBCITE.command()?;
    command
        .args(["get", "--json", query])
        .output()
        .map_err(|error| crate::papers::uv_tool_spawn_error("bibcite", &error))
}

fn citation_from_bibtex(bibtex: &str, fallback_key: &str) -> ResolvedCitation {
    let entry_type = bibtex
        .trim_start()
        .strip_prefix('@')
        .and_then(|rest| rest.split('{').next())
        .unwrap_or("article")
        .trim()
        .to_ascii_lowercase();
    let info = parse_bibliography(bibtex).into_iter().next();
    let body = bibtex
        .find(',')
        .map(|index| bibtex[index + 1..].trim_end_matches(['}', '\n']))
        .unwrap_or("");
    let fields = parse_bibliography_fields(body);
    ResolvedCitation {
        key: info
            .as_ref()
            .map(|item| item.key.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback_key.to_string()),
        title: info
            .as_ref()
            .map(|item| item.title.clone())
            .unwrap_or_else(|| fields.get("title").cloned().unwrap_or_default()),
        author: info
            .as_ref()
            .map(|item| item.authors.clone())
            .unwrap_or_else(|| fields.get("author").cloned().unwrap_or_default()),
        year: info
            .as_ref()
            .map(|item| item.year.clone())
            .unwrap_or_else(|| fields.get("year").cloned().unwrap_or_default()),
        journal: fields.get("journal").cloned().unwrap_or_default(),
        booktitle: fields.get("booktitle").cloned().unwrap_or_default(),
        publisher: fields.get("publisher").cloned().unwrap_or_default(),
        url: fields.get("url").cloned().unwrap_or_default(),
        doi: fields.get("doi").cloned().unwrap_or_default(),
        entry_type,
        bibtex: if bibtex.ends_with('\n') {
            bibtex.to_string()
        } else {
            format!("{bibtex}\n")
        },
    }
}

/// Byte range `[start, end)` of the `@type{key, … }` entry whose key matches
/// (case-insensitive), from the `@` through its closing brace. Mirrors the scan
/// in `parse_bibliography` so an entry can be read or replaced in place.
fn bib_entry_span(bibliography: &str, target_key: &str) -> Option<(usize, usize)> {
    let target = target_key.trim();
    bibliography_entry_spans(bibliography)
        .into_iter()
        .find(|(key, _, _)| key.eq_ignore_ascii_case(target))
        .map(|(_, start, end)| (start, end))
}

/// Parsed citation key and byte range for every editable BibTeX entry.
fn bibliography_entry_spans(bibliography: &str) -> Vec<(String, usize, usize)> {
    let bytes = bibliography.as_bytes();
    let mut cursor = 0;
    let mut entries = Vec::new();
    while cursor < bytes.len() {
        let Some(relative_start) = bibliography[cursor..].find('@') else {
            break;
        };
        let at = cursor + relative_start;
        let mut position = at + 1;
        let entry_type_start = position;
        while position < bytes.len() && bytes[position].is_ascii_alphabetic() {
            position += 1;
        }
        let entry_type = bibliography[entry_type_start..position].to_ascii_lowercase();
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        let Some(&opening) = bytes
            .get(position)
            .filter(|value| **value == b'{' || **value == b'(')
        else {
            cursor = position.saturating_add(1);
            continue;
        };
        let closing = if opening == b'{' { b'}' } else { b')' };
        position += 1;
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        let key_start = position;
        while position < bytes.len() && bytes[position] != b',' && bytes[position] != closing {
            position += 1;
        }
        if position >= bytes.len() || bytes[position] != b',' {
            cursor = position.saturating_add(1);
            continue;
        }
        let key = bibliography[key_start..position].trim().to_string();
        position += 1;
        let mut depth = 1usize;
        let mut quoted = false;
        while position < bytes.len() {
            let byte = bytes[position];
            if byte == b'"' && (position == 0 || bytes[position - 1] != b'\\') {
                quoted = !quoted;
            } else if !quoted && byte == opening {
                depth += 1;
            } else if !quoted && byte == closing {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            position += 1;
        }
        let entry_end = position.saturating_add(1).min(bytes.len());
        cursor = position.saturating_add(1);
        if matches!(entry_type.as_str(), "comment" | "preamble" | "string") {
            continue;
        }
        if !key.is_empty() {
            entries.push((key, at, entry_end));
        }
    }
    entries
}

/// The full field set of a single existing entry (by citation key) from the
/// project's primary bibliography, for pre-filling the entry editor.
pub fn read_bib_entry(root: &Path, key: &str) -> Result<Option<ResolvedCitation>, String> {
    let manifest = read_manifest(root)?;
    let path = safe_path(root, &manifest.primary_bibliography)?;
    if !path.exists() {
        return Ok(None);
    }
    let bibliography = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(bib_entry_span(&bibliography, key)
        .map(|(start, end)| citation_from_bibtex(&bibliography[start..end], key)))
}

/// Replace the entry with `key` in the primary bibliography (or append it when
/// absent), writing the whole file through the undoable transaction log.
pub fn save_bib_entry(root: &Path, key: &str, bibtex: &str) -> Result<(), String> {
    let manifest = read_manifest(root)?;
    let relative = manifest.primary_bibliography.clone();
    let path = safe_path(root, &relative)?;
    let existing = if path.exists() {
        std::fs::read_to_string(&path).map_err(|error| error.to_string())?
    } else {
        String::new()
    };
    let entry = bibtex.trim();
    let next = match bib_entry_span(&existing, key) {
        Some((start, end)) => format!("{}{}{}", &existing[..start], entry, &existing[end..]),
        None => {
            let trimmed = existing.trim_end();
            if trimmed.is_empty() {
                format!("{entry}\n")
            } else {
                format!("{trimmed}\n\n{entry}\n")
            }
        }
    };
    apply_citation_transaction(
        root,
        &format!("Edit {relative}"),
        vec![(relative.clone(), next)],
    )?;
    Ok(())
}

pub fn import_assets(
    root: &Path,
    sources: &[String],
    target_directory: &str,
) -> Result<Vec<String>, String> {
    if sources.is_empty() {
        return Err("Drop one or more image files first.".to_string());
    }
    // Drops land wherever the pointer was: a folder row, a file's parent
    // folder, or the project root ("", normalized as in `import_sources`).
    let target_directory = target_directory.trim().trim_end_matches(['/', '\\']);
    if !target_directory.is_empty() {
        validate_user_entry(target_directory)?;
    }
    let canonical_root = root.canonicalize().map_err(err)?;
    let target = if target_directory.is_empty() {
        canonical_root.clone()
    } else {
        safe_path(root, target_directory)?
    };
    if target.exists() && !target.is_dir() {
        return Err("Drop images onto a project folder.".to_string());
    }

    for source in sources {
        let source = Path::new(source);
        if !source.is_file() || !is_supported_asset(source) {
            return Err(format!(
                "{} is not a supported image or PDF file.",
                source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("That item")
            ));
        }
        source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "An imported image has an invalid file name.".to_string())?;
    }

    // Dropped-on folders can be brand new (the "figures" default for editor
    // drops, or a tree folder deleted on disk mid-drag): create, don't refuse.
    fs::create_dir_all(&target).map_err(err)?;
    let mut imported = Vec::new();
    for source in sources {
        let source = Path::new(source);
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .expect("asset names were validated before copying");
        let destination = available_asset_path(&target, file_name);
        fs::copy(source, &destination).map_err(err)?;
        imported.push(
            destination
                .strip_prefix(&canonical_root)
                .map_err(err)?
                .to_string_lossy()
                .to_string(),
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

/// Text mimes for the project source extensions the agent composer accepts.
fn source_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("md") => Some("text/markdown"),
        Some("html") => Some("text/html"),
        Some("tex" | "sty" | "cls") => Some("text/x-tex"),
        Some("bib" | "bst" | "txt") => Some("text/plain"),
        _ => None,
    }
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
        let mime_type = asset_mime_type(source).or_else(|| source_mime_type(source));
        if !source.is_file() || mime_type.is_none() {
            return Err(format!(
                "{} is not an image, PDF, or text file the agent can read.",
                source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("That item")
            ));
        }
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "A dropped file has an invalid file name.".to_string())?;
        if fs::metadata(source).map_err(err)?.len() > MAX_AGENT_COMPOSER_FILE_BYTES {
            return Err(format!(
                "{name} is larger than the 64 MB limit for agent attachments."
            ));
        }
        let bytes = fs::read(source).map_err(err)?;
        files.push(AgentComposerFile {
            name: name.to_string(),
            mime_type: mime_type
                .expect("checked above before reading the file")
                .to_string(),
            bytes_base64: STANDARD.encode(&bytes),
        });
    }
    Ok(files)
}

pub fn import_sources(
    root: &Path,
    sources: &[String],
    target_directory: &str,
) -> Result<Vec<String>, String> {
    if sources.is_empty() {
        return Err("Drop one or more source files first.".to_string());
    }
    let target_directory = target_directory.trim().trim_end_matches(['/', '\\']);
    if !target_directory.is_empty() {
        validate_user_entry(target_directory)?;
    }
    let target = if target_directory.is_empty() {
        root.to_path_buf()
    } else {
        safe_path(root, target_directory)?
    };
    if !target.is_dir() {
        return Err("Choose an existing project folder.".to_string());
    }

    let canonical_root = root.canonicalize().map_err(err)?;
    let mut imported = Vec::with_capacity(sources.len());
    let mut edits = Vec::new();
    let mut reserved = BTreeSet::new();
    for source in sources {
        let requested_source = Path::new(source);
        if !requested_source.is_file() || !is_supported_source(requested_source) {
            return Err(format!(
                "{} is not a supported source file.",
                requested_source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("That item")
            ));
        }
        if requested_source.metadata().map_err(err)?.len() > 10 * 1024 * 1024 {
            return Err(format!(
                "{} is larger than the 10 MB source-file limit.",
                requested_source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("That item")
            ));
        }
        let canonical_source = requested_source.canonicalize().map_err(err)?;
        if let Ok(relative) = canonical_source.strip_prefix(&canonical_root) {
            let relative = relative.to_string_lossy().replace('\\', "/");
            validate_user_entry(&relative)?;
            imported.push(relative);
            continue;
        }

        let file_name = requested_source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "An imported source has an invalid file name.".to_string())?;
        validate_entry_name(file_name)?;
        let content = fs::read_to_string(&canonical_source).map_err(|error| {
            if error.kind() == std::io::ErrorKind::InvalidData {
                format!("{file_name} is not a UTF-8 text file.")
            } else {
                error.to_string()
            }
        })?;
        let destination = available_import_path(&target, file_name, &reserved);
        reserved.insert(destination.clone());
        let relative = destination
            .strip_prefix(root)
            .map_err(err)?
            .to_string_lossy()
            .replace('\\', "/");
        edits.push((relative.clone(), content));
        imported.push(relative);
    }

    if !edits.is_empty() {
        let label = if edits.len() == 1 {
            format!("Import {}", edits[0].0)
        } else {
            format!("Import {} source files", edits.len())
        };
        apply_transaction(root, &label, edits)?;
    }
    Ok(imported)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedProjectFile {
    pub path: String,
    /// Collab document kind for share registration: "text", "board", or "binary".
    pub kind: String,
}

/// One Finder drop, any mix of files and folders. Folder imports preserve their
/// hierarchy under one collision-free top-level name; hidden entries are
/// omitted and symbolic links are not followed. Content — not extension —
/// decides each file's route. UTF-8 text lands through the undoable transaction
/// log like `import_sources`; figures keep the `import_assets` copy route so
/// collab registration stays "binary" for them (SVG is text bytes but a
/// figure); everything else is copied verbatim. Files already inside the
/// project are registered without copying.
pub fn import_files(
    root: &Path,
    sources: &[String],
    target_directory: &str,
) -> Result<Vec<ImportedProjectFile>, String> {
    if sources.is_empty() {
        return Err("Drop one or more files or folders first.".to_string());
    }
    let target_directory = target_directory.trim().trim_end_matches(['/', '\\']);
    if !target_directory.is_empty() {
        validate_user_entry(target_directory)?;
    }
    let canonical_root = root.canonicalize().map_err(err)?;
    let target = if target_directory.is_empty() {
        canonical_root.clone()
    } else {
        safe_path(root, target_directory)?
    };
    if target.exists() && !target.is_dir() {
        return Err("Drop files and folders onto a project folder.".to_string());
    }

    enum Planned {
        Existing,
        Text {
            content: String,
        },
        Binary {
            source: PathBuf,
            destination: PathBuf,
        },
    }

    fn plan_file(
        source: &Path,
        destination: Option<PathBuf>,
        canonical_root: &Path,
        plan: &mut Vec<(ImportedProjectFile, Planned)>,
    ) -> Result<(), String> {
        // classify_regular_file caps text at 8 MB, so oversized text files
        // take the verbatim copy route rather than the transaction log.
        let text =
            !is_supported_asset(source) && classify_regular_file(source)? == ContentKind::Text;
        let kind = if !text {
            "binary"
        } else if source
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("tldr"))
        {
            "board"
        } else {
            "text"
        };
        let project_path = destination.as_deref().unwrap_or(source);
        let relative = project_path
            .strip_prefix(canonical_root)
            .map_err(err)?
            .to_string_lossy()
            .replace('\\', "/");
        validate_user_entry(&relative)?;
        let planned = match destination {
            None => Planned::Existing,
            Some(_) if text => Planned::Text {
                content: fs::read_to_string(source).map_err(err)?,
            },
            Some(destination) => Planned::Binary {
                source: source.to_path_buf(),
                destination,
            },
        };
        plan.push((
            ImportedProjectFile {
                path: relative,
                kind: kind.into(),
            },
            planned,
        ));
        Ok(())
    }

    fn plan_directory(
        source: &Path,
        destination: Option<&Path>,
        canonical_root: &Path,
        directories: &mut Vec<PathBuf>,
        plan: &mut Vec<(ImportedProjectFile, Planned)>,
    ) -> Result<(), String> {
        if let Some(destination) = destination {
            directories.push(destination.to_path_buf());
        }
        // Hidden files cannot be addressed in the Project tree and commonly
        // include large VCS/cache state. Symlinks are emitted by WalkDir but
        // never traversed, keeping a dropped folder within its visible tree.
        let walker = WalkDir::new(source)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
            });
        for entry in walker.skip(1) {
            let entry = entry.map_err(err)?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(err)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            let name = entry
                .file_name()
                .to_str()
                .ok_or_else(|| "An imported folder contains an invalid file name.".to_string())?;
            validate_entry_name(name)?;
            let suffix = entry.path().strip_prefix(source).map_err(err)?;
            let entry_destination = destination.map(|target| target.join(suffix));
            if metadata.file_type().is_dir() {
                if let Some(entry_destination) = entry_destination {
                    directories.push(entry_destination);
                }
            } else if metadata.file_type().is_file() {
                plan_file(entry.path(), entry_destination, canonical_root, plan)?;
            } else {
                return Err(format!("{name} is not a regular file Lattice can import."));
            }
        }
        Ok(())
    }

    // Plan (and read text content) before touching the project, so a bad entry
    // anywhere in the batch aborts the whole drop instead of half-landing.
    let mut plan: Vec<(ImportedProjectFile, Planned)> = Vec::with_capacity(sources.len());
    let mut directories = Vec::new();
    let mut reserved = BTreeSet::new();
    for source in sources {
        let requested = Path::new(source);
        let display_name = || {
            requested
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("That item")
                .to_string()
        };
        let metadata = fs::symlink_metadata(requested).map_err(err)?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "{} is a symbolic link and cannot be imported.",
                display_name()
            ));
        }
        if !metadata.file_type().is_file() && !metadata.file_type().is_dir() {
            return Err(format!(
                "{} is not a regular file or folder Lattice can import.",
                display_name()
            ));
        }
        let canonical_source = requested.canonicalize().map_err(err)?;
        let inside_project = canonical_source.starts_with(&canonical_root);
        if inside_project {
            if metadata.file_type().is_dir() {
                let relative = canonical_source
                    .strip_prefix(&canonical_root)
                    .map_err(err)?
                    .to_string_lossy()
                    .replace('\\', "/");
                validate_user_entry(&relative)?;
                plan_directory(
                    &canonical_source,
                    None,
                    &canonical_root,
                    &mut directories,
                    &mut plan,
                )?;
            } else {
                plan_file(&canonical_source, None, &canonical_root, &mut plan)?;
            }
            continue;
        }
        let file_name = requested
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "An imported file has an invalid file name.".to_string())?;
        validate_entry_name(file_name)?;
        let destination = if metadata.file_type().is_dir() {
            if canonical_root.starts_with(&canonical_source) {
                return Err(format!(
                    "{} contains the current project and cannot be imported into it.",
                    display_name()
                ));
            }
            available_import_directory_path(&target, file_name, &reserved)
        } else {
            available_import_path(&target, file_name, &reserved)
        };
        reserved.insert(destination.clone());
        if metadata.file_type().is_dir() {
            plan_directory(
                &canonical_source,
                Some(&destination),
                &canonical_root,
                &mut directories,
                &mut plan,
            )?;
        } else {
            plan_file(
                &canonical_source,
                Some(destination),
                &canonical_root,
                &mut plan,
            )?;
        }
    }

    fs::create_dir_all(&target).map_err(err)?;
    for directory in directories {
        fs::create_dir_all(directory).map_err(err)?;
    }
    let mut edits = Vec::new();
    for (file, planned) in &plan {
        match planned {
            Planned::Existing => {}
            Planned::Text { content } => edits.push((file.path.clone(), content.clone())),
            Planned::Binary {
                source,
                destination,
            } => {
                fs::copy(source, destination).map_err(err)?;
            }
        }
    }
    if !edits.is_empty() {
        let label = if edits.len() == 1 {
            format!("Import {}", edits[0].0)
        } else {
            format!("Import {} files", edits.len())
        };
        apply_transaction(root, &label, edits)?;
    }
    Ok(plan.into_iter().map(|(file, _)| file).collect())
}

/// Write raw bytes (base64) to a project-relative path for collab sync.
/// Allows `.research/papers/**` and normal project files; blocks history/sessions/omp.
pub fn write_bytes(root: &Path, relative: &str, base64_data: &str) -> Result<(), String> {
    let relative = relative.trim().replace('\\', "/");
    if relative.is_empty() || relative.contains("..") {
        return Err("Choose a valid project-relative path.".to_string());
    }
    if relative.starts_with(".research/history/")
        || relative.starts_with(".research/sessions/")
        || relative.starts_with(".research/omp-")
        || relative.starts_with(".research/checkpoints/")
        || relative.starts_with(".research/cache/")
    {
        return Err("That path cannot be written by collab sync.".to_string());
    }
    if relative.starts_with('.') && !relative.starts_with(".research/") {
        return Err("Hidden paths outside .research cannot be written.".to_string());
    }
    if relative.starts_with(".research/")
        && !relative.starts_with(".research/papers/")
        && relative != ".research/project.json"
        && relative != ".research/brief.md"
    {
        return Err(
            "Only papers metadata and project sidecar files can sync under .research.".to_string(),
        );
    }
    let bytes = STANDARD
        .decode(base64_data.trim())
        .map_err(|error| format!("Could not decode file bytes: {error}"))?;
    if bytes.len() > 15 * 1024 * 1024 {
        return Err("Synced binary files must be 15 MB or smaller.".to_string());
    }
    ProjectDir::open(root)?.atomic_write(&relative, &bytes)
}

pub fn read_asset(root: &Path, relative: &str) -> Result<AssetPreview, String> {
    let path = safe_path(root, relative)?;
    // SVG is the one supported image format whose bytes classify as text; it
    // is still a figure to preview, not a source file to open in an editor.
    let svg = path
        .extension()
        .is_some_and(|value| value.eq_ignore_ascii_case("svg"));
    if !path.is_file() || (!svg && classify_regular_file(&path)? == ContentKind::Text) {
        return Err("Choose a binary project file.".to_string());
    }
    let size = fs::metadata(&path).map_err(err)?.len();
    if size > 50 * 1024 * 1024 {
        return Err(
            "This figure is too large to preview inside Lattice (50 MB maximum).".to_string(),
        );
    }
    let mime_type = asset_mime_type(&path).unwrap_or("application/octet-stream");
    Ok(AssetPreview {
        path: relative.replace('\\', "/"),
        mime_type: mime_type.to_string(),
        base64: STANDARD.encode(fs::read(&path).map_err(err)?),
    })
}

pub fn prepare_latex_figure(root: &Path, relative: &str) -> Result<String, String> {
    let source = safe_path(root, relative)?;
    if !source.is_file() || !is_supported_asset(&source) {
        return Err("Choose an image or PDF from the project.".to_string());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "svg" => convert_figure(root, relative, &source, "pdf"),
        "webp" => convert_figure(root, relative, &source, "png"),
        _ => Ok(relative.replace('\\', "/")),
    }
}

fn convert_figure(
    root: &Path,
    relative: &str,
    source: &Path,
    target_extension: &str,
) -> Result<String, String> {
    let relative_path = Path::new(relative);
    let stem = relative_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("figure");
    let converted_name = format!("{stem}-converted.{target_extension}");
    let converted_relative = relative_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(converted_name);
    let destination = safe_path(root, &converted_relative.to_string_lossy())?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let current = destination.exists()
        && fs::metadata(&destination)
            .and_then(|value| value.modified())
            .ok()
            >= fs::metadata(source).and_then(|value| value.modified()).ok();
    if !current {
        let output = if source.extension().is_some_and(|value| value.eq_ignore_ascii_case("svg")) {
            if commands::available("rsvg-convert") {
                commands::command("rsvg-convert")
                    .arg("-f")
                    .arg("pdf")
                    .arg("-o")
                    .arg(&destination)
                    .arg(source)
                    .output()
            } else if commands::available("magick") {
                commands::command("magick").arg(source).arg(&destination).output()
            } else {
                return Err("SVG insertion needs rsvg-convert or ImageMagick. The figure can still be previewed in Lattice.".to_string());
            }
        } else if commands::available("magick") {
            commands::command("magick").arg(source).arg(&destination).output()
        } else {
            commands::command("sips")
                .arg("-s")
                .arg("format")
                .arg("png")
                .arg(source)
                .arg("--out")
                .arg(&destination)
                .output()
        }
        .map_err(err)?;
        if !output.status.success() || !destination.is_file() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                "Lattice could not convert this figure for LaTeX.".to_string()
            } else {
                format!("Lattice could not convert this figure for LaTeX. {detail}")
            });
        }
    }
    Ok(converted_relative.to_string_lossy().replace('\\', "/"))
}

fn asset_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("svg") => Some("image/svg+xml"),
        Some("webp") => Some("image/webp"),
        Some("pdf") => Some("application/pdf"),
        Some("eps") => Some("application/postscript"),
        _ => None,
    }
}

fn available_asset_path(directory: &Path, file_name: &str) -> PathBuf {
    available_import_path(directory, file_name, &BTreeSet::new())
}

fn available_import_path(
    directory: &Path,
    file_name: &str,
    reserved: &BTreeSet<PathBuf>,
) -> PathBuf {
    let requested = directory.join(file_name);
    if !requested.exists() && !reserved.contains(&requested) {
        return requested;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("figure");
    let extension = path.extension().and_then(|value| value.to_str());
    for suffix in 2.. {
        let candidate = match extension {
            Some(extension) => directory.join(format!("{stem}-{suffix}.{extension}")),
            None => directory.join(format!("{stem}-{suffix}")),
        };
        if !candidate.exists() && !reserved.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn available_import_directory_path(
    directory: &Path,
    directory_name: &str,
    reserved: &BTreeSet<PathBuf>,
) -> PathBuf {
    let requested = directory.join(directory_name);
    if !requested.exists() && !reserved.contains(&requested) {
        return requested;
    }
    for suffix in 2.. {
        let candidate = directory.join(format!("{directory_name}-{suffix}"));
        if !candidate.exists() && !reserved.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn is_supported_asset(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "pdf" | "svg" | "eps" | "webp")
    )
}

fn is_supported_source(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        // Keep in sync with PROJECT_SOURCE_EXTENSIONS in src/app-utils.ts,
        // which decides what the frontend offers to this import path.
        Some("tex" | "bib" | "md" | "txt" | "html" | "sty" | "cls" | "bst" | "tldr")
    )
}

fn normalize_source_path(relative: &str) -> Result<String, String> {
    let path = Path::new(relative.trim());
    match path.extension().and_then(|extension| extension.to_str()) {
        None => Ok(path.with_extension("tex").to_string_lossy().to_string()),
        Some(extension)
            if matches!(
                extension.to_ascii_lowercase().as_str(),
                "tex" | "bib" | "md" | "sty" | "cls" | "txt" | "html" | "tldr"
            ) =>
        {
            Ok(path.to_string_lossy().to_string())
        }
        _ => Err(
            "New source files must use .tex, .bib, .md, .sty, .cls, .txt, .html, or .tldr."
                .to_string(),
        ),
    }
}

fn seed_content_for_path(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("bib") => "% Bibliography\n".to_string(),
        Some("md") => "# Notes\n".to_string(),
        Some("sty" | "cls") => "% Package\n".to_string(),
        Some("txt" | "html" | "tldr") => String::new(),
        _ => "% New LaTeX file\n".to_string(),
    }
}

pub fn delete_entry(root: &Path, relative: &str) -> Result<(), String> {
    validate_user_entry(relative)?;
    let manifest = read_manifest(root)?;
    let requested = Path::new(relative);
    // Only what a build would actually reach for. `root_documents` is not a
    // curated list: every .tex that declares \documentclass is appended to it
    // the first time it is open during a build, so guarding all of them meant
    // an ordinary draft became undeletable simply because it had been compiled
    // once — with a message about the "primary manuscript" that was not true of
    // it.
    let compiled = manifest
        .root_documents
        .iter()
        .find(|document| document.is_default)
        .or_else(|| manifest.root_documents.first())
        .map(|document| document.path.as_str());
    let protected = compiled
        .into_iter()
        .chain(std::iter::once(manifest.primary_bibliography.as_str()));
    if protected.into_iter().any(|path| {
        let protected = Path::new(path);
        protected == requested || protected.starts_with(requested)
    }) {
        return Err(
            "The document being compiled and its bibliography cannot be deleted.".to_string(),
        );
    }
    let path = safe_path(root, relative)?;
    if !path.exists() {
        return Err("That file or folder no longer exists.".to_string());
    }
    if path.is_dir() {
        ProjectDir::open(root)?.remove(relative)?;
        forget_deleted_root_documents(root, relative)
    } else {
        let before = fs::read_to_string(&path).ok();
        ProjectDir::open(root)?.remove(relative)?;
        if let Some(before) = before {
            let record = new_transaction(
                &format!("Delete {relative}"),
                vec![FileChange {
                    path: relative.to_string(),
                    before: Some(before),
                    after: None,
                }],
                HistoryContext::user("delete", "project"),
            );
            persist_transaction(root, &record)?;
        }
        forget_deleted_root_documents(root, relative)
    }
}

/// Drop manifest root documents whose file has just been deleted.
///
/// Leaving them behind pointed the manifest at a file that is gone, which the
/// build and the SyncTeX paths both resolve through — and the entry would go on
/// protecting a path nobody can delete or restore. The compiled document is
/// never in here: it is refused above, so the default always survives.
fn forget_deleted_root_documents(root: &Path, deleted: &str) -> Result<(), String> {
    let mut manifest = read_manifest(root)?;
    let deleted_path = Path::new(deleted);
    let before = manifest.root_documents.len();
    manifest.root_documents.retain(|document| {
        let path = Path::new(&document.path);
        !(path == deleted_path || path.starts_with(deleted_path))
    });
    if manifest.root_documents.len() == before {
        return Ok(());
    }
    write_manifest(root, &manifest)
}

fn validate_user_entry(relative: &str) -> Result<(), String> {
    let trimmed = relative.trim();
    let first = Path::new(trimmed).components().next();
    if trimmed.is_empty() || matches!(first, Some(Component::Normal(value)) if value == ".research")
    {
        return Err("Choose a project-relative path outside .research.".to_string());
    }
    Ok(())
}

fn validate_entry_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    let mut components = Path::new(trimmed).components();
    let simple_name =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !simple_name || trimmed.starts_with('.') {
        return Err("Choose a simple name without folders or a leading dot.".to_string());
    }
    Ok(trimmed)
}

fn ensure_ignore_line(path: &Path, line: &str) -> Result<(), String> {
    let current = fs::read_to_string(path).unwrap_or_default();
    if current.lines().any(|existing| existing.trim() == line) {
        return Ok(());
    }
    let separator = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    fs::write(path, format!("{current}{separator}{line}\n")).map_err(err)
}

fn file_change_has_effect(change: &FileChange) -> bool {
    change.before != change.after
}

pub fn apply_transaction(
    root: &Path,
    label: &str,
    edits: Vec<(String, String)>,
) -> Result<Option<TransactionRecord>, String> {
    let context = if label.starts_with("Edit ") {
        HistoryContext::user("edit", "editor")
    } else {
        HistoryContext::user("project", "project")
    };
    apply_transaction_with_context(root, label, edits, context)
}

pub fn apply_citation_transaction(
    root: &Path,
    label: &str,
    edits: Vec<(String, String)>,
) -> Result<Option<TransactionRecord>, String> {
    apply_transaction_with_context(
        root,
        label,
        edits,
        HistoryContext {
            actor: "citation",
            kind: "citation",
            source: "citation",
            thread_id: None,
            checkpoint_ref: None,
            undo_of: None,
        },
    )
}

/// Apply citation edits only if every source file still has the contents from
/// which the edits were calculated. This prevents a delayed bibliography
/// action from replacing manuscript changes made while its confirmation was
/// open.
pub fn apply_citation_transaction_checked(
    root: &Path,
    label: &str,
    edits: Vec<(String, String, String)>,
) -> Result<Option<TransactionRecord>, String> {
    if edits.is_empty() {
        return Err("The transaction contains no edits.".to_string());
    }

    let mut changes = Vec::with_capacity(edits.len());
    for (relative, before, after) in edits {
        validate_transaction_path(&relative)?;
        let path = root.join(&relative);
        let current = if path.exists() {
            Some(fs::read_to_string(&path).map_err(err)?)
        } else {
            None
        };
        if current.as_deref() != Some(before.as_str()) {
            return Err(format!(
                "Cannot remove the reference because {relative} changed. Try again."
            ));
        }
        if before != after {
            changes.push(FileChange {
                path: relative,
                before: Some(before),
                after: Some(after),
            });
        }
    }

    commit_transaction_changes(
        root,
        label,
        changes,
        HistoryContext {
            actor: "citation",
            kind: "citation",
            source: "citation",
            thread_id: None,
            checkpoint_ref: None,
            undo_of: None,
        },
    )
}

fn validate_transaction_path(relative: &str) -> Result<(), String> {
    if relative.starts_with(".research/history/") {
        return Err("History records cannot edit themselves.".to_string());
    }
    let relative_path = Path::new(relative);
    if relative_path.as_os_str().is_empty()
        || relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err("The requested path is outside the project.".to_string());
    }
    Ok(())
}

fn apply_transaction_with_context(
    root: &Path,
    label: &str,
    edits: Vec<(String, String)>,
    context: HistoryContext,
) -> Result<Option<TransactionRecord>, String> {
    if edits.is_empty() {
        return Err("The transaction contains no edits.".to_string());
    }

    let mut changes = Vec::with_capacity(edits.len());
    for (relative, after) in &edits {
        validate_transaction_path(relative)?;
        let relative_path = Path::new(relative);
        // This path is used only to capture the previous contents. Parent
        // creation and the mutation itself are descriptor-relative below.
        let path = root.join(relative_path);
        let before = if path.exists() {
            Some(fs::read_to_string(&path).map_err(err)?)
        } else {
            None
        };
        if before.as_ref() != Some(after) {
            changes.push(FileChange {
                path: relative.clone(),
                before,
                after: Some(after.clone()),
            });
        }
    }

    commit_transaction_changes(root, label, changes, context)
}

fn rollback_transaction_files(
    root: &Path,
    project: &ProjectDir,
    changes: &[FileChange],
) -> Result<(), String> {
    let mut failures = Vec::new();
    for change in changes.iter().rev() {
        let result = match &change.before {
            Some(before) => project.atomic_write(&change.path, before.as_bytes()),
            None if root.join(&change.path).exists() => project.remove(&change.path),
            None => Ok(()),
        };
        if let Err(error) = result {
            failures.push(format!("{}: {error}", change.path));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn commit_transaction_changes(
    root: &Path,
    label: &str,
    changes: Vec<FileChange>,
    context: HistoryContext,
) -> Result<Option<TransactionRecord>, String> {
    if changes.is_empty() {
        return Ok(None);
    }

    // Recheck all inputs immediately before the first write. In particular,
    // checked citation edits may have spent time in bibcite after reading the
    // manuscript and must not commit against a newer version.
    for change in &changes {
        let path = root.join(&change.path);
        let current = if path.exists() {
            Some(fs::read_to_string(&path).map_err(err)?)
        } else {
            None
        };
        if current != change.before {
            return Err(format!(
                "Cannot apply the change because {} changed. Try again.",
                change.path
            ));
        }
    }

    let project = ProjectDir::open(root)?;
    let mut applied = 0usize;
    for change in &changes {
        if let Some(after) = &change.after {
            if let Err(error) = project.atomic_write(&change.path, after.as_bytes()) {
                let rollback = rollback_transaction_files(root, &project, &changes[..applied]);
                return Err(match rollback {
                    Ok(()) => error,
                    Err(rollback_error) => {
                        format!(
                            "{error} The partial change could not be rolled back: {rollback_error}"
                        )
                    }
                });
            }
            applied += 1;
        }
    }

    let coalesced = match coalesce_edit_transaction(root, label, &changes, &context) {
        Ok(result) => result,
        Err(error) => {
            let rollback = rollback_transaction_files(root, &project, &changes[..applied]);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => {
                    format!("{error} The file changes could not be rolled back: {rollback_error}")
                }
            });
        }
    };
    match coalesced {
        CoalescedTransaction::NotCoalesced => {}
        CoalescedTransaction::Removed => return Ok(None),
        CoalescedTransaction::Updated(record) => return Ok(Some(*record)),
    }

    let record = new_transaction(label, changes, context);
    if let Err(error) = persist_transaction(root, &record) {
        // `persist_transaction` may have written the record before a later
        // pruning failure. Do not leave history claiming a rolled-back edit.
        let _ = fs::remove_file(transaction_path(root, &record.id)?);
        forget_latest_history(root);
        let rollback = rollback_transaction_files(root, &project, &record.changes[..applied]);
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error} The file changes could not be rolled back: {rollback_error}")
            }
        });
    }
    Ok(Some(record))
}

enum CoalescedTransaction {
    NotCoalesced,
    Removed,
    Updated(Box<TransactionRecord>),
}

fn coalesce_edit_transaction(
    root: &Path,
    label: &str,
    changes: &[FileChange],
    context: &HistoryContext,
) -> Result<CoalescedTransaction, String> {
    if !label.starts_with("Edit ") || changes.len() != 1 {
        return Ok(CoalescedTransaction::NotCoalesced);
    }
    let Some(change) = changes.first() else {
        return Ok(CoalescedTransaction::NotCoalesced);
    };
    let Some(mut previous) = latest_history_record(root)? else {
        return Ok(CoalescedTransaction::NotCoalesced);
    };
    if previous.label != label || previous.changes.len() != 1 {
        return Ok(CoalescedTransaction::NotCoalesced);
    }
    if inferred_history_metadata(&previous) != (context.actor, context.kind, context.source) {
        return Ok(CoalescedTransaction::NotCoalesced);
    }
    if previous.changes[0].path != change.path {
        return Ok(CoalescedTransaction::NotCoalesced);
    }
    let Ok(previous_time) = chrono::DateTime::parse_from_rfc3339(&previous.timestamp) else {
        return Ok(CoalescedTransaction::NotCoalesced);
    };
    let age = Utc::now().signed_duration_since(previous_time.with_timezone(&Utc));
    if age.num_seconds() > EDIT_COALESCE_SECS {
        return Ok(CoalescedTransaction::NotCoalesced);
    }
    if previous.changes[0].before == change.after {
        fs::remove_file(transaction_path(root, &previous.id)?).map_err(err)?;
        // The next-newest record is unknown without a scan; drop the memo and
        // let the next read rediscover it lazily.
        forget_latest_history(root);
        return Ok(CoalescedTransaction::Removed);
    }
    previous.changes[0].after = change.after.clone();
    previous.timestamp = Utc::now().to_rfc3339();
    let path = transaction_path(root, &previous.id)?;
    let raw = serde_json::to_string_pretty(&previous).map_err(err)?;
    fs::write(path, format!("{raw}\n")).map_err(err)?;
    remember_latest_history(root, &previous);
    Ok(CoalescedTransaction::Updated(Box::new(previous)))
}

/// Newest-history memo per project root: (record id, record timestamp).
///
/// `coalesce_edit_transaction` needs the newest record on every save, and
/// rediscovering it means reading and JSON-parsing every history file (up to
/// MAX_HISTORY_ENTRIES, each embedding full before/after file contents) —
/// which put tens of megabytes of parsing on the save path, and dirty file
/// switches await that save. Every in-process mutation flows through
/// `persist_transaction`, `coalesce_edit_transaction`, or `delete_history`,
/// which keep this memo honest; a hit still re-reads the memoized record
/// from disk (one file, not the whole directory) and falls back to the full
/// scan on any surprise. A second app process mutating the same project is a
/// pre-existing race this memo does not widen.
static LATEST_HISTORY: LazyLock<Mutex<HashMap<PathBuf, (String, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn remember_latest_history(root: &Path, record: &TransactionRecord) {
    LATEST_HISTORY.lock().unwrap().insert(
        root.to_path_buf(),
        (record.id.clone(), record.timestamp.clone()),
    );
}

fn forget_latest_history(root: &Path) {
    LATEST_HISTORY.lock().unwrap().remove(root);
}

fn latest_history_record(root: &Path) -> Result<Option<TransactionRecord>, String> {
    let memoized = LATEST_HISTORY.lock().unwrap().get(root).cloned();
    if let Some((id, _timestamp)) = memoized {
        if let Some(record) = read_memoized_history_record(root, &id) {
            return Ok(Some(record));
        }
        // The memoized record vanished or no longer parses — drop the memo
        // and rediscover from the directory.
        forget_latest_history(root);
    }
    let newest = scan_latest_history_record(root)?;
    if let Some(record) = &newest {
        remember_latest_history(root, record);
    }
    Ok(newest)
}

fn read_memoized_history_record(root: &Path, id: &str) -> Option<TransactionRecord> {
    let path = transaction_path(root, id).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let record = serde_json::from_str::<TransactionRecord>(&raw).ok()?;
    if !record.changes.iter().any(file_change_has_effect) {
        return None;
    }
    Some(record)
}

fn scan_latest_history_record(root: &Path) -> Result<Option<TransactionRecord>, String> {
    let directory = root.join(".research/history");
    if !directory.exists() {
        return Ok(None);
    }
    let mut newest: Option<(String, TransactionRecord)> = None;
    for entry in fs::read_dir(directory).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let raw = fs::read_to_string(&path).map_err(err)?;
        let Ok(record) = serde_json::from_str::<TransactionRecord>(&raw) else {
            continue;
        };
        if !record.changes.iter().any(file_change_has_effect) {
            continue;
        }
        let stamp = record.timestamp.clone();
        if newest
            .as_ref()
            .map(|(current, _)| stamp.as_str() > current.as_str())
            .unwrap_or(true)
        {
            newest = Some((stamp, record));
        }
    }
    Ok(newest.map(|(_, record)| record))
}

#[cfg(test)]
pub type TextSnapshot = BTreeMap<String, String>;

#[cfg(test)]
pub fn snapshot_text_files(root: &Path) -> Result<TextSnapshot, String> {
    let mut snapshot = BTreeMap::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(err)?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry.path().strip_prefix(root).map_err(err)?;
        if relative.components().any(|component| {
            matches!(component, Component::Normal(name) if name == ".research" || name == ".git" || name == "node_modules")
        }) || is_build_artifact(entry.path())
        {
            continue;
        }
        if let Ok(content) = fs::read_to_string(entry.path()) {
            snapshot.insert(relative.to_string_lossy().to_string(), content);
        }
    }
    Ok(snapshot)
}

#[cfg(test)]
pub fn save_conversation_checkpoint(
    root: &Path,
    session_id: &str,
    message_id: &str,
) -> Result<(), String> {
    validate_checkpoint_id(session_id)?;
    validate_checkpoint_id(message_id)?;
    let path = checkpoint_path(root, session_id, message_id);
    let snapshot = snapshot_text_files(root)?;
    let raw = format!(
        "{}\n",
        serde_json::to_string_pretty(&snapshot).map_err(err)?
    );
    if raw.len() as u64 > MAX_CHECKPOINT_BYTES {
        return Err(format!(
            "The project is too large to checkpoint ({} MiB; limit is {} MiB).",
            raw.len().div_ceil(1024 * 1024),
            MAX_CHECKPOINT_BYTES / (1024 * 1024)
        ));
    }
    // Free the checkpoint's budget before writing it, so cleanup still works
    // when the volume is already too full to hold one more complete snapshot.
    prune_conversation_checkpoints(
        root,
        MAX_CHECKPOINTS_PER_SESSION,
        MAX_CHECKPOINT_BYTES.saturating_sub(raw.len() as u64),
        None,
        (!path.exists()).then_some(session_id),
    )?;
    let parent = path.parent().expect("checkpoint path has a parent");
    fs::create_dir_all(parent).map_err(err)?;
    let temporary = path.with_extension("json.tmp");
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(err)?;
    }
    if let Err(error) = fs::write(&temporary, raw) {
        let _ = fs::remove_file(&temporary);
        return Err(err(error));
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(err(error));
    }
    prune_conversation_checkpoints(
        root,
        MAX_CHECKPOINTS_PER_SESSION,
        MAX_CHECKPOINT_BYTES,
        Some(&path),
        None,
    )
}

fn prune_conversation_checkpoints(
    root: &Path,
    per_session_limit: usize,
    total_byte_limit: u64,
    protected: Option<&Path>,
    reserved_session: Option<&str>,
) -> Result<(), String> {
    let directory = root.join(".research/checkpoints");
    let directory_metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(err(error)),
    };
    if !directory_metadata.file_type().is_dir() {
        return Ok(());
    }
    let mut entries = Vec::new();
    let mut session_directories = Vec::new();
    for session in fs::read_dir(&directory).map_err(err)? {
        let session = session.map_err(err)?;
        if !session.file_type().map_err(err)?.is_dir() {
            continue;
        }
        session_directories.push(session.path());
        for checkpoint in fs::read_dir(session.path()).map_err(err)? {
            let checkpoint = checkpoint.map_err(err)?;
            let path = checkpoint.path();
            if !checkpoint.file_type().map_err(err)?.is_file() {
                continue;
            }
            if path.extension().is_some_and(|extension| extension == "tmp") {
                fs::remove_file(path).map_err(err)?;
                continue;
            }
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let metadata = checkpoint.metadata().map_err(err)?;
            entries.push((
                metadata.modified().map_err(err)?,
                session.file_name(),
                metadata.len(),
                path,
            ));
        }
    }
    entries.sort_by(|left, right| {
        let left_protected = protected.is_some_and(|path| path == left.3);
        let right_protected = protected.is_some_and(|path| path == right.3);
        right_protected
            .cmp(&left_protected)
            .then_with(|| right.0.cmp(&left.0))
            .then_with(|| right.3.cmp(&left.3))
    });
    let mut per_session = BTreeMap::new();
    let mut kept_bytes = 0u64;
    for (_, session, size, path) in entries {
        let session_limit = per_session_limit.saturating_sub(usize::from(
            reserved_session.is_some_and(|reserved| session.to_string_lossy() == reserved),
        ));
        let session_count = per_session.entry(session).or_insert(0usize);
        let fits_count = *session_count < session_limit;
        let fits_bytes = kept_bytes.saturating_add(size) <= total_byte_limit;
        if fits_count && fits_bytes {
            *session_count += 1;
            kept_bytes = kept_bytes.saturating_add(size);
        } else {
            fs::remove_file(path).map_err(err)?;
        }
    }
    for session in session_directories {
        match fs::remove_dir(session) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(err(error)),
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn restore_conversation_checkpoint(
    root: &Path,
    session_id: &str,
    message_id: &str,
    fallback_timestamp: Option<&str>,
) -> Result<Option<TransactionRecord>, String> {
    validate_checkpoint_id(session_id)?;
    validate_checkpoint_id(message_id)?;
    let path = checkpoint_path(root, session_id, message_id);
    let target = if path.is_file() {
        serde_json::from_str::<TextSnapshot>(&fs::read_to_string(path).map_err(err)?)
            .map_err(err)?
    } else if let Some(timestamp) = fallback_timestamp {
        reconstruct_snapshot_at(root, timestamp)?
    } else {
        return Err(
            "This message predates project checkpoints and its file state cannot be reconstructed."
                .to_string(),
        );
    };
    restore_text_snapshot(
        root,
        &target,
        "Restore files for conversation branch",
        HistoryContext {
            actor: "user",
            kind: "restore",
            source: "checkpoint",
            thread_id: Some(session_id.to_string()),
            checkpoint_ref: Some(message_id.to_string()),
            undo_of: None,
        },
    )
}

#[cfg(test)]
fn reconstruct_snapshot_at(root: &Path, timestamp: &str) -> Result<TextSnapshot, String> {
    let target_time = chrono::DateTime::parse_from_rfc3339(timestamp).map_err(err)?;
    let mut snapshot = snapshot_text_files(root)?;
    let directory = root.join(".research/history");
    if !directory.is_dir() {
        return Ok(snapshot);
    }
    let mut records = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            if let Ok(record) =
                serde_json::from_str::<TransactionRecord>(&fs::read_to_string(path).map_err(err)?)
            {
                if chrono::DateTime::parse_from_rfc3339(&record.timestamp)
                    .is_ok_and(|record_time| record_time > target_time)
                {
                    records.push(record);
                }
            }
        }
    }
    records.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    for record in records {
        for change in record.changes {
            match change.before {
                Some(content) => {
                    snapshot.insert(change.path, content);
                }
                None => {
                    snapshot.remove(&change.path);
                }
            }
        }
    }
    Ok(snapshot)
}

#[cfg(test)]
fn restore_text_snapshot(
    root: &Path,
    target: &TextSnapshot,
    label: &str,
    context: HistoryContext,
) -> Result<Option<TransactionRecord>, String> {
    let current = snapshot_text_files(root)?;
    let paths = current
        .keys()
        .chain(target.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let changes = paths
        .into_iter()
        .filter_map(|path| {
            let before = current.get(&path).cloned();
            let after = target.get(&path).cloned();
            (before != after).then_some(FileChange {
                path,
                before,
                after,
            })
        })
        .collect::<Vec<_>>();
    if changes.is_empty() {
        return Ok(None);
    }
    for change in &changes {
        let path = safe_path(root, &change.path)?;
        match &change.after {
            Some(content) => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(err)?;
                }
                fs::write(path, content).map_err(err)?;
            }
            None if path.exists() => fs::remove_file(path).map_err(err)?,
            None => {}
        }
    }
    let record = new_transaction(label, changes, context);
    persist_transaction(root, &record)?;
    Ok(Some(record))
}

#[cfg(test)]
fn checkpoint_path(root: &Path, session_id: &str, message_id: &str) -> PathBuf {
    root.join(".research/checkpoints")
        .join(session_id)
        .join(format!("{message_id}.json"))
}

#[cfg(test)]
fn validate_checkpoint_id(value: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| "Invalid conversation checkpoint id.".to_string())
}

#[cfg(test)]
pub fn record_agent_changes(
    root: &Path,
    before: &TextSnapshot,
    label: &str,
    thread_id: &str,
) -> Result<Option<TransactionRecord>, String> {
    record_external_changes_with_context(
        root,
        before,
        label,
        HistoryContext {
            actor: "agent",
            kind: "agent",
            source: "agent",
            thread_id: Some(thread_id.to_string()),
            checkpoint_ref: None,
            undo_of: None,
        },
    )
}

#[cfg(test)]
fn record_external_changes_with_context(
    root: &Path,
    before: &TextSnapshot,
    label: &str,
    context: HistoryContext,
) -> Result<Option<TransactionRecord>, String> {
    let after = snapshot_text_files(root)?;
    let paths = before
        .keys()
        .chain(after.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let changes = paths
        .into_iter()
        .filter_map(|path| {
            let old = before.get(&path).cloned();
            let new = after.get(&path).cloned();
            (old != new).then_some(FileChange {
                path,
                before: old,
                after: new,
            })
        })
        .collect::<Vec<_>>();
    if changes.is_empty() {
        return Ok(None);
    }
    let record = new_transaction(label, changes, context);
    persist_transaction(root, &record)?;
    Ok(Some(record))
}

pub fn history(root: &Path) -> Result<Vec<HistoryItem>, String> {
    let directory = root.join(".research/history");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            let raw = fs::read_to_string(path).map_err(err)?;
            if let Ok(record) = serde_json::from_str::<TransactionRecord>(&raw) {
                let changed_files = record
                    .changes
                    .iter()
                    .filter(|change| file_change_has_effect(change))
                    .map(|change| change.path.clone())
                    .collect::<Vec<_>>();
                if changed_files.is_empty() {
                    continue;
                }
                let (actor, kind, source) = inferred_history_metadata(&record);
                records.push(HistoryItem {
                    id: record.id.clone(),
                    label: record.label.clone(),
                    timestamp: record.timestamp.clone(),
                    files: changed_files,
                    actor: actor.to_string(),
                    kind: kind.to_string(),
                    source: source.to_string(),
                    thread_id: record.thread_id.clone(),
                    checkpoint_ref: record.checkpoint_ref.clone(),
                    undo_of: record.undo_of.clone(),
                });
            }
        }
    }
    records.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(records)
}

pub fn revert(root: &Path, transaction_id: &str) -> Result<TransactionRecord, String> {
    let source = get_history_entry(root, transaction_id)?;
    restore_record_changes(root, &source, None)
}

pub fn revert_file(
    root: &Path,
    transaction_id: &str,
    relative: &str,
) -> Result<TransactionRecord, String> {
    let source = get_history_entry(root, transaction_id)?;
    restore_record_changes(root, &source, Some(relative))
}

fn restore_record_changes(
    root: &Path,
    source: &TransactionRecord,
    only_path: Option<&str>,
) -> Result<TransactionRecord, String> {
    let selected = source
        .changes
        .iter()
        .filter(|change| only_path.is_none_or(|relative| change.path == relative))
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err("That file is not part of this history entry.".to_string());
    }

    let mut inverse = Vec::with_capacity(selected.len());
    for change in selected {
        let path = safe_path(root, &change.path)?;
        let current = if path.exists() {
            Some(fs::read_to_string(&path).map_err(err)?)
        } else {
            None
        };
        if current == change.before {
            continue;
        }
        if current != change.after {
            return Err(format!(
                "Cannot restore {} because it changed after this history entry. Review the newer changes first.",
                change.path
            ));
        }
        inverse.push(FileChange {
            path: change.path.clone(),
            before: current,
            after: change.before.clone(),
        });
    }
    if inverse.is_empty() {
        return Err("The selected files are already at the requested state.".to_string());
    }

    for change in &inverse {
        let path = safe_path(root, &change.path)?;
        match &change.after {
            Some(content) => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(err)?;
                }
                fs::write(path, content).map_err(err)?;
            }
            None if path.exists() => fs::remove_file(path).map_err(err)?,
            None => {}
        }
    }

    let label = only_path
        .map(|relative| format!("Restore {relative} from {}", source.label))
        .unwrap_or_else(|| format!("Restore {}", source.label));
    let record = new_transaction(&label, inverse, HistoryContext::restore(source));
    persist_transaction(root, &record)?;
    Ok(record)
}

fn replace_targets(root: &Path, paths: Option<Vec<String>>) -> Result<Vec<String>, String> {
    if let Some(paths) = paths {
        Ok(paths
            .into_iter()
            .filter(|path| searchable_text_path(path))
            .collect())
    } else {
        let mut collected = Vec::new();
        collect_searchable_paths(&scan_files(root)?, &mut collected);
        Ok(collected)
    }
}

pub fn list_todos(root: &Path) -> Result<Vec<TodoHit>, String> {
    let mut hits = Vec::new();
    for relative in replace_targets(root, None)? {
        if !todo_source_path(&relative) {
            continue;
        }
        let absolute = safe_path(root, &relative)?;
        if !absolute.is_file() {
            continue;
        }
        let content = fs::read_to_string(&absolute).unwrap_or_default();
        hits.extend(todos_in_text(&relative, &content));
        if hits.len() >= 400 {
            hits.truncate(400);
            break;
        }
    }
    Ok(hits)
}

fn todo_source_path(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("tex" | "md")
    )
}

fn todos_in_text(path: &str, content: &str) -> Vec<TodoHit> {
    let mut hits = Vec::new();
    for (index, line) in content.lines().enumerate() {
        if let Some(kind) = todo_kind_in_line(line) {
            let preview = {
                let trimmed = line.trim();
                let clipped: String = trimmed.chars().take(160).collect();
                if trimmed.chars().count() > 160 {
                    format!("{clipped}…")
                } else {
                    clipped
                }
            };
            hits.push(TodoHit {
                path: path.replace('\\', "/"),
                line: (index + 1) as u32,
                kind: kind.to_string(),
                preview,
            });
        }
    }
    hits
}

fn todo_kind_in_line(line: &str) -> Option<&'static str> {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix('%') {
        let upper = rest.to_ascii_uppercase();
        if upper.contains("FIXME") {
            return Some("FIXME");
        }
        if upper.contains("XXX") {
            return Some("XXX");
        }
        if upper.contains("TODO") {
            return Some("TODO");
        }
    }
    // \todo{...} / \todo [...]{...} — common todonotes / inline markers
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("\\todo{") || lower.contains("\\todo[") || lower.contains("\\todo*{") {
        return Some("todo");
    }
    None
}

pub fn preview_replace_in_project(
    root: &Path,
    query: &str,
    paths: Option<Vec<String>>,
    match_case: bool,
    use_regex: bool,
) -> Result<ReplacePreview, String> {
    if query.is_empty() {
        return Err("Enter text to find.".to_string());
    }
    let matcher = ReplaceMatcher::new(query, match_case, use_regex)?;
    let targets = replace_targets(root, paths)?;
    let mut matches = Vec::new();
    let mut files = 0u32;
    let mut replacements = 0u32;
    for relative in targets {
        let path = safe_path(root, &relative)?;
        if !path.is_file() {
            continue;
        }
        let before = fs::read_to_string(&path).map_err(err)?;
        let mut file_hits = 0u32;
        for (line_index, line) in before.lines().enumerate() {
            for (column, _len) in matcher.find_in(line) {
                let preview = truncate_chars(line.trim(), 120);
                if matches.len() < 200 {
                    matches.push(ReplaceMatch {
                        path: relative.clone(),
                        line: (line_index + 1) as u32,
                        column: (column + 1) as u32,
                        preview,
                    });
                }
                file_hits += 1;
                replacements += 1;
            }
        }
        if file_hits > 0 {
            files += 1;
        }
    }
    Ok(ReplacePreview {
        matches,
        files,
        replacements,
    })
}

pub fn replace_in_project(
    root: &Path,
    query: &str,
    replacement: &str,
    paths: Option<Vec<String>>,
    match_case: bool,
    use_regex: bool,
) -> Result<ReplaceResult, String> {
    if query.is_empty() {
        return Err("Enter text to find.".to_string());
    }
    let matcher = ReplaceMatcher::new(query, match_case, use_regex)?;
    let targets = replace_targets(root, paths)?;
    let mut edits = Vec::new();
    let mut replacements = 0u32;
    for relative in targets {
        let path = safe_path(root, &relative)?;
        if !path.is_file() {
            continue;
        }
        let before = fs::read_to_string(&path).map_err(err)?;
        let (after, count) = matcher.replace_all(&before, replacement)?;
        if count == 0 {
            continue;
        }
        replacements += count;
        edits.push((relative, after));
    }
    if edits.is_empty() {
        return Ok(ReplaceResult {
            files_changed: Vec::new(),
            replacements: 0,
        });
    }
    let files_changed = edits.iter().map(|(path, _)| path.clone()).collect();
    let label = format!("Replace “{}”", query.chars().take(40).collect::<String>());
    apply_transaction(root, &label, edits)?;
    Ok(ReplaceResult {
        files_changed,
        replacements,
    })
}

struct ReplaceMatcher {
    query: String,
    match_case: bool,
    regex: Option<regex::Regex>,
}

impl ReplaceMatcher {
    fn new(query: &str, match_case: bool, use_regex: bool) -> Result<Self, String> {
        if use_regex {
            let mut builder = regex::RegexBuilder::new(query);
            builder.case_insensitive(!match_case);
            let regex = builder
                .build()
                .map_err(|error| format!("Invalid regular expression: {error}"))?;
            return Ok(Self {
                query: query.to_string(),
                match_case,
                regex: Some(regex),
            });
        }
        if query.is_empty() {
            return Err("Enter text to find.".to_string());
        }
        Ok(Self {
            query: query.to_string(),
            match_case,
            regex: None,
        })
    }

    fn find_in(&self, line: &str) -> Vec<(usize, usize)> {
        if let Some(regex) = &self.regex {
            return regex
                .find_iter(line)
                .map(|item| (item.start(), item.end().saturating_sub(item.start()).max(1)))
                .collect();
        }
        let mut hits = Vec::new();
        if self.match_case {
            let mut start = 0usize;
            while let Some(offset) = line[start..].find(&self.query) {
                let column = start + offset;
                hits.push((column, self.query.len().max(1)));
                start = column + self.query.len().max(1);
            }
            return hits;
        }
        let haystack = line.to_lowercase();
        let needle = self.query.to_lowercase();
        let mut start = 0usize;
        while let Some(offset) = haystack[start..].find(&needle) {
            let column = start + offset;
            hits.push((column, needle.len().max(1)));
            start = column + needle.len().max(1);
        }
        hits
    }

    fn replace_all(&self, source: &str, replacement: &str) -> Result<(String, u32), String> {
        if let Some(regex) = &self.regex {
            let count = regex.find_iter(source).count() as u32;
            if count == 0 {
                return Ok((source.to_string(), 0));
            }
            // NoExpand: `$` is a capture reference to the regex crate, so
            // replacing with `$n$` — ordinary maths — resolved `$n` to an
            // empty group and left a stray `$` behind in every file it
            // touched, reported as a success.
            return Ok((
                regex
                    .replace_all(source, regex::NoExpand(replacement))
                    .into_owned(),
                count,
            ));
        }
        if self.match_case {
            let count = source.matches(&self.query).count() as u32;
            if count == 0 {
                return Ok((source.to_string(), 0));
            }
            return Ok((source.replace(&self.query, replacement), count));
        }
        let hits = self.find_in(source);
        if hits.is_empty() {
            return Ok((source.to_string(), 0));
        }
        // Rebuild with case-insensitive literal replacements using byte offsets from find_in on full source.
        let mut out = String::with_capacity(source.len());
        let mut cursor = 0usize;
        let mut count = 0u32;
        for (start, len) in hits {
            if start < cursor {
                continue;
            }
            out.push_str(&source[cursor..start]);
            out.push_str(replacement);
            cursor = start + len;
            count += 1;
        }
        out.push_str(&source[cursor..]);
        Ok((out, count))
    }
}

fn collect_searchable_paths(nodes: &[FileNode], out: &mut Vec<String>) {
    for node in nodes {
        if node.kind == "directory" {
            collect_searchable_paths(&node.children, out);
            continue;
        }
        if searchable_text_path(&node.path) {
            out.push(node.path.clone());
        }
    }
}

pub fn delete_history(root: &Path, transaction_id: &str) -> Result<(), String> {
    fs::remove_file(transaction_path(root, transaction_id)?).map_err(err)?;
    // Only the newest record is memoized; deleting any other leaves it valid.
    let memoized = LATEST_HISTORY.lock().unwrap().get(root).cloned();
    if memoized.is_some_and(|(id, _)| id == transaction_id) {
        forget_latest_history(root);
    }
    Ok(())
}

pub fn get_history_entry(root: &Path, transaction_id: &str) -> Result<TransactionRecord, String> {
    let history_path = transaction_path(root, transaction_id)?;
    if !history_path.is_file() {
        return Err("That history entry no longer exists.".to_string());
    }
    let raw = fs::read_to_string(history_path).map_err(err)?;
    let mut record: TransactionRecord = serde_json::from_str(&raw).map_err(err)?;
    record.changes.retain(file_change_has_effect);
    Ok(record)
}

fn transaction_path(root: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    if transaction_id.is_empty()
        || transaction_id.contains('/')
        || transaction_id.contains('\\')
        || transaction_id == "."
        || transaction_id == ".."
    {
        return Err("Invalid transaction id.".to_string());
    }
    Ok(root
        .join(".research/history")
        .join(format!("{transaction_id}.json")))
}

fn persist_transaction(root: &Path, record: &TransactionRecord) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(record).map_err(err)?;
    ProjectDir::open(root)?.atomic_write(
        &format!(".research/history/{}.json", record.id),
        format!("{raw}\n").as_bytes(),
    )?;
    ProjectDir::open(root)?.prune_json_files(".research/history", MAX_HISTORY_ENTRIES)?;
    // Every caller builds the record via new_transaction (timestamp = now),
    // so it is by construction the newest; pruning only drops the oldest.
    remember_latest_history(root, record);
    Ok(())
}

#[cfg(any(test, not(unix)))]
pub(crate) fn prune_history(directory: &Path, limit: usize) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(err)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    let remove_count = entries.len().saturating_sub(limit);
    for path in entries.into_iter().take(remove_count) {
        fs::remove_file(path).map_err(err)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentKind {
    Text,
    Binary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabInventoryFile {
    pub path: String,
    pub content_kind: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabInventoryExclusion {
    pub path_or_pattern: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CollabProjectInventoryV2 {
    pub files: Vec<CollabInventoryFile>,
    pub excluded: Vec<CollabInventoryExclusion>,
}

fn classify_file_bytes(bytes: &[u8]) -> ContentKind {
    if bytes.contains(&0) {
        return ContentKind::Binary;
    }
    // Binary formats can have an ASCII-only prefix and no early NULs. Known
    // signatures keep routing content-based without trusting the extension.
    if bytes.starts_with(b"%PDF-")
        || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"\x7fELF")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
    {
        return ContentKind::Binary;
    }
    match std::str::from_utf8(bytes) {
        Ok(decoded) if decoded.as_bytes() == bytes => ContentKind::Text,
        _ => ContentKind::Binary,
    }
}

fn classify_regular_file(path: &Path) -> Result<ContentKind, String> {
    let metadata = fs::symlink_metadata(path).map_err(err)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CLASSIFIED_TEXT_BYTES {
        return Ok(ContentKind::Binary);
    }
    let bytes = fs::read(path).map_err(err)?;
    Ok(classify_file_bytes(&bytes))
}

/// (mtime, len) → kind memo consulted by `scan_files`. The frontend polls
/// `refresh_project` every 2 seconds, and classification is the only part of
/// the scan that reads file *contents* — without this memo the poll re-read
/// every byte of the project each tick. Content cannot change without the
/// metadata pair changing (`atomic_write` replaces the file, bumping mtime),
/// so a hit is safe to trust. Keyed on absolute path; wholesale-cleared past
/// the bound as a backstop rather than an LRU — the working set is one
/// project tree.
type ClassifyCacheEntry = (SystemTime, u64, ContentKind);
static CLASSIFY_CACHE: LazyLock<Mutex<HashMap<PathBuf, ClassifyCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const CLASSIFY_CACHE_MAX_ENTRIES: usize = 65_536;

fn classify_regular_file_cached(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<ContentKind, String> {
    let Ok(modified) = metadata.modified() else {
        return classify_regular_file(path);
    };
    let len = metadata.len();
    if let Some((cached_mtime, cached_len, kind)) = CLASSIFY_CACHE.lock().unwrap().get(path) {
        if *cached_mtime == modified && *cached_len == len {
            return Ok(*kind);
        }
    }
    let kind = classify_regular_file(path)?;
    let mut cache = CLASSIFY_CACHE.lock().unwrap();
    if cache.len() >= CLASSIFY_CACHE_MAX_ENTRIES {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), (modified, len, kind));
    Ok(kind)
}

fn exclusion_reason(relative: &Path, name: &str, path: &Path) -> Option<&'static str> {
    let normalized = relative.to_string_lossy().replace('\\', "/");
    if normalized == ".git" || normalized.starts_with(".git/") {
        return Some("git-internals");
    }
    if normalized == ".research" || normalized.starts_with(".research/") {
        return Some("app-private-state");
    }
    if matches!(
        name,
        ".DS_Store" | "Thumbs.db" | "desktop.ini" | ".Spotlight-V100" | ".Trashes"
    ) {
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

fn project_tree_exclusion_reason(relative: &Path, name: &str, path: &Path) -> Option<&'static str> {
    if let Some(reason) = exclusion_reason(relative, name, path) {
        return Some(reason);
    }
    let normalized = relative.to_string_lossy().replace('\\', "/");
    if normalized
        .split('/')
        .any(|segment| segment.starts_with('.'))
        || name == "opencode.json"
    {
        return Some("hidden-project-config");
    }
    None
}

fn scan_files_with_visibility(
    root: &Path,
    hide_project_config: bool,
) -> Result<Vec<FileNode>, String> {
    fn visit(
        root: &Path,
        directory: &Path,
        hide_project_config: bool,
    ) -> Result<Vec<FileNode>, String> {
        let mut nodes = Vec::new();
        for entry in fs::read_dir(directory).map_err(err)? {
            let entry = entry.map_err(err)?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let relative = path
                .strip_prefix(root)
                .map_err(err)?
                .to_string_lossy()
                .to_string();
            let excluded = if hide_project_config {
                project_tree_exclusion_reason(Path::new(&relative), &name, &path)
            } else {
                exclusion_reason(Path::new(&relative), &name, &path)
            };
            if excluded.is_some() {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(err)?;
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                nodes.push(FileNode {
                    name,
                    path: relative,
                    kind: "symlink".to_string(),
                    content_kind: "symlink".to_string(),
                    size: 0,
                    children: Vec::new(),
                });
            } else if file_type.is_dir() {
                let children = visit(root, &path, hide_project_config)?;
                nodes.push(FileNode {
                    name,
                    path: relative,
                    kind: "directory".to_string(),
                    content_kind: "directory".to_string(),
                    size: 0,
                    children,
                });
            } else if file_type.is_file() {
                let content_kind = classify_regular_file_cached(&path, &metadata)?;
                nodes.push(FileNode {
                    name,
                    path: relative,
                    kind: if content_kind == ContentKind::Text {
                        file_kind(&path).to_string()
                    } else if is_supported_asset(&path) {
                        "figure".to_string()
                    } else {
                        "binary".to_string()
                    },
                    content_kind: if content_kind == ContentKind::Text {
                        "text"
                    } else {
                        "binary"
                    }
                    .to_string(),
                    size: metadata.len(),
                    children: Vec::new(),
                });
            }
        }
        nodes.sort_by(|a, b| {
            let a_dir = a.kind == "directory";
            let b_dir = b.kind == "directory";
            b_dir
                .cmp(&a_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                // Case-colliding names can coexist on case-sensitive hosts.
                // Keep both and use raw name/path as deterministic tie-breaks.
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.path.cmp(&b.path))
        });
        Ok(nodes)
    }
    visit(root, root, hide_project_config)
}

fn scan_files(root: &Path) -> Result<Vec<FileNode>, String> {
    scan_files_with_visibility(root, false)
}

fn scan_project_tree(root: &Path) -> Result<Vec<FileNode>, String> {
    scan_files_with_visibility(root, true)
}

pub fn collab_project_inventory_v2(root: &Path) -> Result<CollabProjectInventoryV2, String> {
    let root = root.canonicalize().map_err(err)?;
    let mut files = Vec::new();
    let mut excluded = Vec::new();
    let walker = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let relative = entry.path().strip_prefix(&root).unwrap_or(entry.path());
            let normalized = relative.to_string_lossy().replace('\\', "/");
            // Paper markdown and its converter-owned assets are portable project
            // content. Traverse only this public branch of otherwise private
            // `.research` state so collaborators receive renderable papers.
            if normalized == ".research" || normalized == ".research/papers" {
                return true;
            }
            if normalized.starts_with(".research/papers/") {
                return !entry.file_name().to_string_lossy().starts_with(".fetch-");
            }
            exclusion_reason(relative, &entry.file_name().to_string_lossy(), entry.path()).is_none()
        });
    for entry in walker.filter_map(Result::ok).skip(1) {
        let path = entry.path();
        let relative = path.strip_prefix(&root).map_err(err)?;
        let normalized = relative.to_string_lossy().replace('\\', "/");
        let metadata = fs::symlink_metadata(path).map_err(err)?;
        if metadata.file_type().is_symlink() {
            excluded.push(CollabInventoryExclusion {
                path_or_pattern: normalized,
                reason: "symlink-not-followed".into(),
            });
            continue;
        }
        if metadata.is_file() {
            let kind = classify_regular_file(path)?;
            files.push(CollabInventoryFile {
                path: normalized,
                content_kind: if kind == ContentKind::Text {
                    "text"
                } else {
                    "binary"
                }
                .into(),
                size: metadata.len(),
            });
        }
    }
    for (pattern, reason) in [
        (".git/**", "git-internals"),
        (".research/** (except papers)", "app-private-state"),
        ("node_modules/**", "generated-directory"),
        ("target/**", "generated-directory"),
        ("dist/**", "generated-directory"),
        ("build/**", "generated-directory"),
    ] {
        let excluded_root = pattern
            .split_once("/**")
            .map_or(pattern, |(directory, _)| directory);
        if root.join(excluded_root).exists() {
            excluded.push(CollabInventoryExclusion {
                path_or_pattern: pattern.into(),
                reason: reason.into(),
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    excluded.sort_by(|a, b| a.path_or_pattern.cmp(&b.path_or_pattern));
    Ok(CollabProjectInventoryV2 { files, excluded })
}

fn file_kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("tex") => "tex",
        Some("bib") => "bib",
        Some("md") => "markdown",
        Some("tldr") => "tldr",
        Some("bst") => "text",
        Some("png" | "jpg" | "jpeg" | "pdf" | "svg" | "eps" | "webp") => "figure",
        _ => "text",
    }
}

/// Files a LaTeX run drops next to the source that nobody edits by hand.
///
/// Kept aligned with `overleaf::ARTIFACT_SUFFIXES`: a file the sync layer
/// refuses to upload should not sit in the tree pretending to be project
/// content. Matched against the whole file name rather than
/// [`Path::extension`], because the ones that used to leak through are not
/// single extensions — biblatex writes `main.run.xml`, and latexmk parks a run
/// it could not finish at `main.bbl-SAVE-ERROR` (its `$save_error_suffix`).
const BUILD_ARTIFACT_SUFFIXES: &[&str] = &[
    ".aux",
    ".bbl",
    ".bcf",
    ".blg",
    ".brf",
    ".dvi",
    ".fdb_latexmk",
    ".fls",
    // Broader than `.synctex.gz` on purpose: this is what the extension-based
    // check it replaced already hid, and narrowing it would surface archives
    // that no project has ever shown in the tree.
    ".gz",
    ".idx",
    ".ilg",
    ".ind",
    ".lof",
    ".log",
    ".lot",
    ".nav",
    ".out",
    ".run.xml",
    ".snm",
    ".synctex",
    ".toc",
    ".vrb",
    ".xdv",
];

fn is_build_artifact(path: &Path) -> bool {
    if path.extension().is_some_and(|ext| ext == "pdf") && path.with_extension("tex").exists() {
        return true;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let lowercased = name.to_ascii_lowercase();
    // latexmk renames instead of deleting whenever biber leaves behind a file
    // it cannot trust, so every suffix above has a `-SAVE-ERROR` twin.
    let stem = lowercased
        .strip_suffix("-save-error")
        .unwrap_or(&lowercased);
    BUILD_ARTIFACT_SUFFIXES
        .iter()
        .any(|suffix| stem.ends_with(suffix))
}

fn latex_title(name: &str) -> String {
    let ascii = name.chars().filter(char::is_ascii).collect::<String>();
    let title = match ascii.trim() {
        "" => "Untitled research",
        value => value,
    };
    title
        .chars()
        .map(|character| match character {
            '\\' => "\\textbackslash{}".to_string(),
            '{' => "\\{".to_string(),
            '}' => "\\}".to_string(),
            '$' => "\\$".to_string(),
            '&' => "\\&".to_string(),
            '#' => "\\#".to_string(),
            '_' => "\\_".to_string(),
            '%' => "\\%".to_string(),
            '~' => "\\~{}".to_string(),
            '^' => "\\^{}".to_string(),
            _ => character.to_string(),
        })
        .collect()
}

fn default_brief(name: &str) -> String {
    format!(
        "# {name}\n\n## Research question\n\nDescribe the central question.\n\n## Thesis\n\nState the current thesis.\n\n## Constraints\n\n- Write in English.\n- Ground factual claims in project evidence.\n\n## Open decisions\n\n- Add the first research decision.\n"
    )
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("research-writer-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn opening_a_folder_ignores_the_build_artifacts_it_will_recompile() {
        let parent = temp_root("adopted-ignores");
        let root = parent.join("imported");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("main.tex"), "\\documentclass{article}\n").unwrap();
        // What an Overleaf import arrives with: a .gitignore that knows nothing
        // about LaTeX. Version tracking starts here, so without these lines the
        // first commit adopts the artifacts and every later build dirties them.
        fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();

        open(&root).unwrap();

        let ignore = fs::read_to_string(root.join(".gitignore")).unwrap();
        for line in [
            "*.aux",
            "*.log",
            "*.fls",
            "*.fdb_latexmk",
            "*.run.xml",
            "*-SAVE-ERROR",
        ] {
            assert!(
                ignore.lines().any(|existing| existing.trim() == line),
                "{line} missing from {ignore}"
            );
        }
        // Whatever the folder already ignored is still ignored.
        assert!(ignore
            .lines()
            .any(|existing| existing.trim() == "node_modules/"));

        // Opening twice must not append a second copy of the same rules.
        open(&root).unwrap();
        let reopened = fs::read_to_string(root.join(".gitignore")).unwrap();
        assert_eq!(reopened, ignore);
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn opening_a_folder_without_latex_claims_no_root_document() {
        let parent = temp_root("markdown-only");
        let root = parent.join("notes");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("ideas.md"), "# Ideas\n").unwrap();
        fs::write(root.join("log.md"), "# Log\n").unwrap();

        let snapshot = open(&root).unwrap();
        // Naming main.tex here invented a document that does not exist, and the
        // app opened onto "Root document not found: main.tex" for a folder that
        // simply has nothing to compile.
        assert!(
            snapshot.manifest.root_documents.is_empty(),
            "a folder with no .tex has no root document: {:?}",
            snapshot.manifest.root_documents,
        );

        // Adding LaTeX later is still detected on the next open.
        fs::write(
            root.join("paper.tex"),
            "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n",
        )
        .unwrap();
        fs::remove_file(root.join(MANIFEST_PATH)).unwrap();
        let reopened = open(&root).unwrap();
        assert_eq!(
            reopened
                .manifest
                .root_documents
                .first()
                .map(|d| d.path.as_str()),
            Some("paper.tex"),
        );

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn the_open_file_wins_the_compile_when_it_is_a_root() {
        let parent = temp_root("compile-root");
        let root = parent.join("papers");
        fs::create_dir_all(root.join("chapters")).unwrap();
        fs::write(
            root.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n",
        )
        .unwrap();
        fs::write(
            root.join("second.tex"),
            "\\documentclass{article}\n\\begin{document}\nB\n\\end{document}\n",
        )
        .unwrap();
        fs::write(root.join("chapters/intro.tex"), "\\section{Intro}\n").unwrap();
        open(&root).unwrap();

        // The open file declares a document class: it is the compile target.
        assert_eq!(
            resolve_compile_root(&root, "second.tex").as_deref(),
            Some("second.tex")
        );
        // A chapter casts no vote; the manifest default stands.
        assert_eq!(resolve_compile_root(&root, "chapters/intro.tex"), None);
        // Non-.tex files never vote.
        assert_eq!(resolve_compile_root(&root, "notes.md"), None);

        // A commented-out preamble does not turn a chapter into a root.
        fs::write(
            root.join("chapters/outro.tex"),
            "% \\documentclass{article}\ntext\n",
        )
        .unwrap();
        assert_eq!(resolve_compile_root(&root, "chapters/outro.tex"), None);

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn a_magic_root_comment_resolves_relative_to_the_file_that_declares_it() {
        let parent = temp_root("magic-root");
        let root = parent.join("papers");
        fs::create_dir_all(root.join("chapters")).unwrap();
        fs::write(
            root.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\input{chapters/one}\n\\end{document}\n",
        )
        .unwrap();
        // `../main.tex` is the TeX convention: relative to the declaring file.
        // `safe_path` alone refuses `..`, which is why this needs its own test.
        fs::write(
            root.join("chapters/one.tex"),
            "% !TEX root = ../main.tex\n\\section{One}\n",
        )
        .unwrap();

        assert_eq!(
            resolve_compile_root(&root, "chapters/one.tex").as_deref(),
            Some("main.tex")
        );

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn set_compile_root_upserts_and_switches_the_default() {
        let parent = temp_root("set-compile-root");
        let root = parent.join("papers");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n",
        )
        .unwrap();
        fs::write(
            root.join("second.tex"),
            "\\documentclass{article}\n\\begin{document}\nB\n\\end{document}\n",
        )
        .unwrap();
        open(&root).unwrap();

        let manifest = set_compile_root(&root, "second.tex").unwrap();
        assert_eq!(manifest.root_documents.len(), 2);
        assert!(manifest
            .root_documents
            .iter()
            .any(|document| document.path == "second.tex" && document.is_default));
        assert!(manifest
            .root_documents
            .iter()
            .any(|document| document.path == "main.tex" && !document.is_default));
        // Written down, not just returned: the next read agrees.
        let reread = read_manifest(&root).unwrap();
        assert!(reread
            .root_documents
            .iter()
            .any(|document| document.path == "second.tex" && document.is_default));

        // Re-recording the current default neither duplicates nor reorders.
        let again = set_compile_root(&root, "second.tex").unwrap();
        assert_eq!(again.root_documents.len(), 2);

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn reopening_retires_a_root_document_that_was_never_there() {
        let parent = temp_root("stale-root");
        let root = parent.join("notes");
        fs::create_dir_all(root.join(".research")).unwrap();
        fs::write(root.join("big.md"), "# Notes\n").unwrap();
        // What every Markdown folder opened before the fix carries: a root
        // document the app named for it, pointing at a file that never existed.
        let mut stale = default_manifest("notes");
        stale.root_documents[0].path = "main.tex".to_string();
        write_manifest(&root, &stale).unwrap();

        let snapshot = open(&root).unwrap();
        assert!(
            snapshot.manifest.root_documents.is_empty(),
            "the invented root should be retired: {:?}",
            snapshot.manifest.root_documents,
        );
        // And the correction is written down, not recomputed on every open.
        assert!(read_manifest(&root).unwrap().root_documents.is_empty());

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn reopening_keeps_a_root_document_that_is_only_missing_right_now() {
        let parent = temp_root("absent-root");
        let root = parent.join("paper");
        fs::create_dir_all(root.join(".research")).unwrap();
        // A .tex exists, so the named root is a setting worth keeping even
        // though that particular file is not on disk at this moment.
        fs::write(root.join("chapter.tex"), "\\section{One}\n").unwrap();
        let mut manifest = default_manifest("paper");
        manifest.root_documents[0].path = "main.tex".to_string();
        write_manifest(&root, &manifest).unwrap();

        let snapshot = open(&root).unwrap();
        assert_eq!(
            snapshot
                .manifest
                .root_documents
                .first()
                .map(|d| d.path.as_str()),
            Some("main.tex"),
            "a temporarily absent root is still the project's",
        );

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn tutorial_project_is_complete_and_resets_on_reopen() {
        let parent = temp_root("tutorial-project");
        let root = create_tutorial(&parent).unwrap();
        assert!(root.join("main.tex").is_file());
        assert!(root.join("notes.md").is_file());
        assert!(root.join("attention-demo.html").is_file());
        assert!(root.join("attention-map.tldr").is_file());
        let board: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("attention-map.tldr")).unwrap()).unwrap();
        assert_eq!(board["tldrawFileFormatVersion"], 1);
        let board_records = board["records"].as_array().unwrap();
        assert!(board_records.len() >= 18);
        assert!(board_records
            .iter()
            .any(|record| record["id"] == "shape:query"));
        assert!(board_records
            .iter()
            .any(|record| record["id"] == "shape:context"));
        assert!(root.join("project.toml").is_file());
        assert!(root.join("references.bib").is_file());
        assert!(root.join("neurips.sty").is_file());
        assert!(root
            .join("figures/scaled-dot-product-attention.png")
            .is_file());
        assert!(root.join("figures/multi-head-attention.png").is_file());
        assert!(root.join("figures/attention-figure-2.pdf").is_file());
        assert!(root.join("figures/ATTRIBUTION.md").is_file());
        assert!(root.join(".research/tutorial.json").is_file());
        assert_eq!(read_manifest(&root).unwrap().venue, "tutorial");
        assert!(fs::read_to_string(root.join("main.tex"))
            .unwrap()
            .contains("\\usepackage[preprint]{neurips}"));
        assert_eq!(
            fs::read_to_string(root.join("references.bib"))
                .unwrap()
                .matches("@")
                .count(),
            9
        );

        fs::write(root.join("notes.md"), "learner edit\n").unwrap();
        fs::write(root.join("learner-file.txt"), "temporary\n").unwrap();
        assert_eq!(create_tutorial(&parent).unwrap(), root);
        assert_eq!(
            fs::read_to_string(root.join("notes.md")).unwrap(),
            TUTORIAL_NOTES
        );
        assert!(!root.join("learner-file.txt").exists());
        assert!(fs::read(root.join("figures/attention-figure-2.pdf"))
            .unwrap()
            .starts_with(b"%PDF-1.3"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn tutorial_reset_refuses_to_delete_an_unmanaged_folder() {
        let parent = temp_root("tutorial-reset-guard");
        let root = parent.join(TUTORIAL_PROJECT_NAME);
        fs::create_dir_all(root.join(".research")).unwrap();
        fs::write(
            root.join(".research/tutorial.json"),
            "{\"id\":\"someone-else\"}",
        )
        .unwrap();
        fs::write(root.join("keep.txt"), "keep\n").unwrap();

        assert!(create_tutorial(&parent).is_err());
        assert_eq!(fs::read_to_string(root.join("keep.txt")).unwrap(), "keep\n");
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn rejects_parent_traversal() {
        let root = temp_root("safe-path");
        assert!(safe_path(&root, "../secret.txt").is_err());
        assert!(!root.join("missing").exists());
        assert!(safe_path(&root, "missing/file.txt").is_err());
        assert!(!root.join("missing").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inventory_classifies_content_without_extension_and_hides_project_config() {
        let root = temp_root("inventory-content");
        fs::write(root.join("README"), b"plain utf-8\r\n").unwrap();
        fs::write(root.join("known.bin"), b"still text\n").unwrap();
        fs::write(root.join(".env.example"), b"SAFE=value\n").unwrap();
        fs::write(root.join(".okignore"), b"private\n").unwrap();
        fs::write(root.join("opencode.json"), b"{}\n").unwrap();
        fs::write(root.join("bom.txt"), b"\xef\xbb\xbfhello\r\n").unwrap();
        fs::write(root.join("nul.txt"), b"hello\0world").unwrap();
        fs::write(root.join("unknown.dat"), [0xff, 0xfe, 0x01]).unwrap();
        fs::create_dir_all(root.join(".ok/local")).unwrap();
        fs::write(root.join(".ok/config.yml"), b"title: hidden\n").unwrap();
        fs::create_dir_all(root.join(".pi/extensions")).unwrap();
        fs::write(root.join(".pi/extensions/open-knowledge.ts"), b"hidden\n").unwrap();
        fs::create_dir_all(root.join(".research/cache")).unwrap();
        fs::write(root.join(".research/cache/private"), b"private").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/generated.js"), b"generated").unwrap();

        let files = scan_files(&root).unwrap();
        let node = |path: &str| files.iter().find(|node| node.path == path).unwrap();
        for path in [
            "README",
            "known.bin",
            ".env.example",
            ".okignore",
            "opencode.json",
            "bom.txt",
        ] {
            assert_eq!(node(path).content_kind, "text", "{path}");
        }
        for path in ["nul.txt", "unknown.dat"] {
            assert_eq!(node(path).content_kind, "binary", "{path}");
        }
        let project_tree = scan_project_tree(&root).unwrap();
        for hidden in [
            ".env.example",
            ".okignore",
            ".ok",
            ".pi",
            ".research",
            "opencode.json",
        ] {
            assert!(
                !project_tree.iter().any(|node| node.path == hidden),
                "{hidden}"
            );
        }
        assert!(!files.iter().any(|node| node.path == "node_modules"));
        assert_eq!(
            read_file(&root, "bom.txt").unwrap().as_bytes(),
            b"\xef\xbb\xbfhello\r\n"
        );
        assert!(read_file(&root, "nul.txt").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn collaboration_inventory_includes_paper_bundles_but_not_other_research_state() {
        let root = temp_root("inventory-papers");
        fs::create_dir_all(root.join(".research/papers/2401.00001/paper_assets")).unwrap();
        fs::write(
            root.join(".research/papers/2401.00001/paper.md"),
            b"# Paper\n",
        )
        .unwrap();
        fs::write(
            root.join(".research/papers/2401.00001/paper_assets/figure.png"),
            b"\x89PNG\r\n\x1a\n",
        )
        .unwrap();
        fs::create_dir_all(root.join(".research/history")).unwrap();
        fs::write(root.join(".research/history/private.json"), b"{}").unwrap();

        let inventory = collab_project_inventory_v2(&root).unwrap();
        let paths = inventory
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&".research/papers/2401.00001/paper.md"));
        assert!(paths.contains(&".research/papers/2401.00001/paper_assets/figure.png"));
        assert!(!paths.iter().any(|path| path.contains("history")));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_visible_but_never_followed() {
        use std::os::unix::fs::symlink;
        let root = temp_root("inventory-links");
        let outside = temp_root("inventory-links-outside");
        fs::write(outside.join("secret"), b"secret").unwrap();
        symlink(outside.join("secret"), root.join("outside-link")).unwrap();
        symlink(&outside, root.join("outside-directory")).unwrap();
        let files = scan_files(&root).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|node| node.content_kind == "symlink"));
        assert!(read_file(&root, "outside-link").is_err());
        assert!(creation_path(&root, "outside-directory/new").is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn materialization_index_round_trips_atomically_under_private_cache() {
        let root = temp_root("materialization-index");
        let mut files = BTreeMap::new();
        files.insert(
            "file-id-1".to_string(),
            MaterializedFile {
                path: "notes/README".to_string(),
                document_epoch: 3,
                applied_revision: 7,
                durable_revision: 6,
                content_sha256: "abc123".to_string(),
            },
        );
        let index = MaterializationIndex {
            schema_version: 1,
            files,
        };
        write_materialization_index(&root, &index).unwrap();
        assert_eq!(read_materialization_index(&root).unwrap(), index);
        assert!(root.join(MATERIALIZATION_INDEX_PATH).is_file());
        assert!(scan_files(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_a_bib_entry_span_by_key_case_insensitively() {
        let bib = "@misc{one, title = {A}}\n\n@inproceedings{Two, booktitle = {B}}\n";
        let (start, end) = bib_entry_span(bib, "TWO").unwrap();
        assert_eq!(&bib[start..end], "@inproceedings{Two, booktitle = {B}}");
        assert!(bib_entry_span(bib, "missing").is_none());
        // A nested brace in a value must not end the entry early.
        let nested = "@article{k, title = {Deep {Nets}}, year = {2020}}\n";
        let (s, e) = bib_entry_span(nested, "k").unwrap();
        assert_eq!(&nested[s..e], nested.trim_end());
    }

    #[test]
    fn resolves_a_bbl_click_to_the_bibitem_key() {
        let bbl = "\\begin{thebibliography}{1}\n\
                   \\bibitem[Smith(2020)]{smith2020}\n\
                   J. Smith. A great paper. 2020.\n\
                   \\bibitem{jones2021}\n\
                   K. Jones. Another one. 2021.\n\
                   \\end{thebibliography}\n";
        // Line 3 falls under the first \bibitem (natbib optional label form).
        assert_eq!(bibitem_key_at(bbl, 3).as_deref(), Some("smith2020"));
        // Clicking the \bibitem line itself resolves too.
        assert_eq!(bibitem_key_at(bbl, 4).as_deref(), Some("jones2021"));
        assert_eq!(bibitem_key_at(bbl, 5).as_deref(), Some("jones2021"));
        // Before any \bibitem there is no key.
        assert_eq!(bibitem_key_at(bbl, 1), None);
    }

    #[test]
    fn finds_the_bib_line_for_a_key() {
        let bib = "% a comment\n\
                   @article{smith2020,\n  title = {A},\n}\n\
                   @inproceedings{Jones2021,\n  booktitle = {B},\n}\n";
        assert_eq!(bib_entry_line(bib, "smith2020"), Some(2));
        // Case-insensitive key match.
        assert_eq!(bib_entry_line(bib, "jones2021"), Some(5));
        assert_eq!(bib_entry_line(bib, "missing"), None);
    }

    #[test]
    fn finds_the_bib_key_governing_a_cursor_line() {
        let bib = "% a comment\n\
                   @article{smith2020,\n  title = {A},\n  year = {2020},\n}\n\n\
                   @inproceedings(\n  Jones2021,\n  title = \"Another paper\",\n)\n";
        assert_eq!(bib_entry_key_at(bib, 3).as_deref(), Some("smith2020"));
        assert_eq!(bib_entry_key_at(bib, 8).as_deref(), Some("Jones2021"));
        assert_eq!(bib_entry_key_at(bib, 6), None);
    }

    #[test]
    fn resolves_a_bib_cursor_to_its_generated_bibitem() {
        let parent = temp_root("bib-forward-sync-parent");
        let root = create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{smith2020,\n  title = {A},\n  year = {2020},\n}\n",
        )
        .unwrap();
        fs::write(
            root.join("main.bbl"),
            "\\begin{thebibliography}{1}\n\
             \\bibitem[Smith(2020)]{smith2020}\n\
             J. Smith. A. 2020.\n\
             \\end{thebibliography}\n",
        )
        .unwrap();

        let target =
            bbl_target_for_bib(&root, Path::new("references.bib"), Path::new("main.bbl"), 3)
                .unwrap()
                .unwrap();
        assert_eq!(target.path, "main.bbl");
        assert_eq!(target.line, 2);
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn reads_and_replaces_one_entry_in_place() {
        let parent = temp_root("bib-edit-parent");
        let root = create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@misc{keep, title = {Keep Me}, year = {2019}}\n\n\
             @misc{vaswani2017, title = {Attention}, howpublished = {arXiv preprint arXiv:1706.03762}, year = {2017}}\n",
        )
        .unwrap();

        let entry = read_bib_entry(&root, "vaswani2017").unwrap().unwrap();
        assert_eq!(entry.entry_type, "misc");
        assert_eq!(entry.title, "Attention");
        assert!(read_bib_entry(&root, "nope").unwrap().is_none());

        save_bib_entry(
            &root,
            "vaswani2017",
            "@inproceedings{vaswani2017, title = {Attention Is All You Need}, booktitle = {NeurIPS}, year = {2017}}",
        )
        .unwrap();

        let updated = fs::read_to_string(root.join("references.bib")).unwrap();
        assert!(updated.contains("@inproceedings{vaswani2017"));
        assert!(updated.contains("booktitle = {NeurIPS}"));
        assert!(!updated.contains("@misc{vaswani2017"));
        // The sibling entry is untouched.
        assert!(updated.contains("@misc{keep, title = {Keep Me}"));

        let reread = read_bib_entry(&root, "vaswani2017").unwrap().unwrap();
        assert_eq!(reread.entry_type, "inproceedings");
        assert_eq!(reread.booktitle, "NeurIPS");
        let history = history(&root).unwrap();
        assert_eq!(history[0].actor, "citation");
        assert_eq!(history[0].kind, "citation");
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn transaction_can_be_reverted() {
        let root = temp_root("transaction");
        fs::create_dir_all(root.join(".research/history")).unwrap();
        fs::write(root.join("main.tex"), "before").unwrap();
        let transaction = apply_transaction(
            &root,
            "edit",
            vec![("main.tex".to_string(), "after".to_string())],
        )
        .unwrap()
        .unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "after");
        let restore = revert(&root, &transaction.id).unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "before");
        let items = history(&root).unwrap();
        assert_eq!(items.len(), 2);
        assert!(transaction_path(&root, &transaction.id).unwrap().exists());
        assert_eq!(restore.undo_of.as_deref(), Some(transaction.id.as_str()));
        assert_eq!(restore.kind.as_deref(), Some("restore"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn transaction_rolls_back_files_written_before_a_later_write_fails() {
        use std::os::unix::fs::symlink;

        let root = temp_root("transaction-rollback");
        let outside = temp_root("transaction-rollback-outside");
        fs::write(root.join("first.tex"), "first before").unwrap();
        fs::write(outside.join("second.tex"), "second before").unwrap();
        symlink(outside.join("second.tex"), root.join("second.tex")).unwrap();

        let result = apply_transaction(
            &root,
            "Edit two files",
            vec![
                ("first.tex".to_string(), "first after".to_string()),
                ("second.tex".to_string(), "second after".to_string()),
            ],
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(root.join("first.tex")).unwrap(),
            "first before"
        );
        assert_eq!(
            fs::read_to_string(outside.join("second.tex")).unwrap(),
            "second before"
        );
        assert!(history(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn external_agent_edits_are_recorded_and_reverted() {
        let root = temp_root("external-transaction");
        fs::create_dir_all(root.join(".research/history")).unwrap();
        fs::write(root.join("main.tex"), "before").unwrap();
        fs::write(root.join("removed.tex"), "remove me").unwrap();
        let before = snapshot_text_files(&root).unwrap();
        fs::write(root.join("main.tex"), "after").unwrap();
        fs::write(root.join("created.tex"), "new").unwrap();
        fs::remove_file(root.join("removed.tex")).unwrap();

        let transaction = record_agent_changes(&root, &before, "Agent edit", "thread-1")
            .unwrap()
            .unwrap();
        assert_eq!(transaction.changes.len(), 3);
        let restore = revert(&root, &transaction.id).unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "before");
        assert_eq!(
            fs::read_to_string(root.join("removed.tex")).unwrap(),
            "remove me"
        );
        assert!(!root.join("created.tex").exists());
        assert_eq!(restore.undo_of.as_deref(), Some(transaction.id.as_str()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_restore_refuses_to_overwrite_newer_file_changes() {
        let root = temp_root("history-conflict");
        fs::create_dir_all(root.join(".research/history")).unwrap();
        fs::write(root.join("main.tex"), "before").unwrap();
        let transaction = apply_transaction(
            &root,
            "Edit main.tex",
            vec![("main.tex".to_string(), "after".to_string())],
        )
        .unwrap()
        .unwrap();
        fs::write(root.join("main.tex"), "newer").unwrap();

        let error = revert(&root, &transaction.id).unwrap_err();

        assert!(error.contains("changed after this history entry"));
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "newer");
        assert_eq!(history(&root).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_history_records_receive_semantic_metadata_without_rewriting_them() {
        let root = temp_root("legacy-history-metadata");
        let directory = root.join(".research/history");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("legacy.json"),
            r#"{
  "id": "legacy",
  "label": "Agent: revise the abstract",
  "timestamp": "2026-07-29T12:00:00Z",
  "changes": [{"path":"main.tex","before":"old","after":"new"}]
}
"#,
        )
        .unwrap();

        let items = history(&root).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].actor, "agent");
        assert_eq!(items[0].kind, "agent");
        assert_eq!(items[0].source, "agent");
        assert_eq!(
            get_history_entry(&root, "legacy").unwrap().schema_version,
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conversation_checkpoint_restores_files_and_records_the_restore() {
        let root = temp_root("conversation-checkpoint");
        fs::write(root.join("main.tex"), "before").unwrap();
        let session_id = Uuid::new_v4().to_string();
        let message_id = Uuid::new_v4().to_string();
        save_conversation_checkpoint(&root, &session_id, &message_id).unwrap();
        apply_transaction(
            &root,
            "agent edit",
            vec![("main.tex".to_string(), "after".to_string())],
        )
        .unwrap();
        let restored = restore_conversation_checkpoint(&root, &session_id, &message_id, None)
            .unwrap()
            .unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "before");
        assert_eq!(restored.label, "Restore files for conversation branch");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conversation_checkpoints_are_pruned_by_session_and_total_size() {
        let root = temp_root("conversation-checkpoint-limit");
        let checkpoints = root.join(".research/checkpoints");
        let first = checkpoints.join(Uuid::new_v4().to_string());
        let second = checkpoints.join(Uuid::new_v4().to_string());
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        for directory in [&first, &second] {
            for _ in 0..4 {
                fs::write(
                    directory.join(format!("{}.json", Uuid::new_v4())),
                    "0123456789",
                )
                .unwrap();
            }
        }

        prune_conversation_checkpoints(&root, 2, 30, None, None).unwrap();

        let remaining = WalkDir::new(&checkpoints)
            .into_iter()
            .flatten()
            .filter(|entry| entry.file_type().is_file())
            .count();
        assert_eq!(remaining, 3);
        assert!(fs::read_dir(first).unwrap().count() <= 2);
        assert!(fs::read_dir(second).unwrap().count() <= 2);

        let protected = fs::read_dir(&checkpoints)
            .unwrap()
            .flatten()
            .flat_map(|session| fs::read_dir(session.path()).unwrap().flatten())
            .map(|entry| entry.path())
            .next()
            .unwrap();
        prune_conversation_checkpoints(&root, 0, 0, Some(&protected), None).unwrap();
        assert!(!protected.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saving_a_checkpoint_reserves_the_new_session_slot_before_rename() {
        let root = temp_root("conversation-checkpoint-reserved-slot");
        fs::write(root.join("main.tex"), "content").unwrap();
        let session_id = Uuid::new_v4().to_string();
        let directory = root.join(".research/checkpoints").join(&session_id);
        fs::create_dir_all(&directory).unwrap();
        for _ in 0..MAX_CHECKPOINTS_PER_SESSION {
            fs::write(directory.join(format!("{}.json", Uuid::new_v4())), "{}\n").unwrap();
        }

        save_conversation_checkpoint(&root, &session_id, &Uuid::new_v4().to_string()).unwrap();

        assert_eq!(
            fs::read_dir(directory).unwrap().count(),
            MAX_CHECKPOINTS_PER_SESSION
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_conversation_checkpoint_is_reconstructed_from_history() {
        let root = temp_root("legacy-conversation-checkpoint");
        fs::write(root.join("main.tex"), "before").unwrap();
        let target_timestamp = Utc::now().to_rfc3339();
        std::thread::sleep(std::time::Duration::from_millis(2));
        apply_transaction(
            &root,
            "agent edit",
            vec![("main.tex".to_string(), "after".to_string())],
        )
        .unwrap();
        restore_conversation_checkpoint(
            &root,
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
            Some(&target_timestamp),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "before");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_entries_can_be_deleted_without_changing_files() {
        let root = temp_root("delete-history");
        fs::create_dir_all(root.join(".research/history")).unwrap();
        fs::write(root.join("main.tex"), "before").unwrap();
        let transaction = apply_transaction(
            &root,
            "edit",
            vec![("main.tex".to_string(), "after".to_string())],
        )
        .unwrap()
        .unwrap();
        delete_history(&root, &transaction.id).unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "after");
        assert!(history(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_history_keeps_only_the_newest_entries() {
        let root = temp_root("history-limit");
        let directory = root.join(".research/history");
        fs::create_dir_all(&directory).unwrap();
        for index in 0..5 {
            fs::write(directory.join(format!("{index:02}.json")), "{}\n").unwrap();
        }

        prune_history(&directory, 3).unwrap();

        let mut remaining = fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        remaining.sort();
        assert_eq!(remaining, vec!["02.json", "03.json", "04.json"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compiled_pdfs_are_hidden_from_the_source_tree() {
        let root = temp_root("compiled-pdf");
        fs::write(root.join("main.tex"), "source").unwrap();
        fs::write(root.join("main.pdf"), b"%PDF-binary").unwrap();
        fs::write(root.join("reading.pdf"), b"%PDF-binary").unwrap();
        let files = scan_files(&root).unwrap();
        assert!(files.iter().any(|file| file.path == "main.tex"));
        assert!(!files.iter().any(|file| file.path == "main.pdf"));
        assert!(files.iter().any(|file| file.path == "reading.pdf"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn biber_and_latexmk_leftovers_are_hidden_from_the_source_tree() {
        let root = temp_root("biber-artifacts");
        fs::write(root.join("main.tex"), "source").unwrap();
        fs::write(root.join("references.bib"), "@article{a,}").unwrap();
        // biblatex writes these two on every single build.
        fs::write(root.join("main.bcf"), "<control/>").unwrap();
        fs::write(root.join("main.run.xml"), "<requests/>").unwrap();
        // latexmk saves rather than deletes what it cannot trust.
        fs::write(root.join("main.bbl-SAVE-ERROR"), "stale").unwrap();
        fs::write(root.join("main.toc"), "contents").unwrap();
        // A .bib is not an artifact, and neither is an .xml a human wrote.
        fs::write(root.join("data.xml"), "<rows/>").unwrap();

        let files = scan_files(&root).unwrap();
        let visible = files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(visible, vec!["data.xml", "main.tex", "references.bib"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renaming_a_source_removes_its_biber_leftovers() {
        let root = temp_root("biber-artifact-cleanup");
        fs::write(root.join("main.tex"), "source").unwrap();
        fs::write(root.join("main.bcf"), "<control/>").unwrap();
        fs::write(root.join("main.run.xml"), "<requests/>").unwrap();
        fs::write(root.join("main.bbl-SAVE-ERROR"), "stale").unwrap();
        // Same stem, not an artifact: renaming a source must not eat it.
        fs::write(root.join("main.gz"), b"archive").unwrap();

        remove_tex_build_artifacts(&root, "main.tex").unwrap();

        assert!(!root.join("main.bcf").exists());
        assert!(!root.join("main.run.xml").exists());
        assert!(!root.join("main.bbl-SAVE-ERROR").exists());
        assert!(root.join("main.gz").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bibliography_entries_are_parsed_for_editor_completion_and_hover() {
        let parent = temp_root("citation-keys");
        let root = create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{vaswani2017attention,\n  title={Attention {Is} All You Need},\n  author={Vaswani, Ashish and Shazeer, Noam},\n  year={2017},\n  journal={NeurIPS}\n}\n@inproceedings{dosovitskiy2021image,\n}\n",
        )
        .unwrap();
        assert_eq!(
            citation_keys(&root).unwrap(),
            vec!["dosovitskiy2021image", "vaswani2017attention"]
        );
        let entries = citations(&root).unwrap();
        assert_eq!(entries[1].title, "Attention Is All You Need");
        assert_eq!(entries[1].authors, "Vaswani, Ashish and Shazeer, Noam");
        assert_eq!(entries[1].year, "2017");
        assert_eq!(entries[1].venue, "NeurIPS");
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn latex_labels_are_indexed_for_reference_hover_previews() {
        let parent = temp_root("latex-reference-previews");
        let root = create(&parent, "paper").unwrap();
        fs::write(root.join("figures/model.png"), b"png-bytes").unwrap();
        fs::write(
            root.join("main.tex"),
            r#"\section{Introduction}\label{sec:intro}
\begin{figure}
  \includegraphics[width=\linewidth]{\detokenize{figures/model.png}}
  \caption{Our model architecture}
  \label{fig:model}
\end{figure}
\begin{table}
  \caption{Main benchmark results}
  \begin{tabular}{lc}
  Method & Score \\
  Ours & 90
  \end{tabular}
  \label{tab:results}
\end{table}
\begin{equation}
  \mathcal{L} = \lVert x - y \rVert_2
  \label{eq:loss}
\end{equation}
"#,
        )
        .unwrap();

        let indexed = references(&root).unwrap();
        let figure = indexed
            .iter()
            .find(|item| item.label == "fig:model")
            .unwrap();
        assert_eq!(figure.kind, "figure");
        assert_eq!(figure.title, "Our model architecture");
        assert_eq!(figure.image_path.as_deref(), Some("figures/model.png"));
        let table = indexed
            .iter()
            .find(|item| item.label == "tab:results")
            .unwrap();
        assert_eq!(table.kind, "table");
        assert!(table.snippet.contains("Method & Score"));
        assert_eq!(
            indexed
                .iter()
                .find(|item| item.label == "eq:loss")
                .unwrap()
                .kind,
            "equation"
        );
        let section = indexed
            .iter()
            .find(|item| item.label == "sec:intro")
            .unwrap();
        assert_eq!(section.kind, "section");
        assert_eq!(section.title, "Introduction");
        assert_eq!(section.line, 1);
        assert_eq!(figure.line, 5);
        assert_eq!(table.line, 13);
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn history_entries_can_be_loaded_with_file_snapshots() {
        let parent = temp_root("history-entry");
        let root = create(&parent, "paper").unwrap();
        let before = fs::read_to_string(root.join("main.tex")).unwrap();
        apply_transaction(
            &root,
            "Edit main.tex",
            vec![("main.tex".to_string(), format!("{before}\n% edited\n"))],
        )
        .unwrap();
        let items = history(&root).unwrap();
        assert_eq!(items.len(), 1);
        let entry = get_history_entry(&root, &items[0].id).unwrap();
        assert_eq!(entry.label, "Edit main.tex");
        assert_eq!(entry.changes[0].before.as_deref(), Some(before.as_str()));
        assert!(entry.changes[0]
            .after
            .as_deref()
            .unwrap()
            .contains("% edited"));
        assert!(get_history_entry(&root, "../escape").is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn project_search_matches_file_paths_and_contents() {
        let root = temp_root("project-search");
        create(&root, "searchable").unwrap();
        let project = root.join("searchable");
        create_entry(&project, "sections/method.tex", "file").unwrap();
        fs::write(
            project.join("sections/method.tex"),
            "A distinctive latent alignment objective.\n",
        )
        .unwrap();

        let content_results = search_files(&project, "latent alignment").unwrap();
        assert_eq!(content_results[0].path, "sections/method.tex");
        assert!(content_results[0].snippet.contains("distinctive latent"));
        assert_eq!(
            search_files(&project, "method.tex").unwrap()[0].path,
            "sections/method.tex"
        );
        assert_eq!(
            search_files(&project, "method tex").unwrap()[0].path,
            "sections/method.tex"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn linear_project_search_excludes_hidden_paths_and_html_source() {
        let root = temp_root("linear-project-search-scope");
        fs::write(
            root.join("page.html"),
            "<html><head><title>hidden_head_token</title></head><body><p>visible_body_token</p><script>hidden_script_token</script></body></html>\n",
        )
        .unwrap();
        fs::write(root.join(".private.md"), "hidden_notes_token\n").unwrap();

        let visible = search_files_linear(&root, "visible body token").unwrap();
        assert_eq!(visible.len(), 1, "got: {visible:?}");
        assert_eq!(visible[0].path, "page.html");
        for excluded in [
            "hidden head token",
            "hidden script token",
            "hidden notes token",
        ] {
            assert!(
                search_files_linear(&root, excluded).unwrap().is_empty(),
                "unexpected search result for {excluded}"
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_todos_finds_comment_and_macro_markers() {
        let parent = temp_root("todos");
        let root = create(&parent, "paper").unwrap();
        fs::create_dir_all(root.join("sections")).unwrap();
        fs::write(
            root.join("sections/method.tex"),
            "Intro\n% TODO rewrite claim\n\\todo{add figure}\n% FIXME citation\n",
        )
        .unwrap();
        fs::write(root.join("notes.md"), "# Notes\n% XXX temp\n").unwrap();
        let hits = list_todos(&root).unwrap();
        assert!(hits
            .iter()
            .any(|hit| hit.kind == "TODO" && hit.path == "sections/method.tex"));
        assert!(hits
            .iter()
            .any(|hit| hit.kind == "todo" && hit.preview.contains("\\todo")));
        assert!(hits.iter().any(|hit| hit.kind == "FIXME"));
        assert!(hits
            .iter()
            .any(|hit| hit.kind == "XXX" && hit.path == "notes.md"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn pdf_marks_round_trip_on_disk() {
        let parent = temp_root("pdf-marks");
        let root = create(&parent, "paper").unwrap();
        assert!(read_pdf_marks(&root).unwrap().is_empty());
        let mark = crate::models::PdfMark {
            id: "mark-1".to_string(),
            kind: "highlight".to_string(),
            page: 1,
            rects: vec![crate::models::PdfMarkRect {
                x1: 10.0,
                y1: 20.0,
                x2: 120.0,
                y2: 36.0,
            }],
            color: "yellow".to_string(),
            text: "Attention is all you need".to_string(),
            note: String::new(),
            created_at: "2026-07-19T00:00:00Z".to_string(),
        };
        write_pdf_marks(&root, vec![mark.clone()]).unwrap();
        let loaded = read_pdf_marks(&root).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "mark-1");
        assert_eq!(loaded[0].text, mark.text);
        let stored = fs::read_to_string(root.join(PDF_MARKS_PATH)).unwrap();
        assert!(stored.starts_with("{\n  \"schemaVersion\": 1,"));
        assert!(stored.ends_with("\n}\n"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn a_draft_that_was_compiled_once_can_still_be_deleted() {
        let parent = temp_root("delete-compiled-draft");
        let root = create(&parent, "paper").unwrap();
        fs::write(
            root.join("rebuttal.tex"),
            "\\documentclass{article}\n\\begin{document}\nB\n\\end{document}\n",
        )
        .unwrap();
        // Opening it during a build registers it as a root document, which is
        // how every compiled draft ended up permanently undeletable.
        set_compile_root(&root, "rebuttal.tex").unwrap();
        set_compile_root(&root, "main.tex").unwrap();
        assert_eq!(read_manifest(&root).unwrap().root_documents.len(), 2);

        delete_entry(&root, "rebuttal.tex").unwrap();

        assert!(!root.join("rebuttal.tex").exists());
        // The manifest must not keep pointing at a file that is gone.
        let manifest = read_manifest(&root).unwrap();
        assert_eq!(
            manifest
                .root_documents
                .iter()
                .map(|document| document.path.as_str())
                .collect::<Vec<_>>(),
            vec!["main.tex"]
        );
        // What a build would actually reach for is still refused.
        assert!(delete_entry(&root, "main.tex").is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn project_entries_can_be_created_and_deleted_but_roots_are_protected() {
        let parent = temp_root("project-entries");
        let root = create(&parent, "paper").unwrap();
        assert_eq!(
            create_entry(&root, "sections/method", "file").unwrap(),
            "sections/method.tex"
        );
        create_entry(&root, "figures/generated", "folder").unwrap();
        assert!(root.join("sections/method.tex").exists());
        assert!(root.join("figures/generated").is_dir());
        delete_entry(&root, "sections/method.tex").unwrap();
        assert!(!root.join("sections/method.tex").exists());
        assert!(delete_entry(&root, "main.tex").is_err());
        assert!(delete_entry(&root, "references.bib").is_err());
        assert!(create_entry(&root, ".research/private.txt", "file").is_err());
        assert_eq!(create_entry(&root, "notes.md", "file").unwrap(), "notes.md");
        assert_eq!(
            create_entry(&root, "supplement.html", "file").unwrap(),
            "supplement.html"
        );
        assert_eq!(
            fs::read_to_string(root.join("supplement.html")).unwrap(),
            ""
        );
        assert!(scan_files(&root)
            .unwrap()
            .iter()
            .any(|node| node.path == "supplement.html"));
        assert!(create_entry(&root, "binary.exe", "file").is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn create_entry_supports_board_files() {
        let parent = temp_root("board-entry");
        let root = create(&parent, "paper").unwrap();
        assert_eq!(
            create_entry(&root, "sketch.tldr", "file").unwrap(),
            "sketch.tldr"
        );
        // Boards seed empty: the editor initializes the tldraw store itself.
        assert_eq!(fs::read_to_string(root.join("sketch.tldr")).unwrap(), "");
        assert!(scan_files(&root)
            .unwrap()
            .iter()
            .any(|node| node.path == "sketch.tldr" && node.kind == "tldr"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn project_entries_can_be_renamed_and_manifest_paths_follow_them() {
        let parent = temp_root("rename-project-entries");
        let root = create(&parent, "paper").unwrap();
        assert_eq!(
            rename_entry(&root, "main.tex", "paper").unwrap(),
            "paper.tex"
        );
        assert_eq!(
            read_manifest(&root).unwrap().root_documents[0].path,
            "paper.tex"
        );
        create_entry(&root, "sections/method", "file").unwrap();
        assert_eq!(
            rename_entry(&root, "sections", "chapters").unwrap(),
            "chapters"
        );
        assert!(root.join("chapters/method.tex").exists());
        assert!(rename_entry(&root, "paper.tex", "references.bib").is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn project_entries_can_move_between_folders_and_manifest_paths_follow_them() {
        let parent = temp_root("move-project-entries");
        let root = create(&parent, "paper").unwrap();
        create_entry(&root, "sections", "folder").unwrap();
        assert_eq!(
            move_entry(&root, "main.tex", "sections").unwrap(),
            "sections/main.tex"
        );
        assert_eq!(
            read_manifest(&root).unwrap().root_documents[0].path,
            "sections/main.tex"
        );
        assert_eq!(
            move_entry(&root, "sections/main.tex", "").unwrap(),
            "main.tex"
        );
        create_entry(&root, "sections/nested", "folder").unwrap();
        assert!(move_entry(&root, "sections", "sections/nested").is_err());
        assert!(move_entry(&root, "main.tex", ".research").is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn moving_a_tex_file_removes_stale_build_outputs_from_both_locations() {
        let parent = temp_root("move-tex-build-outputs");
        let root = create(&parent, "paper").unwrap();
        create_entry(&root, "sections", "folder").unwrap();
        fs::write(root.join("main.pdf"), b"old root PDF").unwrap();
        fs::write(root.join("main.aux"), b"old root aux").unwrap();
        fs::write(root.join("sections/main.pdf"), b"stale destination PDF").unwrap();

        assert_eq!(
            move_entry(&root, "main.tex", "sections").unwrap(),
            "sections/main.tex"
        );
        assert!(!root.join("main.pdf").exists());
        assert!(!root.join("main.aux").exists());
        assert!(!root.join("sections/main.pdf").exists());
        assert!(!scan_files(&root)
            .unwrap()
            .iter()
            .any(|node| node.path == "main.pdf"));

        fs::write(root.join("sections/main.pdf"), b"compiled nested PDF").unwrap();
        fs::write(root.join("main.pdf"), b"stale root PDF").unwrap();
        assert_eq!(
            move_entry(&root, "sections/main.tex", "").unwrap(),
            "main.tex"
        );
        assert!(!root.join("sections/main.pdf").exists());
        assert!(!root.join("main.pdf").exists());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn imported_assets_are_copied_and_renamed_on_collision() {
        let parent = temp_root("import-assets");
        let root = create(&parent, "paper").unwrap();
        let source = parent.join("result.png");
        fs::write(&source, b"png-bytes").unwrap();
        let paths = vec![source.to_string_lossy().to_string()];
        assert_eq!(
            import_assets(&root, &paths, "figures").unwrap(),
            vec!["figures/result.png"]
        );
        assert_eq!(
            import_assets(&root, &paths, "figures").unwrap(),
            vec!["figures/result-2.png"]
        );
        let unsupported = parent.join("notes.txt");
        fs::write(&unsupported, b"text").unwrap();
        assert!(import_assets(
            &root,
            &[unsupported.to_string_lossy().to_string()],
            "figures"
        )
        .is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn agent_composer_files_carry_bytes_for_figures_and_text_sources() {
        let parent = temp_root("agent-composer-files");
        let image = parent.join("plot.png");
        fs::write(&image, b"png-bytes").unwrap();
        let markdown = parent.join("notes.md");
        fs::write(&markdown, b"# Notes").unwrap();

        let files = read_agent_composer_files(&[
            image.to_string_lossy().to_string(),
            markdown.to_string_lossy().to_string(),
        ])
        .unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "plot.png");
        assert_eq!(files[0].mime_type, "image/png");
        assert_eq!(files[0].bytes_base64, STANDARD.encode(b"png-bytes"));
        assert_eq!(files[1].name, "notes.md");
        assert_eq!(files[1].mime_type, "text/markdown");
        assert_eq!(files[1].bytes_base64, STANDARD.encode(b"# Notes"));

        let archive = parent.join("archive.zip");
        fs::write(&archive, b"zip").unwrap();
        let error =
            read_agent_composer_files(&[archive.to_string_lossy().to_string()]).unwrap_err();
        assert!(error.contains("archive.zip"), "{error}");
        assert!(read_agent_composer_files(&[]).is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn imported_assets_follow_the_drop_target() {
        let parent = temp_root("import-asset-targets");
        let root = create(&parent, "paper").unwrap();
        let source = parent.join("result.png");
        fs::write(&source, b"png-bytes").unwrap();
        let paths = vec![source.to_string_lossy().to_string()];
        // Dropping on a folder the project does not have yet (opened projects
        // are not guaranteed a "figures" skeleton) creates it.
        assert_eq!(
            import_assets(&root, &paths, "assets").unwrap(),
            vec!["assets/result.png"]
        );
        // The Project pane background is the project root.
        assert_eq!(
            import_assets(&root, &paths, "").unwrap(),
            vec!["result.png"]
        );
        assert_eq!(
            import_assets(&root, &paths, "assets/").unwrap(),
            vec!["assets/result-2.png"]
        );
        assert!(import_assets(&root, &paths, "main.tex").is_err());
        assert!(import_assets(&root, &paths, ".research").is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn imported_files_route_by_content_and_keep_figures_binary() {
        let parent = temp_root("import-any-files");
        let root = create(&parent, "paper").unwrap();
        let csv = parent.join("data.csv");
        fs::write(&csv, "a,b\n1,2\n").unwrap();
        let archive = parent.join("bundle.zip");
        fs::write(&archive, b"PK\x03\x04rest").unwrap();
        let board = parent.join("sketch.tldr");
        fs::write(&board, "{\"tldrawFileFormatVersion\":1}").unwrap();
        // Text bytes under a figure extension stay on the figure route.
        let svg = parent.join("diagram.svg");
        fs::write(&svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>").unwrap();
        let all = [&csv, &archive, &board, &svg]
            .map(|path| path.to_string_lossy().to_string())
            .to_vec();

        let imported = import_files(&root, &all, "data").unwrap();
        assert_eq!(
            imported
                .iter()
                .map(|file| (file.path.as_str(), file.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("data/data.csv", "text"),
                ("data/bundle.zip", "binary"),
                ("data/sketch.tldr", "board"),
                ("data/diagram.svg", "binary"),
            ]
        );
        assert_eq!(
            fs::read_to_string(root.join("data/data.csv")).unwrap(),
            "a,b\n1,2\n"
        );
        assert!(root.join("data/bundle.zip").is_file());

        // Collisions rename; files already inside the project only register.
        assert_eq!(
            import_files(&root, &all[..1], "data").unwrap()[0].path,
            "data/data-2.csv"
        );
        let inside = root.join("data/data.csv").to_string_lossy().to_string();
        assert_eq!(
            import_files(&root, &[inside], "").unwrap()[0].path,
            "data/data.csv"
        );
        assert!(!root.join("data.csv").exists());

        assert!(import_files(&root, &all[..1], ".research").is_err());
        assert!(import_files(&root, &all[..1], "main.tex").is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn imported_folders_preserve_visible_hierarchy_and_rename_collisions() {
        let parent = temp_root("import-folder");
        let root = create(&parent, "paper").unwrap();
        let source = parent.join("dataset.v1");
        fs::create_dir_all(source.join("nested/empty")).unwrap();
        fs::create_dir_all(source.join(".cache")).unwrap();
        fs::write(source.join("README.md"), "# Dataset\n").unwrap();
        fs::write(source.join("nested/results.csv"), "score\n1\n").unwrap();
        fs::write(source.join("nested/archive.zip"), b"PK\x03\x04rest").unwrap();
        fs::write(source.join(".DS_Store"), b"metadata").unwrap();
        fs::write(source.join(".cache/private.txt"), "private").unwrap();

        let paths = vec![source.to_string_lossy().to_string()];
        let imported = import_files(&root, &paths, "sections").unwrap();
        assert_eq!(
            imported
                .iter()
                .map(|file| (file.path.as_str(), file.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("sections/dataset.v1/README.md", "text"),
                ("sections/dataset.v1/nested/archive.zip", "binary"),
                ("sections/dataset.v1/nested/results.csv", "text"),
            ]
        );
        assert_eq!(
            fs::read_to_string(root.join("sections/dataset.v1/nested/results.csv")).unwrap(),
            "score\n1\n"
        );
        assert!(root.join("sections/dataset.v1/nested/empty").is_dir());
        assert!(!root.join("sections/dataset.v1/.DS_Store").exists());
        assert!(!root.join("sections/dataset.v1/.cache").exists());

        let imported_again = import_files(&root, &paths, "sections").unwrap();
        assert!(imported_again
            .iter()
            .all(|file| file.path.starts_with("sections/dataset.v1-2/")));
        assert!(root.join("sections/dataset.v1-2/nested/empty").is_dir());

        let error = import_files(&root, &[parent.to_string_lossy().to_string()], "").unwrap_err();
        assert!(error.contains("contains the current project"), "{error}");
        fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn imported_folders_do_not_follow_symbolic_links() {
        use std::os::unix::fs::symlink;

        let parent = temp_root("import-folder-symlinks");
        let root = create(&parent, "paper").unwrap();
        let source = parent.join("dataset");
        let outside = parent.join("outside");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(source.join("visible.txt"), "visible").unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, source.join("linked-directory")).unwrap();
        symlink(outside.join("secret.txt"), source.join("linked-file")).unwrap();

        let imported = import_files(&root, &[source.to_string_lossy().to_string()], "").unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].path, "dataset/visible.txt");
        assert!(!root.join("dataset/linked-directory").exists());
        assert!(!root.join("dataset/linked-file").exists());

        let top_level_link = parent.join("linked-dataset");
        symlink(&source, &top_level_link).unwrap();
        let error =
            import_files(&root, &[top_level_link.to_string_lossy().to_string()], "").unwrap_err();
        assert!(error.contains("symbolic link"), "{error}");
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn imported_sources_are_transactional_and_renamed_on_collision() {
        let parent = temp_root("import-sources");
        let root = create(&parent, "paper").unwrap();
        let source = parent.join("notes.tex");
        fs::write(&source, "\\section{Imported}\n").unwrap();
        let paths = vec![source.to_string_lossy().to_string()];

        assert_eq!(
            import_sources(&root, &paths, "").unwrap(),
            vec!["notes.tex"]
        );
        assert_eq!(
            import_sources(&root, &paths, "").unwrap(),
            vec!["notes-2.tex"]
        );
        assert_eq!(
            fs::read_to_string(root.join("notes.tex")).unwrap(),
            "\\section{Imported}\n"
        );
        assert_eq!(
            import_sources(
                &root,
                &[root.join("notes.tex").to_string_lossy().to_string()],
                "",
            )
            .unwrap(),
            vec!["notes.tex"]
        );

        // Boards are text (tldraw JSON) and must import like other sources;
        // the frontend offers them to this path.
        let board = parent.join("sketch.tldr");
        fs::write(&board, "{\"tldrawFileFormatVersion\":1}").unwrap();
        assert_eq!(
            import_sources(&root, &[board.to_string_lossy().to_string()], "").unwrap(),
            vec!["sketch.tldr"]
        );

        let unsupported = parent.join("result.png");
        fs::write(&unsupported, b"png").unwrap();
        assert!(import_sources(&root, &[unsupported.to_string_lossy().to_string()], "",).is_err());
        let invalid_utf8 = parent.join("invalid.bib");
        fs::write(&invalid_utf8, [0xff, 0xfe]).unwrap();
        assert!(import_sources(&root, &[invalid_utf8.to_string_lossy().to_string()], "",).is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn project_figures_can_be_previewed_and_prepared_for_latex() {
        let parent = temp_root("preview-assets");
        let root = create(&parent, "paper").unwrap();
        let png = root.join("figures/result.png");
        fs::write(&png, b"\x89PNG\r\n\x1a\n").unwrap();
        let preview = read_asset(&root, "figures/result.png").unwrap();
        assert_eq!(preview.path, "figures/result.png");
        assert_eq!(preview.mime_type, "image/png");
        assert_eq!(preview.base64, "iVBORw0KGgo=");
        assert_eq!(
            prepare_latex_figure(&root, "figures/result.png").unwrap(),
            "figures/result.png"
        );

        let svg = root.join("figures/diagram.svg");
        fs::write(
            &svg,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>"#,
        )
        .unwrap();
        if commands::available("rsvg-convert") || commands::available("magick") {
            let converted = prepare_latex_figure(&root, "figures/diagram.svg").unwrap();
            assert_eq!(converted, "figures/diagram-converted.pdf");
            assert!(root.join(converted).is_file());
        }
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn new_project_titles_are_safe_latex() {
        assert_eq!(latex_title("R&D_100%"), "R\\&D\\_100\\%");
        assert_eq!(latex_title("科研"), "Untitled research");
    }

    #[test]
    fn search_hits_include_matching_line_numbers() {
        let content = "alpha\nbeta alignment gamma\ndelta\n";
        let terms = search_terms("alignment");
        assert_eq!(
            matching_hit(content, &terms),
            Some((2, "beta alignment gamma".to_string()))
        );
    }

    #[test]
    fn labels_and_citations_can_be_found_and_renamed() {
        let parent = temp_root("rename-symbols");
        let root = create(&parent, "paper").unwrap();
        fs::write(
            root.join("main.tex"),
            "See \\ref{fig:model} and \\cref{fig:model, eq:loss}.\n\\label{fig:model}\n\\citep{vaswani2017attention}\n",
        )
        .unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{vaswani2017attention,\n  title={Attention},\n}\n",
        )
        .unwrap();

        let label_hits = find_label_occurrences(&root, "fig:model").unwrap();
        assert_eq!(label_hits.len(), 3);
        assert!(label_hits.iter().any(|hit| hit.role == "definition"));
        assert_eq!(
            label_hits
                .iter()
                .filter(|hit| hit.role == "reference")
                .count(),
            2
        );

        rename_label(&root, "fig:model", "fig:architecture").unwrap();
        let main = fs::read_to_string(root.join("main.tex")).unwrap();
        assert!(main.contains("\\ref{fig:architecture}"));
        assert!(main.contains("\\cref{fig:architecture, eq:loss}"));
        assert!(main.contains("\\label{fig:architecture}"));
        assert!(!main.contains("fig:model"));

        let cite_hits = find_citation_occurrences(&root, "vaswani2017attention").unwrap();
        assert_eq!(cite_hits.len(), 2);
        rename_citation_key(&root, "vaswani2017attention", "vaswani2017").unwrap();
        let main = fs::read_to_string(root.join("main.tex")).unwrap();
        let bib = fs::read_to_string(root.join("references.bib")).unwrap();
        assert!(main.contains("\\citep{vaswani2017}"));
        assert!(bib.contains("@article{vaswani2017,"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn blank_collab_workspace_has_no_venue_template() {
        let parent = temp_root("collab-blank");
        let root = create_blank(&parent, "share-LT-ABC123").unwrap();
        let manifest = read_manifest(&root).unwrap();
        assert_eq!(manifest.venue, "shared");
        assert!(root.join("main.tex").exists());
        // A document with no pages makes pdflatex write no PDF, which latexmk
        // stores as a failure and replays on every later build of a source that
        // has not changed. The placeholder has to typeset to something.
        let placeholder = fs::read_to_string(root.join("main.tex")).unwrap();
        let body = placeholder
            .split_once("\\begin{document}")
            .and_then(|(_, rest)| rest.split_once("\\end{document}"))
            .map(|(body, _)| body.trim().to_string())
            .unwrap_or_default();
        assert!(
            !body.is_empty(),
            "placeholder must typeset at least one page: {placeholder:?}"
        );
        assert!(!root.join("neurips.sty").exists());
        assert!(!root.join("icml2026.sty").exists());
        assert!(!root.join("iclr2026_conference.sty").exists());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn new_projects_use_the_bundled_neurips_2026_template() {
        let parent = temp_root("neurips-2026-project");
        let root = create(&parent, "Elegant paper").unwrap();
        let source = fs::read_to_string(root.join("main.tex")).unwrap();
        let manifest = read_manifest(&root).unwrap();
        assert_eq!(manifest.venue, "neurips");
        assert!(source.contains("\\documentclass{article}"));
        assert!(source.contains("\\usepackage[preprint]{neurips}"));
        assert!(source.contains("\\bibliographystyle{plainnat}"));
        assert!(!source.contains("Formatting Instructions For NeurIPS 2026"));
        assert!(root.join("neurips.sty").exists());
        assert!(!root.join("neurips_2026.sty").exists());
        assert!(!root.join("arxiv.sty").exists());
        assert!(!root.join(".research/omp-sessions").exists());
        assert!(!root.join(".research/omp-session-map").exists());
        let root_ignore = fs::read_to_string(root.join(".gitignore")).unwrap();
        let research_ignore = fs::read_to_string(root.join(".research/.gitignore")).unwrap();
        assert!(!root_ignore.contains("omp-"));
        assert!(!research_ignore.contains("omp-"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn new_projects_can_use_icml_and_iclr_templates() {
        let parent = temp_root("venue-templates");
        let icml = create_with_venue(&parent, "icml-paper", Venue::Icml).unwrap();
        let icml_source = fs::read_to_string(icml.join("main.tex")).unwrap();
        assert_eq!(read_manifest(&icml).unwrap().venue, "icml");
        assert!(icml_source.contains("\\usepackage[preprint]{icml2026}"));
        assert!(icml.join("icml2026.sty").exists());
        assert!(icml.join("icml2026.bst").exists());
        assert!(!icml.join("neurips.sty").exists());

        let iclr = create_with_venue(&parent, "iclr-paper", Venue::Iclr).unwrap();
        let iclr_source = fs::read_to_string(iclr.join("main.tex")).unwrap();
        assert_eq!(read_manifest(&iclr).unwrap().venue, "iclr");
        assert!(iclr_source.contains("\\usepackage{iclr2026_conference,times}"));
        assert!(iclr.join("iclr2026_conference.sty").exists());
        assert!(iclr.join("iclr2026_conference.bst").exists());
        assert!(!iclr.join("neurips.sty").exists());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn unused_symbols_detect_dead_labels_and_citations() {
        let parent = temp_root("unused-symbols");
        let root = create(&parent, "paper").unwrap();
        fs::write(
            root.join("main.tex"),
            "See \\ref{fig:used} and \\citep{used}.\n\\label{fig:used}\n\\label{fig:dead}\n",
        )
        .unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{used, title={Used}, author={A}, year={2020},}\n@article{dead, title={Dead}, author={B}, year={2021},}\n",
        )
        .unwrap();
        let unused = unused_symbols(&root).unwrap();
        assert_eq!(unused.labels, vec!["fig:dead".to_string()]);
        assert_eq!(unused.citations, vec!["dead".to_string()]);
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn latexmk_engine_arg_maps_known_engines() {
        assert_eq!(latexmk_engine_arg("pdf"), "-pdf");
        assert_eq!(latexmk_engine_arg("xelatex"), "-pdfxe");
        assert_eq!(latexmk_engine_arg("lualatex"), "-pdflua");
        assert_eq!(latexmk_engine_arg("unknown"), "-pdf");
    }

    #[test]
    fn create_entry_supports_bibliography_files() {
        let parent = temp_root("create-bib");
        let root = create(&parent, "paper").unwrap();
        assert_eq!(
            create_entry(&root, "extra.bib", "file").unwrap(),
            "extra.bib"
        );
        assert_eq!(
            fs::read_to_string(root.join("extra.bib")).unwrap(),
            "% Bibliography\n"
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn history_can_restore_a_single_file() {
        let parent = temp_root("history-file-restore");
        let root = create(&parent, "paper").unwrap();
        apply_transaction(
            &root,
            "Edit both",
            vec![
                ("main.tex".to_string(), "% main-new\n".to_string()),
                ("references.bib".to_string(), "% bib-new\n".to_string()),
            ],
        )
        .unwrap();
        let items = history(&root).unwrap();
        revert_file(&root, &items[0].id, "main.tex").unwrap();
        assert_ne!(
            fs::read_to_string(root.join("main.tex")).unwrap(),
            "% main-new\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("references.bib")).unwrap(),
            "% bib-new\n"
        );
        assert!(transaction_path(&root, &items[0].id).unwrap().exists());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn clipboard_image_bytes_are_saved_into_figures() {
        let parent = temp_root("clipboard-image");
        let root = create(&parent, "paper").unwrap();
        let png = [
            0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        ];
        let path =
            import_image_bytes(&root, "figures", "paste.png", &STANDARD.encode(png)).unwrap();
        assert_eq!(path, "figures/paste.png");
        assert!(root.join("figures/paste.png").is_file());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn citation_query_parser_reads_bibtex_fields() {
        let resolved = citation_from_bibtex(
            "@article{lecun2015deep,\n  author = {LeCun, Yann},\n  doi = {10.1038/nature14539},\n  journal = {Nature},\n  title = {Deep learning},\n  year = {2015}\n}\n",
            "fallback",
        );
        assert_eq!(resolved.key, "lecun2015deep");
        assert_eq!(resolved.title, "Deep learning");
        assert_eq!(resolved.doi, "10.1038/nature14539");
        assert_eq!(resolved.journal, "Nature");
        assert_eq!(resolved.entry_type, "article");
    }

    #[test]
    fn replace_in_project_rewrites_matching_files() {
        let parent = temp_root("project-replace");
        let root = create(&parent, "paper").unwrap();
        create_entry(&root, "sections/a.tex", "file").unwrap();
        fs::write(root.join("sections/a.tex"), "alpha token beta\n").unwrap();
        fs::write(root.join("main.tex"), "token in main\n").unwrap();
        let preview = preview_replace_in_project(&root, "token", None, true, false).unwrap();
        assert_eq!(preview.replacements, 2);
        assert_eq!(preview.files, 2);
        assert!(preview.matches.iter().any(|item| item.path == "main.tex"));
        let result = replace_in_project(&root, "token", "VALUE", None, true, false).unwrap();
        assert_eq!(result.replacements, 2);
        assert!(result.files_changed.contains(&"main.tex".to_string()));
        assert!(result.files_changed.contains(&"sections/a.tex".to_string()));
        assert!(fs::read_to_string(root.join("main.tex"))
            .unwrap()
            .contains("VALUE"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn replace_in_project_supports_case_and_regex() {
        let parent = temp_root("project-replace-opts");
        let root = create(&parent, "paper").unwrap();
        fs::write(root.join("main.tex"), "Token TOKEN token\n").unwrap();
        let insensitive = preview_replace_in_project(&root, "token", None, false, false).unwrap();
        assert_eq!(insensitive.replacements, 3);
        let regex = replace_in_project(&root, r"[Tt]oken", "X", None, true, true).unwrap();
        assert_eq!(regex.replacements, 2);
        assert_eq!(
            fs::read_to_string(root.join("main.tex")).unwrap(),
            "X TOKEN X\n"
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn citations_index_all_bibliography_files() {
        let parent = temp_root("multi-bib");
        let root = create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{one,\n  title={One},\n  author={A},\n  year={2020}\n}\n",
        )
        .unwrap();
        create_entry(&root, "extra.bib", "file").unwrap();
        fs::write(
            root.join("extra.bib"),
            "@article{two,\n  title={Two},\n  author={B},\n  year={2021}\n}\n",
        )
        .unwrap();
        let keys = citation_keys(&root).unwrap();
        assert!(keys.iter().any(|key| key == "one"));
        assert!(keys.iter().any(|key| key == "two"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn rapid_edits_coalesce_into_one_history_entry() {
        let parent = temp_root("history-coalesce");
        let root = create(&parent, "paper").unwrap();
        apply_transaction(
            &root,
            "Edit main.tex",
            vec![("main.tex".to_string(), "% one\n".to_string())],
        )
        .unwrap();
        apply_transaction(
            &root,
            "Edit main.tex",
            vec![("main.tex".to_string(), "% two\n".to_string())],
        )
        .unwrap();
        let items = history(&root).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "Edit main.tex");
        let entry = get_history_entry(&root, &items[0].id).unwrap();
        assert_eq!(entry.changes[0].after.as_deref(), Some("% two\n"));
        assert_ne!(entry.changes[0].before.as_deref(), Some("% one\n"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn unchanged_edits_do_not_create_history_entries() {
        let parent = temp_root("history-unchanged");
        let root = create(&parent, "paper").unwrap();
        let content = fs::read_to_string(root.join("main.tex")).unwrap();

        let transaction = apply_transaction(
            &root,
            "Edit main.tex",
            vec![("main.tex".to_string(), content)],
        )
        .unwrap();

        assert!(transaction.is_none());
        assert!(history(&root).unwrap().is_empty());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn existing_unchanged_records_are_hidden_from_history() {
        let parent = temp_root("history-existing-unchanged");
        let root = create(&parent, "paper").unwrap();
        let directory = root.join(".research/history");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("unchanged.json"),
            r#"{
  "id": "unchanged",
  "label": "Edit main.tex",
  "timestamp": "2026-08-03T12:00:00Z",
  "changes": [{"path":"main.tex","before":"same","after":"same"}]
}
"#,
        )
        .unwrap();

        assert!(history(&root).unwrap().is_empty());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn coalesced_edit_removed_when_file_returns_to_original_content() {
        let parent = temp_root("history-coalesce-original");
        let root = create(&parent, "paper").unwrap();
        let original = fs::read_to_string(root.join("main.tex")).unwrap();
        apply_transaction(
            &root,
            "Edit main.tex",
            vec![("main.tex".to_string(), "% temporary\n".to_string())],
        )
        .unwrap();

        let transaction = apply_transaction(
            &root,
            "Edit main.tex",
            vec![("main.tex".to_string(), original.clone())],
        )
        .unwrap();

        assert!(transaction.is_none());
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), original);
        assert!(history(&root).unwrap().is_empty());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn latest_history_memo_tracks_mutations() {
        let parent = temp_root("history-memo");
        let root = create(&parent, "paper").unwrap();
        // Distinct labels so the two records do not coalesce.
        apply_transaction(
            &root,
            "Edit main.tex",
            vec![("main.tex".to_string(), "% a\n".to_string())],
        )
        .unwrap();
        let newest = apply_transaction(
            &root,
            "Update refs.bib",
            vec![("refs.bib".to_string(), "@misc{x}\n".to_string())],
        )
        .unwrap()
        .unwrap();
        assert_eq!(latest_history_record(&root).unwrap().unwrap().id, newest.id);
        // A memo hit must agree with a cold directory scan.
        forget_latest_history(&root);
        assert_eq!(latest_history_record(&root).unwrap().unwrap().id, newest.id);
        // Deleting a non-newest record leaves the memo valid.
        let items = history(&root).unwrap();
        let older = items.iter().find(|item| item.id != newest.id).unwrap();
        delete_history(&root, &older.id).unwrap();
        assert_eq!(latest_history_record(&root).unwrap().unwrap().id, newest.id);
        // Deleting the newest invalidates it; the rescan finds nothing left.
        delete_history(&root, &newest.id).unwrap();
        assert!(latest_history_record(&root).unwrap().is_none());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn classification_cache_tracks_content_changes() {
        let parent = temp_root("classify-cache");
        let root = create(&parent, "paper").unwrap();
        let file = root.join("note.md");
        fs::write(&file, "text\n").unwrap();
        let metadata = fs::symlink_metadata(&file).unwrap();
        assert_eq!(
            classify_regular_file_cached(&file, &metadata).unwrap(),
            ContentKind::Text
        );
        // A rewrite changes (mtime, len), so the cached kind must not stick.
        fs::write(&file, b"a\0b".as_slice()).unwrap();
        let metadata = fs::symlink_metadata(&file).unwrap();
        assert_eq!(
            classify_regular_file_cached(&file, &metadata).unwrap(),
            ContentKind::Binary
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn root_documents_can_be_added_and_removed() {
        let parent = temp_root("root-docs");
        let root = create(&parent, "paper").unwrap();
        create_entry(&root, "alt.tex", "file").unwrap();
        let added = add_root_document(&root, "alt.tex", Some("Alt".to_string()), true).unwrap();
        assert!(added
            .root_documents
            .iter()
            .any(|document| document.path == "alt.tex"
                && document.is_default
                && document.name == "Alt"));
        assert!(remove_root_document(&root, "main.tex").is_ok());
        assert!(remove_root_document(&root, "alt.tex").is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn update_manifest_settings_sets_engine_and_default_root() {
        let parent = temp_root("manifest-settings");
        let root = create(&parent, "paper").unwrap();
        create_entry(&root, "alt.tex", "file").unwrap();
        let mut manifest = read_manifest(&root).unwrap();
        manifest.root_documents.push(RootDocument {
            path: "alt.tex".to_string(),
            name: "Alt".to_string(),
            is_default: false,
        });
        write_manifest(&root, &manifest).unwrap();
        let updated = update_manifest_settings(
            &root,
            Some("xelatex".to_string()),
            Some("alt.tex".to_string()),
            Some(true),
            Some(Some(5000)),
            Some(Some(9)),
            Some(vec![
                "TexLab".to_string(),
                "VLM".to_string(),
                "texlab".to_string(),
            ]),
        )
        .unwrap();
        assert_eq!(updated.engine, "xelatex");
        assert!(updated.trusted);
        assert_eq!(updated.word_budget, Some(5000));
        assert_eq!(updated.page_budget, Some(9));
        assert_eq!(updated.spelling_words, vec!["TexLab", "VLM"]);
        assert!(updated
            .root_documents
            .iter()
            .any(|document| document.path == "alt.tex" && document.is_default));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn parses_tex_magic_comments_for_root_and_engine() {
        let hints = parse_tex_magic_comments(
            "% !TEX root = paper.tex\n% !TEX program = xelatex\n\\documentclass{article}\n",
        );
        assert_eq!(hints.root.as_deref(), Some("paper.tex"));
        assert_eq!(hints.engine.as_deref(), Some("xelatex"));
    }

    #[test]
    fn never_chooses_a_conflict_copy_as_the_root_document() {
        // The copy is byte-identical to the real file when it is made, so
        // nothing but the name tells them apart — and picking the copy means
        // edits to the real file stop reaching the PDF.
        let parent = temp_root("detect-conflict-copy");
        let root = parent.join("proj");
        fs::create_dir_all(&root).unwrap();
        let body = "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n";
        fs::write(root.join("neurips_2026.tex"), body).unwrap();
        fs::write(
            root.join("neurips_2026 (local conflict 20260724-1308).tex"),
            body,
        )
        .unwrap();
        assert_eq!(
            detect_root_document(&root).as_deref(),
            Some("neurips_2026.tex")
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn detects_documentclass_over_shallow_include() {
        let parent = temp_root("detect-root");
        let root = parent.join("proj");
        fs::create_dir_all(root.join("sections")).unwrap();
        fs::write(root.join("sections/intro.tex"), "Intro text\n").unwrap();
        fs::write(
            root.join("paper.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n",
        )
        .unwrap();
        assert_eq!(detect_root_document(&root).as_deref(), Some("paper.tex"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn detects_magic_root_comment() {
        let parent = temp_root("detect-magic-root");
        let root = parent.join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("main.tex"),
            "% !TEX root = manuscript.tex\n\\input{manuscript}\n",
        )
        .unwrap();
        fs::write(
            root.join("manuscript.tex"),
            "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n",
        )
        .unwrap();
        assert_eq!(
            detect_root_document(&root).as_deref(),
            Some("manuscript.tex")
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn exports_project_zip_without_aux_files() {
        let root = temp_root("export-zip");
        fs::write(root.join("main.tex"), "\\documentclass{article}\n").unwrap();
        fs::write(root.join("main.log"), "noise\n").unwrap();
        let zip_path = root
            .parent()
            .unwrap()
            .join(format!("lattice-export-{}.zip", Uuid::new_v4()));
        export_project_zip(&root, &zip_path).unwrap();
        assert!(zip_path.is_file());
        let listing = std::process::Command::new("unzip")
            .args(["-Z1"])
            .arg(&zip_path)
            .output()
            .unwrap();
        let names = String::from_utf8_lossy(&listing.stdout);
        assert!(names.contains("main.tex"));
        assert!(!names.contains("main.log"));
        let _ = fs::remove_file(zip_path);
        fs::remove_dir_all(root).unwrap();
    }
}
