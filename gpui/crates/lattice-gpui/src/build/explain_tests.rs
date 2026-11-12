//! The Tauri app's own cases (`src/build/compile-explain.test.ts`).

use super::*;
use crate::build::diagnostics::tests::diagnostic;

const SOURCE: &str = "\\documentclass{article}\n\\begin{document}\nAttention \\citep{bahdanau2015} and \\citep{vaswani2017} and \\citep{luong2015}.\nNeural machine translation systems \\cietp{luong2015effective}.\n\\end{document}";
const LOG: &str = "./main.tex:4: Undefined control sequence.\nl.4 Neural machine translation systems \\cietp\n                {luong2015effective}.";

fn undefined_command() -> Diagnostic {
    diagnostic(
        "error",
        "Undefined control sequence.",
        Some("main.tex"),
        Some(4),
    )
}

fn options<'a>(log: &'a str, source: Option<&'a str>, after_error: bool) -> ExplainOptions<'a> {
    ExplainOptions {
        log,
        source,
        after_error,
        ..ExplainOptions::default()
    }
}

fn marked(line: &ExcerptLine) -> &str {
    let (start, end) = line.token.expect("a marked token");
    &line.text[start..end]
}

#[test]
fn names_the_unknown_command_quotes_its_line_and_suggests_the_papers_own() {
    let explained = explain(&undefined_command(), options(LOG, Some(SOURCE), true)).unwrap();
    assert_eq!(explained.headline, "Unknown command \\cietp");
    assert_eq!(
        explained.explanation,
        "LaTeX doesn’t know \\cietp. It looks like a typo for \\citep, which this paper uses 3 times."
    );
    assert_eq!(explained.suggestion.as_deref(), Some("\\citep"));
    let lines: Vec<_> = explained
        .excerpt
        .iter()
        .map(|line| (line.number, line.failing))
        .collect();
    assert_eq!(lines, [(3, false), (4, true), (5, false)]);
    assert_eq!(marked(&explained.excerpt[1]), "\\cietp");
}

#[test]
fn no_suggestion_when_nothing_is_close_or_two_tie() {
    let far_log = LOG.replace("\\cietp", "\\zzqxv");
    let far_source = SOURCE.replace("\\cietp", "\\zzqxv");
    let far = explain(
        &undefined_command(),
        options(&far_log, Some(&far_source), true),
    )
    .unwrap();
    assert_eq!(far.headline, "Unknown command \\zzqxv");
    assert_eq!(far.suggestion, None);
    assert!(far.explanation.contains("Check its spelling"));
    // \citex is one edit from \citet and \citep, each used once here.
    let tied_log = LOG.replace("\\cietp", "\\citex");
    let tied = explain(
        &undefined_command(),
        options(&tied_log, Some("\\citet{a} \\citep{b} \\citex{c}"), true),
    );
    assert_eq!(tied.and_then(|tied| tied.suggestion), None);
    // LaTeX's own vocabulary answers when the paper has nothing close.
    let known_log = LOG.replace("\\cietp", "\\sectoin");
    let known = explain(
        &undefined_command(),
        options(&known_log, Some("a\nb\nc\n\\sectoin{Intro}"), true),
    )
    .unwrap();
    assert_eq!(known.suggestion.as_deref(), Some("\\section"));
    assert_eq!(
        known.explanation,
        "LaTeX doesn’t know \\sectoin. It looks like a typo for \\section."
    );
}

#[test]
fn does_not_guess_for_a_short_command() {
    let log = LOG.replace("\\cietp", "\\fo");
    let short = explain(&undefined_command(), options(&log, Some(SOURCE), true));
    assert_eq!(short.and_then(|short| short.suggestion), None);
}

#[test]
fn explains_a_table_end_arydshln_broke_only_when_the_build_noticed() {
    let table = "\\begin{tabularx}{\\textwidth}{l*{6}{C}}\nModel & $\\Delta$ \\\\\n\\end{tabularx}";
    let extra = diagnostic(
        "error",
        "Extra }, or forgotten $.",
        Some("section/5_experiments_v2.tex"),
        Some(3),
    );
    let plain = options("", Some(table), true);
    let clashing = ExplainOptions {
        table_ends_clash: true,
        ..plain
    };
    let clash = explain(&extra, clashing).unwrap();
    assert_eq!(
        clash.headline,
        "arydshln and colortbl clash at this table’s end"
    );
    assert!(clash.explanation.contains(
        "Load arydshln before colortbl in the preamble, or remove \\usepackage{arydshln}"
    ));
    let failing = clash.excerpt.iter().find(|line| line.failing).unwrap();
    assert_eq!(marked(failing), "\\end{tabularx}");
    // Without the notice, TeX's own reading stands.
    assert_eq!(
        explain(&extra, plain).unwrap().headline,
        "A } with no { before it"
    );
    // A math error inside the table is the paper's own.
    let mut math = extra.clone();
    math.message = "Missing $ inserted.".into();
    math.line = Some(2);
    assert_eq!(
        explain(&math, clashing).unwrap().headline,
        "Math outside math mode"
    );
}

#[test]
fn falls_back_to_tex_when_the_log_has_no_context_line() {
    assert_eq!(
        explain(
            &undefined_command(),
            options("Build output", Some(SOURCE), true)
        ),
        None
    );
}

#[test]
fn reads_the_log_from_the_root_documents_folder() {
    // TeX names `sec/a.tex` from the compiled document's folder; the
    // diagnostic was rebased onto the project root.
    let section_log =
        "sec/a.tex:86: Undefined control sequence.\nl.86 \\SuspendTagging\n                {x}";
    let source = (0..86)
        .map(|index| {
            if index == 85 {
                "\\SuspendTagging{x}"
            } else {
                "text"
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let headline = |file: &str, log: &str, root: &str| {
        let mut diagnostic = undefined_command();
        diagnostic.file = Some(file.into());
        diagnostic.line = Some(86);
        explain(
            &diagnostic,
            ExplainOptions {
                root_document: root,
                ..options(log, Some(&source), true)
            },
        )
        .map(|explained| explained.headline)
    };
    let expected = Some("Unknown command \\SuspendTagging".to_string());
    assert_eq!(headline("sec/a.tex", section_log, "main.tex"), expected);
    assert_eq!(
        headline("cvpr/sec/a.tex", section_log, "cvpr/main.tex"),
        expected
    );
    // A file beside the folder, named with `..`, is rebased the same way.
    let shared_log = section_log.replace("sec/a.tex", "../shared/a.tex");
    assert_eq!(
        headline("shared/a.tex", &shared_log, "cvpr/main.tex"),
        expected
    );
}

#[test]
fn reads_each_errors_own_context() {
    let twice = [
        "./main.tex:4: Undefined control sequence.",
        "l.4 Neural \\cietp",
        "               {a} and \\reff{b}.",
        "./main.tex:4: Undefined control sequence.",
        "l.4 Neural \\cietp{a} and \\reff",
        "                         {b}.",
    ]
    .join("\n");
    let line = SOURCE.replace("\\cietp{luong2015effective}", "\\cietp{a} and \\reff{b}");
    let first = explain(
        &undefined_command(),
        ExplainOptions {
            same_after: 1,
            ..options(&twice, Some(&line), true)
        },
    )
    .unwrap();
    assert_eq!(first.headline, "Unknown command \\cietp");
    let second = explain(&undefined_command(), options(&twice, Some(&line), true)).unwrap();
    assert_eq!(second.headline, "Unknown command \\reff");
    assert_eq!(marked(&second.excerpt[1]), "\\reff");
}

#[test]
fn a_command_a_macro_reached_is_named_but_its_line_is_neither_quoted_nor_rewritten() {
    let log = "./main.tex:4: Undefined control sequence.\n\\vect ->\\vec{v}\\xspce \n                    \nl.4 Neural machine translation systems \\vect\n";
    let source = SOURCE.replace("\\cietp{luong2015effective}", "\\vect");
    let explained = explain(&undefined_command(), options(log, Some(&source), true)).unwrap();
    assert_eq!(explained.headline, "Unknown command \\xspce");
    assert_eq!(explained.suggestion, None);
    assert!(explained.excerpt.is_empty());
}

#[test]
fn leaves_a_missing_package_or_class_to_the_install_advice() {
    for file in [
        "neurips_2024.sty",
        "acmart.cls",
        "plainnat.bst",
        "authoryear.bbx",
        "authoryear.cbx",
    ] {
        let missing = diagnostic(
            "error",
            &format!("LaTeX Error: File `{file}' not found."),
            Some("main.tex"),
            Some(3),
        );
        assert_eq!(explain(&missing, options("", Some(SOURCE), true)), None);
    }
}

#[test]
fn leaves_lattices_own_advice_and_unknown_messages_alone() {
    let mut stale = diagnostic("error", "Stale failed build.", None, None);
    stale.code = Some("stale-build");
    assert_eq!(explain(&stale, options(LOG, Some(SOURCE), true)), None);
    let other = diagnostic("warning", "Something else.", None, None);
    assert_eq!(explain(&other, options(LOG, Some(SOURCE), false)), None);
}

#[test]
fn rewrites_the_common_warnings_saying_when_one_may_echo_the_error() {
    let citation = diagnostic(
        "warning",
        "Citation `luong2015effective' on page 1 undefined on input line 4.",
        None,
        None,
    );
    let echoed = explain(&citation, options(LOG, Some(SOURCE), true)).unwrap();
    assert_eq!(echoed.headline, "No entry for luong2015effective");
    assert!(
        echoed
            .explanation
            .contains("may clear once the error above is fixed")
    );
    assert!(echoed.excerpt.is_empty());
    let alone = explain(&citation, options(LOG, Some(SOURCE), false)).unwrap();
    assert!(alone.explanation.contains("add the entry to the .bib file"));
    let overfull = diagnostic(
        "warning",
        "Overfull \\hbox (6.1pt too wide) in paragraph at lines 4--4",
        None,
        None,
    );
    assert_eq!(
        explain(&overfull, options(LOG, Some(SOURCE), false))
            .unwrap()
            .headline,
        "A line runs 6.1 pt into the margin"
    );
    let reference = diagnostic(
        "warning",
        "Reference `fig:arch' on page 2 undefined on input line 9.",
        None,
        None,
    );
    assert_eq!(
        explain(&reference, options(LOG, Some(SOURCE), false))
            .unwrap()
            .explanation,
        "Nothing in the paper has \\label{fig:arch}. Check the spelling, or add the label where the reference should point."
    );
}

#[test]
fn explains_each_common_message() {
    let cases = [
        ("Missing $ inserted.", "Math outside math mode"),
        ("Extra }, or forgotten $.", "A } with no { before it"),
        ("Missing } inserted.", "A { is never closed"),
        (
            "File ended while scanning use of \\textbf.",
            "A { is never closed",
        ),
        (
            "Paragraph ended before \\emph was complete.",
            "\\emph runs past a blank line",
        ),
        (
            "Extra alignment tab has been changed to \\cr.",
            "Too many & in a table row",
        ),
        (
            "Misplaced alignment tab character &.",
            "An & outside a table",
        ),
        ("Double subscript.", "Two subscripts in a row"),
        (
            "LaTeX Error: Environment algorithmic undefined.",
            "Unknown environment algorithmic",
        ),
        (
            "LaTeX Error: \\begin{figure} on input line 12 ended by \\end{table}.",
            "\\begin{figure} is closed by \\end{table}",
        ),
        (
            "LaTeX Error: File `figures/plot.pdf' not found.",
            "File not found: figures/plot.pdf",
        ),
        (
            "LaTeX Error: Missing \\begin{document}.",
            "Text before \\begin{document}",
        ),
        (
            "LaTeX Error: Can be used only in preamble.",
            "A preamble command inside the document",
        ),
        (
            "LaTeX Error: Option clash for package xcolor.",
            "xcolor is loaded twice with different options",
        ),
        (
            "Illegal unit of measure (pt inserted).",
            "A length without a unit",
        ),
        (
            "Label `sec:intro' multiply defined.",
            "The label sec:intro is used twice",
        ),
        (
            "Float too large for page by 12.3pt on input line 40.",
            "A figure or table is 12.3 pt taller than the page",
        ),
    ];
    for (message, headline) in cases {
        let item = diagnostic("error", message, Some("main.tex"), Some(4));
        let explained = explain(&item, options("", Some(SOURCE), true));
        assert_eq!(
            explained.map(|explained| explained.headline).as_deref(),
            Some(headline),
            "{message}"
        );
    }
}

#[test]
fn explains_pdflatex_cjk_unicode_errors_and_leaves_other_characters() {
    let refused = |character: &str, code: &str| {
        diagnostic(
            "error",
            &format!("LaTeX Error: Unicode character {character} (U+{code})"),
            Some("main.tex"),
            Some(1),
        )
    };
    let chinese = explain(
        &refused("论", "8BBA"),
        options("", Some("\\title{我的论文}"), true),
    )
    .unwrap();
    assert_eq!(chinese.headline, "pdfLaTeX can’t typeset 论");
    assert_eq!(
        chinese.explanation,
        "pdfLaTeX has no fonts for Chinese, Japanese or Korean text. Add \\usepackage{ctex} to the preamble and switch the project to XeLaTeX."
    );
    assert_eq!(marked(&chinese.excerpt[0]), "论");
    assert_eq!(
        explain(&refused("한", "D55C"), options("", None, true))
            .unwrap()
            .headline,
        "pdfLaTeX can’t typeset 한"
    );
    assert_eq!(
        explain(&refused("☃", "2603"), options("", None, true)),
        None
    );
}

#[test]
fn transpositions_count_as_one_edit() {
    assert_eq!(edit_distance("\\cietp", "\\citep"), 1);
    assert_eq!(edit_distance("\\sectoin", "\\section"), 1);
    assert_eq!(edit_distance("abc", "abc"), 0);
}
