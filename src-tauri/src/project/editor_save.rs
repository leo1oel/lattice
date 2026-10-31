//! The text an editor save writes over the file on disk: the buffer merged
//! with any outside edit made since it was loaded, in the file's own line
//! breaks.

/// What a save writes, and how it came to differ from the buffer.
pub(super) struct EditorSave {
    pub content: String,
    pub external_changes_merged: bool,
    pub had_conflicts: bool,
}

/// `content`, edited from `base` (the text it was loaded from, when known), as
/// it replaces `current`, the file on disk.
///
/// CodeMirror joins a document's lines with "\n" whatever the file used, so
/// the edited buffer of a CRLF file comes back with LF breaks. Written as it
/// came, changing one line rewrote every line: the git diff, a Windows
/// collaborator's merge and the history entry all saw a new file, and a merge
/// against an outside edit set every line in conflict. So when every line
/// break on disk is CRLF, the buffer and its base take CRLF ones too, before
/// they are compared or merged. A file with mixed breaks, or none, is written
/// as the buffer has it: there is no one style to keep.
///
/// `keep_line_breaks` is false for a compare-and-swap write, whose caller
/// records exactly the text it sent as the file's content.
pub(super) fn editor_save(
    content: String, base: Option<String>, current: &str, keep_line_breaks: bool,
) -> EditorSave {
    let crlf = keep_line_breaks && all_crlf(current);
    let styled = |text: String| if crlf { to_crlf(text) } else { text };
    let content = styled(content);
    match base.map(styled) {
        Some(base) if current != base => {
            let merged = merge_text_snapshots(&base, &content, current);
            EditorSave {
                // diffy ends its conflict markers with "\n".
                content: styled(merged.content),
                external_changes_merged: true,
                had_conflicts: merged.had_conflicts,
            }
        }
        _ => EditorSave { content, external_changes_merged: false, had_conflicts: false },
    }
}

/// Whether `text` has line breaks and every one of them is CRLF.
fn all_crlf(text: &str) -> bool {
    let breaks = text.matches('\n').count();
    breaks > 0 && text.matches("\r\n").count() == breaks && text.matches('\r').count() == breaks
}

fn to_crlf(text: String) -> String {
    if all_crlf(&text) || !text.contains('\n') {
        return text;
    }
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

struct TextMergeResult {
    content: String,
    had_conflicts: bool,
}

/// Merge one edit against the exact content it observed, without touching disk.
fn merge_text_snapshots(base: &str, edited: &str, current: &str) -> TextMergeResult {
    if edited == base || edited == current {
        return TextMergeResult { content: current.to_string(), had_conflicts: false };
    }
    if current == base {
        return TextMergeResult { content: edited.to_string(), had_conflicts: false };
    }
    match diffy::MergeOptions::new().merge(base, edited, current) {
        Ok(content) => TextMergeResult { content, had_conflicts: false },
        Err(content) => TextMergeResult { content, had_conflicts: true },
    }
}

#[cfg(test)]
mod tests {
    use crate::project::apply_editor_transaction;
    use crate::project::test_support::Fixture;

    const CRLF: &str = "first line\r\nsecond line\r\nthird line\r\n";

    fn save(
        fixture: &Fixture, content: &str, base: Option<&str>, expected: Option<&str>,
    ) -> String {
        let written = apply_editor_transaction(
            &fixture.root,
            "intro.tex".to_string(),
            content.to_string(),
            base.map(str::to_string),
            expected.map(str::to_string),
        )
        .unwrap();
        assert_eq!(fixture.read("intro.tex"), written.content, "the result is what is on disk");
        written.content
    }

    #[test]
    fn an_edited_crlf_file_keeps_its_crlf_line_breaks() {
        let fixture = Fixture::project("crlf-edit");
        fixture.write("intro.tex", CRLF);
        // The editor's buffer, as CodeMirror holds it, with the base it was read as.
        let written =
            save(&fixture, "first line\nsecond line edited\nthird line\nadded\n", Some(CRLF), None);
        assert_eq!(written, "first line\r\nsecond line edited\r\nthird line\r\nadded\r\n");
    }

    #[test]
    fn a_crlf_file_merges_an_outside_edit_line_by_line() {
        let fixture = Fixture::project("crlf-merge");
        fixture.write("intro.tex", "first line\r\nsecond line\r\nthird line changed outside\r\n");
        let written =
            save(&fixture, "first line edited\nsecond line\nthird line\n", Some(CRLF), None);
        assert_eq!(written, "first line edited\r\nsecond line\r\nthird line changed outside\r\n");
    }

    #[test]
    fn a_crlf_conflict_is_marked_in_crlf_lines() {
        let fixture = Fixture::project("crlf-conflict");
        fixture.write("intro.tex", "first line\r\nsecond line outside\r\nthird line\r\n");
        let result = apply_editor_transaction(
            &fixture.root,
            "intro.tex".to_string(),
            "first line\nsecond line mine\nthird line\n".to_string(),
            Some(CRLF.to_string()),
            None,
        )
        .unwrap();
        assert!(result.had_conflicts);
        assert!(result.content.contains("second line mine\r\n"));
        assert!(!result.content.replace("\r\n", "").contains('\n'), "{:?}", result.content);
    }

    #[test]
    fn lf_mixed_and_compare_and_swap_writes_keep_the_text_as_sent() {
        let fixture = Fixture::project("line-breaks-as-sent");
        fixture.write("intro.tex", "one\ntwo\n");
        assert_eq!(
            save(&fixture, "one\ntwo\nthree\n", Some("one\ntwo\n"), None),
            "one\ntwo\nthree\n"
        );

        // Mixed breaks have no one style to keep.
        fixture.write("intro.tex", "one\r\ntwo\n");
        assert_eq!(
            save(&fixture, "one\ntwo\nthree\n", Some("one\r\ntwo\n"), None),
            "one\ntwo\nthree\n"
        );

        // A live Overleaf delivery records the text it sent as saved: written
        // otherwise, its next delivery would find the file changed.
        fixture.write("intro.tex", CRLF);
        assert_eq!(save(&fixture, "remote\ntext\n", None, Some(CRLF)), "remote\ntext\n");
    }

    #[test]
    fn a_crlf_buffer_written_back_unchanged_records_no_edit() {
        let fixture = Fixture::project("crlf-unchanged");
        fixture.write("intro.tex", CRLF);
        let result = apply_editor_transaction(
            &fixture.root,
            "intro.tex".to_string(),
            "first line\nsecond line\nthird line\n".to_string(),
            Some(CRLF.to_string()),
            None,
        )
        .unwrap();
        assert!(result.transaction_id.is_empty(), "only the line breaks differed");
        assert_eq!(fixture.read("intro.tex"), CRLF);
    }
}
