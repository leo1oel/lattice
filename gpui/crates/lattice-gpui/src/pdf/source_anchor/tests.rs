use super::*;

fn quoted(source: &str, line: usize, text: &str) -> Option<String> {
    source_range_for_pdf_text(source, line, text).map(|range| source[range].to_string())
}

#[test]
fn the_words_nearest_synctex_line_are_chosen() {
    // `annotation-rounds.test.ts`: the words are on lines 2 and 3, SyncTeX
    // named line 3, so it is that one.
    let source =
        "\\begin{abstract}\nWe show that it works.\nWe show that it scales.\n\\end{abstract}\n";
    let range = source_range_for_pdf_text(source, 3, "We show that it").unwrap();
    let from = source.rfind("We show that it").unwrap();
    assert_eq!(range, from..from + "We show that it".len());
    let range = source_range_for_pdf_text(source, 2, "We show that it").unwrap();
    assert_eq!(range.start, source.find("We show that it").unwrap());
}

#[test]
fn ligatures_hyphens_and_line_breaks_read_as_the_source() {
    // TeX set "efficient" with an ﬁ ligature and broke "workflow" over a line.
    let source = "Intro.\nAn efficient \\emph{work-\nflow} here.\n";
    assert_eq!(
        quoted(source, 2, "eﬃcient work-ﬂow").as_deref(),
        Some("efficient \\emph{work-\nflow")
    );
}

#[test]
fn a_word_cut_at_either_end_is_quoted_whole() {
    let source = "We measure the throughput carefully.\n";
    assert_eq!(
        quoted(source, 1, "asure the throughp").as_deref(),
        Some("measure the throughput")
    );
}

#[test]
fn commands_and_comments_are_not_prose() {
    // "section" is a command name and the comment is never typeset, so the
    // PDF's "Method results" is found across them.
    let source = "\\section{Method} % draft: rename\nresults follow.\n";
    assert_eq!(
        quoted(source, 1, "Method results").as_deref(),
        Some("Method} % draft: rename\nresults")
    );
}

#[test]
fn text_not_in_the_source_falls_back_to_synctex_line() {
    // A formula reads differently on the page than in the source.
    let source = "Before.\n  \\[ \\sum_i a_i \\]  \nAfter.\n";
    assert_eq!(
        quoted(source, 2, "∑").as_deref(),
        Some("\\[ \\sum_i a_i \\]")
    );
    assert_eq!(
        quoted(source, 2, "nowhere at all").as_deref(),
        Some("\\[ \\sum_i a_i \\]")
    );
}

#[test]
fn a_line_outside_the_file_or_empty_places_nothing() {
    let source = "One line.\n\nThird.";
    assert_eq!(source_range_for_pdf_text(source, 0, "One"), None);
    assert_eq!(source_range_for_pdf_text(source, 4, "One"), None);
    assert_eq!(source_range_for_pdf_text(source, 2, "∑"), None);
    // The last line without a final newline is still a line.
    assert_eq!(quoted(source, 3, "Third").as_deref(), Some("Third"));
}
