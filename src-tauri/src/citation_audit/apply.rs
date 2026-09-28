//! Writing one accepted replacement. The entry must still match the preview
//! it was computed from and still describe the same paper; the write goes
//! through the project's checked citation transaction.
use super::*;

pub fn apply(root: &Path, path: &str, key: &str, before: &str, after: &str) -> Result<(), String> {
    let sources = audit_sources(root)?;
    let whole = registered_source(&sources, path)?;
    let (start, end) = entry_span(whole, key)?.ok_or("The bibliography entry no longer exists.")?;
    if &whole[start..end] != before {
        return Err("The bibliography entry changed after the preview. Scan it again.".into());
    }
    if single_entry_key(after).as_deref() != Some(key) {
        return Err(
            "The proposed replacement must be exactly one entry with the same citation key.".into(),
        );
    }
    // Evidence independent of the title: a DOI that another entry already
    // claims means this proposal duplicates that paper rather than correcting
    // this one, which is the shape a wrong publication match takes.
    if let Some(conflict) = doi_owned_by_another_entry(&sources, path, key, after) {
        return Err(format!(
            "That update would give this entry the DOI already used by '{conflict}', \
             so it describes a different paper. Check the record before applying it."
        ));
    }
    if !metadata_identity_matches(before, after) && !is_safe_local_cleanup(before, after) {
        return Err("The proposed metadata conflicts with this reference's identity. Check the title, authors, identifiers, year, and venue manually.".into());
    }
    let mut next = whole.to_string();
    next.replace_range(start..end, after);
    // Audit writes bypass editor autosave formatting. Normalize only gaps so
    // pending entries still match the snapshots used by sequential bulk apply.
    // Reverse traversal keeps the original byte offsets valid after each edit.
    let separator = if whole.contains("\r\n") { "\r\n\r\n" } else { "\n\n" };
    let entries = project::bibliography_entry_spans(&next);
    for pair in entries.windows(2).rev() {
        let (_, left_start, left_end) = &pair[0];
        let (_, right_start, right_end) = &pair[1];
        if complete_entry(&next[*left_start..*left_end])
            && complete_entry(&next[*right_start..*right_end])
            && next[*left_end..*right_start]
                .bytes()
                .all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        {
            next.replace_range(*left_end..*right_start, separator);
        }
    }
    project::apply_citation_transaction_checked(
        root,
        "Audit bibliography entry",
        vec![(path.to_string(), whole.to_string(), next)],
    )?;
    Ok(())
}

/// The key of a different entry that already carries `after`'s DOI, if any.
fn doi_owned_by_another_entry(
    sources: &[(String, String)], path: &str, key: &str, after: &str,
) -> Option<String> {
    let doi = fields(after).get("doi").and_then(|v| normalize_doi(v))?;
    sources.iter().find_map(|(other_path, source)| {
        project::bibliography_entry_spans(source)
            .into_iter()
            .find(|(other_key, start, end)| {
                !(other_path == path && other_key == key)
                    && fields(&source[*start..*end])
                        .get("doi")
                        .and_then(|v| normalize_doi(v))
                        .is_some_and(|v| v == doi)
            })
            .map(|(other_key, _, _)| other_key)
    })
}

/// The entry's current text in a registered bibliography, if it still exists.
pub(super) fn registered_entry(
    root: &Path, path: &str, key: &str,
) -> Result<Option<String>, String> {
    let sources = audit_sources(root)?;
    let source = registered_source(&sources, path)?;
    Ok(entry_span(source, key)?.map(|(start, end)| source[start..end].to_string()))
}

fn registered_source<'a>(sources: &'a [(String, String)], path: &str) -> Result<&'a str, String> {
    let source = sources
        .iter()
        .find(|(registered, _)| registered == path)
        .map(|(_, source)| source.as_str())
        .ok_or_else(|| "That bibliography is not registered in this project.".to_string())?;
    if has_conflict_markers(source) {
        return Err(UNRESOLVED_CONFLICT.into());
    }
    Ok(source)
}

/// Duplicate keys make the target ambiguous, so they are an error, not a guess.
fn entry_span(source: &str, key: &str) -> Result<Option<(usize, usize)>, String> {
    let mut matches =
        project::bibliography_entry_spans(source).into_iter().filter(|(k, _, _)| k == key);
    let first = matches.next();
    if matches.next().is_some() {
        return Err(
            "Duplicate citation key in this file; fix it before checking or applying updates."
                .into(),
        );
    }
    Ok(first.map(|(_, start, end)| (start, end)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_overleaf_conflicted_bibliography_is_reported_once_instead_of_as_duplicates() {
        // The shape Overleaf sync left behind when it could not merge
        // references.bib: diff3 markers around the whole file, plus the
        // untouched local copy saved beside it.
        let project = TestProject::new();
        let root = &project.root;
        let entry =
            "@misc{doe2020,\n  title = {A Study},\n  author = {Doe, Jane},\n  year = {2020},\n}";
        let other = "@misc{roe2021,\n  title = {Another Study},\n  author = {Roe, Rick},\n  year = {2021},\n}";
        let local = format!("{entry}\n\n{other}\n");
        let conflicted = format!(
            "<<<<<<< ours\n{entry}\n\n{other}\n||||||| original\n{entry}\n=======\n>>>>>>> theirs\n"
        );
        project.write_bib(&conflicted);
        fs::write(root.join("references (local conflict 20260926-1808).bib"), &local).unwrap();

        let conflicted_scan = scan(root).unwrap();
        assert!(conflicted_scan.entries.is_empty(), "{:?}", conflicted_scan.entries);
        assert_eq!(conflicted_scan.issues.len(), 1, "{:?}", conflicted_scan.issues);
        assert_eq!(conflicted_scan.issues[0].path, "references.bib");
        assert_eq!(conflicted_scan.issues[0].message, UNRESOLVED_CONFLICT);

        // A check or update started before the sync wrote the markers must
        // stop with the same explanation, not a duplicate-key error.
        assert_eq!(
            registered_entry(root, "references.bib", "doe2020").unwrap_err(),
            UNRESOLVED_CONFLICT
        );
        assert_eq!(
            apply(root, "references.bib", "doe2020", entry, entry).unwrap_err(),
            UNRESOLVED_CONFLICT
        );
        assert_eq!(project.read_bib(), conflicted);

        // Once resolved, the backup copy is still not treated as a source.
        project.write_bib(&local);
        let resolved_scan = scan(root).unwrap();
        assert_eq!(resolved_scan.entries.len(), 2);
        assert!(resolved_scan.issues.is_empty(), "{:?}", resolved_scan.issues);
    }

    #[test]
    fn sequential_apply_normalizes_entry_gaps_without_invalidating_previews() {
        for newline in ["\n", "\r\n"] {
            for gap in ["", " ", newline, &newline.repeat(4)] {
                let one = "@article{one,title={One},author={Alice},year={2024}}";
                let two = "@book{two,title={Two},author={Bob},year={2023}}";
                let three = "@misc{three,title={Three},note={Keep {NASA}}}";
                let tail = format!("{newline}% Keep this comment{newline}@string{{J = \"Journal\"}}{newline}@misc{{draft,title={{unfinished");
                let project = TestProject::with_bib(&format!("{one}{gap}{two}{gap}{three}{tail}"));
                let after_one = one.replace("year={2024}", "year={2024},pages={1--9}");
                let after_two = two.replace("year={2023}", "year={2023},publisher={Press}");
                apply(&project.root, "references.bib", "one", one, &after_one).unwrap();
                // Bulk apply reuses the original previews. Formatting must not
                // change the next entry's bytes and cause a snapshot conflict.
                apply(&project.root, "references.bib", "two", two, &after_two).unwrap();
                assert_eq!(
                    project.read_bib(),
                    format!(
                        "{after_one}{newline}{newline}{after_two}{newline}{newline}{three}{tail}"
                    ),
                    "gap={gap:?} newline={newline:?}"
                );
            }
        }
    }

    #[test]
    fn apply_is_snapshot_checked_and_preserves_other_entries() {
        let before = "@article{one, title={Old}, author={A}, year={2020}}";
        let other = "@article{two, title={Other}, author={B}, year={2021}}";
        let project = TestProject::with_bib(&format!("{before}\n\n{other}\n"));
        let (root, path) = (&project.root, "references.bib");
        let after = "@article{one, title={Old}, author={A}, year={2020}, pages={1--9}}";
        let different = after.replace("title={Old}", "title={Different paper}");
        assert!(apply(root, path, "one", before, &different).is_err());
        apply(root, path, "one", before, after).unwrap();
        let contents = project.read_bib();
        assert!(contents.contains(after));
        assert!(contents.contains(other));
        assert!(apply(root, path, "one", before, after).unwrap_err().contains("changed"));
        assert!(root.join(".research/history").is_dir());
    }

    #[test]
    fn apply_rejects_a_doi_already_claimed_by_another_entry() {
        let gmt = "@article{chen2025gmt, title={GMT: General Motion Tracking for Humanoid Whole-Body Control}, author={Zixuan Chen}, year={2025}}";
        let sonic = "@article{luo2026sonic, title={SONIC: Supersizing Motion Tracking for Natural Humanoid Whole-Body Control}, author={Zhengyi Luo}, year={2026}, doi={10.1126/scirobotics.aed4592}}";
        let project = TestProject::with_bib(&format!("{gmt}\n\n{sonic}\n"));
        let proposed = "@article{chen2025gmt, title={SONIC: Supersizing motion tracking for natural humanoid whole-body control}, author={Zixuan Chen}, year={2026}, doi={10.1126/SCIROBOTICS.AED4592}}";
        let error =
            apply(&project.root, "references.bib", "chen2025gmt", gmt, proposed).unwrap_err();
        assert!(error.contains("luo2026sonic"), "{error}");
        assert_eq!(project.read_bib(), format!("{gmt}\n\n{sonic}\n"));
    }
}
