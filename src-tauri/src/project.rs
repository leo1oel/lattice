use crate::models::{
    FileChange, FileNode, HistoryItem, ProjectManifest, ProjectSnapshot, RootDocument,
    TransactionRecord,
};
use chrono::Utc;
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;
use walkdir::WalkDir;

const MANIFEST_PATH: &str = ".research/project.json";
const RESEARCH_GITIGNORE: &str = "history/\nsessions/\npi-sessions/\ncache/\n";
const ARXIV_STYLE: &str = include_str!("../templates/arxiv-style/arxiv.sty");
const ARXIV_STYLE_LICENSE: &str = include_str!("../templates/arxiv-style/LICENSE");

pub fn default_manifest(name: &str) -> ProjectManifest {
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
    }
}

pub fn create(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let safe_name = name.trim();
    if safe_name.is_empty()
        || safe_name.contains('/')
        || safe_name.contains('\\')
        || safe_name == "."
        || safe_name == ".."
    {
        return Err("Choose a simple project name without path separators.".to_string());
    }

    let root = parent.join(safe_name);
    if root.exists() && fs::read_dir(&root).map_err(err)?.next().is_some() {
        return Err("That folder already exists and is not empty.".to_string());
    }

    fs::create_dir_all(root.join(".research/papers")).map_err(err)?;
    fs::create_dir_all(root.join(".research/history")).map_err(err)?;
    fs::create_dir_all(root.join(".research/sessions")).map_err(err)?;
    fs::create_dir_all(root.join(".research/pi-sessions")).map_err(err)?;
    fs::create_dir_all(root.join(".research/licenses")).map_err(err)?;
    fs::create_dir_all(root.join("figures")).map_err(err)?;

    let manifest = default_manifest(safe_name);
    write_manifest(&root, &manifest)?;
    fs::write(root.join(".research/brief.md"), default_brief(safe_name)).map_err(err)?;
    fs::write(root.join(".research/.gitignore"), RESEARCH_GITIGNORE).map_err(err)?;
    fs::write(
        root.join(".research/licenses/arxiv-style-MIT.txt"),
        ARXIV_STYLE_LICENSE,
    )
    .map_err(err)?;
    fs::write(root.join("main.tex"), default_tex(safe_name)).map_err(err)?;
    fs::write(root.join("arxiv.sty"), ARXIV_STYLE).map_err(err)?;
    fs::write(root.join("references.bib"), "").map_err(err)?;
    fs::write(root.join(".gitignore"), ".research/history/\n.research/sessions/\n.research/pi-sessions/\n.research/cache/\n/main.pdf\n*.aux\n*.bbl\n*.blg\n*.fdb_latexmk\n*.fls\n*.log\n*.out\n*.synctex.gz\n").map_err(err)?;
    Ok(root)
}

pub fn open(root: &Path) -> Result<ProjectSnapshot, String> {
    let root = root.canonicalize().map_err(err)?;
    if !root.is_dir() {
        return Err("The selected path is not a folder.".to_string());
    }

    fs::create_dir_all(root.join(".research/history")).map_err(err)?;
    fs::create_dir_all(root.join(".research/papers")).map_err(err)?;
    fs::create_dir_all(root.join(".research/sessions")).map_err(err)?;
    fs::create_dir_all(root.join(".research/pi-sessions")).map_err(err)?;
    if !root.join(".research/.gitignore").exists() {
        fs::write(root.join(".research/.gitignore"), RESEARCH_GITIGNORE).map_err(err)?;
    }

    let manifest = if root.join(MANIFEST_PATH).exists() {
        read_manifest(&root)?
    } else {
        let name = root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Research project");
        let mut manifest = default_manifest(name);
        if !root.join("main.tex").exists() {
            let first_tex = WalkDir::new(&root)
                .max_depth(3)
                .into_iter()
                .filter_map(Result::ok)
                .find(|entry| entry.path().extension().is_some_and(|ext| ext == "tex"));
            if let Some(entry) = first_tex {
                let relative = entry
                    .path()
                    .strip_prefix(&root)
                    .map_err(err)?
                    .to_string_lossy()
                    .to_string();
                manifest.root_documents[0].path = relative;
            }
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

    Ok(ProjectSnapshot {
        root: root.to_string_lossy().to_string(),
        manifest,
        files: scan_files(&root)?,
    })
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
    let manifest = read_manifest(root)?;
    let bibliography = read_file(root, &manifest.primary_bibliography)?;
    let entry = Regex::new(r"(?m)^\s*@[A-Za-z]+\s*\{\s*([^,\s]+)\s*,").unwrap();
    let mut keys = entry
        .captures_iter(&bibliography)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_string()))
        .collect::<Vec<_>>();
    keys.sort_by_key(|key| key.to_lowercase());
    keys.dedup();
    Ok(keys)
}

pub fn create_entry(root: &Path, relative: &str, kind: &str) -> Result<String, String> {
    validate_user_entry(relative)?;
    let normalized = match kind {
        "file" => normalize_latex_path(relative)?,
        "folder" => relative.trim().to_string(),
        _ => return Err("Choose a LaTeX file or folder.".to_string()),
    };
    let path = safe_path(root, &normalized)?;
    if path.exists() {
        return Err("A file or folder already exists at that path.".to_string());
    }
    match kind {
        "file" => {
            let content = "% New LaTeX file\n".to_string();
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

fn normalize_latex_path(relative: &str) -> Result<String, String> {
    let path = Path::new(relative.trim());
    match path.extension().and_then(|extension| extension.to_str()) {
        None => Ok(path.with_extension("tex").to_string_lossy().to_string()),
        Some(extension) if extension.eq_ignore_ascii_case("tex") => {
            Ok(path.to_string_lossy().to_string())
        }
        _ => Err("New source files must use the .tex extension.".to_string()),
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

pub fn delete_history(root: &Path, transaction_id: &str) -> Result<(), String> {
    fs::remove_file(transaction_path(root, transaction_id)?).map_err(err)
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
    .map_err(err)
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

fn default_tex(name: &str) -> String {
    let title = latex_title(name);
    format!(
        "\\documentclass{{article}}\n\n\\usepackage{{arxiv}}\n\\usepackage[utf8]{{inputenc}}\n\\usepackage[T1]{{fontenc}}\n\\usepackage{{amsmath,amssymb,amsfonts}}\n\\usepackage{{booktabs}}\n\\usepackage{{graphicx}}\n\\usepackage{{hyperref}}\n\\usepackage{{microtype}}\n\\usepackage{{natbib}}\n\\usepackage{{url}}\n\n\\title{{{title}}}\n\\author{{Author Name \\\\\nInstitution \\\\\n\\texttt{{author@example.com}}}}\n\\date{{}}\n\\renewcommand{{\\shorttitle}}{{{title}}}\n\n\\begin{{document}}\n\\maketitle\n\n\\begin{{abstract}}\nDescribe the research question, method, and primary result.\n\\end{{abstract}}\n\n\\keywords{{research \\and scientific writing}}\n\n\\section{{Introduction}}\nState the problem, why it matters, and the central hypothesis.\n\n\\section{{Related Work}}\nPosition the paper against the most relevant evidence.\n\n\\section{{Method}}\nDescribe the proposed method precisely enough to reproduce it.\n\n\\section{{Experiments}}\nDefine the evaluation protocol, baselines, and primary results.\n\n\\section{{Conclusion}}\nSummarize the supported claims and remaining limitations.\n\n\\bibliographystyle{{unsrtnat}}\n\\bibliography{{references}}\n\\end{{document}}\n"
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
    fn bibliography_keys_are_listed_for_editor_completion() {
        let parent = temp_root("citation-keys");
        let root = create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{vaswani2017attention,\n  title={Attention}\n}\n@inproceedings{dosovitskiy2021image,\n}\n",
        )
        .unwrap();
        assert_eq!(
            citation_keys(&root).unwrap(),
            vec!["dosovitskiy2021image", "vaswani2017attention"]
        );
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
        assert!(create_entry(&root, "notes.md", "file").is_err());
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
    fn new_project_titles_are_safe_latex() {
        assert_eq!(latex_title("R&D_100%"), "R\\&D\\_100\\%");
        assert_eq!(latex_title("科研"), "Untitled research");
    }

    #[test]
    fn new_projects_use_the_bundled_arxiv_style_template() {
        let parent = temp_root("arxiv-style-project");
        let root = create(&parent, "Elegant paper").unwrap();
        let source = fs::read_to_string(root.join("main.tex")).unwrap();
        assert!(source.contains("\\documentclass{article}"));
        assert!(source.contains("\\usepackage{arxiv}"));
        assert!(root.join("arxiv.sty").exists());
        assert!(root.join(".research/licenses/arxiv-style-MIT.txt").exists());
        fs::remove_dir_all(parent).unwrap();
    }
}
