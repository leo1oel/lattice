use super::*;
use crate::project::test_support::Fixture;
use std::io::Read;
use zip::ZipArchive;

const MAIN: &str = "\\documentclass{article}\n\\usepackage{graphicx}\n% TODO: tighten the abstract\n\\begin{document}\n\\input{sections/intro}\n\\includegraphics{figures/plot.pdf}\n\\bibliography{refs}\n\\end{document}\n";

/// A project as its last build left it: sources, figures, build output, app
/// state, and the recorder file naming what TeX read and wrote.
fn built_project(label: &str) -> Fixture {
    let fixture = Fixture::empty(label);
    fixture.write("main.tex", MAIN);
    project::open(&fixture.root).unwrap();
    for (path, contents) in [
        ("sections/intro.tex", "Intro text. % ask Ana about this\nMore text.\n"),
        ("figures/plot.pdf", "%PDF-1.5 figure\n"),
        ("figures/unused.png", "png"),
        ("main.bbl", "\\begin{thebibliography}{1}\\end{thebibliography}\n"),
        ("main.aux", "\\relax\n"),
        ("main.pdf", "%PDF-1.5 paper\n"),
        ("refs.bib", "@misc{a}\n"),
        ("neurips.sty", "% the venue's style\n"),
        ("slides/deck.md", "# Talk\n"),
        ("notes.md", "private plans\n"),
        (".research/notes.md", "private\n"),
        (".research/annotations.json", "{}\n"),
    ] {
        fixture.write(path, contents);
    }
    let root = fixture.root.canonicalize().unwrap();
    let recorder = format!(
        "PWD {root}\nINPUT /usr/local/texlive/2025/texmf-dist/tex/latex/base/article.cls\nINPUT main.tex\nOUTPUT main.log\nINPUT ./main.aux\nOUTPUT main.aux\nINPUT sections/intro.tex\nINPUT {root}/figures/plot.pdf\nINPUT neurips.sty\nINPUT main.bbl\nINPUT .research/notes.md\nINPUT figures/deleted.pdf\nOUTPUT main.pdf\n",
        root = root.display()
    );
    fixture.write("main.fls", recorder);
    fixture
}

fn options(strip_comments: bool, merge_inputs: bool) -> ArxivOptions {
    ArxivOptions { strip_comments, merge_inputs }
}

fn staged(fixture: &Fixture, options: ArxivOptions) -> Staged {
    stage(&fixture.root, options).unwrap().expect("the project was built")
}

fn zip_entries(path: &Path) -> BTreeMap<String, String> {
    let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
    (0..archive.len())
        .map(|index| {
            let mut entry = archive.by_index(index).unwrap();
            let mut text = String::new();
            entry.read_to_string(&mut text).unwrap();
            (entry.name().to_string(), text)
        })
        .collect()
}

#[test]
fn the_pack_is_what_the_build_read_inside_the_project_and_never_app_state() {
    let fixture = built_project("arxiv-pack");
    let pack = staged(&fixture, options(false, false));
    assert_eq!(
        pack.files.keys().collect::<Vec<_>>(),
        ["figures/plot.pdf", "main.bbl", "main.tex", "neurips.sty", "sections/intro.tex"]
    );
    assert_eq!(pack.figures, ["figures/plot.pdf"]);
    assert_eq!(pack.missing, ["figures/deleted.pdf"]);
    assert!(matches!(&pack.bibliography, Bibliography::Included { file } if file == "main.bbl"));
    assert_eq!(pack.left_out, ["figures/unused.png", "notes.md", "refs.bib", "slides/"]);
    // Kept as written when the writer keeps comments, and still counted.
    assert_eq!(pack.files["main.tex"], MAIN.as_bytes());
    assert_eq!((pack.comments.count, pack.comments.todos, pack.comments.removed), (2, 1, false));
    assert_eq!(pack.comments.lines[0].text, "TODO: tighten the abstract");
}

#[test]
fn comments_come_out_and_inputs_merge_into_the_root_document() {
    let fixture = built_project("arxiv-options");
    let pack = staged(&fixture, options(true, true));
    let main = std::str::from_utf8(&pack.files["main.tex"]).unwrap();
    assert!(!main.contains("TODO"), "{main}");
    assert!(main.contains("Intro text. %\n"), "{main}");
    assert!(!pack.files.contains_key("sections/intro.tex"));
    assert_eq!(pack.merged, ["sections/intro.tex"]);
    // Merged into the root, not left out of the paper.
    assert!(!pack.left_out.iter().any(|path| path.starts_with("sections")));
    // The style is the venue's: its comments are not the writer's notes.
    assert_eq!(pack.files["neurips.sty"], b"% the venue's style\n");
    assert_eq!((pack.comments.count, pack.comments.removed), (2, true));
}

#[test]
fn an_input_left_empty_by_its_comments_ships_unmerged() {
    let fixture = built_project("arxiv-empty-input");
    fixture.write(
        "main.tex",
        MAIN.replace("\\includegraphics", "\\input{sections/todo}\n\\includegraphics"),
    );
    fixture.write("sections/todo.tex", "% TODO write this\n");
    fixture.write("main.fls", fixture.read("main.fls") + "INPUT sections/todo.tex\n");

    let pack = staged(&fixture, options(true, true));
    assert_eq!(pack.files["sections/todo.tex"], b"");
    assert_eq!(pack.merged, ["sections/intro.tex"]);
    assert!(std::str::from_utf8(&pack.files["main.tex"])
        .unwrap()
        .contains("\\input{sections/todo}\n"));
}

#[test]
fn hand_written_tex_inputs_lose_their_comments_but_postscript_figures_do_not() {
    let fixture = built_project("arxiv-tikz");
    fixture.write(
        "main.tex",
        MAIN.replace("\\includegraphics", "\\input{figures/diagram.tikz}\n\\includegraphics"),
    );
    fixture.write("figures/diagram.tikz", "% note to Ana\n\\draw (0,0);\n");
    let eps = "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n";
    fixture.write("figures/plot.eps", eps);
    let recorder =
        fixture.read("main.fls") + "INPUT figures/diagram.tikz\nINPUT figures/plot.eps\n";
    fixture.write("main.fls", recorder);

    let pack = staged(&fixture, options(true, false));
    assert_eq!(pack.files["figures/diagram.tikz"], b"\\draw (0,0);\n");
    assert_eq!(pack.files["figures/plot.eps"], eps.as_bytes());
    assert!(pack
        .comments
        .lines
        .iter()
        .any(|line| line.file == "figures/diagram.tikz" && line.text == "note to Ana"));
    assert_eq!(pack.comments.count, 3);

    let pack = staged(&fixture, options(true, true));
    assert!(pack.merged.contains(&"figures/diagram.tikz".to_string()));
    assert!(std::str::from_utf8(&pack.files["main.tex"]).unwrap().contains("\\draw (0,0);"));
}

#[test]
fn everything_the_build_wrote_stays_off_the_left_out_list() {
    let fixture = built_project("arxiv-written");
    for path in ["main.lof", "main.nav", "main-blx.bib"] {
        fixture.write(path, "written by TeX\n");
    }
    let recorder =
        fixture.read("main.fls") + "OUTPUT main.lof\nOUTPUT main.nav\nOUTPUT main-blx.bib\n";
    fixture.write("main.fls", recorder);
    let pack = staged(&fixture, options(false, false));
    assert_eq!(pack.left_out, ["figures/unused.png", "notes.md", "refs.bib", "slides/"]);
}

#[test]
fn a_bibliography_without_a_bbl_is_missing_and_an_unbuilt_paper_has_no_pack() {
    let fixture = built_project("arxiv-bbl");
    let recorder = fixture.read("main.fls").replace("INPUT main.bbl\n", "");
    fixture.write("main.fls", recorder);
    assert!(matches!(staged(&fixture, options(true, false)).bibliography, Bibliography::Missing));

    fs::remove_file(fixture.path("main.fls")).unwrap();
    assert!(stage(&fixture.root, options(true, false)).unwrap().is_none());
    let checks = ArxivChecks::default();
    let result = check(&fixture.root, options(true, false), &checks, |_| {}).unwrap();
    assert!(
        matches!(&result, ArxivCheck::Unbuilt { root_document } if root_document == "main.tex")
    );
    // The sheet reads `rootDocument` to name the file in "Build the paper first".
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json, serde_json::json!({ "kind": "unbuilt", "rootDocument": "main.tex" }));
}

#[test]
fn export_writes_the_checked_pack_and_refuses_one_that_changed() {
    let fixture = built_project("arxiv-export");
    let options = options(true, true);
    let digest = staged(&fixture, options).digest;
    let zip_path = fixture.parent.join("out/paper-arxiv.zip");
    export(&fixture.root, options, &digest, &zip_path).unwrap();
    let entries = zip_entries(&zip_path);
    assert_eq!(
        entries.keys().collect::<Vec<_>>(),
        ["figures/plot.pdf", "main.bbl", "main.tex", "neurips.sty"]
    );
    assert!(!entries["main.tex"].contains("TODO"));
    assert!(!zip_path.with_file_name(".paper-arxiv.zip.partial").exists());

    fixture.write("sections/intro.tex", "Rewritten intro.\n");
    let refused = export(&fixture.root, options, &digest, &zip_path).unwrap_err();
    assert!(refused.contains("changed after it was checked"), "{refused}");
}

#[test]
fn a_cancelled_check_skips_its_test_build() {
    let fixture = built_project("arxiv-cancel");
    let checks = ArxivChecks::default();
    let result = check(&fixture.root, options(true, true), &checks, |_| checks.cancel()).unwrap();
    let ArxivCheck::Package(package) = result else { panic!("expected a pack") };
    assert_eq!(package.compile.unwrap().outcome, CompileOutcome::Cancelled);
}

/// The test build itself, where TeX is installed.
#[test]
fn the_pack_builds_alone_without_bibtex() {
    if !commands::available("latexmk") {
        return;
    }
    let fixture = Fixture::empty("arxiv-build");
    fixture.write(
        "main.tex",
        "\\documentclass{article}\n\\begin{document}\n\\input{body}\nSee~\\cite{a}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n",
    );
    fixture.write("body.tex", "Hello % a note\n");
    fixture.write(
        "main.bbl",
        "\\begin{thebibliography}{1}\n\\bibitem{a} A.\n\\end{thebibliography}\n",
    );
    project::open(&fixture.root).unwrap();
    let root = fixture.root.canonicalize().unwrap();
    fixture.write(
        "main.fls",
        format!("PWD {}\nINPUT main.tex\nINPUT body.tex\nINPUT main.bbl\n", root.display()),
    );
    let checks = ArxivChecks::default();
    let ArxivCheck::Package(package) =
        check(&fixture.root, options(true, true), &checks, |_| {}).unwrap()
    else {
        panic!("expected a pack")
    };
    let compile = package.compile.unwrap();
    assert_eq!(compile.outcome, CompileOutcome::Ok, "{:?}", compile.log);
    assert_eq!(compile.pages, Some(1));

    fixture.write("body.tex", "\\undefinedcommand\n");
    let ArxivCheck::Package(package) =
        check(&fixture.root, options(true, true), &checks, |_| {}).unwrap()
    else {
        panic!("expected a pack")
    };
    let compile = package.compile.unwrap();
    assert_eq!(compile.outcome, CompileOutcome::Failed);
    assert!(compile.error.unwrap().message.contains("Undefined control sequence"));
}
