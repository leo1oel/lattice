//! Full-text bundles under `.research/papers/<key>/`: `paper.md`, an optional
//! `blog.md` (the alphaXiv overview), `paper_assets/` with its manifest, and
//! `metadata.json`, which is what makes a bundle a reusable cache entry.

use super::convert::{convert_paper, download_pdf_text};
use super::ids::{arxiv_base_id, parse_arxiv_id, validate_arxiv_id};
use super::markdown::{
    localize_arxiv_fragment_links, markdown_has_body, normalize_imported_markdown, parse_title,
    prefixed_line,
};
use super::{check_cancelled, err, is_web_url};
use crate::firecrawl::ScrapedPage;
use crate::util::sha256_hex;
use crate::{alphaxiv, commands, project};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path};
use std::sync::atomic::AtomicBool;
use uuid::Uuid;

/// Bump whenever import-time normalization (`markdown::normalize_imported_markdown`)
/// or the converters' output shape changes: a bundle from an older schema is
/// rebuilt on its next fetch rather than kept with the old artifacts.
pub(super) const PAPER_SCHEMA_VERSION: u32 = 8;
const ASSET_MANIFEST_SCHEMA_VERSION: u32 = 1;
const EMPTY_ASSET_MANIFEST: &str = "{\"schema_version\":1,\"assets\":[]}\n";
/// The converter recorded on bundles built from the PDF text layer. Like the
/// arxiv2md requirement in `commands`, this string is part of cache identity:
/// bump it with either parser dependency so old bundles rebuild.
pub(super) const ANYDOC_CONVERTER: &str = "anydoc@0.1.9/pdf-inspector@1.17.0";
/// The converter recorded on webpage captures (see firecrawl.rs). Versioned
/// by API generation, not by crate: the scrape output changes when the
/// service's endpoint does.
pub(super) const FIRECRAWL_CONVERTER: &str = "firecrawl-v2";
const KNOWN_CONVERTERS: [&str; 4] = [
    commands::ARXIV2MD.requirement,
    commands::ARXIV_SOURCE2MD.requirement,
    ANYDOC_CONVERTER,
    FIRECRAWL_CONVERTER,
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PaperMetadata {
    pub(super) arxiv_id: String,
    pub(super) requested_arxiv_id: String,
    #[serde(default)]
    pub(super) title: String,
    pub(super) schema_version: u32,
    pub(super) complete: bool,
    #[serde(default)]
    pub(super) converter: String,
    /// What the markdown was derived from: `arxiv-html` for a LaTeXML
    /// rendering, `arxiv-source` for the TeX parser, `arxiv-pdf` for the
    /// text-layer fallback, `pdf-text-layer` for a direct PDF URL, or `web`
    /// for a scraped page. Empty on older, HTML-derived bundles.
    #[serde(default)]
    pub(super) source: String,
    /// The page a `web` bundle captured. This is the join key back to the
    /// bibliography: a webpage citation has no arXiv id, so `list_papers`
    /// matches its `url` field against this.
    #[serde(default)]
    pub(super) source_url: String,
    #[serde(default)]
    pub(super) paper_sha256: String,
    #[serde(default)]
    pub(super) asset_manifest_schema_version: u32,
}

impl PaperMetadata {
    /// Metadata for a complete bundle whose `paper.md` holds `markdown`.
    pub(super) fn new(
        key: &str, requested: &str, title: String, converter: &str, source: &str, source_url: &str,
        markdown: &str,
    ) -> Self {
        Self {
            arxiv_id: key.to_string(),
            requested_arxiv_id: requested.to_string(),
            title,
            schema_version: PAPER_SCHEMA_VERSION,
            complete: true,
            converter: converter.to_string(),
            source: source.to_string(),
            source_url: source_url.to_string(),
            paper_sha256: sha256_hex(markdown),
            asset_manifest_schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
        }
    }

    pub(super) fn read(dir: &Path) -> Option<Self> {
        serde_json::from_str(&fs::read_to_string(dir.join("metadata.json")).ok()?).ok()
    }

    fn write(&self, dir: &Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(err)?;
        fs::write(dir.join("metadata.json"), format!("{json}\n")).map_err(err)
    }
}

#[derive(Deserialize)]
pub(super) struct AssetManifest {
    schema_version: u32,
    pub(super) assets: Vec<AssetManifestEntry>,
}

#[derive(Deserialize)]
pub(super) struct AssetManifestEntry {
    pub(super) path: String,
    sha256: String,
    size: u64,
    #[serde(rename = "type")]
    mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub arxiv_id: String,
    pub paper_path: String,
    pub blog_path: Option<String>,
    pub reused: bool,
}

/// Cache a complete, unfiltered arxiv2md conversion without touching the
/// bibliography. `progress` receives "fulltext" and "overview" as the fetch
/// enters each network-bound step.
pub fn fetch_paper(
    root: &Path, requested: &str, progress: &dyn Fn(&str),
) -> Result<FetchResult, String> {
    fetch_arxiv_bundle(root, requested, progress, &AtomicBool::new(false))
}

pub(super) fn fetch_arxiv_bundle(
    root: &Path, requested: &str, progress: &dyn Fn(&str), cancel: &AtomicBool,
) -> Result<FetchResult, String> {
    check_cancelled(cancel)?;
    let requested =
        parse_arxiv_id(requested).ok_or_else(|| "Enter a valid arXiv id or URL.".to_string())?;
    validate_arxiv_id(&requested)?;
    let base = arxiv_base_id(&requested).to_string();
    // creation_path rather than safe_path: a legacy id (`cs/9901002`) nests
    // its bundle one level deeper, and safe_path refuses to look through an
    // intermediate directory that does not exist yet.
    let dir = project::creation_path(root, &format!(".research/papers/{base}"))?;
    let cached = PaperMetadata::read(&dir);
    let reusable = cached.as_ref().is_some_and(|m| {
        m.schema_version == PAPER_SCHEMA_VERSION
            && m.complete
            && m.arxiv_id.eq_ignore_ascii_case(&base)
            && file_has_body(&dir.join("paper.md"))
            && (requested == base || m.requested_arxiv_id.eq_ignore_ascii_case(&requested))
            && validate_paper_bundle(&dir, m).is_ok()
    });
    if reusable {
        return Ok(bundle_result(&base, &dir, true));
    }
    progress("fulltext");
    check_cancelled(cancel)?;
    build_in_scratch(root, |output_dir| {
        // The overview is independent of the conversion and an order of
        // magnitude cheaper; fetching it concurrently hides its latency
        // entirely behind arxiv2md's download-and-convert work.
        let overview = std::thread::spawn({
            let base = base.clone();
            move || alphaxiv::fetch_overview(&base)
        });
        let output_path = output_dir.join("paper.md");
        let conversion = convert_paper(&requested, &base, output_dir, &output_path, cancel);
        let blog = overview.join().ok().and_then(Result::ok).flatten();
        check_cancelled(cancel)?;
        let conversion = match conversion {
            Ok(conversion) => conversion,
            // A useful overview must survive failure of every full-text
            // converter. Do not replace an existing (possibly edited) bundle,
            // and leave it incomplete so a later fetch can retry.
            Err(error) => return cache_overview_without_full_text(&dir, blog.as_deref(), &error),
        };
        let markdown = localize_arxiv_fragment_links(
            &normalize_imported_markdown(&conversion.markdown),
            &base,
        );
        fs::write(&output_path, &markdown).map_err(err)?;
        let title = parse_title(&markdown).unwrap_or_else(|| format!("arXiv {base}"));
        let metadata = PaperMetadata::new(
            &base,
            &requested,
            title,
            conversion.converter,
            conversion.source,
            "",
            &markdown,
        );
        validate_paper_bundle(output_dir, &metadata)?;
        metadata.write(output_dir)?;
        progress("overview");
        if let Some(blog) = blog {
            fs::write(output_dir.join("blog.md"), blog).map_err(err)?;
        } else if dir.join("blog.md").is_file() {
            fs::copy(dir.join("blog.md"), output_dir.join("blog.md")).map_err(err)?;
        }
        keep_manual_versions(&dir, output_dir, cached.as_ref())?;
        swap_in_bundle(output_dir, &dir)
    })?;
    Ok(bundle_result(&base, &dir, false))
}

/// Atomic replacement must not erase earlier manual-version backups
/// (`paper.legacy*.md`). If the current paper was edited since it was built,
/// keep that version too, under a fresh name rather than replacing an older
/// backup.
fn keep_manual_versions(
    dir: &Path, output_dir: &Path, cached: Option<&PaperMetadata>,
) -> Result<(), String> {
    if dir.is_dir() {
        for entry in fs::read_dir(dir).map_err(err)? {
            let entry = entry.map_err(err)?;
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            if entry.file_type().map_err(err)?.is_file()
                && file_name.starts_with("paper.legacy")
                && file_name.ends_with(".md")
            {
                fs::copy(entry.path(), output_dir.join(file_name)).map_err(err)?;
            }
        }
    }
    let current = dir.join("paper.md");
    let edited = |metadata: &PaperMetadata| {
        metadata.paper_sha256.is_empty()
            || fs::read(&current)
                .ok()
                .is_none_or(|bytes| sha256_hex(&bytes) != metadata.paper_sha256)
    };
    if current.is_file() && cached.is_none_or(edited) {
        let default_legacy = output_dir.join("paper.legacy.md");
        let legacy_path = if default_legacy.exists() {
            output_dir.join(format!("paper.legacy.{}.md", Uuid::new_v4()))
        } else {
            default_legacy
        };
        fs::copy(&current, legacy_path).map_err(err)?;
    }
    Ok(())
}

pub(super) fn cache_overview_without_full_text(
    dir: &Path, blog: Option<&str>, error: &str,
) -> Result<(), String> {
    if file_has_body(&dir.join("blog.md")) {
        return Ok(());
    }
    let blog = blog.filter(|blog| markdown_has_body(blog)).ok_or_else(|| error.to_string())?;
    fs::create_dir_all(dir).map_err(err)?;
    fs::write(dir.join("blog.md"), blog).map_err(err)
}

/// The bundle directory name for a captured webpage: a stable digest of the
/// URL, in a shape `validate_paper_key` can recognize. Everything downstream
/// (tabs, read_paper, collab paths) already keys bundles by this string, so a
/// webpage rides the same rails as an arXiv id.
pub(super) fn web_reference_id(url: &str) -> String {
    format!("web-{}", &sha256_hex(url.trim())[..16])
}

/// A direct link to a PDF outside arXiv; arXiv PDFs keep their
/// identifier-based citation and semantic conversion.
pub(super) fn is_pdf_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.path().to_ascii_lowercase().ends_with(".pdf")
            && !matches!(url.host_str(), Some("arxiv.org" | "www.arxiv.org" | "export.arxiv.org"))
    })
}

/// Capture a webpage or direct PDF as a bundle under `.research/papers/web-…`.
///
/// AlphaXiv URLs use its native overview API and optional PDF rather than a
/// generic webpage scrape. Both resources can succeed independently.
pub fn fetch_web_reference(root: &Path, url: &str) -> Result<FetchResult, String> {
    fetch_web_bundle(root, url, None, &AtomicBool::new(false))
}

/// `page` is a capture the citation resolver already rendered, so the page is
/// not scraped twice.
pub(super) fn fetch_web_bundle(
    root: &Path, url: &str, page: Option<ScrapedPage>, cancel: &AtomicBool,
) -> Result<FetchResult, String> {
    check_cancelled(cancel)?;
    let canonical_url = alphaxiv::paper_id_from_url(url.trim())
        .map(|id| format!("https://www.alphaxiv.org/abs/{}", arxiv_base_id(&id)));
    let url = canonical_url.as_deref().unwrap_or(url.trim());
    if !is_web_url(url) {
        return Err("Enter an http(s) URL.".to_string());
    }
    let id = web_reference_id(url);
    let dir = project::creation_path(root, &format!(".research/papers/{id}"))?;
    // A page can change under its URL, but a citation wants the text that was
    // cited: reuse any complete capture and let deleting the bundle be the
    // explicit way to take a fresh snapshot.
    let reusable = PaperMetadata::read(&dir).is_some_and(|m| {
        m.schema_version == PAPER_SCHEMA_VERSION
            && m.complete
            && m.source_url == url
            && (file_has_body(&dir.join("paper.md")) || file_has_body(&dir.join("blog.md")))
            && validate_paper_bundle(&dir, &m).is_ok()
    });
    if reusable {
        return Ok(bundle_result(&id, &dir, true));
    }
    build_in_scratch(root, |output_dir| {
        let mut blog = None;
        // Direct PDFs have no HTML title and must not go through the webpage
        // scraper. Reuse its URL-keyed bundle so readers and bibliography joins
        // keep the same contract, without pretending the PDF is an arXiv work.
        let (title, body, from_pdf) = if let Some(paper_id) = alphaxiv::paper_id_from_url(url) {
            let paper = alphaxiv::resolve_paper(&paper_id)?
                .ok_or_else(|| "The alphaXiv paper was not found.".to_string())?;
            blog = fs::read_to_string(dir.join("blog.md"))
                .ok()
                .filter(|blog| markdown_has_body(blog))
                .or_else(|| {
                    alphaxiv::fetch_paper_overview(&paper).unwrap_or_else(|error| {
                        log::debug!("alphaXiv overview unavailable: {error}");
                        None
                    })
                });
            check_cancelled(cancel)?;
            let pdf_url = format!("https://www.alphaxiv.org/abs/{}.pdf", paper.universal_id);
            let body = match download_pdf_text(&pdf_url) {
                Ok(body) if markdown_has_body(&body) => body,
                result if blog.is_some() => {
                    log::debug!("alphaXiv PDF unavailable; keeping overview: {result:?}");
                    String::new()
                }
                Err(error) => return Err(error),
                Ok(_) => return Err("The alphaXiv PDF has no readable text.".into()),
            };
            (paper.title, body, true)
        } else if is_pdf_url(url) {
            let body = download_pdf_text(url)?;
            let file_name = || {
                let path = url.split(['?', '#']).next().unwrap_or(url);
                path.rsplit('/').next().unwrap_or(url).to_string()
            };
            (prefixed_line(&body, "# ").unwrap_or_else(file_name), body, true)
        } else {
            let page = match page {
                Some(page) => page,
                None => crate::firecrawl::scrape(url)?,
            };
            let title = page.title.filter(|title| !title.trim().is_empty());
            (title.unwrap_or_else(|| url.to_string()), page.markdown, false)
        };
        check_cancelled(cancel)?;
        let (source, converter, fidelity) = if from_pdf {
            ("pdf-text-layer", ANYDOC_CONVERTER, "fidelity: \"Converted from the PDF text layer. Figures are absent and equations may be garbled; verify against the PDF before quoting.\"\n")
        } else {
            ("web", FIRECRAWL_CONVERTER, "")
        };
        let markdown = normalize_imported_markdown(&format!(
            "---\ntitle: {}\nurl: {}\nsource: \"{source}\"\n{fidelity}---\n\n{body}",
            serde_json::to_string(&title).map_err(err)?,
            serde_json::to_string(url).map_err(err)?,
        ));
        fs::write(output_dir.join("paper.md"), &markdown).map_err(err)?;
        if let Some(blog) = blog {
            fs::write(output_dir.join("blog.md"), blog).map_err(err)?;
        }
        reset_asset_manifest(output_dir)?;
        let metadata = PaperMetadata {
            complete: markdown_has_body(&body),
            ..PaperMetadata::new(&id, &id, title, converter, source, url, &markdown)
        };
        validate_paper_bundle(output_dir, &metadata)?;
        metadata.write(output_dir)?;
        swap_in_bundle(output_dir, &dir)
    })?;
    Ok(bundle_result(&id, &dir, false))
}

/// Build a bundle in a scratch directory beside the library. Everything up to
/// the final swap happens there, and a failure on any path must not strand a
/// `.fetch-*` directory in the project.
fn build_in_scratch(
    root: &Path, build: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let papers_root = project::safe_path(root, ".research/papers")?;
    let temp_root = papers_root.join(format!(".fetch-{}", Uuid::new_v4()));
    let output_dir = temp_root.join("output");
    fs::create_dir_all(&output_dir).map_err(err)?;
    let built = build(&output_dir);
    let _ = fs::remove_dir_all(&temp_root);
    built
}

/// Replace `dir` with the finished bundle, restoring the old one if the move fails.
fn swap_in_bundle(output_dir: &Path, dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir.parent().unwrap()).map_err(err)?;
    let backup = dir.with_extension(format!("old-{}", Uuid::new_v4()));
    if dir.exists() {
        fs::rename(dir, &backup).map_err(err)?;
    }
    if let Err(error) = fs::rename(output_dir, dir) {
        if backup.exists() {
            let _ = fs::rename(&backup, dir);
        }
        return Err(err(error));
    }
    let _ = fs::remove_dir_all(backup);
    Ok(())
}

fn bundle_result(key: &str, dir: &Path, reused: bool) -> FetchResult {
    let path = |file: &str| format!(".research/papers/{key}/{file}");
    FetchResult {
        arxiv_id: key.to_string(),
        paper_path: if file_has_body(&dir.join("paper.md")) {
            path("paper.md")
        } else {
            String::new()
        },
        blog_path: dir.join("blog.md").is_file().then(|| path("blog.md")),
        reused,
    }
}

pub(super) fn file_has_body(path: &Path) -> bool {
    fs::read_to_string(path).ok().is_some_and(|markdown| markdown_has_body(&markdown))
}

/// An empty `paper_assets/`, replacing whatever a converter left there: text
/// without extractable figures still owes the bundle its manifest.
pub(super) fn reset_asset_manifest(dir: &Path) -> Result<(), String> {
    let assets_dir = dir.join("paper_assets");
    if assets_dir.exists() {
        fs::remove_dir_all(&assets_dir).map_err(err)?;
    }
    fs::create_dir_all(&assets_dir).map_err(err)?;
    fs::write(assets_dir.join("manifest.json"), EMPTY_ASSET_MANIFEST).map_err(err)
}

pub(super) fn read_asset_manifest(dir: &Path) -> Result<AssetManifest, String> {
    let bytes = fs::read(dir.join("paper_assets/manifest.json")).map_err(err)?;
    serde_json::from_slice(&bytes).map_err(|error| format!("Invalid paper asset manifest: {error}"))
}

/// A manifest path that stays inside the bundle's `paper_assets/`.
pub(super) fn is_bundle_asset_path(path: &Path) -> bool {
    path.starts_with("paper_assets")
        && path.components().all(|component| matches!(component, Component::Normal(_)))
}

pub(super) fn validate_paper_bundle(
    directory: &Path, metadata: &PaperMetadata,
) -> Result<(), String> {
    if !KNOWN_CONVERTERS.contains(&metadata.converter.as_str())
        || metadata.asset_manifest_schema_version != ASSET_MANIFEST_SCHEMA_VERSION
    {
        return Err("The cached paper was produced by an unsupported converter.".to_string());
    }
    let paper = fs::read(directory.join("paper.md")).map_err(err)?;
    if sha256_hex(&paper) != metadata.paper_sha256 {
        return Err("The cached paper markdown does not match its metadata.".to_string());
    }
    let manifest = read_asset_manifest(directory)?;
    if manifest.schema_version != ASSET_MANIFEST_SCHEMA_VERSION {
        return Err("Unsupported paper asset manifest version.".to_string());
    }
    let canonical_directory = fs::canonicalize(directory).map_err(err)?;
    for asset in manifest.assets {
        let relative = Path::new(&asset.path);
        if !is_bundle_asset_path(relative) {
            return Err(format!("Unsafe paper asset path: {}", asset.path));
        }
        if !matches!(
            asset.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml"
        ) {
            return Err(format!("Unsupported paper asset type: {}", asset.mime_type));
        }
        let canonical_path = fs::canonicalize(directory.join(relative))
            .map_err(|_| format!("Paper asset is missing: {}", asset.path))?;
        if !canonical_path.starts_with(&canonical_directory) || !canonical_path.is_file() {
            return Err(format!("Unsafe paper asset path: {}", asset.path));
        }
        let bytes = fs::read(&canonical_path).map_err(err)?;
        if bytes.len() as u64 != asset.size || sha256_hex(&bytes) != asset.sha256 {
            return Err(format!("Paper asset failed integrity validation: {}", asset.path));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::library::{list_papers, read_paper_blog_local};
    use crate::papers::test_support::TestProject;
    use crate::test_support::TempDir;

    #[test]
    fn failed_full_text_keeps_overview_without_inventing_a_paper_or_overwriting_edits() {
        let project = TestProject::new("@misc{report, title={Report}, eprint={2609.12345}}");
        let dir = project.root.join(".research/papers/2609.12345");
        assert_eq!(
            cache_overview_without_full_text(&dir, None, "PDF failed"),
            Err("PDF failed".into())
        );
        assert!(!dir.exists());
        let overview = "# Overview\n\nCited claim [p8](https://example.org/report.pdf#page=8).";
        cache_overview_without_full_text(&dir, Some(overview), "PDF failed").unwrap();
        let papers = list_papers(&project.root).unwrap();
        assert!(papers[0].has_blog);
        assert!(!papers[0].has_full_text);
        assert!(!dir.join("paper.md").exists());
        fs::write(dir.join("blog.md"), "My edited overview").unwrap();
        cache_overview_without_full_text(&dir, Some("Replacement"), "PDF failed").unwrap();
        assert_eq!(
            read_paper_blog_local(&project.root, "2609.12345").unwrap().as_deref(),
            Some("My edited overview")
        );
    }

    #[test]
    fn direct_pdf_urls_do_not_steal_arxiv_or_webpage_queries() {
        for (query, direct_pdf) in [
            ("https://mirros.ai/report/s-space.pdf", true),
            ("https://example.org/report.PDF?download=1#page=2", true),
            ("https://example.org/2609.01147.pdf", true),
            ("https://arxiv.org/pdf/2609.01147.pdf", false),
            ("https://export.arxiv.org/pdf/2609.01147.pdf", false),
            ("https://example.org/page?file=paper.pdf", false),
            ("file:///paper.pdf", false),
            ("A paper.pdf", false),
        ] {
            assert_eq!(is_pdf_url(query), direct_pdf, "{query}");
        }
    }

    /// Revalidation must accept every intact bundle a converter writes — a PDF
    /// text-layer bundle with an empty manifest, an inline SVG figure — or
    /// every reopen would refetch and reconvert. Missing, tampered, escaping
    /// or unknown-converter bundles are rebuilt instead.
    #[test]
    fn revalidates_bundles_and_rejects_missing_tampered_or_escaping_assets() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>"#;
        let svg_manifest = format!(
            r#"{{"schema_version":1,"assets":[{{"path":"paper_assets/figure.svg","sha256":"{}","size":{},"type":"image/svg+xml"}}]}}"#,
            sha256_hex(svg),
            svg.len()
        );
        let tampered = r#"{"schema_version":1,"assets":[{"path":"paper_assets/figure.png","sha256":"00","size":3,"type":"image/png"}]}"#;
        let escaping = r#"{"schema_version":1,"assets":[{"path":"paper_assets/../outside.png","sha256":"00","size":0,"type":"image/png"}]}"#;
        let arxiv2md = commands::ARXIV2MD.requirement;
        for (converter, manifest, asset, valid) in [
            (ANYDOC_CONVERTER, Some(EMPTY_ASSET_MANIFEST), None, true),
            ("anydoc@9.9.9", Some(EMPTY_ASSET_MANIFEST), None, false),
            (arxiv2md, None, None, false),
            (arxiv2md, Some(tampered), Some(("figure.png", "bad")), false),
            (arxiv2md, Some(svg_manifest.as_str()), Some(("figure.svg", svg)), true),
            (arxiv2md, Some(escaping), None, false),
        ] {
            let directory = TempDir::new("papers");
            let markdown =
                "---\ntitle: \"A Paper\"\n---\n\nBody with ![Figure](paper_assets/figure.png)\n";
            directory.write("paper.md", markdown);
            if let Some(manifest) = manifest {
                directory.write("paper_assets/manifest.json", manifest);
            }
            if let Some((name, contents)) = asset {
                directory.write(&format!("paper_assets/{name}"), contents);
            }
            let metadata = PaperMetadata::new(
                "2401.00001",
                "2401.00001",
                "A Paper".into(),
                converter,
                "",
                "",
                markdown,
            );
            assert_eq!(
                validate_paper_bundle(&directory, &metadata).is_ok(),
                valid,
                "{converter} {manifest:?}"
            );
        }
    }

    /// 2605.30170 has no arXiv HTML rendering and ar5iv serves a failed-
    /// conversion stub for it (HTTP 200, empty body), so arxiv2md "succeeds"
    /// with a bodyless document. The fetch must preserve its TeX formulas
    /// through the source route rather than flatten them through the PDF.
    #[test]
    #[ignore = "requires network access"]
    fn falls_back_to_tex_source_for_a_broken_ar5iv_rendering() {
        let project = TestProject::new("");
        let result = fetch_paper(&project.root, "2605.30170", &|_| {}).unwrap();
        assert_eq!(result.arxiv_id, "2605.30170");
        let markdown = fs::read_to_string(project.root.join(&result.paper_path)).unwrap();
        assert!(markdown.contains("source: \"arxiv-source\""));
        assert!(markdown.contains(r"N_H = \sum_{i=1}^{L} f_{\text{probe}}(z_i)."));
        assert!(!markdown.contains("Show PGFPlots source"));
        assert!(markdown_has_body(&markdown));
        // The stub conversion's leftovers are gone: the manifest is honestly
        // empty and revalidation accepts the bundle, so a refetch reuses it.
        assert!(fetch_paper(&project.root, "2605.30170", &|_| {}).unwrap().reused);
    }

    /// arXiv HTML represents some vector figures as `<object data="…svg">`
    /// instead of `<img>`. Figure 6 in 2609.01607 mixes both forms in one row;
    /// both panels must be local verified assets rather than an empty left cell.
    #[test]
    #[ignore = "requires network access"]
    fn imports_external_svg_figure_panels() {
        let project = TestProject::new("");
        let result = fetch_paper(&project.root, "2609.01607", &|_| {}).unwrap();
        let markdown = fs::read_to_string(project.root.join(&result.paper_path)).unwrap();
        let figure = markdown
            .split_once("<PaperFigure id=\"S4.F6\">")
            .and_then(|(_, rest)| rest.split_once("</PaperFigure>"))
            .map(|(figure, _)| figure)
            .expect("Figure 6 should retain its structured panel layout");
        assert_eq!(figure.matches("![").count(), 2, "got: {figure}");
        assert!(figure.contains("paper_assets/"));
        assert!(figure.contains(".svg)"));
        let manifest = project.root.join(".research/papers/2609.01607/paper_assets/manifest.json");
        let manifest = fs::read_to_string(manifest).unwrap();
        assert!(manifest.contains("svg_vqa_accuracy.svg"));
        assert!(manifest.contains("image/svg+xml"));
    }
}
