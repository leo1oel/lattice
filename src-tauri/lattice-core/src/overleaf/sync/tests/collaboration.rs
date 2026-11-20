//! Two people editing one project (LATA-51): every way their edits can meet,
//! against Overleaf directly and between two Lattice copies of the project.
//! Text merges against the last synced copy; only edits to the same sentence
//! (code: the same line) conflict, marked in the file itself, with this Mac's
//! untouched copy kept out of the project. A binary file keeps the newer copy.
//! Build output never syncs. Nothing either side wrote is ever lost.
//! Renames and deletions on one side are pinned in `renames.rs` and
//! `deletions.rs`.

use super::*;
use crate::project;

fn set_roots(root: &Path, roots: &[&str], default: &str) {
    let mut manifest = project::default_manifest("paper");
    manifest.root_documents = (roots.iter())
        .map(|path| crate::models::RootDocument {
            path: path.to_string(),
            name: String::new(),
            is_default: *path == default,
            chosen: false,
        })
        .collect();
    project::write_manifest(root, &manifest).unwrap();
}

/// Every file under `root` but Lattice's own folder.
fn project_files(root: &Path) -> Vec<String> {
    let mut files: Vec<String> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
        .filter(|path| !path.starts_with(".research"))
        .collect();
    files.sort();
    files
}

fn no_duplicates(root: &Path) {
    let copies: Vec<_> =
        project_files(root).into_iter().filter(|p| p.contains("conflict")).collect();
    assert!(copies.is_empty(), "{copies:?}");
}

// ---- one Lattice against Overleaf ------------------------------------------------

#[test]
fn different_lines_of_one_file_merge() {
    let (_s, root, result) = run_sync(
        Mock::project(&[("main.tex", b"Alpha.\n\nBeta, theirs.\n")]),
        &[("main.tex", b"Alpha, mine.\n\nBeta.\n")],
        &[("main.tex", b"Alpha.\n\nBeta.\n")],
    );
    assert_eq!(
        (result.merged.as_slice(), result.pushed.as_slice()),
        (&["main.tex".into()][..], &["main.tex".into()][..])
    );
    assert_eq!(text(&root, "main.tex"), "Alpha, mine.\n\nBeta, theirs.\n");
}

#[test]
fn different_sentences_of_one_paragraph_merge() {
    let (server, root, result) = run_sync(
        Mock::project(&[("main.tex", b"One. Two. Three, theirs.\n")]),
        &[("main.tex", b"One, mine. Two. Three.\n")],
        &[("main.tex", b"One. Two. Three.\n")],
    );
    assert!(result.conflicts.is_empty(), "{:?}", result.conflicts);
    assert_eq!(text(&root, "main.tex"), "One, mine. Two. Three, theirs.\n");
    assert_eq!(result.pushed, ["main.tex"]);
    assert_eq!(server.uploads().len(), 1);
}

#[test]
fn the_same_sentence_is_marked_in_place_and_mine_is_kept_out_of_the_project() {
    let mine: &[u8] = b"Intro.\n\nThe result never holds.\n\nEnd.\n";
    let (server, root, result) = run_sync(
        Mock::project(&[("main.tex", b"Intro.\n\nThe result holds always.\n\nEnd.\n")]),
        &[("main.tex", mine)],
        &[("main.tex", b"Intro.\n\nThe result holds.\n\nEnd.\n")],
    );
    let [conflict] = &result.conflicts[..] else { panic!("{:?}", result.conflicts) };
    assert!(conflict.markers && conflict.kept.is_none());
    assert_eq!(
        text(&root, "main.tex"),
        "Intro.\n\n<<<<<<< This Mac\nThe result never holds.\n||||||| Last sync\nThe result holds.\n=======\nThe result holds always.\n>>>>>>> Overleaf\n\nEnd.\n"
    );
    assert_eq!(read_local(&root, &conflict.set_aside).unwrap(), mine);
    no_duplicates(&root);
    assert!(server.uploads().is_empty(), "markers never go up");
}

#[test]
fn different_files_never_meet() {
    let (_s, root, result) = run_sync(
        Mock::project(&[("a.tex", b"a\n"), ("b.tex", b"b theirs\n")]),
        &[("a.tex", b"a mine\n"), ("b.tex", b"b\n")],
        &[("a.tex", b"a\n"), ("b.tex", b"b\n")],
    );
    assert_eq!(
        (result.pulled.as_slice(), result.pushed.as_slice()),
        (&["b.tex".into()][..], &["a.tex".into()][..])
    );
    assert!(result.conflicts.is_empty());
    assert_eq!(text(&root, "b.tex"), "b theirs\n");
}

#[test]
fn a_script_merges_by_line_and_conflicts_in_place() {
    let base: Files = &[("plot.py", b"a = 1\n\nb = 2\n")];
    let (_s, root, result) = run_sync(
        Mock::project(&[("plot.py", b"a = 1\n\nb = 3\n")]),
        &[("plot.py", b"a = 5\n\nb = 2\n")],
        base,
    );
    assert_eq!(result.merged, ["plot.py"]);
    assert_eq!(text(&root, "plot.py"), "a = 5\n\nb = 3\n");

    let (_s, root, result) = run_sync(
        Mock::project(&[("plot.py", b"a = 3\n\nb = 2\n")]),
        &[("plot.py", b"a = 5\n\nb = 2\n")],
        base,
    );
    assert!(result.conflicts[0].markers);
    assert!(text(&root, "plot.py").starts_with("<<<<<<< This Mac\na = 5\n"));
    no_duplicates(&root);
}

#[test]
fn a_file_new_on_both_sides_is_marked_where_they_differ() {
    let (_s, root, result) = run_sync(
        Mock::project(&[("notes.tex", b"Shared.\nTheirs.\n")]),
        &[("notes.tex", b"Shared.\nMine.\n")],
        &[],
    );
    assert!(result.conflicts[0].markers);
    assert_eq!(
        text(&root, "notes.tex"),
        "Shared.\n<<<<<<< This Mac\nMine.\n=======\nTheirs.\n>>>>>>> Overleaf\n"
    );
    assert_eq!(read_local(&root, &result.conflicts[0].set_aside).unwrap(), b"Shared.\nMine.\n");
    no_duplicates(&root);
}

/// Overleaf at version 41, where a co-author replaced `fig.png` at `at` (ms).
fn figure_replaced_at(at: i64) -> Mock {
    let update = json!({ "fromV": 40, "toV": 41, "pathnames": ["fig.png"],
        "project_ops": [], "meta": { "end_ts": at } });
    Mock {
        versions: vec![41],
        history: vec![update],
        ..Mock::project(&[("fig.png", b"\x89PNG theirs\0")])
    }
}

#[test]
fn a_figure_changed_on_both_sides_keeps_the_newer_copy_and_sets_the_other_aside() {
    let base: Files = &[("fig.png", b"\x89PNG base\0")];
    let mine: Files = &[("fig.png", b"\x89PNG mine\0")];
    let agreed = |root: &Path| {
        edit_state(root, |state| {
            (state.remote_version, state.agreed_version) = (Some(40), Some(40))
        })
    };

    // Theirs is newer than the file here (an hour from now).
    let server = figure_replaced_at(chrono::Utc::now().timestamp_millis() + 3_600_000).serve();
    let (config, root) = linked(&server, mine, base);
    agreed(&root);
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    let [conflict] = &result.conflicts[..] else { panic!("{:?}", result.conflicts) };
    assert_eq!(conflict.kept, Some(ConflictSide::Overleaf));
    assert_eq!(read_local(&root, "fig.png").unwrap(), b"\x89PNG theirs\0");
    assert_eq!(read_local(&root, &conflict.set_aside).unwrap(), b"\x89PNG mine\0");
    assert!(server.uploads().is_empty());
    no_duplicates(&root);

    // Mine is newer (theirs is from the day after the last sync).
    let server = figure_replaced_at(last_sync_ms() + 86_400_000).serve();
    let (config, root) = linked(&server, mine, base);
    agreed(&root);
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    let [conflict] = &result.conflicts[..] else { panic!("{:?}", result.conflicts) };
    assert_eq!(conflict.kept, Some(ConflictSide::ThisMac));
    assert_eq!(read_local(&root, "fig.png").unwrap(), b"\x89PNG mine\0");
    assert_eq!(read_local(&root, &conflict.set_aside).unwrap(), b"\x89PNG theirs\0");
    assert_eq!(result.pushed, ["fig.png"]);
    assert_eq!(state_files(&root)["fig.png"], sha256_hex(b"\x89PNG mine\0"));
    no_duplicates(&root);

    // The writer prefers the other copy after all: it is one click back.
    crate::overleaf::restore_set_aside(&root, &conflict.set_aside, "fig.png").unwrap();
    assert_eq!(read_local(&root, "fig.png").unwrap(), b"\x89PNG theirs\0");
    assert!(crate::overleaf::restore_set_aside(&root, &conflict.set_aside, "other.png").is_err());
    assert!(crate::overleaf::restore_set_aside(&root, "fig.png", "fig.png").is_err());
}

// ---- build output ----------------------------------------------------------------

const PAPER: &[u8] = b"\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n";

#[test]
fn no_root_documents_pdf_syncs_either_way() {
    let sources: [(&str, &[u8]); 2] = [("cvpr/main.tex", PAPER), ("cvpr/supp.tex", PAPER)];
    let with = |pdf: &'static [u8]| -> Vec<(&str, &[u8])> {
        sources.iter().copied().chain([("cvpr/supp.pdf", pdf)]).collect()
    };
    // Built here and on Overleaf (an older Lattice sent one up), and agreed once.
    let server = Mock::project(&with(b"%PDF theirs")).serve();
    let (config, root) = linked(&server, &with(b"%PDF mine"), &with(b"%PDF old"));
    set_roots(&root, &["cvpr/main.tex", "cvpr/supp.tex"], "cvpr/main.tex");
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(
        result.conflicts.is_empty() && result.pulled.is_empty() && result.pushed.is_empty(),
        "{result:?}"
    );
    assert_eq!(read_local(&root, "cvpr/supp.pdf").unwrap(), b"%PDF mine");
    assert!(server.uploads().is_empty() && server.with_method("DELETE").is_empty());
    assert!(!state_files(&root).contains_key("cvpr/supp.pdf"));
}

#[test]
fn a_documents_pdf_stays_out_even_when_no_root_lists_it() {
    let base: Files = &[("main.tex", PAPER), ("tmp/check.tex", PAPER)];
    let local: Files = &[("main.tex", PAPER), ("tmp/check.tex", PAPER), ("tmp/check.pdf", b"%PDF")];
    let server = Mock::project(base).serve();
    let (config, root) = linked(&server, local, base);
    set_roots(&root, &["main.tex"], "main.tex");
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.pushed.is_empty(), "{:?}", result.pushed);
}

#[test]
fn a_standalone_figure_the_paper_includes_still_syncs() {
    let main: &[u8] = b"\\documentclass{article}\n\\begin{document}\n\\includegraphics[width=\\linewidth]{figures/plot}\n\\end{document}\n";
    let figure: &[u8] = b"\\documentclass{standalone}\n\\begin{document}x\\end{document}\n";
    let base: Files = &[("main.tex", main), ("figures/plot.tex", figure)];
    let local: Files =
        &[("main.tex", main), ("figures/plot.tex", figure), ("figures/plot.pdf", b"%PDF fig")];
    let server = Mock::project(base).serve();
    let (config, root) = linked(&server, local, base);
    set_roots(&root, &["main.tex", "figures/plot.tex"], "main.tex");
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.pushed, ["figures/plot.pdf"]);
}

// ---- two Lattice copies of one project -----------------------------------------

const DRAFT: &[u8] = b"\\documentclass{article}\n\\begin{document}\nIntro one. Intro two.\n\nMethod one. Method two.\n\\end{document}\n";

#[test]
fn two_copies_editing_one_paragraph_both_land_on_both() {
    let overleaf = Overleaf::new(&[("main.tex", DRAFT)]);
    let (ana, ben) = (overleaf.client(), overleaf.client());
    ana.write("main.tex", &DRAFT.to_vec().replace_text("Intro one.", "Intro one, by Ana."));
    ben.write("main.tex", &DRAFT.to_vec().replace_text("Intro two.", "Intro two, by Ben."));
    assert_eq!(ana.sync().pushed, ["main.tex"]);
    let ben_sync = ben.sync();
    assert_eq!(ben_sync.merged, ["main.tex"], "{ben_sync:?}");
    let both = "Intro one, by Ana. Intro two, by Ben.";
    assert!(ben.text("main.tex").contains(both));
    assert!(ana.sync().pulled == ["main.tex"]);
    assert!(ana.text("main.tex").contains(both));
    assert!(String::from_utf8(overleaf.file("main.tex").unwrap()).unwrap().contains(both));
    no_duplicates(&ana.root);
    no_duplicates(&ben.root);
}

#[test]
fn two_copies_rewriting_one_sentence_conflict_once_and_resolve() {
    let overleaf = Overleaf::new(&[("main.tex", DRAFT)]);
    let (ana, ben) = (overleaf.client(), overleaf.client());
    ana.write(
        "main.tex",
        &DRAFT.to_vec().replace_text("Method one.", "Method one, as Ana has it."),
    );
    ben.write(
        "main.tex",
        &DRAFT.to_vec().replace_text("Method one.", "Method one, as Ben has it."),
    );
    ana.sync();
    let result = ben.sync();
    let [conflict] = &result.conflicts[..] else { panic!("{result:?}") };
    let marked = ben.text("main.tex");
    assert!(
        marked.contains("<<<<<<< This Mac\nMethod one, as Ben has it. Method two.\n"),
        "{marked}"
    );
    // Ana's copy is untouched by Ben's conflict: nothing marked went up.
    assert!(!String::from_utf8(overleaf.file("main.tex").unwrap()).unwrap().contains("<<<<<<<"));
    // Ben keeps both; the resolved file goes up and reaches Ana.
    let resolved = marked
        .replace("<<<<<<< This Mac\n", "")
        .replace("||||||| Last sync\nMethod one. Method two.\n", "")
        .replace("=======\n", "")
        .replace(">>>>>>> Overleaf\n", "");
    ben.write("main.tex", resolved.as_bytes());
    assert_eq!(ben.sync().pushed, ["main.tex"]);
    ana.sync();
    assert_eq!(ana.text("main.tex"), resolved);
    assert_eq!(
        read_local(&ben.root, &conflict.set_aside).unwrap(),
        DRAFT.to_vec().replace_text("Method one.", "Method one, as Ben has it.")
    );
    no_duplicates(&ben.root);
}

#[test]
fn edits_made_offline_merge_on_reconnecting() {
    let overleaf = Overleaf::new(&[("main.tex", DRAFT), ("refs.bib", b"@a{x}\n")]);
    let offline = overleaf.client();
    // While this copy is offline: a co-author edits twice on the web...
    overleaf.web_edit("main.tex", &DRAFT.to_vec().replace_text("Intro two.", "Intro two (web)."));
    let web = overleaf.file("main.tex").unwrap();
    overleaf.web_edit("main.tex", &web.replace_text("Method two.", "Method two (web)."));
    overleaf.web_edit("refs.bib", b"@a{x}\n@b{y}\n");
    // ...and the writer here edits other sentences, and a new file.
    offline.write(
        "main.tex",
        &DRAFT
            .to_vec()
            .replace_text("Intro one.", "Intro one (offline).")
            .replace_text("Method one.", "Method one (offline)."),
    );
    offline.write("notes.md", b"todo\n");
    let result = offline.sync();
    assert!(result.conflicts.is_empty(), "{result:?}");
    let text = offline.text("main.tex");
    for part in ["Intro one (offline). Intro two (web).", "Method one (offline). Method two (web)."]
    {
        assert!(text.contains(part), "{text}");
    }
    assert_eq!(offline.read("refs.bib").unwrap(), b"@a{x}\n@b{y}\n");
    assert_eq!(overleaf.file("notes.md").unwrap(), b"todo\n");
    assert_eq!(overleaf.file("main.tex").unwrap(), text.as_bytes());
}

#[test]
fn two_copies_building_the_same_document_never_meet_over_its_pdf() {
    let overleaf = Overleaf::new(&[("main.tex", PAPER), ("supp.tex", PAPER)]);
    let (ana, ben) = (overleaf.client(), overleaf.client());
    for (client, pdf) in [(&ana, &b"%PDF ana"[..]), (&ben, &b"%PDF ben"[..])] {
        set_roots(&client.root, &["main.tex", "supp.tex"], "main.tex");
        client.write("supp.pdf", pdf);
        client.write("main.pdf", pdf);
        client.write("main.synctex.gz", pdf);
    }
    for _ in 0..2 {
        for client in [&ana, &ben] {
            let result = client.sync();
            assert!(
                result.pushed.is_empty() && result.pulled.is_empty() && result.conflicts.is_empty(),
                "{result:?}"
            );
        }
    }
    assert_eq!(overleaf.file("supp.pdf"), None);
    assert_eq!(ana.read("supp.pdf").unwrap(), b"%PDF ana");
    assert_eq!(ben.read("supp.pdf").unwrap(), b"%PDF ben");
}

#[test]
fn an_edit_here_follows_a_rename_on_overleaf() {
    let overleaf = Overleaf::new(&[("main.tex", DRAFT), ("sec/a.tex", b"Alpha one. Alpha two.\n")]);
    let here = overleaf.client();
    here.write("sec/a.tex", b"Alpha one, edited here. Alpha two.\n");
    overleaf.web_rename("sec/a.tex", "sec/intro.tex");
    let result = here.sync();
    assert!(result.conflicts.is_empty() && result.held_renames.is_empty(), "{result:?}");
    assert_eq!(here.read("sec/a.tex"), None);
    assert_eq!(here.read("sec/intro.tex").unwrap(), b"Alpha one, edited here. Alpha two.\n");
    assert_eq!(overleaf.file("sec/intro.tex").unwrap(), b"Alpha one, edited here. Alpha two.\n");
    assert_eq!(overleaf.file("sec/a.tex"), None, "the old name never comes back");
}

#[test]
fn an_edit_here_survives_a_deletion_on_overleaf_and_a_deletion_here_yields_to_an_edit_there() {
    let overleaf = Overleaf::new(&[("main.tex", DRAFT), ("a.tex", b"a\n"), ("b.tex", b"b\n")]);
    let here = overleaf.client();
    here.write("a.tex", b"a, edited here\n");
    overleaf.web_delete("a.tex");
    fs::remove_file(here.root.join("b.tex")).unwrap();
    overleaf.web_edit("b.tex", b"b, edited there\n");
    let result = here.sync();
    assert!(result.conflicts.is_empty(), "{result:?}");
    assert_eq!(overleaf.file("a.tex").unwrap(), b"a, edited here\n");
    assert_eq!(here.read("b.tex").unwrap(), b"b, edited there\n");
}

trait ReplaceText {
    fn replace_text(&self, from: &str, to: &str) -> Vec<u8>;
}

impl ReplaceText for Vec<u8> {
    fn replace_text(&self, from: &str, to: &str) -> Vec<u8> {
        let text = String::from_utf8(self.clone()).unwrap();
        assert!(text.contains(from), "{from:?} in {text:?}");
        text.replacen(from, to, 1).into_bytes()
    }
}
