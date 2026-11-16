//! The default root document's PDF in a subfolder (`cvpr/main.tex` builds
//! `cvpr/main.pdf`) is this copy's build, as `main.pdf` beside a top-level
//! `main.tex` is: it never goes up, a collaborator's never comes down over
//! it, and one an earlier sync agreed on is let go of on both sides. Other
//! root documents' PDFs sync like any other file.

use crate::overleaf::sync::{prefetch, sync, sync_prefetched};
use crate::overleaf::test_support::*;
use crate::overleaf_rt::mock_server::realtime_state;
use crate::project;
use serde_json::json;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

const PAPER: &[u8] = b"\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n";
const NO_LIVE: &BTreeSet<String> = &BTreeSet::new();

/// The manifest `project::open` leaves once each of `roots` has been built,
/// `default` being what Build compiles.
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

/// The manifest `project::open` leaves: `cvpr/main.tex` is what builds.
fn compile_cvpr(root: &Path) {
    set_roots(root, &["cvpr/main.tex"], "cvpr/main.tex");
}

/// A sync of a `cvpr/main.tex` project, whose last sync agreed on `base`.
fn sync_cvpr(
    remote: Files, local: Files, base: Files,
) -> (MockServer, TempDir, crate::overleaf::OverleafSyncResult) {
    let server = Mock::project(remote).serve();
    let (config, root) = linked(&server, local, base);
    compile_cvpr(&root);
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    (server, root, result)
}

fn uploads_name(server: &MockServer, name: &str) -> bool {
    server.uploads().iter().any(|upload| upload.body_text().contains(name))
}

#[test]
fn a_subfolder_roots_pdf_never_goes_up() {
    let source: Files = &[("cvpr/main.tex", PAPER)];
    let local: Files = &[("cvpr/main.tex", PAPER), ("cvpr/main.pdf", b"%PDF mine")];
    let (server, _root, result) = sync_cvpr(source, local, source);
    assert!(result.pushed.is_empty(), "{:?}", result.pushed);
    assert!(!uploads_name(&server, "main.pdf"));
}

#[test]
fn a_collaborators_pdf_never_comes_down_over_this_copys_build() {
    // An earlier Lattice sent this copy's PDF up, and the table still holds it.
    let base: Files = &[("cvpr/main.tex", PAPER), ("cvpr/main.pdf", b"%PDF old")];
    let remote: Files = &[("cvpr/main.tex", PAPER), ("cvpr/main.pdf", b"%PDF theirs")];

    // Unchanged here since: Overleaf's would have been pulled over it.
    let (_server, root, result) = sync_cvpr(remote, base, base);
    assert!(result.pulled.is_empty() && result.conflicts.is_empty(), "{result:?}");
    assert_eq!(read_local(&root, "cvpr/main.pdf").unwrap(), b"%PDF old");

    // Rebuilt here too: Overleaf's would have won the conflict.
    let local: Files = &[("cvpr/main.tex", PAPER), ("cvpr/main.pdf", b"%PDF mine")];
    let (server, root, result) = sync_cvpr(remote, local, base);
    assert!(result.pulled.is_empty() && result.pushed.is_empty(), "{result:?}");
    assert!(result.conflicts.is_empty(), "{:?}", result.conflicts);
    assert_eq!(read_local(&root, "cvpr/main.pdf").unwrap(), b"%PDF mine");
    assert!(!uploads_name(&server, "main.pdf"));
    // Let go of, not deleted: Overleaf's copy stays where it is.
    assert!(result.skipped_remote_deletes.is_empty() && result.deleted_local.is_empty());
    assert!(server.with_method("DELETE").is_empty());
    assert_eq!(state_files(&root).keys().collect::<Vec<_>>(), ["cvpr/main.tex"]);
}

#[test]
fn a_top_level_roots_pdf_still_stays_out_both_ways() {
    let remote: Files = &[("main.tex", PAPER), ("main.pdf", b"%PDF theirs")];
    let local: Files = &[("main.tex", PAPER), ("main.pdf", b"%PDF mine")];
    let (server, root, result) = run_sync(Mock::project(remote), local, &[("main.tex", PAPER)]);
    assert!(result.pulled.is_empty() && result.pushed.is_empty(), "{result:?}");
    assert_eq!(server.uploads().len(), 0);
    assert_eq!(read_local(&root, "main.pdf").unwrap(), b"%PDF mine");
}

/// The same through the live tree and history, which fetch only what a
/// co-author changed instead of downloading the project.
#[test]
fn a_collaborators_pdf_added_on_overleaf_is_not_fetched() {
    let files = vec![("cvpr/main.tex".to_string(), PAPER.to_vec())];
    let shared = SharedProject::new(&files, 40);
    let mock = Mock {
        realtime: Some(realtime_state(json!({}), &[])),
        shared: Some(Arc::clone(&shared)),
        ..Default::default()
    };
    let server = mock.serve();
    let source: Files = &[("cvpr/main.tex", PAPER)];
    let (config, root) = linked(&server, source, source);
    edit_state(&root, |state| {
        state.remote_version = Some(40);
        state.agreed_version = Some(40);
        state.unsettled = Some(Default::default());
    });
    compile_cvpr(&root);
    {
        let mut shared = shared.lock().unwrap();
        shared.files.insert("cvpr/main.pdf".into(), b"%PDF theirs".to_vec());
        shared.update(&[], json!([{ "add": { "pathname": "cvpr/main.pdf" } }]));
    }

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.pulled.is_empty(), "{:?}", result.pulled);
    assert_eq!(read_local(&root, "cvpr/main.pdf"), None);
    let downloads = server.recorded().iter().filter(|r| r.url.ends_with("/download/zip")).count();
    assert_eq!(downloads, 0, "fetched from the live tree, not downloaded");
}

/// `supplementary/supp.tex` was built here once, so it is a root document,
/// but Build compiles `cvpr/main.tex`: the supplement's PDF is an input of
/// the paper that collaborators on Overleaf cannot build, and it syncs.
#[test]
fn a_non_default_roots_pdf_syncs_both_ways() {
    let sources = [("cvpr/main.tex", PAPER), ("supplementary/supp.tex", PAPER)];
    let with_pdf = |pdf: &'static [u8]| {
        let mut files = sources.to_vec();
        files.push(("supplementary/supp.pdf", pdf));
        files
    };
    let base = with_pdf(b"%PDF v1");
    let roots = ["cvpr/main.tex", "supplementary/supp.tex"];

    let server = Mock::project(&base).serve();
    let (config, root) = linked(&server, &with_pdf(b"%PDF v2 mine"), &base);
    set_roots(&root, &roots, "cvpr/main.tex");
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.pushed, ["supplementary/supp.pdf"], "{result:?}");
    assert!(uploads_name(&server, "supp.pdf"));

    let server = Mock::project(&with_pdf(b"%PDF v2 theirs")).serve();
    let (config, root) = linked(&server, &base, &base);
    set_roots(&root, &roots, "cvpr/main.tex");
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.pulled, ["supplementary/supp.pdf"], "{result:?}");
    assert_eq!(read_local(&root, "supplementary/supp.pdf").unwrap(), b"%PDF v2 theirs");
}

/// Making `arxiv/main.tex` what Build compiles hands `cvpr/main.pdf` back
/// to sync, and takes `arxiv/main.pdf` out of it.
#[test]
fn switching_the_default_root_moves_which_pdf_stays_out() {
    let sources: Files = &[("cvpr/main.tex", PAPER), ("arxiv/main.tex", PAPER)];
    let local: Files = &[
        ("cvpr/main.tex", PAPER),
        ("arxiv/main.tex", PAPER),
        ("cvpr/main.pdf", b"%PDF cvpr"),
        ("arxiv/main.pdf", b"%PDF arxiv"),
    ];
    let roots = ["cvpr/main.tex", "arxiv/main.tex"];
    let server = Mock::project(sources).serve();
    let (config, root) = linked(&server, local, sources);

    set_roots(&root, &roots, "cvpr/main.tex");
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.pushed, ["arxiv/main.pdf"], "{result:?}");

    set_roots(&root, &roots, "arxiv/main.tex");
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.pushed, ["cvpr/main.pdf"], "{result:?}");
    let tracked = state_files(&root);
    assert!(tracked.contains_key("cvpr/main.pdf") && !tracked.contains_key("arxiv/main.pdf"));
}

/// A download read ahead of the lease while `cvpr/main.tex` was the default
/// holds a collaborator's `arxiv/main.pdf`. Building `arxiv/main.tex`
/// meanwhile makes it the default, and the sync turns that download down
/// instead of pulling their PDF over the one just built.
#[test]
fn a_download_read_ahead_before_the_default_root_changed_is_turned_down() {
    let sources = [("cvpr/main.tex", PAPER), ("arxiv/main.tex", PAPER)];
    let mut remote = sources.to_vec();
    remote.push(("arxiv/main.pdf", b"%PDF theirs"));
    let server = Mock::project(&remote).serve();
    let (config, root) = linked(&server, &sources, &sources);
    let roots = ["cvpr/main.tex", "arxiv/main.tex"];
    set_roots(&root, &roots, "cvpr/main.tex");
    let read_ahead = || prefetch(&config, &root, NO_LIVE, None, &|| {}, &|_, _| {}).unwrap();
    let prefetched = read_ahead();
    assert!(prefetched.is_some());

    set_roots(&root, &roots, "arxiv/main.tex");
    std::fs::write(root.join("arxiv/main.pdf"), b"%PDF mine").unwrap();
    let turned_down = sync_prefetched(&config, &root, NO_LIVE, None, prefetched, None);
    assert!(turned_down.unwrap().is_none());
    assert_eq!(read_local(&root, "arxiv/main.pdf").unwrap(), b"%PDF mine");

    let result = sync_prefetched(&config, &root, NO_LIVE, None, read_ahead(), None).unwrap();
    let result = result.expect("read again with arxiv/main.tex the default, it fits");
    assert!(result.pulled.is_empty() && result.pushed.is_empty(), "{result:?}");
    assert_eq!(read_local(&root, "arxiv/main.pdf").unwrap(), b"%PDF mine");
}

fn conflict_copies_in(root: &Path, folder: &str) -> Vec<String> {
    (std::fs::read_dir(root.join(folder)).unwrap())
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| crate::overleaf::files::is_conflict_copy(name))
        .collect()
}

/// The writer builds `cvpr/main.tex` while the Agent builds `arxiv/main.tex`
/// (or the other way round), so what Build compiles keeps moving between
/// them. Each move hands the other PDF back to sync with no agreed copy,
/// while Overleaf still holds the one an earlier sync sent up. A build here
/// in between made the two differ, and the sync used to report
/// `cvpr/main.pdf` as changed on both sides and set this copy's build aside
/// as `cvpr/main (local conflict …).pdf`. It is a build, not an edit:
/// Overleaf's copy stays, quietly, and nothing is set aside.
#[test]
fn a_pdf_built_here_never_conflicts_when_it_rejoins_sync() {
    let sources = [("cvpr/main.tex", PAPER), ("arxiv/main.tex", PAPER)];
    let roots = ["cvpr/main.tex", "arxiv/main.tex"];
    let root = linked_root(&sources, &sources);
    let build = |document: &str, pdf: &[u8]| {
        std::fs::write(root.join(document).with_extension("pdf"), pdf).unwrap();
        crate::latex::record_build(&root, document);
        set_roots(&root, &roots, document);
    };
    // Overleaf as each sync finds it: the sources plus what went up so far.
    let sync_against = |pdfs: &[(&'static str, &'static [u8])]| {
        let mut remote = sources.to_vec();
        remote.extend_from_slice(pdfs);
        let server = Mock::project(&remote).serve();
        edit_state(&root, |state| state.host = server.base.clone());
        let config = signed_in(&server.base);
        (sync(&config, &root, NO_LIVE, None).unwrap(), server)
    };

    // The Agent builds arxiv: cvpr's earlier build goes up as an ordinary PDF.
    build("cvpr/main.tex", b"%PDF cvpr 1");
    build("arxiv/main.tex", b"%PDF arxiv 1");
    let (result, _server) = sync_against(&[]);
    assert_eq!(result.pushed, ["cvpr/main.pdf"], "{result:?}");

    // The writer builds cvpr, which leaves sync; arxiv's goes up in turn.
    build("cvpr/main.tex", b"%PDF cvpr 2");
    let (result, _server) = sync_against(&[("cvpr/main.pdf", b"%PDF cvpr 1")]);
    assert_eq!(result.pushed, ["arxiv/main.pdf"], "{result:?}");

    // The Agent builds arxiv again, and cvpr/main.pdf rejoins sync with
    // Overleaf's copy and this copy's build both differing from no base.
    build("arxiv/main.tex", b"%PDF arxiv 2");
    let on_overleaf =
        [("cvpr/main.pdf", b"%PDF cvpr 1" as &[u8]), ("arxiv/main.pdf", b"%PDF arxiv 1")];
    let (result, server) = sync_against(&on_overleaf);
    assert!(result.conflicts.is_empty(), "{:?}", result.conflicts);
    assert!(conflict_copies_in(&root, "cvpr").is_empty());
    assert_eq!(result.pulled, ["cvpr/main.pdf"], "{result:?}");
    assert_eq!(read_local(&root, "cvpr/main.pdf").unwrap(), b"%PDF cvpr 1");
    assert!(server.uploads().is_empty(), "{result:?}");
}

/// A collaborator's newer build of a PDF that syncs (`supplementary/supp.pdf`)
/// lands on Overleaf while this copy rebuilt it too: theirs wins, quietly.
#[test]
fn overleafs_copy_of_a_pdf_built_here_wins_without_a_conflict() {
    let sources = [("cvpr/main.tex", PAPER), ("supplementary/supp.tex", PAPER)];
    let with_pdf = |pdf: &'static [u8]| {
        let mut files = sources.to_vec();
        files.push(("supplementary/supp.pdf", pdf));
        files
    };
    let server = Mock::project(&with_pdf(b"%PDF v2 theirs")).serve();
    let (config, root) = linked(&server, &with_pdf(b"%PDF v2 mine"), &with_pdf(b"%PDF v1"));
    set_roots(&root, &["cvpr/main.tex", "supplementary/supp.tex"], "cvpr/main.tex");
    crate::latex::record_build(&root, "supplementary/supp.tex");

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert!(result.conflicts.is_empty(), "{:?}", result.conflicts);
    assert_eq!(result.pulled, ["supplementary/supp.pdf"], "{result:?}");
    assert_eq!(read_local(&root, "supplementary/supp.pdf").unwrap(), b"%PDF v2 theirs");
    assert!(conflict_copies_in(&root, "supplementary").is_empty());
    assert!(server.uploads().is_empty());
}

/// A PDF the writer put in place of this copy's build (a figure exported
/// over it, an edited copy) is theirs, and a both-sides change to it is the
/// real conflict it always was.
#[test]
fn a_pdf_written_over_this_copys_build_still_conflicts() {
    let sources = [("cvpr/main.tex", PAPER), ("figures/plot.tex", PAPER)];
    let with_pdf = |pdf: &'static [u8]| {
        let mut files = sources.to_vec();
        files.push(("figures/plot.pdf", pdf));
        files
    };
    let server = Mock::project(&with_pdf(b"%PDF v2 theirs")).serve();
    let (config, root) = linked(&server, &with_pdf(b"%PDF built"), &with_pdf(b"%PDF v1"));
    set_roots(&root, &["cvpr/main.tex"], "cvpr/main.tex");
    crate::latex::record_build(&root, "figures/plot.tex");
    std::fs::write(root.join("figures/plot.pdf"), b"%PDF exported by hand").unwrap();

    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(result.conflicts.len(), 1, "{result:?}");
    assert_eq!(conflict_copies_in(&root, "figures").len(), 1);
}
