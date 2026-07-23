use crate::commands;
use crate::models::{
    AssetPreview, CitationInfo, EditorComment, EditorCommentsFile, FileChange, FileNode,
    HistoryItem, PdfMark, PdfMarksFile, ProjectManifest, ProjectSearchResult, ProjectSnapshot,
    ReferenceInfo, RenameSymbolResult, ReplaceMatch, ReplacePreview, ReplaceResult,
    ResolvedCitation, RootDocument, SymbolOccurrence, TodoHit, TransactionRecord, UnusedSymbols,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;
use walkdir::WalkDir;

const MANIFEST_PATH: &str = ".research/project.json";
const PDF_MARKS_PATH: &str = ".research/pdf-annotations.json";
const EDITOR_COMMENTS_PATH: &str = ".research/editor-comments.json";
const RESEARCH_GITIGNORE: &str =
    "history/\nsessions/\nomp-sessions/\nomp-session-map/\nomp-runtime/\ncheckpoints/\ncache/\n";
const MAX_HISTORY_ENTRIES: usize = 100;
const EDIT_COALESCE_SECS: i64 = 45;
const NEURIPS_2026_MAIN: &str = include_str!("../templates/neurips-2026/main.tex");
const NEURIPS_2026_STYLE: &str = include_str!("../templates/neurips-2026/neurips_2026.sty");
const ICML_2026_MAIN: &str = include_str!("../templates/icml-2026/main.tex");
const ICML_2026_STYLE: &str = include_str!("../templates/icml-2026/icml2026.sty");
const ICML_2026_BST: &str = include_str!("../templates/icml-2026/icml2026.bst");
const ICLR_2026_MAIN: &str = include_str!("../templates/iclr-2026/main.tex");
const ICLR_2026_STYLE: &str = include_str!("../templates/iclr-2026/iclr2026_conference.sty");
const ICLR_2026_BST: &str = include_str!("../templates/iclr-2026/iclr2026_conference.bst");

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

fn prepare_project_skeleton(root: &Path) -> Result<(), String> {
    if root.exists() && fs::read_dir(root).map_err(err)?.next().is_some() {
        return Err("That folder already exists and is not empty.".to_string());
    }
    fs::create_dir_all(root.join(".research/papers")).map_err(err)?;
    fs::create_dir_all(root.join(".research/history")).map_err(err)?;
    fs::create_dir_all(root.join(".research/sessions")).map_err(err)?;
    fs::create_dir_all(root.join(".research/omp-sessions")).map_err(err)?;
    fs::create_dir_all(root.join(".research/omp-session-map")).map_err(err)?;
    fs::create_dir_all(root.join(".research/licenses")).map_err(err)?;
    fs::create_dir_all(root.join("figures")).map_err(err)?;
    fs::write(root.join(".research/.gitignore"), RESEARCH_GITIGNORE).map_err(err)?;
    fs::write(
        root.join(".gitignore"),
        ".research/history/\n.research/sessions/\n.research/omp-sessions/\n.research/omp-session-map/\n.research/omp-runtime/\n.research/checkpoints/\n.research/cache/\n/main.pdf\n*.aux\n*.bbl\n*.blg\n*.fdb_latexmk\n*.fls\n*.log\n*.out\n*.synctex.gz\n",
    )
    .map_err(err)?;
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
    fs::write(
        root.join("main.tex"),
        "% Waiting for shared project files…\n\\documentclass{article}\n\\begin{document}\n\\end{document}\n",
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
    fs::create_dir_all(root.join(".research/omp-sessions")).map_err(err)?;
    fs::create_dir_all(root.join(".research/omp-session-map")).map_err(err)?;
    let research_ignore = root.join(".research/.gitignore");
    if research_ignore.exists() {
        ensure_ignore_line(&research_ignore, "checkpoints/")?;
        ensure_ignore_line(&research_ignore, "omp-sessions/")?;
        ensure_ignore_line(&research_ignore, "omp-session-map/")?;
        ensure_ignore_line(&research_ignore, "omp-runtime/")?;
    } else {
        fs::write(&research_ignore, RESEARCH_GITIGNORE).map_err(err)?;
    }
    ensure_ignore_line(&root.join(".gitignore"), ".research/checkpoints/")?;
    ensure_ignore_line(&root.join(".gitignore"), ".research/omp-sessions/")?;
    ensure_ignore_line(&root.join(".gitignore"), ".research/omp-session-map/")?;
    ensure_ignore_line(&root.join(".gitignore"), ".research/omp-runtime/")?;
    ensure_ignore_line(&root.join(".gitignore"), ".research/cache/")?;
    ensure_ignore_line(&root.join(".research/.gitignore"), "cache/")?;

    let manifest = if root.join(MANIFEST_PATH).exists() {
        read_manifest(&root)?
    } else {
        let name = root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Research project");
        let mut manifest = default_manifest(name);
        if let Some(relative) = detect_root_document(&root) {
            let stem = Path::new(&relative)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Root")
                .to_string();
            manifest.root_documents[0].path = relative;
            manifest.root_documents[0].name = stem;
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
        files: scan_files(&root)?,
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

pub fn write_manifest(root: &Path, manifest: &ProjectManifest) -> Result<(), String> {
    let path = root.join(MANIFEST_PATH);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let raw = serde_json::to_string_pretty(manifest).map_err(err)?;
    fs::write(path, format!("{raw}\n")).map_err(err)
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
    let path = root.join(PDF_MARKS_PATH);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let file = PdfMarksFile {
        schema_version: 1,
        annotations,
    };
    let raw = serde_json::to_string_pretty(&file).map_err(err)?;
    fs::write(path, format!("{raw}\n")).map_err(err)
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
    let path = root.join(EDITOR_COMMENTS_PATH);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let file = EditorCommentsFile {
        schema_version: 1,
        comments,
    };
    let raw = serde_json::to_string_pretty(&file).map_err(err)?;
    fs::write(path, format!("{raw}\n")).map_err(err)
}

pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("The requested path is outside the project.".to_string());
    }

    let path = root.join(relative_path);
    let parent = path.parent().unwrap_or(root);
    fs::create_dir_all(parent).map_err(err)?;
    let canonical_parent = parent.canonicalize().map_err(err)?;
    let canonical_root = root.canonicalize().map_err(err)?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("The requested path is outside the project.".to_string());
    }
    Ok(path)
}

pub fn read_file(root: &Path, relative: &str) -> Result<String, String> {
    fs::read_to_string(safe_path(root, relative)?).map_err(|error| {
        if error.kind() == std::io::ErrorKind::InvalidData {
            "This is a binary file and cannot be opened in the source editor.".to_string()
        } else {
            error.to_string()
        }
    })
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
    "citep",
    "citet",
    "citealp",
    "citealt",
    "citeauthor",
    "parencite",
    "textcite",
    "autocite",
    "footcite",
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

fn find_command_argument_keys(source: &str, commands: &[&str]) -> Vec<(usize, usize, String)> {
    let mut hits = Vec::new();
    let bytes = source.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
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
        let parts = argument.split(',').collect::<Vec<_>>();
        let mut offset = 0usize;
        for (index_in_list, part) in parts.iter().enumerate() {
            let leading = part.len() - part.trim_start().len();
            let key = part.trim();
            if !key.is_empty() {
                let from = content_start + offset + leading;
                hits.push((from, from + key.len(), key.to_string()));
            }
            offset += part.len();
            if index_in_list + 1 < parts.len() {
                offset += 1;
            }
        }
        index = end;
    }
    hits
}

/// One in-place edit to a `\label`/`\cite` reference: (path, from, to, line, old, new).
type ReferenceEdit = (String, usize, usize, u32, String, String);

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
            if found != key {
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
    let transaction = apply_transaction(root, label, file_edits)?;
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

fn parse_bibliography(bibliography: &str) -> Vec<CitationInfo> {
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
        });
    }
    citations
}

/// arXiv preprints reach a .bib in several shapes: an `eprint` field, an
/// `archivePrefix`/`primaryClass` pair, or just a URL or DOI pointing at arXiv.
fn bibliography_arxiv_id(fields: &BTreeMap<String, String>) -> Option<String> {
    let looks_like_id = |value: &str| {
        Regex::new(r"^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?/\d{7})(v\d+)?$")
            .ok()
            .is_some_and(|pattern| pattern.is_match(value))
    };
    if let Some(eprint) = fields.get("eprint").map(|value| value.trim()) {
        let candidate = eprint
            .trim_start_matches("arXiv:")
            .trim_start_matches("arxiv:");
        if looks_like_id(candidate) {
            return Some(candidate.to_string());
        }
    }
    let pattern = Regex::new(r"arxiv\.org/(?:abs|pdf)/([^\s,}]+?)(?:v\d+)?(?:\.pdf)?$").ok()?;
    for field in ["url", "doi", "note", "howpublished"] {
        let Some(value) = fields.get(field) else {
            continue;
        };
        if let Some(capture) = pattern.captures(value.trim()) {
            return Some(capture[1].to_string());
        }
        if let Some(rest) = value.trim().strip_prefix("10.48550/arXiv.") {
            return Some(rest.to_string());
        }
    }
    None
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
    scan_files(root)
}

fn search_files_linear(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    let terms = search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    search_file_nodes_multi(root, &scan_files(root)?, &terms, &mut results)?;
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
        if content.is_empty() {
            continue;
        }
        for (index, line) in content.lines().enumerate() {
            if !matches_search(line, terms) {
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
                line: Some((index + 1) as u32),
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

fn searchable_text_path(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("tex" | "bib" | "sty" | "cls" | "md" | "txt")
    )
}

pub fn create_entry(root: &Path, relative: &str, kind: &str) -> Result<String, String> {
    validate_user_entry(relative)?;
    let normalized = match kind {
        "file" => normalize_source_path(relative)?,
        "folder" => relative.trim().to_string(),
        _ => return Err("Choose a source file or folder.".to_string()),
    };
    let path = safe_path(root, &normalized)?;
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
    if source.is_file() && !is_visible_source(Path::new(&normalized_name)) {
        return Err("Keep a supported project file extension when renaming this file.".to_string());
    }

    let parent = Path::new(relative)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let destination_relative = parent.join(&normalized_name).to_string_lossy().to_string();
    if destination_relative == relative {
        return Ok(destination_relative);
    }
    let destination = safe_path(root, &destination_relative)?;
    if destination.exists() {
        return Err("A file or folder already exists with that name.".to_string());
    }

    let original_manifest = read_manifest(root)?;
    let mut updated_manifest = original_manifest.clone();
    for document in &mut updated_manifest.root_documents {
        document.path = renamed_relative_path(&document.path, relative, &destination_relative);
    }
    updated_manifest.primary_bibliography = renamed_relative_path(
        &updated_manifest.primary_bibliography,
        relative,
        &destination_relative,
    );

    fs::rename(&source, &destination).map_err(err)?;
    if let Err(error) = write_manifest(root, &updated_manifest) {
        let _ = fs::rename(&destination, &source);
        let _ = write_manifest(root, &original_manifest);
        return Err(error);
    }
    Ok(destination_relative)
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
    Ok(destination
        .strip_prefix(root)
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
    let direct = commands::command("bibcite")
        .args(["get", "--json", query])
        .output();
    match direct {
        Ok(output) => Ok(output),
        Err(_) => commands::command("uvx")
            .env("UV_CACHE_DIR", "/tmp/research-writer-uv-cache")
            .args(["--from", "bibcite-cli", "bibcite", "get", "--json", query])
            .output()
            .map_err(|error| crate::papers::uv_tool_spawn_error("bibcite", &error)),
    }
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
    let bytes = bibliography.as_bytes();
    let target = target_key.trim().to_ascii_lowercase();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let relative_start = bibliography[cursor..].find('@')?;
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
        let key = bibliography[key_start..position]
            .trim()
            .to_ascii_lowercase();
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
        if key == target {
            return Some((at, entry_end));
        }
    }
    None
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
    apply_transaction(
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
    validate_user_entry(target_directory)?;
    if sources.is_empty() {
        return Err("Drop one or more image files first.".to_string());
    }
    let target = safe_path(root, target_directory)?;
    if !target.is_dir() {
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
                .strip_prefix(root)
                .map_err(err)?
                .to_string_lossy()
                .to_string(),
        );
    }
    Ok(imported)
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
    let path = safe_path(root, &relative)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(path, bytes).map_err(err)
}

pub fn read_asset(root: &Path, relative: &str) -> Result<AssetPreview, String> {
    let path = safe_path(root, relative)?;
    if !path.is_file() || !is_supported_asset(&path) {
        return Err("Choose an image or PDF from the project.".to_string());
    }
    let size = fs::metadata(&path).map_err(err)?.len();
    if size > 50 * 1024 * 1024 {
        return Err(
            "This figure is too large to preview inside Lattice (50 MB maximum).".to_string(),
        );
    }
    let mime_type = asset_mime_type(&path)
        .ok_or_else(|| "Lattice cannot preview this figure type.".to_string())?;
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
    let requested = directory.join(file_name);
    if !requested.exists() {
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
        if !candidate.exists() {
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

fn normalize_source_path(relative: &str) -> Result<String, String> {
    let path = Path::new(relative.trim());
    match path.extension().and_then(|extension| extension.to_str()) {
        None => Ok(path.with_extension("tex").to_string_lossy().to_string()),
        Some(extension)
            if matches!(
                extension.to_ascii_lowercase().as_str(),
                "tex" | "bib" | "md" | "sty" | "cls" | "txt"
            ) =>
        {
            Ok(path.to_string_lossy().to_string())
        }
        _ => Err("New source files must use .tex, .bib, .md, .sty, .cls, or .txt.".to_string()),
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
        Some("txt") => String::new(),
        _ => "% New LaTeX file\n".to_string(),
    }
}

pub fn delete_entry(root: &Path, relative: &str) -> Result<(), String> {
    validate_user_entry(relative)?;
    let manifest = read_manifest(root)?;
    let requested = Path::new(relative);
    let mut protected = manifest
        .root_documents
        .iter()
        .map(|document| document.path.as_str())
        .collect::<Vec<_>>();
    protected.push(&manifest.primary_bibliography);
    if protected.iter().any(|path| {
        let protected = Path::new(path);
        protected == requested || protected.starts_with(requested)
    }) {
        return Err("The primary manuscript and bibliography cannot be deleted.".to_string());
    }
    let path = safe_path(root, relative)?;
    if !path.exists() {
        return Err("That file or folder no longer exists.".to_string());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(err)
    } else {
        let before = fs::read_to_string(&path).ok();
        fs::remove_file(path).map_err(err)?;
        if let Some(before) = before {
            let record = TransactionRecord {
                id: format!(
                    "{}-{}",
                    Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
                    Uuid::new_v4()
                ),
                label: format!("Delete {relative}"),
                timestamp: Utc::now().to_rfc3339(),
                changes: vec![FileChange {
                    path: relative.to_string(),
                    before: Some(before),
                    after: None,
                }],
            };
            persist_transaction(root, &record)?;
        }
        Ok(())
    }
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

pub fn apply_transaction(
    root: &Path,
    label: &str,
    edits: Vec<(String, String)>,
) -> Result<TransactionRecord, String> {
    if edits.is_empty() {
        return Err("The transaction contains no edits.".to_string());
    }

    let mut changes = Vec::with_capacity(edits.len());
    for (relative, after) in &edits {
        if relative.starts_with(".research/history/") {
            return Err("History records cannot edit themselves.".to_string());
        }
        let path = safe_path(root, relative)?;
        let before = if path.exists() {
            Some(fs::read_to_string(&path).map_err(err)?)
        } else {
            None
        };
        changes.push(FileChange {
            path: relative.clone(),
            before,
            after: Some(after.clone()),
        });
    }

    for change in &changes {
        let path = safe_path(root, &change.path)?;
        if let Some(after) = &change.after {
            fs::write(path, after).map_err(err)?;
        }
    }

    if let Some(record) = coalesce_edit_transaction(root, label, &changes)? {
        return Ok(record);
    }

    let record = TransactionRecord {
        id: format!(
            "{}-{}",
            Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
            Uuid::new_v4()
        ),
        label: label.to_string(),
        timestamp: Utc::now().to_rfc3339(),
        changes,
    };
    persist_transaction(root, &record)?;
    Ok(record)
}

fn coalesce_edit_transaction(
    root: &Path,
    label: &str,
    changes: &[FileChange],
) -> Result<Option<TransactionRecord>, String> {
    if !label.starts_with("Edit ") || changes.len() != 1 {
        return Ok(None);
    }
    let Some(change) = changes.first() else {
        return Ok(None);
    };
    let Some(mut previous) = latest_history_record(root)? else {
        return Ok(None);
    };
    if previous.label != label || previous.changes.len() != 1 {
        return Ok(None);
    }
    if previous.changes[0].path != change.path {
        return Ok(None);
    }
    let Ok(previous_time) = chrono::DateTime::parse_from_rfc3339(&previous.timestamp) else {
        return Ok(None);
    };
    let age = Utc::now().signed_duration_since(previous_time.with_timezone(&Utc));
    if age.num_seconds() > EDIT_COALESCE_SECS {
        return Ok(None);
    }
    previous.changes[0].after = change.after.clone();
    previous.timestamp = Utc::now().to_rfc3339();
    let path = transaction_path(root, &previous.id)?;
    let raw = serde_json::to_string_pretty(&previous).map_err(err)?;
    fs::write(path, format!("{raw}\n")).map_err(err)?;
    Ok(Some(previous))
}

fn latest_history_record(root: &Path) -> Result<Option<TransactionRecord>, String> {
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

pub type TextSnapshot = BTreeMap<String, String>;

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

pub fn save_conversation_checkpoint(
    root: &Path,
    session_id: &str,
    message_id: &str,
) -> Result<(), String> {
    validate_checkpoint_id(session_id)?;
    validate_checkpoint_id(message_id)?;
    let path = checkpoint_path(root, session_id, message_id);
    fs::create_dir_all(path.parent().expect("checkpoint path has a parent")).map_err(err)?;
    let snapshot = snapshot_text_files(root)?;
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&snapshot).map_err(err)?
        ),
    )
    .map_err(err)
}

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
    restore_text_snapshot(root, &target, "Restore files for conversation branch")
}

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

fn restore_text_snapshot(
    root: &Path,
    target: &TextSnapshot,
    label: &str,
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
    let record = TransactionRecord {
        id: format!(
            "{}-{}",
            Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
            Uuid::new_v4()
        ),
        label: label.to_string(),
        timestamp: Utc::now().to_rfc3339(),
        changes,
    };
    persist_transaction(root, &record)?;
    Ok(Some(record))
}

fn checkpoint_path(root: &Path, session_id: &str, message_id: &str) -> PathBuf {
    root.join(".research/checkpoints")
        .join(session_id)
        .join(format!("{message_id}.json"))
}

fn validate_checkpoint_id(value: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| "Invalid conversation checkpoint id.".to_string())
}

pub fn record_external_changes(
    root: &Path,
    before: &TextSnapshot,
    label: &str,
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
    let record = TransactionRecord {
        id: format!(
            "{}-{}",
            Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
            Uuid::new_v4()
        ),
        label: label.to_string(),
        timestamp: Utc::now().to_rfc3339(),
        changes,
    };
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
                records.push(HistoryItem {
                    id: record.id,
                    label: record.label,
                    timestamp: record.timestamp,
                    files: record
                        .changes
                        .into_iter()
                        .map(|change| change.path)
                        .collect(),
                });
            }
        }
    }
    records.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(records)
}

pub fn revert(root: &Path, transaction_id: &str) -> Result<TransactionRecord, String> {
    let history_path = transaction_path(root, transaction_id)?;
    let raw = fs::read_to_string(&history_path).map_err(err)?;
    let source: TransactionRecord = serde_json::from_str(&raw).map_err(err)?;
    for change in &source.changes {
        let path = safe_path(root, &change.path)?;
        match &change.before {
            Some(content) => fs::write(path, content).map_err(err)?,
            None => {
                if path.exists() {
                    fs::remove_file(path).map_err(err)?;
                }
            }
        }
    }
    fs::remove_file(history_path).map_err(err)?;
    Ok(source)
}

pub fn revert_file(
    root: &Path,
    transaction_id: &str,
    relative: &str,
) -> Result<TransactionRecord, String> {
    let history_path = transaction_path(root, transaction_id)?;
    let raw = fs::read_to_string(&history_path).map_err(err)?;
    let source: TransactionRecord = serde_json::from_str(&raw).map_err(err)?;
    let change = source
        .changes
        .iter()
        .find(|change| change.path == relative)
        .ok_or_else(|| "That file is not part of this history entry.".to_string())?;
    let path = safe_path(root, &change.path)?;
    match &change.before {
        Some(content) => fs::write(path, content).map_err(err)?,
        None => {
            if path.exists() {
                fs::remove_file(path).map_err(err)?;
            }
        }
    }
    Ok(source)
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
                let preview = line.trim();
                let preview = if preview.len() > 120 {
                    format!("{}…", &preview[..120])
                } else {
                    preview.to_string()
                };
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
            return Ok((regex.replace_all(source, replacement).into_owned(), count));
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
    fs::remove_file(transaction_path(root, transaction_id)?).map_err(err)
}

pub fn get_history_entry(root: &Path, transaction_id: &str) -> Result<TransactionRecord, String> {
    let history_path = transaction_path(root, transaction_id)?;
    if !history_path.is_file() {
        return Err("That history entry no longer exists.".to_string());
    }
    let raw = fs::read_to_string(history_path).map_err(err)?;
    serde_json::from_str(&raw).map_err(err)
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
    let directory = root.join(".research/history");
    fs::create_dir_all(&directory).map_err(err)?;
    let raw = serde_json::to_string_pretty(record).map_err(err)?;
    fs::write(
        directory.join(format!("{}.json", record.id)),
        format!("{raw}\n"),
    )
    .map_err(err)?;
    prune_history(&directory, MAX_HISTORY_ENTRIES)
}

fn prune_history(directory: &Path, limit: usize) -> Result<(), String> {
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

fn scan_files(root: &Path) -> Result<Vec<FileNode>, String> {
    fn visit(root: &Path, directory: &Path) -> Result<Vec<FileNode>, String> {
        let mut nodes = Vec::new();
        for entry in fs::read_dir(directory).map_err(err)? {
            let entry = entry.map_err(err)?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || is_build_artifact(&path) {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .map_err(err)?
                .to_string_lossy()
                .to_string();
            if path.is_dir() {
                let children = visit(root, &path)?;
                nodes.push(FileNode {
                    name,
                    path: relative,
                    kind: "directory".to_string(),
                    children,
                });
            } else if is_visible_source(&path) {
                nodes.push(FileNode {
                    name,
                    path: relative,
                    kind: file_kind(&path).to_string(),
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
        });
        Ok(nodes)
    }
    visit(root, root)
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
        Some("bst") => "text",
        Some("png" | "jpg" | "jpeg" | "pdf" | "svg" | "eps" | "webp") => "figure",
        _ => "text",
    }
}

fn is_visible_source(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(
            "tex"
                | "bib"
                | "md"
                | "txt"
                | "sty"
                | "cls"
                | "bst"
                | "png"
                | "jpg"
                | "jpeg"
                | "pdf"
                | "svg"
                | "eps"
                | "webp"
        )
    )
}

fn is_build_artifact(path: &Path) -> bool {
    if path.extension().is_some_and(|ext| ext == "pdf") && path.with_extension("tex").exists() {
        return true;
    }
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("aux" | "bbl" | "blg" | "fls" | "fdb_latexmk" | "log" | "out" | "gz")
    )
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
    fn rejects_parent_traversal() {
        let root = temp_root("safe-path");
        assert!(safe_path(&root, "../secret.txt").is_err());
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
        .unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "after");
        revert(&root, &transaction.id).unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "before");
        assert!(history(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
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

        let transaction = record_external_changes(&root, &before, "Agent edit")
            .unwrap()
            .unwrap();
        assert_eq!(transaction.changes.len(), 3);
        revert(&root, &transaction.id).unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "before");
        assert_eq!(
            fs::read_to_string(root.join("removed.tex")).unwrap(),
            "remove me"
        );
        assert!(!root.join("created.tex").exists());
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
        assert!(root.join(".research/pdf-annotations.json").is_file());
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
        assert!(create_entry(&root, "binary.exe", "file").is_err());
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
    fn project_figures_can_be_previewed_and_prepared_for_latex() {
        let parent = temp_root("preview-assets");
        let root = create(&parent, "paper").unwrap();
        let png = root.join("figures/result.png");
        fs::write(&png, b"png-bytes").unwrap();
        let preview = read_asset(&root, "figures/result.png").unwrap();
        assert_eq!(preview.path, "figures/result.png");
        assert_eq!(preview.mime_type, "image/png");
        assert_eq!(preview.base64, "cG5nLWJ5dGVz");
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
        )
        .unwrap();
        assert_eq!(updated.engine, "xelatex");
        assert!(updated.trusted);
        assert_eq!(updated.word_budget, Some(5000));
        assert_eq!(updated.page_budget, Some(9));
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
