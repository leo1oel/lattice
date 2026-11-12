//! The Tauri app's own cases (`src/build/compile-diagnostics.test.ts`).

use super::*;

pub(crate) fn diagnostic(
    level: &str,
    message: &str,
    file: Option<&str>,
    line: Option<u32>,
) -> Diagnostic {
    Diagnostic {
        file: file.map(str::to_string),
        line,
        column: None,
        end_line: None,
        end_column: None,
        level: level.into(),
        message: message.into(),
        code: None,
        params: Default::default(),
    }
}

fn files(paths: &[&str]) -> Vec<String> {
    paths.iter().map(|path| path.to_string()).collect()
}

#[test]
fn groups_sorted_diagnostics_by_normalized_file_worst_file_first() {
    let sorted = sort(&[
        diagnostic("warning", "Overfull", Some("./main.tex"), Some(9)),
        diagnostic("warning", "Font shape", None, None),
        diagnostic("error", "Undefined", Some("chapters/ch01.tex"), Some(3)),
        diagnostic(
            "warning",
            "Citation",
            Some("/Users/me/paper/main.tex"),
            Some(2),
        ),
    ]);
    let groups: Vec<(Option<String>, Vec<&str>)> = group_by_file(&sorted)
        .into_iter()
        .map(|group| {
            let messages = group
                .diagnostics
                .iter()
                .map(|item| item.message.as_str())
                .collect();
            (group.file, messages)
        })
        .collect();
    assert_eq!(
        groups,
        [
            (Some("chapters/ch01.tex".into()), vec!["Undefined"]),
            (None, vec!["Font shape"]),
            (Some("main.tex".into()), vec!["Citation", "Overfull"]),
        ]
    );
}

#[test]
fn normalizes_absolute_and_dotted_log_paths() {
    assert_eq!(
        normalize_path(Some("./chapters/intro.tex")).as_deref(),
        Some("chapters/intro.tex")
    );
    assert_eq!(
        normalize_path(Some("/Users/me/paper/src/main.tex")).as_deref(),
        Some("src/main.tex")
    );
    assert_eq!(
        normalize_path(Some("C:\\\\paper\\\\main.tex")).as_deref(),
        Some("main.tex")
    );
}

#[test]
fn cuts_an_absolute_path_whose_case_changes_length_at_its_project_folder() {
    // 'İ' lowercases to three bytes and 'Ω' (U+2126) to two: the folder found
    // must still be cut at its own place in the path as TeX gave it.
    assert_eq!(
        normalize_path(Some("/Users/İlker/thesis/chapters/intro.tex")).as_deref(),
        Some("chapters/intro.tex")
    );
    assert_eq!(
        normalize_path(Some("/Users/ΩΩΩΩ/thesis/chapters/intro.tex")).as_deref(),
        Some("chapters/intro.tex")
    );
    assert_eq!(
        normalize_path(Some("/Users/İlker/Thesis/Sections/Intro.tex")).as_deref(),
        Some("Sections/Intro.tex")
    );
}

#[test]
fn resolves_diagnostics_against_the_project_tree() {
    let tree = files(&["main.tex", "chapters", "chapters/intro.tex"]);
    assert_eq!(
        resolve_path(Some("/tmp/paper/./chapters/intro.tex"), &tree, "main.tex"),
        "chapters/intro.tex"
    );
    assert_eq!(resolve_path(None, &tree, "main.tex"), "main.tex");
    assert_eq!(
        resolve_path(
            Some("intro.tex"),
            &files(&["preintro.tex", "paper/intro.tex"]),
            ""
        ),
        "paper/intro.tex"
    );
    assert_eq!(
        resolve_path(Some("intro.tex"), &files(&["preintro.tex"]), ""),
        "intro.tex"
    );
}

#[test]
fn resolves_to_the_exact_file_not_another_that_shares_its_name() {
    let tree = files(&[
        "arxiv/sections/intro.tex",
        "paper/main.tex",
        "paper/sections/intro.tex",
    ]);
    let resolve = |file: &str| resolve_path(Some(file), &tree, "");
    assert_eq!(
        resolve("paper/sections/intro.tex"),
        "paper/sections/intro.tex"
    );
    assert_eq!(
        resolve("./paper/sections/intro.tex"),
        "paper/sections/intro.tex"
    );
    assert_eq!(
        resolve_path(
            Some("intro.tex"),
            &files(&["chapters/intro.tex", "intro.tex"]),
            ""
        ),
        "intro.tex"
    );
    // No exact match: a suffix decides only when one file has it.
    assert_eq!(resolve("sections/intro.tex"), "sections/intro.tex");
    assert_eq!(
        resolve("/Users/me/paper/sections/intro.tex"),
        "paper/sections/intro.tex"
    );
    assert_eq!(
        resolve("/Users/me/x/sections/intro.tex"),
        "sections/intro.tex"
    );
}

#[test]
fn labels_and_groups_by_the_full_project_path() {
    assert_eq!(
        normalize_path(Some("paper/sections/intro.tex")).as_deref(),
        Some("paper/sections/intro.tex")
    );
    assert_eq!(
        location_label(&diagnostic(
            "error",
            "x",
            Some("arxiv/sections/intro.tex"),
            Some(3)
        )),
        "arxiv/sections/intro.tex:3"
    );
    let both = [
        diagnostic("error", "a", Some("arxiv/sections/intro.tex"), Some(1)),
        diagnostic("error", "b", Some("paper/sections/intro.tex"), Some(1)),
    ];
    let groups: Vec<_> = group_by_file(&both)
        .into_iter()
        .map(|group| group.file)
        .collect();
    assert_eq!(
        groups,
        [
            Some("arxiv/sections/intro.tex".to_string()),
            Some("paper/sections/intro.tex".to_string())
        ]
    );
}

#[test]
fn recognizes_installable_dependencies_but_not_project_templates() {
    assert_eq!(
        missing_tex_dependency_file(
            "Missing LaTeX dependency `algorithm.sty`. BasicTeX does not include every package available on Overleaf."
        )
        .as_deref(),
        Some("algorithm.sty")
    );
    assert_eq!(
        missing_tex_dependency_file(
            "Missing style file `neurips_2026.sty`. It belongs next to main.tex."
        ),
        None
    );
}

#[test]
fn sorts_errors_before_warnings_and_counts_them() {
    let sorted = sort(&[
        diagnostic(
            "warning",
            "Undefined reference.",
            Some("main.tex"),
            Some(20),
        ),
        diagnostic("error", "Missing $.", Some("main.tex"), Some(4)),
        diagnostic("error", "Bad command.", Some("other.tex"), Some(1)),
    ]);
    let messages: Vec<_> = sorted.iter().map(|item| item.message.as_str()).collect();
    assert_eq!(
        messages,
        ["Missing $.", "Bad command.", "Undefined reference."]
    );
    assert_eq!(
        summarize(&sorted),
        Counts {
            error: 2,
            warning: 1,
            info: 0,
            capped: false
        }
    );
    assert_eq!(location_label(&sorted[0]), "main.tex:4");
}

#[test]
fn the_cap_note_marks_the_counts_as_lower_bounds() {
    let mut cap = diagnostic("info", "Only the first 40", None, None);
    cap.code = Some("diagnostics-capped");
    let counts = summarize(&[diagnostic("error", "x", None, None), cap]);
    assert_eq!((counts.error, counts.info, counts.capped), (1, 0, true));
}

#[test]
fn a_fingerprint_ignores_order_but_not_content() {
    let warning = diagnostic("warning", "Fonts are not Times.", Some("main.tex"), Some(4));
    let error = diagnostic("error", "Missing $.", Some("main.tex"), Some(9));
    assert_eq!(
        fingerprint(&[warning.clone(), error.clone()]),
        fingerprint(&[error.clone(), warning.clone()])
    );
    let base = fingerprint(std::slice::from_ref(&warning));
    assert_eq!(fingerprint(std::slice::from_ref(&warning)), base);
    assert_ne!(fingerprint(&[warning.clone(), error]), base);
    assert_ne!(fingerprint(&[]), base);
    let mut moved = warning.clone();
    moved.line = Some(5);
    assert_ne!(fingerprint(&[moved]), base);
    let mut edited = warning;
    edited.message = "Something else.".into();
    assert_ne!(fingerprint(&[edited]), base);
}

#[test]
fn a_failed_log_opens_at_its_first_error() {
    let log = "This is pdfTeX\n(./main.tex\n./main.tex:4: Undefined control sequence.\nl.4 x";
    assert_eq!(&log[failed_log_anchor(log)..][..10], "./main.tex");
    let package = "banner\n! LaTeX Error: File `x.sty' not found.\n";
    assert_eq!(&package[failed_log_anchor(package)..][..2], "! ");
    assert_eq!(failed_log_anchor("Latexmk: all done"), 17);
}

#[test]
fn replaces_the_whole_command_and_nothing_that_starts_with_it() {
    let text = "a \\cite{x}\n\\citep{y} \\cite{z}";
    let range = replace_token_on_line(text, 2, "\\cite").unwrap();
    assert_eq!(range, 21..26);
    assert_eq!(&text[range], "\\cite");
    assert_eq!(replace_token_on_line(text, 2, "\\cietp"), None);
    assert_eq!(replace_token_on_line(text, 3, "\\cite"), None);
}
