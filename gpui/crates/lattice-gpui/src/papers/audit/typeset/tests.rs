//! `reference-typeset.test.tsx`'s cases, and the behaviour
//! `reference-typeset.ts` documents for inline references, the corrected
//! `\bibitem` and the word comparison.

use super::*;

fn change(field: &str, before: &str, after: &str) -> Change {
    Change {
        field: field.into(),
        before: before.into(),
        after: after.into(),
    }
}

const BEFORE: &str = "@article{tay2022efficient, title={Efficient Transformers: A Survey}, author={Tay, Yi and Dehghani, Mostafa and Bahri, Dara and Metzler, Donald}, journal={ACM Computing Surveys}, year={2022}}";

fn after() -> String {
    BEFORE.replace(
        "year={2022}",
        "volume={55}, pages={1--28}, doi={10.1145/3530811}, year={2022}",
    )
}

fn changes() -> Vec<Change> {
    vec![
        change("doi", "", "10.1145/3530811"),
        change("pages", "", "1--28"),
        change("volume", "", "55"),
    ]
}

#[test]
fn prints_the_reference_with_its_fix_in_one_tagged_run() {
    let fix = typeset_bib_fix(BEFORE, &after(), &changes());
    assert_eq!(
        fix.text,
        "Yi Tay, Mostafa Dehghani, Dara Bahri et al. Efficient Transformers: A Survey. ACM Computing Surveys, 2022."
    );
    assert_eq!(fix.edits.len(), 1);
    let edit = &fix.edits[0];
    assert_eq!(edit.insert, "vol. 55, pp. 1–28, ");
    assert_eq!(edit.tag, "pages, volume");
    // An insertion between two printed pieces replaces nothing.
    assert_eq!(edit.from, edit.to);
    assert_eq!(
        &fix.text[..edit.from],
        "Yi Tay, Mostafa Dehghani, Dara Bahri et al. Efficient Transformers: A Survey. ACM Computing Surveys, "
    );
    assert_eq!(fix.unprinted, ["DOI"]);
}

#[test]
fn a_changed_author_list_prints_every_name() {
    let after = BEFORE.replace("Metzler, Donald", "Metzler, Don");
    let fix = typeset_bib_fix(BEFORE, &after, &[change("author", "", "")]);
    let edit = &fix.edits[0];
    assert_eq!(
        &fix.text[edit.from..edit.to],
        "Yi Tay, Mostafa Dehghani, Dara Bahri, Donald Metzler. "
    );
    assert_eq!(
        edit.insert,
        "Yi Tay, Mostafa Dehghani, Dara Bahri, Don Metzler. "
    );
    assert_eq!(edit.tag, "authors");
}

#[test]
fn a_bibitem_is_marked_where_it_states_a_value_and_lists_what_it_does_not() {
    let written = "A. Vaswani et al. Attention is all you need. In NIPS, 2017.";
    let fix = typeset_inline_fix(
        written,
        &[
            change("booktitle", "nips", "NeurIPS"),
            change("author", "Vaswani, Ashish and Shazeer, Noam", "Vaswani, A."),
        ],
    );
    assert_eq!(fix.text, written);
    // Found ignoring case, and marked over the item's own spelling.
    assert_eq!(fix.edits.len(), 1);
    let edit = &fix.edits[0];
    assert_eq!(&fix.text[edit.from..edit.to], "NIPS");
    assert_eq!(
        (edit.insert.as_str(), edit.tag.as_str()),
        ("NeurIPS", "booktitle")
    );
    assert_eq!(fix.unprinted, ["Authors"]);
}

#[test]
fn a_corrected_bibitem_changes_only_the_words_it_states() {
    let corrected = corrected_bibitem(
        "vaswani2017",
        "A. Vaswani. Attention. In NIPS, 2016.",
        "@inproceedings{v, title={Attention}, year={2017}}",
        &[
            change("booktitle", "NIPS", "NeurIPS & Co"),
            change("year", "2016", "2017"),
        ],
    );
    assert_eq!(
        corrected,
        "\\bibitem{vaswani2017} A. Vaswani. Attention. In NeurIPS \\& Co, 2017."
    );
}

#[test]
fn a_bibitem_that_does_not_state_a_value_is_written_afresh() {
    let record = "@article{v, title={Attention Is All You Need}, author={Vaswani, Ashish and Shazeer, Noam}, journal={NeurIPS}, volume={30}, pages={5998--6008}, year={2017}}";
    let corrected = corrected_bibitem(
        "vaswani2017",
        "Vaswani et al. Attention.",
        record,
        &[change("pages", "", "5998--6008")],
    );
    assert_eq!(
        corrected,
        "\\bibitem{vaswani2017}\nAshish Vaswani, Noam Shazeer.\n\\newblock Attention Is All You Need.\n\\newblock \\emph{NeurIPS}, vol.~30, pp.~5998--6008, 2017."
    );
}

#[test]
fn only_the_differing_words_are_marked() {
    // bibliography-audit.test.tsx: "Original Press" against "Candidate Press".
    let (ours, theirs) = word_difference("Original Press", "Candidate Press");
    let marked = |words: &[Word]| -> Vec<String> {
        words
            .iter()
            .filter(|word| word.differs)
            .map(|word| word.word.clone())
            .collect()
    };
    assert_eq!(marked(&ours), ["Original"]);
    assert_eq!(marked(&theirs), ["Candidate"]);
    let joined = |words: &[Word]| {
        words
            .iter()
            .map(|word| word.word.as_str())
            .collect::<String>()
    };
    assert_eq!(joined(&ours), "Original Press");
    assert_eq!(joined(&theirs), "Candidate Press");
}

#[test]
fn the_space_between_words_is_never_marked() {
    let (ours, theirs) = word_difference("a b", "a  c d");
    assert!(
        ours.iter()
            .chain(&theirs)
            .filter(|word| word.word.trim().is_empty())
            .all(|word| !word.differs)
    );
    assert_eq!(theirs.iter().filter(|word| word.differs).count(), 2);
}
