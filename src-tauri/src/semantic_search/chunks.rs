//! Reading project prose and splitting it into stable, heading-scoped blocks.
//!
//! Only `.tex`, `.md`, and `.mdx` sources are read, plus cached paper prose
//! under `.research/papers/`. A block is a heading trail or a paragraph under
//! it, so editing one paragraph only changes that block's hash.

use super::{BuildFailure, MAX_BLOCK_CHARS, MAX_SOURCE_BYTES};
use crate::util::collapse_whitespace;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use walkdir::{DirEntry, WalkDir};

#[derive(Debug)]
pub(super) struct SourceDocument {
    pub(super) path: String,
    pub(super) title: String,
    pub(super) kind: String,
    pub(super) file_kind: String,
    pub(super) chunks: Vec<SourceChunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SourceChunk {
    pub(super) line: u32,
    pub(super) text: String,
}

pub(super) fn read_source_documents(
    root: &Path, cancel: &AtomicBool,
) -> Result<Vec<SourceDocument>, BuildFailure> {
    let mut documents = Vec::new();
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| semantic_walk_entry(root, entry));
    for entry in walker.filter_map(Result::ok) {
        if cancel.load(Ordering::Acquire) {
            return Err(BuildFailure::Cancelled);
        }
        let relative = relative_path(root, entry.path());
        let extension = extension(entry.path());
        if !entry.file_type().is_file()
            || !semantic_source_path(&relative, &extension)
            || entry.metadata().map_or(true, |metadata| metadata.len() > MAX_SOURCE_BYTES)
        {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let (title, chunks) = if extension == "tex" {
            (file_title(&relative), latex_chunks(&content))
        } else {
            markdown_chunks(&content, &file_title(&relative))
        };
        if chunks.is_empty() {
            continue;
        }
        let kind = if is_paper_markdown(&relative) { "paper" } else { "file" };
        documents.push(SourceDocument {
            path: relative,
            title,
            kind: kind.to_string(),
            file_kind: extension,
            chunks,
        });
    }
    documents.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(documents)
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn extension(path: &Path) -> String {
    path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// Skip build output and dot-directories, except the paper cache under
/// `.research/papers/`.
fn semantic_walk_entry(root: &Path, entry: &DirEntry) -> bool {
    let relative = relative_path(root, entry.path());
    let first = relative.split('/').next().unwrap_or_default();
    if matches!(first, ".git" | "node_modules" | "target" | "dist") {
        return false;
    }
    !first.starts_with('.')
        || relative == ".research"
        || relative == ".research/papers"
        || relative.starts_with(".research/papers/")
}

/// Prose sources outside dot-directories, plus cached paper prose.
fn semantic_source_path(relative: &str, extension: &str) -> bool {
    matches!(extension, "tex" | "md" | "mdx")
        && (!relative.split('/').any(|part| part.starts_with('.')) || is_paper_markdown(relative))
}

fn is_paper_markdown(path: &str) -> bool {
    path.starts_with(".research/papers/")
        && (path.ends_with("/paper.md") || path.ends_with("/blog.md"))
}

fn file_title(path: &str) -> String {
    Path::new(path).file_name().and_then(|value| value.to_str()).unwrap_or(path).to_string()
}

/// Accumulates paragraphs under the current heading trail.
#[derive(Default)]
struct Chunker {
    chunks: Vec<SourceChunk>,
    headings: Vec<String>,
    paragraph: Vec<String>,
    paragraph_line: u32,
}

impl Chunker {
    fn heading(&mut self, line: u32, level: usize, heading: String) {
        self.flush();
        self.headings.truncate(level.saturating_sub(1));
        self.headings.push(heading);
        push_block(&mut self.chunks, line, "", &self.headings.join(" › "));
    }

    fn text(&mut self, line: u32, text: &str) {
        if self.paragraph.is_empty() {
            self.paragraph_line = line;
        }
        self.paragraph.push(text.to_string());
    }

    fn flush(&mut self) {
        if self.paragraph.is_empty() {
            return;
        }
        let body = self.paragraph.join(" ");
        self.paragraph.clear();
        push_block(&mut self.chunks, self.paragraph_line, &self.headings.join(" › "), &body);
    }

    fn finish(mut self) -> Vec<SourceChunk> {
        self.flush();
        self.chunks
    }
}

pub(super) fn markdown_chunks(content: &str, fallback_title: &str) -> (String, Vec<SourceChunk>) {
    let lines = content.lines().collect::<Vec<_>>();
    let is_front_matter_fence = |line: &&str| line.trim_end_matches('\r') == "---";
    let start = if lines.first().is_some_and(is_front_matter_fence) {
        lines.iter().skip(1).position(is_front_matter_fence).map_or(lines.len(), |index| index + 2)
    } else {
        0
    };
    let mut title = fallback_title.to_string();
    let mut chunker = Chunker::default();
    let mut fence: Option<char> = None;

    for (index, raw_line) in lines.iter().enumerate().skip(start) {
        let line_number = index as u32 + 1;
        let trimmed = raw_line.trim();
        let fence_marker = trimmed
            .strip_prefix("```")
            .map(|_| '`')
            .or_else(|| trimmed.strip_prefix("~~~").map(|_| '~'));
        if let Some(marker) = fence_marker {
            chunker.flush();
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some((level, heading)) = markdown_heading(raw_line) {
            if level == 1 && title == fallback_title {
                title = heading.clone();
            }
            chunker.heading(line_number, level, heading);
        } else if trimmed.is_empty() {
            chunker.flush();
        } else {
            chunker.text(line_number, raw_line);
        }
    }
    (title, chunker.finish())
}

fn markdown_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    let level = trimmed.chars().take_while(|character| *character == '#').count();
    if !(1..=6).contains(&level) || !trimmed[level..].starts_with(char::is_whitespace) {
        return None;
    }
    let heading = trimmed[level..].trim().trim_end_matches('#').trim().to_string();
    (!heading.is_empty()).then_some((level, heading))
}

pub(super) fn latex_chunks(content: &str) -> Vec<SourceChunk> {
    let mut chunker = Chunker::default();
    for (index, raw_line) in content.lines().enumerate() {
        let line_number = index as u32 + 1;
        let line = strip_latex_comment(raw_line);
        let trimmed = line.trim();
        if let Some((level, heading)) = latex_heading(line) {
            chunker.heading(line_number, level, heading);
        } else if trimmed.is_empty() {
            chunker.flush();
        } else if !is_latex_structure_only(trimmed) {
            chunker.text(line_number, trimmed);
        }
    }
    chunker.finish()
}

fn strip_latex_comment(line: &str) -> &str {
    for (index, character) in line.char_indices() {
        if character != '%' {
            continue;
        }
        let slash_count = line[..index].chars().rev().take_while(|value| *value == '\\').count();
        if slash_count % 2 == 0 {
            return &line[..index];
        }
    }
    line
}

fn latex_heading(line: &str) -> Option<(usize, String)> {
    const COMMANDS: [(&str, usize); 7] = [
        ("part", 1),
        ("chapter", 1),
        ("section", 2),
        ("subsection", 3),
        ("subsubsection", 4),
        ("paragraph", 5),
        ("subparagraph", 6),
    ];
    for (command, level) in COMMANDS {
        let needle = format!("\\{command}");
        let Some(start) = line.find(&needle) else {
            continue;
        };
        let rest = line[start + needle.len()..].trim_start();
        let rest = rest.strip_prefix('*').map_or(rest, str::trim_start);
        let rest = rest.strip_prefix('{')?;
        let mut depth = 1usize;
        let end = rest.char_indices().find_map(|(index, character)| {
            match character {
                '{' => depth += 1,
                '}' => depth -= 1,
                _ => {}
            }
            (depth == 0).then_some(index)
        })?;
        let heading = collapse_whitespace(&rest[..end]);
        if !heading.is_empty() {
            return Some((level, heading));
        }
    }
    None
}

fn is_latex_structure_only(line: &str) -> bool {
    [
        "\\documentclass",
        "\\usepackage",
        "\\begin{",
        "\\end{",
        "\\label{",
        "\\bibliography{",
        "\\bibliographystyle{",
        "\\includegraphics",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn push_block(chunks: &mut Vec<SourceChunk>, line: u32, context: &str, body: &str) {
    let body = collapse_whitespace(body);
    if body.is_empty() {
        return;
    }
    let pieces = split_block(&body, MAX_BLOCK_CHARS.saturating_sub(context.chars().count() + 1));
    for piece in pieces {
        let text = if context.is_empty() || piece == context {
            piece
        } else {
            format!("{context}\n{piece}")
        };
        chunks.push(SourceChunk { line, text });
    }
}

fn split_block(text: &str, maximum: usize) -> Vec<String> {
    let maximum = maximum.max(200);
    if text.chars().count() <= maximum {
        return vec![text.to_string()];
    }
    let mut pieces = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let needed = word.chars().count() + usize::from(!current.is_empty());
        if !current.is_empty() && current.chars().count() + needed > maximum {
            pieces.push(std::mem::take(&mut current));
        }
        // An over-long word always flushed `current` above.
        if word.chars().count() > maximum {
            let chars = word.chars().collect::<Vec<_>>();
            pieces.extend(chars.chunks(maximum).map(|slice| slice.iter().collect()));
            continue;
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(chunks: &[SourceChunk]) -> Vec<&str> {
        chunks.iter().map(|chunk| chunk.text.as_str()).collect()
    }

    #[test]
    fn markdown_and_latex_chunk_on_stable_prose_boundaries() {
        let (_, markdown) = markdown_chunks(
            "---\ntags: [private]\n---\n# Methods\n\nFirst paragraph.\ncontinued here.\n\n## Results\n\nSecond paragraph.\n\n```rs\nsecret_code();\n```\n",
            "paper.md",
        );
        assert_eq!(
            texts(&markdown),
            [
                "Methods",
                "Methods\nFirst paragraph. continued here.",
                "Methods › Results",
                "Methods › Results\nSecond paragraph.",
            ]
        );

        let latex = latex_chunks(
            "\\documentclass{article}\n\\section{Method}\n\nA local approach. % hidden note\n\n\\subsection{Evaluation}\n\nA measured result.\n",
        );
        assert_eq!(
            texts(&latex),
            [
                "Method",
                "Method\nA local approach.",
                "Method › Evaluation",
                "Method › Evaluation\nA measured result.",
            ]
        );
    }
}
