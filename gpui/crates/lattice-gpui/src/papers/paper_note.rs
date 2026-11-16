//! A paper's note (`paper-notes.ts`): one Markdown file per paper in the
//! project, under `notes/`, named by its citation key. The reader's Add to
//! note appends a quote with its source link there, and Zotero's
//! annotations come in there (`zotero/notes.rs`), so the note leads back to
//! the page each passage came from. The file is an ordinary project
//! document the writer can edit, link and share like any other.

use std::path::Path;

use lattice_core::{papers::PaperSummary, project as core_project};

use super::source_link::markdown_text;

/// `notes/<citation key>.md`, or the library id for a paper the
/// bibliography does not key.
pub fn note_path(paper: &PaperSummary) -> String {
    note_file(paper.citation_key.as_deref(), &paper.arxiv_id)
}

/// [`note_path`] of the paper keyed `citation_key` with the library id
/// `arxiv_id`.
pub fn note_file(citation_key: Option<&str>, arxiv_id: &str) -> String {
    let source = citation_key
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .unwrap_or(arxiv_id);
    static UNSAFE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[^\p{L}\p{N}._-]+").unwrap());
    let name = UNSAFE.replace_all(source, "-");
    let name = name.trim_start_matches(['-', '.']).trim_end_matches('-');
    format!("notes/{}.md", if name.is_empty() { "paper" } else { name })
}

/// The paper's reading file (its full text with `full_text`, else its
/// overview), from a note at `note` (`paperLinkHref`): relative, so any tool
/// resolves it.
pub fn reading_href(note: &str, arxiv_id: &str, full_text: bool) -> String {
    let depth = note
        .split('/')
        .filter(|part| !part.is_empty())
        .count()
        .saturating_sub(1);
    let file = if full_text { "paper" } else { "blog" };
    format!(
        "{}.research/papers/{arxiv_id}/{file}.md",
        "../".repeat(depth)
    )
}

/// The note after adding `entry` (`withPaperNoteEntry`): appended after a
/// blank line, or, for a note not yet written, below the paper's title
/// linking to the paper.
pub fn with_entry(current: Option<&str>, paper: &PaperSummary, entry: &str) -> String {
    let Some(current) = current else {
        let title = markdown_text(if paper.title.trim().is_empty() {
            &paper.arxiv_id
        } else {
            paper.title.trim()
        });
        let href = reading_href(&note_path(paper), &paper.arxiv_id, paper.has_full_text);
        return format!("# {title}\n\n[{title}]({href})\n\n{entry}\n");
    };
    let kept = current.trim_end();
    if kept.is_empty() {
        format!("{entry}\n")
    } else {
        format!("{kept}\n\n{entry}\n")
    }
}

/// Rewrite `paper`'s note in the project at `root` as `change` gives it
/// from what is there now (`None` for a note not yet written); `change`
/// answers `None` to leave it (`updatePaperNote`). The note's path.
pub fn update_note(
    root: &Path,
    paper: &PaperSummary,
    change: impl FnOnce(Option<&str>) -> Option<String>,
) -> Result<String, String> {
    let path = note_path(paper);
    let current = root
        .join(&path)
        .is_file()
        .then(|| core_project::read_file(root, &path))
        .transpose()?;
    if let Some(content) = change(current.as_deref()) {
        // The text read is the base: an edit that lands meanwhile is merged,
        // not overwritten.
        core_project::apply_editor_transaction(root, path.clone(), content, current, None)?;
    }
    Ok(path)
}

/// Append `entry` to `paper`'s note in the project at `root`, writing the
/// note if it is new (`addToPaperNote`). The note's path.
pub fn add_to_note(root: &Path, paper: &PaperSummary, entry: &str) -> Result<String, String> {
    update_note(root, paper, |current| {
        Some(with_entry(current, paper, entry))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::model::test_support::{paper, with};

    // `paper-notes.test.ts`: a new note starts with the paper's title
    // linking to its reading file; a later entry follows a blank line.
    #[test]
    fn a_note_starts_with_the_paper_then_gathers_entries() {
        let folder = tempfile::tempdir().unwrap();
        let attention = with(paper("Attention Is All You Need"), |p| {
            p.arxiv_id = "1706.03762".into();
            p.citation_key = Some("vaswani2017".into());
            p.has_full_text = true;
        });
        let path = add_to_note(folder.path(), &attention, "> first").unwrap();
        assert_eq!(path, "notes/vaswani2017.md");
        add_to_note(folder.path(), &attention, "> second").unwrap();
        assert_eq!(
            std::fs::read_to_string(folder.path().join(&path)).unwrap(),
            "# Attention Is All You Need\n\n[Attention Is All You Need](../.research/papers/1706.03762/paper.md)\n\n> first\n\n> second\n"
        );
        assert_eq!(
            reading_href("notes/deep/x.md", "1706.03762", false),
            "../../.research/papers/1706.03762/blog.md"
        );
    }
}
