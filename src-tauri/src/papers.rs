use crate::commands;
use crate::models::{ImportResult, PaperSummary};
use crate::project;
use regex::Regex;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;
use uuid::Uuid;

pub fn import_arxiv(root: &Path, input: &str) -> Result<ImportResult, String> {
    let arxiv_id = parse_arxiv_id(input)?;
    let manifest = project::read_manifest(root)?;
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
        .map_err(|error| format!("Could not start arxiv2md: {error}"))?;
    ensure_success("arxiv2md", &markdown_output)?;
    let markdown = fs::read_to_string(&markdown_path).map_err(err)?;
    let title = parse_title(&markdown).unwrap_or_else(|| format!("arXiv {arxiv_id}"));

    let citation_output = run_bibcite(&bibliography_path, &arxiv_id)?;
    let bibliography = fs::read_to_string(&bibliography_path).map_err(err)?;
    let citation_key = parse_citation_key(&citation_output);
    let paper_relative = format!(".research/papers/{arxiv_id}/paper.md");
    project::apply_transaction(
        root,
        &format!("Import arXiv {arxiv_id}"),
        vec![
            (paper_relative.clone(), markdown),
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
    })
}

pub fn list_papers(root: &Path) -> Result<Vec<PaperSummary>, String> {
    let directory = root.join(".research/papers");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut papers = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        let markdown_path = entry.path().join("paper.md");
        if markdown_path.exists() {
            let arxiv_id = entry.file_name().to_string_lossy().to_string();
            let markdown = fs::read_to_string(markdown_path).map_err(err)?;
            papers.push(PaperSummary {
                title: parse_title(&markdown).unwrap_or_else(|| format!("arXiv {arxiv_id}")),
                arxiv_id,
            });
        }
    }
    papers.sort_by_key(|paper| paper.title.to_lowercase());
    Ok(papers)
}

pub fn read_paper(root: &Path, arxiv_id: &str) -> Result<String, String> {
    if !Regex::new(r"^\d{4}\.\d{4,5}(v\d+)?$|^[a-z-]+/\d{7}(v\d+)?$")
        .unwrap()
        .is_match(arxiv_id)
    {
        return Err("Invalid arXiv id.".to_string());
    }
    project::read_file(root, &format!(".research/papers/{arxiv_id}/paper.md"))
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
            .map_err(|error| format!("Could not start bibcite: {error}"))?,
    };
    ensure_success("bibcite", &output)?;
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
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
        fs::remove_dir_all(parent).unwrap();
    }
}
