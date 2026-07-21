use crate::commands;
use crate::models::WordCount;
use crate::project;
use std::path::Path;

pub fn count_project(root: &Path) -> Result<WordCount, String> {
    let manifest = project::read_manifest(root)?;
    let document = manifest
        .root_documents
        .iter()
        .find(|item| item.is_default)
        .or_else(|| manifest.root_documents.first())
        .ok_or_else(|| "No root document configured.".to_string())?;
    let absolute = project::safe_path(root, &document.path)?;
    if !absolute.is_file() {
        return Err(format!("Root document not found: {}", document.path));
    }
    if commands::available("texcount") {
        if let Ok(count) = run_texcount(root, &document.path) {
            return Ok(count);
        }
    }
    let content = std::fs::read_to_string(&absolute).unwrap_or_default();
    Ok(estimate_from_latex(&content))
}

fn run_texcount(root: &Path, relative: &str) -> Result<WordCount, String> {
    let output = commands::command("texcount")
        .current_dir(root)
        .args(["-inc", "-q", relative])
        .output()
        .map_err(|error| format!("Could not run texcount: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "texcount failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_texcount_output(&stdout)
}

pub fn parse_texcount_output(stdout: &str) -> Result<WordCount, String> {
    let mut text = 0u32;
    let mut headers = 0u32;
    let mut captions = 0u32;
    for line in stdout.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(value) = extract_labeled_count(&lower, "words in text:") {
            text = value;
        } else if let Some(value) = extract_labeled_count(&lower, "words in headers:") {
            headers = value;
        } else if let Some(value) = extract_labeled_count(&lower, "words outside text") {
            captions = value;
        }
    }
    if text == 0 && headers == 0 && captions == 0 {
        // Fallback: `-sum -1` style single integer
        if let Some(total) = stdout
            .lines()
            .find_map(|line| line.trim().parse::<u32>().ok())
        {
            return Ok(WordCount {
                text: total,
                headers: 0,
                captions: 0,
                total,
                source: "texcount".to_string(),
            });
        }
        return Err("Could not parse texcount output.".to_string());
    }
    Ok(WordCount {
        text,
        headers,
        captions,
        total: text.saturating_add(headers).saturating_add(captions),
        source: "texcount".to_string(),
    })
}

fn extract_labeled_count(line: &str, label: &str) -> Option<u32> {
    let rest = line.split_once(label)?.1;
    rest.split(|character: char| !character.is_ascii_digit())
        .filter(|token| !token.is_empty())
        .next_back()
        .and_then(|token| token.parse().ok())
}

/// Rough body estimate when texcount is unavailable: strip common LaTeX noise.
pub fn estimate_from_latex(source: &str) -> WordCount {
    let mut text = source.to_string();
    // Drop comments
    text = text
        .lines()
        .map(|line| {
            if let Some((code, _)) = line.split_once('%') {
                code
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    // Drop common environments that are not body prose
    for env in ["figure", "table", "equation", "align", "gather", "verbatim", "lstlisting"] {
        let pattern = regex::Regex::new(&format!(
            r"(?s)\\begin\{{{env}\}}.*?\\end\{{{env}\}}"
        ))
        .ok();
        if let Some(regex) = pattern {
            text = regex.replace_all(&text, " ").into_owned();
        }
    }
    // Drop commands like \foo{...} keeping braced text for \textbf etc. is hard; strip macros.
    let command = regex::Regex::new(r"\\[A-Za-z]+\*?(\[[^\]]*\])?(\{[^}]*\})*").ok();
    if let Some(regex) = command {
        text = regex.replace_all(&text, " ").into_owned();
    }
    text = text.replace(['{', '}', '$', '&', '#', '_', '~', '^'], " ");
    let words = text
        .split(|character: char| !character.is_alphanumeric() && character != '\'' && character != '-')
        .filter(|token| !token.is_empty())
        .count() as u32;
    WordCount {
        text: words,
        headers: 0,
        captions: 0,
        total: words,
        source: "estimate".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_verbose_texcount_output() {
        let sample = r#"
File: main.tex
Words in text: 412
Words in headers: 18
Words outside text (captions, etc.): 24
Number of headers: 6
"#;
        let count = parse_texcount_output(sample).unwrap();
        assert_eq!(count.text, 412);
        assert_eq!(count.headers, 18);
        assert_eq!(count.captions, 24);
        assert_eq!(count.total, 454);
        assert_eq!(count.source, "texcount");
    }

    #[test]
    fn estimates_without_commands() {
        let count = estimate_from_latex(
            r#"\documentclass{article}
\begin{document}
Hello world from a short paper.
% TODO ignore
\textbf{Bold words}
\end{document}
"#,
        );
        assert!(count.total >= 5);
        assert_eq!(count.source, "estimate");
    }
}
