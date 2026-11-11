//! Folders deleted or renamed on Overleaf (issue #840): the build outputs
//! and empty folders Lattice left in them go too, here and in the merge-base
//! tree, while anything of the writer's stays and is named.

use super::*;
use crate::overleaf::sync::stale_folders::KeptFolder;

const MAIN: &[u8] = b"\\documentclass{article}\n\\input{msec/intro}\n";
const INTRO: &[u8] = b"\\section{Intro}\n";
const PLOT: &[u8] = b"\x89PNG plot";
const ROOT: &[u8] = b"\\documentclass{article}\n";

/// The paper in `A/` on Overleaf, beside a root document.
fn paper_in(folder: &str) -> Vec<(String, &'static [u8])> {
    let files = [("main.tex", MAIN), ("msec/intro.tex", INTRO), ("figs/sub/plot.png", PLOT)];
    let mut paper: Vec<(String, &[u8])> =
        files.iter().map(|(path, bytes)| (format!("{folder}/{path}"), *bytes)).collect();
    paper.push(("root.tex".to_string(), ROOT));
    paper
}

fn borrowed<'a>(files: &'a [(String, &'static [u8])]) -> Vec<(&'a str, &'static [u8])> {
    files.iter().map(|(path, bytes)| (path.as_str(), *bytes)).collect()
}

/// What a build of `A/main.tex` and a standalone figure leaves beside them.
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
    for (label, remote) in [("renamed to B", borrowed(&renamed)), ("deleted", deleted.to_vec())] {
        let (_server, config, root) = built_paper(&remote, &[]);
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
    let (_server, config, root) = built_paper(&[("root.tex", ROOT)], &[(copy, b"%PDF kept")]);
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    let kept = KeptFolder { folder: "A".into(), files: vec![copy.into()] };
    assert_eq!(result.kept_folders, [kept]);
    assert_eq!(read_local(&root, copy).as_deref(), Some(b"%PDF kept".as_slice()));
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

#[test]
fn the_next_sync_clears_skeletons_an_earlier_version_left() {
    // What earlier syncs left of folders reorganised on Overleaf: one of
    // build outputs only, one of empty folders the merge-base tree still
    // has. Folders with no record of syncing are the writer's unless they
    // hold build outputs alone.
    let files: Files = &[("root.tex", ROOT)];
    let leftovers: Files = &[
        ("old/main.aux", b"generated"),
        ("old/main.log", b"generated"),
        ("old/figs/plot.synctex.gz", b"generated"),
        ("mine/notes (local conflict 20260701-1200).txt", b"kept"),
        ("mine/notes.aux", b"generated"),
    ];
    let server = Mock { versions: vec![42], ..Mock::project(files) }.serve();
    let (config, root) = linked(&server, &[files, leftovers].concat(), files);
    for folder in ["skeleton/msec", "skeleton/figs/qual", "fresh"] {
        fs::create_dir_all(disk_path(&root, folder)).unwrap();
    }
    fs::create_dir_all(disk_path(&root, ".research/overleaf-base/skeleton/msec")).unwrap();
    fs::create_dir_all(disk_path(&root, ".research/overleaf-base/skeleton/figs/qual")).unwrap();

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.kept_folders.is_empty(), "{:?}", result.kept_folders);
    for gone in ["old", "skeleton"] {
        assert!(!exists(&root, gone), "{gone}");
        assert!(!base_folder(&root, gone), "{gone}");
    }
    assert!(exists(&root, "fresh"), "an empty folder made here stays");
    assert!(exists(&root, "mine/notes.aux"), "a folder of the writer's is left alone");
    assert_eq!(read_local(&root, "root.tex").as_deref(), Some(ROOT));
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
