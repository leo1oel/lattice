//! An entry Add papers wrote passes Check citations with no proposals. Each
//! case replays one add path's transformation offline against fixture source
//! records (the record a lookup returned, and the publisher's record the
//! import merged), then runs the check's comparison and cleanup on the result
//! against the same records, the way a later check meets them.
use super::*;

/// What Check citations proposes for `entry` when the lookup returns `found`
/// and the publisher's record is `official`.
fn proposals(entry: &str, found: &str, official: &str) -> Vec<String> {
    let looked_up = if entry_doi(&fields(entry)).is_some() {
        compare_doi_entry(entry, found)
    } else {
        compare_title_entry(entry, found)
    };
    assert!(looked_up.verified(), "lookup rejected: {found}\n{:?}", looked_up.candidate);
    // `publication::refine` then merges the publisher's record over the entry
    // itself, and that merge replaces the lookup's proposal.
    let checked = if official.is_empty() {
        cleanup_result(looked_up)
    } else {
        cleanup_result(merge_metadata(entry, official, true))
    };
    let changes = checked.changes.into_iter();
    changes
        .map(|change| format!("{}: {:?} -> {:?}", change.field, change.before, change.after))
        .collect()
}

/// `prepare_import` without its network lookups: the import's own record
/// merged with the publisher's, cleaned up, and named by canonical venue.
fn imported(raw: &str, official: &str) -> String {
    let merged = cleanup_result(merge_metadata(raw, official, true));
    canonical_venues(merged.after.as_deref().unwrap_or(raw))
}

fn assert_passes(path: &str, entry: &str, found: &str, official: &str) {
    let proposed = proposals(entry, found, official);
    assert!(proposed.is_empty(), "{path}: {entry}\nproposed {proposed:#?}");
}

const EACL_ANTHOLOGY: &str = "@inproceedings{quan-etal-2024-enhancing,
  title = {Enhancing Ethical Explanations of Large Language Models through Iterative Symbolic Refinement},
  author = {Quan, Xin and Valentino, Marco and Dennis, Louise and Freitas, Andre},
  booktitle = {Proceedings of the 18th Conference of the {E}uropean Chapter of the {A}ssociation for {C}omputational {L}inguistics (Volume 1: Long Papers)},
  year = {2024},
  address = {St. Julian{'}s, Malta},
  publisher = {Association for Computational Linguistics},
  url = {https://aclanthology.org/2024.eacl-long.1/},
  doi = {10.18653/v1/2024.eacl-long.1},
  pages = {1--22}
}";

const FINDINGS_ANTHOLOGY: &str = "@inproceedings{li-etal-2026-memory,
  title = {Memory Agents for Long Documents},
  author = {Li, Wei and Chen, Yu},
  booktitle = {Findings of the Association for Computational Linguistics: EMNLP 2026},
  year = {2026},
  publisher = {Association for Computational Linguistics},
  url = {https://aclanthology.org/2026.findings-emnlp.12/},
  doi = {10.18653/v1/2026.findings-emnlp.12},
  pages = {120--134}
}";

const ICCV_CROSSREF: &str = "@inproceedings{Kirillov_2023,
  title = {Segment Anything},
  author = {Kirillov, Alexander and Mintun, Eric and Ravi, Nikhila},
  booktitle = {2023 IEEE/CVF International Conference on Computer Vision (ICCV)},
  publisher = {IEEE},
  year = {2023},
  pages = {3992–4003},
  doi = {10.1109/iccv51070.2023.00371},
  url = {http://dx.doi.org/10.1109/ICCV51070.2023.00371}
}";

const ICCV_CVF: &str = "@InProceedings{Kirillov_2023_ICCV,
  author = {Kirillov, Alexander and Mintun, Eric and Ravi, Nikhila},
  title = {Segment Anything},
  booktitle = {Proceedings of the IEEE/CVF International Conference on Computer Vision (ICCV)},
  month = {October},
  year = {2023},
  pages = {4015-4026},
  doi = {10.1109/iccv51070.2023.00371}
}";

const NEURIPS_CROSSREF: &str = "@inproceedings{Alayrac_2022,
  title = {Flamingo: A Visual Language Model for Few-Shot Learning},
  author = {Alayrac, Jean-Baptiste and Donahue, Jeff},
  booktitle = {Advances in Neural Information Processing Systems 35},
  publisher = {Neural Information Processing Systems Foundation, Inc. (NeurIPS)},
  year = {2022},
  pages = {23716--23736},
  doi = {10.52202/068431-1723},
  url = {http://dx.doi.org/10.52202/068431-1723}
}";

#[test]
fn doi_imports_pass_the_check_against_the_records_they_came_from() {
    // A DOI import merges the publisher's record into bibcite's: the check
    // then compares the stored entry with those same records.
    for (path, found, official) in [
        ("ACL Anthology DOI", EACL_ANTHOLOGY, EACL_ANTHOLOGY),
        ("Findings DOI", FINDINGS_ANTHOLOGY, FINDINGS_ANTHOLOGY),
        ("CVF DOI", ICCV_CROSSREF, ICCV_CVF),
        ("NeurIPS DOI", NEURIPS_CROSSREF, NEURIPS_CROSSREF),
    ] {
        let entry = imported(found, official);
        assert_passes(path, &entry, found, official);
        let venue = fields(&entry).get("booktitle").cloned().unwrap();
        assert!(
            !venue.contains("Proceedings of the 18th")
                && !venue.contains("Systems 35")
                && !venue.contains("2026"),
            "{path} stored a source spelling: {venue}"
        );
    }
}

#[test]
fn entries_the_editor_or_a_paste_hands_over_pass_the_check() {
    // The entry editor names the venue from the canonical list and fills an
    // empty URL with the DOI link; a pasted entry or Zotero export may
    // spell authors "Last, First" and pages with an en dash. Each goes through
    // the same import merge as a DOI lookup.
    let editor = "@inproceedings{quan2024enhancing,
  title = {Enhancing Ethical Explanations of Large Language Models through Iterative Symbolic Refinement},
  author = {Quan, Xin and Valentino, Marco and Dennis, Louise and Freitas, Andre},
  year = {2024},
  booktitle = {Proceedings of the Conference of the European Chapter of the Association for Computational Linguistics (EACL)},
  url = {https://doi.org/10.18653/v1/2024.eacl-long.1},
  doi = {10.18653/v1/2024.eacl-long.1}
}";
    let zotero = "@inproceedings{kirillov2023segment,
  title = {Segment Anything},
  author = {Kirillov, Alexander and Mintun, Eric and Ravi, Nikhila},
  booktitle = {IEEE/CVF International Conference on Computer Vision (ICCV)},
  year = {2023},
  pages = {4015–4026},
  doi = {10.1109/ICCV51070.2023.00371}
}";
    let findings = "@inproceedings{li2026memory,
  title = {Memory Agents for Long Documents},
  author = {Wei Li and Yu Chen},
  booktitle = {Findings of the Association for Computational Linguistics: EMNLP (Findings of EMNLP)},
  year = {2026},
  doi = {10.18653/v1/2026.findings-emnlp.12}
}";
    for (path, raw, found, official) in [
        ("entry editor", editor, EACL_ANTHOLOGY, EACL_ANTHOLOGY),
        ("Zotero", zotero, ICCV_CROSSREF, ICCV_CVF),
        ("pasted BibTeX", findings, FINDINGS_ANTHOLOGY, FINDINGS_ANTHOLOGY),
    ] {
        let entry = imported(raw, official);
        assert_passes(path, &entry, found, official);
        // The writer's canonical venue and their DOI link survive the merge.
        let (before, after) = (fields(raw), fields(&entry));
        assert_eq!(after["booktitle"], before["booktitle"], "{path}");
        if let Some(url) = before.get("url") {
            assert_eq!(&after["url"], url, "{path}");
        }
    }
}

#[test]
fn webpage_and_title_records_pass_the_local_cleanup() {
    // Webpage, AlphaXiv and PDF records have no publisher record to merge;
    // the import applies the check's local cleanup, so the check has none
    // left to propose.
    let report = "@misc{generalist2026gen15,
  author = {{Generalist Team}},
  title = {GEN-1.5: One-Shot Learners for Robot Manipulation},
  year = {2026},
  url = {https://generalistai.com/blog/gen-1.5}
}";
    let entry = protect_bibtex(report);
    assert_ne!(entry, report, "the cleanup protects GEN-1.5");
    assert!(cleanup_result(result("checked", "", &entry)).changes.is_empty(), "{entry}");
    // A title lookup's record is the lookup the check repeats.
    let title = "@inproceedings{brown2020language,
  author = {Tom B. Brown and Benjamin Mann},
  booktitle = {Advances in Neural Information Processing Systems (NeurIPS)},
  title = {Language Models are Few-Shot Learners},
  year = {2020}
}";
    let entry = protect_bibtex(title);
    assert_passes("title lookup", &entry, title, "");
}
