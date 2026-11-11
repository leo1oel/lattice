//! Folders deleted or renamed on Overleaf (issue #840): the build outputs
//! and empty folders Lattice left in them go too, here and in the merge-base
//! tree, while anything of the writer's stays and is named.

use super::*;
use crate::overleaf::sync::stale_folders::KeptFolder;

const MAIN: &[u8] = b"\\documentclass{article}\n\\input{msec/intro}\n";
const INTRO: &[u8] = b"\\section{Intro}\n";
const PLOT: &[u8] = b"\x89PNG plot";
const FIGURE: &[u8] = b"\\documentclass{standalone}\n";
const ROOT: &[u8] = b"\\documentclass{article}\n";

/// The paper in `A/` on Overleaf, beside a root document.
fn paper_in(folder: &str) -> Vec<(String, &'static [u8])> {
    let files = [
        ("main.tex", MAIN),
        ("msec/intro.tex", INTRO),
        ("figs/sub/plot.png", PLOT),
        ("figs/sub/plot.tex", FIGURE),
    ];
    let mut paper: Vec<(String, &[u8])> =
        files.iter().map(|(path, bytes)| (format!("{folder}/{path}"), *bytes)).collect();
    paper.push(("root.tex".to_string(), ROOT));
    paper
}

fn borrowed<'a>(files: &'a [(String, &'static [u8])]) -> Vec<(&'a str, &'static [u8])> {
    files.iter().map(|(path, bytes)| (path.as_str(), *bytes)).collect()
}

/// What a build of `A/main.tex` and the standalone `A/figs/sub/plot.tex`
/// leaves beside them, known by their names.
const BUILD_OUTPUTS: [&str; 11] = [
    "A/main.aux",
    "A/main.bbl",
    "A/main.blg",
    "A/main.brf",
    "A/main.fdb_latexmk",
    "A/main.fls",
    "A/main.log",
    "A/main.out",
    "A/main.synctex.gz",
    "A/figs/sub/plot.aux",
    "A/figs/sub/plot.synctex(busy)",
];

fn exists(root: &Path, rel: &str) -> bool {
    disk_path(root, rel).symlink_metadata().is_ok()
}

fn base_folder(root: &Path, rel: &str) -> bool {
    exists(root, &format!(".research/overleaf-base/{rel}"))
}

/// `A/` built here, with an empty subfolder no file ever filled, linked to an
/// Overleaf that now holds `remote` instead; `local_extra` is put in `A/` too.
fn built_paper(remote: Files, local_extra: Files) -> (MockServer, TempDir, TempDir) {
    let paper = paper_in("A");
    let base = borrowed(&paper);
    let outputs: Vec<(&str, &[u8])> =
        BUILD_OUTPUTS.iter().map(|path| (*path, b"generated".as_slice())).collect();
    let local = [base.as_slice(), &outputs, local_extra].concat();
    let server = Mock { versions: vec![42], ..Mock::project(remote) }.serve();
    let (config, root) = linked(&server, &local, &base);
    fs::create_dir_all(disk_path(&root, "A/figs/qual")).unwrap();
    assert!(base_folder(&root, "A/msec"), "the clone kept a merge base there");
    (server, config, root)
}

#[test]
fn a_folder_renamed_or_deleted_on_overleaf_leaves_nothing_of_lattices_behind() {
    let renamed = paper_in("B");
    let deleted: Files = &[("root.tex", ROOT)];
    // Finder's noise goes with the folders it sat in.
    let finder: Files = &[("A/.DS_Store", b"finder"), ("A/msec/.DS_Store", b"finder")];
    for (label, remote) in [("renamed to B", borrowed(&renamed)), ("deleted", deleted.to_vec())] {
        let (_server, config, root) = built_paper(&remote, finder);
        let result = sync(&config, &root, NO_LIVE, None).unwrap();
        assert!(result.deleted_local.contains(&"A/main.tex".to_string()), "{label}");
        assert!(result.kept_folders.is_empty(), "{label}: {:?}", result.kept_folders);
        assert!(!exists(&root, "A"), "{label}: A/ is gone, outputs and empty folders too");
        assert!(!base_folder(&root, "A"), "{label}: and from the merge-base tree");
        assert!(!state_files(&root).keys().any(|path| path.starts_with("A/")), "{label}");
        for (path, bytes) in &remote {
            assert_eq!(read_local(&root, path).as_deref(), Some(*bytes), "{label}: {path}");
        }
        assert!(exists(&root, ".research/overleaf.json"), "{label}: app state untouched");
    }
}

#[test]
fn a_file_of_the_writers_keeps_its_folder_and_is_named_once() {
    let copy = "A/figs/main (local conflict 20260701-1200).pdf";
    let extra: Files = &[(copy, b"%PDF kept"), ("A/figs/.DS_Store", b"finder")];
    let (_server, config, root) = built_paper(&[("root.tex", ROOT)], extra);
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    let kept = KeptFolder { folder: "A".into(), files: vec![copy.into()] };
    assert_eq!(result.kept_folders, [kept]);
    assert_eq!(read_local(&root, copy).as_deref(), Some(b"%PDF kept".as_slice()));
    assert!(exists(&root, "A/figs/.DS_Store"), "Finder's stays where the folder does");
    for gone in BUILD_OUTPUTS.iter().chain(&["A/msec", "A/figs/sub", "A/figs/qual"]) {
        assert!(!exists(&root, gone), "{gone}");
    }
    assert!(!base_folder(&root, "A"));
    assert!(!state_files(&root).contains_key(copy), "it stays out of the synced map");

    let again = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(again.kept_folders.is_empty(), "named once: {:?}", again.kept_folders);
    assert!(exists(&root, copy));
}

#[test]
fn a_folder_holding_a_file_held_for_a_rename_stays_whole() {
    // Overleaf renamed A/ to B/ while main.tex was edited here, and its
    // history cannot be read: main.tex is held in A/, so A/ is not stale.
    const EDITED: &[u8] = b"\\documentclass{article}\n\\input{msec/intro}\nAn edit.\n";
    let renamed = paper_in("B");
    let paper = paper_in("A");
    let edited: Vec<(&str, &[u8])> = (borrowed(&paper).into_iter())
        .map(|(path, bytes)| (path, if path == "A/main.tex" { EDITED } else { bytes }))
        .chain([("A/main.aux", b"generated".as_slice())])
        .collect();
    let server = Mock {
        versions: vec![42],
        routes: vec![("GET", "/project/proj-1/updates", 500, String::new())],
        ..Mock::project(&borrowed(&renamed))
    }
    .serve();
    let (config, root) = linked(&server, &edited, &borrowed(&paper));
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.held_renames, ["A/main.tex"]);
    assert!(result.kept_folders.is_empty());
    assert_eq!(read_local(&root, "A/main.tex").as_deref(), Some(EDITED));
    assert!(exists(&root, "A/main.aux"), "the held file's folder is left as it is");
    assert!(base_folder(&root, "A"), "with its merge base");
}

/// A TeX recorder for a build run in `folder` that wrote `outputs` there.
fn recorder(root: &Path, folder: &str, outputs: &[&str]) -> String {
    let pwd = disk_path(root, folder);
    let lines: String = outputs.iter().map(|output| format!("OUTPUT {output}\n")).collect();
    format!("PWD {}\nINPUT /usr/local/texlive/article.cls\nINPUT main.tex\n{lines}", pwd.display())
}

#[test]
fn the_next_sync_clears_skeletons_an_earlier_version_left() {
    // What earlier syncs left of folders reorganised on Overleaf, which the
    // merge-base tree still has: one of build outputs only, its source long
    // gone from the agreed table, so its build records say what the build
    // wrote; one of empty folders.
    let files: Files = &[("root.tex", ROOT)];
    let server = Mock { versions: vec![42], ..Mock::project(files) }.serve();
    let (config, root) = linked(&server, files, files);
    fs::create_dir_all(disk_path(&root, "old")).unwrap();
    let fls = recorder(&root, "old", &["main.log", "./main.aux", "main.pdf"]);
    // latexmk's database: BibTeX's outputs only it names.
    let fdb = "# Fdb version 4\n[\"pdflatex\"] 1 \"main.tex\" \"main.pdf\" \"main\" 1 0\n  \"main.tex\" 1 2 abc \"\"\n  (generated)\n  \"main.aux\"\n  \"main.fls\"\n  \"main.log\"\n  \"main.pdf\"\n[\"bibtex main\"] 1 \"main.aux\" \"main.bbl\" \"main\" 1 0\n  \"main.aux\" 1 2 abc \"pdflatex\"\n  (generated)\n  \"main.bbl\"\n  \"main.blg\"\n";
    let leftovers = [
        ("old/main.fls", fls.as_str()),
        ("old/main.fdb_latexmk", fdb),
        ("old/main.aux", "generated"),
        ("old/main.log", "generated"),
        ("old/main.bbl", "generated"),
        ("old/main.blg", "generated"),
        // SyncTeX's, which no record lists: the recorded PDF stands for it.
        ("old/main.synctex.gz", "generated"),
    ];
    for (path, text) in leftovers {
        fs::write(disk_path(&root, path), text).unwrap();
    }
    for folder in ["old/figs", "skeleton/msec", "skeleton/figs/qual"] {
        fs::create_dir_all(disk_path(&root, folder)).unwrap();
        fs::create_dir_all(disk_path(&root, &format!(".research/overleaf-base/{folder}"))).unwrap();
    }

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.kept_folders.is_empty(), "{:?}", result.kept_folders);
    for gone in ["old", "skeleton"] {
        assert!(!exists(&root, gone), "{gone}");
        assert!(!base_folder(&root, gone), "{gone}");
    }
    assert_eq!(read_local(&root, "root.tex").as_deref(), Some(ROOT));
}

#[test]
fn folders_with_no_record_of_syncing_are_the_writers_and_stay_whole() {
    // None of these ever held a synced file, so however much they look like
    // build output, no build of Overleaf's documents wrote them.
    let files: Files = &[("root.tex", ROOT)];
    let mine: Files = &[
        ("results/slurm-4821.out", b"epoch 1 loss 0.3"),
        ("logs/train.log", b"step 100"),
        ("finder/.DS_Store", b"finder"),
        ("mine/notes (local conflict 20260701-1200).txt", b"kept"),
        ("mine/notes.aux", b"generated"),
    ];
    let server = Mock { versions: vec![42], ..Mock::project(files) }.serve();
    let (config, root) = linked(&server, &[files, mine].concat(), files);
    fs::create_dir_all(disk_path(&root, "fresh")).unwrap();
    // An external build's `$aux_dir`, its recorder and all.
    fs::create_dir_all(disk_path(&root, "build")).unwrap();
    let fls = recorder(&root, "build", &["main.aux", "main.log"]);
    for (path, text) in
        [("build/main.fls", fls.as_str()), ("build/main.aux", "x"), ("build/main.log", "x")]
    {
        fs::write(disk_path(&root, path), text).unwrap();
    }

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.kept_folders.is_empty(), "{:?}", result.kept_folders);
    let left = mine.iter().map(|(path, _)| *path);
    for path in left.chain(["fresh", "build/main.fls", "build/main.aux", "build/main.log"]) {
        assert!(exists(&root, path), "{path}");
    }
}

#[test]
fn a_file_merely_named_like_build_output_keeps_a_cleared_folder() {
    // In a folder Overleaf deleted, a log or job output no build of its
    // documents wrote is the writer's: it stays, and so does its folder.
    let (_server, config, root) = built_paper(
        &[("root.tex", ROOT)],
        &[("A/results/slurm-4821.out", b"epoch 1"), ("A/train.log", b"step 100")],
    );
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    let files = vec!["A/results/slurm-4821.out".into(), "A/train.log".into()];
    assert_eq!(result.kept_folders, [KeptFolder { folder: "A".into(), files }]);
    assert_eq!(read_local(&root, "A/train.log").as_deref(), Some(b"step 100".as_slice()));
    assert!(exists(&root, "A/results/slurm-4821.out"));
    for gone in BUILD_OUTPUTS.iter().chain(&["A/msec", "A/figs"]) {
        assert!(!exists(&root, gone), "{gone}");
    }
}

#[test]
fn an_edit_whose_upload_stood_down_keeps_its_folder_unnamed() {
    // Overleaf deleted A/ while main.tex was edited here, and moved on
    // before the edit could go back up: it goes next sync, so A/ is neither
    // cleared nor reported.
    const EDITED: &[u8] = b"\\documentclass{article}\n\\input{msec/intro}\nAn edit.\n";
    let paper = paper_in("A");
    let local: Vec<(&str, &[u8])> = (borrowed(&paper).into_iter())
        .map(|(path, bytes)| (path, if path == "A/main.tex" { EDITED } else { bytes }))
        .chain([("A/main.aux", b"generated".as_slice())])
        .collect();
    let server = Mock { versions: vec![42, 43], ..Mock::project(&[("root.tex", ROOT)]) }.serve();
    let (config, root) = linked(&server, &local, &borrowed(&paper));
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.pushed.is_empty() && server.uploads().is_empty(), "{:?}", result.pushed);
    assert!(result.kept_folders.is_empty(), "{:?}", result.kept_folders);
    assert_eq!(read_local(&root, "A/main.tex").as_deref(), Some(EDITED));
    assert!(exists(&root, "A/main.aux"), "the unsent file's folder is left as it is");
}

#[test]
fn a_new_file_a_read_only_sync_cannot_send_keeps_its_folder_unnamed() {
    // The file goes up once the account can write again: it is no file that
    // never syncs, so the folder is neither cleared nor reported.
    let (_server, config, root) = built_paper(&[("root.tex", ROOT)], &[("A/new.tex", b"new")]);
    edit_state(&root, |state| state.permission = Some("readOnly".to_string()));
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.read_only && result.pushed.is_empty());
    assert!(result.kept_folders.is_empty(), "{:?}", result.kept_folders);
    assert_eq!(read_local(&root, "A/new.tex").as_deref(), Some(b"new".as_slice()));
}
