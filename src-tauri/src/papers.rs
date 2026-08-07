use crate::commands;
use crate::models::{ImportResult, PaperSummary, ProjectSearchResult};
use crate::project;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Output;
use uuid::Uuid;

// Schema 4 also normalizes converter block boundaries before hashing and
// publishing the bundle, so schema-3 papers are rebuilt instead of waiting for
// the editor to rewrite them after first open.
// Schema 5 folds ar5iv's "•" item glyphs into their bullets, rejoins
// hard-wrapped paragraphs, and links the Contents section to its headings;
// re-fetching a schema-4 paper re-converts it with those fixes.
const PAPER_SCHEMA_VERSION: u32 = 5;
const ASSET_MANIFEST_SCHEMA_VERSION: u32 = 1;
const ARXIV2MD_REQUIREMENT: &str =
    "arxiv2markdown @ git+https://github.com/leo1oel/arxiv2md.git@f7ac16ffd83ae063926f4e05aa5a2b2c4deafd45";
/// The converter recorded on bundles built from the PDF text layer. Like the
/// requirement above, this string is part of cache identity: bump it together
/// with the `anydoc` dependency so bundles built by the old version rebuild.
const ANYDOC_CONVERTER: &str = "anydoc@0.1.7";
/// The converter recorded on webpage captures (see firecrawl.rs). Versioned
/// by API generation, not by crate: the scrape output changes when the
/// service's endpoint does.
const FIRECRAWL_CONVERTER: &str = "firecrawl-v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaperMetadata {
    arxiv_id: String,
    requested_arxiv_id: String,
    #[serde(default)]
    title: String,
    schema_version: u32,
    complete: bool,
    #[serde(default)]
    converter: String,
    /// What the markdown was derived from: `arxiv-html` for a LaTeXML
    /// rendering, `arxiv-pdf` for the text-layer fallback, `web` for a
    /// scraped page. Empty on bundles from before the field existed, which
    /// are all HTML-derived.
    #[serde(default)]
    source: String,
    /// The page a `web` bundle captured. This is the join key back to the
    /// bibliography: a webpage citation has no arXiv id, so `list_papers`
    /// matches its `url` field against this.
    #[serde(default)]
    source_url: String,
    #[serde(default)]
    paper_sha256: String,
    #[serde(default)]
    asset_manifest_schema_version: u32,
}

type ImportedPaper = (String, PaperMetadata, bool, bool, Vec<String>);

/// The HTML conversion carries rendering artifacts the reader would show
/// verbatim: ar5iv's itemize glyph as list content ("- •"), prose
/// hard-wrapped at the source's line width, and a plain-text Contents
/// section. Fix the bytes once at import so every consumer — reader, agent,
/// full-text search — sees clean markdown.
fn normalize_imported_markdown(markdown: &str) -> String {
    let collapsed = collapse_item_bullet_glyphs(markdown);
    let unwrapped = unwrap_hard_wrapped_paragraphs(&collapsed);
    let separated = separate_adjacent_blocks(&unwrapped);
    link_contents_entries(&separated)
}

/// ar5iv marks every itemize entry with a literal "•" glyph, which the
/// conversion emits as the item's entire first line. Fold the real content up
/// into the marker so the reader shows one bullet instead of a bullet, a
/// glyph, and a line break.
fn collapse_item_bullet_glyphs(markdown: &str) -> String {
    let lines = markdown.split('\n').collect::<Vec<_>>();
    let mut out = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if line.trim() == "- •" {
            if let Some(next) = lines.get(index + 1).filter(|next| !next.trim().is_empty()) {
                let indent = &line[..line.len() - line.trim_start().len()];
                out.push(format!("{indent}- {}", next.trim_start()));
                index += 2;
                continue;
            }
        }
        out.push(line.to_string());
        index += 1;
    }
    out.join("\n")
}

/// Anything that must not be glued onto the previous prose line.
fn is_block_start(line: &str) -> bool {
    let trimmed = line.trim_start();
    if trimmed.is_empty() {
        return true;
    }
    let ordered_item = {
        let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
        digits > 0
            && trimmed[digits..].starts_with(['.', ')'])
            && trimmed[digits + 1..]
                .chars()
                .next()
                .is_none_or(|c| c == ' ')
    };
    trimmed.starts_with('#')
        || trimmed.starts_with("- ")
        || trimmed == "-"
        || trimmed.starts_with("* ")
        || trimmed.starts_with("+ ")
        || trimmed.starts_with('>')
        || trimmed.starts_with('|')
        || trimmed.starts_with('<')
        || trimmed.starts_with("![")
        || trimmed.starts_with("$$")
        || trimmed.starts_with("```")
        || trimmed.starts_with("~~~")
        || trimmed.starts_with("---")
        || trimmed.starts_with("===")
        || trimmed.starts_with("___")
        || trimmed.starts_with("[^")
        || ordered_item
}

/// The converter hard-wraps paragraphs at the HTML source's line width, and
/// the visual editor faithfully renders those single newlines — so one
/// paragraph read as a stack of one-line fragments. Rejoin consecutive plain
/// prose lines. Structural lines (headings, lists, tables, quotes, HTML
/// anchors, math, fences), indented continuations, explicit hard breaks, and
/// the YAML frontmatter all pass through untouched.
fn unwrap_hard_wrapped_paragraphs(markdown: &str) -> String {
    let lines = markdown.split('\n').collect::<Vec<_>>();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut index = 0;
    if lines.first() == Some(&"---") {
        out.push("---".to_string());
        index = 1;
        while index < lines.len() {
            let line = lines[index];
            out.push(line.to_string());
            index += 1;
            if line == "---" {
                break;
            }
        }
    }
    let mut in_code = false;
    let mut in_math = false;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            out.push(line.to_string());
            continue;
        }
        if !in_code && trimmed == "$$" {
            in_math = !in_math;
            out.push(line.to_string());
            continue;
        }
        let continues_previous = !in_code
            && !in_math
            && !line.starts_with(char::is_whitespace)
            && !is_block_start(line)
            && out.last().is_some_and(|previous| {
                !previous.starts_with(char::is_whitespace)
                    && !is_block_start(previous)
                    && !previous.ends_with("  ")
                    && !previous.ends_with('\\')
            });
        if continues_previous {
            let previous = out.last_mut().expect("checked by continues_previous");
            previous.push(' ');
            previous.push_str(line.trim_end());
        } else {
            out.push(line.to_string());
        }
    }
    out.join("\n")
}

fn separate_adjacent_blocks(markdown: &str) -> String {
    let lines = markdown.split('\n').collect::<Vec<_>>();
    let mut normalized = Vec::with_capacity(lines.len() + 16);
    let mut in_display_math = false;
    for (index, line) in lines.iter().enumerate() {
        normalized.push((*line).to_string());
        if *line == "$$" {
            in_display_math = !in_display_math;
        }

        let Some(next) = lines.get(index + 1) else {
            continue;
        };
        let heading_before_list = line.starts_with('#') && next.starts_with("- ");
        let prose_before_display_math = !in_display_math && !line.is_empty() && *next == "$$";
        if heading_before_list || prose_before_display_math {
            normalized.push(String::new());
        }
    }
    normalized.join("\n")
}

/// Rust twin of the vendored `toWikiLinkSlug` (open-knowledge-core
/// utils/slug.ts): NFKD, strip combining marks, lowercase, collapse
/// non-alphanumeric runs into single hyphens, trim edge hyphens. The two must
/// stay in lockstep or Contents links stop landing on their headings.
fn wiki_link_slug(text: &str) -> String {
    use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
    let mut slug = String::new();
    let mut pending_hyphen = false;
    for ch in text.trim().nfkd() {
        if is_combining_mark(ch) {
            continue;
        }
        if ch.is_alphanumeric() {
            if pending_hyphen && !slug.is_empty() {
                slug.push('-');
            }
            pending_hyphen = false;
            slug.extend(ch.to_lowercase());
        } else {
            pending_hyphen = true;
        }
    }
    slug
}

/// The converter's "## Contents" section lists section names as plain text.
/// Rewrite every entry that names a real heading into an in-document link,
/// using the same slug (and duplicate suffixing, in document order) the
/// editor's HeadingAnchors decoration assigns — clicking an entry then
/// scrolls the reader to that section. Entries with no matching heading stay
/// plain text.
fn link_contents_entries(markdown: &str) -> String {
    let lines = markdown.split('\n').collect::<Vec<_>>();
    let mut slug_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut headings: Vec<(String, String)> = Vec::new();
    let mut in_code = false;
    for line in &lines {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        let level = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&level) && trimmed[level..].starts_with(' ') {
            let text = trimmed[level + 1..].trim().to_string();
            let base = wiki_link_slug(&text);
            if base.is_empty() {
                continue;
            }
            let count = slug_counts.entry(base.clone()).or_insert(0);
            let slug = if *count == 0 {
                base.clone()
            } else {
                format!("{base}-{count}")
            };
            *count += 1;
            headings.push((text, slug));
        }
    }
    let Some(contents_at) = lines.iter().position(|line| *line == "## Contents") else {
        return markdown.to_string();
    };
    let mut consumed = vec![false; headings.len()];
    let mut out: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
    for (offset, line) in lines[contents_at + 1..].iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        let Some(text) = trimmed.strip_prefix("- ") else {
            break;
        };
        let text = text.trim();
        // Consume matches in order: the table of contents mirrors document
        // order, so duplicate section names resolve to distinct headings.
        let matched = headings
            .iter()
            .enumerate()
            .find(|(i, (heading, _))| !consumed[*i] && heading == text);
        if let Some((i, (_, slug))) = matched {
            consumed[i] = true;
            let indent = &line[..line.len() - trimmed.len()];
            out[contents_at + 1 + offset] = format!("{indent}- [{text}](#{slug})");
        }
    }
    out.join("\n")
}

#[derive(Debug, Deserialize)]
struct AssetManifest {
    schema_version: u32,
    assets: Vec<AssetManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct AssetManifestEntry {
    path: String,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeResult {
    pub dry_run: bool,
    pub changed: bool,
    pub report: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub key: String,
    pub removed: bool,
    pub blockers: Vec<crate::models::SymbolOccurrence>,
}

#[derive(Clone, Copy)]
pub enum HistoryMode {
    Record,
    Defer,
}

/// Add a work to the project's bibliography, with its full text when we can
/// get it.
///
/// The box this comes from only took arXiv ids, so a DOI, a title, or a web
/// page had to be added through the bibliography editor instead — a second
/// place to do the same thing, which nobody would guess at. `bibcite` resolves
/// all of them, so the input goes to it either way; the arXiv branch exists
/// only because that is the case where a full text can also be fetched.
///
/// A work with no full text is not a lesser citation: it appears in Papers and
/// in the `.bib` exactly like the rest, just without anything to open.
/// `progress` receives a stage id ("resolving", "fulltext", "overview")
/// whenever the pipeline enters a network-bound step, so the UI can say what
/// the spinner is waiting on. The agent CLI path and tests pass the no-op.
pub fn import_reference_with_progress(
    root: &Path,
    input: &str,
    progress: &dyn Fn(&str),
) -> Result<ImportResult, String> {
    let manifest = project::read_manifest(root)?;
    import_citation(root, &manifest, input, HistoryMode::Record, progress)
}

pub(crate) fn import_reference_with_history(
    root: &Path,
    input: &str,
    history: HistoryMode,
) -> Result<ImportResult, String> {
    let manifest = project::read_manifest(root)?;
    import_citation(root, &manifest, input, history, &|_| {})
}

/// Cache a complete, unfiltered arxiv2md conversion without touching the bibliography.
pub fn fetch_paper(root: &Path, requested: &str) -> Result<FetchResult, String> {
    fetch_paper_with_progress(root, requested, &|_| {})
}

/// See `import_reference_with_progress` for the stage contract.
pub fn fetch_paper_with_progress(
    root: &Path,
    requested: &str,
    progress: &dyn Fn(&str),
) -> Result<FetchResult, String> {
    let requested =
        parse_arxiv_id(requested).ok_or_else(|| "Enter a valid arXiv id or URL.".to_string())?;
    validate_arxiv_id(&requested)?;
    let base = arxiv_base_id(&requested).to_string();
    // creation_path rather than safe_path: a legacy id (`cs/9901002`) nests
    // its bundle one level deeper, and safe_path refuses to look through an
    // intermediate directory that does not exist yet. Legacy-era papers are
    // exactly the ones with no HTML rendering, so before the PDF fallback no
    // fetch had ever needed that directory.
    let dir = project::creation_path(root, &format!(".research/papers/{base}"))?;
    let metadata_path = dir.join("metadata.json");
    let cached_metadata = fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<PaperMetadata>(&raw).ok());
    let valid = cached_metadata.as_ref().is_some_and(|m| {
        m.schema_version == PAPER_SCHEMA_VERSION
            && m.complete
            && m.arxiv_id.eq_ignore_ascii_case(&base)
            && cached_paper_has_body(&dir.join("paper.md"))
            && (requested == base || m.requested_arxiv_id.eq_ignore_ascii_case(&requested))
            && validate_paper_bundle(&dir, m).is_ok()
    });
    if valid {
        return Ok(FetchResult {
            arxiv_id: base.clone(),
            paper_path: format!(".research/papers/{base}/paper.md"),
            blog_path: dir
                .join("blog.md")
                .is_file()
                .then(|| format!(".research/papers/{base}/blog.md")),
            reused: true,
        });
    }
    progress("fulltext");
    let papers_root = project::safe_path(root, ".research/papers")?;
    fs::create_dir_all(&papers_root).map_err(err)?;
    let temp_root = papers_root.join(format!(".fetch-{}", Uuid::new_v4()));
    let output_dir = temp_root.join("output");
    fs::create_dir_all(&output_dir).map_err(err)?;
    let output_path = output_dir.join("paper.md");
    // Everything up to the atomic swap happens under temp_root. Build inside a
    // closure so a failure on any path cannot strand a `.fetch-*` directory in
    // the project; conversion errors were doing exactly that.
    let build = || -> Result<(), String> {
        // The overview is independent of the conversion and an order of
        // magnitude cheaper; fetching it concurrently hides its latency
        // entirely behind arxiv2md's download-and-convert work.
        let overview = std::thread::spawn({
            let base = base.clone();
            move || crate::alphaxiv::fetch_overview(&base)
        });
        let (converted, converter) = convert_paper(&requested, &base, &output_dir, &output_path)?;
        let markdown = normalize_imported_markdown(&converted);
        fs::write(&output_path, &markdown).map_err(err)?;
        let title = parse_title(&markdown).unwrap_or_else(|| format!("arXiv {base}"));
        let metadata = PaperMetadata {
            arxiv_id: base.clone(),
            requested_arxiv_id: requested.clone(),
            title,
            schema_version: PAPER_SCHEMA_VERSION,
            complete: true,
            converter: converter.to_string(),
            source: if converter == ANYDOC_CONVERTER {
                "arxiv-pdf"
            } else {
                "arxiv-html"
            }
            .to_string(),
            source_url: String::new(),
            paper_sha256: sha256_hex(markdown.as_bytes()),
            asset_manifest_schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
        };
        validate_paper_bundle(&output_dir, &metadata)?;
        fs::write(
            output_dir.join("metadata.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&metadata).map_err(err)?
            ),
        )
        .map_err(err)?;
        progress("overview");
        if let Ok(Ok(Some(blog))) = overview.join() {
            fs::write(output_dir.join("blog.md"), blog).map_err(err)?;
        } else if dir.join("blog.md").is_file() {
            fs::copy(dir.join("blog.md"), output_dir.join("blog.md")).map_err(err)?;
        }
        if dir.join("paper.md").is_file()
            && cached_metadata.as_ref().is_none_or(|metadata| {
                metadata.paper_sha256.is_empty()
                    || fs::read(dir.join("paper.md"))
                        .ok()
                        .is_none_or(|bytes| sha256_hex(&bytes) != metadata.paper_sha256)
            })
        {
            fs::copy(dir.join("paper.md"), output_dir.join("paper.legacy.md")).map_err(err)?;
        }
        fs::create_dir_all(dir.parent().unwrap()).map_err(err)?;
        let backup = dir.with_extension(format!("old-{}", Uuid::new_v4()));
        if dir.exists() {
            fs::rename(&dir, &backup).map_err(err)?;
        }
        if let Err(e) = fs::rename(&output_dir, &dir) {
            if backup.exists() {
                let _ = fs::rename(&backup, &dir);
            }
            return Err(err(e));
        }
        let _ = fs::remove_dir_all(backup);
        Ok(())
    };
    let built = build();
    let _ = fs::remove_dir_all(&temp_root);
    built?;
    Ok(FetchResult {
        arxiv_id: base.clone(),
        paper_path: format!(".research/papers/{base}/paper.md"),
        blog_path: dir
            .join("blog.md")
            .is_file()
            .then(|| format!(".research/papers/{base}/blog.md")),
        reused: false,
    })
}

/// The bundle directory name for a captured webpage: a stable digest of the
/// URL, in a shape `validate_paper_key` can recognize. Everything downstream
/// (tabs, read_paper, collab paths) already keys bundles by this string, so a
/// webpage rides the same rails as an arXiv id.
pub(crate) fn web_reference_id(url: &str) -> String {
    format!("web-{}", &sha256_hex(url.trim().as_bytes())[..16])
}

fn is_web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Capture a webpage as a readable bundle under `.research/papers/web-…`.
///
/// The same contract as an arXiv fetch — atomic swap, sha-validated bundle,
/// honest frontmatter — with one difference: there is never a blog, so the
/// reader shows a single content view.
pub fn fetch_web_reference(root: &Path, url: &str) -> Result<FetchResult, String> {
    let url = url.trim();
    if !is_web_url(url) {
        return Err("Enter an http(s) URL.".to_string());
    }
    let id = web_reference_id(url);
    let dir = project::creation_path(root, &format!(".research/papers/{id}"))?;
    let cached_metadata = fs::read_to_string(dir.join("metadata.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<PaperMetadata>(&raw).ok());
    // A page can change under its URL, but a citation wants the text that was
    // cited: reuse any complete capture and let deleting the bundle be the
    // explicit way to take a fresh snapshot.
    let valid = cached_metadata.as_ref().is_some_and(|m| {
        m.schema_version == PAPER_SCHEMA_VERSION
            && m.complete
            && m.source_url == url
            && cached_paper_has_body(&dir.join("paper.md"))
            && validate_paper_bundle(&dir, m).is_ok()
    });
    if valid {
        return Ok(FetchResult {
            arxiv_id: id.clone(),
            paper_path: format!(".research/papers/{id}/paper.md"),
            blog_path: None,
            reused: true,
        });
    }
    let papers_root = project::safe_path(root, ".research/papers")?;
    let temp_root = papers_root.join(format!(".fetch-{}", Uuid::new_v4()));
    let output_dir = temp_root.join("output");
    fs::create_dir_all(&output_dir).map_err(err)?;
    let build = || -> Result<(), String> {
        let page = crate::firecrawl::scrape(url)?;
        let title = page
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(url);
        let markdown = normalize_imported_markdown(&format!(
            "---\ntitle: \"{}\"\nurl: \"{}\"\nsource: \"web\"\n---\n\n{}",
            title.replace('"', "'"),
            url,
            page.markdown,
        ));
        fs::write(output_dir.join("paper.md"), &markdown).map_err(err)?;
        fs::create_dir_all(output_dir.join("paper_assets")).map_err(err)?;
        fs::write(
            output_dir.join("paper_assets/manifest.json"),
            "{\"schema_version\":1,\"assets\":[]}\n",
        )
        .map_err(err)?;
        let metadata = PaperMetadata {
            arxiv_id: id.clone(),
            requested_arxiv_id: id.clone(),
            title: title.to_string(),
            schema_version: PAPER_SCHEMA_VERSION,
            complete: true,
            converter: FIRECRAWL_CONVERTER.to_string(),
            source: "web".to_string(),
            source_url: url.to_string(),
            paper_sha256: sha256_hex(markdown.as_bytes()),
            asset_manifest_schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
        };
        validate_paper_bundle(&output_dir, &metadata)?;
        fs::write(
            output_dir.join("metadata.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&metadata).map_err(err)?
            ),
        )
        .map_err(err)?;
        let backup = dir.with_extension(format!("old-{}", Uuid::new_v4()));
        if dir.exists() {
            fs::rename(&dir, &backup).map_err(err)?;
        }
        if let Err(e) = fs::rename(&output_dir, &dir) {
            if backup.exists() {
                let _ = fs::rename(&backup, &dir);
            }
            return Err(err(e));
        }
        let _ = fs::remove_dir_all(backup);
        Ok(())
    };
    let built = build();
    let _ = fs::remove_dir_all(&temp_root);
    built?;
    Ok(FetchResult {
        arxiv_id: id.clone(),
        paper_path: format!(".research/papers/{id}/paper.md"),
        blog_path: None,
        reused: false,
    })
}

/// Convert the requested paper to markdown, returning the raw text and the
/// converter that produced it.
///
/// arXiv renders modern papers to HTML but never went back over the archive,
/// and ar5iv covers most — not all — of the rest. A paper neither has rendered
/// still has a PDF with a real text layer (arXiv PDFs come from pdfTeX, not
/// scans), so the text layer is the fallback: strictly worse than a rendering,
/// strictly better than the citation-with-no-text it used to be.
fn convert_paper(
    requested: &str,
    base: &str,
    output_dir: &Path,
    output_path: &Path,
) -> Result<(String, &'static str), String> {
    let output = commands::ARXIV2MD
        .command()
        .current_dir(output_dir)
        // Without this the converter caches its source HTML relative to the
        // working directory, which is the bundle being built — every paper
        // carried ~500 KB of its own raw HTML into the project.
        .env("ARXIV2MD_CACHE_PATH", commands::arxiv2md_cache_dir())
        .arg(requested)
        .arg("--frontmatter")
        .arg("--download-assets")
        // Papers are read, not re-exported, and arXiv's own figures are
        // routinely 16-bit-per-channel PNG — depth no screen can show at twice
        // the bytes. WebP keeps plots and diagrams pixel-exact and costs a
        // 32-paper library 34 MB of figures instead of 216 MB.
        .arg("--compress-assets")
        .arg("--remove-refs")
        .arg("--section")
        .arg("Acknowledgements")
        .arg("--section")
        .arg("Acknowledgments")
        .arg("-o")
        .arg(output_path)
        .output()
        .map_err(|e| uv_tool_spawn_error("arxiv2md", &e))?;
    match ensure_success("arxiv2md", &output) {
        Ok(()) => {
            if !output_path.is_file() {
                return Err("arxiv2md did not produce paper.md".to_string());
            }
            Ok((
                fs::read_to_string(output_path).map_err(err)?,
                ARXIV2MD_REQUIREMENT,
            ))
        }
        Err(error) if error.contains("does not have an HTML version") => {
            let markdown = pdf_text_markdown(requested, base).map_err(|pdf_error| {
                format!("{error}\nThe PDF fallback also failed: {pdf_error}")
            })?;
            // The bundle contract requires an asset manifest; the text layer
            // carries no extractable figures, so it is honestly empty.
            fs::create_dir_all(output_dir.join("paper_assets")).map_err(err)?;
            fs::write(
                output_dir.join("paper_assets/manifest.json"),
                "{\"schema_version\":1,\"assets\":[]}\n",
            )
            .map_err(err)?;
            Ok((markdown, ANYDOC_CONVERTER))
        }
        Err(error) => Err(error),
    }
}

/// The PDF text layer as markdown, with frontmatter that says what it is.
///
/// Honesty is the point of the frontmatter: the text layer has no figures,
/// and its equations carry font encoding rather than LaTeX (Computer Modern
/// renders `{W_i}` as `fWig`). Both the reader and the agent read this file
/// raw, so the caveat rides in the file itself rather than in UI state.
fn pdf_text_markdown(requested: &str, base: &str) -> Result<String, String> {
    const MAX_PDF_BYTES: usize = 100 * 1024 * 1024;
    let client = reqwest::blocking::Client::builder()
        .user_agent("Lattice research writer (paper import)")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| format!("Could not create the PDF download client: {error}"))?;
    let response = client
        .get(format!("https://arxiv.org/pdf/{requested}"))
        .send()
        .map_err(|error| format!("PDF download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "arXiv returned HTTP {} for the PDF.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PDF_BYTES as u64)
    {
        return Err("The PDF is larger than the 100 MB conversion limit.".to_string());
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("PDF download failed: {error}"))?;
    if bytes.len() > MAX_PDF_BYTES {
        return Err("The PDF is larger than the 100 MB conversion limit.".to_string());
    }
    let body = anydoc::to_markdown_bytes(&bytes, anydoc::Format::Pdf)
        .map_err(|error| format!("PDF conversion failed: {error}"))?;
    if body.trim().len() < 200 {
        return Err(
            "The PDF has almost no text layer; a scanned paper needs OCR, which is not available."
                .to_string(),
        );
    }
    let title = body
        .lines()
        .find_map(|line| {
            let text = line.trim_start_matches('#').trim();
            (line.starts_with('#') && !text.is_empty()).then(|| text.to_string())
        })
        .unwrap_or_else(|| format!("arXiv {base}"));
    Ok(format!(
        "---\ntitle: \"{}\"\nurl: \"https://arxiv.org/abs/{base}\"\nsource: \"pdf-text-layer\"\nfidelity: \"Converted from the PDF text layer because arXiv has no HTML rendering. Figures are absent and equations may be garbled by font encoding; verify formulas against the PDF before quoting them.\"\n---\n\n{}",
        title.replace('"', "'"),
        body,
    ))
}

fn validate_paper_bundle(directory: &Path, metadata: &PaperMetadata) -> Result<(), String> {
    let known_converter = metadata.converter == ARXIV2MD_REQUIREMENT
        || metadata.converter == ANYDOC_CONVERTER
        || metadata.converter == FIRECRAWL_CONVERTER;
    if !known_converter || metadata.asset_manifest_schema_version != ASSET_MANIFEST_SCHEMA_VERSION {
        return Err("The cached paper was produced by an unsupported converter.".to_string());
    }
    let paper = fs::read(directory.join("paper.md")).map_err(err)?;
    if sha256_hex(&paper) != metadata.paper_sha256 {
        return Err("The cached paper markdown does not match its metadata.".to_string());
    }
    let manifest_path = directory.join("paper_assets/manifest.json");
    let manifest: AssetManifest =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(err)?)
            .map_err(|error| format!("Invalid paper asset manifest: {error}"))?;
    if manifest.schema_version != ASSET_MANIFEST_SCHEMA_VERSION {
        return Err("Unsupported paper asset manifest version.".to_string());
    }
    let canonical_directory = fs::canonicalize(directory).map_err(err)?;
    for asset in manifest.assets {
        let relative = Path::new(&asset.path);
        if !relative.starts_with("paper_assets")
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(format!("Unsafe paper asset path: {}", asset.path));
        }
        if !matches!(
            asset.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err(format!("Unsupported paper asset type: {}", asset.mime_type));
        }
        let path = directory.join(relative);
        let canonical_path = fs::canonicalize(&path)
            .map_err(|_| format!("Paper asset is missing: {}", asset.path))?;
        if !canonical_path.starts_with(&canonical_directory) || !canonical_path.is_file() {
            return Err(format!("Unsafe paper asset path: {}", asset.path));
        }
        let bytes = fs::read(&canonical_path).map_err(err)?;
        if bytes.len() as u64 != asset.size || sha256_hex(&bytes) != asset.sha256 {
            return Err(format!(
                "Paper asset failed integrity validation: {}",
                asset.path
            ));
        }
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            use std::fmt::Write;
            let _ = write!(output, "{byte:02x}");
            output
        })
}

pub(crate) fn arxiv_base_id(arxiv_id: &str) -> &str {
    match arxiv_id.rsplit_once('v') {
        Some((base, version))
            if !base.is_empty() && version.chars().all(|c| c.is_ascii_digit()) =>
        {
            base
        }
        _ => arxiv_id,
    }
}

/// Everything the project cites, whether or not its full text was fetched.
///
/// Citations and downloaded papers used to be separate worlds: only a directory
/// under `.research/papers` holding a `paper.md` counted, so anything the agent
/// added through bibcite — and anything without an arXiv id at all — was
/// invisible here while sitting in the bibliography. Read both and join them on
/// the citation key.
pub fn list_papers(root: &Path) -> Result<Vec<PaperSummary>, String> {
    let mut imported = imported_papers(root)?;
    let mut papers = Vec::new();
    let manifest = project::read_manifest(root)?;
    let bibliography =
        fs::read_to_string(project::safe_path(root, &manifest.primary_bibliography)?)
            .unwrap_or_default();
    for citation in project::parse_bibliography(&bibliography) {
        // Join on either identifier. Keying on the citation key alone missed
        // every paper whose metadata.json predates that field or whose key was
        // later rewritten: the fetched text sat right there while the row
        // claimed the work had none and offered to download it again.
        let matched = imported
            .iter()
            .position(|(id, metadata, _has_full_text, _has_blog, _asset_paths)| {
                let by_arxiv = citation.arxiv_id.as_deref().is_some_and(|cited| {
                    arxiv_base_id(cited).eq_ignore_ascii_case(arxiv_base_id(id))
                });
                // A webpage citation has no arXiv id; its captured bundle
                // remembers which URL it snapshotted instead.
                let by_url = citation.url.as_deref().is_some_and(|cited| {
                    !metadata.source_url.is_empty() && metadata.source_url == cited.trim()
                });
                by_arxiv || by_url
            })
            .map(|index| imported.remove(index));
        let title = if !citation.title.trim().is_empty() {
            citation.title.clone()
        } else {
            citation.key.clone()
        };
        papers.push(PaperSummary {
            // Keep whichever id can actually fetch the text: the imported one,
            // else whatever the bibliography entry points at.
            arxiv_id: matched
                .as_ref()
                .map(|(id, _, _, _, _)| id.clone())
                .or(citation.arxiv_id)
                .unwrap_or_default(),
            url: citation.url,
            title,
            citation_key: Some(citation.key),
            has_full_text: matched
                .as_ref()
                .is_some_and(|(_, _, has_full_text, _, _)| *has_full_text),
            has_blog: matched
                .as_ref()
                .is_some_and(|(_, _, _, has_blog, _)| *has_blog),
            asset_paths: matched
                .map(|(_, _, _, _, asset_paths)| asset_paths)
                .unwrap_or_default(),
        });
    }
    // The bibliography is strictly authoritative; unclaimed cache entries stay hidden.
    papers.sort_by_key(|paper| paper.title.to_lowercase());
    Ok(papers)
}

/// Directories under `.research/papers` that hold full text and/or an overview.
fn imported_papers(root: &Path) -> Result<Vec<ImportedPaper>, String> {
    let directory = root.join(".research/papers");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut imported = Vec::new();
    for paper_directory in paper_cache_directories(&directory)? {
        let markdown_path = paper_directory.join("paper.md");
        let arxiv_id = paper_directory
            .strip_prefix(&directory)
            .map_err(err)?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let markdown = fs::read_to_string(markdown_path).unwrap_or_default();
        let has_full_text = markdown_has_body(&markdown);
        let has_blog = fs::read_to_string(paper_directory.join("blog.md"))
            .ok()
            .is_some_and(|blog| markdown_has_body(&blog));
        if !has_full_text && !has_blog {
            continue;
        }
        // Legacy or externally supplied text may have no metadata. Keep it
        // readable, but do not treat it as a complete reusable tool cache.
        let metadata = fs::read_to_string(paper_directory.join("metadata.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<PaperMetadata>(&raw).ok())
            .unwrap_or_else(|| PaperMetadata {
                arxiv_id: arxiv_id.clone(),
                requested_arxiv_id: String::new(),
                title: parse_title(&markdown).unwrap_or_default(),
                schema_version: 0,
                complete: false,
                converter: String::new(),
                source: String::new(),
                source_url: String::new(),
                paper_sha256: String::new(),
                asset_manifest_schema_version: 0,
            });
        let asset_paths = paper_asset_paths(&paper_directory, &arxiv_id);
        imported.push((arxiv_id, metadata, has_full_text, has_blog, asset_paths));
    }
    Ok(imported)
}

fn paper_asset_paths(directory: &Path, arxiv_id: &str) -> Vec<String> {
    let manifest_path = directory.join("paper_assets/manifest.json");
    let Ok(bytes) = fs::read(&manifest_path) else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_slice::<AssetManifest>(&bytes) else {
        return Vec::new();
    };
    let prefix = format!(".research/papers/{arxiv_id}/");
    let mut paths = vec![format!("{prefix}paper_assets/manifest.json")];
    paths.extend(manifest.assets.into_iter().filter_map(|asset| {
        let path = Path::new(&asset.path);
        (path.starts_with("paper_assets")
            && path
                .components()
                .all(|component| matches!(component, Component::Normal(_))))
        .then(|| format!("{prefix}{}", asset.path))
    }));
    paths
}

fn paper_cache_directories(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut found = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        if !entry.file_type().map_err(err)?.is_dir() {
            continue;
        }
        let path = entry.path();
        if path.join("paper.md").is_file() || path.join("blog.md").is_file() {
            found.push(path);
        } else {
            // Legacy arXiv ids contain one slash (`archive/YYMMNNN`). Inspect
            // exactly that second level and never follow symlinks.
            for child in fs::read_dir(&path).map_err(err)? {
                let child = child.map_err(err)?;
                if child.file_type().map_err(err)?.is_dir()
                    && (child.path().join("paper.md").is_file()
                        || child.path().join("blog.md").is_file())
                {
                    found.push(child.path());
                }
            }
        }
    }
    Ok(found)
}

pub fn search_papers(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    let terms = project::search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    for paper in list_papers(root)? {
        if project::matches_search(&paper.title, &terms) {
            results.push(ProjectSearchResult {
                kind: "paper".to_string(),
                path: format!(".research/papers/{}/paper.md", paper.arxiv_id),
                title: paper.title,
                snippet: String::new(),
                line: None,
                arxiv_id: Some(paper.arxiv_id),
                file_kind: None,
            });
        }
    }
    results.truncate(60);
    Ok(results)
}

pub fn read_paper(root: &Path, arxiv_id: &str) -> Result<String, String> {
    validate_paper_key(arxiv_id)?;
    let markdown = project::read_file(root, &format!(".research/papers/{arxiv_id}/paper.md"))?;
    if !markdown_has_body(&markdown) {
        return Err("Cached paper has no full-text body.".to_string());
    }
    Ok(markdown)
}

fn cached_paper_has_body(path: &Path) -> bool {
    fs::read_to_string(path)
        .ok()
        .is_some_and(|markdown| markdown_has_body(&markdown))
}

fn markdown_has_body(markdown: &str) -> bool {
    let mut lines = markdown.lines();
    if lines.next().is_some_and(|line| line.trim() == "---") {
        for line in &mut lines {
            if line.trim() == "---" {
                return lines.any(|body_line| !body_line.trim().is_empty());
            }
        }
        return false;
    }
    !markdown.trim().is_empty()
}

/// The alphaXiv overview ("blog") for an imported paper. Returns the stored
/// `blog.md` when present; otherwise backfills it once from alphaXiv (covering
/// papers imported before blogs existed, or whose import-time fetch failed) and
/// caches it. `Ok(None)` when alphaXiv has no report for the paper.
pub fn read_paper_blog(root: &Path, arxiv_id: &str) -> Result<Option<String>, String> {
    validate_paper_key(arxiv_id)?;
    // A webpage capture has no overview and its key means nothing to
    // alphaXiv; asking would be a guaranteed-miss network call per open.
    if arxiv_id.starts_with("web-") {
        return read_paper_blog_local(root, arxiv_id);
    }
    let blog_path = project::safe_path(root, &format!(".research/papers/{arxiv_id}/blog.md"))?;
    if blog_path.exists() {
        return fs::read_to_string(&blog_path).map(Some).map_err(err);
    }
    // Only backfill papers we actually hold; the reader has nothing to show for
    // a cite-only work, and we would not have a directory to cache into.
    let paper_dir = project::safe_path(root, &format!(".research/papers/{arxiv_id}"))?;
    if !paper_dir.exists() {
        return Ok(None);
    }
    match crate::alphaxiv::fetch_overview(arxiv_id)? {
        Some(blog) => {
            fs::write(&blog_path, &blog).map_err(err)?;
            Ok(Some(blog))
        }
        None => Ok(None),
    }
}

/// Read an overview only when it is already cached. Unlike `read_paper_blog`,
/// this is safe for passive UI affordances and never performs network I/O.
pub fn read_paper_blog_local(root: &Path, arxiv_id: &str) -> Result<Option<String>, String> {
    validate_paper_key(arxiv_id)?;
    let path = project::safe_path(root, &format!(".research/papers/{arxiv_id}/blog.md"))?;
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(err)
}

/// Remove only the primary bibliography entry, retaining any downloaded cache.
pub fn remove_reference(root: &Path, key: &str) -> Result<RemoveResult, String> {
    remove_reference_with_history(root, key, HistoryMode::Record)
}

pub(crate) fn remove_reference_with_history(
    root: &Path,
    key: &str,
    history: HistoryMode,
) -> Result<RemoveResult, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter a citation key to remove.".to_string());
    }
    let blockers = citation_blockers(root, key)?;
    if !blockers.is_empty() {
        return Ok(RemoveResult {
            key: key.to_string(),
            removed: false,
            blockers,
        });
    }
    let manifest = project::read_manifest(root)?;
    let path = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = fs::read_to_string(&path).unwrap_or_default();
    let exact_key = project::parse_bibliography(&before)
        .into_iter()
        .find(|entry| entry.key.eq_ignore_ascii_case(key))
        .map(|entry| entry.key)
        .ok_or_else(|| format!("Citation key `{key}` is not in the primary bibliography."))?;
    let temp = std::env::temp_dir().join(format!("lattice-remove-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).map_err(err)?;
    let copy = temp.join("references.bib");
    fs::write(&copy, &before).map_err(err)?;
    run_bibcite_remove(&copy, &exact_key)?;
    let after = fs::read_to_string(&copy).map_err(err)?;
    let _ = fs::remove_dir_all(temp);
    commit_bibliography(
        root,
        &manifest.primary_bibliography,
        &after,
        &format!("Remove {exact_key}"),
        history,
    )?;
    Ok(RemoveResult {
        key: exact_key,
        removed: true,
        blockers: Vec::new(),
    })
}

fn citation_blockers(
    root: &Path,
    key: &str,
) -> Result<Vec<crate::models::SymbolOccurrence>, String> {
    project::find_citation_usages(root, key)
}

pub fn upgrade_bibliography(root: &Path, dry_run: bool) -> Result<UpgradeResult, String> {
    upgrade_bibliography_with_history(root, dry_run, HistoryMode::Record)
}

pub(crate) fn upgrade_bibliography_with_history(
    root: &Path,
    dry_run: bool,
    history: HistoryMode,
) -> Result<UpgradeResult, String> {
    let manifest = project::read_manifest(root)?;
    let path = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = fs::read_to_string(&path).unwrap_or_default();
    let temp = std::env::temp_dir().join(format!("lattice-upgrade-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).map_err(err)?;
    let copy = temp.join("references.bib");
    fs::write(&copy, &before).map_err(err)?;
    let mut command = commands::BIBCITE.command();
    command.arg("upgrade").arg("--no-tidy").arg(&copy);
    if dry_run {
        command.arg("--dry-run");
    }
    let output = command
        .output()
        .map_err(|e| uv_tool_spawn_error("bibcite", &e))?;
    ensure_success("bibcite", &output)?;
    let report = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("bibcite returned an invalid JSON report: {error}"))?;
    let mut after = fs::read_to_string(&copy).map_err(err)?;
    if !dry_run && after != before {
        run_bibcite_tidy(&copy)?;
        after = fs::read_to_string(&copy).map_err(err)?;
        commit_bibliography(
            root,
            &manifest.primary_bibliography,
            &after,
            "Upgrade bibliography",
            history,
        )?;
    }
    let _ = fs::remove_dir_all(temp);
    Ok(UpgradeResult {
        dry_run,
        changed: after != before,
        report,
    })
}

/// A bundle key under `.research/papers`: an arXiv id, or the digest name
/// of a captured webpage. Everything that only reads bundles takes this;
/// fetch_paper keeps the strict arXiv check because only arXiv is fetchable
/// by id.
fn validate_paper_key(key: &str) -> Result<(), String> {
    if Regex::new(r"^web-[0-9a-f]{16}$").unwrap().is_match(key) {
        return Ok(());
    }
    validate_arxiv_id(key)
}

fn validate_arxiv_id(arxiv_id: &str) -> Result<(), String> {
    if Regex::new(r"(?i)^\d{4}\.\d{4,5}(v\d+)?$|^[a-z-]+(?:\.[a-z]{2})?/\d{7}(v\d+)?$")
        .unwrap()
        .is_match(arxiv_id)
    {
        Ok(())
    } else {
        Err("Invalid arXiv id.".to_string())
    }
}

/// An arXiv id inside whatever was typed, if there is one.
///
/// The word boundaries matter now that anything else is a valid entry: without
/// them the digits inside a DOI like `10.1145/3292500.3330701` match the
/// modern arXiv shape, and the app would go and look for a paper that does not
/// exist instead of asking bibcite to resolve the DOI.
fn parse_arxiv_id(input: &str) -> Option<String> {
    let pattern =
        Regex::new(r"(?i)\b(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?)\b")
            .unwrap();
    pattern
        .captures(input.trim())
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str().to_string())
}

/// Everything that is not an arXiv paper: resolve it, write the `.bib` entry,
/// and stop there. There is no text to fetch and none is pretended.
fn import_citation(
    root: &Path,
    manifest: &crate::models::ProjectManifest,
    query: &str,
    history: HistoryMode,
    progress: &dyn Fn(&str),
) -> Result<ImportResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Enter an arXiv id, a DOI, a URL, or a paper title.".to_string());
    }
    let temp = std::env::temp_dir().join(format!("research-writer-cite-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp).map_err(err)?;
    let bibliography_path = temp.join("references.bib");
    let project_bibliography = project::safe_path(root, &manifest.primary_bibliography)?;
    let before = if project_bibliography.exists() {
        fs::read_to_string(&project_bibliography).map_err(err)?
    } else {
        String::new()
    };
    fs::write(&bibliography_path, &before).map_err(err)?;

    progress("resolving");
    let citation_output = run_bibcite(&bibliography_path, query)?;
    let bibliography = fs::read_to_string(&bibliography_path).map_err(err)?;
    let citation_key = parse_citation_key(&citation_output)
        .ok_or_else(|| "bibcite did not return a citation key.".to_string())?;
    // Whether the work was already cited, asked of the bibliography rather
    // than of the file's bytes: bibcite may tidy an entry it decides to keep,
    // and a reformat is not a new reference.
    let already_imported = project::parse_bibliography(&before)
        .iter()
        .any(|entry| entry.key.eq_ignore_ascii_case(&citation_key));
    let resolved_entry = project::parse_bibliography(&bibliography)
        .into_iter()
        .find(|entry| entry.key.eq_ignore_ascii_case(&citation_key))
        .ok_or_else(|| "bibcite reported a key absent from its bibliography.".to_string())?;
    let title = Some(resolved_entry.title.clone())
        .filter(|title| !title.trim().is_empty())
        .or_else(|| Some(citation_key.clone()))
        .unwrap_or_else(|| query.to_string());
    let resolved_arxiv = resolved_entry.arxiv_id;
    // The bibliography is the deliverable; the fetched text is enrichment.
    // Commit it before attempting any download: a work whose text cannot be
    // fetched (no HTML rendering, network trouble) is still a full citation —
    // see the note on import_reference — and failing the import after bibcite
    // already resolved the entry threw the user's citation away over a
    // download problem.
    if bibliography != before {
        commit_bibliography(
            root,
            &manifest.primary_bibliography,
            &bibliography,
            &format!("Cite {citation_key}"),
            history,
        )?;
    }
    // A DOI/title may resolve to an entry carrying an arXiv eprint. Attach its
    // cache only after bibcite has told us the identity; fetching never edits
    // the bibliography itself.
    let mut fetch_error = None;
    let fetched = match resolved_arxiv.as_deref() {
        Some(id) => match fetch_paper_with_progress(root, id, progress) {
            Ok(fetched) => Some(fetched),
            Err(error) => {
                fetch_error = Some(error);
                None
            }
        },
        // bibcite classifies what it resolved; only an actual webpage gets
        // scraped. A DOI'd journal article also carries a `url`, but that is
        // a publisher landing page — paywall chrome, not the work — and every
        // scrape spends shared Firecrawl quota.
        None if bibcite_report_source(&citation_output).as_deref() == Some("webpage") => {
            match resolved_entry
                .url
                .as_deref()
                .filter(|entry_url| is_web_url(entry_url))
                .or_else(|| Some(query).filter(|typed| is_web_url(typed)))
            {
                Some(page_url) => {
                    progress("fulltext");
                    match fetch_web_reference(root, page_url) {
                        Ok(fetched) => Some(fetched),
                        Err(error) => {
                            fetch_error = Some(error);
                            None
                        }
                    }
                }
                None => None,
            }
        }
        None => None,
    };
    let _ = fs::remove_dir_all(&temp);
    Ok(ImportResult {
        // The fetched bundle's key when there is one — for a webpage that is
        // the digest id, which is what the UI needs to open and share it.
        arxiv_id: fetched
            .as_ref()
            .map(|item| item.arxiv_id.clone())
            .or(resolved_arxiv)
            .unwrap_or_default(),
        title,
        paper_path: fetched.map(|item| item.paper_path).unwrap_or_default(),
        citation_key: Some(citation_key),
        citation_output,
        already_imported,
        fetch_error,
    })
}

fn run_bibcite(path: &PathBuf, query: &str) -> Result<String, String> {
    let output = commands::BIBCITE
        .command()
        .arg("add")
        .arg("--no-tidy")
        .arg(path)
        .arg(query)
        .output()
        .map_err(|error| uv_tool_spawn_error("bibcite", &error))?;
    ensure_success("bibcite", &output)?;
    let report = String::from_utf8(output.stdout).map_err(err)?;
    serde_json::from_str::<Value>(&report)
        .map_err(|error| format!("bibcite returned an invalid JSON report: {error}"))?;
    run_bibcite_tidy(path)?;
    Ok(report)
}

fn run_bibcite_remove(path: &PathBuf, key: &str) -> Result<(), String> {
    let output = commands::BIBCITE
        .command()
        .arg("remove")
        .arg("--no-tidy")
        .arg(path)
        .arg(key)
        .output()
        .map_err(|error| uv_tool_spawn_error("bibcite", &error))?;
    ensure_success("bibcite", &output)?;
    serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|error| format!("bibcite returned an invalid JSON report: {error}"))?;
    run_bibcite_tidy(path)
}

fn run_bibcite_tidy(path: &Path) -> Result<(), String> {
    let output = commands::BIBCITE
        .command()
        .arg("tidy")
        .arg(path)
        .output()
        .map_err(|error| uv_tool_spawn_error("bibcite", &error))?;
    ensure_success("bibcite tidy", &output)
}

fn commit_bibliography(
    root: &Path,
    relative: &str,
    contents: &str,
    label: &str,
    history: HistoryMode,
) -> Result<(), String> {
    match history {
        HistoryMode::Record => {
            project::apply_citation_transaction(
                root,
                label,
                vec![(relative.to_string(), contents.to_string())],
            )?;
        }
        HistoryMode::Defer => {
            fs::write(project::safe_path(root, relative)?, contents).map_err(err)?;
        }
    }
    Ok(())
}

/// The citation key bibcite settled on, out of its report.
///
/// It prints one indented JSON object on stdout and its diagnostics on stderr,
/// so reading this a line at a time — as this did — never parsed anything: not
/// one line of `{\n  "key": "he2016deep",\n …}` is valid JSON on its own. Every
/// import has been recording a null key since, which is why the Papers list
/// carries a fallback that joins a paper to its citation by arXiv id, and why
/// a work with no arXiv id could not be joined at all.
///
/// Each balanced object is tried, newest first, so a run that reports several
/// entries still yields the last key.
/// bibcite's classification of what it resolved ("arxiv", "doi",
/// "webpage", …), from the same JSON report the key comes from.
fn bibcite_report_source(output: &str) -> Option<String> {
    json_objects(output).into_iter().rev().find_map(|chunk| {
        serde_json::from_str::<Value>(&chunk)
            .ok()?
            .get("source")
            .and_then(Value::as_str)
            .map(ToString::to_string)
    })
}

fn parse_citation_key(output: &str) -> Option<String> {
    json_objects(output).into_iter().rev().find_map(|chunk| {
        serde_json::from_str::<Value>(&chunk)
            .ok()?
            .get("key")
            .and_then(Value::as_str)
            .map(ToString::to_string)
    })
}

/// Every brace-balanced `{…}` in the text, in order. Braces inside strings do
/// not count, or a title containing one would end the object early.
fn json_objects(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = index;
                }
                depth += 1;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    found.push(text[start..index + character.len_utf8()].to_string());
                }
            }
            _ => {}
        }
    }
    found
}

fn parse_title(markdown: &str) -> Option<String> {
    // With --frontmatter, arxiv2md's clean title is the YAML `title:` field;
    // older output carried a plain `Title:` line. Prefer the frontmatter.
    yaml_frontmatter_title(markdown).or_else(|| {
        markdown.lines().find_map(|line| {
            line.strip_prefix("Title:")
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(ToString::to_string)
        })
    })
}

fn yaml_frontmatter_title(markdown: &str) -> Option<String> {
    let mut lines = markdown.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix("title:") {
            let value = rest.trim().trim_matches('"').trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn ensure_success(name: &str, output: &Output) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{name} failed.\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Importing arXiv papers shells out to `uvx` (arxiv2markdown + bibcite-cli).
/// When uv isn't installed the raw spawn error ("No such file or directory") is
/// baffling, so point the user straight at the installer.
pub(crate) fn uv_tool_spawn_error(tool: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "Adding arXiv papers needs the `uv` tool, which isn't installed yet. \
Install it from Settings → TeX doctor → Open install guide (or run `brew install uv`), then try again."
            .to_string()
    } else {
        format!("Could not start {tool}: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_converter_block_structure_without_touching_latex() {
        let source = "## Contents\n- Intro\n\n<a id=\"eq\"></a>\n$$\nx_{p} \\%\n$$\n\n- •\nContinuation with $x_{p}$\n";
        assert_eq!(
            normalize_imported_markdown(source),
            "## Contents\n\n- Intro\n\n<a id=\"eq\"></a>\n\n$$\nx_{p} \\%\n$$\n\n- Continuation with $x_{p}$\n",
        );
    }

    #[test]
    fn folds_item_bullet_glyphs_into_their_markers() {
        let source = "- •\n  $p(\\textbf{x}|c)$. First item.\n- •\n  Second item.\n  - •\n    Nested item.\n";
        assert_eq!(
            normalize_imported_markdown(source),
            "- $p(\\textbf{x}|c)$. First item.\n- Second item.\n  - Nested item.\n",
        );
    }

    #[test]
    fn rejoins_hard_wrapped_paragraphs_but_not_structure() {
        let source = "---\ntitle: \"T\"\nauthors: [\"A\", \"B\"]\n---\n\nOne sentence that was wrapped,\nand continues here.\nStill the same paragraph.\n\n## Heading stays\n\n- list item stays\n\n<a id=\"S1\"></a>\n\nNext paragraph after anchor,\nrejoined too.\n";
        assert_eq!(
            normalize_imported_markdown(source),
            "---\ntitle: \"T\"\nauthors: [\"A\", \"B\"]\n---\n\nOne sentence that was wrapped, and continues here. Still the same paragraph.\n\n## Heading stays\n\n- list item stays\n\n<a id=\"S1\"></a>\n\nNext paragraph after anchor, rejoined too.\n",
        );
    }

    #[test]
    fn leaves_display_math_and_code_fences_unwrapped() {
        let source = "Before math\n\n$$\na = b\n+ c\n$$\n\n```\nline one\nline two\n```\n";
        assert_eq!(normalize_imported_markdown(source), source);
    }

    #[test]
    fn links_contents_entries_to_their_headings() {
        let source = "## Contents\n\n- 1 Introduction\n  - 1.1 Setup\n- Diffusion Models.\n- Diffusion Models.\n- No Such Section\n\n## 1 Introduction\n\n### 1.1 Setup\n\n#### Diffusion Models.\n\n#### Diffusion Models.\n";
        let normalized = normalize_imported_markdown(source);
        assert!(normalized.contains("- [1 Introduction](#1-introduction)"));
        assert!(normalized.contains("  - [1.1 Setup](#1-1-setup)"));
        // Duplicate section names consume headings in document order, with
        // the same numeric suffixing HeadingAnchors applies.
        assert!(normalized.contains("- [Diffusion Models.](#diffusion-models)\n"));
        assert!(normalized.contains("- [Diffusion Models.](#diffusion-models-1)"));
        // An entry with no matching heading stays plain text.
        assert!(normalized.contains("- No Such Section"));
    }

    #[test]
    fn slugs_match_the_editors_wiki_link_slugger() {
        assert_eq!(
            wiki_link_slug("2.1 Conditional Video Generation"),
            "2-1-conditional-video-generation"
        );
        assert_eq!(wiki_link_slug("Why Video?"), "why-video");
        assert_eq!(
            wiki_link_slug("Simulating the SE(3) Action Space"),
            "simulating-the-se-3-action-space"
        );
        // NFKD + combining-mark stripping, as in toWikiLinkSlug.
        assert_eq!(wiki_link_slug("Café Décor"), "cafe-decor");
        assert_eq!(wiki_link_slug("  --- "), "");
    }

    /// bibcite reports one indented JSON object and its diagnostics around it.
    /// Read a line at a time this parsed nothing at all, so every import
    /// recorded a null citation key while bibcite had returned one.
    #[test]
    fn reads_the_citation_key_out_of_bibcites_report() {
        let output = "{\n  \"query\": \"10.1109/CVPR.2016.90\",\n  \"action\": \"added\",\n  \
             \"key\": \"he2016deep\",\n  \"title\": \"Deep Residual Learning\",\n  \
             \"published\": true\n}\n[bibcite] query understood as doi: 10.1109/CVPR.2016.90\n";
        assert_eq!(parse_citation_key(output).as_deref(), Some("he2016deep"));
    }

    #[test]
    fn takes_the_last_key_when_several_entries_are_reported() {
        let output = "{\"key\": \"first2020\"}\nnoise\n{\n  \"key\": \"second2021\"\n}\n";
        assert_eq!(parse_citation_key(output).as_deref(), Some("second2021"));
    }

    /// A brace inside a title must not close the object early, or the key
    /// after it is never seen.
    #[test]
    fn is_not_confused_by_braces_inside_strings() {
        let output = "{\n  \"title\": \"On {NP}-hardness\",\n  \"key\": \"karp1972\"\n}\n";
        assert_eq!(parse_citation_key(output).as_deref(), Some("karp1972"));
    }

    #[test]
    fn reports_no_key_when_bibcite_found_nothing() {
        assert_eq!(
            parse_citation_key("[bibcite] No match found anywhere for: x\n"),
            None
        );
    }

    #[test]
    fn accepts_urls_and_ids() {
        assert_eq!(
            parse_arxiv_id("https://arxiv.org/abs/2401.12345").unwrap(),
            "2401.12345"
        );
        assert_eq!(parse_arxiv_id("2401.12345v2").unwrap(), "2401.12345v2");
        assert_eq!(parse_arxiv_id("not a paper"), None);
    }

    /// Anything that is not an arXiv paper has to reach bibcite untouched.
    /// The digits inside a DOI have the shape of a modern arXiv id, and
    /// without word boundaries `10.1145/3292500.3330701` matched — so the app
    /// went looking for a paper that does not exist instead of resolving it.
    #[test]
    fn does_not_mistake_a_doi_or_a_title_for_an_arxiv_id() {
        assert_eq!(parse_arxiv_id("10.1145/3292500.3330701"), None);
        assert_eq!(
            parse_arxiv_id("https://doi.org/10.1038/s41586-021-03819-2"),
            None
        );
        assert_eq!(parse_arxiv_id("Attention Is All You Need"), None);
        assert_eq!(
            parse_arxiv_id("https://example.edu/blog/2024/some-post"),
            None
        );
        // Longer than any arXiv id, so it is not one with the tail ignored.
        assert_eq!(parse_arxiv_id("2401.123456789"), None);
        // Still found inside a real URL, which is what people paste.
        assert_eq!(
            parse_arxiv_id("see https://arxiv.org/pdf/2401.12345v3 for details").unwrap(),
            "2401.12345v3"
        );
    }

    #[test]
    fn extracts_the_paper_title_from_arxiv_markdown() {
        assert_eq!(
            parse_title("Title: Attention Is All You Need\nArXiv: 1706.03762\n"),
            Some("Attention Is All You Need".to_string())
        );
    }

    #[test]
    fn extracts_the_title_from_yaml_frontmatter() {
        let markdown =
            "---\ntitle: \"Attention Is All You Need\"\nsections: 28\n---\n\n## Contents\n";
        assert_eq!(
            parse_title(markdown),
            Some("Attention Is All You Need".to_string())
        );
    }

    #[test]
    fn distinguishes_frontmatter_only_cache_from_markdown_with_a_body() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-body-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{empty, title={Empty}, eprint={2501.00001}}\n\
             @article{full, title={Full}, eprint={2501.00002}}\n",
        )
        .unwrap();
        for (id, markdown) in [
            ("2501.00001", "---\ntitle: Empty\nsections: 0\n---\n\n"),
            (
                "2501.00002",
                "---\ntitle: Full\n---\n\n# Introduction\nText.\n",
            ),
        ] {
            let directory = root.join(".research/papers").join(id);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("paper.md"), markdown).unwrap();
        }

        let papers = list_papers(&root).unwrap();
        assert!(
            !papers
                .iter()
                .find(|paper| paper.arxiv_id == "2501.00001")
                .unwrap()
                .has_full_text
        );
        assert!(
            papers
                .iter()
                .find(|paper| paper.arxiv_id == "2501.00002")
                .unwrap()
                .has_full_text
        );
        assert!(read_paper(&root, "2501.00001").is_err());
        assert!(read_paper(&root, "2501.00002")
            .unwrap()
            .contains("Introduction"));
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn reports_a_cached_blog_independently_from_full_text() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-blog-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{overview, title={Overview only}, eprint={2501.00003}}\n",
        )
        .unwrap();
        let directory = root.join(".research/papers/2501.00003");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("paper.md"),
            "---\ntitle: Overview only\n---\n",
        )
        .unwrap();
        fs::write(directory.join("blog.md"), "# A useful overview\nDetails.\n").unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1);
        assert!(!papers[0].has_full_text);
        assert!(papers[0].has_blog);

        fs::write(root.join("references.bib"), "").unwrap();
        assert!(list_papers(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn lists_cited_works_even_when_only_the_bibliography_knows_them() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-list-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        // Two citations; only the first was ever fetched.
        fs::write(
            root.join("references.bib"),
            "@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  eprint = {1706.03762}\n}\n\
             @article{kingma2015adam,\n  title = {Adam: A Method for Stochastic Optimization},\n  eprint = {1412.6980}\n}\n",
        )
        .unwrap();
        let directory = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("paper.md"),
            "Title: Attention Is All You Need\n",
        )
        .unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":"vaswani2017attention"}"#,
        )
        .unwrap();
        fs::write(directory.join("blog.md"), "# Overview\n").unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 2, "got: {papers:?}");

        let adam = papers
            .iter()
            .find(|paper| paper.citation_key.as_deref() == Some("kingma2015adam"))
            .expect("a bibliography-only entry should still be listed");
        assert!(!adam.has_full_text);
        assert!(!adam.has_blog);
        assert_eq!(adam.title, "Adam: A Method for Stochastic Optimization");
        // Its arXiv id came off the bibliography, so the text can be fetched later.
        assert_eq!(adam.arxiv_id, "1412.6980");

        let attention = papers
            .iter()
            .find(|paper| paper.citation_key.as_deref() == Some("vaswani2017attention"))
            .expect("the fetched paper should still be listed");
        assert!(attention.has_full_text);
        assert!(attention.has_blog);
        assert_eq!(attention.arxiv_id, "1706.03762");

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn lists_only_the_manifest_primary_bibliography() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-primary-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@book{primary, title={Primary source}}\n",
        )
        .unwrap();
        fs::write(
            root.join("supplement.bib"),
            "@book{secondary, title={Completion only}}\n",
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1);
        assert_eq!(papers[0].citation_key.as_deref(), Some("primary"));
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn remove_is_blocked_by_nocite_and_preserves_the_cache() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-blocker-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("main.tex"), "\\nocite{KEEP}\n").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{keep, title={Keep me}, eprint={2401.00001}}\n",
        )
        .unwrap();
        let cache = root.join(".research/papers/2401.00001");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("paper.md"), "cached").unwrap();

        let result = remove_reference(&root, "keep").unwrap();
        assert!(!result.removed);
        assert!(!result.blockers.is_empty());
        assert!(cache.join("paper.md").is_file());
        assert!(fs::read_to_string(root.join("references.bib"))
            .unwrap()
            .contains("keep"));
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn bibliography_definition_alone_does_not_block_removal() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-unused-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{unused, title={Not cited in the manuscript}}\n",
        )
        .unwrap();

        assert!(citation_blockers(&root, "unused").unwrap().is_empty());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn nocite_wildcard_blocks_removing_any_entry() {
        let parent =
            std::env::temp_dir().join(format!("lattice-paper-wildcard-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("main.tex"), "\\nocite{*}\n").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{keep, title={Keep everything}}\n",
        )
        .unwrap();

        assert!(!citation_blockers(&root, "keep").unwrap().is_empty());
        let _ = fs::remove_dir_all(parent);
    }

    #[cfg(unix)]
    #[test]
    fn cache_discovery_does_not_follow_symlink_loops() {
        use std::os::unix::fs::symlink;

        let parent = std::env::temp_dir().join(format!("lattice-paper-loop-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let papers = root.join(".research/papers");
        fs::create_dir_all(papers.join("archive")).unwrap();
        symlink(&papers, papers.join("archive/loop")).unwrap();

        assert!(imported_papers(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn supports_and_discovers_legacy_arxiv_cache_paths() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-legacy-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let directory = root.join(".research/papers/math.GT/0211159");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("paper.md"), "Title: A legacy paper\n").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{legacy, title={A legacy paper}, eprint={math.GT/0211159}}\n",
        )
        .unwrap();

        assert_eq!(
            parse_arxiv_id("https://arxiv.org/abs/math.GT/0211159v2").as_deref(),
            Some("math.GT/0211159v2")
        );
        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1);
        assert_eq!(papers[0].arxiv_id, "math.GT/0211159");
        assert!(papers[0].has_full_text);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn finds_the_arxiv_id_in_a_conference_entry_that_also_cites_the_preprint() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-eprint-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            r#"@inproceedings{lei2025scalability,
  author        = {Weixian Lei and Jiacong Wang},
  title         = {The Scalability of Simplicity},
  booktitle     = {IEEE/CVF International Conference on Computer Vision (ICCV)},
  year          = {2025},
  url           = {https://arxiv.org/abs/2504.10462},
  archiveprefix = {arXiv},
  eprint        = {2504.10462},
  primaryclass  = {cs.CV},
}
"#,
        )
        .unwrap();
        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1, "got: {papers:?}");
        assert_eq!(papers[0].arxiv_id, "2504.10462", "got: {:?}", papers[0]);
        assert!(!papers[0].has_full_text);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn finds_the_arxiv_id_in_a_blip3o_style_journal_field() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-journal-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{blip3o, title={BLIP3o}, journal={arXiv preprint arXiv:2505.09568}}\n",
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1);
        assert_eq!(papers[0].arxiv_id, "2505.09568");
        assert!(!papers[0].has_full_text);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn joins_a_fetched_paper_to_its_citation_by_arxiv_id_when_the_key_is_unknown() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-join-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@inproceedings{lei2025scalability,\n  title = {The Scalability of Simplicity},\n  eprint = {2504.10462}\n}\n",
        )
        .unwrap();
        // Imported before the citation key existed, so metadata knows no key —
        // and the stored id carries a version suffix the citation omits.
        let directory = root.join(".research/papers/2504.10462v2");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("paper.md"),
            "Title: The Scalability of Simplicity\n",
        )
        .unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"2504.10462v2","title":"The Scalability of Simplicity"}"#,
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(
            papers.len(),
            1,
            "the fetched text and its citation are one work: {papers:?}"
        );
        assert!(papers[0].has_full_text, "got: {:?}", papers[0]);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn does_not_list_a_fetched_paper_twice_when_it_is_also_cited() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-dedupe-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  eprint = {1706.03762}\n}\n",
        )
        .unwrap();
        let directory = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("paper.md"),
            "Title: Attention Is All You Need\n",
        )
        .unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":"vaswani2017attention"}"#,
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1, "got: {papers:?}");
        assert!(papers[0].has_full_text);
    }

    /// Papers is the project's literature, not everything the agent opened.
    ///
    /// A survey has the agent reading dozens of papers into
    /// `.research/papers/`; listing those would bury the handful that are
    /// actually cited. The line is the bibliography, and the marker for a read
    /// is simply that nothing wrote a `metadata.json` beside the text.
    #[test]
    fn keeps_papers_the_agent_only_read_out_of_the_list_until_they_are_cited() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-reading-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        fs::write(root.join("references.bib"), "").unwrap();

        // What the skill leaves behind: the text, and nothing else.
        let read = root.join(".research/papers/2401.00001");
        fs::create_dir_all(&read).unwrap();
        fs::write(read.join("paper.md"), "Title: Something I skimmed\n").unwrap();

        // A second uncited cache entry is hidden too, regardless of metadata.
        let library = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&library).unwrap();
        fs::write(
            library.join("paper.md"),
            "Title: Attention Is All You Need\n",
        )
        .unwrap();
        fs::write(
            library.join("metadata.json"),
            r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":null}"#,
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        assert!(papers.is_empty(), "got: {papers:?}");

        // Citing the one that was only read brings it in, text and all — no
        // file has to move and no metadata has to be rewritten.
        fs::write(
            root.join("references.bib"),
            "@misc{skimmed2024,\n  title = {Something I skimmed},\n  eprint = {2401.00001}\n}\n",
        )
        .unwrap();
        let papers = list_papers(&root).unwrap();
        assert_eq!(papers.len(), 1, "got: {papers:?}");
        let cited = papers
            .iter()
            .find(|paper| paper.arxiv_id == "2401.00001")
            .expect("the newly cited paper");
        assert!(cited.has_full_text);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn reuses_a_complete_canonical_cache_without_spawning_a_fetch() {
        let parent =
            std::env::temp_dir().join(format!("lattice-paper-duplicate-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let directory = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&directory).unwrap();
        let markdown = "Title: Attention Is All You Need\n";
        fs::write(directory.join("paper.md"), markdown).unwrap();
        fs::create_dir_all(directory.join("paper_assets")).unwrap();
        fs::write(
            directory.join("paper_assets/manifest.json"),
            r#"{"schema_version":1,"assets":[]}"#,
        )
        .unwrap();
        let metadata = PaperMetadata {
            arxiv_id: "1706.03762".to_string(),
            requested_arxiv_id: "1706.03762v7".to_string(),
            title: "Attention Is All You Need".to_string(),
            schema_version: PAPER_SCHEMA_VERSION,
            complete: true,
            converter: ARXIV2MD_REQUIREMENT.to_string(),
            source: String::new(),
            source_url: String::new(),
            paper_sha256: sha256_hex(markdown.as_bytes()),
            asset_manifest_schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
        };
        fs::write(
            directory.join("metadata.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();

        let result = fetch_paper(&root, "https://arxiv.org/abs/1706.03762v7").unwrap();
        assert!(result.reused);
        assert_eq!(result.arxiv_id, "1706.03762");
        fs::remove_dir_all(parent).unwrap();
    }

    /// A download failure is a note on the citation, never its undoing: the
    /// entry must land in the bibliography exactly as it would for a work
    /// with no full text at all (see the note on import_reference).
    #[cfg(unix)]
    #[test]
    fn a_citation_survives_a_failed_full_text_download() {
        use std::os::unix::fs::PermissionsExt;
        let parent = std::env::temp_dir().join(format!("lattice-cite-fetch-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let tools = parent.join("tools");
        fs::create_dir_all(&tools).unwrap();
        let bibcite = tools.join("fake-bibcite");
        fs::write(
            &bibcite,
            concat!(
                "#!/bin/sh\n",
                "# invoked as: fake-bibcite add --no-tidy <path> <query>\n",
                "path=\"$3\"\n",
                "cat >> \"$path\" <<'BIB'\n",
                "@article{stub2024,\n",
                "  title = {A Paper Without A Rendering},\n",
                "  eprint = {2401.99999},\n",
                "}\n",
                "BIB\n",
                "printf '{\"key\": \"stub2024\"}\\n'\n",
            ),
        )
        .unwrap();
        let arxiv2md = tools.join("fake-arxiv2md");
        fs::write(
            &arxiv2md,
            concat!(
                "#!/bin/sh\n",
                "echo 'Error: This paper does not have an HTML version available on arXiv.' >&2\n",
                "exit 1\n",
            ),
        )
        .unwrap();
        for tool in [&bibcite, &arxiv2md] {
            fs::set_permissions(tool, fs::Permissions::from_mode(0o755)).unwrap();
        }
        // Process-wide, but nothing else in the suite spawns these tools: the
        // other fetch/list tests are satisfied from on-disk caches.
        std::env::set_var(commands::BIBCITE.override_env, &bibcite);
        std::env::set_var(commands::ARXIV2MD.override_env, &arxiv2md);
        let result = import_reference_with_history(&root, "10.1234/example", HistoryMode::Defer);
        std::env::remove_var(commands::BIBCITE.override_env);
        std::env::remove_var(commands::ARXIV2MD.override_env);

        let result = result.unwrap();
        assert_eq!(result.citation_key.as_deref(), Some("stub2024"));
        assert_eq!(result.arxiv_id, "2401.99999");
        assert!(result.paper_path.is_empty());
        let error = result.fetch_error.expect("the failed download is reported");
        assert!(
            error.contains("does not have an HTML version"),
            "got: {error}"
        );
        let bibliography = fs::read_to_string(root.join("references.bib")).unwrap();
        assert!(bibliography.contains("stub2024"), "got: {bibliography}");
        fs::remove_dir_all(parent).unwrap();
    }

    /// A webpage capture keys its bundle by URL digest; the readers accept
    /// that key, and the bibliography join finds the bundle through the URL
    /// its metadata remembers.
    #[test]
    fn webpage_captures_join_the_bibliography_by_url() {
        let url = "https://example.com/a-blog-post";
        let id = web_reference_id(url);
        assert!(validate_paper_key(&id).is_ok(), "got: {id}");
        assert!(validate_paper_key("web-not-a-digest").is_err());

        let parent = std::env::temp_dir().join(format!("lattice-web-join-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let directory = root.join(".research/papers").join(&id);
        fs::create_dir_all(directory.join("paper_assets")).unwrap();
        let markdown =
            "---\ntitle: \"A Blog Post\"\nsource: \"web\"\n---\n\nThe captured content.\n";
        fs::write(directory.join("paper.md"), markdown).unwrap();
        fs::write(
            directory.join("paper_assets/manifest.json"),
            "{\"schema_version\":1,\"assets\":[]}\n",
        )
        .unwrap();
        let metadata = PaperMetadata {
            arxiv_id: id.clone(),
            requested_arxiv_id: id.clone(),
            title: "A Blog Post".to_string(),
            schema_version: PAPER_SCHEMA_VERSION,
            complete: true,
            converter: FIRECRAWL_CONVERTER.to_string(),
            source: "web".to_string(),
            source_url: url.to_string(),
            paper_sha256: sha256_hex(markdown.as_bytes()),
            asset_manifest_schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
        };
        fs::write(
            directory.join("metadata.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("references.bib"),
            format!(
                "@misc{{blog2024,\n  title = {{A Blog Post}},\n  url = {{{url}}},\n  year = {{2024}}\n}}\n"
            ),
        )
        .unwrap();

        let papers = list_papers(&root).unwrap();
        let entry = papers
            .iter()
            .find(|paper| paper.citation_key.as_deref() == Some("blog2024"))
            .expect("the webpage citation");
        assert_eq!(entry.arxiv_id, id, "joined to its capture: {entry:?}");
        assert!(entry.has_full_text);
        assert!(!entry.has_blog);
        assert_eq!(entry.url.as_deref(), Some(url));
        assert!(read_paper(&root, &id).unwrap().contains("captured content"));
        // The reused-capture check accepts the bundle without refetching.
        let reused = fetch_web_reference(&root, url).unwrap();
        assert!(reused.reused);
        assert_eq!(reused.arxiv_id, id);
        fs::remove_dir_all(parent).unwrap();
    }

    /// A text-layer bundle records anydoc as its converter and carries an
    /// empty asset manifest; revalidation must accept it, or every reopen
    /// would refetch and reconvert the PDF.
    #[test]
    fn accepts_a_pdf_text_layer_bundle() {
        let directory = std::env::temp_dir().join(format!("lattice-pdf-bundle-{}", Uuid::new_v4()));
        fs::create_dir_all(directory.join("paper_assets")).unwrap();
        let markdown = b"---\ntitle: \"A Paper\"\nsource: \"pdf-text-layer\"\n---\n\nBody.\n";
        fs::write(directory.join("paper.md"), markdown).unwrap();
        fs::write(
            directory.join("paper_assets/manifest.json"),
            "{\"schema_version\":1,\"assets\":[]}\n",
        )
        .unwrap();
        let metadata = PaperMetadata {
            arxiv_id: "cs/9901002".to_string(),
            requested_arxiv_id: "cs/9901002".to_string(),
            title: "A Paper".to_string(),
            schema_version: PAPER_SCHEMA_VERSION,
            complete: true,
            converter: ANYDOC_CONVERTER.to_string(),
            source: "arxiv-pdf".to_string(),
            source_url: String::new(),
            paper_sha256: sha256_hex(markdown),
            asset_manifest_schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
        };
        assert_eq!(validate_paper_bundle(&directory, &metadata), Ok(()));
        let unknown = PaperMetadata {
            converter: "anydoc@9.9.9".to_string(),
            ..metadata
        };
        assert!(validate_paper_bundle(&directory, &unknown).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_paper_bundles_with_missing_or_tampered_assets() {
        let directory =
            std::env::temp_dir().join(format!("lattice-paper-assets-{}", Uuid::new_v4()));
        fs::create_dir_all(directory.join("paper_assets")).unwrap();
        let markdown = b"# Paper\n\n![Figure](paper_assets/figure.png)\n";
        fs::write(directory.join("paper.md"), markdown).unwrap();
        let metadata = PaperMetadata {
            arxiv_id: "2401.00001".to_string(),
            requested_arxiv_id: "2401.00001".to_string(),
            title: "Paper".to_string(),
            schema_version: PAPER_SCHEMA_VERSION,
            complete: true,
            converter: ARXIV2MD_REQUIREMENT.to_string(),
            source: String::new(),
            source_url: String::new(),
            paper_sha256: sha256_hex(markdown),
            asset_manifest_schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
        };

        assert!(validate_paper_bundle(&directory, &metadata).is_err());
        fs::write(
            directory.join("paper_assets/manifest.json"),
            r#"{"schema_version":1,"assets":[{"path":"paper_assets/figure.png","sha256":"00","size":3,"type":"image/png"}]}"#,
        )
        .unwrap();
        fs::write(directory.join("paper_assets/figure.png"), b"bad").unwrap();
        assert!(validate_paper_bundle(&directory, &metadata).is_err());

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn rejects_asset_manifest_paths_that_escape_the_paper_bundle() {
        let directory = std::env::temp_dir().join(format!("lattice-paper-path-{}", Uuid::new_v4()));
        fs::create_dir_all(directory.join("paper_assets")).unwrap();
        let markdown = b"# Paper\n";
        fs::write(directory.join("paper.md"), markdown).unwrap();
        fs::write(
            directory.join("paper_assets/manifest.json"),
            r#"{"schema_version":1,"assets":[{"path":"paper_assets/../outside.png","sha256":"00","size":0,"type":"image/png"}]}"#,
        )
        .unwrap();
        let metadata = PaperMetadata {
            arxiv_id: "2401.00001".to_string(),
            requested_arxiv_id: "2401.00001".to_string(),
            title: "Paper".to_string(),
            schema_version: PAPER_SCHEMA_VERSION,
            complete: true,
            converter: ARXIV2MD_REQUIREMENT.to_string(),
            source: String::new(),
            source_url: String::new(),
            paper_sha256: sha256_hex(markdown),
            asset_manifest_schema_version: ASSET_MANIFEST_SCHEMA_VERSION,
        };
        assert!(validate_paper_bundle(&directory, &metadata).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn paper_search_matches_only_titles() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-search-{}", Uuid::new_v4()));
        let root = project::create(&parent, "paper").unwrap();
        let directory = root.join(".research/papers/1706.03762");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("paper.md"),
            "Title: Attention Is All You Need\nThe encoder-free model relies entirely on self-attention.\n",
        )
        .unwrap();
        fs::write(
            directory.join("metadata.json"),
            r#"{"arxivId":"1706.03762","title":"Attention Is All You Need","citationKey":"vaswani2017attention"}"#,
        )
        .unwrap();
        fs::write(
            root.join("references.bib"),
            "@article{vaswani2017attention, title={Attention Is All You Need}, eprint={1706.03762}}\n",
        )
        .unwrap();

        let results = search_papers(&root, "attention need").unwrap();

        assert_eq!(results[0].arxiv_id.as_deref(), Some("1706.03762"));
        assert!(results[0].snippet.is_empty());
        assert!(search_papers(&root, "self-attention").unwrap().is_empty());
        assert!(search_papers(&root, "encoder free").unwrap().is_empty());
        assert!(search_papers(&root, "1706.03762").unwrap().is_empty());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    #[ignore = "requires network access"]
    fn imports_markdown_and_a_real_citation() {
        let parent = std::env::temp_dir().join(format!("lattice-paper-e2e-{}", Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "paper").unwrap();
        let result = import_reference_with_progress(&root, "1706.03762", &|_| {}).unwrap();
        assert_eq!(result.arxiv_id, "1706.03762");
        assert_eq!(result.title, "Attention Is All You Need");
        assert!(root.join(&result.paper_path).exists());
        // --frontmatter now leads the full text with a YAML block.
        assert!(fs::read_to_string(root.join(&result.paper_path))
            .unwrap()
            .starts_with("---"));
        // The alphaXiv overview is fetched and stored as the blog view.
        assert!(root.join(".research/papers/1706.03762/blog.md").exists());
        assert!(!fs::read_to_string(root.join("references.bib"))
            .unwrap()
            .is_empty());
        fs::remove_dir_all(parent).unwrap();
    }
}
