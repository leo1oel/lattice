//! Deterministic webpage citation metadata. Values come from the publisher;
//! missing names and dates stay missing rather than being inferred from a URL.
use crate::papers::collapse_whitespace as text;
use scraper::{ElementRef, Html, Selector};
use serde_json::Value;
use std::collections::BTreeMap;

/// BibTeX-escape free text.
pub(crate) fn bib_text(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            '\\' => "\\textbackslash{}".to_string(),
            '{' => "\\textbraceleft{}".to_string(),
            '}' => "\\textbraceright{}".to_string(),
            '&' | '%' | '$' | '#' | '_' => format!("\\{ch}"),
            '^' => "\\textasciicircum{}".to_string(),
            '~' => "\\textasciitilde{}".to_string(),
            _ => ch.to_string(),
        })
        .collect()
}

/// A URL as a BibTeX field value: the characters BibTeX would parse are
/// percent-encoded instead.
pub(crate) fn bib_url(url: &str) -> String {
    url.replace('{', "%7B").replace('}', "%7D").replace('\\', "%5C")
}

/// Every non-empty `<meta>` content, whitespace-collapsed and keyed by the
/// lowercased value of the first attribute in `keys` the tag carries.
pub(crate) fn meta_values(document: &Html, keys: &[&str]) -> BTreeMap<String, Vec<String>> {
    let mut meta: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for element in document.select(&Selector::parse("meta").unwrap()) {
        let name = keys.iter().find_map(|key| element.value().attr(key));
        if let (Some(name), Some(content)) = (name, element.value().attr("content")) {
            let content = text(content);
            if !content.is_empty() {
                meta.entry(name.to_lowercase()).or_default().push(content);
            }
        }
    }
    meta
}

fn element_text(element: ElementRef) -> String {
    text(&element.text().collect::<String>())
}

fn first_text(document: &Html, selector: &str) -> Option<String> {
    document.select(&Selector::parse(selector).unwrap()).next().map(element_text)
}

/// The first `<h1>` that reads exactly `title`.
fn headline<'a>(document: &'a Html, title: &str) -> Option<ElementRef<'a>> {
    document.select(&Selector::parse("h1").unwrap()).find(|heading| element_text(*heading) == title)
}

fn year(value: &str) -> Option<String> {
    // Ignore sentinel values such as Runway's publication_date="undefined".
    let pattern = regex::Regex::new(r"(?i)^(?:(\d{4})(?:-\d{2}(?:-\d{2})?(?:[T ].*)?)?|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(?:\d{1,2},?\s+)?(\d{4}))$").unwrap();
    let capture = pattern.captures(value.trim())?;
    let year = capture.get(1).or_else(|| capture.get(2))?.as_str();
    ("1000"..="2999").contains(&year).then(|| year.to_string())
}

fn article_nodes<'a>(value: &'a Value, nodes: &mut Vec<&'a Value>) {
    if let Some(items) = value.as_array() {
        for item in items {
            article_nodes(item, nodes);
        }
        return;
    }
    let is_article = |kind: &str| {
        matches!(
            kind,
            "Article" | "NewsArticle" | "BlogPosting" | "TechArticle" | "ScholarlyArticle"
        )
    };
    if value.get("@type").is_some_and(|kind| {
        kind.as_str().is_some_and(is_article)
            || kind
                .as_array()
                .is_some_and(|kinds| kinds.iter().filter_map(Value::as_str).any(is_article))
    }) {
        nodes.push(value);
    }
    if let Some(graph) = value.get("@graph") {
        article_nodes(graph, nodes);
    }
}

/// A JavaScript application can expose only its generic site title before
/// rendering (for example "Tencent Hy"). That is not the article title.
fn is_unrendered_app(document: &Html) -> bool {
    if document.select(&Selector::parse("script[src]").unwrap()).next().is_none() {
        return false;
    }
    let body_chars = document
        .select(&Selector::parse("body").unwrap())
        .flat_map(|body| body.descendants())
        .filter(|node| {
            !node.ancestors().filter_map(ElementRef::wrap).any(|ancestor| {
                matches!(
                    ancestor.value().name(),
                    "script" | "style" | "noscript" | "nav" | "footer"
                )
            })
        })
        .filter_map(|node| node.value().as_text())
        .flat_map(|value| value.chars())
        .filter(|ch| !ch.is_whitespace())
        .take(200)
        .count();
    body_chars < 200
}

/// The JSON-LD article this page is about: the one whose URL is the page's,
/// or, without a URL, whose headline is the page title.
fn page_article(document: &Html, url: &str, title: &str) -> Option<Value> {
    let schemas: Vec<Value> = document
        .select(&Selector::parse("script[type='application/ld+json']").unwrap())
        // Serializing inner_html escapes ampersands in JSON string values.
        // Script text is already the original JSON; do not HTML-encode it.
        .filter_map(|element| serde_json::from_str(&element.text().collect::<String>()).ok())
        .collect();
    let mut articles = Vec::new();
    for schema in &schemas {
        article_nodes(schema, &mut articles);
    }
    let canonical = |value: &str| {
        reqwest::Url::parse(value).ok().map(|mut u| {
            u.set_fragment(None);
            u.to_string().trim_end_matches('/').to_string()
        })
    };
    let article = articles.into_iter().find(|article| {
        let source = article.get("url").and_then(Value::as_str).or_else(|| {
            article
                .get("mainEntityOfPage")
                .and_then(|v| v.as_str().or_else(|| v.get("@id").and_then(Value::as_str)))
        });
        match source {
            Some(source) => canonical(source).is_some_and(|source| Some(source) == canonical(url)),
            None => article
                .get("headline")
                .and_then(Value::as_str)
                .is_some_and(|headline| text(headline) == title),
        }
    });
    article.cloned()
}

/// JSON-LD `author` names; an organization is braced so BibTeX keeps it whole.
fn json_ld_authors(value: &Value) -> Vec<String> {
    let values: Vec<&Value> =
        value.as_array().map(|items| items.iter().collect()).unwrap_or_else(|| vec![value]);
    values
        .into_iter()
        .filter_map(|value| {
            let name = value.as_str().or_else(|| value.get("name").and_then(Value::as_str))?;
            let name = bib_text(&text(name));
            let organization = value.get("@type").and_then(Value::as_str) == Some("Organization");
            Some(if organization { format!("{{{name}}}") } else { name })
        })
        .collect()
}

/// None means that a scholarly resolver owns the page (DOI), or that there
/// is no usable title and the caller must try browser-rendered extraction.
pub(crate) fn citation(html: &str, url: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let meta = meta_values(&document, &["name", "property"]);
    // Do not downgrade a journal publication into an unverified blog citation.
    if meta.contains_key("citation_doi") || is_unrendered_app(&document) {
        return None;
    }
    let first = |names: &[&str]| {
        names.iter().find_map(|name| meta.get(*name).and_then(|values| values.first()).cloned())
    };
    let mut title = first(&["citation_title", "og:title", "twitter:title"])
        // Tencent's rendered article cover is a div; its h1 elements are
        // section headings, and the browser title is only the site name.
        .or_else(|| first_text(&document, "[itemprop='headline'], .hy-md-cover-card__title"))
        .or_else(|| first_text(&document, "h1"))
        .or_else(|| first_text(&document, "title"))
        .filter(|value| !value.is_empty())?;
    if matches!(
        title.to_lowercase().as_str(),
        "access denied" | "just a moment..." | "robot check" | "403 forbidden" | "page not found"
    ) {
        return None;
    }
    let article = page_article(&document, url, &title);
    if let Some(headline) = article.as_ref().and_then(|a| a.get("headline")).and_then(Value::as_str)
    {
        if !headline.trim().is_empty() {
            title = text(headline);
        }
    }

    // A rendered article may expose only a visual byline, not meta tags.
    // Keep it within the matching headline's container to avoid related posts.
    let byline = headline(&document, &title)
        .and_then(|heading| heading.parent())
        .and_then(ElementRef::wrap)
        .and_then(|header| header.select(&Selector::parse(".byline").unwrap()).next());
    let listed: Option<Vec<String>> = if let Some(values) = meta.get("citation_author") {
        Some(values.iter().map(|name| bib_text(name)).collect())
    } else if let Some(value) = first(&["authors", "article-author"]) {
        // Some publishers list every byline author here but only the first
        // author in JSON-LD. Preserve the explicit complete list.
        let names = value.split(',').map(text).filter(|name| !name.is_empty());
        Some(names.map(|name| bib_text(&name)).collect())
    } else {
        article.as_ref().and_then(|article| article.get("author")).map(json_ld_authors)
    };
    let non_empty = |names: &Vec<String>| !names.is_empty();
    let authors = listed
        .filter(non_empty)
        .or_else(|| Some(vec![bib_text(&first(&["author"])?)]))
        .or_else(|| {
            let names = Selector::parse("b, strong, [rel='author']").unwrap();
            let names = byline?.select(&names).map(element_text).filter(|name| !name.is_empty());
            Some(names.map(|name| bib_text(&name)).collect()).filter(non_empty)
        })
        .or_else(|| {
            let publisher = first(&["og:site_name"])
                .or_else(|| {
                    let name = article.as_ref()?.pointer("/publisher/name")?.as_str()?;
                    Some(text(name))
                })
                .or_else(|| {
                    // A site suffix is publisher evidence only when the rest of the
                    // HTML title exactly matches the independently extracted headline.
                    let browser_title = first_text(&document, "title")?;
                    let suffix = browser_title.strip_prefix(&title)?;
                    [" | ", " \\ ", " — ", " – ", " - "]
                        .iter()
                        .find_map(|separator| suffix.strip_prefix(separator))
                        .map(text)
                        .filter(|name| !name.is_empty() && name.len() <= 80)
                })?;
            Some(vec![format!("{{{}}}", bib_text(&publisher))])
        })
        .unwrap_or_default();
    let published = [
        "citation_publication_date",
        "article:published_time",
        "published_time",
        "date",
        "datepublished",
    ]
    .iter()
    .filter_map(|name| meta.get(*name))
    .flatten()
    .find_map(|value| year(value))
    .or_else(|| {
        article.as_ref().and_then(|a| a.get("datePublished")).and_then(Value::as_str).and_then(year)
    })
    .or_else(|| {
        document
            .select(&Selector::parse("time, [class*='date'], [class*='Date']").unwrap())
            .find_map(|element| {
                if element
                    .ancestors()
                    .filter_map(ElementRef::wrap)
                    .chain(std::iter::once(element))
                    .any(|ancestor| {
                        matches!(ancestor.value().name(), "footer" | "nav")
                            || ancestor.value().attr("class").is_some_and(|class| {
                                let class = class.to_lowercase();
                                class.contains("updated") || class.contains("modified")
                            })
                    })
                {
                    return None;
                }
                year(element.value().attr("datetime").unwrap_or_default())
                    .or_else(|| year(&element_text(element)))
            })
    })
    .or_else(|| {
        let label = element_text(byline?);
        year(label.rsplit('·').next()?.trim())
    })
    .or_else(|| {
        // Some article headers put an unlabeled date immediately before the
        // headline. Require the matching headline and a date-only prefix,
        // rather than scanning arbitrary body text or copyright notices.
        let heading = headline(&document, &title)?;
        let label = element_text(heading.prev_siblings().find_map(ElementRef::wrap)?);
        year(label.split('·').next()?.trim())
    });
    let key: String = title
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(40)
        .flat_map(char::to_lowercase)
        .collect();
    let mut fields = vec![format!("  title = {{{}}}", bib_text(&title))];
    if !authors.is_empty() {
        fields.push(format!("  author = {{{}}}", authors.join(" and ")));
    }
    if let Some(ref year) = published {
        fields.push(format!("  year = {{{year}}}"));
    }
    fields.push(format!("  url = {{{}}}", bib_url(url)));
    Some(format!(
        "@misc{{{}{},\n{}\n}}",
        if key.is_empty() { "webpage" } else { &key },
        published.unwrap_or_default(),
        fields.join(",\n")
    ))
}

pub(crate) fn has_doi(html: &str) -> bool {
    Html::parse_document(html)
        .select(
            &Selector::parse("meta[name='citation_doi' i], meta[property='citation_doi' i]")
                .unwrap(),
        )
        .next()
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visual_byline_supplies_authors_and_year_without_affiliations_or_related_posts() {
        let html = "<title>Study</title><header><h1>Study</h1><p>Introduction</p><div class='byline'><b>Bojie Li</b> (Pine AI) · <b>Noah Shi</b> (University of Washington) · 2026</div></header><aside><div class='byline'><b>Wrong Author</b> · 2025</div></aside>";
        let bib = citation(html, "https://example.org/study/#idea").unwrap();
        assert!(bib.contains("author = {Bojie Li and Noah Shi}"), "{bib}");
        assert!(bib.contains("year = {2026}"));
        assert!(!bib.contains("Pine AI"));
        assert!(!bib.contains("Wrong Author"));
        let html = html.replace("<div class='byline'><b>Bojie Li</b> (Pine AI) · <b>Noah Shi</b> (University of Washington) · 2026</div>", "");
        let bib = citation(&html, "https://example.org/study/").unwrap();
        assert!(!bib.contains("author ="));
        assert!(!bib.contains("year ="));
    }

    #[test]
    fn rendered_article_headers_override_section_headings_and_capture_adjacent_dates() {
        let bib = citation("<title>Tencent Hy</title><div class='hy-md-cover-card__date'>August 28, 2026</div><div class='hy-md-cover-card__title'>Introducing Hy4 preview</div><h1>A new flagship generation</h1>", "https://hy.tencent.ai/research/hy4-preview").unwrap();
        assert!(bib.contains("title = {Introducing Hy4 preview}"));
        assert!(bib.contains("year = {2026}"));
        let bib = citation("<title>GLM research</title><div>2026-08-14 · Research</div><h1>GLM research</h1><footer>2027</footer>", "https://z.ai/blog/research").unwrap();
        assert!(bib.contains("year = {2026}"));
        let bib = citation(
            "<title>GLM research</title><div>Updated 2026-08-14</div><h1>GLM research</h1>",
            "https://z.ai/blog/research",
        )
        .unwrap();
        assert!(!bib.contains("year ="));
    }

    #[test]
    fn personal_authors_override_site_name_and_invalid_date_does_not_hide_publication_date() {
        let html = "<meta property='og:title' content='Flash &amp; Cyber'><meta property='og:site_name' content='Google'><meta name='authors' content='Tulsee Doshi,Raluca Ada Popa'><meta name='citation_publication_date' content='undefined'><meta property='article:published_time' content='2026-09-02'>";
        let html = format!(
            r#"{html}<script type="application/ld+json">{{"@type":"Article","url":"https://example.org/flash","author":{{"name":"Tulsee Doshi"}}}}</script>"#
        );
        let bib = citation(&html, "https://example.org/flash").unwrap();
        assert!(bib.contains("author = {Tulsee Doshi and Raluca Ada Popa}"));
        assert!(bib.contains("year = {2026}"));
        assert!(bib.contains("title = {Flash \\& Cyber}"));
        assert!(!bib.contains("Google"));
    }

    #[test]
    fn visible_publication_dates_work_but_footer_years_do_not() {
        for date in [
            "<time datetime='2025-08-31'>Yesterday</time>",
            "<div class='LaunchHero__date'>August 2025</div>",
        ] {
            let bib = citation(
                &format!("<title>A study</title>{date}<footer>Copyright 2026</footer>"),
                "https://example.org/study",
            )
            .unwrap();
            assert!(bib.contains("year = {2025}"), "{bib}");
        }
        let bib = citation(
            "<title>A study</title><footer><time>September 2026</time></footer><main><div class='last-updated'><time>September 2026</time></div></main>",
            "https://example.org/study",
        )
        .unwrap();
        assert!(!bib.contains("year ="));
        assert!(!bib.contains("author ="));
        assert!(!bib.contains("XXXX"));
    }

    #[test]
    fn structured_metadata_uses_the_article_not_related_links_or_modified_dates() {
        let html = r#"<meta property="og:title" content="A study"><script type="application/ld+json">{"@graph":[{"@type":"Article","url":"https://example.org/related","author":{"name":"Wrong"},"datePublished":"2026-01-01"},{"@type":"BlogPosting","url":"https://example.org/study","author":[{"@type":"Person","name":"Zoë Li"},{"@type":"Organization","name":"R&D Team"}],"datePublished":"2024-04-03","dateModified":"2026-09-01"}]}</script>"#;
        let bib = citation(html, "https://example.org/study#intro").unwrap();
        assert!(bib.contains("Zoë Li and {R\\&D Team}"), "{bib}");
        assert!(bib.contains("year = {2024}"));
        assert!(!bib.contains("Wrong"));
        assert!(!bib.contains("2026"));
    }

    #[test]
    fn empty_shells_challenges_and_doi_publications_are_not_blog_citations() {
        for html in [
            "<div id='root'></div>",
            "<title>Tencent Hy</title><script src='/assets/app.js'></script><div id='app'></div>",
            "<title>Just a moment...</title>",
            "<title>Paper</title><meta name='citation_doi' content='10.123/example'>",
        ] {
            assert!(citation(html, "https://example.org/").is_none());
        }
    }

    #[test]
    fn matching_headline_site_suffix_supplies_a_corporate_author() {
        let bib = citation("<title>Introducing a model \\ Publisher</title><meta property='og:title' content='Introducing a model'><main><p class='release-date'>September 2026</p></main>", "https://example.org/model").unwrap();
        assert!(bib.contains("author = {{Publisher}}"));
        assert!(bib.contains("year = {2026}"));
        let other = citation("<title>Different title | Wrong company</title><meta property='og:title' content='Introducing a model'>", "https://example.org/model").unwrap();
        assert!(!other.contains("author ="));
    }
}
