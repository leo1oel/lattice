//! The per-entry check. The entry is re-read from disk, looked up by its
//! strongest identity (a preprint's published version, else its DOI, else its
//! title), then locally cleaned and confirmed against publication records.
use super::*;
use serde_json::Value;

/// "checked" or a `citation_batch::Failure` code, as reported by `check_batch`.
const S2_BATCH_STATUSES: &str = "checked not_configured queue_busy daily_quota \
    upstream_rate_limit rate_limited unauthorized timeout network malformed unavailable";

pub fn check_entry(
    root: &Path, request: AuditEntry, s2_batch_status: Option<&str>,
) -> Result<AuditResult, String> {
    if s2_batch_status
        .is_some_and(|status| !S2_BATCH_STATUSES.split_whitespace().any(|known| known == status))
    {
        return Err("Invalid batch status.".into());
    }
    let before = match registered_entry(root, &request.path, &request.key)? {
        Some(value) if value == request.bibtex => value,
        Some(value) => {
            return Ok(result("conflict", "The bibliography entry changed after the scan.", value))
        }
        None => return Ok(result("conflict", "The bibliography entry no longer exists.", "")),
    };
    let checked = annotate_s2(lookup(root, before, s2_batch_status)?, s2_batch_status);
    Ok(publication::refine(cleanup_result(checked)))
}

fn lookup(root: &Path, before: String, s2: Option<&str>) -> Result<AuditResult, String> {
    let local = fields(&before);
    let arxiv = local.contains_key("eprint")
        || local.values().any(|v| v.to_ascii_lowercase().contains("arxiv"));
    if arxiv {
        if local.get("pubstate").is_some_and(|v| v.trim().eq_ignore_ascii_case("preprint")) {
            let message = "Kept as a preprint because pubstate is explicitly preprint.";
            return Ok(result("skipped", message, before));
        }
        let checked = upgrade_preprint(&before, s2)?;
        return Ok(proceedings::refine(&before, checked));
    }
    Ok(match local.get("doi").and_then(|v| normalize_doi(v)) {
        Some(doi) => lookup_doi(root, before, &doi, s2),
        None => lookup_title(before, &local, s2),
    })
}

/// A title lookup needs a title; authors alone are not an identity.
fn has_title(values: &BTreeMap<String, String>) -> bool {
    values.get("title").is_some_and(|title| !title.trim().is_empty())
}

fn metadata_unavailable(before: String, error: &str) -> AuditResult {
    result("unavailable", &format!("Metadata check incomplete: {error}"), before)
        .because("metadata_unavailable")
}

fn lookup_title(before: String, local: &BTreeMap<String, String>, s2: Option<&str>) -> AuditResult {
    if !has_title(local) {
        return result("skipped", "A title is required for a title lookup.", before)
            .because("missing_identity");
    }
    let title = clean(&local["title"]).replace(['{', '}'], "");
    let lookup = audit_command(s2).and_then(|command| {
        run_bibcite(&["get", &title, "--json", "--require-published"], Some(command))
    });
    match lookup {
        Ok(output) if is_clean_lookup_miss(&output) => {
            result("checked", "No matching metadata record was found.", before)
                .because("no_match")
                .with_sources(output_sources(&output))
        }
        Ok(output) => match parse_get_output(&output) {
            Ok(remote) => {
                let checked = compare_title_entry(&before, &remote);
                let sources = metadata_sources(&output, &checked);
                checked.with_sources(sources)
            }
            Err(error) => {
                metadata_unavailable(before, &error).with_sources(output_sources(&output))
            }
        },
        Err(error) => metadata_unavailable(before, &error),
    }
}

fn lookup_doi(root: &Path, before: String, doi: &str, s2: Option<&str>) -> AuditResult {
    let health = citation_health::lookup(root, [doi.to_string()]).remove(doi);
    let metadata =
        audit_command(s2).and_then(|command| run_bibcite(&["get", "--json", doi], Some(command)));
    let mut checked = match metadata.as_ref().map_err(Clone::clone).and_then(parse_get_output) {
        Ok(remote) => compare_doi_entry(&before, &remote),
        Err(error) => result("unavailable", &format!("Metadata check incomplete: {error}"), before),
    };
    if let Ok(output) = &metadata {
        checked.sources = metadata_sources(output, &checked);
    }
    checked.record_health(health);
    checked
}

/// Report the batch's Semantic Scholar outcome in place of bibcite's S2 row.
fn annotate_s2(mut checked: AuditResult, status: Option<&str>) -> AuditResult {
    if let Some(status) = status.filter(|status| *status != "checked") {
        let outcome =
            if status == "not_configured" { status.to_string() } else { format!("batch_{status}") };
        upsert_source(&mut checked.sources, SourceCheck::new("semanticscholar", outcome));
    }
    checked
}

fn upgrade_preprint(before: &str, s2_batch_status: Option<&str>) -> Result<AuditResult, String> {
    let unavailable = |message: &str| Ok(result("unavailable", message, before));
    let temp = scratch(Some(before))?;
    let path = temp.path.to_string_lossy();
    let output = match run_bibcite(
        &["upgrade", &path, "--no-tidy", "--include-published-arxiv"],
        Some(audit_command(s2_batch_status)?),
    ) {
        Ok(output) => output,
        Err(error) => return unavailable(&format!("Preprint check incomplete: {error}")),
    };
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if detail.is_empty() { "bibcite did not report a match" } else { &detail };
        return unavailable(&format!("Preprint check incomplete: {detail}"));
    }
    let Ok(report) = serde_json::from_slice::<Value>(&output.stdout) else {
        return unavailable("bibcite returned invalid upgrade JSON.");
    };
    let Some(record) = report.get("entries").and_then(|v| v.as_array()).and_then(|v| v.first())
    else {
        return Ok(result("skipped", "No upgrade check was performed for this entry.", before));
    };
    if record.get("matched").and_then(|v| v.as_bool()) != Some(true) {
        // A successful CLI exit can still contain incomplete provider lookups.
        // Retain safe, structured outcomes, not raw errors containing URLs/keys.
        return Ok(upgrade_miss(before, record).with_sources(output_sources(&output)));
    }
    let after = fs::read_to_string(&temp.path).map_err(|e| e.to_string())?;
    let spans = project::bibliography_entry_spans(&after);
    if spans.len() != 1 {
        return unavailable("Preprint check returned an incomplete or ambiguous result.");
    }
    let after = after[spans[0].1..spans[0].2].to_string();
    if renamed_paper(before, &after) {
        let mut checked = result(
            "unavailable",
            "The published record found for this entry describes a different paper.",
            before,
        )
        .because("identity_conflict");
        checked.candidate = Some(AuditCandidate {
            bibtex: after.clone(),
            changes: differing_fields(before, &after),
            reasons: vec!["title".into()],
        });
        checked.sources = metadata_sources(&output, &checked);
        return Ok(checked);
    }
    // `upgrade` preserves the input author field, so comparing that output to
    // the input cannot verify the authors. Dereference the candidate DOI and
    // check independent metadata before offering an applicable replacement.
    let candidate = fields(&after);
    let identity = match candidate.get("doi").and_then(|doi| published_doi(doi)) {
        Some(doi) => Ok(doi),
        None => candidate
            .get("title")
            .map(|title| clean(title).replace(['{', '}'], ""))
            .filter(|title| !title.is_empty())
            .ok_or_else(|| "The publication has no independently searchable title.".to_string()),
    };
    let remote_output = identity.and_then(|identity| {
        run_bibcite(
            &["get", &identity, "--json", "--require-published"],
            Some(audit_command(s2_batch_status)?),
        )
    });
    let mut checked = match remote_output.as_ref().map_err(Clone::clone).and_then(parse_get_output)
    {
        Ok(remote)
            if metadata_identity_matches(before, &remote)
                && metadata_identity_matches(&after, &remote) =>
        {
            let mut checked = merge_metadata(before, &remote, true);
            if checked.after.is_some() {
                checked.message = "A published version is available.".into();
            }
            checked
        }
        Ok(remote) => {
            let mut checked = identity_conflict(before, &remote);
            if let Some(candidate) = checked.candidate.as_mut() {
                candidate.reasons.extend(identity_conflicts(&after, &remote));
                candidate.reasons.sort();
                candidate.reasons.dedup();
            }
            checked
        }
        Err(_) => result(
            "unavailable",
            "Independent publication metadata was unavailable; no replacement is offered.",
            before,
        )
        .because("metadata_unavailable"),
    };
    checked.sources = metadata_sources(&output, &checked);
    if let Some(source) = record.get("source").and_then(|value| value.as_str()) {
        let selected = selected_source(source, &checked, &output);
        upsert_source(&mut checked.sources, selected);
    }
    if let Ok(remote_output) = &remote_output {
        for source in metadata_sources(remote_output, &checked) {
            upsert_source(&mut checked.sources, source);
        }
    }
    Ok(checked)
}

fn upgrade_miss(before: &str, record: &Value) -> AuditResult {
    let reason = record.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
    let checked = if reason == "no_published_version" {
        result("checked", "No published version was found.", before)
    } else {
        result("unavailable", "The published version could not be confirmed.", before)
    };
    checked.because(reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    #[ignore = "sets a process-wide bibcite override; run this subprocess smoke test alone"]
    fn native_am_radio_check_preserves_canonical_conference_venue() {
        use std::os::unix::fs::PermissionsExt;

        // Copied verbatim from .tmp/native-vlm-audit/original.bib. The mock is
        // a local bibcite process, so this exercises check_entry, the scratch file,
        // command setup, upgrade parsing, and proposal merging without network I/O.
        let before = "@inproceedings{ranzinger2024amradio,\n  archiveprefix = {arXiv},\n  author = {Mike Ranzinger and Greg Heinrich and Jan Kautz and Pavlo Molchanov},\n  booktitle = {IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)},\n  eprint = {2312.06709},\n  primaryclass = {cs.CV},\n  title = {{AM-RADIO:} Agglomerative Vision Foundation Model Reduce All Domains Into One},\n  url = {https://arxiv.org/abs/2312.06709},\n  year = {2024}\n}";
        let project = TestProject::with_bib(before);
        let root = &project.root;
        let mock = project.parent.join("mock-bibcite");
        let published = before
            .replace("  year =", "  doi = {10.1234/amradio},\n  pages = {12830--12840},\n  year =");
        let remote = serde_json::json!({"bibtex": published}).to_string();
        fs::write(
            &mock,
            format!("#!/bin/sh\nif [ \"$1\" = get ]; then\nprintf '%s\\n' '{remote}'\nexit 0\nfi\ncat >\"$2\" <<'EOF'\n{published}\nEOF\nprintf '%s\\n' '{{\"entries\":[{{\"matched\":true}}]}}'\n"),
        )
        .unwrap();
        fs::set_permissions(&mock, fs::Permissions::from_mode(0o700)).unwrap();
        unsafe { std::env::set_var("LATTICE_BIBCITE_BIN", &mock) };
        let entry = |key: &str, title: &str, bibtex: &str| AuditEntry {
            path: "references.bib".into(),
            key: key.into(),
            title: title.into(),
            bibtex: bibtex.into(),
            issues: vec![],
        };
        let checked =
            check_entry(root, entry("ranzinger2024amradio", "AM-RADIO", before), None).unwrap();
        // The independent record confirms the same arXiv ID and title. Its
        // corrected authors may now replace the upgrade's preserved input list.
        let script = fs::read_to_string(&mock).unwrap();
        fs::write(&mock, script.replace(&remote, &remote.replace("Greg Heinrich", "Someone Else")))
            .unwrap();
        let corrected = upgrade_preprint(before, None).unwrap();
        // A publication without a DOI must still be independently checked by
        // title. The mock rejects any lookup that allows a preprint fallback.
        let no_doi = published.replace("  doi = {10.1234/amradio},\n", "");
        let no_doi_json = serde_json::json!({"bibtex": no_doi, "source": "dblp"}).to_string();
        fs::write(&mock, format!("#!/bin/sh\nif [ \"$1\" = get ]; then\ncase \"$*\" in *--require-published*) ;; *) exit 3;; esac\nprintf '%s\\n' '{no_doi_json}'\nexit 0\nfi\ncat >\"$2\" <<'EOF'\n{no_doi}\nEOF\nprintf '%s\\n' '{{\"entries\":[{{\"matched\":true,\"source\":\"dblp\"}}]}}'\n")).unwrap();
        let verified = upgrade_preprint(before, None).unwrap();
        assert!(verified.after.is_some());
        assert!(verified
            .sources
            .iter()
            .any(|row| row.source == "dblp" && row.outcome == "selected"));

        let title_only =
            "@misc{titleonly, title={Safe Paper}, author={Alice Smith and Bob Jones}, year={2024}}";
        project.write_bib(title_only);
        let title_remote = "@inproceedings{remote, title={Safe Paper}, author={Smith, Alice and Jones, Bob}, year={2024}, booktitle={ICLR}}";
        let title_json = serde_json::json!({"bibtex": title_remote, "source":"dblp"}).to_string();
        fs::write(&mock, format!("#!/bin/sh\ncase \"$*\" in *--require-published*) ;; *) exit 3;; esac\nprintf '%s\\n' '{title_json}'\n")).unwrap();
        let request = || entry("titleonly", "Safe Paper", title_only);
        let title_checked = check_entry(root, request(), None).unwrap();
        assert_eq!(title_checked.status, "update");
        assert!(title_checked.after.as_ref().unwrap().starts_with("@inproceedings{titleonly,"));
        assert!(!title_checked.changes.iter().any(|change| change.field == "author"));
        for (code, message, reason) in [
            (2, "[bibcite] No match found anywhere for: Safe Paper", "no_match"),
            (3, "[bibcite] No match found anywhere for: Safe Paper", "metadata_unavailable"),
            (3, "[openalex] host not found", "metadata_unavailable"),
            (2, "[dblp-fuzzy] transient failure: request timed out\n[bibcite] No match found anywhere for: Safe Paper", "metadata_unavailable"),
        ] {
            fs::write(&mock, format!("#!/bin/sh\nprintf '%s\\n' '{message}' >&2\nexit {code}\n"))
                .unwrap();
            let outcome = check_entry(root, request(), None).unwrap();
            assert_eq!(outcome.publication_reason.as_deref(), Some(reason));
            assert!(outcome.after.is_none());
        }
        let unavailable = upgrade_preprint(before, None).unwrap();
        assert!(unavailable.after.is_none());
        let title_after = title_checked.after.as_ref().unwrap();
        apply(root, "references.bib", "titleonly", title_only, title_after).unwrap();
        assert!(project.read_bib().contains("booktitle = {ICLR}"));
        unsafe { std::env::remove_var("LATTICE_BIBCITE_BIN") };
        assert_eq!(corrected.status, "update");
        assert!(fields(corrected.after.as_ref().unwrap())["author"].contains("Someone Else"));
        let after = checked.after.expect("mocked published metadata is proposed");
        assert_eq!(
            clean(fields(&after).get("booktitle").unwrap()),
            "IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)"
        );
        assert_eq!(clean(fields(&after).get("pages").unwrap()), "12830--12840");
    }

    #[test]
    fn title_identity_and_preprint_misses_stay_distinct() {
        // Authors are not part of the lookup identity: a titled entry without
        // them is still looked up (and then fails the author check).
        for entry in [
            "@misc{x,title={Only title}}",
            "@inproceedings{shinn2023reflexion,title={Reflexion: Language Agents with Verbal Reinforcement Learning},booktitle={NeurIPS},year={2023}}",
        ] {
            assert!(has_title(&fields(entry)), "{entry}");
        }
        // Only a definite "no published version" counts as checked.
        for (reason, status) in [
            ("no_published_version", "checked"),
            ("sources_unavailable", "unavailable"),
            ("identity_conflict", "unavailable"),
            ("ambiguous", "unavailable"),
            ("unexpected", "unavailable"),
        ] {
            let checked = upgrade_miss("entry", &serde_json::json!({ "reason": reason }));
            assert_eq!(checked.status, status, "{reason}");
        }
    }

    #[test]
    fn publication_diagnostics_preserve_partial_results_without_raw_errors() {
        for (detail, expected) in [
            ("batch result reused", "batch_reused"),
            ("batch unavailable", "unavailable"),
            ("disabled: public literature service queue_busy", "queue_busy"),
            ("disabled: public literature service daily_quota", "daily_quota"),
            ("disabled: public literature service upstream_rate_limit", "rate_limited"),
        ] {
            let sources = publication_sources(&format!("[semanticscholar] {detail}"));
            assert_eq!(sources.len(), 1);
            assert_eq!(sources[0].outcome, expected);
        }
        let sources = publication_sources(concat!(
            "[upgrade] matching: Private title\n",
            "[crossref] no publication found\n",
            "[semanticscholar] disabled for the rest of this run: rate-limited (429)\n",
            "[dblp] transient failure for this entry: dblp unreachable (RemoteProtocolError)\n",
            "[openalex] error: ReadTimeout: https://example.org?api_key=secret\n",
            "[unpaywall] disabled for the rest of this run: server error (500)\n",
            "[googlescholar] disabled for the rest of this run: captcha/429\n",
        ));
        let pairs: Vec<_> =
            sources.iter().map(|s| (s.source.as_str(), s.outcome.as_str())).collect();
        let mut expected = vec![
            ("crossref", "no_match"),
            ("dblp", "connection_failed"),
            ("googlescholar", "blocked"),
            ("openalex", "timeout"),
            ("semanticscholar", "rate_limited"),
            ("unpaywall", "server_error"),
        ];
        assert_eq!(pairs, expected);
        let result = upgrade_miss("entry", &serde_json::json!({"reason":"sources_unavailable"}))
            .with_sources(sources);
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("publicationReason"));
        assert!(!json.contains("secret"));
        assert!(!json.contains("Private title"));
        assert!(!result.message.contains("sources_unavailable"));
        assert_eq!(result.status, "unavailable");

        // A batch failure replaces only the S2 diagnostic.
        let annotated = annotate_s2(result, Some("upstream_rate_limit"));
        expected.retain(|(source, _)| *source != "semanticscholar");
        expected.push(("semanticscholar", "batch_upstream_rate_limit"));
        let pairs: Vec<_> =
            annotated.sources.iter().map(|s| (s.source.as_str(), s.outcome.as_str())).collect();
        assert_eq!(pairs, expected);
    }

    /// Explicit opt-in network smoke test: copy a bibliography into a disposable
    /// project and exercise the same scan/check functions as the native commands.
    #[test]
    #[ignore = "requires LATTICE_AUDIT_LIVE_BIB and LATTICE_AUDIT_LIVE_OUTPUT; calls publication services"]
    fn live_bibliography_audit_on_isolated_copy() {
        let source = std::env::var("LATTICE_AUDIT_LIVE_BIB").unwrap();
        let output = std::env::var("LATTICE_AUDIT_LIVE_OUTPUT").unwrap();
        let original = fs::read_to_string(&source).unwrap();
        let project = TestProject::with_bib(&original);
        let root = &project.root;
        let scan = scan(root).unwrap();
        let started = std::time::Instant::now();
        let mut results = Vec::new();
        for entries in scan.entries.chunks(2) {
            std::thread::scope(|scope| {
                let tasks: Vec<_> = entries
                    .iter()
                    .map(|entry| {
                        scope.spawn(move || check_entry(root, entry.clone(), None).unwrap())
                    })
                    .collect();
                for task in tasks {
                    results.push(task.join().unwrap());
                }
            });
            eprintln!("Checked {}/{} entries", results.len(), scan.entries.len());
        }
        assert_eq!(project.read_bib(), original);
        for (entry, result) in scan.entries.iter().zip(&results) {
            if let Some(after) = &result.after {
                apply(root, &entry.path, &entry.key, &result.before, after).unwrap();
                assert_eq!(
                    registered_entry(root, &entry.path, &entry.key).unwrap().as_deref(),
                    Some(after.as_str())
                );
            }
        }
        fs::write(
            output,
            serde_json::to_vec_pretty(&serde_json::json!({
                "scan": scan, "results": results, "elapsedSeconds": started.elapsed().as_secs_f64()
            }))
            .unwrap(),
        )
        .unwrap();
    }
}
