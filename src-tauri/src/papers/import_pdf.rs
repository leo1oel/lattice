//! Importing a PDF link directly: the report itself becomes the full text,
//! and its citation is built from what the PDF and its metadata supply rather
//! than by treating a binary URL as an HTML webpage.

use super::bibliography::{commit_bibliography, HistoryMode};
use super::bundle::{fetch_web_bundle, PaperMetadata};
use super::import::{cancelled, import_report, BIBLIOGRAPHY_CHANGED};
use super::web_citation::{merge_supplied_bibtex, pdf_citation_bibtex};
use crate::models::ProjectManifest;
use crate::papers::ImportResult;
use crate::project;
use crate::util::err;
use crate::web_metadata::bib_url;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Import the report itself, enriching its citation from explicitly supplied
/// metadata rather than treating a binary URL as an HTML webpage.
pub(super) fn import_pdf_citation(
    root: &Path, manifest: &ProjectManifest, url: &str, history: HistoryMode,
    progress: &dyn Fn(&str), cancel: &AtomicBool,
) -> Result<ImportResult, String> {
    progress("fulltext");
    let url = bib_url(url);
    let fetched = match fetch_web_bundle(root, &url, None, cancel) {
        Ok(fetched) => fetched,
        Err(_) if cancel.load(Ordering::Acquire) => return Ok(cancelled(&url)),
        Err(error) => return Err(error),
    };
    let metadata_path =
        project::safe_path(root, &format!(".research/papers/{}/metadata.json", fetched.arxiv_id))?;
    let metadata: PaperMetadata =
        serde_json::from_slice(&fs::read(metadata_path).map_err(err)?).map_err(err)?;
    let markdown =
        fs::read_to_string(project::safe_path(root, &fetched.paper_path)?).map_err(err)?;
    progress("resolving");
    let raw = pdf_citation_bibtex(&markdown, &metadata.title, &url);
    let captured = ImportResult {
        arxiv_id: fetched.arxiv_id,
        paper_path: fetched.paper_path,
        ..cancelled(&metadata.title)
    };
    if cancel.load(Ordering::Acquire) {
        return Ok(captured);
    }
    // The download can take a minute, and the bibliography is the writer's
    // meanwhile: merge into the file as it is now, never as it was when the
    // import began, and merge again if it changes before the commit lands.
    let bibliography_path = project::safe_path(root, &manifest.primary_bibliography)?;
    let mut attempts = 0;
    let (key, already_imported) = loop {
        let base = if bibliography_path.exists() {
            fs::read_to_string(&bibliography_path).map_err(err)?
        } else {
            String::new()
        };
        let (bibliography, key, already_imported) = merge_supplied_bibtex(&base, &raw)?;
        let label = format!("Cite {key}");
        if bibliography == base
            || commit_bibliography(
                root,
                &manifest.primary_bibliography,
                &base,
                &bibliography,
                &label,
                history,
            )?
        {
            break (key, already_imported);
        }
        attempts += 1;
        if attempts == 3 {
            return Err(BIBLIOGRAPHY_CHANGED.into());
        }
    };
    Ok(ImportResult {
        citation_output: import_report(
            &key,
            "pdf",
            if already_imported { "already-present" } else { "added" },
        ),
        citation_key: Some(key),
        already_imported,
        cancelled: false,
        ..captured
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::import::import_reference;
    use crate::papers::library::{list_papers, read_paper};
    use crate::papers::test_support::{serve_once, TestProject};
    #[cfg(unix)]
    use crate::{
        commands,
        papers::test_support::{fake_raw_bibcite, tool_lock, ToolOverride},
    };

    fn import(root: &Path, input: &str) -> Result<ImportResult, String> {
        import_reference(root, input, HistoryMode::Record, &|_| {}, &AtomicBool::new(false))
    }

    /// A complete one-page PDF, with asymmetric title/body and enough text to
    /// distinguish successful conversion from an empty placeholder.
    fn one_page_pdf() -> Vec<u8> {
        let stream = format!(
            "BT /F1 22 Tf 50 750 Td (Direct PDF Study) Tj /F1 12 Tf {} ET",
            "0 -18 Td (Evidence from the imported report remains readable.) Tj ".repeat(8)
        );
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
        ];
        let mut pdf = "%PDF-1.4\n".to_string();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
        }
        let xref = pdf.len();
        pdf.push_str("xref\n0 6\n0000000000 65535 f \n");
        for offset in offsets {
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str(&format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"));
        pdf.into_bytes()
    }

    #[cfg(unix)]
    #[test]
    fn direct_pdf_import_creates_readable_citation_and_reuses_it_offline() {
        let _lock = tool_lock();
        let (url, server) = serve_once(one_page_pdf());
        // A key collision must preserve the unrelated citation verbatim.
        let key = "anonymousXXXXdirect";
        let before = format!("@article{{{key}, title={{Keep me}}, doi={{10.1234/existing}}}}\n");
        let project = TestProject::new(&before);
        let _bibcite = ToolOverride::set(&commands::BIBCITE, &fake_raw_bibcite(&project.parent));
        let imported = import(&project.root, &url).unwrap();
        server.join().unwrap();
        assert!(!imported.already_imported);
        assert_eq!(imported.citation_key.as_deref(), Some(format!("{key}-2").as_str()));
        let markdown = read_paper(&project.root, &imported.arxiv_id).unwrap();
        assert!(markdown.contains("Evidence from the imported report remains readable."));
        assert!(markdown.contains("pdf-text-layer"));
        let bibliography = project.bibliography();
        assert!(bibliography.starts_with(&before));
        let entries = project::parse_bibliography(&bibliography);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].url.as_deref(), Some(url.as_str()));
        let listed = list_papers(&project.root).unwrap();
        assert!(listed.iter().any(|paper| paper.arxiv_id == imported.arxiv_id
            && paper.has_full_text
            && !paper.has_blog));
        let again = import(&project.root, &url).unwrap();
        assert!(again.already_imported);
        assert_eq!(again.citation_key, imported.citation_key);
        assert_eq!(project.bibliography(), bibliography);
        // Only arXiv bundles may be joined by title. A generic PDF must not
        // get attached to a different citation just because titles coincide.
        project.write(
            "references.bib",
            &format!("@misc{{decoy, title={{{}}}}}\n{bibliography}", imported.title),
        );
        let listed = list_papers(&project.root).unwrap();
        let full_text = |key: Option<&str>| {
            listed.iter().find(|paper| paper.citation_key.as_deref() == key).unwrap().has_full_text
        };
        assert!(!full_text(Some("decoy")));
        assert!(full_text(imported.citation_key.as_deref()));
    }

    /// The download can take a minute; an entry the writer, Overleaf or the
    /// agent adds meanwhile must survive the import's commit rather than be
    /// reverted to the text read when the import began (audit S2).
    #[cfg(unix)]
    #[test]
    fn direct_pdf_import_keeps_entries_added_during_the_download() {
        let _lock = tool_lock();
        let (url, server) = serve_once(one_page_pdf());
        let project = TestProject::new("@misc{first, title={First}}\n");
        let _bibcite = ToolOverride::set(&commands::BIBCITE, &fake_raw_bibcite(&project.parent));
        let during =
            "@misc{first, title={First}}\n@misc{during, title={Added during the download}}\n";
        let imported = import_reference(
            &project.root,
            &url,
            HistoryMode::Record,
            &|stage| {
                if stage == "resolving" {
                    project.write("references.bib", during);
                }
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        server.join().unwrap();
        let bibliography = project.bibliography();
        assert!(bibliography.starts_with(during), "{bibliography}");
        let key = imported.citation_key.unwrap();
        let keys: Vec<_> =
            project::parse_bibliography(&bibliography).into_iter().map(|entry| entry.key).collect();
        assert_eq!(keys, ["first", "during", key.as_str()]);
    }

    #[test]
    fn direct_pdf_import_rejects_html_without_writing_a_citation() {
        let (url, server) = serve_once(b"<html><title>Not a PDF</title></html>".to_vec());
        let project = TestProject::new("");
        let error = import(&project.root, &url).unwrap_err();
        server.join().unwrap();
        assert!(error.contains("did not return a PDF"), "{error}");
        assert_eq!(project.bibliography(), "");
    }

    #[test]
    #[ignore = "requires network access"]
    fn direct_pdf_import_live_s_space() {
        let project = TestProject::new("");
        let url = "https://mirros.ai/report/s-space.pdf";
        let result = import(&project.root, url).unwrap();
        let markdown = read_paper(&project.root, &result.arxiv_id).unwrap();
        assert!(markdown.contains("S-Space"), "expected the actual report text");
        assert!(markdown.len() > 10_000);
        assert!(result.citation_key.is_some());
        assert!(result.fetch_error.is_none());
        let bib = project.bibliography();
        let entry = project::parse_bibliography(&bib)
            .into_iter()
            .find(|entry| Some(&entry.key) == result.citation_key.as_ref())
            .unwrap();
        assert_eq!(entry.authors, "MirroS Team");
        assert_eq!(entry.year, "2026");
        assert_eq!(entry.url.as_deref(), Some(url));
        assert!(!bib.contains("needs review"));
        assert!(!bib.contains("Blog post"));
        eprintln!("Imported title: {}; {} bytes of Markdown", result.title, markdown.len());
    }
}
