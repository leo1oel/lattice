//! The PDFs builds write for the project's root documents, wherever those
//! sit: `main.tex` builds `main.pdf`, `cvpr/main.tex` builds `cvpr/main.pdf`
//! (latexmk `-cd -outdir=.`, see `latex::latexmk`).
//!
//! Such a PDF is this copy's own build output, never something to share:
//! Overleaf sync leaves it out in both directions, and a folder opened here
//! keeps it out of the version timeline. A PDF that came from anywhere else
//! at that path would be shown as if this copy had built it.

use super::manifest::ensure_ignore_line;
use crate::models::ProjectManifest;
use std::path::Path;

/// Every root document's PDF, relative to the project with `/`.
pub fn root_document_pdfs(manifest: &ProjectManifest) -> Vec<String> {
    (manifest.root_documents.iter())
        .filter_map(|document| {
            let path = document.path.replace('\\', "/");
            let split = path.len().checked_sub(".tex".len())?;
            let (stem, extension) = (path.get(..split)?, path.get(split..)?);
            (!stem.is_empty() && extension.eq_ignore_ascii_case(".tex"))
                .then(|| format!("{stem}.pdf"))
        })
        .collect()
}

/// Keep each root document's PDF out of git. A project Lattice made ignores
/// `/main.pdf` from birth (`create_skeleton`); a folder it adopted, such as an
/// Overleaf or git clone, had nothing, so every automatic version committed
/// the PDF, and anyone pulling it got this copy's build in place of theirs.
pub(super) fn ignore_root_document_pdfs(
    root: &Path, manifest: &ProjectManifest,
) -> Result<(), String> {
    for pdf in root_document_pdfs(manifest) {
        ensure_ignore_line(&root.join(".gitignore"), &format!("/{}", gitignore_literal(&pdf)))?;
    }
    Ok(())
}

/// `path` as a gitignore pattern that matches only itself: the characters
/// gitignore reads as globs or comments are escaped, and so is trailing
/// whitespace, which it would otherwise drop.
fn gitignore_literal(path: &str) -> String {
    let mut pattern = String::with_capacity(path.len());
    for (index, character) in path.char_indices() {
        let at_start = index == 0 && matches!(character, '#' | '!');
        let trailing_space = character == ' ' && path[index..].trim_end().is_empty();
        if at_start || trailing_space || matches!(character, '\\' | '*' | '?' | '[' | ']') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::RootDocument;

    fn manifest(paths: &[&str]) -> ProjectManifest {
        let mut manifest = super::super::create::default_manifest("p");
        manifest.root_documents = (paths.iter())
            .map(|path| RootDocument {
                path: path.to_string(),
                name: String::new(),
                is_default: false,
                chosen: false,
            })
            .collect();
        manifest
    }

    #[test]
    fn each_root_document_names_the_pdf_beside_it() {
        let roots = manifest(&["main.tex", "cvpr/main.tex", "Paper.TEX", "notes.md", ".tex"]);
        assert_eq!(root_document_pdfs(&roots), ["main.pdf", "cvpr/main.pdf", "Paper.pdf"]);
    }

    #[test]
    fn a_pattern_matches_only_its_own_path() {
        assert_eq!(gitignore_literal("cvpr/main.pdf"), "cvpr/main.pdf");
        assert_eq!(gitignore_literal("#draft [v2]*.pdf"), "\\#draft \\[v2\\]\\*.pdf");
        assert_eq!(gitignore_literal("!a b .pdf"), "\\!a b .pdf");
    }
}
