//! The paper library: everything the primary bibliography cites, joined to
//! whichever bundle holds its text. The bibliography is authoritative: a work
//! without a bundle is still listed, and a bundle nobody cites stays hidden.

use super::bundle::{file_has_body, is_bundle_asset_path, read_asset_manifest, PaperMetadata};
use super::ids::{arxiv_base_id, same_arxiv_work, validate_paper_key};
use super::markdown::markdown_has_body;
use crate::papers::PaperSummary;
use crate::util::err;
use crate::{alphaxiv, project};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// A bundle directory that holds full text and/or an overview.
struct CachedBundle {
    key: String,
    /// The URL a webpage capture snapshotted; empty for arXiv bundles.
    source_url: String,
    has_full_text: bool,
    has_blog: bool,
    asset_paths: Vec<String>,
}

impl CachedBundle {
    /// A webpage citation has no arXiv id; its captured bundle remembers
    /// which URL it snapshotted instead.
    fn captured(&self, cited: &str) -> bool {
        let alphaxiv_work =
            |url: &str| alphaxiv::paper_id_from_url(url).map(|id| arxiv_base_id(&id).to_string());
        !self.source_url.is_empty()
            && (self.source_url == cited.trim()
                || alphaxiv_work(&self.source_url)
                    .is_some_and(|work| Some(work) == alphaxiv_work(cited)))
    }
}

/// Everything the project cites, whether or not its full text was fetched.
/// Only local reads: each row's citation health is whatever the cache already
/// holds, and `refresh_citation_health` asks Crossref for the rest, so the
/// list never waits on the network (a cold check of 24 DOIs took 6 s, and
/// 30 s when Crossref timed out).
pub fn list_papers(root: &Path) -> Result<Vec<PaperSummary>, String> {
    let mut bundles = cached_bundles(root)?;
    let citations = primary_bibliography(root)?;
    let citation_health = crate::citation_health::cached(
        root,
        citations.iter().filter_map(|citation| citation.doi.clone()),
    );
    let mut papers = Vec::new();
    for citation in citations {
        // Cache attachment requires an explicit identity. Titles alone cannot
        // prove that the downloaded text belongs to this citation.
        let by_arxiv = bundles.iter().position(|bundle| {
            citation.arxiv_id.as_deref().is_some_and(|cited| same_arxiv_work(cited, &bundle.key))
        });
        let by_url = bundles
            .iter()
            .position(|bundle| citation.url.as_deref().is_some_and(|cited| bundle.captured(cited)));
        let matched = by_arxiv.or(by_url).map(|index| bundles.remove(index));
        papers.push(PaperSummary {
            // Keep whichever id can actually fetch the text: the bundle's, else
            // whatever the bibliography entry points at.
            arxiv_id: matched
                .as_ref()
                .map(|bundle| bundle.key.clone())
                .or(citation.arxiv_id)
                .unwrap_or_default(),
            citation_health: citation
                .doi
                .as_ref()
                .and_then(|doi| citation_health.get(doi))
                .cloned(),
            doi: citation.doi,
            url: citation.url,
            title: super::title_or_key(citation.title, &citation.key),
            authors: citation.bibtex_authors,
            year: Some(citation.year).filter(|year| !year.is_empty()),
            citation_key: Some(citation.key),
            has_full_text: matched.as_ref().is_some_and(|bundle| bundle.has_full_text),
            has_blog: matched.as_ref().is_some_and(|bundle| bundle.has_blog),
            asset_paths: matched.map(|bundle| bundle.asset_paths).unwrap_or_default(),
        });
    }
    papers.sort_by_key(|paper| paper.title.to_lowercase());
    Ok(papers)
}

/// Recheck the citation health of every DOI the bibliography cites (within
/// the per-scan cap), for the rows `list_papers` returned with cached health.
pub fn refresh_citation_health(
    root: &Path,
) -> Result<BTreeMap<String, crate::citation_health::CitationHealth>, String> {
    let citations = primary_bibliography(root)?;
    Ok(crate::citation_health::lookup(
        root,
        citations.into_iter().filter_map(|citation| citation.doi),
    ))
}

/// The primary bibliography's entries. A file that is not there yet (a new
/// project, or an Overleaf clone still arriving) is an empty library; one that
/// cannot be read is an error, so the library can say so instead of looking
/// empty.
fn primary_bibliography(root: &Path) -> Result<Vec<crate::models::CitationInfo>, String> {
    let manifest = project::read_manifest(root)?;
    let path = project::safe_path(root, &manifest.primary_bibliography)?;
    let bibliography = match fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(format!("Could not read {}: {error}", manifest.primary_bibliography))
        }
    };
    Ok(project::parse_bibliography(&bibliography))
}

fn cached_bundles(root: &Path) -> Result<Vec<CachedBundle>, String> {
    let directory = root.join(".research/papers");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut bundles = Vec::new();
    for bundle_dir in paper_cache_directories(&directory)? {
        let key = bundle_dir
            .strip_prefix(&directory)
            .map_err(err)?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let has_full_text = file_has_body(&bundle_dir.join("paper.md"));
        let has_blog = file_has_body(&bundle_dir.join("blog.md"));
        if !has_full_text && !has_blog {
            continue;
        }
        // Legacy or externally supplied text may have no metadata. Keep it
        // readable, but it has no captured URL to join on.
        let source_url = PaperMetadata::read(&bundle_dir)
            .map(|metadata| metadata.source_url)
            .unwrap_or_default();
        let asset_paths = paper_asset_paths(&bundle_dir, &key);
        bundles.push(CachedBundle { key, source_url, has_full_text, has_blog, asset_paths });
    }
    Ok(bundles)
}

fn paper_asset_paths(directory: &Path, key: &str) -> Vec<String> {
    let Ok(manifest) = read_asset_manifest(directory) else {
        return Vec::new();
    };
    let prefix = format!(".research/papers/{key}/");
    let assets = manifest
        .assets
        .into_iter()
        .filter(|asset| is_bundle_asset_path(Path::new(&asset.path)))
        .map(|asset| format!("{prefix}{}", asset.path));
    [format!("{prefix}paper_assets/manifest.json")].into_iter().chain(assets).collect()
}

fn paper_cache_directories(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let holds_text =
        |path: &Path| path.join("paper.md").is_file() || path.join("blog.md").is_file();
    let mut found = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        if !entry.file_type().map_err(err)?.is_dir() {
            continue;
        }
        let path = entry.path();
        if holds_text(&path) {
            found.push(path);
            continue;
        }
        // Legacy arXiv ids contain one slash (`archive/YYMMNNN`). Inspect
        // exactly that second level and never follow symlinks.
        for child in fs::read_dir(&path).map_err(err)? {
            let child = child.map_err(err)?;
            if child.file_type().map_err(err)?.is_dir() && holds_text(&child.path()) {
                found.push(child.path());
            }
        }
    }
    Ok(found)
}

/// One library entry as the agent sees it: what the work is, how to cite it,
/// and which cached files hold its text. Paths are workspace-relative so the
/// agent can read them directly with its own file tools.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPaper {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_key: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub arxiv_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_health: Option<crate::citation_health::CitationHealth>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_text_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overview_path: Option<String>,
}

/// The paper library for the agent's `list_papers` tool: the same cited works
/// the Papers panel and the composer's @-picker show, with readable cache
/// paths attached. An entry without paths is cited but not downloaded — the
/// agent can fetch_paper it by arXiv id.
pub fn list_library(root: &Path) -> Result<Vec<LibraryPaper>, String> {
    // The agent asked for this list and reads its health once, so it waits
    // for the recheck the Papers panel runs in the background.
    let mut health = refresh_citation_health(root)?;
    Ok(library_entries(root)?
        .into_iter()
        .map(|entry| LibraryPaper {
            citation_health: entry
                .doi
                .as_ref()
                .and_then(|doi| health.remove(doi))
                .or(entry.citation_health),
            ..entry
        })
        .collect())
}

/// The library with paths attached and only cached citation health.
pub(super) fn library_entries(root: &Path) -> Result<Vec<LibraryPaper>, String> {
    Ok(list_papers(root)?
        .into_iter()
        .map(|paper| {
            let cached = |present: bool, file: &str| {
                (present && !paper.arxiv_id.is_empty())
                    .then(|| format!(".research/papers/{}/{file}", paper.arxiv_id))
            };
            LibraryPaper {
                full_text_path: cached(paper.has_full_text, "paper.md"),
                overview_path: cached(paper.has_blog, "blog.md"),
                title: paper.title,
                citation_key: paper.citation_key,
                arxiv_id: paper.arxiv_id,
                doi: paper.doi,
                url: paper.url,
                citation_health: paper.citation_health,
            }
        })
        .collect())
}

pub fn read_paper(root: &Path, arxiv_id: &str) -> Result<String, String> {
    validate_paper_key(arxiv_id)?;
    let markdown = project::read_file(root, &format!(".research/papers/{arxiv_id}/paper.md"))?;
    if !markdown_has_body(&markdown) {
        return Err("Cached paper has no full-text body.".to_string());
    }
    Ok(markdown)
}

/// Read an overview only when it is already cached. It never performs
/// network I/O, so passive UI affordances can call it freely.
pub fn read_paper_blog_local(root: &Path, arxiv_id: &str) -> Result<Option<String>, String> {
    validate_paper_key(arxiv_id)?;
    let path = project::safe_path(root, &format!(".research/papers/{arxiv_id}/blog.md"))?;
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::bundle::{web_reference_id, FIRECRAWL_CONVERTER};
    use crate::papers::test_support::TestProject;

    const ATTENTION_BIB: &str = "@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  eprint = {1706.03762}\n}\n";
    const ATTENTION_PAPER: &str = ".research/papers/1706.03762/paper.md";
    /// Metadata from before bundles recorded their schema: it no longer parses
    /// as a bundle's metadata and must not keep the text from being listed.
    const LEGACY_METADATA: &str = r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":"vaswani2017attention"}"#;

    fn find<'a>(papers: &'a [PaperSummary], key: &str) -> &'a PaperSummary {
        papers.iter().find(|paper| paper.citation_key.as_deref() == Some(key)).expect(key)
    }

    /// The bibliography decides what is listed; a bundle attaches to the entry
    /// only through an explicit identity. Rows are the bibliography, the
    /// project files, and the expected (key, arxiv id, full text, overview) of
    /// every listed paper.
    #[test]
    fn lists_what_the_bibliography_cites_joined_to_cached_text() {
        /// A listed paper: citation key, arXiv id or bundle key, full text, overview.
        type Listed = (&'static str, &'static str, bool, bool);
        type Case = (&'static str, &'static [(&'static str, &'static str)], &'static [Listed]);
        const FRONTMATTER_ONLY: &str = "---\ntitle: Empty\nsections: 0\n---\n\n";
        let cases: [Case; 9] = [
            // Frontmatter alone is not a full text.
            (
                "@article{empty, title={Empty}, eprint={2501.00001}}\n\
                 @article{full, title={Full}, eprint={2501.00002}}\n",
                &[
                    (".research/papers/2501.00001/paper.md", FRONTMATTER_ONLY),
                    (".research/papers/2501.00002/paper.md", "---\ntitle: Full\n---\n\n# Introduction\nText.\n"),
                ],
                &[("empty", "2501.00001", false, false), ("full", "2501.00002", true, false)],
            ),
            // An overview is reported independently of the full text.
            (
                "@article{overview, title={Overview only}, eprint={2501.00003}}\n",
                &[
                    (".research/papers/2501.00003/paper.md", FRONTMATTER_ONLY),
                    (".research/papers/2501.00003/blog.md", "# A useful overview\nDetails.\n"),
                ],
                &[("overview", "2501.00003", false, true)],
            ),
            // A bundle joins its citation despite a version suffix the citation
            // omits, or metadata that predates citation keys.
            (
                "@inproceedings{lei2025scalability,\n  title = {The Scalability of Simplicity},\n  eprint = {2504.10462}\n}\n",
                &[
                    (".research/papers/2504.10462v2/paper.md", "Title: A cached paper\n"),
                    (".research/papers/2504.10462v2/metadata.json", r#"{"arxivId":"2504.10462v2","title":"The Scalability of Simplicity"}"#),
                ],
                &[("lei2025scalability", "2504.10462v2", true, false)],
            ),
            (
                ATTENTION_BIB,
                &[(ATTENTION_PAPER, "Title: A cached paper\n"), (".research/papers/1706.03762/metadata.json", LEGACY_METADATA)],
                &[("vaswani2017attention", "1706.03762", true, false)],
            ),
            // Only the manifest's primary bibliography counts.
            (
                "@book{primary, title={Primary source}}\n",
                &[("supplement.bib", "@book{secondary, title={Completion only}}\n")],
                &[("primary", "", false, false)],
            ),
            // Legacy arXiv ids nest their bundle one directory deeper.
            (
                "@article{legacy, title={A legacy paper}, eprint={math.GT/0211159}}\n",
                &[(".research/papers/math.GT/0211159/paper.md", "Title: A legacy paper\n")],
                &[("legacy", "math.GT/0211159", true, false)],
            ),
            // The arXiv id is found wherever the entry records it: a conference
            // entry that also cites the preprint, or a BLIP3-o style journal.
            (
                "@inproceedings{lei2025scalability,\n  author        = {Weixian Lei and Jiacong Wang},\n  title         = {The Scalability of Simplicity},\n  booktitle     = {IEEE/CVF International Conference on Computer Vision (ICCV)},\n  year          = {2025},\n  url           = {https://arxiv.org/abs/2504.10462},\n  archiveprefix = {arXiv},\n  eprint        = {2504.10462},\n  primaryclass  = {cs.CV},\n}\n",
                &[],
                &[("lei2025scalability", "2504.10462", false, false)],
            ),
            (
                "@article{blip3o, title={BLIP3o}, journal={arXiv preprint arXiv:2505.09568}}\n",
                &[],
                &[("blip3o", "2505.09568", false, false)],
            ),
            // Papers is the project's literature, not everything the agent
            // read into `.research/papers/`: uncited caches stay hidden, with
            // or without metadata, until citing one brings its text in (as
            // the cases above do).
            (
                "",
                &[
                    (".research/papers/2401.00001/paper.md", "Title: Something I skimmed\n"),
                    (ATTENTION_PAPER, "Title: Attention Is All You Need\n"),
                    (".research/papers/1706.03762/metadata.json", LEGACY_METADATA),
                ],
                &[],
            ),
        ];
        for (bibliography, files, expected) in cases {
            let project = TestProject::new(bibliography);
            for (path, contents) in files {
                project.write(path, contents);
            }
            let papers = list_papers(&project.root).unwrap();
            assert_eq!(papers.len(), expected.len(), "{bibliography}: {papers:?}");
            for &(key, arxiv_id, full_text, blog) in expected {
                let paper = find(&papers, key);
                assert_eq!(
                    (paper.arxiv_id.as_str(), paper.has_full_text, paper.has_blog),
                    (arxiv_id, full_text, blog),
                    "{key}"
                );
                if !arxiv_id.is_empty() {
                    assert_eq!(read_paper(&project.root, arxiv_id).is_ok(), full_text, "{key}");
                }
            }
        }
    }

    /// Webpage captures key their bundle by URL digest; the readers accept
    /// that key, and the bibliography join finds the bundle through the URL
    /// its metadata remembers — so an arXiv bundle that merely shares a title
    /// cannot replace an identified OpenReview capture.
    #[test]
    fn webpage_captures_join_the_bibliography_by_url_not_title() {
        let title = "A Single Transformer for Scalable Vision-Language Modeling";
        let (openreview, blog) =
            ("https://openreview.net/forum?id=nuzFG0Rbhy", "https://example.com/a-blog-post");
        let (openreview_id, blog_id) = (web_reference_id(openreview), web_reference_id(blog));
        assert!(validate_paper_key(&blog_id).is_ok(), "got: {blog_id}");
        assert!(validate_paper_key("web-not-a-digest").is_err());

        let project = TestProject::new(&format!(
            "@article{{chen2024single,\n  title = {{{title}}},\n  url = {{{openreview}}}\n}}\n\
             @misc{{blog2024,\n  title = {{A Blog Post}},\n  url = {{{blog}}},\n  year = {{2024}}\n}}\n"
        ));
        let web_markdown = format!("# {title}\n\nOpenReview page.");
        let web = PaperMetadata::new(
            &openreview_id,
            "",
            title.into(),
            FIRECRAWL_CONVERTER,
            "web",
            openreview,
            &web_markdown,
        );
        project.write_bundle(&web_markdown, &web);
        let arxiv_markdown = format!("# SOLO: {title}\n\nThe arXiv full text.");
        let arxiv2md = crate::commands::ARXIV2MD.requirement;
        let arxiv = PaperMetadata::new(
            "2407.06438",
            "2407.06438v3",
            title.into(),
            arxiv2md,
            "arxiv-html",
            "",
            &arxiv_markdown,
        );
        project.write_bundle(&arxiv_markdown, &arxiv);
        let markdown =
            "---\ntitle: \"A Blog Post\"\nsource: \"web\"\n---\n\nThe captured content.\n";
        let blog_title = "A Blog Post".to_string();
        let capture = PaperMetadata::new(
            &blog_id,
            &blog_id,
            blog_title,
            FIRECRAWL_CONVERTER,
            "web",
            blog,
            markdown,
        );
        project.write_bundle(markdown, &capture);

        let papers = list_papers(&project.root).unwrap();
        assert_eq!(papers.len(), 2, "got: {papers:?}");
        let chen = find(&papers, "chen2024single");
        assert_eq!((chen.arxiv_id.as_str(), chen.has_full_text), (openreview_id.as_str(), true));
        let entry = find(&papers, "blog2024");
        assert_eq!(entry.arxiv_id, blog_id, "joined to its capture: {entry:?}");
        assert_eq!((entry.has_full_text, entry.has_blog), (true, false));
        assert_eq!(entry.url.as_deref(), Some(blog));
        assert!(read_paper(&project.root, &blog_id).unwrap().contains("captured content"));
        // The reused-capture check accepts the bundle without refetching.
        let reused = crate::papers::fetch_web_reference(
            &project.root,
            blog,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        assert!(reused.reused);
        assert_eq!(reused.arxiv_id, blog_id);
    }

    #[cfg(unix)]
    #[test]
    fn cache_discovery_does_not_follow_symlink_loops() {
        let project = TestProject::new("");
        let papers = project.root.join(".research/papers");
        fs::create_dir_all(papers.join("archive")).unwrap();
        std::os::unix::fs::symlink(&papers, papers.join("archive/loop")).unwrap();
        assert!(cached_bundles(&project.root).unwrap().is_empty());
    }

    /// Both listings show every cited work, fetched or not. The agent's
    /// attaches paths it can read directly and marks cited-but-undownloaded
    /// works by their absence; title, authors, year, arXiv id, normalized DOI and
    /// cached health come off the bibliography and its caches.
    #[test]
    fn lists_cited_works_for_the_app_and_agent_even_when_never_fetched() {
        let project = TestProject::new(&format!(
            "{ATTENTION_BIB}@article{{kingma2015adam,\n  title = {{Adam: A Method for Stochastic Optimization}},\n  author = {{Diederik P. Kingma and Jimmy Ba}},\n  year = {{2015}},\n  eprint = {{1412.6980}},\n  doi = {{https://doi.org/10.1234/EXAMPLE}}\n}}\n"
        ));
        project.write(ATTENTION_PAPER, "Title: Attention Is All You Need\n");
        project.write(".research/papers/1706.03762/metadata.json", LEGACY_METADATA);
        project.write(".research/papers/1706.03762/blog.md", "An overview with a body.\n");
        project.write(
            ".research/cache/citation-health-v1.json",
            r#"{
              "schema": 1,
              "entries": {
                "10.1234/example": {
                  "checked_at_epoch": 9999999999,
                  "health": {
                    "kind": "expressionOfConcern",
                    "updateType": "expression_of_concern",
                    "source": "publisher",
                    "date": "2024-04-01",
                    "link": "https://doi.org/10.5555/notice",
                    "checkedAt": "2026-08-13T12:00:00Z"
                  }
                }
              }
            }"#,
        );

        let papers = list_papers(&project.root).unwrap();
        assert_eq!(papers.len(), 2, "got: {papers:?}");
        let attention = find(&papers, "vaswani2017attention");
        let listed = (attention.arxiv_id.as_str(), attention.has_full_text, attention.has_blog);
        assert_eq!(listed, ("1706.03762", true, true));
        let adam = find(&papers, "kingma2015adam");
        assert_eq!((adam.has_full_text, adam.has_blog), (false, false));
        assert_eq!(adam.title, "Adam: A Method for Stochastic Optimization");
        assert_eq!(adam.authors, "Diederik P. Kingma and Jimmy Ba");
        assert_eq!(adam.year.as_deref(), Some("2015"));
        assert_eq!(find(&papers, "vaswani2017attention").year, None);
        // Its arXiv id came off the bibliography, so the text can be fetched later.
        assert_eq!(adam.arxiv_id, "1412.6980");
        assert_eq!(adam.doi.as_deref(), Some("10.1234/example"));
        let kind = adam.citation_health.as_ref().map(|health| health.kind.as_str());
        assert_eq!(kind, Some("expressionOfConcern"));

        let library = list_library(&project.root).unwrap();
        assert_eq!(library.len(), 2, "got: {library:?}");
        let cached = library.iter().find(|paper| paper.arxiv_id == "1706.03762").unwrap();
        assert_eq!(cached.citation_key.as_deref(), Some("vaswani2017attention"));
        assert_eq!(cached.full_text_path.as_deref(), Some(ATTENTION_PAPER));
        assert_eq!(cached.overview_path.as_deref(), Some(".research/papers/1706.03762/blog.md"));
        let uncached = library.iter().find(|paper| paper.arxiv_id == "1412.6980").unwrap();
        let paths = (uncached.full_text_path.as_deref(), uncached.overview_path.as_deref());
        assert_eq!(paths, (None, None), "got: {uncached:?}");
        assert_eq!(uncached.doi.as_deref(), Some("10.1234/example"));
        let link = uncached.citation_health.as_ref().and_then(|health| health.link.as_deref());
        assert_eq!(link, Some("https://doi.org/10.5555/notice"));
    }

    /// The reader names a paper by its authors' surnames, and only the braces
    /// say a name is one organisation: without them "{Google Brain}" reads as
    /// a person called Brain. The frontend's `paper-identity.test.ts` formats
    /// these exact listed values.
    #[test]
    fn lists_authors_with_the_braces_that_group_a_corporate_name() {
        let project = TestProject::new(
            "@misc{gemini, title={Gemini}, author={{Gemini Team} and others}}\n\
             @misc{brain, title={Brain}, author = \"{Google  Brain}\"}\n\
             @misc{institute, title={Institute}, author={{Research and Development Institute} and Doe, Jane}}\n\
             @misc{att, title={AT}, author={{AT\\&T} and Borel, Émile}}\n",
        );
        let papers = list_papers(&project.root).unwrap();
        let listed =
            ["gemini", "brain", "institute", "att"].map(|key| find(&papers, key).authors.as_str());
        assert_eq!(
            listed,
            [
                "{Gemini Team} and others",
                "{Google Brain}",
                "{Research and Development Institute} and Doe, Jane",
                "{AT&T} and Borel, Émile",
            ]
        );
        // Everywhere else a citation is shown as text, the braces are gone.
        let citations = project::parse_bibliography(&project.bibliography());
        assert_eq!(citations[1].authors, "Google Brain");
    }
}
