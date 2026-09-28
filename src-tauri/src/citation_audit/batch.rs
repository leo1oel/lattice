//! The Semantic Scholar fast path: hydrate up to 20 entries by exact DOI or
//! arXiv ID in one request. Anything short of a confirmed, identical paper
//! falls back to the per-entry check; a miss never counts as verified.
use super::*;
use crate::citation_batch::{self, Paper};

/// A bounded fast path; None means the original multi-source check is still
/// required. API misses and malformed records never count as successful checks.
pub fn check_batch(root: &Path, entries: Vec<AuditEntry>) -> Result<BatchAudit, String> {
    if entries.len() > citation_batch::BATCH_SIZE {
        return Err("Too many entries in an audit batch.".into());
    }
    let failed = |code: &str| {
        let results = entries.iter().map(|_| None).collect();
        Ok(BatchAudit { results, s2_failure: Some(code.into()) })
    };
    let ids = entries.iter().map(|entry| batch_id(&entry.bibtex)).collect::<Vec<_>>();
    let papers = match citation_batch::lookup(&ids.iter().flatten().cloned().collect::<Vec<_>>()) {
        Ok(papers) => papers,
        Err(failure) => return failed(failure.code()),
    };
    let Ok(normalized) = normalize_s2_batch(&papers) else {
        return failed("malformed");
    };
    let mut results = entries
        .iter()
        .zip(ids)
        .map(|(entry, id)| {
            let id = id?;
            let paper = papers.get(&id)?;
            // The same snapshot guard as the individual path, before any proposal.
            if registered_entry(root, &entry.path, &entry.key).ok().flatten().as_deref()
                != Some(&entry.bibtex)
            {
                return None;
            }
            let (bibtex, venue) = normalized.get(&id)?;
            // These proceedings have a direct authoritative check. A fast
            // index result must not bypass the formal-version author lookup.
            if venue
                .as_deref()
                .is_some_and(|venue| venue.contains("NeurIPS") || venue.contains("ICLR"))
            {
                return None;
            }
            let mut checked = batch_comparison(&entry.bibtex, paper, bibtex, venue.as_deref())?;
            if checked.candidate.is_some() {
                // A conflicting fast-path record (including a Findings DOI
                // mislabeled as ACL) still needs the independent source lookup.
                return None;
            }
            checked.sources.push(SourceCheck::new("semanticscholar", "selected"));
            Some(publication::refine(cleanup_result(checked)))
        })
        .collect::<Vec<_>>();
    let doi_of =
        |checked: &AuditResult| fields(checked.current()).get("doi").and_then(|v| published_doi(v));
    // One shared lookup loads/writes the health cache once for this group.
    // Crossref's health checks remain individual requests, not an invented batch API.
    let health = citation_health::lookup(root, results.iter().flatten().filter_map(doi_of));
    for checked in results.iter_mut().flatten() {
        // A confirmed conference publication may have no DOI. Like the
        // existing preprint upgrade, this is not a Crossref health verdict.
        if let Some(doi) = doi_of(checked) {
            checked.record_health(health.get(&doi).cloned());
        }
    }
    Ok(BatchAudit { results, s2_failure: None })
}

/// The exact identifier S2 is asked about, unless the entry is an explicit preprint.
fn batch_id(before: &str) -> Option<String> {
    let local = fields(before);
    if local.get("pubstate").is_some_and(|v| v.eq_ignore_ascii_case("preprint")) {
        return None;
    }
    if let Some(doi) = local.get("doi").and_then(|v| published_doi(v)) {
        return Some(format!("DOI:{doi}"));
    }
    // Versioned arXiv identifiers refer to the same S2 paper.
    Some(format!("ARXIV:{}", unversioned_arxiv(&project::bibliography_arxiv_id(&local)?)))
}

fn batch_comparison(
    before: &str, paper: &Paper, normalized_bibtex: &str, canonical_venue: Option<&str>,
) -> Option<AuditResult> {
    let local = fields(before);
    if normalize_title(local.get("title")?) != normalize_title(&paper.title) {
        return None;
    }
    let preprint = batch_id(before)?.starts_with("ARXIV:");
    let doi = paper.external_ids.get("DOI").and_then(|v| v.as_str()).and_then(published_doi);
    if !preprint && doi.is_none() {
        return None;
    }
    let mut remote = normalized_bibtex.trim().to_string();
    let other = fields(&remote);
    if project::bibliography_entry_spans(&remote).len() != 1
        || !complete_entry(&remote)
        || other.get("doi").is_some_and(|v| normalize_doi(v) != doi)
        || normalize_title(other.get("title")?) != normalize_title(&paper.title)
    {
        return None;
    }
    // S2's generated BibTeX often omits DOI even when externalIds contains it.
    // Only add the independently confirmed identifier, never guess one from a title.
    if let Some(doi) = doi.filter(|_| !other.contains_key("doi")) {
        if doi.contains(['{', '}', '\\']) || !remote.ends_with('}') {
            return None;
        }
        remote = append_field(&remote, &format!("  doi = {{{doi}}}"));
    }
    if !preprint {
        return Some(compare_doi_entry(before, &remote));
    }
    let arxiv = paper.external_ids.get("ArXiv")?.as_str()?;
    if batch_id(before)? != format!("ARXIV:{}", unversioned_arxiv(arxiv)) {
        return None;
    }
    // S2 may omit eprint in BibTeX even though externalIds confirms it.
    // Carry that checked identifier into the shared identity/apply rules.
    if project::bibliography_arxiv_id(&other).is_none() {
        if !remote.ends_with('}') {
            return None;
        }
        remote = append_field(&remote, &format!("  eprint = {{{arxiv}}}"));
    }
    if !metadata_identity_matches(before, &remote) {
        return None;
    }
    let venue = canonical_venue?.trim();
    if venue.is_empty()
        || is_preprint_venue(venue)
        || !["journal", "booktitle"].iter().any(|name| {
            other.get(*name).is_some_and(|v| normalize_text(v) == normalize_text(venue))
        })
    {
        return None;
    }
    let year = local.get("year")?.parse::<u32>().ok()?;
    let published_year = other.get("year")?.parse::<u32>().ok()?;
    if year.abs_diff(published_year) > 2 || local.get("author")?.trim().is_empty() {
        return None;
    }
    let after = merge_metadata(before, &remote, true).after?;
    Some(proposal(before, after, "A published version is available."))
}

/// Normalize S2's generated BibTeX, and each paper's independent venue field,
/// with one bibcite run. Returns (bibtex, canonical venue) by batch ID.
fn normalize_s2_batch(
    papers: &BTreeMap<String, Paper>,
) -> Result<BTreeMap<String, (String, Option<String>)>, String> {
    let mut order = Vec::new();
    let mut input = String::new();
    for (id, paper) in papers {
        let Some(style) = &paper.citation_styles else {
            continue;
        };
        order.push(id.clone());
        input.push_str(&style.bibtex);
        input.push('\n');
        // Normalize the independent venue field too; the generated BibTeX
        // must agree with it before a preprint can become a publication.
        let venue = paper.venue.as_deref().unwrap_or("");
        let venue = if venue.contains(['{', '}', '\\']) { "" } else { venue };
        input.push_str(&format!(
            "@misc{{latticeVenue{}, journal = {{{venue}}}, year = {{{}}}}}\n",
            order.len(),
            paper.year.unwrap_or(0)
        ));
    }
    if order.is_empty() {
        return Ok(BTreeMap::new());
    }
    let temp = scratch(Some(&input))?;
    let output = run_bibcite(&["normalize", temp.path.to_string_lossy().as_ref()], None)?;
    if !output.status.success() {
        return Err("bibcite normalization failed".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "bibcite normalization returned invalid JSON")?;
    let values = value
        .get("bibtex")
        .and_then(|v| v.as_array())
        .ok_or("bibcite normalization returned no entries")?;
    // Each paper yields its entry followed by its venue hint, in input order.
    if values.len() != order.len() * 2 {
        return Err("unexpected normalized entries".into());
    }
    order
        .into_iter()
        .zip(values.chunks(2))
        .map(|(id, pair)| {
            let (Some(bibtex), Some(hint)) = (pair[0].as_str(), pair[1].as_str()) else {
                return Err("missing normalized entry".to_string());
            };
            let hint = fields(hint);
            let venue = hint.get("journal").or_else(|| hint.get("booktitle")).cloned();
            Ok((id, (bibtex.to_string(), venue)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s2_paper(json: serde_json::Value) -> Paper {
        serde_json::from_value(json).unwrap()
    }

    /// Compare against S2's own BibTeX, as if bibcite normalization were identity.
    fn compare_batch(before: &str, paper: &Paper) -> Option<AuditResult> {
        let bibtex = &paper.citation_styles.as_ref()?.bibtex;
        let parsed = fields(bibtex);
        let venue = parsed.get("journal").or_else(|| parsed.get("booktitle"));
        batch_comparison(before, paper, bibtex, venue.map(String::as_str))
    }

    #[test]
    #[ignore = "requires installed bibcite 0.6.8; normalizes offline without S2 requests"]
    fn installed_batch_normalizer_preserves_publication_and_venue_identity() {
        let paper = s2_paper(serde_json::json!({
            "externalIds": {"ArXiv":"2401.12345", "DOI":"10.1234/published"},
            "title":"A paper", "venue":"CVPR", "year":2024,
            "citationStyles":{"bibtex":"@inproceedings{remote, title={A paper}, author={Alice Smith}, year={2024}, booktitle={CVPR}}"}
        }));
        let mut papers = BTreeMap::from([("ARXIV:2401.12345".into(), paper)]);
        let normalized = normalize_s2_batch(&papers).unwrap();
        let (bibtex, venue) = &normalized["ARXIV:2401.12345"];
        assert_eq!(
            venue.as_deref(),
            Some("IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)")
        );
        let before = "@article{mine, title={A paper}, author={Alice Smith}, year={2024}, eprint={2401.12345}, journal={arXiv}}";
        assert!(batch_comparison(before, &papers["ARXIV:2401.12345"], bibtex, venue.as_deref())
            .is_some());
        papers.get_mut("ARXIV:2401.12345").unwrap().venue = Some("ICLR".into());
        let normalized = normalize_s2_batch(&papers).unwrap();
        let (bibtex, venue) = &normalized["ARXIV:2401.12345"];
        assert!(batch_comparison(before, &papers["ARXIV:2401.12345"], bibtex, venue.as_deref())
            .is_none());
    }

    #[test]
    fn batch_preprint_upgrade_preserves_key_expressions_and_requires_identity() {
        let before = "@article{mine, title={A paper}, author={Smith, Alice and Jones, Bob}, year={2024}, eprint={2401.12345v2}, journal={arXiv}, month=jan, custom={keep}}";
        assert_eq!(batch_id(before).as_deref(), Some("ARXIV:2401.12345"));
        let mut paper = s2_paper(serde_json::json!({
            "externalIds": {"ArXiv":"2401.12345", "DOI":"10.1234/published"},
            "title":"A paper", "venue":"ICML", "year":2024,
            "citationStyles":{"bibtex":"@inproceedings{remote, title={A paper}, author={Alice Smith and Bob Jones}, year={2024}, booktitle={ICML}}"}
        }));
        let checked = compare_batch(before, &paper).expect("identity safeguards passed");
        let after = checked.after.unwrap();
        assert!(after.starts_with("@inproceedings{mine,"));
        for kept in ["month = jan", "custom = {keep}", "doi = {10.1234/published}"] {
            assert!(after.contains(kept), "{kept}");
        }
        paper.title = "Different paper".into();
        assert!(compare_batch(before, &paper).is_none());
    }

    #[test]
    fn real_s2_conference_shape_without_doi_is_not_misclassified_as_a_journal() {
        // Shape observed from S2's ARXIV:1706.03762 endpoint: no DOI, and an
        // @Article citation containing booktitle rather than journal.
        let paper = s2_paper(serde_json::json!({
            "externalIds":{"ArXiv":"1706.03762"},
            "title":"Attention is All you Need", "venue":"Neural Information Processing Systems", "year":2017,
            "citationStyles":{"bibtex":"@Article{Vaswani2017AttentionIA, author={Ashish Vaswani and Noam Shazeer and Niki Parmar and Jakob Uszkoreit and Llion Jones and Aidan N. Gomez and Lukasz Kaiser and I. Polosukhin}, booktitle={Neural Information Processing Systems}, pages={5998-6008}, title={Attention is All you Need}, year={2017}}"}
        }));
        let before = "@article{vaswani2017, title={Attention Is All You Need}, author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, I.}, year={2017}, eprint={1706.03762}, journal={arXiv preprint arXiv:1706.03762}}";
        let checked = compare_batch(before, &paper).expect("valid S2 publication retained");
        assert_eq!(checked.status, "update");
        assert!(checked.after.unwrap().starts_with("@inproceedings{vaswani2017,"));
    }

    #[test]
    fn batch_respects_explicit_preprint_and_rejects_conflicting_bibtex_doi() {
        assert!(batch_id("@article{a, eprint={2401.12345}, pubstate={preprint}}").is_none());
        let before = "@article{mine, title={A paper}, author={A}, year={2024}, doi={10.1234/a}}";
        let paper = s2_paper(serde_json::json!({
            "externalIds":{"DOI":"10.1234/a"}, "title":"A paper",
            "citationStyles":{"bibtex":"@article{x,title={A paper},doi={10.1234/wrong}}"}
        }));
        assert!(compare_batch(before, &paper).is_none());
    }

    #[test]
    fn doi_batch_keeps_normalized_venue_and_metadata_fast_path() {
        let before = "@inproceedings{mine, title={A paper}, author={A}, year={2024}, booktitle={IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)}, doi={10.1234/a}}";
        let compare = |bibtex: &str| {
            let paper = s2_paper(serde_json::json!({
                "externalIds":{"DOI":"10.1234/a"}, "title":"A paper",
                "citationStyles":{"bibtex":bibtex}
            }));
            compare_batch(before, &paper)
        };
        let alias = "@inproceedings{x, title={A paper}, author={A}, year={2024}, booktitle={2024 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)}, doi={10.1234/a}}";
        assert!(compare(alias).is_some());

        let field_switch = "@article{x, title={A paper}, author={A}, year={2024}, journal={IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)}, doi={10.1234/a}}";
        assert!(compare(field_switch).is_some());

        let metadata = "@inproceedings{x, title={A paper}, author={A and B}, year={2024}, booktitle={IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)}, doi={10.1234/a}}";
        assert!(compare(metadata).is_none_or(|checked| checked.after.is_none()));
    }

    #[test]
    fn batch_requires_matching_authors_even_for_the_confirmed_arxiv_record() {
        let before = "@article{mine,title={A paper},author={Alice Smith and Bob Jones},year={2024},eprint={2401.12345},journal={arXiv}}";
        for (arxiv, author, accepted) in [
            ("2401.12345", "Alice Smith and Carol Jones", false),
            ("2401.99999", "Alice Smith and Bob Jones", false),
            ("2401.12345", "Alice Smith and Bob Jones", true),
        ] {
            let paper = s2_paper(serde_json::json!({
                "externalIds":{"ArXiv":arxiv}, "title":"A paper", "venue":"ICML", "year":2024,
                "citationStyles":{"bibtex":format!("@inproceedings{{x,title={{A paper}},author={{{author}}},year={{2024}},booktitle={{ICML}}}}")}
            }));
            assert_eq!(compare_batch(before, &paper).is_some(), accepted, "{arxiv} {author}");
        }
    }
}
