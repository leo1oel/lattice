//! What a build compiled and wrote, read around it: the project's files,
//! each PDF's fingerprint before it (did a failed build write a new one?),
//! and the text of each file its diagnostics name, as it compiled them.

use std::{
    collections::HashMap,
    hash::{Hash as _, Hasher as _},
    path::{Path, PathBuf},
};

use lattice_core::models::{Diagnostic, FileNode};

use crate::build::diagnostics;

/// Every path in the project tree, parents before their children.
pub(super) fn flatten(nodes: &[FileNode], out: &mut Vec<String>) {
    for node in nodes {
        if !node.path.is_empty() {
            out.push(node.path.clone());
        }
        flatten(&node.children, out);
    }
}

/// What a PDF holds, to tell whether a failed build wrote a new one. Not its
/// time: lattice-core puts the last good PDF back after a failed build
/// (`shown_pdf.rs`), which writes the file without a new page in it.
fn fingerprint(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(hasher.finish())
}

/// The PDF of each document a build could compile, fingerprinted before it.
pub(super) fn fingerprint_pdfs(root: &Path, documents: &[String]) -> HashMap<PathBuf, u64> {
    documents
        .iter()
        .filter_map(|document| {
            let pdf = root.join(document).with_extension("pdf");
            fingerprint(&pdf).map(|hash| (pdf, hash))
        })
        .collect()
}

/// The build wrote `pdf` anew: it holds other bytes than before the build,
/// or there was none.
pub(super) fn rewrote(pdf: &Path, before: &HashMap<PathBuf, u64>) -> bool {
    fingerprint(pdf) != before.get(pdf).copied()
}

/// The text of each project file the diagnostics name, keyed as they name
/// it: what the build compiled. An editor's text as the build saved it, since
/// an autosave during the build writes newer text to disk; else the file on
/// disk, and only a file in the project tree.
pub(super) fn read_sources(
    root: &Path,
    diagnostics: &[Diagnostic],
    root_document: &str,
    files: &[String],
    saved: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut sources = HashMap::new();
    for diagnostic in diagnostics {
        let Some(file) = &diagnostic.file else {
            continue;
        };
        if sources.contains_key(file) {
            continue;
        }
        let path = diagnostics::resolve_path(Some(file), files, root_document);
        let text = match saved.get(&path) {
            Some(text) => Some(text.clone()),
            None if files.contains(&path) => std::fs::read_to_string(root.join(&path))
                .ok()
                .map(|text| crate::editor_panel::normalize_breaks(&text)),
            None => None,
        };
        if let Some(text) = text {
            sources.insert(file.clone(), text);
        }
    }
    sources
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pdf_is_rewritten_only_against_its_own_bytes_before_the_build() {
        let root = std::env::temp_dir().join(format!("lattice-rewrote-{}", std::process::id()));
        std::fs::create_dir_all(root.join("figures")).unwrap();
        std::fs::write(root.join("main.pdf"), "the paper").unwrap();
        std::fs::write(root.join("figures/plot.pdf"), "the figure").unwrap();
        let documents = ["main.tex".to_string(), "figures/plot.tex".to_string()];
        let before = fingerprint_pdfs(&root, &documents);
        let plot = root.join("figures/plot.pdf");
        let main = root.join("main.pdf");
        let chapter = root.join("chapters/intro.pdf");

        let left_in_place = rewrote(&plot, &before);
        std::fs::write(&main, "the paper, typeset again").unwrap();
        let typeset = rewrote(&main, &before);
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(&chapter, "a first chapter").unwrap();
        let first = rewrote(&chapter, &before);
        std::fs::remove_dir_all(&root).ok();

        assert!(!left_in_place);
        assert!(typeset);
        assert!(first);
    }

    fn naming(file: &str) -> Diagnostic {
        Diagnostic {
            file: Some(file.to_string()),
            line: Some(1),
            column: None,
            end_line: None,
            end_column: None,
            level: "error".into(),
            message: "Undefined control sequence.".into(),
            code: None,
            params: Default::default(),
        }
    }

    #[test]
    fn sources_are_the_text_the_build_saved_and_only_project_files_with_buffer_breaks() {
        let base =
            std::env::temp_dir().join(format!("lattice-read-sources-{}", std::process::id()));
        let root = base.join("paper");
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(root.join("main.tex"), "autosaved during the build").unwrap();
        std::fs::write(
            root.join("chapters/intro.tex"),
            "on disk\r\nwith CRLF breaks\r\n",
        )
        .unwrap();
        std::fs::write(base.join("secret.tex"), "outside the project").unwrap();
        let files = vec![
            "main.tex".to_string(),
            "chapters".to_string(),
            "chapters/intro.tex".to_string(),
        ];
        let saved = HashMap::from([("main.tex".to_string(), "as built".to_string())]);

        let sources = read_sources(
            &root,
            &[
                naming("main.tex"),
                naming("./chapters/intro.tex"),
                naming("../secret.tex"),
            ],
            "main.tex",
            &files,
            &saved,
        );
        std::fs::remove_dir_all(&base).ok();

        assert_eq!(
            sources.get("main.tex").map(String::as_str),
            Some("as built")
        );
        assert_eq!(
            sources.get("./chapters/intro.tex").map(String::as_str),
            Some("on disk\nwith CRLF breaks\n")
        );
        assert_eq!(sources.get("../secret.tex"), None);
        assert_eq!(sources.len(), 2);
    }
}
