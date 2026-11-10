use super::hook::{hook, parse, submission_names};
use super::*;
use crate::latex::{build, ActiveBuild, BuildSteps};
use crate::project::test_support::Fixture;

fn fig(index: u32, float: u32, kind: &str, file: &str) -> String {
    format!("fig;{index};{float};{kind};figures/;{file};100.0pt;50.0pt;2.0pt")
}

fn names(lines: &[String]) -> Vec<String> {
    submission_names(&parse(&lines.join("\n")))
}

#[test]
fn reads_each_recorded_figure_and_float_number() {
    let record = parse(&format!(
        "{}\nnoise\nfig;2;0;none;;s.tex;0.0pt;0pt;0pt\nfloat;1;scheme;S1\nfloat;x;scheme;2\nshipped;1\n",
        fig(1, 1, "scheme", "s.tex")
    ));
    assert_eq!(record.figures.len(), 1, "a box with no width is no figure");
    let figure = &record.figures[0];
    assert_eq!(
        (figure.index, figure.float, figure.kind.as_str(), figure.path()),
        (1, 1, "scheme", "figures/s.tex".to_string())
    );
    assert!((figure.width - 100.0).abs() < 1e-9 && (figure.depth - 2.0).abs() < 1e-9);
    assert_eq!(record.numbers, BTreeMap::from([(1, "S1".to_string())]));
    assert_eq!(record.shipped, 1);
}

#[test]
fn names_files_by_function_lettering_only_figures_that_share_a_float() {
    let lines = [
        fig(1, 1, "scheme", "s.tex"),
        "float;1;scheme;1".into(),
        fig(2, 2, "figure", "f.tex"),
        "float;2;figure;2".into(),
        fig(3, 3, "scheme", "a.tex"),
        fig(4, 3, "scheme", "b.tex"),
        "float;3;scheme;2".into(),
        fig(5, 0, "none", "toc_art.tex"),
    ];
    assert_eq!(names(&lines), ["Scheme1", "Figure2", "Scheme2a", "Scheme2b", "toc_art"]);
}

#[test]
fn names_follow_the_number_the_paper_prints() {
    // \counterwithin{figure}{section}, then an SI part numbered S1, S2.
    let lines = [
        fig(1, 1, "figure", "a.tex"),
        "float;1;figure;1.1".into(),
        fig(2, 2, "figure", "b.tex"),
        "float;2;figure;2.1".into(),
        fig(3, 3, "figure", "c.tex"),
        "float;3;figure;1".into(),
        fig(4, 4, "figure", "d.tex"),
        "float;4;figure;S1".into(),
    ];
    assert_eq!(names(&lines), ["Figure1-1", "Figure2-1", "Figure1", "FigureS1"]);
}

#[test]
fn a_name_taken_twice_gets_a_count() {
    // Two `scheme.tex` in different folders, in no float, and one in an uncaptioned float.
    let lines = [
        fig(1, 0, "none", "scheme.tex"),
        fig(2, 0, "none", "Scheme.tex"),
        fig(3, 1, "figure", "scheme.tex"),
    ];
    assert_eq!(names(&lines), ["scheme", "Scheme-2", "scheme-3"]);
}

#[test]
fn a_figure_named_after_its_file_gets_a_plain_file_name() {
    let lines = [
        fig(1, 0, "none", "../../../Library/evil.tex"),
        fig(2, 0, "none", ".hidden.tex"),
        fig(3, 0, "weird", "a b/c.tex"),
        fig(4, 1, "figure", "x.tex"),
        "float;1;figure;../..".into(),
    ];
    assert_eq!(names(&lines), ["evil", "hidden", "c", "x"]);
}

#[test]
fn takes_only_entries_the_export_listed_by_their_project_path() {
    let entries = BTreeMap::from([
        ("figures/scheme.tex".to_string(), String::new()),
        ("si/scheme.tex".to_string(), String::new()),
        ("paper/art/toc.tex".to_string(), String::new()),
    ]);
    let record = parse(
        &[
            "fig;1;0;none;figures/;scheme.tex;1pt;1pt;0pt",
            "fig;2;0;none;./si;scheme.tex;1pt;1pt;0pt",
            "fig;3;0;none;;toc.tex;1pt;1pt;0pt",
            "fig;4;0;none;;scheme.tex;1pt;1pt;0pt",
            "fig;5;0;none;../../etc;scheme.tex;1pt;1pt;0pt",
            "fig;6;0;none;figures;other.tex;1pt;1pt;0pt",
        ]
        .join("\n"),
    );
    let placed = placed_entries(&record.figures, &entries, "paper/main.tex");
    let found: Vec<(&str, u32)> =
        placed.iter().map(|(path, figure)| (path.as_str(), figure.index)).collect();
    assert_eq!(found, [("figures/scheme.tex", 1), ("si/scheme.tex", 2), ("paper/art/toc.tex", 3)]);
}

#[test]
fn lists_the_entry_files_for_tex_plainly() {
    let text = hook(&["Document_1-5.tex".into(), "x}{y,z;.tex".into()]);
    assert!(text.contains(r"\detokenize{,Document_1-5.tex,xyz.tex,}"), "{text}");
    assert!(text.contains(r"\RawShipout"), "figure pages bypass the page hooks");
    assert!(text.contains(r"\immediate\openout\ljx@out=\jobname.figures"));
    assert!(!text.contains("{{"), "a doubled brace is a format string escape left behind");
}

#[test]
fn an_entry_becomes_its_figure_with_its_marks_unprinted() {
    let entry = "% editable-figure source: s.reactio\n\\node {\\textbf{\\rcmpd{1}}~(xx\\%)};\n\\node {\\cmpd[pre-label-code=x]{a.b}};\n% \\rcmpd{commented}\n";
    assert_eq!(
        replacement(entry, "Scheme1"),
        "\\includegraphics{Scheme1}\\begingroup\\setbox0\\hbox{\\rcmpd{1}\\cmpd[pre-label-code=x]{a.b}}\\endgroup%\n"
    );
    assert_eq!(
        replacement("% editable-figure source: s.svg\n\\includegraphics{s.pdf}\n", "Figure2"),
        "\\includegraphics{Figure2}%\n"
    );
}

#[test]
fn a_merged_figure_line_loses_its_space_line_and_keeps_its_space() {
    let replacement =
        replacement("% editable-figure source: s.svg\n\\includegraphics{s.pdf}\n", "Figure1");
    let mut files = BTreeMap::from([(
        "main.tex".to_string(),
        format!("  \\centering\n  {replacement}\\space\n  \\caption{{}}\n").into_bytes(),
    )]);
    tidy_merged_figures(&mut files, [replacement].iter());
    assert_eq!(
        String::from_utf8(files.remove("main.tex").unwrap()).unwrap(),
        "  \\centering\n  \\includegraphics{Figure1}\n  \\caption{}\n"
    );
}

#[test]
fn finds_only_entry_files_and_never_hidden_ones() {
    let fixture = Fixture::empty("journal-entries");
    fixture.write("main.tex", "\\documentclass{article}\n");
    fixture.write("figures/s.tex", "% editable-figure source: s.reactio\nx\n");
    fixture.write("figures/plain.tex", "% just a file\n");
    fixture.write(".research/x.tex", "% editable-figure source: x.reactio\n");
    let root = fixture.root.canonicalize().unwrap();
    assert_eq!(entry_files(&root).into_keys().collect::<Vec<_>>(), ["figures/s.tex"]);
}

#[test]
fn writes_only_into_its_own_folder_outside_the_project() {
    let fixture = Fixture::empty("journal-folder");
    let root = fixture.root.canonicalize().unwrap();
    assert!(output_folder(&root, &root).is_err());
    fs::create_dir_all(root.join("sub")).unwrap();
    assert!(output_folder(&root, &root.join("sub/..")).is_err(), "a parent is compared as it is");
    let parent = Fixture::empty("journal-parent");
    let parent_root = parent.root.canonicalize().unwrap();
    let name = format!("{}-journal", root.file_name().unwrap().to_string_lossy());
    fs::create_dir_all(parent_root.join(&name)).unwrap();
    fs::write(parent_root.join(&name).join("mine.txt"), "keep").unwrap();
    assert!(output_folder(&root, &parent_root).is_err(), "a folder it did not make is left alone");
    fs::remove_dir_all(parent_root.join(&name)).unwrap();
    let folder = output_folder(&root, &parent_root).unwrap();
    fs::write(folder.join("Scheme1.pdf"), "old").unwrap();
    let again = output_folder(&root, &parent_root).unwrap();
    assert!(!again.join("Scheme1.pdf").exists(), "an earlier export of its own is replaced");
}

const MAIN: &str = r"\documentclass{article}
\usepackage{chemnum}
\begin{document}
Early \cmpd{a}.
\begin{figure}[h]
\centering
\input{figures/scheme}
\caption{A scheme.}
\end{figure}
Then \cmpd{c} and \cmpd{b}.
\end{document}
";

const ENTRY: &str = r"% editable-figure source: scheme.reactio
\fbox{\rule{0pt}{2cm}\rule{3cm}{0pt}}\quad\textbf{\cmpd{b}}\quad\textbf{\cmpd{a}}
";

/// Builds the project in Lattice, then exports it. The fixtures go with the
/// last value, so the export is there while the test reads it.
fn build_and_export(name: &str, files: &[(&str, &str)]) -> (JournalExport, PathBuf, [Fixture; 2]) {
    let fixture = Fixture::empty(name);
    for (path, text) in files {
        fixture.write(path, text);
    }
    crate::project::open(&fixture.root).unwrap();
    let result =
        build(&fixture.root, false, &ActiveBuild::default(), None, &BuildSteps::silent()).unwrap();
    assert!(result.success, "{}", result.log);
    let parent = Fixture::empty(&format!("{name}-out"));
    let options = JournalOptions { tiff: false, dpi: 300, article: true };
    let export = export(&fixture.root, &parent.root, options).unwrap();
    let folder = PathBuf::from(&export.folder);
    (export, folder, [fixture, parent])
}

/// A figure's one page: its size in PDF points and its text.
fn figure_page(path: &Path) -> (f64, f64, String) {
    let doc = lopdf::Document::load(path).unwrap();
    assert_eq!(doc.get_pages().len(), 1, "{}", path.display());
    let page = *doc.get_pages().get(&1).unwrap();
    let media = doc.get_dictionary(page).unwrap().get(b"MediaBox").unwrap().as_array().unwrap();
    let number = |object: &lopdf::Object| object.as_float().unwrap_or_default() as f64;
    let size = (number(&media[2]) - number(&media[0]), number(&media[3]) - number(&media[1]));
    (size.0, size.1, doc.extract_text(&[1]).unwrap_or_default())
}

#[test]
#[ignore = "requires latexmk and a working pdfLaTeX installation"]
fn exports_each_figure_and_a_source_pack_that_keeps_the_numbers() {
    let (export, folder, _fixtures) =
        build_and_export("journal-export", &[("main.tex", MAIN), ("figures/scheme.tex", ENTRY)]);
    assert_eq!(export.figures, ["Figure1"]);
    assert!(export.problems.is_empty(), "{:?}", export.problems);
    let (width, height, text) = figure_page(&folder.join("Figure1.pdf"));
    // The frame is 3 cm by 2 cm plus the marks, with a 1 pt margin; nothing of the page comes along.
    assert!(width > 85.0 && width < 200.0 && height > 56.0 && height < 70.0, "{width} x {height}");
    assert!(!text.contains("Early") && !text.contains("scheme"), "{text}");
    let main = fs::read_to_string(folder.join("main.tex")).unwrap();
    assert!(
        main.contains(
            r"\includegraphics{Figure1}\begingroup\setbox0\hbox{\cmpd{b}\cmpd{a}}\endgroup"
        ),
        "{main}"
    );
    assert!(!folder.join("figures/scheme.tex").exists());
    assert_eq!(
        export.article.as_ref().map(|check| check.outcome),
        Some(super::super::CompileOutcome::Ok)
    );
    assert!(folder.join("main.pdf").is_file());
}

const NUMBERED: &str = r"\documentclass{article}
\usepackage{graphicx}
\usepackage{chemnum}
\counterwithin{figure}{section}
\begin{document}
\section{One}
Start with \cmpd{a}.
\begin{figure}[h]
\centering
\resizebox{0.9\linewidth}{!}{\input{figures/left}}
\caption{Scaled.}
\end{figure}
\section{Two}
\begin{figure}[h]
\centering
\input{figures/right}\hfill\input{art/right}
\caption{Two drawings.}
\end{figure}
\clearpage
\setcounter{figure}{0}
\renewcommand\thefigure{S\arabic{figure}}
\begin{figure}[h]
\input{figures/si}
\caption{Supporting.}
\end{figure}
\input{figures/toc}
\end{document}
";

fn entry(width: &str, mark: &str) -> String {
    format!(
        "% editable-figure source: x.reactio\n\\fbox{{\\rule{{0pt}}{{1cm}}\\rule{{{width}}}{{0pt}}}}\\quad\\textbf{{\\cmpd{{{mark}}}}}\n"
    )
}

#[test]
#[ignore = "requires latexmk and a working pdfLaTeX installation"]
fn names_follow_the_printed_numbers_and_a_scaled_figure_comes_whole() {
    let (left, right, art, si, toc) = (
        entry("12cm", "a"),
        entry("2cm", "b"),
        entry("2cm", "c"),
        entry("2cm", "d"),
        entry("1cm", "e"),
    );
    let (export, folder, _fixtures) = build_and_export(
        "journal-numbered",
        &[
            ("paper/main.tex", NUMBERED),
            ("figures/left.tex", &left),
            ("figures/right.tex", &right),
            ("art/right.tex", &art),
            ("figures/si.tex", &si),
            ("figures/toc.tex", &toc),
        ],
    );
    assert_eq!(
        export.figures,
        ["Figure1-1", "Figure2-1a", "Figure2-1b", "FigureS1", "toc"],
        "{:?}",
        export.problems
    );
    // The paper scales it to 0.9\linewidth; the export has it whole, at its own 12 cm.
    let (width, _, text) = figure_page(&folder.join("paper/Figure1-1.pdf"));
    assert!(width > 12.0 * 72.0 / 2.54, "{width}");
    assert!(!text.contains("Start"), "{text}");
    // The `\input`s the pack does not merge (inside a group) become the figure in place too.
    let main = fs::read_to_string(folder.join("paper/main.tex")).unwrap();
    for name in ["Figure1-1", "Figure2-1a", "Figure2-1b", "FigureS1", "toc"] {
        assert!(main.contains(&format!("\\includegraphics{{{name}}}")), "{main}");
    }
    assert!(!main.contains("\\input{figures"), "{main}");
    assert!(!folder.join("figures/left.tex").exists());
    assert_eq!(
        export.article.as_ref().map(|check| check.outcome),
        Some(super::super::CompileOutcome::Ok),
        "{:?}",
        export.article
    );
}
