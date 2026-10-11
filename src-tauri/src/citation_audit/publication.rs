//! Read Crossref's deposited BibTeX directly, without bibcite's lossy venue
//! normalization. Its container title identifies the proceedings, whereas
//! event.name can refer to a colocated workshop (including CVPR 2009).
//! ACL Anthology DOIs are read from the Anthology itself, the publisher of
//! record: Crossref's deposit can drop given names (POPE's "Wayne Xin Zhao"
//! is deposited as "Xin Zhao").
use super::proceedings::{self, official_client};
use super::*;
use reqwest::blocking::Client;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

const CROSSREF: &str = "Crossref / official proceedings";
const ACL_ANTHOLOGY: &str = "ACL Anthology";

/// A publisher's record of one paper and the source row that reports it.
struct Official {
    bibtex: String,
    source: &'static str,
}

pub(super) fn refine(checked: AuditResult) -> AuditResult {
    refine_with(checked, false)
}

/// `refine` for a record an import just fetched by its DOI. When the ACL
/// Anthology's record of that same DOI differs only in author forms, the
/// fetched record's authors came from the lossy Crossref deposit, so the
/// Anthology's replace them. An audit never does this: there the authors are
/// the writer's own, and a disagreement stays a candidate for review.
pub(super) fn refine_import(checked: AuditResult) -> AuditResult {
    refine_with(checked, true)
}

fn refine_with(mut checked: AuditResult, import: bool) -> AuditResult {
    if checked.status == "conflict" || checked.status == "skipped" {
        return checked;
    }
    let basis = checked.current();
    let values = fields(basis);
    if values.get("pubstate").is_some_and(|v| v.eq_ignore_ascii_case("preprint")) {
        return checked;
    }
    let doi = entry_doi(&values).filter(|doi| !doi.starts_with(ARXIV_DOI_PREFIX));
    if doi.is_none() && project::bibliography_arxiv_id(&values).is_none() {
        return checked;
    }
    let found = lookup(basis, doi.as_deref());
    let source = found.as_ref().ok().and_then(Option::as_ref).map_or(CROSSREF, |o| o.source);
    let outcome = match found {
        Ok(Some(official)) => {
            // A conference's own citation export, already selected for this
            // entry, keeps every field it settled (LLaVA's NeurIPS publisher);
            // the generic deposit only fills in what that export lacks.
            let (remote, disagreements) = match &checked.official {
                Some(export) => prefer(export, &official.bibtex),
                None => (official.bibtex, vec![]),
            };
            let anthology_authors = import
                && source == ACL_ANTHOLOGY
                && doi.is_some()
                && identity_conflicts(&checked.before, &remote) == ["author"];
            if metadata_identity_matches(&checked.before, &remote) || anthology_authors {
                let mut updated = cleanup_result(merge_metadata(&checked.before, &remote, true));
                updated.sources = checked.sources;
                updated.health = checked.health;
                updated.official = checked.official;
                updated.disagreements = disagreements;
                if updated.after.is_some() {
                    updated.message = "Verified publication metadata is available.".into();
                }
                if updated.health.as_ref().is_some_and(CitationHealth::is_incomplete) {
                    updated.status = "unavailable".into();
                    updated.message = "Publication metadata was verified, but the citation-health check was incomplete.".into();
                }
                checked = updated;
                "selected"
            } else {
                let mut conflict = identity_conflict(&checked.before, &remote);
                conflict.sources = checked.sources;
                conflict.health = checked.health;
                checked = conflict;
                "candidate"
            }
        }
        Ok(None) => "no_match",
        Err(_) => {
            checked.official_source_unavailable();
            "unavailable"
        }
    };
    checked.sources.push(SourceCheck::new(source, outcome));
    checked
}

/// `primary` with any field it lacks taken from `secondary`, plus the
/// bibliographic facts on which the two records disagree.
fn prefer(primary: &str, secondary: &str) -> (String, Vec<String>) {
    let (first, mut values) = (fields(primary), fields(secondary));
    let mut disagreements = Vec::new();
    for (name, value) in first.into_iter().filter(|(_, value)| !value.trim().is_empty()) {
        let differs = values.get(&name).is_some_and(|other| !same_value(&name, &value, other));
        if differs && ["publisher", "pages", "volume", "year", "doi"].contains(&name.as_str()) {
            disagreements.push(name.clone());
        }
        values.insert(name, value);
    }
    let spans = project::bibliography_entry_spans(primary);
    let key = spans.first().map_or("official", |span| span.0.as_str());
    let expressions = values.into_iter().map(|(name, value)| (name, format!("{{{value}}}")));
    (render_entry(&entry_type(primary.trim()), key, expressions.collect()), disagreements)
}

fn candidate_dois(before: &str, report: &serde_json::Value) -> Vec<String> {
    let local = fields(before);
    let title = local.get("title").map(|v| normalize_title(v)).unwrap_or_default();
    report
        .pointer("/message/items")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|item| {
            matches!(item["type"].as_str(), Some("proceedings-article" | "journal-article"))
        })
        .filter(|item| {
            !title.is_empty()
                && item["title"][0].as_str().is_some_and(|v| normalize_title(v) == title)
        })
        .filter_map(|item| item["DOI"].as_str().and_then(published_doi))
        .collect()
}

fn lookup(before: &str, doi: Option<&str>) -> Result<Option<Official>, String> {
    let client = official_client("Lattice bibliography publication verification", true)?;
    let dois = if let Some(doi) = doi {
        vec![doi.to_string()]
    } else {
        let values = fields(before);
        let title = values.get("title").ok_or("Missing title")?.replace(['{', '}'], "");
        let report: serde_json::Value = client
            .get("https://api.crossref.org/works")
            .query(&[("query.title", title.as_str()), ("rows", "5")])
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| e.to_string())?;
        candidate_dois(before, &report)
    };
    let mut matched = None;
    for doi in dois {
        // The Anthology may lack an export for an older DOI; Crossref's
        // deposit is then still a verified record of the same DOI.
        let official = match acl_anthology(&client, &doi) {
            Ok(Some(bibtex)) => Official { bibtex, source: ACL_ANTHOLOGY },
            _ => Official { bibtex: crossref_bibtex(&client, &doi)?, source: CROSSREF },
        };
        let remote = match official_cvf(&client, &official.bibtex, &doi)? {
            Some(cvf) => Official { bibtex: cvf, ..official },
            None => official,
        };
        // Keep author conflicts visible for review rather than reporting that
        // a published version does not exist.
        let conflicts = identity_conflicts(before, remote.bibtex.trim());
        if accepts(before, &remote.bibtex, &doi) || conflicts == ["author"] {
            // Multiple publications with identical identities need review.
            if matched.is_some() {
                return Ok(None);
            }
            matched = Some(Official { bibtex: remote.bibtex.trim().to_string(), ..remote });
        }
    }
    Ok(matched)
}

fn crossref_bibtex(client: &Client, doi: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse("https://api.crossref.org/works/").unwrap();
    url.path_segments_mut().unwrap().pop_if_empty().extend([
        doi,
        "transform",
        "application",
        "x-bibtex",
    ]);
    client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| e.to_string())
}

/// The ACL Anthology's own BibTeX for one of its DOIs (`10.18653/v1/<id>`),
/// when it is a complete record of exactly that DOI.
fn acl_anthology(client: &Client, doi: &str) -> Result<Option<String>, String> {
    let Some(id) = anthology_id(doi) else {
        return Ok(None);
    };
    let bibtex = anthology_bibtex(client, &id)?;
    let exact = bibtex.as_deref().is_some_and(|bibtex| {
        fields(bibtex).get("doi").and_then(|v| normalize_doi(v)).as_deref() == Some(doi)
    });
    Ok(bibtex.filter(|_| exact))
}

/// The Anthology's record for a paper ID such as `2023.emnlp-main.20`.
pub(super) fn anthology_record(id: &str) -> Result<Option<String>, String> {
    let client = official_client("Lattice bibliography publication verification", true)?;
    anthology_bibtex(&client, id)
}

fn anthology_bibtex(client: &Client, id: &str) -> Result<Option<String>, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Ok(None);
    }
    let url = reqwest::Url::parse("https://aclanthology.org/").unwrap().join(&format!("{id}.bib"));
    let bibtex = proceedings::fetch(client, url.map_err(|e| e.to_string())?)?;
    let bibtex = bibtex.trim();
    Ok(complete_entry(bibtex).then(|| bibtex.to_string()))
}

/// The Anthology ID a normalized (lowercase) ACL DOI names. IDs are
/// case-sensitive: old-style ones begin with an uppercase letter (D19-1275),
/// new-style ones are lowercase (2023.emnlp-main.20).
fn anthology_id(doi: &str) -> Option<String> {
    let id = doi.strip_prefix("10.18653/v1/")?;
    let mut chars = id.chars();
    let first = chars.next()?;
    Some(if first.is_ascii_alphabetic() && chars.next().is_some_and(|c| c.is_ascii_digit()) {
        format!("{}{}", first.to_ascii_uppercase(), &id[1..])
    } else {
        id.to_string()
    })
}

fn official_cvf(client: &Client, remote: &str, doi: &str) -> Result<Option<String>, String> {
    let values = fields(remote);
    let venue = values.get("booktitle").map(String::as_str).unwrap_or("");
    let Some(conference) = ["ICCV", "CVPR", "WACV"].into_iter().find(|name| venue.contains(name))
    else {
        return Ok(None);
    };
    if venue.to_lowercase().contains("workshop") {
        return Ok(None);
    }
    let Some(year) = values
        .get("year")
        .filter(|year| year.len() == 4 && year.chars().all(|c| c.is_ascii_digit()))
    else {
        return Ok(None);
    };
    // CVF open-access proceedings begin in 2013; older records use Crossref.
    if year.as_str() < "2013" {
        return Ok(None);
    }
    let Some(title) = values.get("title") else {
        return Ok(None);
    };
    let base = reqwest::Url::parse("https://openaccess.thecvf.com").unwrap();
    let papers = cvf_papers(client, &base, &format!("{conference}{year}"))?;
    let mut matches =
        papers.iter().filter(|(_, text)| normalize_title(text) == normalize_title(title));
    let Some((path, _)) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Ok(None);
    }
    let page = proceedings::fetch(client, base.join(path).unwrap())?;
    let document = scraper::Html::parse_document(&page);
    let selector = scraper::Selector::parse(".bibref").unwrap();
    let Some(entry) = document.select(&selector).next() else {
        return Ok(None);
    };
    let raw = entry.text().collect::<String>();
    if !complete_entry(raw.trim())
        || normalize_title(fields(&raw).get("title").map(String::as_str).unwrap_or(""))
            != normalize_title(title)
    {
        return Ok(None);
    }
    Ok(Some(append_field(raw.trim(), &format!(" doi = {{{doi}}}"))))
}

/// One conference year's paper links (path, title), kept for the rest of an
/// audit: every entry from that conference reads the same multi-megabyte index.
static CVF_INDEXES: LazyLock<Mutex<HashMap<String, (Instant, PaperLinks)>>> =
    LazyLock::new(Default::default);
type PaperLinks = Arc<Vec<(String, String)>>;
const CVF_INDEX_LIFETIME: Duration = Duration::from_secs(30 * 60);

fn cvf_papers(
    client: &Client, base: &reqwest::Url, conference_year: &str,
) -> Result<PaperLinks, String> {
    {
        let mut indexes = CVF_INDEXES.lock().unwrap_or_else(|e| e.into_inner());
        indexes.retain(|_, (fetched, _)| fetched.elapsed() < CVF_INDEX_LIFETIME);
        if let Some((_, papers)) = indexes.get(conference_year) {
            return Ok(papers.clone());
        }
    }
    let index = proceedings::fetch_index(
        client,
        base.join(&format!("/{conference_year}?day=all")).unwrap(),
    )?;
    let prefix = format!("/content/{conference_year}/html/");
    let papers = Arc::new(
        proceedings::links(&index)
            .into_iter()
            .filter(|(href, _)| href.starts_with(&prefix) && href.ends_with("_paper.html"))
            .collect::<Vec<_>>(),
    );
    CVF_INDEXES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(conference_year.to_string(), (Instant::now(), papers.clone()));
    Ok(papers)
}

fn accepts(before: &str, remote: &str, doi: &str) -> bool {
    let values = fields(remote);
    metadata_identity_matches(before, remote.trim())
        && values.get("doi").and_then(|v| normalize_doi(v)).as_deref() == Some(doi)
        && matches!(entry_type(remote.trim()).as_str(), "article" | "inproceedings")
        && ["journal", "booktitle"]
            .iter()
            .any(|key| values.get(*key).is_some_and(|v| !v.is_empty() && !is_preprint_venue(v)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Live Crossref, CVF and arXiv requests"]
    fn live_reported_publications() {
        let dino = crate::papers::official_arxiv_citation("2104.14294").unwrap().unwrap();
        let remote = lookup(&dino, None).unwrap().expect("DINO publication").bibtex;
        assert!(metadata_identity_matches(&dino, &remote), "{remote}");
        assert!(fields(&remote)["booktitle"].contains("ICCV"));
        assert_eq!(fields(&remote)["pages"], "9650-9660");
        let pope = crate::papers::official_arxiv_citation("2305.10355").unwrap().unwrap();
        // The ACL Anthology keeps "Wayne Xin Zhao", which Crossref's deposit drops.
        let remote = lookup(&pope, None).unwrap().expect("POPE publication");
        assert_eq!(remote.source, ACL_ANTHOLOGY);
        assert_eq!(fields(&remote.bibtex)["doi"], "10.18653/v1/2023.emnlp-main.20");
        assert!(metadata_identity_matches(&pope, &remote.bibtex), "{}", remote.bibtex);
    }

    #[test]
    fn published_candidates_require_exact_title_and_publication_type() {
        let before =
            "@misc{dino,title={Emerging Properties in Self-Supervised Vision Transformers}}";
        let report = serde_json::json!({"message":{"items":[
            {"type":"proceedings-article","title":["Emerging Properties in Self-Supervised Vision Transformers"],"DOI":"10.1109/ICCV48922.2021.00951"},
            {"type":"posted-content","title":["Emerging Properties in Self-Supervised Vision Transformers"],"DOI":"10.48550/arXiv.2104.14294"},
            {"type":"proceedings-article","title":["Other Properties in Self-Supervised Vision Transformers"],"DOI":"10.1234/other"}
        ]}});
        assert_eq!(candidate_dois(before, &report), vec!["10.1109/iccv48922.2021.00951"]);
    }

    #[test]
    fn authoritative_venue_can_correct_workshops_but_not_identity() {
        let before = "@inproceedings{image,title={ImageNet: A large-scale hierarchical image database},author={Jia Deng and Wei Dong},year={2009},doi={10.1109/CVPR.2009.5206848},booktitle={CVPR Workshops}}";
        let remote = before.replace(
            "CVPR Workshops",
            "2009 IEEE Conference on Computer Vision and Pattern Recognition",
        );
        let doi = "10.1109/cvpr.2009.5206848";
        assert!(accepts(before, &remote, doi));
        assert!(!accepts(before, &remote.replace("Wei Dong", "Other Author"), doi));
        assert!(!accepts(before, &remote, "10.1234/wrong"));
        assert_eq!(
            fields(&merge_metadata(before, &remote, true).after.unwrap())["booktitle"],
            "2009 IEEE Conference on Computer Vision and Pattern Recognition"
        );
    }
}
