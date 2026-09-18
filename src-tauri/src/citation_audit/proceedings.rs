//! Official proceedings supplement generic indexes, which can lag a new volume
//! or retain preprint metadata. Never infer acceptance from an arXiv title alone.
use super::*;
use reqwest::blocking::Client;
use scraper::{Html, Selector};
use std::io::Read;

const ICLR: &str = "https://proceedings.iclr.cc";
const NEURIPS: &str = "https://papers.nips.cc";

pub(super) fn refine(before: &str, mut checked: AuditResult) -> AuditResult {
    let basis = checked.after.as_deref().unwrap_or(before);
    let values = fields(basis);
    let venue = values.get("booktitle").map(String::as_str).unwrap_or("");
    let site = if venue.contains("NeurIPS") || venue.contains("Neural Information Processing") {
        NEURIPS
    } else if venue.contains("ICLR")
        || (checked.after.is_none()
            && matches!(
                checked.publication_reason.as_deref(),
                Some("no_published_version" | "sources_unavailable")
            ))
    {
        ICLR
    } else {
        return checked;
    };
    let Some(title) = values.get("title") else {
        return checked;
    };
    let source = if site == ICLR {
        "ICLR Proceedings"
    } else {
        "NeurIPS Proceedings"
    };
    match lookup(site, title) {
        Ok(Some(remote)) if metadata_identity_matches(basis, &remote) => {
            // When the index already confirmed a preprint-to-publication match,
            // independently verify its title/authors against the official export.
            // Merge from the original so the preview remains snapshot-correct.
            let mut official = merge_metadata(before, &remote, true);
            official.sources = checked.sources;
            for row in &mut official.sources {
                if row.outcome.starts_with("selected") {
                    row.outcome = "matched".into();
                }
            }
            official.sources.push(SourceCheck {
                source: source.into(),
                outcome: "selected".into(),
            });
            official
        }
        outcome => {
            checked.sources.push(SourceCheck {
                source: source.into(),
                outcome: match outcome {
                    Ok(Some(_)) => "candidate",
                    Ok(None) => "no_match",
                    Err(_) => "unavailable",
                }
                .into(),
            });
            // A failed official request is not proof that publication is absent.
            if checked.after.is_none() && checked.sources.last().unwrap().outcome == "unavailable" {
                checked.status = "unavailable".into();
                checked.publication_reason = Some("sources_unavailable".into());
            }
            checked
        }
    }
}

fn fetch(client: &Client, url: reqwest::Url) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut text = String::new();
    response
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() > 4 * 1024 * 1024 {
        return Err("Proceedings response too large".into());
    }
    Ok(text)
}

fn links(html: &str) -> Vec<(String, String)> {
    Html::parse_document(html)
        .select(&Selector::parse("a[href]").unwrap())
        .map(|a| {
            (
                a.value().attr("href").unwrap().to_string(),
                a.text().collect::<String>(),
            )
        })
        .collect()
}

fn paper_path(html: &str, title: &str) -> Option<String> {
    let mut matches = links(html).into_iter().filter(|(href, text)| {
        href.starts_with("/paper_files/paper/")
            && href.contains("/hash/")
            && href.ends_with("-Abstract-Conference.html")
            && normalize_title(text) == normalize_title(title)
    });
    let first = matches.next()?.0;
    // Multiple same-title papers are ambiguous, even within one conference.
    matches.next().is_none().then_some(first)
}

fn lookup(site: &str, title: &str) -> Result<Option<String>, String> {
    // Only fixed official hosts are contacted; links cannot redirect requests
    // into an arbitrary domain or local network.
    let client = Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() <= 3
                && attempt.url().scheme() == "https"
                && attempt
                    .previous()
                    .first()
                    .is_some_and(|first| first.host_str() == attempt.url().host_str())
            {
                attempt.follow()
            } else {
                attempt.error("Proceedings redirect left the official host or exceeded its limit")
            }
        }))
        .user_agent("Lattice bibliography audit")
        .build()
        .map_err(|e| e.to_string())?;
    let base = reqwest::Url::parse(site).unwrap();
    let mut search = base.join("/papers/search").unwrap();
    search
        .query_pairs_mut()
        .append_pair("q", &clean(title).replace(['{', '}'], ""));
    let results = fetch(&client, search)?;
    let Some(path) = paper_path(&results, title) else {
        return Ok(None);
    };
    let page = fetch(&client, base.join(&path).unwrap())?;
    let export = links(&page)
        .into_iter()
        .find(|(href, _)| href.starts_with("/paper_files/paper/") && href.ends_with("/bibtex"))
        .ok_or("Missing proceedings BibTeX export")?
        .0;
    let mut bibtex = fetch(&client, base.join(&export).unwrap())?;
    if !complete_entry(bibtex.trim()) {
        return Err("Incomplete proceedings export".into());
    }
    let values = fields(&bibtex);
    if normalize_title(values.get("title").map(String::as_str).unwrap_or(""))
        != normalize_title(title)
        || entry_type(bibtex.trim()) != "inproceedings"
    {
        return Err("Proceedings export did not match search result".into());
    }
    // Official exports omit the acronym used by the app's canonical venue.
    let canonical = if site == ICLR {
        "International Conference on Learning Representations (ICLR)"
    } else {
        "Advances in Neural Information Processing Systems (NeurIPS)"
    };
    if let Some(venue) = values.get("booktitle") {
        bibtex = bibtex.replace(&format!("{{{venue}}}"), &format!("{{{canonical}}}"));
    }
    Ok(Some(bibtex))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_requires_one_exact_conference_title_and_safe_path() {
        let link = "<a href='/paper_files/paper/2026/hash/abc-Abstract-Conference.html'>Memory &amp; Agents</a>";
        assert!(paper_path(link, "Memory & Agents").is_some());
        assert!(paper_path(link, "Other Memory & Agents").is_none());
        assert!(paper_path(
            &link.replace("Conference.html", "Workshop.html"),
            "Memory & Agents"
        )
        .is_none());
        assert!(paper_path(
            &link.replace("href='/", "href='https://evil.test/"),
            "Memory & Agents"
        )
        .is_none());
        assert!(paper_path(&format!("{link}{link}"), "Memory & Agents").is_none());
    }
}
