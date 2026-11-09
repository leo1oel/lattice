//! An entry Add papers wrote passes Check citations with no proposals. Each
//! case replays one add path's transformation offline against fixture source
//! records (the record a lookup returned, and the publisher's record the
//! import merged), then runs the check's comparison and cleanup on the result
//! against the same records, the way a later check meets them.
//!
//! Add papers writes the check's own proposal (`check::prepare_import`), so
//! the preprint cases replay that: the record the check would propose for the
//! fetched arXiv entry is written, then checked again.
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
        cleanup_result(merge_metadata(entry, &publisher_record(entry, official), true))
    };
    let changes = checked.changes.into_iter();
    changes
        .map(|change| format!("{}: {:?} -> {:?}", change.field, change.before, change.after))
        .collect()
}

/// `prepare_import` without its network lookups: the import's own record
/// merged with the publisher's, cleaned up, and named by canonical venue.
fn imported(raw: &str, official: &str) -> String {
    let merged = cleanup_result(merge_metadata(raw, &publisher_record(raw, official), true));
    canonical_venues(merged.after.as_deref().unwrap_or(raw))
}

/// The publisher's record `publication::lookup` merges for `entry`: a CVF
/// export carries its DOI's own (IEEE) pages, and an entry already numbered
/// the CVF way keeps its own numbering.
fn publisher_record(entry: &str, official: &str) -> String {
    if official != ICCV_CVF {
        return official.into();
    }
    let (record, cvf_pages) = publication::doi_pagination(ICCV_CVF, ICCV_CROSSREF);
    publication::keep_cvf_pages(entry, record, cvf_pages.as_deref())
}

/// The check's preprint path for `entry`: the published record an index
/// matched merged over it (`upgrade_preprint`), replaced by the publisher's
/// record when there is one (`publication::refine`). Fields an unreachable
/// proceedings site settles are `withheld`.
fn preprint_check(
    entry: &str, published: &str, official: &str, withheld: &'static [&'static str],
) -> AuditResult {
    let mut checked = merge_metadata(entry, published, true);
    if !official.is_empty() {
        checked = merge_metadata(entry, official, true);
    }
    checked.withheld = withheld;
    proceedings::withhold(cleanup_result(checked))
}

/// Add papers on a fetched arXiv `raw`, then Check citations on what it wrote.
fn assert_preprint_round_trip(
    path: &str, raw: &str, published: &str, official: &str, withheld: &'static [&'static str],
) -> String {
    let checked = preprint_check(raw, published, official, withheld);
    let added = canonical_venues(checked.after.as_deref().unwrap_or(raw));
    let again = preprint_check(&added, published, official, withheld);
    let proposed: Vec<_> = again
        .changes
        .iter()
        .map(|c| format!("{}: {:?} -> {:?}", c.field, c.before, c.after))
        .collect();
    assert!(proposed.is_empty(), "{path}: {added}\nproposed {proposed:#?}");
    added
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
        if official == ICCV_CVF {
            // The entry keeps its IEEE DOI, so it keeps that DOI's pagination.
            assert!(same_value("pages", &fields(&entry)["pages"], "3992--4003"), "{path}: {entry}");
        }
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

/// arXiv's record of a paper, as `official_arxiv_citation` writes it.
fn arxiv_record(key: &str, title: &str, authors: &str, year: &str, id: &str) -> String {
    format!("@misc{{{key},\n  title = {{{title}}},\n  author = {{{authors}}},\n  year = {{{year}}},\n  url = {{https://arxiv.org/abs/{id}}},\n  eprint = {{{id}}},\n  archiveprefix = {{arXiv}},\n  howpublished = {{arXiv preprint arXiv:{id}}}\n}}")
}

#[test]
fn preprints_published_only_in_dblp_are_added_as_published() {
    // ICLR, PMLR and TMLR papers have no Crossref record to find by title;
    // DBLP's (through bibcite's upgrade) is the only published record, and
    // the check proposes it. Add papers now writes it.
    let merity = arxiv_record(
        "merity2016pointer",
        "Pointer Sentinel Mixture Models",
        "Merity, Stephen and Xiong, Caiming and Bradbury, James and Socher, Richard",
        "2016",
        "1609.07843",
    );
    let merity_dblp = "@inproceedings{merity2016pointer,
  author = {Stephen Merity and Caiming Xiong and James Bradbury and Richard Socher},
  title = {Pointer Sentinel Mixture Models},
  booktitle = {5th International Conference on Learning Representations, {ICLR} 2017, Toulon, France, April 24-26, 2017, Conference Track Proceedings},
  publisher = {OpenReview.net},
  year = {2017},
  url = {https://openreview.net/forum?id=Byj72udxe},
  eprint = {1609.07843},
  archiveprefix = {arXiv}
}";
    let clip = arxiv_record(
        "radford2021learning",
        "Learning Transferable Visual Models From Natural Language Supervision",
        "Radford, Alec and Kim, Jong Wook and Hallacy, Chris",
        "2021",
        "2103.00020",
    );
    let clip_dblp = "@inproceedings{radford2021learning,
  author = {Alec Radford and Jong Wook Kim and Chris Hallacy},
  title = {Learning Transferable Visual Models From Natural Language Supervision},
  booktitle = {Proceedings of the 38th International Conference on Machine Learning, {ICML} 2021, 18-24 July 2021, Virtual Event},
  series = {Proceedings of Machine Learning Research},
  volume = {139},
  pages = {8748-8763},
  publisher = {{PMLR}},
  year = {2021},
  url = {http://proceedings.mlr.press/v139/radford21a.html}
}";
    let solo = arxiv_record(
        "chen2024solo",
        "{SOLO}: A Single Transformer for Scalable Vision-Language Modeling",
        "Chen, Yangyi and Wang, Xingyao and Peng, Hao and Ji, Heng",
        "2024",
        "2407.06438",
    );
    let solo_dblp = "@article{chen2024solo,
  author = {Yangyi Chen and Xingyao Wang and Hao Peng and Heng Ji},
  title = {{SOLO:} {A} Single Transformer for Scalable Vision-Language Modeling},
  journal = {Trans. Mach. Learn. Res.},
  volume = {2024},
  year = {2024},
  url = {https://openreview.net/forum?id=nuzFG0Rbhy}
}";
    for (path, raw, published, venue) in [
        ("ICLR (DBLP)", merity, merity_dblp, "booktitle"),
        ("PMLR (DBLP)", clip, clip_dblp, "booktitle"),
        ("TMLR (DBLP)", solo, solo_dblp, "journal"),
    ] {
        let added = assert_preprint_round_trip(path, &raw, published, "", &[]);
        let values = fields(&added);
        assert_ne!(entry_type(&added), "misc", "{path}: {added}");
        assert!(
            values.contains_key(venue) && !values.contains_key("howpublished"),
            "{path}: {added}"
        );
    }
}

#[test]
fn springer_chapters_are_conference_papers() {
    // Crossref files ECCV papers as chapters of a Lecture Notes volume, and
    // exports them as @inbook; the title search used to skip them.
    let report = serde_json::json!({"message":{"items":[{"type":"book-chapter","title":["Let ViT Speak: Generative Language-Image Pre-training"],"DOI":"10.1007/978-3-032-37189-8_33"}]}});
    let fang = arxiv_record(
        "fang2026let",
        "Let {ViT} Speak: Generative Language-Image Pre-training",
        "Fang, Yan and Lan, Mengcheng and Huang, Zilong",
        "2026",
        "2605.00809",
    );
    assert_eq!(publication::candidate_dois(&fang, &report), vec!["10.1007/978-3-032-37189-8_33"]);
    let deposit = "@inbook{Fang_2026, title={Let ViT Speak: Generative Language-Image Pre-training}, ISBN={9783032371898}, ISSN={1611-3349}, url={http://dx.doi.org/10.1007/978-3-032-37189-8_33}, DOI={10.1007/978-3-032-37189-8_33}, booktitle={Computer Vision – ECCV 2026}, publisher={Springer Nature Switzerland}, author={Fang, Yan and Lan, Mengcheng and Huang, Zilong}, year={2026}, pages={588–608} }";
    let official = publication::proceedings_chapter(deposit);
    assert_eq!(entry_type(&official), "inproceedings");
    assert!(publication::accepts(&fang, &official, "10.1007/978-3-032-37189-8_33"), "{official}");
    let added = assert_preprint_round_trip("Springer chapter", &fang, &official, &official, &[]);
    let values = fields(&added);
    assert_eq!(values["booktitle"], "European Conference on Computer Vision (ECCV)");
    assert_eq!(values["pages"], "588--608");
    // A real book's chapter is not a conference paper.
    let book = deposit.replace("Computer Vision – ECCV 2026", "Handbook of Visual Learning");
    assert_eq!(entry_type(&publication::proceedings_chapter(&book)), "inbook");
}

#[test]
fn unreachable_proceedings_settle_nothing() {
    // papers.nips.cc and proceedings.iclr.cc refuse connections on some
    // networks. Crossref's deposit (NeurIPS Foundation, a DOI link) and DBLP
    // (an arXiv link) must not then replace what the export settles, or the
    // proposal would flip back wherever the site answers.
    let neurips_settles: &'static [&'static str] = &["publisher", "url"];
    let written = "@inproceedings{alayrac2022flamingo,
  author = {Jean-Baptiste Alayrac and Jeff Donahue},
  booktitle = {Advances in Neural Information Processing Systems (NeurIPS)},
  doi = {10.52202/068431-1723},
  eprint = {2304.08485},
  pages = {23716--23736},
  publisher = {Curran Associates, Inc.},
  title = {Flamingo: A Visual Language Model for Few-Shot Learning},
  url = {https://proceedings.neurips.cc/paper_files/paper/2022/file/960a172bc7fbf0177ccccbb411a7d800-Paper-Conference.pdf},
  year = {2022}
}";
    let stored = preprint_check(written, NEURIPS_CROSSREF, NEURIPS_CROSSREF, neurips_settles);
    assert!(
        stored.changes.is_empty(),
        "{:?}",
        stored.changes.iter().map(|c| &c.field).collect::<Vec<_>>()
    );
    // Reachable, the same record is proposed: withholding is only for the outage.
    assert!(!preprint_check(written, NEURIPS_CROSSREF, NEURIPS_CROSSREF, &[]).changes.is_empty());
    // Added during the outage: the DOI record's other fields, arXiv's link.
    let flamingo = arxiv_record(
        "alayrac2022flamingo",
        "Flamingo: A Visual Language Model for Few-Shot Learning",
        "Alayrac, Jean-Baptiste and Donahue, Jeff",
        "2022",
        "2204.14198",
    );
    let added = assert_preprint_round_trip(
        "NeurIPS unreachable",
        &flamingo,
        NEURIPS_CROSSREF,
        NEURIPS_CROSSREF,
        neurips_settles,
    );
    let values = fields(&added);
    assert_eq!(values["url"], "https://arxiv.org/abs/2204.14198");
    assert!(
        !values.contains_key("publisher") && values["doi"] == "10.52202/068431-1723",
        "{added}"
    );

    // ICLR, unreachable: DBLP's arXiv link never replaces the proceedings
    // page, and the export's pages are not DBLP's to fill.
    let iclr = "@inproceedings{neo2024towards,
  author = {Neo, Clement and Ong, Luke},
  booktitle = {International Conference on Learning Representations (ICLR)},
  eprint = {2410.07149},
  title = {Towards Interpreting Visual Information Processing in Vision-Language Models},
  url = {https://proceedings.iclr.cc/paper_files/paper/2025/file/900fb3439e4968df79a6f2bfedec49cd-Paper-Conference.pdf},
  year = {2025}
}";
    let dblp = "@inproceedings{neo2024towards,
  author = {Clement Neo and Luke Ong},
  booktitle = {International Conference on Learning Representations (ICLR)},
  pages = {1--20},
  title = {Towards Interpreting Visual Information Processing in Vision-Language Models},
  url = {https://arxiv.org/abs/2410.07149},
  year = {2025}
}";
    assert!(preprint_check(iclr, dblp, "", &["publisher", "url", "pages"]).changes.is_empty());
    // Even with the site reachable, an arXiv link is no correction.
    assert!(!preprint_check(iclr, dblp, "", &[]).changes.iter().any(|c| c.field == "url"));
}

#[test]
fn either_cvf_numbering_agrees_with_the_record() {
    // CVPR and ICCV papers are numbered twice: IEEE Xplore (the DOI's own
    // record) and CVF Open Access. An entry with either numbering and the
    // DOI is not proposed the other; a new entry takes the DOI's.
    let (record, cvf) = publication::doi_pagination(ICCV_CVF, ICCV_CROSSREF);
    assert_eq!(fields(&record)["pages"], "3992–4003");
    assert_eq!(cvf.as_deref(), Some("4015-4026"));
    for pages in ["3992--4003", "4015--4026"] {
        let entry = format!("@inproceedings{{kirillov2023segment,\n  title = {{Segment Anything}},\n  author = {{Kirillov, Alexander and Mintun, Eric and Ravi, Nikhila}},\n  booktitle = {{IEEE/CVF International Conference on Computer Vision (ICCV)}},\n  year = {{2023}},\n  pages = {{{pages}}},\n  doi = {{10.1109/iccv51070.2023.00371}}\n}}");
        assert_passes(pages, &entry, ICCV_CROSSREF, ICCV_CVF);
    }
    // Without the DOI, the CVF numbering is not kept beside the DOI it gains.
    let no_doi = "@inproceedings{kirillov2023segment,\n  title = {Segment Anything},\n  author = {Kirillov, Alexander and Mintun, Eric and Ravi, Nikhila},\n  booktitle = {IEEE/CVF International Conference on Computer Vision (ICCV)},\n  year = {2023},\n  pages = {4015--4026}\n}";
    let kept = publication::keep_cvf_pages(no_doi, record.clone(), cvf.as_deref());
    assert_eq!(fields(&kept)["pages"], "3992–4003");
}
