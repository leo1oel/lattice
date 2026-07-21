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
    title: String,
    citation_key: Option<String>,
}

pub fn import_arxiv(root: &Path, input: &str) -> Result<ImportResult, String> {
    let arxiv_id = parse_arxiv_id(input)?;
    let manifest = project::read_manifest(root)?;
    if let Some(existing) = find_imported_paper(root, &arxiv_id)? {
        return Ok(ImportResult {
            paper_path: format!(".research/papers/{}/paper.md", existing.arxiv_id),
            arxiv_id: existing.arxiv_id,
            title: existing.title,
            citation_key: existing.citation_key,
            citation_output: String::new(),
            already_imported: true,
        });
    }
    let temp = std::env::temp_dir().join(format!("research-writer-import-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).map_err(err)?;
    let markdown_path = temp.join("paper.md");
    let arxiv_cache = temp.join(".arxiv2md_cache");
    let bibliography_path = temp.join("references.bib");
    fs::create_dir_all(&arxiv_cache).map_err(err)?;
    let project_bibliography = project::safe_path(root, &manifest.primary_bibliography)?;
    if project_bibliography.exists() {
        fs::copy(&project_bibliography, &bibliography_path).map_err(err)?;
    } else {
        fs::write(&bibliography_path, "").map_err(err)?;
    }

    let markdown_output = commands::command("uvx")
        .current_dir(&temp)
        .env("UV_CACHE_DIR", "/tmp/research-writer-uv-cache")
        .env("ARXIV2MD_CACHE_PATH", &arxiv_cache)
        .arg("--from")
        .arg("arxiv2markdown")
        .arg("arxiv2md")
        .arg(&arxiv_id)
        .arg("-o")
        .arg(&markdown_path)
        .output()
        .map_err(|error| uv_tool_spawn_error("arxiv2md", &error))?;
    ensure_success("arxiv2md", &markdown_output)?;
    let markdown = fs::read_to_string(&markdown_path).map_err(err)?;
    let title = parse_title(&markdown).unwrap_or_else(|| format!("arXiv {arxiv_id}"));

    let citation_output = run_bibcite(&bibliography_path, &arxiv_id)?;
    let bibliography = fs::read_to_string(&bibliography_path).map_err(err)?;
    let citation_key = parse_citation_key(&citation_output);
    let paper_relative = format!(".research/papers/{arxiv_id}/paper.md");
    let metadata_relative = format!(".research/papers/{arxiv_id}/metadata.json");
    let metadata = serde_json::to_string_pretty(&PaperMetadata {
        arxiv_id: arxiv_id.clone(),
        title: title.clone(),
        citation_key: citation_key.clone(),
    })
    .map_err(err)?;
    project::apply_transaction(
        root,
        &format!("Import arXiv {arxiv_id}"),
        vec![
            (paper_relative.clone(), markdown),
            (metadata_relative, format!("{metadata}\n")),
            (manifest.primary_bibliography, bibliography),
        ],
    )?;
    let _ = fs::remove_dir_all(temp);

    Ok(ImportResult {
        arxiv_id,
        title,
        paper_path: paper_relative,
        citation_key,
        citation_output,
        already_imported: false,
    })
}

fn find_imported_paper(root: &Path, requested_id: &str) -> Result<Option<PaperSummary>, String> {
    let requested_base = arxiv_base_id(requested_id);
    Ok(list_papers(root)?
        .into_iter()
        .find(|paper| arxiv_base_id(&paper.arxiv_id) == requested_base))
}

fn arxiv_base_id(arxiv_id: &str) -> &str {
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
    for citation in project::citations(root)? {
        let matched = imported
            .iter()
            .position(|(_, metadata)| {
                metadata
                    .citation_key
                    .as_deref()
                    .is_some_and(|key| key.eq_ignore_ascii_case(&citation.key))
            })
            .map(|index| imported.remove(index));
        let title = match &matched {
            Some((_, metadata)) if !metadata.title.trim().is_empty() => metadata.title.clone(),
            _ if !citation.title.trim().is_empty() => citation.title.clone(),
            _ => citation.key.clone(),
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
    // Papers imported before their citation landed, or whose key was rewritten.
    for (arxiv_id, metadata) in imported {
        papers.push(PaperSummary {
            title: if metadata.title.trim().is_empty() {
                format!("arXiv {arxiv_id}")
            } else {
                metadata.title
            },
            citation_key: metadata.citation_key,
            arxiv_id,
            has_full_text: true,
        });
    }
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
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        let markdown_path = entry.path().join("paper.md");
        if !markdown_path.exists() {
            continue;
        }
        let arxiv_id = entry.file_name().to_string_lossy().to_string();
        let markdown = fs::read_to_string(markdown_path).map_err(err)?;
        let metadata = fs::read_to_string(entry.path().join("metadata.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<PaperMetadata>(&raw).ok())
            .unwrap_or_else(|| PaperMetadata {
                arxiv_id: arxiv_id.clone(),
                title: parse_title(&markdown).unwrap_or_default(),
                citation_key: None,
            });
        imported.push((arxiv_id, metadata));
    }
    Ok(imported)
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

pub fn rename_paper(root: &Path, arxiv_id: &str, title: &str) -> Result<PaperSummary, String> {
    validate_arxiv_id(arxiv_id)?;
    let title = title.trim();
    if title.is_empty() {
        return Err("Enter a paper title.".to_string());
    }
    if title.chars().count() > 300 {
        return Err("Keep the paper title under 300 characters.".to_string());
    }
    let current = list_papers(root)?
        .into_iter()
        .find(|paper| paper.arxiv_id == arxiv_id)
        .ok_or_else(|| "That imported paper no longer exists.".to_string())?;
    let metadata = PaperMetadata {
        arxiv_id: arxiv_id.to_string(),
        title: title.to_string(),
        citation_key: current.citation_key.clone(),
    };
    let metadata_path = root
        .join(".research/papers")
        .join(arxiv_id)
        .join("metadata.json");
    fs::write(
        metadata_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&metadata).map_err(err)?
        ),
    )
    .map_err(err)?;
    Ok(PaperSummary {
        arxiv_id: arxiv_id.to_string(),
        title: title.to_string(),
        citation_key: current.citation_key,
        // Renaming only ever targets a paper that was fetched.
        has_full_text: true,
    })
}

/// Remove a work from the project: its fetched text if there is any, and its
/// bibliography entry if it has one.
///
/// Either half may be absent. A paper added through bibcite has a citation key
/// and no directory; one imported before its citation landed has the reverse.
/// Identifying by arXiv id alone used to reject the first case outright with
/// "Invalid arXiv id", leaving those entries unmanageable from the panel.
pub fn delete_paper(
    root: &Path,
    arxiv_id: Option<&str>,
    citation_key: Option<&str>,
) -> Result<(), String> {
    let arxiv_id = arxiv_id.map(str::trim).filter(|value| !value.is_empty());
    let citation_key = citation_key.map(str::trim).filter(|value| !value.is_empty());
    if arxiv_id.is_none() && citation_key.is_none() {
        return Err("That paper has neither an arXiv id nor a citation key.".to_string());
    }

    let paper_directory = match arxiv_id {
        Some(id) => {
            validate_arxiv_id(id)?;
            let directory = root.join(".research/papers").join(id);
            directory.exists().then_some(directory)
        }
        None => None,
    };

    let manifest = project::read_manifest(root)?;
    let bibliography_path = project::safe_path(root, &manifest.primary_bibliography)?;
    let bibliography = fs::read_to_string(&bibliography_path).unwrap_or_default();
    let citation_key = citation_key.map(str::to_string).or_else(|| {
        paper_directory
            .as_ref()
            .and_then(|directory| fs::read_to_string(directory.join("metadata.json")).ok())
            .and_then(|raw| serde_json::from_str::<PaperMetadata>(&raw).ok())
            .and_then(|item| item.citation_key)
            .or_else(|| arxiv_id.and_then(|id| find_citation_key_for_arxiv(&bibliography, id)))
    });

    if paper_directory.is_none() && citation_key.is_none() {
        return Err("That paper no longer exists.".to_string());
    }

    if let Some(citation_key) = &citation_key {
        let temp = std::env::temp_dir().join(format!("research-writer-delete-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp).map_err(err)?;
        let temporary_bibliography = temp.join("references.bib");
        fs::write(&temporary_bibliography, &bibliography).map_err(err)?;
        let result = run_bibcite_remove(&temporary_bibliography, citation_key)
            .and_then(|_| fs::read_to_string(&temporary_bibliography).map_err(err));
        let _ = fs::remove_dir_all(&temp);
        let updated_bibliography = result?;
        project::apply_transaction(
            root,
            &format!("Remove {citation_key}"),
            vec![(manifest.primary_bibliography, updated_bibliography)],
        )?;
    }

    match paper_directory {
        Some(directory) => fs::remove_dir_all(directory).map_err(err),
        None => Ok(()),
    }
}

fn validate_arxiv_id(arxiv_id: &str) -> Result<(), String> {
    if Regex::new(r"^\d{4}\.\d{4,5}(v\d+)?$|^[a-z-]+/\d{7}(v\d+)?$")
        .unwrap()
        .is_match(arxiv_id)
    {
        Ok(())
    } else {
        Err("Invalid arXiv id.".to_string())
    }
}

fn parse_arxiv_id(input: &str) -> Result<String, String> {
    let pattern = Regex::new(r"(?i)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+/\d{7}(?:v\d+)?)").unwrap();
    pattern
        .captures(input.trim())
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str().to_string())
        .ok_or_else(|| "Enter an arXiv URL or id, for example 2401.12345.".to_string())
}

fn run_bibcite(path: &PathBuf, query: &str) -> Result<String, String> {
    let direct = commands::command("bibcite")
        .arg("add")
        .arg(path)
        .arg(query)
        .output();
    let output = match direct {
        Ok(output) => output,
        Err(_) => commands::command("uvx")
            .env("UV_CACHE_DIR", "/tmp/research-writer-uv-cache")
            .arg("--from")
            .arg("bibcite-cli")
            .arg("bibcite")
            .arg("add")
            .arg(path)
            .arg(query)
            .output()
            .map_err(|error| uv_tool_spawn_error("bibcite", &error))?,
    };
    ensure_success("bibcite", &output)?;
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

fn run_bibcite_remove(path: &PathBuf, key: &str) -> Result<(), String> {
    let direct = commands::command("bibcite")
        .arg("remove")
        .arg(path)
        .arg(key)
        .output();
    let output = match direct {
        Ok(output) => output,
        Err(_) => commands::command("uvx")
            .env("UV_CACHE_DIR", "/tmp/research-writer-uv-cache")
            .arg("--from")
            .arg("bibcite-cli")
            .arg("bibcite")
            .arg("remove")
            .arg(path)
            .arg(key)
            .output()
            .map_err(|error| uv_tool_spawn_error("bibcite", &error))?,
    };
    ensure_success("bibcite", &output)
}

fn find_citation_key_for_arxiv(bibliography: &str, arxiv_id: &str) -> Option<String> {
    let bytes = bibliography.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let Some(at_offset) = bibliography[index..].find('@') else {
            break;
        };
        let at = index + at_offset;
        let Some(open_offset) = bibliography[at..].find('{') else {
            break;
        };
        let open = at + open_offset;
        let Some(comma_offset) = bibliography[open + 1..].find(',') else {
            break;
        };
        let comma = open + 1 + comma_offset;
        let key = bibliography[open + 1..comma].trim();
        let mut depth = 1i32;
        let mut end = comma + 1;
        for (offset, character) in bibliography[open + 1..].char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + 1 + offset + character.len_utf8();
                        break;
                    }
                }
                _ => {}
            }
        }
        if bibliography[at..end].contains(arxiv_id) && !key.is_empty() {
            return Some(key.to_string());
        }
        index = end.max(at + 1);
    }
    None
}

fn parse_citation_key(output: &str) -> Option<String> {
    for line in output.lines().rev() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(key) = value.get("key").and_then(Value::as_str) {
                return Some(key.to_string());
            }
        }
    }
    None
}

fn parse_title(markdown: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        line.strip_prefix("Title:")
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(ToString::to_string)
    })
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

    #[test]
    fn accepts_urls_and_ids() {
        assert_eq!(
            parse_arxiv_id("https://arxiv.org/abs/2401.12345").unwrap(),
            "2401.12345"
        );
        assert_eq!(parse_arxiv_id("2401.12345v2").unwrap(), "2401.12345v2");
        assert!(parse_arxiv_id("not a paper").is_err());
    }

    #[test]
    fn extracts_the_paper_title_from_arxiv_markdown() {
        assert_eq!(
            parse_title("Title: Attention Is All You Need\nArXiv: 1706.03762\n"),
            Some("Attention Is All You Need".to_string())
        );
    }

    #[test]
    fn finds_a_legacy_imports_citation_key_by_arxiv_id() {
        let bibliography = "@article{vaswani2017attention,\n  eprint = {1706.03762},\n  title = {Attention {Is} All You Need}\n}\n";
        assert_eq!(
            find_citation_key_for_arxiv(bibliography, "1706.03762"),
            Some("vaswani2017attention".to_string())
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
        fs::write(directory.join("paper.md"), "Title: Attention Is All You Need\n").unwrap();
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
    fn removes_a_cited_only_work_that_has_no_arxiv_id() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-del-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@book{knuth1984texbook,\n  title = {The TeXbook},\n  author = {Knuth, Donald}\n}\n",
        )
        .unwrap();
        // Listed, so it must be removable — this is the case that used to fail
        // with "Invalid arXiv id" before the identifier was allowed to be a key.
        let listed = list_papers(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].arxiv_id.is_empty());

        // bibcite may be absent on the machine running tests; either way the
        // call must get past identifier validation rather than rejecting outright.
        match delete_paper(&root, None, Some("knuth1984texbook")) {
            Ok(()) => assert!(list_papers(&root).unwrap().is_empty()),
            Err(error) => assert!(
                !error.contains("Invalid arXiv id") && !error.contains("no longer exists"),
                "got: {error}"
            ),
        }
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn refuses_a_paper_with_no_identifier_at_all() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-noid-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let error = delete_paper(&root, Some("  "), None).unwrap_err();
        assert!(error.contains("neither an arXiv id nor a citation key"), "got: {error}");
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn does_not_list_a_fetched_paper_twice_when_it_is_also_cited() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-dedupe-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{vaswani2017attention,\n  title = {Attention Is All You Need}\n}\n",
        )
        .unwrap();
        let directory = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("paper.md"), "Title: Attention Is All You Need\n").unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":"vaswani2017attention"}"#,
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1, "got: {papers:?}");
        assert!(papers[0].has_full_text);
    }

    #[test]
    fn reuses_an_imported_paper_for_url_and_version_variants() {
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
            r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":"vaswani2017attention"}"#,
        )
        .unwrap();

        let result = import_arxiv(&root, "https://arxiv.org/abs/1706.03762v7").unwrap();

        assert!(result.already_imported);
        assert_eq!(result.arxiv_id, "1706.03762");
        assert_eq!(result.citation_key.as_deref(), Some("vaswani2017attention"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn renames_only_the_paper_display_title() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-rename-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let directory = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("paper.md"), "Title: Original title\n").unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"1706.03762","title":"Original title","citationKey":"vaswani2017attention"}"#,
        )
        .unwrap();
        let renamed = rename_paper(&root, "1706.03762", "A clearer title").unwrap();
        assert_eq!(renamed.title, "A clearer title");
        assert_eq!(
            renamed.citation_key.as_deref(),
            Some("vaswani2017attention")
        );
        assert_eq!(list_papers(&root).unwrap()[0].title, "A clearer title");
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
        let result = import_arxiv(&root, "1706.03762").unwrap();
        assert_eq!(result.arxiv_id, "1706.03762");
        assert_eq!(result.title, "Attention Is All You Need");
        assert!(root.join(&result.paper_path).exists());
        assert!(!fs::read_to_string(root.join("references.bib"))
            .unwrap()
            .is_empty());
        delete_paper(&root, Some("1706.03762"), None).unwrap();
        assert!(!root.join(&result.paper_path).exists());
        assert!(fs::read_to_string(root.join("references.bib"))
            .unwrap()
            .trim()
            .is_empty());
        fs::remove_dir_all(parent).unwrap();
    }
}
