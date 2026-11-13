//! A PDF on this Mac as a cited work's text: a Zotero attachment, read in
//! place and converted like a downloaded PDF. Such a file has neither an arXiv
//! id nor a URL for the library to join on, so its bundle names the citation it
//! belongs to (`PaperMetadata::citation_key`), and is keyed by that citation:
//! attaching again replaces it.
//!
//! The bundle keeps a copy of the PDF beside its text (`original.pdf`), so the
//! reader shows the very pages the writer read and annotated in Zotero, and a
//! note's page links (zotero-annotations.ts) open at the right page whether
//! or not Zotero still has the file where it was.

use super::bundle::{
    build_in_scratch, bundle_result, reset_asset_manifest, swap_in_bundle, validate_paper_bundle,
    web_reference_id, FetchResult, PaperMetadata, ANYDOC_CONVERTER,
};
use super::convert::{pdf_text, MAX_DOWNLOAD_BYTES};
use super::markdown::{markdown_has_body, normalize_imported_markdown, prefixed_line};
use crate::project;
use crate::util::err;
use std::fs;
use std::path::Path;

/// The bundle's copy of the PDF its text came from.
pub(super) const ORIGINAL_PDF: &str = "original.pdf";

/// Convert the PDF at `path` into the bundle of the citation `citation_key`.
pub fn attach_pdf_file(
    root: &Path, citation_key: &str, path: &Path,
) -> Result<FetchResult, String> {
    let citation_key = citation_key.trim();
    if citation_key.is_empty() {
        return Err("A PDF can only be attached to a cited paper.".to_string());
    }
    if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("pdf")) {
        return Err(format!("Not a PDF: {}", path.display()));
    }
    let size = fs::metadata(path)
        .map_err(|_| format!("The PDF is not on this Mac: {}", path.display()))?
        .len();
    if size > MAX_DOWNLOAD_BYTES as u64 {
        return Err("The PDF is larger than the 100 MB conversion limit.".to_string());
    }
    let bytes = fs::read(path).map_err(err)?;
    let id = web_reference_id(&format!("citation:{}", citation_key.to_lowercase()));
    let dir = project::creation_path(root, &format!(".research/papers/{id}"))?;
    let file_name = path.file_stem().map(|stem| stem.to_string_lossy().into_owned());
    build_in_scratch(root, |output_dir| {
        let body = pdf_text(&bytes)?;
        let title =
            prefixed_line(&body, "# ").or(file_name).unwrap_or_else(|| citation_key.to_string());
        // The caveat names the kept PDF: an agent that reaches this text by a
        // search hit or a mention, rather than through list_papers' pdfPath,
        // would otherwise go looking for "the PDF" outside the bundle.
        let markdown = normalize_imported_markdown(&format!(
            "---\ntitle: {}\nsource: \"pdf-text-layer\"\nfidelity: \"Converted from the PDF text layer. Figures are absent and equations may be garbled; verify against {ORIGINAL_PDF}, beside this file, before quoting.\"\n---\n\n{body}",
            serde_json::to_string(&title).map_err(err)?,
        ));
        fs::write(output_dir.join("paper.md"), &markdown).map_err(err)?;
        fs::write(output_dir.join(ORIGINAL_PDF), &bytes).map_err(err)?;
        reset_asset_manifest(output_dir)?;
        let metadata = PaperMetadata {
            complete: markdown_has_body(&body),
            citation_key: citation_key.to_string(),
            ..PaperMetadata::new(&id, &id, title, ANYDOC_CONVERTER, "pdf-text-layer", "", &markdown)
        };
        validate_paper_bundle(output_dir, &metadata)?;
        metadata.write(output_dir)?;
        swap_in_bundle(output_dir, &dir)
    })?;
    Ok(bundle_result(&id, &dir, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::list_papers;
    use crate::papers::test_support::TestProject;
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Document, Object, Stream};

    /// A one-page PDF whose text layer holds `lines`.
    fn pdf_with(lines: &[&str]) -> Vec<u8> {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        let mut operations = vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 11.into()]),
            Operation::new("Td", vec![72.into(), 720.into()]),
            Operation::new("TL", vec![14.into()]),
        ];
        for line in lines {
            operations.push(Operation::new("Tj", vec![Object::string_literal(*line)]));
            operations.push(Operation::new("T*", vec![]));
        }
        operations.push(Operation::new("ET", vec![]));
        let content = Content { operations }.encode().unwrap();
        let content_id = document.add_object(Stream::new(dictionary! {}, content));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            }),
        );
        let catalog_id =
            document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        bytes
    }

    const LINES: [&str; 6] = [
        "Sparse attention for long documents",
        "We study how reading notes kept in a reference manager can be cited.",
        "The method keeps a citation key stable across exports and imports.",
        "Experiments cover three corpora of scientific papers and their notes.",
        "Results show the library joins each local file to its citation.",
        "This paragraph exists so the text layer is long enough to count.",
    ];

    #[test]
    fn a_local_pdf_becomes_the_text_of_the_citation_it_was_attached_to() {
        let project = TestProject::new(
            "@article{Lee2024Sparse,\n  title = {Sparse attention for long documents},\n  author = {Lee, Ada},\n  year = {2024},\n  doi = {10.1000/sparse}\n}\n",
        );
        let pdf = project.parent.join("Lee - 2024 - Sparse.pdf");
        fs::write(&pdf, pdf_with(&LINES)).unwrap();

        let fetched = attach_pdf_file(&project.root, "Lee2024Sparse", &pdf).unwrap();

        assert!(fetched.paper_path.ends_with("paper.md"), "{}", fetched.paper_path);
        let papers = list_papers(&project.root).unwrap();
        assert_eq!(papers.len(), 1);
        assert!(papers[0].has_full_text);
        assert_eq!(papers[0].arxiv_id, fetched.arxiv_id);
        let text = fs::read_to_string(project.root.join(&fetched.paper_path)).unwrap();
        assert!(text.contains("citation key stable"), "{text}");
        // The PDF itself stays beside its text, for the reader to show.
        assert!(papers[0].has_local_pdf);
        let kept =
            project.root.join(format!(".research/papers/{}/{ORIGINAL_PDF}", fetched.arxiv_id));
        assert_eq!(fs::read(kept).unwrap(), fs::read(&pdf).unwrap());
        // Attaching again replaces the bundle rather than adding a second one.
        let again = attach_pdf_file(&project.root, "lee2024sparse", &pdf).unwrap();
        assert_eq!(again.arxiv_id, fetched.arxiv_id);
    }

    /// The reported failure: asked for a Zotero paper's table, the agent found
    /// the paper in list_papers but no PDF, searched the project and said it
    /// could not open the PDF. Its library entry, as the agent's gateway
    /// returns it, must name the PDF the bundle keeps, and the converted text
    /// must point there too.
    #[test]
    fn the_agent_library_names_the_pdf_a_zotero_paper_keeps() {
        let project = TestProject::new(
            "@article{Lee2024Sparse,\n  title = {Sparse attention for long documents},\n  author = {Lee, Ada},\n  year = {2024}\n}\n\
             @article{Kim2023Dense,\n  title = {Dense retrieval},\n  author = {Kim, Bo},\n  year = {2023}\n}\n",
        );
        let pdf = project.parent.join("Lee - 2024 - Sparse.pdf");
        fs::write(&pdf, pdf_with(&LINES)).unwrap();
        let fetched = attach_pdf_file(&project.root, "Lee2024Sparse", &pdf).unwrap();

        let listed =
            crate::agent_literature::LiteratureRequest::ListPapers {}.run(&project.root).unwrap();
        let entry = |key: &str| {
            listed["papers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|paper| paper["citationKey"] == key)
                .unwrap_or_else(|| panic!("{key} in {listed}"))
                .clone()
        };
        let attached = entry("Lee2024Sparse");
        let pdf_path = format!(".research/papers/{}/{ORIGINAL_PDF}", fetched.arxiv_id);
        assert_eq!(attached["pdfPath"], pdf_path.as_str(), "{attached}");
        assert_eq!(fs::read(project.root.join(&pdf_path)).unwrap(), fs::read(&pdf).unwrap());
        let text_path = attached["fullTextPath"].as_str().unwrap();
        let text = fs::read_to_string(project.root.join(text_path)).unwrap();
        assert!(text.contains("verify against original.pdf, beside this file"), "{text}");
        // A work Lattice holds no PDF of names none, rather than a path that
        // is not there.
        assert!(entry("Kim2023Dense").get("pdfPath").is_none(), "{listed}");
    }

    #[test]
    fn only_a_readable_pdf_on_this_mac_is_attached() {
        let project = TestProject::new("");
        let missing = project.parent.join("gone.pdf");
        assert!(attach_pdf_file(&project.root, "Key", &missing)
            .unwrap_err()
            .contains("not on this Mac"));
        let notes = project.parent.join("notes.txt");
        fs::write(&notes, "text").unwrap();
        assert!(attach_pdf_file(&project.root, "Key", &notes)
            .unwrap_err()
            .starts_with("Not a PDF"));
        let scanned = project.parent.join("scan.pdf");
        fs::write(&scanned, pdf_with(&["Page 1"])).unwrap();
        assert!(attach_pdf_file(&project.root, "Key", &scanned)
            .unwrap_err()
            .contains("text layer"));
        assert!(attach_pdf_file(&project.root, " ", &scanned).is_err());
        assert!(!project.root.join(".research/papers").read_dir().is_ok_and(|mut dir| dir
            .any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with("web-"))));
    }
}
