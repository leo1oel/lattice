use crate::commands;
use crate::models::{ImportResult, PaperSummary, ProjectSearchResult};
use crate::project;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaperMetadata {
    arxiv_id: String,
    requested_arxiv_id: String,
    #[serde(default)]
    title: String,
    schema_version: u32,
    complete: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub arxiv_id: String,
    pub paper_path: String,
    pub blog_path: Option<String>,
    pub reused: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeResult {
    pub dry_run: bool,
    pub changed: bool,
    pub report: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub key: String,
    pub removed: bool,
    pub blockers: Vec<crate::models::SymbolOccurrence>,
}

#[derive(Clone, Copy)]
pub enum HistoryMode {
    Record,
    Defer,
}

/// Add a work to the project's bibliography, with its full text when we can
/// get it.
///
/// The box this comes from only took arXiv ids, so a DOI, a title, or a web
/// page had to be added through the bibliography editor instead — a second
/// place to do the same thing, which nobody would guess at. `bibcite` resolves
/// all of them, so the input goes to it either way; the arXiv branch exists
/// only because that is the case where a full text can also be fetched.
///
/// A work with no full text is not a lesser citation: it appears in Papers and
/// in the `.bib` exactly like the rest, just without anything to open.
pub fn import_reference(root: &Path, input: &str) -> Result<ImportResult, String> {
    import_reference_with_history(root, input, HistoryMode::Record)
}

pub(crate) fn import_reference_with_history(
    root: &Path,
    input: &str,
    history: HistoryMode,
) -> Result<ImportResult, String> {
    let manifest = project::read_manifest(root)?;
    import_citation(root, &manifest, input, history)
}

/// Cache a complete, unfiltered arxiv2md conversion without touching the bibliography.
pub fn fetch_paper(root: &Path, requested: &str) -> Result<FetchResult, String> {
    let requested =
        parse_arxiv_id(requested).ok_or_else(|| "Enter a valid arXiv id or URL.".to_string())?;
    validate_arxiv_id(&requested)?;
    let base = arxiv_base_id(&requested).to_string();
    let dir = project::safe_path(root, &format!(".research/papers/{base}"))?;
    let metadata_path = dir.join("metadata.json");
    let valid = fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<PaperMetadata>(&raw).ok())
        .is_some_and(|m| {
            m.schema_version == 1
                && m.complete
                && m.arxiv_id.eq_ignore_ascii_case(&base)
                && dir.join("paper.md").is_file()
                && (requested == base || m.requested_arxiv_id.eq_ignore_ascii_case(&requested))
        });
    if valid {
        return Ok(FetchResult {
            arxiv_id: base.clone(),
            paper_path: format!(".research/papers/{base}/paper.md"),
            blog_path: dir
                .join("blog.md")
                .is_file()
                .then(|| format!(".research/papers/{base}/blog.md")),
            reused: true,
        });
    }
    let papers_root = project::safe_path(root, ".research/papers")?;
    fs::create_dir_all(&papers_root).map_err(err)?;
    let temp_root = papers_root.join(format!(".fetch-{}", Uuid::new_v4()));
    let output_dir = temp_root.join("output");
    fs::create_dir_all(&output_dir).map_err(err)?;
    let output_path = output_dir.join("paper.md");
    let output = commands::ARXIV2MD
        .command()
        .current_dir(&output_dir)
        .arg(&requested)
        .arg("--frontmatter")
        .arg("-o")
        .arg(&output_path)
        .output()
        .map_err(|e| uv_tool_spawn_error("arxiv2md", &e))?;
    ensure_success("arxiv2md", &output)?;
    if !output_path.is_file() {
        return Err("arxiv2md did not produce paper.md".to_string());
    }
    let title = parse_title(&fs::read_to_string(&output_path).map_err(err)?)
        .unwrap_or_else(|| format!("arXiv {base}"));
    let metadata = PaperMetadata {
        arxiv_id: base.clone(),
        requested_arxiv_id: requested,
        title,
        schema_version: 1,
        complete: true,
    };
    fs::write(
        output_dir.join("metadata.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&metadata).map_err(err)?
        ),
    )
    .map_err(err)?;
    if let Ok(Some(blog)) = crate::alphaxiv::fetch_overview(&base) {
        fs::write(output_dir.join("blog.md"), blog).map_err(err)?;
    }
    fs::create_dir_all(dir.parent().unwrap()).map_err(err)?;
    let backup = dir.with_extension(format!("old-{}", Uuid::new_v4()));
    if dir.exists() {
        fs::rename(&dir, &backup).map_err(err)?;
    }
    if let Err(e) = fs::rename(&output_dir, &dir) {
        if backup.exists() {
            let _ = fs::rename(&backup, &dir);
        }
        return Err(err(e));
    }
    let _ = fs::remove_dir_all(backup);
    let _ = fs::remove_dir_all(temp_root);
    Ok(FetchResult {
        arxiv_id: base.clone(),
        paper_path: format!(".research/papers/{base}/paper.md"),
        blog_path: dir
            .join("blog.md")
            .is_file()
            .then(|| format!(".research/papers/{base}/blog.md")),
        reused: false,
    })
}

pub(crate) fn arxiv_base_id(arxiv_id: &str) -> &str {
    match arxiv_id.rsplit_once('v') {
        Some((base, version))
            if !base.is_empty() && version.chars().all(|c| c.is_ascii_digit()) =>
        {
            base
        }
        _ => arxiv_id,
    }
}

/// Everything the project cites, whether or not its full text was fetched.
///
/// Citations and downloaded papers used to be separate worlds: only a directory
/// under `.research/papers` holding a `paper.md` counted, so anything the agent
/// added through bibcite — and anything without an arXiv id at all — was
/// invisible here while sitting in the bibliography. Read both and join them on
/// the citation key.
pub fn list_papers(root: &Path) -> Result<Vec<PaperSummary>, String> {
    let mut imported = imported_papers(root)?;
    let mut papers = Vec::new();
    let manifest = project::read_manifest(root)?;
    let bibliography =
        fs::read_to_string(project::safe_path(root, &manifest.primary_bibliography)?)
            .unwrap_or_default();
    for citation in project::parse_bibliography(&bibliography) {
        // Join on either identifier. Keying on the citation key alone missed
        // every paper whose metadata.json predates that field or whose key was
        // later rewritten: the fetched text sat right there while the row
        // claimed the work had none and offered to download it again.
        let matched = imported
            .iter()
            .position(|(id, _metadata)| {
                let by_arxiv = citation.arxiv_id.as_deref().is_some_and(|cited| {
                    arxiv_base_id(cited).eq_ignore_ascii_case(arxiv_base_id(id))
                });
                by_arxiv
            })
            .map(|index| imported.remove(index));
        let title = if !citation.title.trim().is_empty() {
            citation.title.clone()
        } else {
            citation.key.clone()
        };
        papers.push(PaperSummary {
            // Keep whichever id can actually fetch the text: the imported one,
            // else whatever the bibliography entry points at.
            arxiv_id: matched
                .as_ref()
                .map(|(id, _)| id.clone())
                .or(citation.arxiv_id)
                .unwrap_or_default(),
            title,
            citation_key: Some(citation.key),
            has_full_text: matched.is_some(),
        });
    }
    // The bibliography is strictly authoritative; unclaimed cache entries stay hidden.
    papers.sort_by_key(|paper| paper.title.to_lowercase());
    Ok(papers)
}

/// Directories under `.research/papers` that hold a fetched `paper.md`.
fn imported_papers(root: &Path) -> Result<Vec<(String, PaperMetadata)>, String> {
    let directory = root.join(".research/papers");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut imported = Vec::new();
    for paper_directory in paper_cache_directories(&directory)? {
        let markdown_path = paper_directory.join("paper.md");
        let arxiv_id = paper_directory
            .strip_prefix(&directory)
            .map_err(err)?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let markdown = fs::read_to_string(markdown_path).map_err(err)?;
        // Legacy or externally supplied text may have no metadata. Keep it
        // readable, but do not treat it as a complete reusable tool cache.
        let metadata = fs::read_to_string(paper_directory.join("metadata.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<PaperMetadata>(&raw).ok())
            .unwrap_or_else(|| PaperMetadata {
                arxiv_id: arxiv_id.clone(),
                requested_arxiv_id: String::new(),
                title: parse_title(&markdown).unwrap_or_default(),
                schema_version: 0,
                complete: false,
            });
        imported.push((arxiv_id, metadata));
    }
    Ok(imported)
}

fn paper_cache_directories(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut found = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        if !entry.file_type().map_err(err)?.is_dir() {
            continue;
        }
        let path = entry.path();
        if path.join("paper.md").is_file() {
            found.push(path);
        } else {
            // Legacy arXiv ids contain one slash (`archive/YYMMNNN`). Inspect
            // exactly that second level and never follow symlinks.
            for child in fs::read_dir(&path).map_err(err)? {
                let child = child.map_err(err)?;
                if child.file_type().map_err(err)?.is_dir()
                    && child.path().join("paper.md").is_file()
                {
                    found.push(child.path());
                }
            }
        }
    }
    Ok(found)
}

pub fn search_papers(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    let terms = project::search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    for paper in list_papers(root)? {
        if project::matches_search(&paper.title, &terms) {
            results.push(ProjectSearchResult {
                kind: "paper".to_string(),
                path: format!(".research/papers/{}/paper.md", paper.arxiv_id),
                title: paper.title,
                snippet: String::new(),
                line: None,
                arxiv_id: Some(paper.arxiv_id),
                file_kind: None,
            });
        }
    }
    results.truncate(60);
    Ok(results)
}

pub fn read_paper(root: &Path, arxiv_id: &str) -> Result<String, String> {
    validate_arxiv_id(arxiv_id)?;
    project::read_file(root, &format!(".research/papers/{arxiv_id}/paper.md"))
}

/// The alphaXiv overview ("blog") for an imported paper. Returns the stored
/// `blog.md` when present; otherwise backfills it once from alphaXiv (covering
/// papers imported before blogs existed, or whose import-time fetch failed) and
/// caches it. `Ok(None)` when alphaXiv has no report for the paper.
pub fn read_paper_blog(root: &Path, arxiv_id: &str) -> Result<Option<String>, String> {
    validate_arxiv_id(arxiv_id)?;
    let blog_path = project::safe_path(root, &format!(".research/papers/{arxiv_id}/blog.md"))?;
    if blog_path.exists() {
        return fs::read_to_string(&blog_path).map(Some).map_err(err);
    }
    // Only backfill papers we actually hold; the reader has nothing to show for
    // a cite-only work, and we would not have a directory to cache into.
    let paper_dir = project::safe_path(root, &format!(".research/papers/{arxiv_id}"))?;
    if !paper_dir.exists() {
        return Ok(None);
    }
    match crate::alphaxiv::fetch_overview(arxiv_id)? {
        Some(blog) => {
            fs::write(&blog_path, &blog).map_err(err)?;
            Ok(Some(blog))
        }
        None => Ok(None),
    }
}

/// Remove only the primary bibliography entry, retaining any downloaded cache.
pub fn remove_reference(root: &Path, key: &str) -> Result<RemoveResult, String> {
    remove_reference_with_history(root, key, HistoryMode::Record)
}

pub(crate) fn remove_reference_with_history(
    root: &Path,
    key: &str,
    history: HistoryMode,
) -> Result<RemoveResult, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter a citation key to remove.".to_string());
    }
    let blockers = citation_blockers(root, key)?;
    if !blockers.is_empty() {
        return Ok(RemoveResult {
            key: key.to_string(),
            removed: false,
            blockers,
        });
    }
    let manifest = project::read_manifest(root)?;
    let path = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = fs::read_to_string(&path).unwrap_or_default();
    let exact_key = project::parse_bibliography(&before)
        .into_iter()
        .find(|entry| entry.key.eq_ignore_ascii_case(key))
        .map(|entry| entry.key)
        .ok_or_else(|| format!("Citation key `{key}` is not in the primary bibliography."))?;
    let temp = std::env::temp_dir().join(format!("lattice-remove-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).map_err(err)?;
    let copy = temp.join("references.bib");
    fs::write(&copy, &before).map_err(err)?;
    run_bibcite_remove(&copy, &exact_key)?;
    let after = fs::read_to_string(&copy).map_err(err)?;
    let _ = fs::remove_dir_all(temp);
    commit_bibliography(
        root,
        &manifest.primary_bibliography,
        &after,
        &format!("Remove {exact_key}"),
        history,
    )?;
    Ok(RemoveResult {
        key: exact_key,
        removed: true,
        blockers: Vec::new(),
    })
}

fn citation_blockers(
    root: &Path,
    key: &str,
) -> Result<Vec<crate::models::SymbolOccurrence>, String> {
    project::find_citation_usages(root, key)
}

pub fn upgrade_bibliography(root: &Path, dry_run: bool) -> Result<UpgradeResult, String> {
    upgrade_bibliography_with_history(root, dry_run, HistoryMode::Record)
}

pub(crate) fn upgrade_bibliography_with_history(
    root: &Path,
    dry_run: bool,
    history: HistoryMode,
) -> Result<UpgradeResult, String> {
    let manifest = project::read_manifest(root)?;
    let path = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = fs::read_to_string(&path).unwrap_or_default();
    let temp = std::env::temp_dir().join(format!("lattice-upgrade-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).map_err(err)?;
    let copy = temp.join("references.bib");
    fs::write(&copy, &before).map_err(err)?;
    let mut command = commands::BIBCITE.command();
    command.arg("upgrade").arg("--no-tidy").arg(&copy);
    if dry_run {
        command.arg("--dry-run");
    }
    let output = command
        .output()
        .map_err(|e| uv_tool_spawn_error("bibcite", &e))?;
    ensure_success("bibcite", &output)?;
    let report = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("bibcite returned an invalid JSON report: {error}"))?;
    let mut after = fs::read_to_string(&copy).map_err(err)?;
    if !dry_run && after != before {
        run_bibcite_tidy(&copy)?;
        after = fs::read_to_string(&copy).map_err(err)?;
        commit_bibliography(
            root,
            &manifest.primary_bibliography,
            &after,
            "Upgrade bibliography",
            history,
        )?;
    }
    let _ = fs::remove_dir_all(temp);
    Ok(UpgradeResult {
        dry_run,
        changed: after != before,
        report,
    })
}

fn validate_arxiv_id(arxiv_id: &str) -> Result<(), String> {
    if Regex::new(r"(?i)^\d{4}\.\d{4,5}(v\d+)?$|^[a-z-]+(?:\.[a-z]{2})?/\d{7}(v\d+)?$")
        .unwrap()
        .is_match(arxiv_id)
    {
        Ok(())
    } else {
        Err("Invalid arXiv id.".to_string())
    }
}

/// An arXiv id inside whatever was typed, if there is one.
///
/// The word boundaries matter now that anything else is a valid entry: without
/// them the digits inside a DOI like `10.1145/3292500.3330701` match the
/// modern arXiv shape, and the app would go and look for a paper that does not
/// exist instead of asking bibcite to resolve the DOI.
fn parse_arxiv_id(input: &str) -> Option<String> {
    let pattern =
        Regex::new(r"(?i)\b(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?)\b")
            .unwrap();
    pattern
        .captures(input.trim())
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str().to_string())
}

/// Everything that is not an arXiv paper: resolve it, write the `.bib` entry,
/// and stop there. There is no text to fetch and none is pretended.
fn import_citation(
    root: &Path,
    manifest: &crate::models::ProjectManifest,
    query: &str,
    history: HistoryMode,
) -> Result<ImportResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Enter an arXiv id, a DOI, a URL, or a paper title.".to_string());
    }
    let temp = std::env::temp_dir().join(format!("research-writer-cite-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).map_err(err)?;
    let bibliography_path = temp.join("references.bib");
    let project_bibliography = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = if project_bibliography.exists() {
        fs::read_to_string(&project_bibliography).map_err(err)?
    } else {
        String::new()
    };
    fs::write(&bibliography_path, &before).map_err(err)?;

    let citation_output = run_bibcite(&bibliography_path, query)?;
    let bibliography = fs::read_to_string(&bibliography_path).map_err(err)?;
    let citation_key = parse_citation_key(&citation_output)
        .ok_or_else(|| "bibcite did not return a citation key.".to_string())?;
    // Whether the work was already cited, asked of the bibliography rather
    // than of the file's bytes: bibcite may tidy an entry it decides to keep,
    // and a reformat is not a new reference.
    let already_imported = project::parse_bibliography(&before)
        .iter()
        .any(|entry| entry.key.eq_ignore_ascii_case(&citation_key));
    let resolved_entry = project::parse_bibliography(&bibliography)
        .into_iter()
        .find(|entry| entry.key.eq_ignore_ascii_case(&citation_key))
        .ok_or_else(|| "bibcite reported a key absent from its bibliography.".to_string())?;
    let title = Some(resolved_entry.title.clone())
        .filter(|title| !title.trim().is_empty())
        .or_else(|| Some(citation_key.clone()))
        .unwrap_or_else(|| query.to_string());
    // A DOI/title may resolve to an entry carrying an arXiv eprint. Attach its
    // cache only after bibcite has told us the identity; fetching never edits
    // the bibliography itself.
    let resolved_arxiv = resolved_entry.arxiv_id;
    let fetched = match resolved_arxiv.as_deref() {
        Some(id) => Some(fetch_paper(root, id)?),
        None => None,
    };
    if bibliography != before {
        commit_bibliography(
            root,
            &manifest.primary_bibliography,
            &bibliography,
            &format!("Cite {citation_key}"),
            history,
        )?;
    }
    let _ = fs::remove_dir_all(&temp);
    Ok(ImportResult {
        arxiv_id: resolved_arxiv.unwrap_or_default(),
        title,
        paper_path: fetched.map(|item| item.paper_path).unwrap_or_default(),
        citation_key: Some(citation_key),
        citation_output,
        already_imported,
    })
}

fn run_bibcite(path: &PathBuf, query: &str) -> Result<String, String> {
    let output = commands::BIBCITE
        .command()
        .arg("add")
        .arg("--no-tidy")
        .arg(path)
        .arg(query)
        .output()
        .map_err(|error| uv_tool_spawn_error("bibcite", &error))?;
    ensure_success("bibcite", &output)?;
    let report = String::from_utf8(output.stdout).map_err(err)?;
    serde_json::from_str::<Value>(&report)
        .map_err(|error| format!("bibcite returned an invalid JSON report: {error}"))?;
    run_bibcite_tidy(path)?;
    Ok(report)
}

fn run_bibcite_remove(path: &PathBuf, key: &str) -> Result<(), String> {
    let output = commands::BIBCITE
        .command()
        .arg("remove")
        .arg("--no-tidy")
        .arg(path)
        .arg(key)
        .output()
        .map_err(|error| uv_tool_spawn_error("bibcite", &error))?;
    ensure_success("bibcite", &output)?;
    serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|error| format!("bibcite returned an invalid JSON report: {error}"))?;
    run_bibcite_tidy(path)
}

fn run_bibcite_tidy(path: &Path) -> Result<(), String> {
    let output = commands::BIBCITE
        .command()
        .arg("tidy")
        .arg(path)
        .output()
        .map_err(|error| uv_tool_spawn_error("bibcite", &error))?;
    ensure_success("bibcite tidy", &output)
}

fn commit_bibliography(
    root: &Path,
    relative: &str,
    contents: &str,
    label: &str,
    history: HistoryMode,
) -> Result<(), String> {
    match history {
        HistoryMode::Record => {
            project::apply_transaction(
                root,
                label,
                vec![(relative.to_string(), contents.to_string())],
            )?;
        }
        HistoryMode::Defer => {
            fs::write(project::safe_path(root, relative)?, contents).map_err(err)?;
        }
    }
    Ok(())
}

/// The citation key bibcite settled on, out of its report.
///
/// It prints one indented JSON object on stdout and its diagnostics on stderr,
/// so reading this a line at a time — as this did — never parsed anything: not
/// one line of `{\n  "key": "he2016deep",\n …}` is valid JSON on its own. Every
/// import has been recording a null key since, which is why the Papers list
/// carries a fallback that joins a paper to its citation by arXiv id, and why
/// a work with no arXiv id could not be joined at all.
///
/// Each balanced object is tried, newest first, so a run that reports several
/// entries still yields the last key.
fn parse_citation_key(output: &str) -> Option<String> {
    json_objects(output).into_iter().rev().find_map(|chunk| {
        serde_json::from_str::<Value>(&chunk)
            .ok()?
            .get("key")
            .and_then(Value::as_str)
            .map(ToString::to_string)
    })
}

/// Every brace-balanced `{…}` in the text, in order. Braces inside strings do
/// not count, or a title containing one would end the object early.
fn json_objects(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = index;
                }
                depth += 1;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    found.push(text[start..index + character.len_utf8()].to_string());
                }
            }
            _ => {}
        }
    }
    found
}

fn parse_title(markdown: &str) -> Option<String> {
    // With --frontmatter, arxiv2md's clean title is the YAML `title:` field;
    // older output carried a plain `Title:` line. Prefer the frontmatter.
    yaml_frontmatter_title(markdown).or_else(|| {
        markdown.lines().find_map(|line| {
            line.strip_prefix("Title:")
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(ToString::to_string)
        })
    })
}

fn yaml_frontmatter_title(markdown: &str) -> Option<String> {
    let mut lines = markdown.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix("title:") {
            let value = rest.trim().trim_matches('"').trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn ensure_success(name: &str, output: &Output) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{name} failed.\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Importing arXiv papers shells out to `uvx` (arxiv2markdown + bibcite-cli).
/// When uv isn't installed the raw spawn error ("No such file or directory") is
/// baffling, so point the user straight at the installer.
pub(crate) fn uv_tool_spawn_error(tool: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "Adding arXiv papers needs the `uv` tool, which isn't installed yet. \
Install it from Settings → TeX doctor → Open install guide (or run `brew install uv`), then try again."
            .to_string()
    } else {
        format!("Could not start {tool}: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// bibcite reports one indented JSON object and its diagnostics around it.
    /// Read a line at a time this parsed nothing at all, so every import
    /// recorded a null citation key while bibcite had returned one.
    #[test]
    fn reads_the_citation_key_out_of_bibcites_report() {
        let output = "{\n  \"query\": \"10.1109/CVPR.2016.90\",\n  \"action\": \"added\",\n  \
             \"key\": \"he2016deep\",\n  \"title\": \"Deep Residual Learning\",\n  \
             \"published\": true\n}\n[bibcite] query understood as doi: 10.1109/CVPR.2016.90\n";
        assert_eq!(parse_citation_key(output).as_deref(), Some("he2016deep"));
    }

    #[test]
    fn takes_the_last_key_when_several_entries_are_reported() {
        let output = "{\"key\": \"first2020\"}\nnoise\n{\n  \"key\": \"second2021\"\n}\n";
        assert_eq!(parse_citation_key(output).as_deref(), Some("second2021"));
    }

    /// A brace inside a title must not close the object early, or the key
    /// after it is never seen.
    #[test]
    fn is_not_confused_by_braces_inside_strings() {
        let output = "{\n  \"title\": \"On {NP}-hardness\",\n  \"key\": \"karp1972\"\n}\n";
        assert_eq!(parse_citation_key(output).as_deref(), Some("karp1972"));
    }

    #[test]
    fn reports_no_key_when_bibcite_found_nothing() {
        assert_eq!(
            parse_citation_key("[bibcite] No match found anywhere for: x\n"),
            None
        );
    }

    #[test]
    fn accepts_urls_and_ids() {
        assert_eq!(
            parse_arxiv_id("https://arxiv.org/abs/2401.12345").unwrap(),
            "2401.12345"
        );
        assert_eq!(parse_arxiv_id("2401.12345v2").unwrap(), "2401.12345v2");
        assert_eq!(parse_arxiv_id("not a paper"), None);
    }

    /// Anything that is not an arXiv paper has to reach bibcite untouched.
    /// The digits inside a DOI have the shape of a modern arXiv id, and
    /// without word boundaries `10.1145/3292500.3330701` matched — so the app
    /// went looking for a paper that does not exist instead of resolving it.
    #[test]
    fn does_not_mistake_a_doi_or_a_title_for_an_arxiv_id() {
        assert_eq!(parse_arxiv_id("10.1145/3292500.3330701"), None);
        assert_eq!(
            parse_arxiv_id("https://doi.org/10.1038/s41586-021-03819-2"),
            None
        );
        assert_eq!(parse_arxiv_id("Attention Is All You Need"), None);
        assert_eq!(
            parse_arxiv_id("https://example.edu/blog/2024/some-post"),
            None
        );
        // Longer than any arXiv id, so it is not one with the tail ignored.
        assert_eq!(parse_arxiv_id("2401.123456789"), None);
        // Still found inside a real URL, which is what people paste.
        assert_eq!(
            parse_arxiv_id("see https://arxiv.org/pdf/2401.12345v3 for details").unwrap(),
            "2401.12345v3"
        );
    }

    #[test]
    fn extracts_the_paper_title_from_arxiv_markdown() {
        assert_eq!(
            parse_title("Title: Attention Is All You Need\nArXiv: 1706.03762\n"),
            Some("Attention Is All You Need".to_string())
        );
    }

    #[test]
    fn extracts_the_title_from_yaml_frontmatter() {
        let markdown =
            "---\ntitle: \"Attention Is All You Need\"\nsections: 28\n---\n\n## Contents\n";
        assert_eq!(
            parse_title(markdown),
            Some("Attention Is All You Need".to_string())
        );
    }

    #[test]
    fn lists_cited_works_even_when_only_the_bibliography_knows_them() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-list-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        // Two citations; only the first was ever fetched.
        fs::write(
            root.join("references.bib"),
            "@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  eprint = {1706.03762}\n}\n\
             @article{kingma2015adam,\n  title = {Adam: A Method for Stochastic Optimization},\n  eprint = {1412.6980}\n}\n",
        )
        .unwrap();
        let directory = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("paper.md"),
            "Title: Attention Is All You Need\n",
        )
        .unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":"vaswani2017attention"}"#,
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 2, "got: {papers:?}");

        let adam = papers
            .iter()
            .find(|paper| paper.citation_key.as_deref() == Some("kingma2015adam"))
            .expect("a bibliography-only entry should still be listed");
        assert!(!adam.has_full_text);
        assert_eq!(adam.title, "Adam: A Method for Stochastic Optimization");
        // Its arXiv id came off the bibliography, so the text can be fetched later.
        assert_eq!(adam.arxiv_id, "1412.6980");

        let attention = papers
            .iter()
            .find(|paper| paper.citation_key.as_deref() == Some("vaswani2017attention"))
            .expect("the fetched paper should still be listed");
        assert!(attention.has_full_text);
        assert_eq!(attention.arxiv_id, "1706.03762");

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn lists_only_the_manifest_primary_bibliography() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-primary-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@book{primary, title={Primary source}}\n",
        )
        .unwrap();
        fs::write(
            root.join("supplement.bib"),
            "@book{secondary, title={Completion only}}\n",
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1);
        assert_eq!(papers[0].citation_key.as_deref(), Some("primary"));
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn remove_is_blocked_by_nocite_and_preserves_the_cache() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-blocker-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("main.tex"), "\\nocite{KEEP}\n").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{keep, title={Keep me}, eprint={2401.00001}}\n",
        )
        .unwrap();
        let cache = root.join(".research/papers/2401.00001");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("paper.md"), "cached").unwrap();

        let result = remove_reference(&root, "keep").unwrap();
        assert!(!result.removed);
        assert!(!result.blockers.is_empty());
        assert!(cache.join("paper.md").is_file());
        assert!(fs::read_to_string(root.join("references.bib"))
            .unwrap()
            .contains("keep"));
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn bibliography_definition_alone_does_not_block_removal() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-unused-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{unused, title={Not cited in the manuscript}}\n",
        )
        .unwrap();

        assert!(citation_blockers(&root, "unused").unwrap().is_empty());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn nocite_wildcard_blocks_removing_any_entry() {
        let parent =
            std::env::temp_dir().join(format!("lattice-paper-wildcard-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("main.tex"), "\\nocite{*}\n").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{keep, title={Keep everything}}\n",
        )
        .unwrap();

        assert!(!citation_blockers(&root, "keep").unwrap().is_empty());
        let _ = fs::remove_dir_all(parent);
    }

    #[cfg(unix)]
    #[test]
    fn cache_discovery_does_not_follow_symlink_loops() {
        use std::os::unix::fs::symlink;

        let parent = std::env::temp_dir().join(format!("lattice-paper-loop-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let papers = root.join(".research/papers");
        fs::create_dir_all(papers.join("archive")).unwrap();
        symlink(&papers, papers.join("archive/loop")).unwrap();

        assert!(imported_papers(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn supports_and_discovers_legacy_arxiv_cache_paths() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-legacy-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let directory = root.join(".research/papers/math.GT/0211159");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("paper.md"), "Title: A legacy paper\n").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{legacy, title={A legacy paper}, eprint={math.GT/0211159}}\n",
        )
        .unwrap();

        assert_eq!(
            parse_arxiv_id("https://arxiv.org/abs/math.GT/0211159v2").as_deref(),
            Some("math.GT/0211159v2")
        );
        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1);
        assert_eq!(papers[0].arxiv_id, "math.GT/0211159");
        assert!(papers[0].has_full_text);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn finds_the_arxiv_id_in_a_conference_entry_that_also_cites_the_preprint() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-eprint-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            r#"@inproceedings{lei2025scalability,
  author        = {Weixian Lei and Jiacong Wang},
  title         = {The Scalability of Simplicity},
  booktitle     = {IEEE/CVF International Conference on Computer Vision (ICCV)},
  year          = {2025},
  url           = {https://arxiv.org/abs/2504.10462},
  archiveprefix = {arXiv},
  eprint        = {2504.10462},
  primaryclass  = {cs.CV},
}
"#,
        )
        .unwrap();
        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1, "got: {papers:?}");
        assert_eq!(papers[0].arxiv_id, "2504.10462", "got: {:?}", papers[0]);
        assert!(!papers[0].has_full_text);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn joins_a_fetched_paper_to_its_citation_by_arxiv_id_when_the_key_is_unknown() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-join-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@inproceedings{lei2025scalability,\n  title = {The Scalability of Simplicity},\n  eprint = {2504.10462}\n}\n",
        )
        .unwrap();
        // Imported before the citation key existed, so metadata knows no key —
        // and the stored id carries a version suffix the citation omits.
        let directory = root.join(".research/papers/2504.10462v2");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("paper.md"),
            "Title: The Scalability of Simplicity\n",
        )
        .unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"2504.10462v2","title":"The Scalability of Simplicity"}"#,
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(
            papers.len(),
            1,
            "the fetched text and its citation are one work: {papers:?}"
        );
        assert!(papers[0].has_full_text, "got: {:?}", papers[0]);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn does_not_list_a_fetched_paper_twice_when_it_is_also_cited() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-dedupe-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  eprint = {1706.03762}\n}\n",
        )
        .unwrap();
        let directory = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("paper.md"),
            "Title: Attention Is All You Need\n",
        )
        .unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":"vaswani2017attention"}"#,
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1, "got: {papers:?}");
        assert!(papers[0].has_full_text);
    }

    /// Papers is the project's literature, not everything the agent opened.
    ///
    /// A survey has the agent reading dozens of papers into
    /// `.research/papers/`; listing those would bury the handful that are
    /// actually cited. The line is the bibliography, and the marker for a read
    /// is simply that nothing wrote a `metadata.json` beside the text.
    #[test]
    fn keeps_papers_the_agent_only_read_out_of_the_list_until_they_are_cited() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-reading-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("references.bib"), "").unwrap();

        // What the skill leaves behind: the text, and nothing else.
        let read = root.join(".research/papers/2401.00001");
        fs::create_dir_all(&read).unwrap();
        fs::write(read.join("paper.md"), "Title: Something I skimmed\n").unwrap();

        // A second uncited cache entry is hidden too, regardless of metadata.
        let library = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&library).unwrap();
        fs::write(
            library.join("paper.md"),
            "Title: Attention Is All You Need\n",
        )
        .unwrap();
        fs::write(
            library.join("metadata.json"),
            r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":null}"#,
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert!(papers.is_empty(), "got: {papers:?}");

        // Citing the one that was only read brings it in, text and all — no
        // file has to move and no metadata has to be rewritten.
        fs::write(
            root.join("references.bib"),
            "@misc{skimmed2024,\n  title = {Something I skimmed},\n  eprint = {2401.00001}\n}\n",
        )
        .unwrap();
        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1, "got: {papers:?}");
        let cited = papers
            .iter()
            .find(|paper| paper.arxiv_id == "2401.00001")
            .expect("the newly cited paper");
        assert!(cited.has_full_text);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn reuses_a_complete_canonical_cache_without_spawning_a_fetch() {
        let parent =
            std::env::temp_dir().join(format!("lattice-paper-duplicate-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let directory = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("paper.md"),
            "Title: Attention Is All You Need\n",
        )
        .unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"1706.03762","requestedArxivId":"1706.03762v7","title":"Attention Is All You Need","schemaVersion":1,"complete":true}"#,
        )
        .unwrap();

        let result = fetch_paper(&root, "https://arxiv.org/abs/1706.03762v7").unwrap();
        assert!(result.reused);
        assert_eq!(result.arxiv_id, "1706.03762");
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn paper_search_matches_only_titles() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-search-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let directory = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("paper.md"),
            "Title: Attention Is All You Need\nThe encoder-free model relies entirely on self-attention.\n",
        )
        .unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":"vaswani2017attention"}"#,
        )
        .unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{vaswani2017attention, title={Attention Is All You Need}, eprint={1706.03762}}\n",
        )
        .unwrap();

        let results = search_papers(&root, "attention need").unwrap();

        assert_eq!(results[0].arxiv_id.as_deref(), Some("1706.03762"));
        assert!(results[0].snippet.is_empty());
        assert!(search_papers(&root, "self-attention").unwrap().is_empty());
        assert!(search_papers(&root, "encoder free").unwrap().is_empty());
        assert!(search_papers(&root, "1706.03762").unwrap().is_empty());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    #[ignore = "requires network access"]
    fn imports_markdown_and_a_real_citation() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-e2e-{}", Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "paper").unwrap();
        let result = import_reference(&root, "1706.03762").unwrap();
        assert_eq!(result.arxiv_id, "1706.03762");
        assert_eq!(result.title, "Attention Is All You Need");
        assert!(root.join(&result.paper_path).exists());
        // --frontmatter now leads the full text with a YAML block.
        assert!(fs::read_to_string(root.join(&result.paper_path))
            .unwrap()
            .starts_with("---"));
        // The alphaXiv overview is fetched and stored as the blog view.
        assert!(root.join(".research/papers/1706.03762/blog.md").exists());
        assert!(!fs::read_to_string(root.join("references.bib"))
            .unwrap()
            .is_empty());
        fs::remove_dir_all(parent).unwrap();
    }
}
