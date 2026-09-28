//! Citations a source supplies itself: the BibTeX block on a project page or
//! blog, a PDF's official landing page, alphaXiv's suggested citation, or —
//! failing those — the page's own metadata. Supplied records keep the
//! publisher's field values and bypass bibcite's resolution.

use super::bibliography::{run_bibcite_input, ScratchBibliography};
use super::citation::{normalized_paper_title, paper_titles_match, unused_key};
use super::{err, http_client, is_web_url, read_capped, LITERATURE_USER_AGENT};
use crate::citation_audit::entry_fields;
use crate::firecrawl::ScrapedPage;
use crate::project;
use crate::web_metadata::{self, bib_text, bib_url};
use regex::Regex;
use scraper::{Html, Selector};
use std::sync::atomic::AtomicBool;

pub(super) struct WebCitation {
    pub(super) bibtex: String,
    /// The browser-rendered capture, when resolving needed one; the bundle
    /// reuses it instead of scraping again.
    pub(super) page: Option<ScrapedPage>,
}

pub(super) fn resolve_web_citation(url: &str) -> Result<Option<WebCitation>, String> {
    if let Some(id) = crate::alphaxiv::paper_id_from_url(url) {
        let paper = crate::alphaxiv::resolve_paper(&id)?
            .ok_or_else(|| "The alphaXiv paper was not found.".to_string())?;
        return Ok(Some(WebCitation { bibtex: alphaxiv_bibtex(&paper)?, page: None }));
    }
    resolve_web_citation_with(url, fetch_web_html(url), crate::firecrawl::scrape)
}

/// `None` when the page names a DOI, which bibcite resolves better. Static
/// HTML is tried first; only a page without usable metadata spends a scrape.
fn resolve_web_citation_with(
    url: &str, html: Result<String, String>,
    render: impl FnOnce(&str) -> Result<ScrapedPage, String>,
) -> Result<Option<WebCitation>, String> {
    let reason = match html {
        Ok(html) => {
            if let Some(bibtex) = webpage_bibtex(&html, url) {
                return Ok(Some(WebCitation { bibtex, page: None }));
            }
            if web_metadata::has_doi(&html) {
                return Ok(None);
            }
            "The page has no readable citation metadata; it may require JavaScript.".to_string()
        }
        Err(error) => error,
    };
    let mut page = render(url)
        .map_err(|error| format!("{reason}\nBrowser-rendered extraction failed: {error}"))?;
    let title = page.title.as_deref().unwrap_or_default();
    let bibtex = supplied_web_bibtex(&page.html, url)
        .or_else(|| matching_supplied_bibtex(&page.markdown, url, title))
        .map(|raw| supplied_bibtex_with_source(raw, url))
        .or_else(|| web_metadata::citation(&page.html, url))
        .ok_or_else(|| "The rendered page still has no reliable citation metadata. Supply its official BibTeX or DOI instead.".to_string())?;
    if let Some(entry) = project::parse_bibliography(&bibtex).first() {
        page.title = Some(entry.title.clone());
    }
    Ok(Some(WebCitation { bibtex, page: Some(page) }))
}

/// The page's own citation block, else a citation built from its metadata.
fn webpage_bibtex(html: &str, url: &str) -> Option<String> {
    supplied_web_bibtex(html, url)
        .map(|raw| supplied_bibtex_with_source(raw, url))
        .or_else(|| web_metadata::citation(html, url))
}

pub(super) fn fetch_web_html(url: &str) -> Result<String, String> {
    let response = http_client(LITERATURE_USER_AGENT, 15)
        .map_err(err)?
        .get(url)
        .send()
        .map_err(err)?
        .error_for_status()
        .map_err(err)?;
    let bytes = read_capped(response, 4 * 1024 * 1024)
        .map_err(err)?
        .ok_or("The webpage HTML exceeds the 4 MB citation extraction limit.")?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn same_citation_url(left: &str, right: &str) -> bool {
    let normalize = |value: &str| {
        reqwest::Url::parse(value).ok().map(|mut url| {
            url.set_fragment(None);
            let path = url.path().trim_end_matches('/').to_string();
            url.set_path(&path);
            url.to_string()
        })
    };
    normalize(left).is_some_and(|left| Some(left) == normalize(right))
}

/// A code block may cite a related paper rather than the page itself. Require
/// a matching URL (including a plain URL in note), or an exact title when no
/// source URL was supplied, and reject conflicting candidates instead of
/// silently picking the first reference.
fn matching_supplied_bibtex(text: &str, url: &str, title: &str) -> Option<String> {
    let mut candidates = Vec::new();
    for (_, start, end) in project::bibliography_entry_spans(text) {
        let raw = &text[start..end];
        if raw.len() > 64 * 1024 || !raw.ends_with(['}', ')']) {
            continue;
        }
        let Some(entry) = project::parse_bibliography(raw).into_iter().next() else {
            continue;
        };
        let source_url =
            entry.url.or_else(|| entry_fields(raw).remove("note").filter(|note| is_web_url(note)));
        let matches = !entry.title.is_empty()
            && match source_url.as_deref() {
                Some(cited_url) => same_citation_url(cited_url, url),
                None => {
                    !title.is_empty()
                        && normalized_paper_title(&entry.title) == normalized_paper_title(title)
                }
            };
        if matches && !candidates.iter().any(|candidate| candidate == raw) {
            candidates.push(raw.to_string());
        }
    }
    (candidates.len() == 1).then(|| candidates.remove(0))
}

fn supplied_web_bibtex(html: &str, url: &str) -> Option<String> {
    // Only rendered citation blocks count; Next.js hydration scripts can
    // repeat the same entry and arbitrary script strings are not page copy.
    let scripts = Regex::new(r"(?is)<(?:script|style)\b[^>]*>.*?</(?:script|style)\s*>").unwrap();
    let html = scripts.replace_all(html, "");
    let tags = Regex::new(r"(?s)<[^>]*>").unwrap();
    let title = Regex::new(r"(?is)<title\b[^>]*>(.*?)</title\s*>")
        .unwrap()
        .captures(&html)
        .map(|c| html_escape::decode_html_entities(&tags.replace_all(&c[1], "")).into_owned())
        .unwrap_or_default();
    let document = Html::parse_document(&html);
    let blocks = Selector::parse("pre, code, .citation, .bibtex").unwrap();
    let line_breaks = Regex::new(r"(?i)<br\b[^>]*>").unwrap();
    let text = document
        .select(&blocks)
        .map(|element| {
            let inner = element.inner_html();
            let block = line_breaks.replace_all(&inner, "\n");
            // HTML layout spaces are not BibTeX syntax whitespace. Normalize
            // them after entity decoding, preserving Unicode author names.
            html_escape::decode_html_entities(&tags.replace_all(&block, ""))
                .chars()
                .map(|ch| if ch.is_whitespace() && !ch.is_ascii() { ' ' } else { ch })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    matching_supplied_bibtex(&text, url, &title)
}

fn fetch_supplied_web_bibtex(url: &str) -> Option<String> {
    let raw = supplied_web_bibtex(&fetch_web_html(url).ok()?, url)?;
    Some(supplied_bibtex_with_source(raw, url))
}

/// Keep a source identity even when the recommended entry omitted its URL.
fn supplied_bibtex_with_source(raw: String, url: &str) -> String {
    if project::parse_bibliography(&raw).first().is_some_and(|entry| entry.url.is_some()) {
        return raw;
    }
    let (body, close) = raw.split_at(raw.len() - 1);
    format!("{},\n  url = {{{}}}\n{close}", body.trim_end().trim_end_matches(','), bib_url(url))
}

/// The citation for a PDF: one it embeds, else its official landing page's
/// with the PDF as the source, else only what is known for certain.
pub(super) fn pdf_citation_bibtex(markdown: &str, title: &str, url: &str) -> String {
    if let Some(raw) = matching_supplied_bibtex(markdown, url, title) {
        return supplied_bibtex_with_source(raw, url);
    }
    // A labelled, same-origin project URL on the first page is evidence of an
    // official landing page. Never search arbitrary URLs in the references.
    let first_page: String = markdown.chars().take(6000).collect();
    let website = Regex::new(r"(?im)(?:^|\s)(?:\*\*)?(?:Website|Project(?: page)?|Homepage)(?:\*\*)?:\s*(?:\[[^\]]*\]\()?<?(https?://[^\s)>]+)").unwrap();
    let source_origin = reqwest::Url::parse(url).ok().map(|url| url.origin());
    let supplied = website.captures_iter(&first_page).take(3).find_map(|capture| {
        let page_url = &capture[1];
        if Some(reqwest::Url::parse(page_url).ok()?.origin()) != source_origin {
            return None;
        }
        let raw = fetch_supplied_web_bibtex(page_url)?;
        let entry = project::parse_bibliography(&raw).into_iter().next()?;
        (normalized_paper_title(&entry.title) == normalized_paper_title(title)).then_some(raw)
    });
    if let Some(raw) = supplied {
        let key = project::parse_bibliography(&raw).remove(0).key;
        let mut fields = entry_fields(&raw);
        fields.insert("url".to_string(), url.to_string());
        if fields.get("note").is_some_and(|note| note.trim().eq_ignore_ascii_case("Blog post")) {
            fields.remove("note");
        }
        fields.remove("howpublished");
        let fields = fields
            .iter()
            .map(|(name, value)| format!("  {name} = {{{value}}}"))
            .collect::<Vec<_>>()
            .join(",\n");
        return format!("@misc{{{key}pdf,\n{fields}\n}}\n");
    }
    // Missing metadata stays missing. Internal review instructions must never
    // be printed as a bibliographic note in the user's manuscript.
    let key = normalized_paper_title(title)
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(32)
        .collect::<String>();
    format!("@misc{{{key}pdf,\n  title = {{{}}},\n  url = {{{url}}}\n}}\n", bib_text(title))
}

/// The field list of one raw BibTeX entry, between its key's comma and the
/// closing delimiter.
fn entry_body(raw: &str) -> Option<&str> {
    Some(&raw[raw.find(',')? + 1..raw.len() - 1])
}

pub(crate) fn alphaxiv_bibtex(paper: &crate::alphaxiv::Paper) -> Result<String, String> {
    let raw = paper.citation_bibtex.as_deref().unwrap_or("").trim();
    let entries = project::parse_bibliography(raw);
    let entry = entries
        .first()
        .filter(|entry| entries.len() == 1 && paper_titles_match(&entry.title, &paper.title))
        .ok_or_else(|| "alphaXiv did not supply a matching citation.".to_string())?;
    let (head, body) =
        raw.split_once(',').ok_or_else(|| "Invalid alphaXiv citation.".to_string())?;
    let body = body.strip_suffix('}').ok_or_else(|| "Invalid alphaXiv citation.".to_string())?;
    let mut fields = project::parse_bibliography_fields_syntax(body);
    // Always attach the bundle to this AlphaXiv work, even when its suggested
    // citation points to an external announcement. Preserve the other fields.
    fields.insert("url".into(), format!("{{https://www.alphaxiv.org/abs/{}}}", paper.universal_id));
    if entry.year.is_empty() {
        if let Some(date) = paper.publication_date.and_then(chrono::DateTime::from_timestamp_millis)
        {
            fields.insert("year".into(), format!("{{{}}}", date.format("%Y")));
        }
    }
    let fields = fields.iter().map(|(key, value)| format!("  {key} = {value},"));
    Ok(format!("{head},\n{}\n}}\n", fields.collect::<Vec<_>>().join("\n")))
}

/// Same key policy as bibcite-cli 0.6.10's normalize.make_key / _finalize.
/// Supplied BibTeX bypasses that policy upstream, so apply it here without
/// round-tripping publisher fields through bibcite's lossy normalization.
pub(super) fn supplied_citation_key(raw: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    const STOPWORDS: &str = "i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself they them their theirs themselves what which who whom this that these those am is are was were be been being have has had having do does did doing a an the and but if or because as until while of at by for with about against between into through during before after above below to from up down in out on off over under again further then once here there when where why how all any both each few more most other some such no nor not only own same so than too very s t can will just don should now";
    let (_, start, end) = project::bibliography_entry_spans(raw).into_iter().next().unwrap();
    let fields = entry_fields(&raw[start..end]);
    let hash = |value: &str| -> String {
        value
            .nfkd()
            .filter(char::is_ascii)
            .flat_map(char::to_lowercase)
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
            .collect()
    };
    let field = |name: &str| fields.get(name).map(String::as_str).filter(|value| !value.is_empty());
    let separator = Regex::new(r"(?i)\s+and\s+").unwrap();
    let author = field("author").unwrap_or("anonymous");
    let first = separator.split(author.trim()).next().unwrap().trim().trim_matches(['{', '}']);
    let surname = first
        .split_once(',')
        .map(|(last, _)| last)
        .unwrap_or_else(|| first.split_whitespace().last().unwrap_or("anon"));
    let surname = hash(surname);
    let year = field("year").unwrap_or("XXXX");
    let words: Vec<String> = fields
        .get("title")
        .map(String::as_str)
        .unwrap_or_default()
        .split_whitespace()
        .map(hash)
        .filter(|word| !word.is_empty())
        .collect();
    let word = words
        .iter()
        .find(|word| !STOPWORDS.split_whitespace().any(|stop| stop == word.as_str()))
        .or_else(|| words.first())
        .map(String::as_str)
        .unwrap_or("paper");
    format!("{}{year}{word}", if surname.is_empty() { "anon" } else { &surname })
}

/// Let bibcite validate/normalize the supplied record without tidying the
/// user's bibliography. Merge by URL here: bibcite's title-only dedupe would
/// otherwise collapse a report and its identically titled blog into one entry.
/// Returns the new bibliography, the entry's key, and whether it already existed.
pub(super) fn merge_supplied_bibtex(
    before: &str, raw: &str,
) -> Result<(String, String, bool), String> {
    let scratch = ScratchBibliography::new("lattice-supplied-cite", None)?;
    run_bibcite_input(&scratch.path, raw, true, &AtomicBool::new(false))?;
    let validated = project::parse_bibliography(&scratch.read()?)
        .into_iter()
        .next()
        .ok_or_else(|| "bibcite did not return a citation.".to_string())?;
    // Even --no-tidy drops fields such as month during bibcite's internal
    // record conversion. Use it to validate the entry and key, but keep
    // the publisher's original field values rather than that lossy output.
    let entries = project::parse_bibliography(before);
    let existing = entries.iter().find(|item| {
        validated
            .url
            .as_deref()
            .zip(item.url.as_deref())
            .is_some_and(|(a, b)| same_citation_url(a, b))
    });
    let key = match existing {
        Some(item) => item.key.clone(),
        None => unused_key(&entries, &supplied_citation_key(raw)),
    };
    let (_, start, end) = project::bibliography_entry_spans(raw).into_iter().next().unwrap();
    let supplied = &raw[start..end];
    let opening = supplied.find(['{', '(']).unwrap();
    let comma = supplied.find(',').unwrap();
    let head = &supplied[..opening + 1];
    let old_span = existing.and_then(|item| {
        project::bibliography_entry_spans(before)
            .into_iter()
            .find(|(key, _, _)| key.eq_ignore_ascii_case(&item.key))
    });
    let Some((_, start, end)) = old_span else {
        let bibliography = format!("{before}\n{head}{key}{}\n", &supplied[comma..]);
        return Ok((bibliography, key, existing.is_some()));
    };
    // Re-import may enrich fields, but missing metadata must not erase
    // information the user already supplied. Remove only our old internal
    // note, not legitimate publisher/user notes.
    let mut fields =
        project::parse_bibliography_fields_syntax(entry_body(&before[start..end]).unwrap());
    if fields.get("note").is_some_and(|note| {
        note.trim_matches(['{', '}', '"'])
            == "Imported from PDF; bibliographic metadata needs review"
    }) {
        fields.remove("note");
    }
    fields.extend(project::parse_bibliography_fields_syntax(entry_body(supplied).unwrap()));
    let body = fields
        .iter()
        .map(|(name, value)| format!("  {name} = {value}"))
        .collect::<Vec<_>>()
        .join(",\n");
    let replacement = format!("{head}{key},\n{body}\n{}", &supplied[supplied.len() - 1..]);
    Ok((format!("{}{replacement}{}", &before[..start], &before[end..]), key, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::bundle::fetch_web_bundle;
    use crate::papers::library::read_paper;
    #[cfg(unix)]
    use crate::papers::test_support::{fake_raw_bibcite, tool_lock, ToolOverride};
    use crate::papers::test_support::{serve_once, TestProject};
    #[cfg(unix)]
    use crate::test_support::TempDir;

    const SUPPLIED_BLOG: &str = "@misc{mirros2026sspace,\n title={S-Space: Exploring Spatial Workspace in Multimodal Models},\n author={{MirroS Team}},\n year={2026},\n month={September},\n url={https://mirros.ai/blog/s-space},\n note={Blog post}\n}";

    #[test]
    fn alphaxiv_citation_keeps_fields_and_supplies_a_stable_identity_and_missing_year() {
        let mut paper = crate::alphaxiv::Paper {
            version_id: "version-id".into(),
            universal_id: "2609.report".into(),
            title: "A Report".into(),
            citation_bibtex: Some("@misc{report, title={A Report}, author={{Research Team}}, url={https://example.org/announcement}, note={Keep {nested} braces}}".into()),
            publication_date: Some(1789948800000),
        };
        let raw = alphaxiv_bibtex(&paper).unwrap();
        let entry = project::parse_bibliography(&raw).remove(0);
        assert_eq!(entry.url.as_deref(), Some("https://www.alphaxiv.org/abs/2609.report"));
        assert_eq!(entry.year, "2026");
        assert!(raw.contains("note = {Keep {nested} braces}"));
        paper.title = "A different report".into();
        assert!(alphaxiv_bibtex(&paper).is_err());
    }

    #[test]
    fn supplied_keys_follow_bibcite_arxiv_policy() {
        for (author, year, title, expected) in [
            (
                "Ashish Vaswani and Noam Shazeer",
                "2017",
                "Attention Is All You Need",
                "vaswani2017attention",
            ),
            (
                "García, María AND Other, Author",
                "2025",
                "The Éléphant in the Room",
                "garcia2025elephant",
            ),
            ("{Thinking Machines Lab}", "2026", "Introducing Inkling-Small", "lab2026introducing"),
            ("", "2026", "GLM-5.3: Frontier Coding", "anonymous2026glm53"),
            ("", "", "The and a", "anonymousXXXXthe"),
            ("李", "2024", "研究", "anon2024paper"),
        ] {
            let raw = format!(
                "@misc{{publisherKey,author={{{author}}},year={{{year}}},title={{{title}}}}}\n"
            );
            assert_eq!(supplied_citation_key(&raw), expected);
        }
    }

    #[test]
    fn supplied_bibtex_prefers_the_page_itself_not_its_references_or_scripts() {
        let html = format!("<title>Publisher title</title><script><pre>@misc{{noise,title={{Wrong}},url={{https://mirros.ai/blog/s-space}}}}</pre></script><pre>@article{{other,title={{Other work}},url={{https://example.org/other}}}}</pre><pre><code>{SUPPLIED_BLOG}</code></pre>");
        let raw = supplied_web_bibtex(&html, "https://mirros.ai/blog/s-space#citation").unwrap();
        assert_eq!(raw, SUPPLIED_BLOG);
        let conflict = format!("{html}<code>{}</code>", SUPPLIED_BLOG.replace("2026", "2025"));
        assert!(supplied_web_bibtex(&conflict, "https://mirros.ai/blog/s-space").is_none());
        let highlighted = "<title>A &amp; B</title><pre><code><span>@misc</span>{a,title={A &amp; B},author={{A Team}}}</code></pre>";
        assert_eq!(
            supplied_web_bibtex(highlighted, "https://example.org/a").as_deref(),
            Some("@misc{a,title={A & B},author={{A Team}}}")
        );
        let broken = "<code>@misc{broken,title={Missing braces";
        assert!(supplied_web_bibtex(broken, "https://example.org/").is_none());
    }

    #[test]
    fn supplied_web_citations_handle_html_spaces_and_note_urls() {
        let html = "<title>Atlas: A World Model | World Labs</title><pre><code>@article{atlas,<br>&nbsp;author={World Labs Team},<br>\u{202f}title={Atlas: A World Model},<br> year={2026}, note={https://www.worldlabs.ai/blog/atlas}}</code></pre>";
        let raw = supplied_web_bibtex(html, "https://www.worldlabs.ai/blog/atlas#citation")
            .expect("a matching note URL identifies the official citation despite the site suffix");
        assert!(!raw.contains(['\u{a0}', '\u{202f}']));
        assert!(raw.contains("author={World Labs Team}"));
        let raw = supplied_bibtex_with_source(raw, "https://www.worldlabs.ai/blog/atlas");
        assert!(raw.contains("url = {https://www.worldlabs.ai/blog/atlas}"));
        assert!(raw.contains("note={https://www.worldlabs.ai/blog/atlas}"));
        // A cited reference must not become the page's citation merely because
        // its title matches; an explicit conflicting source takes precedence.
        let other = "<title>Atlas: A World Model</title><pre>@article{other,title={Atlas: A World Model},note={https://example.org/other}}</pre>";
        assert!(supplied_web_bibtex(other, "https://www.worldlabs.ai/blog/atlas").is_none());
        let conflict = html.replace("year={2026}", "url={https://example.org/other},year={2026}");
        assert!(supplied_web_bibtex(&conflict, "https://www.worldlabs.ai/blog/atlas").is_none());
    }

    #[test]
    fn webpage_citation_reads_official_nested_div_before_metadata() {
        let url = "https://generalistai.com/blog/gen-1.5";
        let html = "<meta property='og:title' content='Wrong site suffix'><div class='citation monospace'>@article&lbrace;generalist2026gen15,<br><span>author={Generalist Team},title={<span>GEN-1.5</span>: One-Shot Learners},year={2026},note={https://generalistai.com/blog/gen-1.5},</span><br>&rbrace;</div>";
        let bib = webpage_bibtex(html, url).unwrap();
        assert!(bib.starts_with("@article{generalist2026gen15,"));
        assert!(bib.contains("title={GEN-1.5: One-Shot Learners}"));
        assert!(bib.contains("url = {https://generalistai.com/blog/gen-1.5}"));
    }

    #[cfg(unix)]
    #[test]
    fn supplied_citations_keep_existing_keys_and_do_not_merge_report_with_blog() {
        let _lock = tool_lock();
        let tools = TempDir::new("papers");
        let _bibcite = ToolOverride::set(&crate::commands::BIBCITE, &fake_raw_bibcite(&tools));
        let (fresh, key, _) = merge_supplied_bibtex("", SUPPLIED_BLOG).unwrap();
        assert_eq!(key, "team2026sspace");
        assert_eq!(fresh.trim(), SUPPLIED_BLOG.replacen("mirros2026sspace", "team2026sspace", 1));
        let (unchanged, key, exists) = merge_supplied_bibtex(SUPPLIED_BLOG, SUPPLIED_BLOG).unwrap();
        assert!(exists);
        assert_eq!(key, "mirros2026sspace");
        assert!(unchanged.contains("month = {September}"));
        let before = "@misc{team2026sspace,title={S-Space: Exploring Spatial Workspace in Multimodal Models},url={https://mirros.ai/report/s-space.pdf}}\n";
        let (added, key, existing) = merge_supplied_bibtex(before, SUPPLIED_BLOG).unwrap();
        assert!(!existing);
        assert_eq!(key, "team2026sspace-2");
        assert!(added.starts_with(before));
        assert_eq!(project::parse_bibliography(&added).len(), 2);
        assert!(added.contains("author={{MirroS Team}}"));
        assert!(added.contains("note={Blog post}"));
        let (_, key, existing) = merge_supplied_bibtex(&added, SUPPLIED_BLOG).unwrap();
        assert!(existing);
        assert_eq!(key, "team2026sspace-2");
        let old = "@misc{keepMyKey,title={Old},author={{User Team}},year={2024},url={https://example.org/a.pdf},note={Imported from PDF; bibliographic metadata needs review},keywords={keep this}}";
        let raw = "@misc{newKey,title={New},url={https://example.org/a.pdf}}";
        let (repaired, key, existing) = merge_supplied_bibtex(old, raw).unwrap();
        assert!(existing);
        assert_eq!(key, "keepMyKey");
        for kept in ["author = {{User Team}}", "year = {2024}", "keywords = {keep this}"] {
            assert!(repaired.contains(kept), "{kept}");
        }
        assert!(!repaired.contains("needs review"));
        let old = "@misc{keep,title={Study},url={https://example.org/macro},month=jul,journal=publisher,howpublished=\"Blog\"}";
        let update = "@misc{new,title={Study},url={https://example.org/macro},year={2026}}";
        let (merged, key, _) = merge_supplied_bibtex(old, update).unwrap();
        assert_eq!(key, "keep");
        for kept in
            ["month = jul,", "journal = publisher,", "howpublished = \"Blog\",", "year = {2026}"]
        {
            assert!(merged.contains(kept), "{kept}");
        }
    }

    #[test]
    fn pdf_citation_borrows_official_fields_but_keeps_the_pdf_source() {
        let title = "S-Space: Exploring Spatial Workspace in Multimodal Models";
        let page = format!(
            "<title>{title}</title><pre>{}</pre>",
            SUPPLIED_BLOG.replace("url={https://mirros.ai/blog/s-space},", "")
        );
        let (page_url, server) = serve_once(page.into_bytes());
        let pdf_url =
            reqwest::Url::parse(&page_url).unwrap().join("/original.pdf").unwrap().to_string();
        let raw = pdf_citation_bibtex(
            &format!("# {title}\n\nDate:September 7, 2026 Website:[{page_url}]({page_url}) Code:https://example.org/code\n"),
            title,
            &pdf_url,
        );
        server.join().unwrap();
        for expected in [
            "author = {{MirroS Team}}",
            "year = {2026}",
            "month = {September}",
            &format!("url = {{{pdf_url}}}"),
        ] {
            assert!(raw.contains(expected), "{expected}: {raw}");
        }
        assert!(!raw.contains("Blog post"));
        let plain = "https://example.org/plain.pdf";
        let fallback =
            pdf_citation_bibtex("# Plain PDF\n\nNo supplied citation.", "Plain PDF", plain);
        assert!(fallback.contains("url = {https://example.org/plain.pdf}"));
        assert!(!fallback.contains("note"));
        assert!(!fallback.contains("year"));
        let embedded = pdf_citation_bibtex(
            "@misc{official,title={Plain PDF},author={{Example Team}},year={2025}}",
            "Plain PDF",
            plain,
        );
        assert!(embedded.contains("url = {https://example.org/plain.pdf}"));
        assert!(embedded.contains("author={{Example Team}}"));
        assert!(embedded.contains("year={2025}"));
    }

    #[test]
    fn webpage_citation_resolver_uses_rendered_metadata_and_reuses_capture() {
        let url = "https://example.org/js-page";
        let html = "<meta property='og:title' content='Rendered study'><meta name='authors' content='Ada One,Bea Two'><meta property='article:published_time' content='2026-09-02'>";
        let markdown =
            "# Rendered study\n\n".to_string() + &"Actual captured research content. ".repeat(15);
        let result =
            resolve_web_citation_with(url, Ok("<div id='root'></div>".into()), |requested| {
                assert_eq!(requested, url);
                Ok(ScrapedPage {
                    html: html.into(),
                    title: Some("Rendered study".into()),
                    markdown: markdown.clone(),
                })
            })
            .unwrap()
            .unwrap();
        assert!(result.bibtex.contains("Ada One and Bea Two"));
        assert!(result.bibtex.contains("year = {2026}"));
        let project = TestProject::new("");
        let root = &project.root;
        let fetched = fetch_web_bundle(root, url, result.page, &AtomicBool::new(false)).unwrap();
        assert!(read_paper(root, &fetched.arxiv_id)
            .unwrap()
            .contains("Actual captured research content."));
        // No supplied page is necessary on the second visit, and no network
        // scrape occurs: the first render already populated the complete cache.
        assert!(crate::papers::fetch_web_reference(root, url).unwrap().reused);

        let static_page = resolve_web_citation_with(url, Ok(html.into()), |_| {
            panic!("static metadata must not spend a scrape")
        });
        assert!(static_page.unwrap().unwrap().page.is_none());
        let failure = resolve_web_citation_with(url, Err("HTTP 567".into()), |_| {
            Err("blocked after rendering".into())
        })
        .err()
        .unwrap();
        assert!(failure.contains("HTTP 567"));
        assert!(failure.contains("blocked after rendering"));
        let doi_page =
            "<meta name='citation_doi' content='10.1/example'><title>Publication</title>";
        let doi = resolve_web_citation_with(url, Ok(doi_page.into()), |_| {
            panic!("DOI resolution must not scrape")
        });
        assert!(doi.unwrap().is_none());
    }

    #[test]
    #[ignore = "requires network access and bibcite"]
    fn supplied_blog_live_s_space() {
        let raw = fetch_supplied_web_bibtex("https://mirros.ai/blog/s-space").unwrap();
        let (bib, key, _) = merge_supplied_bibtex("", &raw).unwrap();
        let entry = project::parse_bibliography(&bib).remove(0);
        assert_eq!(key, "team2026sspace");
        assert_eq!(entry.authors, "MirroS Team");
        assert_eq!(entry.year, "2026");
        assert!(bib.contains("September"));
        assert!(bib.contains("Blog post"));
        assert_eq!(entry.url.as_deref(), Some("https://mirros.ai/blog/s-space"));
        eprintln!("{bib}");
    }

    #[test]
    #[ignore = "requires network access and bibcite"]
    fn supplied_web_citations_live_workspace_and_atlas() {
        for (url, key, journal, author) in [
            (
                "https://transformer-circuits.pub/2026/workspace/index.html",
                "gurnee2026verbalizable",
                "Transformer Circuits Thread",
                "Gurnee, Wes",
            ),
            (
                "https://www.worldlabs.ai/blog/atlas",
                "team2026atlas",
                "World Labs Blog",
                "World Labs Team",
            ),
        ] {
            let raw = fetch_supplied_web_bibtex(url).expect(url);
            let (bib, actual_key, _) = merge_supplied_bibtex("", &raw).expect(url);
            let entry = project::parse_bibliography(&bib).remove(0);
            assert_eq!(actual_key, key);
            assert!(bib.starts_with("\n@article{"), "{bib}");
            assert!(bib.contains(author), "{bib}");
            assert!(bib.contains(journal), "{bib}");
            assert_eq!(entry.year, "2026");
            assert_eq!(entry.url.as_deref(), Some(url));
            eprintln!("{bib}");
        }
    }

    #[test]
    #[ignore = "requires network access and bibcite; set LATTICE_TEST_CITATION_URL"]
    fn webpage_citation_live_requested_url() {
        let url = std::env::var("LATTICE_TEST_CITATION_URL").unwrap();
        let result = resolve_web_citation(&url).unwrap().unwrap();
        let (bib, _, _) = merge_supplied_bibtex("", &result.bibtex).unwrap();
        eprintln!("{bib}");
        if std::env::var_os("LATTICE_TEST_FULL_WEB_IMPORT").is_some() {
            let project = TestProject::new("");
            let fetched =
                fetch_web_bundle(&project.root, &url, result.page, &AtomicBool::new(false))
                    .unwrap();
            let markdown = read_paper(&project.root, &fetched.arxiv_id).unwrap();
            assert!(markdown.len() > 1000, "captured article is unexpectedly short");
            assert!(crate::papers::fetch_web_reference(&project.root, &url).unwrap().reused);
            eprintln!("Captured {} bytes of Markdown; repeat import reused cache.", markdown.len());
        }
        assert_eq!(project::parse_bibliography(&bib).remove(0).url.as_deref(), Some(url.as_str()));
    }
}
