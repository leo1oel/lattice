//! The PDF a build writes for the project's default root document, the one
//! Build compiles, wherever it sits: `main.tex` builds `main.pdf`,
//! `cvpr/main.tex` builds `cvpr/main.pdf` (latexmk `-cd -outdir=.`, see
//! `latex::latexmk`).
//!
//! That PDF is this copy's own build output, never something to share:
//! Overleaf sync leaves it out in both directions, since one that came from
//! anywhere else at that path would be shown as if this copy had built it.
//! Other root documents' PDFs sync like any other file: one may be an input
//! of the paper (`\includepdf{supplementary/supp.pdf}`), and collaborators
//! on Overleaf cannot build it themselves.

use super::manifest::default_root_document;
use crate::models::ProjectManifest;

/// The default root document's PDF, relative to the project with `/`.
pub fn default_root_pdf(manifest: &ProjectManifest) -> Option<String> {
    let path = default_root_document(manifest)?.path.replace('\\', "/");
    let split = path.len().checked_sub(".tex".len())?;
    let (stem, extension) = (path.get(..split)?, path.get(split..)?);
    (!stem.is_empty() && extension.eq_ignore_ascii_case(".tex")).then(|| format!("{stem}.pdf"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::RootDocument;

    fn manifest(paths: &[(&str, bool)]) -> ProjectManifest {
        let mut manifest = super::super::create::default_manifest("p");
        manifest.root_documents = (paths.iter())
            .map(|(path, is_default)| RootDocument {
                path: path.to_string(),
                name: String::new(),
                is_default: *is_default,
                chosen: false,
            })
            .collect();
        manifest
    }

    #[test]
    fn only_the_default_root_names_its_pdf() {
        let roots = manifest(&[("supplementary/supp.tex", false), ("cvpr/main.tex", true)]);
        assert_eq!(default_root_pdf(&roots).as_deref(), Some("cvpr/main.pdf"));
        let unmarked = manifest(&[("Paper.TEX", false), ("cvpr/main.tex", false)]);
        assert_eq!(default_root_pdf(&unmarked).as_deref(), Some("Paper.pdf"));
        assert_eq!(default_root_pdf(&manifest(&[("notes.md", true)])), None);
        assert_eq!(default_root_pdf(&manifest(&[(".tex", true)])), None);
        assert_eq!(default_root_pdf(&manifest(&[])), None);
    }
}
