//! Whether two records describe the same paper. A metadata source may correct
//! a record's venue, pages or type, but never who wrote it or what it is called.
use super::*;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

/// Automatic replacement requires the same normalized title and full, ordered
/// author list. Equivalent BibTeX name order and TeX accent formatting remain
/// valid, but metadata lookup must not silently correct author identity.
pub(crate) fn metadata_identity_matches(before: &str, remote: &str) -> bool {
    identity_conflicts(before, remote).is_empty()
}

/// The identity fields on which `remote` disagrees with `before`.
pub(super) fn identity_conflicts(before: &str, remote: &str) -> Vec<String> {
    let remote = remote.trim();
    if single_entry_key(remote).is_none() {
        return vec!["record".into()];
    }
    let mut reasons: Vec<String> = Vec::new();
    // A same-title paper is not a published version of an explicit book or
    // chapter. Keep this separate from legitimate preprint/type corrections.
    if matches!(
        entry_type(before.trim()).as_str(),
        "book" | "booklet" | "collection" | "inbook" | "incollection"
    ) && matches!(
        entry_type(remote).as_str(),
        "article" | "inproceedings" | "conference" | "proceedings"
    ) {
        reasons.push("ENTRYTYPE".into());
    }
    let (local, other) = (fields(before), fields(remote));
    let title = normalize_title(&field_value(&local, "title"));
    let remote_title = normalize_title(&field_value(&other, "title"));
    if remote_title.is_empty() || (!title.is_empty() && title != remote_title) {
        reasons.push("title".into());
    }
    let doi = |values: &BTreeMap<String, String>| {
        ["doi", "url"].into_iter().find_map(|name| values.get(name).and_then(|v| normalize_doi(v)))
    };
    let (local_doi, remote_doi) = (doi(&local), doi(&other));
    let same_arxiv = project::bibliography_arxiv_id(&local)
        .zip(project::bibliography_arxiv_id(&other))
        .map(|(a, b)| unversioned_arxiv(&a) == unversioned_arxiv(&b));
    let same_identifier = local_doi.as_ref().is_some_and(|doi| Some(doi) == remote_doi.as_ref())
        || same_arxiv == Some(true);
    if title.is_empty() && !same_identifier {
        reasons.push("title".into());
    }
    if let Some(doi) = local_doi.as_deref().filter(|v| !v.starts_with(ARXIV_DOI_PREFIX)) {
        if remote_doi.as_deref() != Some(doi) {
            reasons.push("doi".into());
        }
    }
    if same_arxiv == Some(false) {
        reasons.push("arxiv".into());
    }
    let year = |values: &BTreeMap<String, String>| field_value(values, "year").parse::<u32>().ok();
    if year(&local).zip(year(&other)).is_some_and(|(a, b)| a.abs_diff(b) > 2) {
        reasons.push("year".into());
    }
    // ACL Anthology encodes Findings in the DOI. Never accept a source's
    // lossy conference normalization as evidence that this is the main track.
    let remote_venue = ["booktitle", "journal", "journaltitle"]
        .into_iter()
        .find_map(|name| other.get(name))
        .map(|venue| normalize_title(venue))
        .unwrap_or_default();
    if remote_doi
        .as_deref()
        .is_some_and(|doi| doi.starts_with("10.18653/v1/") && doi.contains(".findings-"))
        && !remote_venue.split_whitespace().any(|word| word == "findings")
    {
        reasons.push("venue".into());
    }
    let local_authors = author_names(&field_value(&local, "author"));
    let remote_authors = author_names(&field_value(&other, "author"));
    if local_authors.is_empty()
        || local_authors != remote_authors
        || has_repeated_authors(&remote_authors)
    {
        reasons.push("author".into());
    }
    reasons
}

/// A non-applicable result that shows the conflicting record for review.
pub(super) fn identity_conflict(before: &str, remote: &str) -> AuditResult {
    let mut checked = result("unavailable", "Paper identity could not be confirmed. Review the candidate manually; no replacement is offered.", before).because("identity_conflict");
    checked.candidate = Some(AuditCandidate {
        bibtex: remote.into(),
        changes: differing_fields(before, remote),
        reasons: identity_conflicts(before, remote),
    });
    checked
}

pub(super) fn compare_doi_entry(before: &str, remote: &str) -> AuditResult {
    let doi = |entry: &str| fields(entry).get("doi").and_then(|v| normalize_doi(v));
    let local = doi(before);
    if local.is_none() || local != doi(remote) {
        return identity_conflict(before, remote);
    }
    compare_title_entry(before, remote)
}

pub(super) fn compare_title_entry(before: &str, remote: &str) -> AuditResult {
    if !metadata_identity_matches(before, remote) {
        return identity_conflict(before, remote);
    }
    merge_metadata(before, remote, false)
}

/// The short name a title gives itself before a colon — "GMT" in "GMT: General
/// Motion Tracking for Humanoid Whole-Body Control". A longer head introduces
/// an ordinary subtitle instead of naming the work, so it does not count.
fn title_acronym(title: &str) -> Option<String> {
    let (head, rest) = title.split_once(':')?;
    if rest.trim().is_empty() || head.split_whitespace().count() > 3 {
        return None;
    }
    let key =
        head.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase();
    (!key.is_empty()).then_some(key)
}

/// Whether a proposed record renamed the paper, which means it is not the same
/// paper at all.
///
/// The preprint-upgrade path is the one place a provider may legitimately
/// return a title different from the one we asked about, so unlike the batch
/// path it cannot require the titles to be equal. It can still require this:
/// a camera-ready version rewords its description, but it does not give itself
/// a new name. Without the check, a provider matching "GMT: General Motion
/// Tracking for Humanoid Whole-Body Control" onto "SONIC: Supersizing Motion
/// Tracking for Natural Humanoid Whole-Body Control" — six of eight shared
/// significant words — silently rewrites the entry into someone else's paper.
pub(super) fn renamed_paper(before: &str, after: &str) -> bool {
    let name_of =
        |entry: &str| fields(entry).get("title").and_then(|title| title_acronym(&clean(title)));
    matches!((name_of(before), name_of(after)), (Some(a), Some(b)) if a != b)
}

pub(super) fn author_names(authors: &str) -> Vec<Vec<String>> {
    // Decode conventional TeX accents only for comparison. Keep the original
    // field when equivalent, and never discard accents or unknown commands.
    static ACCENT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r#"\\([`'"^~=.uvHckrbd])(?:\s*\{\s*([A-Za-z])\s*\}|\s+([A-Za-z])|([A-Za-z]))"#,
        )
        .unwrap()
    });
    let decoded = ACCENT.replace_all(authors, |captures: &regex::Captures<'_>| {
        // A letter command requires a delimiter: \unknown is not \u nknown.
        if captures.get(4).is_some() && captures[1].chars().all(|c| c.is_ascii_alphabetic()) {
            return captures[0].to_string();
        }
        let mark = match &captures[1] {
            "`" => '\u{0300}',
            "'" => '\u{0301}',
            "^" => '\u{0302}',
            "~" => '\u{0303}',
            "=" => '\u{0304}',
            "u" => '\u{0306}',
            "." => '\u{0307}',
            "\"" => '\u{0308}',
            "r" => '\u{030a}',
            "H" => '\u{030b}',
            "v" => '\u{030c}',
            "d" => '\u{0323}',
            "c" => '\u{0327}',
            "k" => '\u{0328}',
            "b" => '\u{0331}',
            _ => unreachable!("accent regex restricts the command"),
        };
        let base = (2..=4).find_map(|group| captures.get(group)).unwrap().as_str();
        format!("{base}{mark}")
    });
    normalize_text(&decoded.replace(['{', '}'], ""))
        .nfc()
        .collect::<String>()
        .split(" and ")
        .map(|name| {
            let mut words = name
                .split(|c: char| !c.is_alphanumeric() && !is_combining_mark(c) && c != '\\')
                .filter(|word| !word.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            words.sort();
            words
        })
        .filter(|name| !name.is_empty())
        .collect()
}

pub(super) fn has_repeated_authors(authors: &[Vec<String>]) -> bool {
    authors.iter().enumerate().any(|(index, name)| authors[..index].contains(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equivalent_kernelbench_authors_preserve_local_bibtex() {
        let authors = r"Ouyang, Anne and Guo, Simon and Arora, Simran and Zhang, Alex L and Hu, William and R{\'e}, Christopher and Mirhoseini, Azalia";
        let remote_authors = "Anne Ouyang and Simon Guo and Simran Arora and Alex L. Zhang and William Hu and Christopher Ré and Azalia Mirhoseini";
        let before = format!(
            "@misc{{kernelbench, title={{KernelBench}}, author={{{authors}}}, year={{2025}}}}"
        );
        let remote = format!("@misc{{remote, title={{KernelBench}}, author={{{remote_authors}}}, year={{2025}}, doi={{10.1234/kernelbench}}}}");
        let accepted = compare_title_entry(&before, &remote);
        assert_eq!(accepted.status, "update");
        assert_eq!(fields(&accepted.after.unwrap())["author"], authors);
        assert!(!accepted.changes.iter().any(|change| change.field == "author"));
        assert!(!differing_fields(&before, &remote).iter().any(|change| change.field == "author"));
        let corrected = compare_title_entry(&before, &remote.replace("Simon Guo", "Sam Guo"));
        assert!(corrected.after.is_none());
        assert_eq!(corrected.publication_reason.as_deref(), Some("identity_conflict"));
        assert!(corrected.candidate.unwrap().reasons.contains(&"author".into()));
    }

    #[test]
    fn author_accents_are_equivalent_without_erasing_identity() {
        for tex in [
            r"R{\'e}, Christopher",
            r"R\'{e}, Christopher",
            r"R\'e, Christopher",
            "Christopher Re\u{301}",
        ] {
            assert_eq!(author_names(tex), author_names("Christopher Ré"), "{tex}");
        }
        assert_eq!(author_names(r#"M{\"u}ller, Alice"#), author_names("Alice Müller"));
        assert_eq!(author_names(r"\v{S}imek, Bob"), author_names("Bob Šimek"));
        assert_ne!(author_names("Christopher Ré"), author_names("Christopher Re"));
        assert_ne!(author_names(r"\bad{e}, Alice"), author_names("Alice Bade"));
        assert_ne!(author_names(r"\unknown, Alice"), author_names("Alice ŭnknown"));
    }

    #[test]
    fn books_cannot_be_replaced_by_same_title_articles() {
        let before = "@book{goodfellow2016deep, title={Deep learning}, author={Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron and Bengio, Yoshua}, volume={1}, year={2016}, publisher={MIT Press}}";
        let wrong = "@article{lecun2015deep, title={Deep learning}, author={Yann LeCun and Yoshua Bengio and Geoffrey E. Hinton}, year={2015}, journal={Nature}, doi={10.1038/nature14539}, eprint={1807.07987}, archiveprefix={arXiv}}";
        // Even matching authors and a nearby year must not turn an explicit book
        // into a paper: bibliographic identity includes this type boundary.
        let same_authors = wrong.replace(
            "Yann LeCun and Yoshua Bengio and Geoffrey E. Hinton",
            "Ian Goodfellow and Yoshua Bengio and Aaron Courville and Yoshua Bengio",
        );
        for remote in [wrong, same_authors.as_str()] {
            let rejected = compare_title_entry(before, remote);
            assert!(rejected.after.is_none());
            let candidate = rejected.candidate.unwrap();
            assert!(candidate.reasons.contains(&"ENTRYTYPE".into()));
            assert!(candidate.changes.iter().any(|change| change.field == "ENTRYTYPE"
                && change.before == "book"
                && change.after == "article"));
            let with_id = before.replacen(", title=", ", doi={10.1234/collision}, title=", 1);
            let remote_with_id = remote.replace("10.1038/nature14539", "10.1234/collision");
            assert!(compare_doi_entry(&with_id, &remote_with_id).after.is_none());
        }
    }

    #[test]
    fn doi_lookup_still_rejects_conflicting_paper_metadata() {
        let before = "@article{mine,title={A specific paper},author={Alice Smith and Bob Jones},year={2024},journal={Journal One},doi={10.1234/a}}";
        for remote in [
            before.replace("A specific paper", "A different paper"),
            before.replace("10.1234/a", "10.1234/other"),
            before.replace("2024", "2014"),
            format!("{before}\n{before}"),
        ] {
            let checked = compare_doi_entry(before, &remote);
            assert!(checked.after.is_none(), "unsafe proposal: {remote}");
            assert_eq!(checked.status, "unavailable");
        }
        let missing_author = before.replace("author={Alice Smith and Bob Jones},", "");
        assert!(compare_doi_entry(&missing_author, before).after.is_none());
        let corrosion = before.replace("Journal One", "Corrosion Science");
        assert!(compare_doi_entry(&corrosion, before).after.is_some());
        let reordered_names =
            before.replace("Alice Smith and Bob Jones", "Smith, Alice and Jones, Bob");
        assert_ne!(compare_doi_entry(&reordered_names, before).status, "unavailable");
    }

    #[test]
    fn confirmed_identifiers_do_not_override_author_identity() {
        for id in ["doi={10.1234/exact}", "eprint={2401.12345}"] {
            let before = format!("@article{{mine,title={{A specific paper}},author={{Smith, Alice and Jones, Bob}},year={{2024}},journal={{Journal One}},{id}}}");
            let remote = before.replace(
                "Smith, Alice and Jones, Bob",
                "Bob Jones and Alicia Smith and Carol Miller",
            );
            let checked = compare_title_entry(&before, &remote);
            assert!(checked.after.is_none());
            assert!(checked.candidate.unwrap().reasons.contains(&"author".into()));
            let without_id = before.replace(&format!(",{id}"), "");
            let wrong_id = remote
                .replace("10.1234/exact", "10.1234/other")
                .replace("2401.12345", "2401.99999");
            for (local, remote) in [
                (without_id.as_str(), remote.clone()),
                (before.as_str(), wrong_id),
                (before.as_str(), remote.replace("A specific paper", "Another paper")),
            ] {
                assert!(compare_title_entry(local, &remote).after.is_none(), "{remote}");
            }
        }
    }

    /// A title lookup accepts a record only with the same title and year and
    /// the equivalent full, ordered author list: truncated (`others`),
    /// repeated, missing, renamed, reordered or dropped authors are all
    /// identity conflicts.
    #[test]
    fn title_matches_require_title_year_and_the_equivalent_full_ordered_author_list() {
        let refine_authors = "Aman Madaan and Niket Tandon and Prakhar Gupta and Skyler Hallinan";
        let refine = format!("@inproceedings{{remote,title={{Self-Refine: Iterative Refinement with Self-Feedback}},author={{{refine_authors}}},year={{2023}},booktitle={{NeurIPS}}}}");
        let reflexion = "@inproceedings{shinn2023reflexion,title={Reflexion: Language Agents with Verbal Reinforcement Learning},author={Shinn, Noah and Cassano, Federico and Berman, Edward and Gopinath, Ashwin and Narasimhan, Karthik and Yao, Shunyu},booktitle={NeurIPS},year={2023}}";
        let reflexion_remote = "@inproceedings{source,title={Reflexion: language agents with verbal reinforcement learning},author={Noah Shinn and Federico Cassano and Ashwin Gopinath and Karthik Narasimhan and Shunyu Yao},booktitle={NeurIPS},year={2023}}";
        let react = "@inproceedings{yao2023react,title={{ReAct}: Synergizing Reasoning and Acting in Language Models},author={Yao, Shunyu and Zhao, Jeffrey and Yu, Dian and Du, Nan and Shafran, Izhak and Narasimhan, Karthik and Cao, Yuan},year={2023},booktitle={ICLR}}";
        let react_remote = "@inproceedings{remote,title={ReAct: Synergizing Reasoning and Acting in Language Models},author={Shunyu Yao and Jeffrey Zhao and Dian Yu and Nan Du and Izhak Shafran and Karthik Narasimhan and Yuan Cao},year={2023},booktitle={ICLR}}";
        let safe = "@inproceedings{x, title={Safe Paper}, author={Smith, Alice and Jones, Bob}, year={2024}, booktitle={ICLR}}";
        let good = "@inproceedings{r, title={Safe Paper}, author={Alice Smith and Bob Jones}, year={2024}, booktitle={ICLR}, doi={10.1234/good}}";
        let mut cases = vec![
            (safe.to_string(), good.to_string(), None),
            (safe.to_string(), good.replace("Safe Paper", "Wrong Paper"), Some("title")),
            (safe.to_string(), good.replace("Alice Smith and Bob Jones", ""), Some("author")),
            (safe.to_string(), good.replace("2024", "2010"), Some("year")),
            (react.to_string(), react_remote.to_string(), None),
            (refine.replace(refine_authors, "others"), refine.clone(), Some("author")),
            (reflexion.to_string(), reflexion_remote.to_string(), Some("author")),
            (
                reflexion.replace("author={Shinn, Noah and Cassano, Federico and Berman, Edward and Gopinath, Ashwin and Narasimhan, Karthik and Yao, Shunyu},", ""),
                reflexion_remote.to_string(),
                Some("author"),
            ),
            (reflexion.to_string(), reflexion_remote.replace("Reflexion:", "Different paper:"), Some("title")),
        ];
        for corrected in [
            react_remote.replace("Karthik Narasimhan", "Kumar Narasimhan"),
            react_remote.replace("Karthik Narasimhan", "K. Narasimhan"),
            react_remote.replace("Jeffrey Zhao", "Jeffrey Zhang"),
            react_remote.replace("Shunyu Yao and Jeffrey Zhao", "Jeffrey Zhao and Shunyu Yao"),
            react_remote.replace(" and Yuan Cao", ""),
        ] {
            cases.push((react.to_string(), corrected, Some("author")));
        }
        for local_authors in [
            "Madaan, Aman and Tandon, Niket and Gupta, Prakhar and others",
            "Madaan, Aman and Tandon, Niket and Aman Madaan and Gupta, Prakhar and Skyler Hallinan",
        ] {
            let before =
                refine.replace(refine_authors, local_authors).replace("{remote,", "{mine,");
            for remote in [
                refine.clone(),
                refine.replace("Niket Tandon", "Another Person"),
                refine.replace("Aman Madaan and Niket Tandon", "Niket Tandon and Aman Madaan"),
                refine.replace("2023", "2024"),
                refine.replace("NeurIPS", "ICML"),
            ] {
                cases.push((before.clone(), remote, Some("author")));
            }
        }
        for (before, remote, conflict) in cases {
            let checked = compare_title_entry(&before, &remote);
            assert_eq!(checked.verified(), conflict.is_none(), "{before}\n{remote}");
            if let Some(reason) = conflict {
                // A conflict is exposed as a non-applicable candidate.
                assert!(checked.after.is_none(), "{remote}");
                assert_eq!(checked.publication_reason.as_deref(), Some("identity_conflict"));
                assert!(checked.candidate.unwrap().reasons.iter().any(|r| r == reason), "{remote}");
            }
        }
        // A missing venue is filled in from the confirmed record.
        let without_venue = react.replace(",booktitle={ICLR}", "");
        assert!(compare_title_entry(&without_venue, react_remote).after.is_some());
    }

    #[test]
    fn confirmed_papers_can_correct_venues_without_collapsing_findings() {
        for (before, remote) in [
            ("@inproceedings{awm,title={Agent Workflow Memory},author={Wang, Zora Zhiruo and Mao, Jiayuan and Fried, Daniel and Neubig, Graham},booktitle={ICLR},year={2025}}", "@inproceedings{x,title={Agent Workflow Memory},author={Zora Zhiruo Wang and Jiayuan Mao and Daniel Fried and Graham Neubig},booktitle={ICML},year={2025}}"),
            ("@inproceedings{memp,title={Memp: Exploring Agent Procedural Memory},author={Runnan Fang and Yuan Liang},booktitle={ACL},year={2026},doi={10.18653/v1/2026.findings-acl.866}}", "@inproceedings{x,title={Memp: Exploring Agent Procedural Memory},author={Runnan Fang and Yuan Liang},booktitle={Findings of the Association for Computational Linguistics: ACL 2026},year={2026},doi={10.18653/v1/2026.findings-acl.866}}"),
        ] {
            let after = compare_title_entry(before, remote).after.unwrap();
            assert_eq!(fields(&after)["booktitle"], fields(remote)["booktitle"]);
            if remote.contains("findings-acl") {
                assert!(compare_title_entry(&after, &remote.replace("Findings of the Association for Computational Linguistics: ACL 2026", "ACL")).after.is_none());
            }
            let project = TestProject::with_bib(before);
            let key = &project::bibliography_entry_spans(before)[0].0;
            apply(&project.root, "references.bib", key, before, &after).unwrap();
            assert!(compare_title_entry(before, &remote.replace("title={", "title={Different ")).after.is_none());
        }
    }

    #[test]
    fn a_publication_match_that_renames_the_paper_is_not_a_correction() {
        let gmt = "@article{chen2025gmt, title={GMT: General Motion Tracking for Humanoid Whole-Body Control}, author={Zixuan Chen}, year={2025}}";
        let sonic = "@article{chen2025gmt, title={SONIC: Supersizing motion tracking for natural humanoid whole-body control}, author={Zixuan Chen}, year={2026}, doi={10.1126/SCIROBOTICS.AED4592}}";
        assert!(renamed_paper(gmt, sonic));
        // Camera-ready case change, or dropping a short name, is still the same paper.
        assert!(!renamed_paper(
            gmt,
            "@article{chen2025gmt, title={GMT: General motion tracking for humanoid whole-body control}, author={Zixuan Chen}, year={2025}}"
        ));
        assert!(!renamed_paper(
            "@article{a, title={HOVER: Versatile Neural Whole-Body Controller for Humanoid Robots}, author={A}, year={2024}}",
            "@article{a, title={Versatile Neural Whole-Body Controller for Humanoid Robots}, author={A}, year={2024}}"
        ));
    }
}
