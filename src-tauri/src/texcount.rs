use crate::models::WordCount;
use crate::{commands, latex, project};
use std::path::Path;

pub fn count_project(root: &Path) -> Result<WordCount, String> {
    let manifest = project::read_manifest(root)?;
    let document =
        latex::default_root(&manifest).ok_or_else(|| "No root document configured.".to_string())?;
    let absolute = project::safe_path(root, &document.path)?;
    if !absolute.is_file() {
        return Err(format!("Root document not found: {}", document.path));
    }
    if commands::available("texcount") {
        let output = commands::command("texcount")
            .current_dir(root)
            .args(["-inc", "-q", &document.path])
            .output()
            .ok()
            .filter(|output| output.status.success());
        if let Some(count) = output
            .and_then(|output| parse_texcount_output(&String::from_utf8_lossy(&output.stdout)))
        {
            return Ok(count);
        }
    }
    let content = std::fs::read_to_string(&absolute).unwrap_or_default();
    Ok(estimate_from_latex(&content))
}

fn parse_texcount_output(stdout: &str) -> Option<WordCount> {
    const LABELS: [&str; 3] = ["words in text:", "words in headers:", "words outside text"];
    // Text, headers, and captions (texcount's "outside text"), in LABELS order.
    let mut counts = [0u32; 3];
    for line in stdout.lines() {
        let lower = line.to_ascii_lowercase();
        for (count, label) in counts.iter_mut().zip(LABELS) {
            if let Some(value) = labeled_count(&lower, label) {
                *count = value;
                break;
            }
        }
    }
    let [text, headers, captions] = if counts == [0; 3] {
        // Fallback: `-sum -1` style single integer
        [stdout.lines().find_map(|line| line.trim().parse::<u32>().ok())?, 0, 0]
    } else {
        counts
    };
    let total = text.saturating_add(headers).saturating_add(captions);
    Some(WordCount { text, headers, captions, total, source: "texcount".to_string() })
}

fn labeled_count(line: &str, label: &str) -> Option<u32> {
    let rest = line.split_once(label)?.1;
    rest.split(|character: char| !character.is_ascii_digit())
        .rfind(|token| !token.is_empty())
        .and_then(|token| token.parse().ok())
}

/// Rough body estimate when texcount is unavailable: strip common LaTeX noise.
fn estimate_from_latex(source: &str) -> WordCount {
    let mut text = source
        .lines()
        .map(|line| line.split_once('%').map_or(line, |(code, _)| code))
        .collect::<Vec<_>>()
        .join("\n");
    // Environments that are not body prose.
    for env in ["figure", "table", "equation", "align", "gather", "verbatim", "lstlisting"] {
        if let Ok(regex) = regex::Regex::new(&format!(r"(?s)\\begin\{{{env}\}}.*?\\end\{{{env}\}}"))
        {
            text = regex.replace_all(&text, " ").into_owned();
        }
    }
    // Keeping the braced text of \textbf and friends is hard; strip macros whole.
    if let Ok(regex) = regex::Regex::new(r"\\[A-Za-z]+\*?(\[[^\]]*\])?(\{[^}]*\})*") {
        text = regex.replace_all(&text, " ").into_owned();
    }
    text = text.replace(['{', '}', '$', '&', '#', '_', '~', '^'], " ");
    let words = text
        .split(|character: char| {
            !character.is_alphanumeric() && character != '\'' && character != '-'
        })
        .filter(|token| !token.is_empty())
        .count() as u32;
    WordCount { text: words, headers: 0, captions: 0, total: words, source: "estimate".to_string() }
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
