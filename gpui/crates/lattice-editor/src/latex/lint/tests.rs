//! The Tauri app's `latex-diagnostics.test.ts` cases, in byte offsets.

use super::*;

fn figure(label: &str, path: &str) -> Reference {
    Reference {
        label: label.into(),
        kind: "figure".into(),
        path: path.into(),
        line: 1,
        ..Reference::default()
    }
}

fn messages(lints: &[Lint]) -> Vec<String> {
    lints.iter().map(|lint| lint.message.clone()).collect()
}

fn set(items: &[&str]) -> HashSet<String> {
    items.iter().map(|item| item.to_string()).collect()
}

fn paths(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

#[test]
fn flags_unmatched_environments_and_duplicate_labels() {
    assert_eq!(
        messages(&structure_lint(
            "\\begin{figure}\n\\label{fig:a}\n\\label{fig:a}\n\\end{table}\n\\begin{equation}\n"
        )),
        [
            "Expected \\end{figure}, found \\end{table}.",
            "Unclosed \\begin{equation}.",
            "Duplicate label “fig:a”.",
        ]
    );
}

#[test]
fn comments_hide_what_folding_hides() {
    for (source, unclosed) in [
        (r"50\% \begin{equation}", true),
        (r"\\%\begin{equation}", false),
        (r"\\\%\begin{equation}", true),
        (r"\\\\% \begin{equation}", false),
        ("$x % \\begin{equation}\n$", false),
    ] {
        let expected: Vec<String> = if unclosed {
            vec!["Unclosed \\begin{equation}.".into()]
        } else {
            Vec::new()
        };
        assert_eq!(messages(&structure_lint(source)), expected, "{source:?}");
    }
    let source = "% \\end{x}\n$a$ % note\n\\begin{equation}";
    let ranges: Vec<_> = structure_lint(source)
        .into_iter()
        .map(|lint| lint.range)
        .collect();
    assert_eq!(ranges, vec![source.find("\\begin").unwrap()..source.len()]);
}

#[test]
fn flags_unclosed_math_and_duplicate_bibliography_keys() {
    let found = messages(&structure_lint("Hello $x + y and $$a"));
    for message in ["Unclosed display math $$", "Unclosed inline math $"] {
        assert!(found.iter().any(|item| item.contains(message)), "{found:?}");
    }
    let found = messages(&structure_lint(
        "@article{same,\n  title={A},\n}\n@misc{same,\n  title={B},\n}\n",
    ));
    assert!(
        found
            .iter()
            .any(|item| item.contains("Duplicate bibliography key “same”"))
    );
}

#[test]
fn warns_about_unknown_unused_and_cross_file_duplicates() {
    let index = LintIndex {
        citation_keys: set(&["known"]),
        references: vec![figure("fig:model", "main.tex")],
        ..LintIndex::default()
    };
    assert_eq!(
        messages(&index_lint(
            "See \\citep{missing} and \\ref{fig:gone}.",
            &index,
            ""
        )),
        [
            "Unknown citation key “missing”.",
            "Unknown label “fig:gone”."
        ]
    );
    let index = LintIndex {
        citation_keys: set(&["dead"]),
        references: vec![figure("fig:dead", "main.tex")],
        unused_labels: set(&["fig:dead"]),
        unused_citations: set(&["dead"]),
        ..LintIndex::default()
    };
    assert_eq!(
        messages(&index_lint(
            "\\label{fig:dead} @article{dead, title={X},}",
            &index,
            "main.tex"
        )),
        ["Unused label “fig:dead”.", "Unused citation key “dead”."]
    );
    let index = LintIndex {
        references: vec![
            figure("fig:shared", "main.tex"),
            figure("fig:shared", "sections/a.tex"),
        ],
        ..LintIndex::default()
    };
    assert!(
        messages(&index_lint("\\label{fig:shared}", &index, "main.tex"))
            .iter()
            .any(|message| message.contains("also defined in sections/a.tex"))
    );
}

#[test]
fn reports_nothing_of_the_index_until_it_has_landed() {
    let index = LintIndex {
        references: vec![figure("fig:shared", "sections/a.tex")],
        project_paths: paths(&["main.tex"]),
        pending: true,
        ..LintIndex::default()
    };
    assert_eq!(
        messages(&index_lint(
            "\\label{fig:shared} \\citep{missing} \\ref{fig:gone} \\input{gone} $x",
            &index,
            "main.tex"
        )),
        ["Unclosed inline math $.", "Missing file “gone”."]
    );
}

#[test]
fn novalidate_lines_and_regions_are_exempt() {
    let source = [
        "\\newcommand{\\bi}{\\begin{itemize}} % novalidate",
        "\\ref{gone:a}",
        "%begin novalidate",
        "\\begin{tikzpicture} \\ref{gone:b} $x",
        "%end novalidate",
        "\\ref{gone:c} 100\\% novalidate",
        "%begin novalidate",
        "\\end{figure}",
    ]
    .join("\n");
    let lints = index_lint(&source, &LintIndex::default(), "");
    assert_eq!(
        messages(&lints),
        ["Unknown label “gone:a”.", "Unknown label “gone:c”."]
    );
    let starts: Vec<&str> = lints
        .iter()
        .map(|lint| &source[lint.range.start..lint.range.start + 6])
        .collect();
    assert_eq!(starts, ["gone:a", "gone:c"]);
}

#[test]
fn flags_missing_paths_and_offers_to_create_the_file() {
    let index = LintIndex {
        project_paths: paths(&["sections/ok.tex", "figures/kept.pdf"]),
        ..LintIndex::default()
    };
    let lints = path_lint(
        "\\input{missing}\n\\includegraphics{figures/gone.pdf}\n\\input{sections/ok}",
        &index,
    );
    assert_eq!(
        messages(&lints),
        [
            "Missing file “missing”.",
            "Missing figure “figures/gone.pdf”."
        ]
    );
    assert_eq!(
        lints[0].action,
        Some(LintAction::CreateFile("missing.tex".into()))
    );
    // Beside a root in a subfolder.
    let index = LintIndex {
        project_paths: paths(&["paper/main.tex"]),
        root_path: "paper/main.tex".into(),
        ..LintIndex::default()
    };
    assert_eq!(
        path_lint("\\input{sections/new}", &index)[0].action,
        Some(LintAction::CreateFile("paper/sections/new.tex".into()))
    );
}

#[test]
fn a_path_that_differs_only_in_case_is_fixed_in_place() {
    let source = [
        "\\input{Sections/Intro}",
        "\\includegraphics[width=2cm]{Figures/Plot.PNG}",
        "\\includegraphics{\\detokenize{Figures\\Plot}}",
        "\\input{sections/gone}",
    ]
    .join("\n");
    let index = LintIndex {
        project_paths: paths(&["main.tex", "sections/intro.tex", "figures/plot.png"]),
        ..LintIndex::default()
    };
    let lints = path_lint(&source, &index);
    assert_eq!(
        messages(&lints),
        [
            "“Sections/Intro” differs in case from sections/intro.tex on disk. Overleaf and arXiv can fail to find it.",
            "Missing file “sections/gone”.",
            "“Figures/Plot.PNG” differs in case from figures/plot.png on disk. Overleaf and arXiv can fail to find it.",
            "“Figures/Plot” differs in case from figures/plot.png on disk. Overleaf and arXiv can fail to find it.",
        ]
    );
    let mut fixed = source.clone();
    for lint in lints.iter().rev() {
        if let Some(LintAction::FixCase { range, insert }) = &lint.action {
            fixed.replace_range(range.clone(), insert);
        }
    }
    assert_eq!(
        fixed.split('\n').collect::<Vec<_>>(),
        [
            "\\input{sections/intro}",
            "\\includegraphics[width=2cm]{figures/plot.png}",
            "\\includegraphics{\\detokenize{figures\\plot}}",
            "\\input{sections/gone}",
        ]
    );
    assert_eq!(
        messages(&path_lint(&fixed, &index)),
        ["Missing file “sections/gone”."]
    );
}

#[test]
fn figures_in_detokenize_or_under_graphicspath_are_found() {
    let index = LintIndex {
        project_paths: paths(&["figures/native-umm-converted.pdf"]),
        ..LintIndex::default()
    };
    assert!(
        path_lint(
            "\\includegraphics[width=\\linewidth]{\\detokenize{figures/native-umm-converted.pdf}}",
            &index
        )
        .is_empty()
    );
    let index = LintIndex {
        project_paths: paths(&["figs/plot.pdf", "images/other.png"]),
        graphics_roots: vec!["figs".into(), "images".into()],
        ..LintIndex::default()
    };
    assert!(path_lint("\\includegraphics{plot}", &index).is_empty());
    assert_eq!(
        messages(&path_lint("\\includegraphics{missing}", &index)),
        ["Missing figure “missing”."]
    );
}
