use crate::models::{
    FileChange, FileNode, HistoryItem, ProjectManifest, ProjectSnapshot, RootDocument,
    TransactionRecord,
};
use chrono::Utc;
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;
use walkdir::WalkDir;

const MANIFEST_PATH: &str = ".research/project.json";

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
    fs::create_dir_all(root.join("figures")).map_err(err)?;

    let manifest = default_manifest(safe_name);
    write_manifest(&root, &manifest)?;
    fs::write(root.join(".research/brief.md"), default_brief(safe_name)).map_err(err)?;
    fs::write(root.join("main.tex"), default_tex(safe_name)).map_err(err)?;
    fs::write(root.join("references.bib"), "").map_err(err)?;
    fs::write(root.join(".gitignore"), ".research/history/\n.research/cache/\n*.aux\n*.bbl\n*.blg\n*.fdb_latexmk\n*.fls\n*.log\n*.out\n*.synctex.gz\n").map_err(err)?;
    Ok(root)
}

pub fn open(root: &Path) -> Result<ProjectSnapshot, String> {
    let root = root.canonicalize().map_err(err)?;
    if !root.is_dir() {
        return Err("The selected path is not a folder.".to_string());
    }

    fs::create_dir_all(root.join(".research/history")).map_err(err)?;
    fs::create_dir_all(root.join(".research/papers")).map_err(err)?;

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
                if !children.is_empty() {
                    nodes.push(FileNode {
                        name,
                        path: relative,
                        kind: "directory".to_string(),
                        children,
                    });
                }
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
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("tex") => "tex",
        Some("bib") => "bib",
        Some("md") => "markdown",
        Some("png" | "jpg" | "jpeg" | "pdf" | "svg") => "figure",
        _ => "text",
    }
}

fn is_visible_source(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("tex" | "bib" | "md" | "txt" | "sty" | "cls" | "png" | "jpg" | "jpeg" | "pdf" | "svg")
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
        "\\documentclass[11pt]{{article}}\n\\usepackage[margin=1in]{{geometry}}\n\\usepackage{{microtype}}\n\\usepackage{{hyperref}}\n\\usepackage{{graphicx}}\n\\usepackage[numbers]{{natbib}}\n\n\\title{{{title}}}\n\\author{{}}\n\\date{{}}\n\n\\begin{{document}}\n\\maketitle\n\n\\begin{{abstract}}\nDescribe the question, method, and primary result.\n\\end{{abstract}}\n\n\\section{{Introduction}}\nStart writing here.\n\n\\bibliographystyle{{plainnat}}\n\\bibliography{{references}}\n\\end{{document}}\n"
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
    fn new_project_titles_are_safe_latex() {
        assert_eq!(latex_title("R&D_100%"), "R\\&D\\_100\\%");
        assert_eq!(latex_title("科研"), "Untitled research");
    }
}
