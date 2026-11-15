//! The Tauri app's `latex-input.test.ts`, `latex-environments.test.ts`
//! (`beginEnvironmentClose`) and `latex-editor.test.ts` cases, with `|` as
//! the caret.

use super::*;

fn apply(text: &str, edit: &InputEdit) -> String {
    let result = format!(
        "{}{}{}",
        &text[..edit.range.start],
        edit.insert,
        &text[edit.range.end..]
    );
    format!("{}|{}", &result[..edit.cursor], &result[edit.cursor..])
}

/// `source` after Enter on its `\item` line; `None` for the plain newline.
fn enter(source: &str) -> Option<String> {
    let cursor = source.find('|').unwrap();
    let text = source.replacen('|', "", 1);
    list_item_newline(&text, cursor).map(|edit| apply(&text, &edit))
}

#[test]
fn list_items_continue_and_leave_on_enter() {
    let cases = [
        // Continues an item at its indent.
        (
            "\\begin{itemize}\n  \\item one|\n\\end{itemize}",
            "\\begin{itemize}\n  \\item one\n  \\item |\n\\end{itemize}",
        ),
        // Moves the text after the caret into the new item.
        (
            "\\begin{enumerate}\n\\item one |two\n\\end{enumerate}",
            "\\begin{enumerate}\n\\item one\n\\item |two\n\\end{enumerate}",
        ),
        // Continues a labelled description item.
        (
            "\\begin{description}\n\\item[Term]|\n\\end{description}",
            "\\begin{description}\n\\item[Term]\n\\item |\n\\end{description}",
        ),
        // Leaves the list from an empty last item.
        (
            "  \\begin{itemize}\n    \\item one\n    \\item |\n  \\end{itemize}\nAfter",
            "  \\begin{itemize}\n    \\item one\n  \\end{itemize}\n  |\nAfter",
        ),
        // Leaves a nested list into the outer item.
        (
            "\\begin{itemize}\n\\item a\n  \\begin{itemize}\n  \\item b\n  \\item|\n  \\end{itemize}\n\\end{itemize}",
            "\\begin{itemize}\n\\item a\n  \\begin{itemize}\n  \\item b\n  \\end{itemize}\n  |\n\\end{itemize}",
        ),
        // Ends an empty item in the middle of a list.
        (
            "\\begin{itemize}\n  \\item |\n  \\item two\n\\end{itemize}",
            "\\begin{itemize}\n  |\n  \\item two\n\\end{itemize}",
        ),
        // Byte offsets past text that is not ASCII.
        (
            "\\begin{itemize}\n\\item café|\n\\end{itemize}",
            "\\begin{itemize}\n\\item café\n\\item |\n\\end{itemize}",
        ),
    ];
    for (source, expected) in cases {
        assert_eq!(enter(source).as_deref(), Some(expected), "{source:?}");
    }
}

#[test]
fn other_lines_keep_the_plain_newline() {
    assert_eq!(
        enter("\\begin{itemize}\n\\item one\nmore|\n\\end{itemize}"),
        None
    );
    assert_eq!(enter("\\begin{itemize}\n|\\item one\n\\end{itemize}"), None);
    assert_eq!(enter("\\itemsep=2pt|"), None);
    assert_eq!(enter("\\bibitem{key} Author|"), None);
}

#[test]
fn sized_delimiters_close_with_their_own_size() {
    let close = |before: &str, after: &str| sized_delimiter_close(before, after);
    let some = |replace: usize, insert: &str| Some((replace, insert.to_string()));
    assert_eq!(close("$\\left(", ""), some(0, "\\right)"));
    assert_eq!(close("\\bigl[", ""), some(0, "\\bigr]"));
    assert_eq!(close("\\Biggl\\{", ""), some(0, "\\Biggr\\}"));
    assert_eq!(close("\\left\\langle", ""), some(0, "\\right\\rangle"));
    assert_eq!(close("\\left|", ""), some(0, "\\right|"));
    assert_eq!(close("\\left\\|", ""), some(0, "\\right\\|"));
    // The bracket pairing already wrote is absorbed.
    assert_eq!(close("\\left(", ")$"), some(1, "\\right)"));
    assert_eq!(close("\\left\\{", "}"), some(1, "\\right\\}"));
    assert_eq!(close("\\left|", "|x|"), some(0, "\\right|"));
    // Other commands, or an opener that already has its partner.
    assert_eq!(close("\\leftarrow(", ""), None);
    assert_eq!(close("\\right(", ""), None);
    assert_eq!(close("\\left\\langl", ""), None);
    assert_eq!(close("\\left(", "x \\right)"), None);
    assert_eq!(close("\\left(", "x \\left[ y \\right] \\right)"), None);
    assert_eq!(close("\\left( a \\bigl[", "\\right)"), some(0, "\\bigr]"));
}

#[test]
fn a_begin_is_closed_unless_its_end_exists() {
    let close = |before: &str, after: &str| {
        begin_environment_close(before, &format!("{before}{after}"), "")
    };
    assert_eq!(
        close("\\begin{align}", ""),
        Some(("\n  \n\\end{align}".to_string(), 3))
    );
    assert_eq!(close("\\begin{align}", "\n\\end{align}"), None);
    assert_eq!(
        close("\\begin{itemize}", "\n\\item a\n\\item b\n\\end{itemize}"),
        None
    );
    assert!(
        close("\\begin{itemize}", "\n\\begin{itemize}\\end{itemize}")
            .unwrap()
            .0
            .contains("\\end{itemize}")
    );
    assert!(
        close(
            "\\begin{itemize}\n\\item a\n\\begin{itemize}",
            "\n\\end{itemize}"
        )
        .unwrap()
        .0
        .contains("\\end{itemize}")
    );
    assert_eq!(
        close(
            "\\begin{itemize}\n\\begin{itemize}",
            "\n\\end{itemize}\n\\end{itemize}"
        ),
        None
    );
    assert!(
        close("\\begin{itemize}", "\n% \\end{itemize}")
            .unwrap()
            .0
            .contains("\\end{itemize}")
    );
    assert_eq!(
        close(
            "a \\\\% \\begin{itemize}\n\\begin{itemize}",
            "\n\\end{itemize}"
        ),
        None
    );
    // A list's body line starts its first item, at the \begin's indent.
    assert_eq!(
        begin_environment_close("  \\begin{enumerate}", "  \\begin{enumerate}", "  "),
        Some(("\n    \\item \n  \\end{enumerate}".to_string(), 11))
    );
}

/// `source` after Enter (`insertLatexNewline`), `None` for the plain newline.
fn newline(source: &str) -> Option<String> {
    let cursor = source.find('|').unwrap();
    let text = source.replacen('|', "", 1);
    latex_newline(&text, cursor, cursor).map(|edit| apply(&text, &edit))
}

#[test]
fn enter_after_a_begin_writes_its_end() {
    assert_eq!(
        newline("\\begin{equation}|").as_deref(),
        Some("\\begin{equation}\n  |\n\\end{equation}")
    );
    // Trailing blanks go, and an already closed environment gets an indented line.
    assert_eq!(
        newline("  \\begin{figure}  |\n  \\end{figure}").as_deref(),
        Some("  \\begin{figure}\n    |\n  \\end{figure}")
    );
    assert_eq!(
        newline("\\begin{itemize}\n\\item a|\n\\end{itemize}").as_deref(),
        Some("\\begin{itemize}\n\\item a\n\\item |\n\\end{itemize}")
    );
    assert_eq!(newline("plain text|"), None);
    // A selection is the plain newline's.
    assert_eq!(latex_newline("\\begin{x}ab", 9, 11), None);
}

/// `source` after a typed character that ended at its caret.
fn typed(source: &str) -> Option<String> {
    let cursor = source.find('|').unwrap();
    let text = source.replacen('|', "", 1);
    after_input(&text, cursor).map(|edit| apply(&text, &edit))
}

#[test]
fn typing_closes_a_begin_and_a_left() {
    assert_eq!(
        typed("\\begin{itemize}|").as_deref(),
        Some("\\begin{itemize}\n  \\item |\n\\end{itemize}")
    );
    // `\left(` with the `)` bracket pairing wrote after the caret.
    assert_eq!(typed("$\\left(|)").as_deref(), Some("$\\left(|\\right)"));
    assert_eq!(
        typed("$\\left(x\\bigl\\{|\\right)").as_deref(),
        Some("$\\left(x\\bigl\\{|\\bigr\\}\\right)")
    );
    assert_eq!(typed("plain|"), None);
}

#[test]
fn dollar_pairs_and_steps_over() {
    let dollar = |source: &str| {
        let cursor = source.find('|').unwrap();
        let text = source.replacen('|', "", 1);
        apply(&text, &dollar_pair(&text, cursor))
    };
    assert_eq!(dollar("a |b"), "a $|$b");
    assert_eq!(dollar("a $|$ b"), "a $$|$$ b");
    assert_eq!(dollar("a $x|$ b"), "a $x$| b");
}
