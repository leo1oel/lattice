//! Citations a source supplies itself: the BibTeX block on a project page or
//! blog, a PDF's official landing page, alphaXiv's suggested citation, or —
//! failing those — the page's own metadata. Supplied records keep the
//! publisher's field values and bypass bibcite's resolution.

use super::bibliography::{run_bibcite_input, ScratchBibliography};
use super::citation::{
    normalized_paper_title, paper_titles_match, supplied_citation_key, unused_key,
};
use super::{http_client, is_web_url, read_capped};
use crate::citation_audit::entry_fields;
use crate::firecrawl::ScrapedPage;
use crate::project;
use crate::util::err;
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
    let response = http_client(15)
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
        .map(|c| crate::util::decode_html_entities(&tags.replace_all(&c[1], "")).into_owned())
        .unwrap_or_default();
    let document = Html::parse_document(&html);
    // CVF Open Access pages keep their citation in `.bibref`, which the
    // audit's proceedings check reads too.
    let blocks = Selector::parse("pre, code, .citation, .bibtex, .bibref").unwrap();
    let line_breaks = Regex::new(r"(?i)<br\b[^>]*>").unwrap();
    let text = document
        .select(&blocks)
        .map(|element| {
            let inner = element.inner_html();
            let block = line_breaks.replace_all(&inner, "\n");
            // HTML layout spaces are not BibTeX syntax whitespace. Normalize
            // them after entity decoding, preserving Unicode author names.
            crate::util::decode_html_entities(&tags.replace_all(&block, ""))
                .chars()
                .map(|ch| if ch.is_whitespace() && !ch.is_ascii() { ' ' } else { ch })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    // CVF Open Access titles every page with its repository's name; the
    // paper's own title is its citation_title.
    let paper = Selector::parse(r#"meta[name="citation_title"]"#).unwrap();
    let paper = document.select(&paper).find_map(|meta| meta.value().attr("content"));
    matching_supplied_bibtex(&text, url, &title)
        .or_else(|| matching_supplied_bibtex(&text, url, paper?))
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
    // A webpage's record gets the check's own lookup and cleanup, like any
    // other added record, so Check citations has nothing to add to it.
    let prepared = crate::citation_audit::prepare_supplied(&raw[start..end]);
    let protected = crate::citation_audit::protect_bibtex(&prepared);
    let supplied = protected.as_str();
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
    let unchanged = fields.clone();
    fields.extend(project::parse_bibliography_fields_syntax(entry_body(supplied).unwrap()));
    if fields == unchanged {
        // Nothing to enrich: keep the entry exactly as it is written.
        return Ok((before.to_string(), key, true));
    }
    let body = fields
        .iter()
        .map(|(name, value)| format!("  {name} = {value}"))
        .collect::<Vec<_>>()
        .join(",\n");
    let replacement = format!("{head}{key},\n{body}\n{}", &supplied[supplied.len() - 1..]);
    Ok((format!("{}{replacement}{}", &before[..start], &before[end..]), key, true))
}

#[cfg(test)]
mod tests;
