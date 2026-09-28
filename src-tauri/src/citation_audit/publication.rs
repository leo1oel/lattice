//! Read Crossref's deposited BibTeX directly, without bibcite's lossy venue
//! normalization. Its container title identifies the proceedings, whereas
//! event.name can refer to a colocated workshop (including CVPR 2009).
use super::*;
use reqwest::blocking::Client;

pub(super) fn refine(mut checked: AuditResult) -> AuditResult {
    if checked.status == "conflict" || checked.status == "skipped" {
        return checked;
    }
    let basis = checked.after.as_deref().unwrap_or(&checked.before);
    let values = fields(basis);
    if values.get("pubstate").is_some_and(|v| v.eq_ignore_ascii_case("preprint")) {
        return checked;
    }
    let doi =
        values.get("doi").and_then(|v| normalize_doi(v)).filter(|v| !v.starts_with("10.48550/"));
    if doi.is_none() && project::bibliography_arxiv_id(&values).is_none() {
        return checked;
    }
    let outcome = lookup(basis, doi.as_deref());
    let source_outcome = match outcome {
        Ok(Some(remote)) if metadata_identity_matches(&checked.before, &remote) => {
            let mut updated = cleanup_result(merge_metadata(&checked.before, &remote, true));
            updated.sources = checked.sources;
            updated.health = checked.health;
            if updated.after.is_some() {
                updated.message = "Verified publication metadata is available.".into();
            }
            if updated.health.as_ref().is_some_and(|h| h.kind == "unavailable" || h.stale) {
                updated.status = "unavailable".into();
                updated.message = "Publication metadata was verified, but the citation-health check was incomplete.".into();
            }
            checked = updated;
            "selected"
        }
        Ok(Some(remote)) => {
            let mut conflict = identity_conflict(&checked.before, &remote);
            conflict.sources = checked.sources;
            conflict.health = checked.health;
            checked = conflict;
            "candidate"
        }
        Ok(None) => "no_match",
        Err(_) => {
            if checked.after.is_none() {
                checked.status = "unavailable".into();
                checked.publication_reason = Some("sources_unavailable".into());
            }
            "unavailable"
        }
    };
    checked.sources.push(SourceCheck {
        source: "Crossref / official proceedings".into(),
        outcome: source_outcome.into(),
    });
    checked
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
        .filter_map(|item| item["DOI"].as_str().and_then(normalize_doi))
        .filter(|doi| !doi.starts_with("10.48550/"))
        .collect()
}

fn lookup(before: &str, doi: Option<&str>) -> Result<Option<String>, String> {
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
                attempt.stop()
            }
        }))
        .user_agent("Lattice bibliography publication verification")
        .build()
        .map_err(|e| e.to_string())?;
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
        let mut url = reqwest::Url::parse("https://api.crossref.org/works/").unwrap();
        url.path_segments_mut()
            .unwrap()
            .pop_if_empty()
            .push(&doi)
            .push("transform")
            .push("application")
            .push("x-bibtex");
        let remote = client
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
            .map_err(|e| e.to_string())?;
        let remote = official_cvf(&client, &remote, &doi)?.unwrap_or(remote);
        // Keep author conflicts visible for review rather than reporting that
        // a published version does not exist (e.g. Wayne Xin Zhao vs Xin Zhao).
        let conflicts = identity_conflicts(before, remote.trim());
        if accepts(before, &remote, &doi) || conflicts == ["author"] {
            // Multiple publications with identical identities need review.
            if matched.is_some() {
                return Ok(None);
            }
            matched = Some(remote.trim().to_string());
        }
    }
    Ok(matched)
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
    let index = super::proceedings::fetch(
        client,
        base.join(&format!("/{conference}{year}?day=all")).unwrap(),
    )?;
    let mut matches = super::proceedings::links(&index).into_iter().filter(|(href, text)| {
        href.starts_with(&format!("/content/{conference}{year}/html/"))
            && href.ends_with("_paper.html")
            && normalize_title(text) == normalize_title(title)
    });
    let Some((path, _)) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Ok(None);
    }
    let page = super::proceedings::fetch(client, base.join(&path).unwrap())?;
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
    let mut raw = raw.trim().to_string();
    raw.pop();
    Ok(Some(format!("{},\n doi = {{{doi}}}\n}}", raw.trim_end().trim_end_matches(','))))
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
        let remote = lookup(&dino, None).unwrap().expect("DINO publication");
        assert!(metadata_identity_matches(&dino, &remote), "{remote}");
        assert!(fields(&remote)["booktitle"].contains("ICCV"));
        assert_eq!(fields(&remote)["pages"], "9650-9660");
        let pope = crate::papers::official_arxiv_citation("2305.10355").unwrap().unwrap();
        let remote = lookup(&pope, None).unwrap().expect("POPE publication candidate");
        assert_eq!(fields(&remote)["doi"], "10.18653/v1/2023.emnlp-main.20");
        assert_eq!(identity_conflicts(&pope, &remote), vec!["author"]);
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
