//! Files still carrying conflict markers: never uploaded, and never merged
//! again while Overleaf keeps moving — an agent rewrote a paragraph here while
//! a co-author typed into the same one on Overleaf, and kept typing before
//! anyone resolved it.

use super::*;

const BASE: &[u8] = b"Intro.\n\nOld sentence one. Old sentence two.\n\nEnd.\n";
const AGENT: &[u8] = b"Intro.\n\nThe agent rewrote this whole paragraph.\n\nEnd.\n";
const TYPED: &[u8] =
    b"Intro.\n\nOld sentence one. Old sentence two. Coauthor typed this.\n\nEnd.\n";
const KEPT_TYPING: &[u8] =
    b"Intro.\n\nOld sentence one. Old sentence two. Coauthor typed this. And kept typing.\n\nEnd.\n";

/// Sync `root` again against a fresh Overleaf serving `remote`.
fn sync_against(root: &Path, remote: Files) -> (MockServer, OverleafSyncResult) {
    let server = Mock::project(remote).serve();
    edit_state(root, |state| state.host = server.base.clone());
    let config = signed_in(&server.base);
    let result = sync(&config, root, NO_LIVE, None).unwrap();
    (server, result)
}

fn conflict_copies(root: &Path) -> Vec<String> {
    let mut copies: Vec<String> = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| is_conflict_copy(name))
        .collect();
    copies.sort();
    copies
}

#[test]
fn a_file_still_marked_up_is_not_merged_again_while_overleaf_moves_on() {
    let (_first_server, root, first) = run_sync(
        Mock::project(&[("main.tex", TYPED)]),
        &[("main.tex", AGENT)],
        &[("main.tex", BASE)],
    );
    let [conflict] = &first.conflicts[..] else { panic!("{:?}", first.conflicts) };
    assert!(conflict.markers);
    let marked = text(&root, "main.tex");
    assert_eq!(marked.matches("<<<<<<<").count(), 1, "{marked}");
    assert_eq!(read_local(&root, &conflict.local_copy).unwrap(), AGENT);

    // The co-author keeps typing in the same paragraph; nobody has resolved
    // the conflict yet. The next sync (live mode polls every 45 s, often
    // within the same minute) used to merge the marked-up file again: a
    // second set of markers around the first, and the same-minute name
    // writing the marked-up text over the clean copy of the agent's version.
    let (server, second) = sync_against(&root, &[("main.tex", KEPT_TYPING)]);
    assert_eq!(second.unresolved_conflicts, ["main.tex"]);
    assert!(second.conflicts.is_empty() && second.merged.is_empty() && second.pulled.is_empty());
    assert!(second.pushed.is_empty());
    assert!(server.uploads().is_empty());
    assert_eq!(text(&root, "main.tex"), marked);
    assert_eq!(read_local(&root, &conflict.local_copy).unwrap(), AGENT);
    assert_eq!(conflict_copies(&root), std::slice::from_ref(&conflict.local_copy));
    // Still against the copy of Overleaf's the markers show.
    assert_eq!(state_files(&root)["main.tex"], sha256_hex(TYPED));
    assert_eq!(read_base_copy(&root, "main.tex").unwrap().as_bytes(), TYPED);
    // Named once, when the hold starts, and listed by the dry run as waiting
    // on the writer rather than left out as though nothing were pending.
    assert_eq!(second.newly_unresolved_conflicts, ["main.tex"]);
    let dry_run = preview(&signed_in(&server.base), &root, NO_LIVE).unwrap();
    let rows: Vec<_> =
        (dry_run.changes.iter()).map(|c| (c.kind.as_str(), c.path.as_str())).collect();
    assert_eq!(rows, [("unresolvedConflict", "main.tex")]);
    // Every later sync while it stays marked up holds it without news.
    let (_server, held_again) = sync_against(&root, &[("main.tex", KEPT_TYPING)]);
    assert_eq!(held_again.unresolved_conflicts, ["main.tex"]);
    assert!(held_again.newly_unresolved_conflicts.is_empty());
    assert_eq!(text(&root, "main.tex"), marked);

    // Resolved (here, keeping the agent's paragraph): the next sync merges it
    // with what the co-author typed since, as one fresh conflict whose clean
    // copy never takes the name of the earlier one.
    fs::write(root.join("main.tex"), AGENT).unwrap();
    let (server, third) = sync_against(&root, &[("main.tex", KEPT_TYPING)]);
    assert!(third.unresolved_conflicts.is_empty());
    let [again] = &third.conflicts[..] else { panic!("{:?}", third.conflicts) };
    assert_ne!(again.local_copy, conflict.local_copy);
    let remarked = text(&root, "main.tex");
    assert_eq!(remarked.matches("<<<<<<<").count(), 1, "{remarked}");
    assert!(remarked.contains("And kept typing."), "{remarked}");
    assert_eq!(read_local(&root, &again.local_copy).unwrap(), AGENT);
    assert_eq!(read_local(&root, &conflict.local_copy).unwrap(), AGENT);
    assert!(server.uploads().is_empty());
}

#[test]
fn a_conflict_copy_never_takes_the_name_of_an_existing_file() {
    let taken =
        ["main (local conflict 20261108-0217).tex", "main (local conflict 20261108-0217 2).tex"];
    let name = |path| conflict_copy_name(path, "20261108-0217", |name| taken.contains(&name));
    assert_eq!(name("main.tex"), "main (local conflict 20261108-0217 3).tex");
    assert_eq!(name("other.tex"), "other (local conflict 20261108-0217).tex");
    assert_eq!(
        conflict_copy_name("sec/intro.tex", "20261108-0217", |name| name
            == "sec/intro (local conflict 20261108-0217).tex"),
        "sec/intro (local conflict 20261108-0217 2).tex"
    );
    assert!(is_conflict_copy("main (local conflict 20261108-0217 3).tex"));
}

#[test]
fn overleaf_sync_never_uploads_excluded_files_or_unresolved_conflict_markers() {
    // A file still carrying markers must not be published to collaborators.
    let marked = format!("{CONFLICT_MARKER} ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n");
    let base: Files = &[("main.tex", b"body"), ("notes.tex", b"alpha\n")];
    let (server, root, result) = run_sync(
        Mock::project(base),
        &[
            ("main.tex", b"body"),
            ("notes.tex", marked.as_bytes()),
            ("main.log", b"latexmk noise"),
            (".DS_Store", b"finder noise"),
            ("main.pdf", b"%PDF compiled output"),
            ("main.synctex.gz", b"synctex"),
            ("tmp/pdfs/full-appendix/render-1.png", b"temporary preview"),
        ],
        base,
    );
    assert!(result.pushed.is_empty() && result.pulled.is_empty());
    assert!(server.uploads().is_empty());
    // Excluded files never enter state, and the marked file is left out so
    // it uploads as soon as the markers are gone.
    assert_eq!(state_files(&root).keys().collect::<Vec<_>>(), vec!["main.tex"]);
    // Both stay untouched on disk.
    assert_eq!(read_local(&root, "notes.tex").unwrap(), marked.as_bytes());
    for rel in ["main.log", "main.pdf", "tmp/pdfs/full-appendix/render-1.png"] {
        assert!(read_local(&root, rel).is_some(), "{rel}");
    }
}
