//! Builds that keep their intermediate files in the hidden build folder
//! (`aux_files`): what lands where, and that everything reading a build's
//! files still finds them there.

use super::super::synctex::{forward_search, inverse_search};
use super::super::PdfSyncTarget;
use super::*;
use crate::test_support::TempDir;
use std::path::PathBuf;
use walkdir::WalkDir;

const MAIN: &str = "\\documentclass{article}\n\
    \\usepackage{hyperref}\n\
    \\begin{document}\n\
    \\tableofcontents\n\
    \\include{chapters/intro}\n\
    \\include{chapters/method}\n\
    As \\cite{knuth} shows, Section~\\ref{sec:method} works.\n\
    \\bibliographystyle{plain}\n\
    \\bibliography{refs}\n\
    \\end{document}\n";

const BIB: &str = "@book{knuth,\n  author = {Donald Knuth},\n  title = {The TeXbook},\n  publisher = {Addison-Wesley},\n  year = {1984}\n}\n";

/// The extensions a build writes besides the PDF.
const INTERMEDIATE: &[&str] =
    &[".aux", ".log", ".fls", ".fdb_latexmk", ".bbl", ".blg", ".out", ".toc", ".synctex.gz"];

/// A project whose root document `paper/main.tex` includes two chapters and
/// cites a `.bib` entry.
fn paper() -> (TempDir, PathBuf) {
    let parent = TempDir::new("latex-hidden");
    let root = project::create(&parent, "Hidden build").unwrap();
    let mut manifest = project::read_manifest(&root).unwrap();
    manifest.root_documents[0].path = "paper/main.tex".to_string();
    project::write_manifest(&root, &manifest).unwrap();
    let _ = fs::remove_file(root.join("main.tex"));
    for (path, text) in [
        ("paper/main.tex", MAIN),
        ("paper/chapters/intro.tex", "\\section{Intro}\\label{sec:intro}\nIntro words.\n"),
        ("paper/chapters/method.tex", "\\section{Method}\\label{sec:method}\nMethod words.\n"),
        ("paper/refs.bib", BIB),
    ] {
        fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
        fs::write(root.join(path), text).unwrap();
    }
    (parent, root)
}

fn build_in(root: &Path, layout: AuxFiles, unattended: bool) -> BuildResult {
    build(root, false, unattended, &ActiveBuild::default(), None, &BuildSteps::silent(), layout)
        .unwrap()
}

/// Every intermediate file in the project outside `.research/`.
fn intermediates_outside_research(root: &Path) -> Vec<String> {
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".research")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
        .filter(|path| INTERMEDIATE.iter().any(|extension| path.ends_with(extension)))
        .collect()
}

#[test]
fn a_hidden_build_names_its_folder_to_latexmk() {
    let command = latexmk_into(Path::new("/p"), AuxFiles::Hidden, "paper/main.tex");
    let args: Vec<_> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
    // After latexmk's own `-auxdir=.`, so it wins.
    let beside = args.iter().position(|arg| arg == "-auxdir=.").unwrap();
    let hidden = args.iter().position(|arg| arg == "-auxdir=/p/.research/build/paper").unwrap();
    assert!(beside < hidden, "{args:?}");
    let command = latexmk_into(Path::new("/p"), AuxFiles::Beside, "paper/main.tex");
    assert!(!command.get_args().any(|arg| arg.to_string_lossy().contains(".research")));
}

#[test]
#[ignore = "requires latexmk, pdfLaTeX and BibTeX"]
fn a_hidden_build_leaves_only_the_pdf_beside_the_sources() {
    let (_parent, root) = paper();
    let result = build_in(&root, AuxFiles::Hidden, false);
    assert!(result.success, "{}", result.log);
    assert!(result.has_pdf && result.synctex == Some(true), "{result:?}");
    assert_eq!(result.aux_folder, ".research/build/paper");
    assert!(root.join("paper/main.pdf").is_file());
    assert_eq!(intermediates_outside_research(&root), Vec::<String>::new());
    let hidden = root.join(".research/build/paper");
    for file in ["main.aux", "main.log", "main.bbl", "main.synctex.gz", "chapters/intro.aux"] {
        assert!(hidden.join(file).is_file(), "{file}");
    }
    // The bibliography and the cross-reference resolved: no warnings left.
    assert!(
        !result.diagnostics.iter().any(|item| item.message.contains("undefined")),
        "{:?}",
        result.diagnostics
    );

    // SyncTeX, both ways, through a chapter and through the bibliography.
    let intro = forward_search(&root, "paper/chapters/intro.tex", 2, 0).unwrap().unwrap();
    let middle =
        |target: &PdfSyncTarget| (target.x + target.width / 4.0, target.y + target.height / 2.0);
    let (x, y) = middle(&intro);
    let back = inverse_search(&root, intro.page, x, y).unwrap();
    assert_eq!(back.path, "paper/chapters/intro.tex");
    let entry = forward_search(&root, "paper/refs.bib", 2, 0).unwrap().unwrap();
    let (x, y) = middle(&entry);
    let back = inverse_search(&root, entry.page, x, y).unwrap();
    assert_eq!(back.path, "paper/refs.bib");

    // Nothing changed: latexmk's state in the hidden folder says so.
    let again = build_in(&root, AuxFiles::Hidden, true);
    assert!(again.success && skipped_recompile(&again.log), "{}", again.log);
    assert!(forward_search(&root, "paper/chapters/method.tex", 2, 0).unwrap().is_some());

    // An edit typesets once more, from the hidden folder's state.
    let pdf = fs::read(root.join("paper/main.pdf")).unwrap();
    let method = root.join("paper/chapters/method.tex");
    fs::write(&method, "\\section{Method}\\label{sec:method}\nMore method words.\n").unwrap();
    let edited = build_in(&root, AuxFiles::Hidden, true);
    assert!(edited.success && edited.synctex == Some(true), "{}", edited.log);
    assert_ne!(fs::read(root.join("paper/main.pdf")).unwrap(), pdf);
    assert_eq!(intermediates_outside_research(&root), Vec::<String>::new());

    // Clean is latexmk's, as beside the document: the PDF and its map stay.
    clean(&root).unwrap();
    assert!(!hidden.join("main.aux").exists() && !hidden.join("main.log").exists());
    assert!(!hidden.join("main.fdb_latexmk").exists());
    assert!(root.join("paper/main.pdf").is_file() && hidden.join("main.synctex.gz").is_file());
}

#[test]
#[ignore = "requires latexmk, pdfLaTeX and BibTeX"]
fn switching_the_setting_moves_each_documents_files_at_its_next_build() {
    let (_parent, root) = paper();
    let beside = build_in(&root, AuxFiles::Beside, false);
    assert!(beside.success, "{}", beside.log);
    assert_eq!(beside.aux_folder, "paper");
    assert!(root.join("paper/main.aux").is_file() && root.join("paper/main.synctex.gz").is_file());

    let hidden = build_in(&root, AuxFiles::Hidden, false);
    assert!(hidden.success && hidden.synctex == Some(true), "{}", hidden.log);
    assert_eq!(intermediates_outside_research(&root), Vec::<String>::new());
    assert!(forward_search(&root, "paper/chapters/intro.tex", 2, 0).unwrap().is_some());

    let back = build_in(&root, AuxFiles::Beside, false);
    assert!(back.success && back.synctex == Some(true), "{}", back.log);
    let folder = root.join(".research/build/paper");
    for file in ["main.aux", "main.log", "main.fls", "main.synctex.gz", "chapters/intro.aux"] {
        assert!(!folder.join(file).exists(), "{file} stayed in the hidden folder");
    }
    for file in ["main.aux", "main.log", "main.bbl", "main.synctex.gz", "chapters/intro.aux"] {
        assert!(root.join("paper").join(file).is_file(), "{file}");
    }
    assert!(forward_search(&root, "paper/chapters/intro.tex", 2, 0).unwrap().is_some());
}

#[test]
#[ignore = "requires latexmk, pdfLaTeX and BibTeX"]
fn a_fatal_error_keeps_the_last_pdf_and_its_map_in_the_hidden_folder() {
    let (_parent, root) = paper();
    let first = build_in(&root, AuxFiles::Hidden, false);
    assert!(first.success, "{}", first.log);
    let pdf = fs::read(root.join("paper/main.pdf")).unwrap();

    let broken = MAIN.replace("\\tableofcontents", "\\tableofcontents\n\\input{missing}");
    fs::write(root.join("paper/main.tex"), broken).unwrap();
    let failed = build_in(&root, AuxFiles::Hidden, false);
    assert!(!failed.success, "{}", failed.log);
    assert!(
        failed.diagnostics.iter().any(|item| item.level == "error"
            && item.file.as_deref() == Some("paper/main.tex")
            && item.line == Some(5)),
        "{:?}",
        failed.diagnostics
    );
    // Missing beside the document too: the error is the document's own, and
    // the build stays in the hidden folder.
    assert_eq!(failed.aux_folder, ".research/build/paper");
    assert!(!failed.diagnostics.iter().any(|item| item.code == Some("built-beside")));
    assert!(!root.join("paper/main.log").exists() && !root.join("paper/main.aux").exists());
    // The last good PDF is back with its own map, and SyncTeX still answers.
    assert_eq!(fs::read(root.join("paper/main.pdf")).unwrap(), pdf);
    assert!(root.join(".research/build/paper/main.synctex.gz").is_file());
    assert!(!root.join("paper/main.synctex.gz").exists());
    assert!(forward_search(&root, "paper/chapters/intro.tex", 2, 0).unwrap().is_some());
}

#[test]
#[ignore = "requires latexmk, pdfLaTeX and BibTeX"]
fn a_clean_then_a_build_beside_leaves_no_hidden_map_to_read() {
    let (_parent, root) = paper();
    let hidden = build_in(&root, AuxFiles::Hidden, false);
    assert!(hidden.success, "{}", hidden.log);
    clean(&root).unwrap();
    assert!(root.join(".research/build/paper/main.synctex.gz").is_file());

    // A chapter the hidden build never saw: only a fresh map knows it.
    fs::write(root.join("paper/chapters/extra.tex"), "\\section{Extra}\nExtra words.\n").unwrap();
    let main = MAIN.replace(
        "\\include{chapters/method}",
        "\\include{chapters/method}\n\\include{chapters/extra}",
    );
    fs::write(root.join("paper/main.tex"), main).unwrap();
    let beside = build_in(&root, AuxFiles::Beside, false);
    assert!(beside.success && beside.synctex == Some(true), "{}", beside.log);
    assert_eq!(
        aux_files::synctex(&root, "paper/main.tex"),
        Some(root.join("paper/main.synctex.gz"))
    );
    let folder = root.join(".research/build/paper");
    for file in ["main.synctex.gz", "main.bbl", "main.blg"] {
        assert!(!folder.join(file).exists(), "{file} stayed in the hidden folder");
    }
    assert!(forward_search(&root, "paper/chapters/extra.tex", 2, 0).unwrap().is_some());
}

/// Writes its index entries where TeX writes, then runs makeindex (allowed
/// in TeX's restricted shell escape) from the document's folder and reads
/// what it made: as minted 2.x does with Pygments, this works only when TeX
/// writes beside the document.
const INDEXED: &str = "\\documentclass{article}\n\
    \\newwrite\\terms\n\
    \\immediate\\openout\\terms=\\jobname.terms\n\
    \\immediate\\write\\terms{\\string\\indexentry{Lattice}{1}}\n\
    \\immediate\\closeout\\terms\n\
    \\immediate\\write18{makeindex -q -o \\jobname-terms.tex \\jobname.terms}\n\
    \\begin{document}\n\
    Words.\n\
    \\input{\\jobname-terms}\n\
    \\end{document}\n";

fn trusted_paper(main: &str) -> (TempDir, PathBuf) {
    let (parent, root) = paper();
    let mut manifest = project::read_manifest(&root).unwrap();
    manifest.trusted = true;
    project::write_manifest(&root, &manifest).unwrap();
    fs::write(root.join("paper/main.tex"), main).unwrap();
    (parent, root)
}

fn built_beside_notes(result: &BuildResult) -> usize {
    result.diagnostics.iter().filter(|item| item.code == Some("built-beside")).count()
}

#[test]
#[ignore = "requires latexmk, pdfLaTeX and makeindex"]
fn a_document_that_builds_only_beside_itself_falls_back_and_stays_there() {
    let (_parent, root) = trusted_paper(INDEXED);
    let first = build_in(&root, AuxFiles::Hidden, false);
    assert!(first.success && first.synctex == Some(true), "{}", first.log);
    assert_eq!(built_beside_notes(&first), 1, "{:?}", first.diagnostics);
    assert_eq!(first.aux_folder, "paper");
    assert!(root.join("paper/main.log").is_file() && root.join("paper/main.pdf").is_file());
    assert!(!root.join(".research/build/paper/main.log").exists());

    // Straight beside: a hidden build first would fail and note it again.
    fs::write(root.join("paper/main.tex"), INDEXED.replace("Words.", "More words.")).unwrap();
    let again = build_in(&root, AuxFiles::Hidden, false);
    assert!(again.success, "{}", again.log);
    assert_eq!(built_beside_notes(&again), 0, "{:?}", again.diagnostics);
    assert_eq!(again.aux_folder, "paper");
    assert!(!root.join(".research/build/paper/main.log").exists());
}

#[test]
#[ignore = "requires latexmk and pdfLaTeX"]
fn an_ordinary_error_keeps_the_hidden_folder() {
    let (_parent, root) =
        trusted_paper(&MAIN.replace("\\tableofcontents", "\\tableofcontents\n\\undefinedmacro"));
    let failed = build_in(&root, AuxFiles::Hidden, false);
    assert!(!failed.success, "{}", failed.log);
    assert_eq!(built_beside_notes(&failed), 0, "{:?}", failed.diagnostics);
    assert_eq!(failed.aux_folder, ".research/build/paper");
    assert_eq!(intermediates_outside_research(&root), Vec::<String>::new());

    fs::write(root.join("paper/main.tex"), MAIN).unwrap();
    let fixed = build_in(&root, AuxFiles::Hidden, false);
    assert!(fixed.success, "{}", fixed.log);
    assert_eq!(fixed.aux_folder, ".research/build/paper");
}
