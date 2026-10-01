//! Finding text in a project: search (indexed with a linear fallback), TODO
//! markers, and find/replace across files.

use super::history::apply_transaction;
use super::paths::{extension, safe_path, source_kind};
use super::tree::{scan_tree, tree_files, TreeView};
use super::{clip_line, err};
use crate::models::{
    FileNode, ProjectSearchResult, ReplaceMatch, ReplacePreview, ReplaceResult, TodoHit,
};
use crate::util::truncate_chars;
use regex::Regex;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

/// Most results any search returns.
const MAX_SEARCH_RESULTS: usize = 200;

pub fn search_files(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    // The index's unicode61 tokenizer keeps a run of Chinese or Japanese text
    // between punctuation as one token, and the index matches token prefixes:
    // "注意力" inside "我们提出了注意力机制" found nothing. Those queries read
    // the files instead, which matches substrings.
    if search_terms(query).iter().any(|term| term.chars().any(is_unspaced_script)) {
        return search_files_linear(root, query);
    }
    crate::fts::search(root, query).or_else(|_| search_files_linear(root, query))
}

/// A character from a script written without spaces between words.
fn is_unspaced_script(character: char) -> bool {
    matches!(character,
        '\u{3040}'..='\u{30FF}' // Hiragana, Katakana
        | '\u{3400}'..='\u{4DBF}' // CJK Extension A
        | '\u{4E00}'..='\u{9FFF}' // CJK Unified Ideographs
        | '\u{F900}'..='\u{FAFF}' // CJK Compatibility Ideographs
        | '\u{0E00}'..='\u{0E7F}' // Thai
        | '\u{20000}'..='\u{2FA1F}' // CJK Extensions B–F, compatibility supplement
    )
}

/// A project-file search hit; line 1 with the path as snippet for path matches.
pub(crate) fn file_search_result(
    path: &str, title: &str, snippet: String, line: Option<u32>, file_kind: Option<String>,
) -> ProjectSearchResult {
    ProjectSearchResult {
        kind: "file".to_string(),
        path: path.to_string(),
        title: title.to_string(),
        snippet,
        line,
        arxiv_id: None,
        file_kind,
    }
}

fn search_files_linear(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    let terms = search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    search_nodes(root, &scan_tree(root, TreeView::Project)?, &terms, &mut results)?;
    results.truncate(MAX_SEARCH_RESULTS);
    Ok(results)
}

/// Path and line matches, in tree order. A folder stops scanning its own
/// entries once the cap is reached; the caller truncates the rest.
fn search_nodes(
    root: &Path, nodes: &[FileNode], terms: &[String], results: &mut Vec<ProjectSearchResult>,
) -> Result<(), String> {
    for node in nodes {
        if node.kind == "directory" {
            search_nodes(root, &node.children, terms, results)?;
            continue;
        }
        let content = if searchable_text_path(&node.path) {
            fs::read_to_string(safe_path(root, &node.path)?).unwrap_or_default()
        } else {
            String::new()
        };
        let hit = |snippet: String, line: u32| {
            file_search_result(&node.path, &node.name, snippet, Some(line), Some(node.kind.clone()))
        };
        let path_haystack = node.path.replace(['\\', '/', '.', '-', '_'], " ");
        if matches_search(&format!("{} {}", node.path, path_haystack), terms) {
            results.push(hit(node.path.clone(), 1));
        }
        for (line_number, line) in searchable_text_lines(&node.path, &content) {
            if matches_search(&line, terms) {
                results.push(hit(clip_line(&line, 180), line_number));
                if results.len() >= MAX_SEARCH_RESULTS {
                    return Ok(());
                }
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

pub(crate) fn searchable_text_path(path: &str) -> bool {
    source_kind(path).is_some_and(|kind| kind.searchable)
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
    if extension(path).as_deref() != Some("html") {
        return content
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(index, line)| (index as u32 + 1, line.to_string()))
            .collect();
    }

    let (body, first_line) = match HTML_BODY_OPEN_RE.find(content) {
        Some(open) => {
            let after_open = &content[open.end()..];
            let end = HTML_BODY_CLOSE_RE
                .find(after_open)
                .map_or(content.len(), |close| open.end() + close.start());
            (&content[open.end()..end], super::line_number_at(content, open.end()))
        }
        None => (content, 1),
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
            let decoded = crate::util::decode_html_entities(line);
            let text = crate::util::collapse_whitespace(&decoded);
            (!text.is_empty()).then(|| (first_line + index as u32, text))
        })
        .collect()
}

/// Every searchable file in the inventory: what find/replace and the TODO scan read.
fn replace_targets(root: &Path) -> Result<Vec<String>, String> {
    Ok(tree_files(&scan_tree(root, TreeView::Inventory)?)
        .into_iter()
        .filter(|node| searchable_text_path(&node.path))
        .map(|node| node.path.clone())
        .collect())
}

pub fn list_todos(root: &Path) -> Result<Vec<TodoHit>, String> {
    let mut hits = Vec::new();
    for relative in replace_targets(root)? {
        if !matches!(
            extension(&relative).as_deref(),
            Some("tex" | "md" | "tsx" | "ts" | "jsx" | "js")
        ) {
            continue;
        }
        let absolute = safe_path(root, &relative)?;
        if !absolute.is_file() {
            continue;
        }
        let content = fs::read_to_string(&absolute).unwrap_or_default();
        let latex = extension(&relative).as_deref() == Some("tex");
        hits.extend(content.lines().enumerate().filter_map(|(index, line)| {
            Some(TodoHit {
                path: relative.replace('\\', "/"),
                line: (index + 1) as u32,
                kind: todo_kind_in_line(line, latex)?.to_string(),
                preview: clip_line(line, 160),
            })
        }));
        if hits.len() >= 400 {
            hits.truncate(400);
            break;
        }
    }
    Ok(hits)
}

/// A marker in a `%` comment (first in priority order), else a `\todo`
/// command. Outside LaTeX a `%` is text ("50% done"), so only a line that
/// starts with one counts there. Kept in step with src/project/todo-scavenger.ts.
fn todo_kind_in_line(line: &str, latex: bool) -> Option<&'static str> {
    let trimmed = line.trim_start();
    let comment = if latex { comment_in_line(trimmed) } else { trimmed.strip_prefix('%') };
    if let Some(comment) = comment {
        // A marker is a word of its own: "% Mastodon dataset" is not a TODO.
        if let Some(marker) =
            ["FIXME", "XXX", "TODO"].into_iter().find(|marker| has_marker_word(comment, marker))
        {
            return Some(marker);
        }
    }
    // \todo{...} / \todo [...]{...} — common todonotes / inline markers
    let lower = trimmed.to_ascii_lowercase();
    ["\\todo{", "\\todo[", "\\todo*{"].iter().any(|marker| lower.contains(marker)).then_some("todo")
}

/// The `%` comment on a line, including one after text; `\%` is a percent
/// sign, but `\\%` is a line break and then a comment.
fn comment_in_line(line: &str) -> Option<&str> {
    let mut backslashes = 0usize;
    for (index, character) in line.char_indices() {
        if character == '%' && backslashes % 2 == 0 {
            return Some(&line[index + 1..]);
        }
        backslashes = if character == '\\' { backslashes + 1 } else { 0 };
    }
    None
}

/// `marker` (or its plural) in `text`, not inside a longer word.
fn has_marker_word(text: &str, marker: &str) -> bool {
    let upper = text.to_ascii_uppercase();
    let is_word = |byte: u8| byte.is_ascii_alphanumeric();
    upper.match_indices(marker).any(|(start, _)| {
        let mut end = start + marker.len();
        if upper.as_bytes().get(end) == Some(&b'S') {
            end += 1;
        }
        !(start > 0 && is_word(upper.as_bytes()[start - 1]))
            && !upper.as_bytes().get(end).copied().is_some_and(is_word)
    })
}

pub fn preview_replace_in_project(
    root: &Path, query: &str, match_case: bool, use_regex: bool,
) -> Result<ReplacePreview, String> {
    let matcher = ReplaceMatcher::new(query, match_case, use_regex)?;
    let mut matches = Vec::new();
    let mut files = 0u32;
    let mut replacements = 0u32;
    for (relative, before) in replace_sources(root)? {
        // The preview walks the same whole-file matches the replace rewrites,
        // so a pattern that spans or anchors to lines counts what it replaces.
        let mut file_hits = 0u32;
        let (mut line_number, mut line_start, mut scanned) = (1u32, 0usize, 0usize);
        for found in matcher.regex.find_iter(&before) {
            if matches.len() < 200 {
                for (offset, _) in before[scanned..found.start()].match_indices('\n') {
                    line_number += 1;
                    line_start = scanned + offset + 1;
                }
                scanned = found.start();
                let line_end =
                    before[line_start..].find('\n').map_or(before.len(), |end| line_start + end);
                matches.push(ReplaceMatch {
                    path: relative.clone(),
                    line: line_number,
                    column: before[line_start..found.start()].chars().count() as u32 + 1,
                    preview: truncate_chars(before[line_start..line_end].trim(), 120),
                });
            }
            file_hits += 1;
        }
        replacements += file_hits;
        files += u32::from(file_hits > 0);
    }
    Ok(ReplacePreview { matches, files, replacements })
}

pub fn replace_in_project(
    root: &Path, query: &str, replacement: &str, match_case: bool, use_regex: bool,
) -> Result<ReplaceResult, String> {
    let matcher = ReplaceMatcher::new(query, match_case, use_regex)?;
    let mut edits = Vec::new();
    let mut replacements = 0u32;
    for (relative, before) in replace_sources(root)? {
        let (after, count) = matcher.replace_all(&before, replacement);
        if count > 0 {
            replacements += count;
            edits.push((relative, after));
        }
    }
    if edits.is_empty() {
        return Ok(ReplaceResult { files_changed: Vec::new(), replacements: 0 });
    }
    let files_changed = edits.iter().map(|(path, _)| path.clone()).collect();
    let label = format!("Replace “{}”", query.chars().take(40).collect::<String>());
    apply_transaction(root, &label, edits)?;
    Ok(ReplaceResult { files_changed, replacements })
}

/// `(relative path, contents)` of every replace target that is a file.
fn replace_sources(root: &Path) -> Result<Vec<(String, String)>, String> {
    let mut sources = Vec::new();
    for relative in replace_targets(root)? {
        let path = safe_path(root, &relative)?;
        if path.is_file() {
            let contents = fs::read_to_string(&path).map_err(err)?;
            sources.push((relative, contents));
        }
    }
    Ok(sources)
}

/// Find/replace across the project, matching the way the editor's own
/// search does: `^` and `$` anchor to each line (CRLF included), and a
/// literal is an escaped pattern so its offsets always index the original
/// text. (Case-insensitive literals once matched against a lowercased copy;
/// `Å` (U+212B) or `İ` lowercase to a different byte length, so the replace
/// landed beside the match and silently corrupted the file.)
struct ReplaceMatcher {
    regex: Regex,
}

impl ReplaceMatcher {
    fn new(query: &str, match_case: bool, use_regex: bool) -> Result<Self, String> {
        if query.is_empty() {
            return Err("Enter text to find.".to_string());
        }
        let pattern = if use_regex { query.to_string() } else { regex::escape(query) };
        let regex = regex::RegexBuilder::new(&pattern)
            .case_insensitive(!match_case)
            .multi_line(true)
            .crlf(true)
            .build()
            .map_err(|error| format!("Invalid regular expression: {error}"))?;
        Ok(Self { regex })
    }

    fn replace_all(&self, source: &str, replacement: &str) -> (String, u32) {
        // NoExpand: `$` is a capture reference to the regex crate, so
        // replacing with `$n$` — ordinary maths — resolved `$n` to an
        // empty group and left a stray `$` behind in every file it
        // touched, reported as a success.
        let count = self.regex.find_iter(source).count() as u32;
        (self.regex.replace_all(source, regex::NoExpand(replacement)).into_owned(), count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    #[test]
    fn project_search_matches_paths_and_visible_contents() {
        let fixture = Fixture::project("project-search");
        let root = &fixture.root;
        fixture.write("sections/method.tex", "A distinctive latent alignment objective.\n");

        for query in ["latent alignment", "method.tex", "method tex"] {
            let hit = &search_files(root, query).unwrap()[0];
            assert_eq!(hit.path, "sections/method.tex", "{query}");
        }
        assert!(search_files(root, "latent alignment").unwrap()[0].snippet.contains("distinctive"));

        // A Chinese word inside a sentence, which the index keeps as one token.
        fixture.write("sections/intro.tex", "我们提出了注意力机制，效果很好。\n");
        for query in ["注意力", "机制", "注意力 效果"] {
            let hits = search_files(root, query).unwrap();
            assert_eq!(
                hits.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>(),
                ["sections/intro.tex"],
                "{query}"
            );
        }

        // The linear fallback also skips hidden paths and HTML outside the body.
        fixture.write(
            "page.html",
            "<html><head><title>hidden_head_token</title></head><body><p>visible_body_token</p><script>hidden_script_token</script></body></html>\n",
        );
        fixture.write(".private.md", "hidden_notes_token\n");
        let visible = search_files_linear(root, "visible body token").unwrap();
        assert_eq!(visible.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>(), ["page.html"]);
        for excluded in ["hidden head token", "hidden script token", "hidden notes token"] {
            let results = search_files_linear(root, excluded).unwrap();
            assert!(results.is_empty(), "unexpected search result for {excluded}");
        }
    }

    #[test]
    fn replace_and_todo_scans_read_every_searchable_file() {
        let fixture = Fixture::project("project-replace");
        let root = &fixture.root;
        fixture.write("sections/a.tex", "alpha token beta\n");
        fixture.write("main.tex", "token in main\n");
        let preview = preview_replace_in_project(root, "token", true, false).unwrap();
        assert_eq!((preview.replacements, preview.files), (2, 2));
        assert!(preview.matches.iter().any(|item| item.path == "main.tex"));
        let result = replace_in_project(root, "token", "VALUE", true, false).unwrap();
        assert_eq!(result.replacements, 2);
        for path in ["main.tex", "sections/a.tex"] {
            assert!(result.files_changed.contains(&path.to_string()), "{path}");
        }
        assert_eq!(fixture.read("main.tex"), "VALUE in main\n");

        // Case-insensitive literals and regular expressions.
        fixture.write("main.tex", "Token TOKEN token\n");
        let insensitive = preview_replace_in_project(root, "token", false, false).unwrap();
        assert_eq!(insensitive.replacements, 3);
        let regex = replace_in_project(root, r"[Tt]oken", "X", true, true).unwrap();
        assert_eq!(regex.replacements, 2);
        assert_eq!(fixture.read("main.tex"), "X TOKEN X\n");

        // A case-insensitive literal replaces the match itself even when an
        // earlier character lowercases to a different byte length (Å, U+212B).
        fixture.write("main.tex", "Grain size 5 \u{212B} and Token here\n");
        let result = replace_in_project(root, "token", "VALUE", false, false).unwrap();
        assert_eq!(result.replacements, 1);
        assert_eq!(fixture.read("main.tex"), "Grain size 5 \u{212B} and VALUE here\n");

        // The preview counts what the replace rewrites: `^` anchors to every
        // line (CRLF too), and a pattern may span lines.
        fixture.write("sections/a.tex", "alpha\r\nbeta\r\n");
        fixture.write("main.tex", "one\ntwo\n");
        let anchored = preview_replace_in_project(root, "^(?:one|two)", true, true).unwrap();
        let replaced = replace_in_project(root, "^(?:one|two)", "> $0", true, true).unwrap();
        assert_eq!((anchored.replacements, replaced.replacements), (2, 2));
        assert_eq!(fixture.read("main.tex"), "> $0\n> $0\n");
        let line_ends = preview_replace_in_project(root, "(?:alpha|beta)$", true, true).unwrap();
        let replaced = replace_in_project(root, "(?:alpha|beta)$", "x", true, true).unwrap();
        assert_eq!((line_ends.replacements, replaced.replacements), (2, 2));
        assert_eq!(fixture.read("sections/a.tex"), "x\r\nx\r\n");
        fixture.write("main.tex", "first\nsecond\n");
        let spanning = preview_replace_in_project(root, r"first\nsec", true, true).unwrap();
        assert_eq!(spanning.replacements, 1);
        assert_eq!((spanning.matches[0].line, spanning.matches[0].preview.as_str()), (1, "first"));
        let second = preview_replace_in_project(root, "cond", true, false).unwrap();
        assert_eq!((second.matches[0].line, second.matches[0].column), (2, 3));

        // TODO markers in comments and \todo macros.
        fixture.write(
            "sections/method.tex",
            "Intro\n% TODO rewrite claim\n\\todo{add figure}\n% FIXME citation\n",
        );
        fixture.write("notes.md", "# Notes\n% XXX temp\n50% todo is prose here\n");
        fixture.write(
            "sections/results.tex",
            "% Mastodon dataset\nGains hold. % TODO cite\nA 50\\% rate, todo-free\n",
        );
        let hits = list_todos(root).unwrap();
        let lines_in = |path: &str| -> Vec<u32> {
            hits.iter().filter(|hit| hit.path == path).map(|hit| hit.line).collect()
        };
        assert_eq!(lines_in("sections/results.tex"), [2]);
        assert_eq!(lines_in("notes.md"), [2]);
        assert!(hits.iter().any(|hit| hit.kind == "TODO" && hit.path == "sections/method.tex"));
        assert!(hits.iter().any(|hit| hit.kind == "todo" && hit.preview.contains("\\todo")));
        assert!(hits.iter().any(|hit| hit.kind == "FIXME"));
        assert!(hits.iter().any(|hit| hit.kind == "XXX" && hit.path == "notes.md"));
    }
}
