use super::*;
#[cfg(unix)]
use crate::papers::test_support::{tool_lock, write_test_tool, TestProject, ToolOverride};

/// A shared bibliography: a co-author's entry, a preprint, and an entry in
/// another hand's style (bare numbers, a quoted note).
const SHARED: &str = r#"% Shared library
@article{coauthor2020,
  title={A Co-Author's Paper},
  author={Smith, Jane and Doe, John},
  journal={Journal of Things},
  volume={12}, number={3}, pages={45--67},
  year={2020},
  doi={10.1000/xyz123},
  note={Added by co-author, keep this note},
  keywords={important}
}

@misc{he2015deep,
  title={Deep Residual Learning for Image Recognition},
  author={He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  journal={arXiv preprint arXiv:1512.03385},
  year={2015},
  note={Keep me too},
  pages = {1--12}
}

@inproceedings{vaswani2017,
  author = {Vaswani, Ashish},
  title = {Attention Is All You Need},
  booktitle = {NeurIPS},
  volume = 30,
  pages = {5998--6008},
  year = 2017,
  note = "co-author's note"
}
"#;

/// Every entry as bibcite 0.6.11's `upgrade --no-tidy` writes the file back:
/// sorted, lowercased, rebraced, the comment wrapped. Unchanged entries keep
/// their fields; the upgraded one drops the preprint venue and the note.
fn bibcite_rewrite(upgraded: &str) -> String {
    format!(
        r#"@comment{{% Shared library}}

@article{{coauthor2020,
  author = {{Smith, Jane and Doe, John}},
  doi = {{10.1000/xyz123}},
  journal = {{Journal of Things}},
  keywords = {{important}},
  note = {{Added by co-author, keep this note}},
  number = {{3}},
  pages = {{45--67}},
  title = {{A Co-Author's Paper}},
  volume = {{12}},
  year = {{2020}}
}}

{upgraded}

@inproceedings{{vaswani2017,
  author = {{Vaswani, Ashish}},
  booktitle = {{NeurIPS}},
  note = {{co-author's note}},
  pages = {{5998--6008}},
  title = {{Attention Is All You Need}},
  volume = {{30}},
  year = {{2017}}
}}
"#
    )
}

const PUBLISHED: &str = "@inproceedings{he2015deep,
  author = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  booktitle = {IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)},
  doi = {10.1109/CVPR.2016.90},
  pages = {770--778},
  title = {Deep Residual Learning for Image Recognition},
  year = {2016}
}";

/// The upgrade lands in the entry it upgraded, in that entry's own layout:
/// changed values rewritten, new fields appended, nothing the writer had
/// dropped. Every other byte, comment and co-author entries included, stays.
#[test]
fn upgrade_rewrites_only_the_upgraded_entry_and_keeps_its_fields() {
    let (merged, retained) = merge_upgrade(SHARED, &bibcite_rewrite(PUBLISHED)).unwrap();
    let expected = SHARED.replace(
        "@misc{he2015deep,
  title={Deep Residual Learning for Image Recognition},
  author={He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  journal={arXiv preprint arXiv:1512.03385},
  year={2015},
  note={Keep me too},
  pages = {1--12}
}",
        "@inproceedings{he2015deep,
  title={Deep Residual Learning for Image Recognition},
  author={He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  journal={arXiv preprint arXiv:1512.03385},
  year={2016},
  note={Keep me too},
  pages = {770--778},
  booktitle = {IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)},
  doi = {10.1109/CVPR.2016.90}
}",
    );
    assert_ne!(expected, SHARED);
    assert_eq!(merged, expected);
    assert_eq!(
        retained,
        [RetainedFields {
            key: "he2015deep".into(),
            fields: vec!["journal".into(), "note".into()]
        }]
    );
    assert!(validate_bibliography_upgrade(SHARED, &merged).is_ok());

    // Nothing upgraded: bibcite's reformat alone changes no byte.
    let untouched = bibcite_rewrite(&PUBLISHED.replace("@inproceedings", "@misc")
        .replace("  booktitle = {IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)},\n  doi = {10.1109/CVPR.2016.90},\n", "  journal = {arXiv preprint arXiv:1512.03385},\n  note = {Keep me too},\n")
        .replace("770--778", "1--12").replace("2016", "2015"));
    assert_eq!(merge_upgrade(SHARED, &untouched).unwrap(), (SHARED.to_string(), Vec::new()));
}

/// New fields follow the entry's own separator and `=` spacing, a bare value
/// is replaced whole, and an entry that cannot be edited safely refuses.
#[test]
fn upgrade_edits_follow_the_entry_layout() {
    let (merged, _) = merge_upgrade(
        "@Misc{k, title={T}, year=2015}\n",
        "@article{k,\n  doi = {10.1/x},\n  title = {T},\n  year = {2016}\n}",
    )
    .unwrap();
    assert_eq!(merged, "@article{k, title={T}, year={2016}, doi={10.1/x}}\n");
    let (same_type, _) =
        merge_upgrade("@ARTICLE{k, title={T}}", "@article{k, title = {T}, doi = {10.1/x}}")
            .unwrap();
    assert_eq!(same_type, "@ARTICLE{k, title={T}, doi={10.1/x}}");
    for (before, proposed) in [
        // Unterminated: its last value is not its end.
        ("@misc{k, title={T}", "@article{k, title={T}, doi={10.1/x}}"),
        ("@misc{k, title={T}}", "@article{k, title={T}, doi={10.1/x}}\n@misc{j, title={J}}"),
        ("@misc{k, title={T}}", "@misc{j, title={T}}"),
    ] {
        assert!(merge_upgrade(before, proposed).is_err(), "{before} -> {proposed}");
    }
}

#[test]
fn bulk_upgrade_cannot_change_paper_identity_or_citation_keys() {
    let before = "@misc{old,title={Exact Title},author={Alice Smith and Bob Jones},year={2025},eprint={2510.14979}}";
    let after = before
        .replace("@misc", "@article")
        .replace("year={2025}", "year={2026},doi={10.1234/published}");
    assert!(validate_bibliography_upgrade(before, &after).is_ok());
    for invalid in [
        after.replace("Alice", "Ann"),
        after.replace("Exact Title", "Similar Title"),
        after.replace("2510.14979", "2605.28820"),
        after.replace("{old,", "{new,"),
        format!("{after}\n{after}"),
    ] {
        assert!(validate_bibliography_upgrade(before, &invalid).is_err(), "{invalid}");
    }
}

/// The audit's F2 repro through the real `upgrade_bibliography`: bibcite
/// rewrites the whole shared file and enriches one entry. Before the fix a
/// whole-file `bibcite tidy` then stripped volume, number, pages and note
/// from every entry and the result synced to Overleaf; the fake refuses
/// `tidy` so any return of it fails here.
#[cfg(unix)]
#[test]
fn agent_upgrade_leaves_co_author_entries_byte_for_byte() {
    let _lock = tool_lock();
    let project = TestProject::new(SHARED);
    let enriched = "@misc{he2015deep,
  author = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  journal = {arXiv preprint arXiv:1512.03385},
  pages = {1--12},
  publisher = {arXiv},
  title = {Deep Residual Learning for Image Recognition},
  year = {2015}
}";
    let proposal = project.parent.write("proposal.bib", bibcite_rewrite(enriched));
    let tool = project.parent.join("bibcite");
    write_test_tool(
        &tool,
        &format!(
            "#!/bin/sh\nset -eu\n[ \"$1\" = upgrade ] && [ \"$2\" = --no-tidy ] || exit 23\n\
             cp '{}' \"$3\"\nprintf '{{\"upgraded\": 1}}\\n'\n",
            proposal.display()
        ),
    );
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);

    let preview = upgrade_bibliography(&project.root, true).unwrap();
    assert!(!preview.changed);
    assert_eq!(project.bibliography(), SHARED);

    let result = upgrade_bibliography(&project.root, false).unwrap();
    assert!(result.changed);
    assert_eq!(result.report["upgraded"], 1);
    assert_eq!(
        result.retained_fields,
        [RetainedFields { key: "he2015deep".into(), fields: vec!["note".into()] }]
    );
    let after = project.bibliography();
    let entry = |text: &str, key: &str| {
        let (_, start, end) = project::bibliography_entry_spans(text)
            .into_iter()
            .find(|(candidate, _, _)| candidate == key)
            .unwrap();
        text[start..end].to_string()
    };
    for key in ["coauthor2020", "vaswani2017"] {
        assert_eq!(entry(&after, key), entry(SHARED, key), "{key}");
    }
    assert!(after.starts_with("% Shared library\n@article{coauthor2020,\n"));
    let upgraded = entry(&after, "he2015deep");
    assert_eq!(
        upgraded,
        entry(SHARED, "he2015deep")
            .replace("pages = {1--12}\n}", "pages = {1--12},\n  publisher = {arXiv}\n}",)
    );
    assert_eq!(after, SHARED.replace(&entry(SHARED, "he2015deep"), &upgraded));
}
