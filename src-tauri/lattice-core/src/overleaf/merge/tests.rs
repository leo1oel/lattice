use super::*;

fn clean(base: &str, ours: &str, theirs: &str) -> String {
    match merge_text(base, ours, theirs, true) {
        TextMerge::Clean(text) => text,
        TextMerge::Conflicted(text) => panic!("conflicted:\n{text}"),
    }
}

fn conflicted(base: &str, ours: &str, theirs: &str, prose: bool) -> String {
    match merge_text(base, ours, theirs, prose) {
        TextMerge::Conflicted(text) => text,
        TextMerge::Clean(text) => panic!("clean:\n{text}"),
    }
}

#[test]
fn different_sentences_of_one_paragraph_merge() {
    let merged =
        clean("One. Two. Three.\n", "One, mine. Two. Three.\n", "One. Two. Three, theirs.\n");
    assert_eq!(merged, "One, mine. Two. Three, theirs.\n");
}

#[test]
fn different_lines_merge_and_the_same_edit_on_both_sides_is_taken_once() {
    assert_eq!(clean("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n"), "A\nb\nC\n");
    assert_eq!(clean("a\nb\n", "a\nB\n", "a\nB\n"), "a\nB\n");
}

#[test]
fn the_same_sentence_conflicts_on_its_whole_line() {
    let base = "Intro.\n\nFirst. The result holds. Last.\n\nEnd.\n";
    let ours = "Intro.\n\nFirst. The result never holds. Last.\n\nEnd.\n";
    let theirs = "Intro.\n\nFirst. The result holds always. Last.\n\nEnd.\n";
    let expected = "Intro.\n\n<<<<<<< This Mac\nFirst. The result never holds. Last.\n||||||| Last sync\nFirst. The result holds. Last.\n=======\nFirst. The result holds always. Last.\n>>>>>>> Overleaf\n\nEnd.\n";
    assert_eq!(conflicted(base, ours, theirs, true), expected);
}

#[test]
fn a_conflict_and_a_clean_edit_on_one_line_stay_one_spot() {
    let base = "A one. B two. C three.\n";
    let ours = "A mine. B two. C three, mine.\n";
    let theirs = "A theirs. B two. C three.\n";
    let text = conflicted(base, ours, theirs, true);
    assert_eq!(text.matches("<<<<<<<").count(), 1, "{text}");
    assert!(text.contains("=======\nA theirs. B two. C three, mine.\n>>>>>>>"), "{text}");
}

#[test]
fn code_merges_by_line_only() {
    conflicted("a = 1; b = 2\n", "a = 5; b = 2\n", "a = 1; b = 3\n", false);
    let text = conflicted("x\na. b.\n", "x\na! b.\n", "x\na. b?\n", false);
    assert!(text.starts_with("x\n<<<<<<< This Mac\na! b.\n"), "{text}");
}

#[test]
fn edits_to_neighbouring_sentences_merge_but_insertions_at_one_place_conflict() {
    assert_eq!(
        clean(
            "One. Two.
",
            "One, mine. Two.
",
            "One. Two, theirs.
"
        ),
        "One, mine. Two, theirs.
"
    );
    conflicted(
        "One. Two.
",
        "One. Mine. Two.
",
        "One. Theirs. Two.
",
        true,
    );
}

#[test]
fn text_without_a_final_newline_and_markers_like_lines_survive() {
    assert_eq!(clean("a\n=======\nb", "A\n=======\nb", "a\n=======\nB"), "A\n=======\nB");
    let merged = clean("x \\n y. Two.\n", "x \\n y. Two, mine.\n", "Theirs x \\n y. Two.\n");
    assert_eq!(merged, "Theirs x \\n y. Two, mine.\n");
}

#[test]
fn no_base_marks_only_what_differs() {
    let text = merge_without_base("head\nmine\ntail\n", "head\ntheirs\ntail\n");
    assert_eq!(text, "head\n<<<<<<< This Mac\nmine\n=======\ntheirs\n>>>>>>> Overleaf\ntail\n");
}

#[test]
fn only_prose_files_merge_by_sentence() {
    assert!(is_prose("sec/Intro.TEX") && is_prose("README.md"));
    assert!(!is_prose("refs.bib") && !is_prose("plot.py"));
}
