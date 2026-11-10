use super::hook::{crop_box, hook, parse, submission_names, Placed};
use super::*;
use crate::latex::{build, ActiveBuild, BuildSteps};
use crate::project::test_support::Fixture;

fn record(index: u32, kind: &str, start: u32, file: &str) -> String {
    let (x, y) = (72.27 * 65536.0, 2.0 * 72.27 * 65536.0);
    format!("fig;{index};{kind};{start};{file};100.0pt;50.0pt;2.0pt;1;{x};{y}")
}

#[test]
fn reads_each_recorded_figure_in_tex_points() {
    let placed = parse(&format!(
        "{}\nnoise\nfig;1;figure;0;s.tex;0.0pt;0pt;0pt;1;0;0\n",
        record(1, "scheme", 0, "s.tex")
    ));
    assert_eq!(placed.len(), 1);
    let figure = &placed[0];
    assert_eq!(
        (figure.kind.as_str(), figure.number, figure.file.as_str(), figure.page),
        ("scheme", 1, "s.tex", 1)
    );
    assert!(
        (figure.x - 72.27).abs() < 1e-9
            && (figure.width - 100.0).abs() < 1e-9
            && (figure.depth - 2.0).abs() < 1e-9
    );
}

#[test]
fn names_files_by_function_lettering_several_in_one_float() {
    let text = [
        record(1, "scheme", 0, "s.tex"),
        record(2, "figure", 1, "f.tex"),
        record(3, "scheme", 1, "a.tex"),
        record(4, "scheme", 1, "b.tex"),
        record(5, "none", 0, "toc_art.tex"),
    ]
    .join("\n");
    assert_eq!(
        submission_names(&parse(&text)),
        ["Scheme1", "Figure2", "Scheme2a", "Scheme2b", "toc_art"]
    );
}

#[test]
fn crops_the_box_in_pdf_points_with_its_depth() {
    let figure: Placed = parse(&record(1, "figure", 0, "s.tex")).remove(0);
    let [left, bottom, right, _] = crop_box(&figure);
    assert!((left - 71.0).abs() < 1e-9);
    assert!((bottom - (144.0 - 2.0 * 72.0 / 72.27 - 1.0)).abs() < 1e-9);
    assert!((right - left - (100.0 * 72.0 / 72.27 + 2.0)).abs() < 1e-9);
}

#[test]
fn lists_the_entry_files_for_tex_plainly() {
    let text = hook(&["Document_1-5.tex".into(), "x}{y,z.tex".into()]);
    assert!(text.contains(r"\detokenize{,Document_1-5.tex,xyz.tex,}"), "{text}");
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

#[test]
#[ignore = "requires latexmk and a working pdfLaTeX installation"]
fn exports_each_figure_and_a_source_pack_that_keeps_the_numbers() {
    let fixture = Fixture::empty("journal-export");
    fixture.write("main.tex", MAIN);
    fixture.write("figures/scheme.tex", ENTRY);
    crate::project::open(&fixture.root).unwrap();
    let result =
        build(&fixture.root, false, &ActiveBuild::default(), None, &BuildSteps::silent()).unwrap();
    assert!(result.success, "{}", result.log);
    let parent = Fixture::empty("journal-export-out");
    let options = JournalOptions { tiff: false, dpi: 300, article: true };
    let export = export(&fixture.root, &parent.root, options).unwrap();
    assert_eq!(export.figures, ["Figure1"]);
    assert!(export.problems.is_empty(), "{:?}", export.problems);
    let folder = PathBuf::from(&export.folder);
    let figure = lopdf::Document::load(folder.join("Figure1.pdf")).unwrap();
    assert_eq!(figure.get_pages().len(), 1);
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
