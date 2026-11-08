//! Fetching only what Overleaf changed (audit F4): every kind of change a
//! co-author can make arrives without the project download, nothing Overleaf
//! left alone is fetched again, and the download still stands in wherever the
//! history or a fetch cannot vouch for the result.

use super::*;
use crate::overleaf::sync::changes::blob_hash;
use crate::overleaf_rt::mock_server::{realtime_state, sent_updates, MockState};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// A small paper: documents in folders, a bibliography and two figures.
fn paper() -> Vec<(String, Vec<u8>)> {
    let text = |path: &str, body: &str| (path.to_string(), body.as_bytes().to_vec());
    vec![
        text("main.tex", "\\documentclass{article}\n\nIntro.\n\nMiddle.\n\nEnd.\n"),
        text("sections/a.tex", "\\section{A}\nAlpha.\n"),
        text("sections/b.tex", "\\section{B}\nBeta.\n"),
        text("refs.bib", "@article{k, title={T}}\n"),
        ("figures/f1.png".into(), vec![0x89, b'P', b'N', b'G', 1, 2, 3]),
        ("figures/f2.pdf".into(), b"%PDF-1.5 figure two".to_vec()),
    ]
}

/// A project linked to a mock Overleaf holding `files`, whose last sync
/// agreed on exactly that at version 40.
struct Lab {
    shared: Arc<Mutex<SharedProject>>,
    live: Arc<Mutex<MockState>>,
    server: MockServer,
    config: TempDir,
    root: TempDir,
}

fn lab_with(files: &[(String, Vec<u8>)], configure: impl FnOnce(&mut Mock)) -> Lab {
    let shared = SharedProject::new(files, 40);
    // The tree and documents come from `shared` at every connection.
    let live = realtime_state(json!({}), &[]);
    let mut mock = Mock {
        realtime: Some(Arc::clone(&live)),
        shared: Some(Arc::clone(&shared)),
        ..Default::default()
    };
    configure(&mut mock);
    let server = mock.serve();
    let as_files: Vec<(&str, &[u8])> =
        files.iter().map(|(path, bytes)| (path.as_str(), bytes.as_slice())).collect();
    let (config, root) = linked(&server, &as_files, &as_files);
    edit_state(&root, |state| {
        state.remote_version = Some(40);
        state.agreed_version = Some(40);
        state.unsettled = Some(BTreeSet::new());
    });
    Lab { shared, live, server, config, root }
}

fn lab() -> Lab {
    lab_with(&paper(), |_| {})
}

impl Lab {
    fn sync(&self) -> OverleafSyncResult {
        sync(&self.config, &self.root, NO_LIVE, None).unwrap()
    }

    /// A co-author changes the project, recording one update.
    fn co_author(
        &self, change: impl FnOnce(&mut BTreeMap<String, Vec<u8>>), pathnames: &[&str], ops: Value,
    ) {
        let mut shared = self.shared.lock().unwrap();
        change(&mut shared.files);
        shared.update(pathnames, ops);
    }

    fn downloads(&self) -> usize {
        downloads(&self.server)
    }

    /// The files fetched by id, by path.
    fn files_fetched(&self) -> Vec<String> {
        let shared = self.shared.lock().unwrap();
        let fetched = self.server.recorded().into_iter().filter_map(|request| {
            let id = request.url.strip_prefix("/project/proj-1/file/")?.to_string();
            shared.files.keys().find(|path| entity_id(path) == id).cloned()
        });
        fetched.collect()
    }

    /// The documents joined over the live channel, by id.
    fn docs_joined(&self) -> Vec<String> {
        let frames = self.live.lock().unwrap().frames.clone();
        (frames.iter())
            .filter(|frame| frame.contains("\"joinDoc\""))
            .filter_map(|frame| {
                Some(frame.split("\"args\":[\"").nth(1)?.split('"').next()?.to_string())
            })
            .collect()
    }

    /// The project on disk is exactly Overleaf's, and the table agrees.
    fn assert_matches_overleaf(&self) {
        let shared = self.shared.lock().unwrap();
        let local = read_local_files(&self.root).unwrap().files;
        assert_eq!(local, shared.files);
        let hashes: BTreeMap<String, String> =
            (shared.files.iter()).map(|(path, bytes)| (path.clone(), sha256_hex(bytes))).collect();
        assert_eq!(state_files(&self.root), hashes);
    }
}

#[test]
fn the_hash_overleaf_keeps_a_file_under_is_gits_blob_hash() {
    // `git hash-object` of an empty file, and of "hello\n".
    assert_eq!(blob_hash(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    assert_eq!(blob_hash(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
}

/// The audit's case: a co-author types in one document while Lattice is not
/// in it live, and the next sync used to download all 30 MB to pull it.
#[test]
fn a_co_authors_edit_fetches_that_document_and_nothing_else() {
    let lab = lab();
    let edited = "\\section{A}\nAlpha, edited on Overleaf.\n";
    lab.co_author(
        |files| {
            files.insert("sections/a.tex".into(), edited.into());
        },
        &["sections/a.tex"],
        json!([]),
    );

    let result = lab.sync();
    assert_eq!(result.pulled, ["sections/a.tex"]);
    assert!(result.pushed.is_empty() && result.deleted_local.is_empty());
    assert_eq!(lab.downloads(), 0, "no project download");
    assert!(lab.files_fetched().is_empty(), "the figures stand as agreed");
    assert_eq!(lab.docs_joined(), [entity_id("sections/a.tex")]);
    lab.assert_matches_overleaf();
    let state = load_state(&lab.root).unwrap();
    assert_eq!((state.remote_version, state.agreed_version), (Some(41), Some(41)));
    assert_eq!(state.unsettled, Some(BTreeSet::new()), "the next sync may fetch only too");

    // Nothing new: the version read is the whole sync.
    let result = lab.sync();
    assert!(result.pulled.is_empty() && result.pushed.is_empty());
    assert_eq!((lab.downloads(), lab.docs_joined().len()), (0, 1));
}

#[test]
fn added_deleted_renamed_and_replaced_files_and_documents_all_arrive() {
    let lab = lab();
    let figure = b"\x89PNG a brand new figure".to_vec();
    let replaced = b"%PDF-1.5 figure two, redrawn".to_vec();
    lab.co_author(
        |files| {
            files.insert("figures/f3.png".into(), figure.clone());
            files.remove("sections/b.tex");
            let f1 = files.remove("figures/f1.png").unwrap();
            files.insert("figures/fig1.png".into(), f1);
            let a = files.remove("sections/a.tex").unwrap();
            files.insert("sections/intro.tex".into(), a);
            files.insert("figures/f2.pdf".into(), replaced.clone());
        },
        &[],
        json!([
            { "add": { "pathname": "figures/f3.png" } },
            { "remove": { "pathname": "sections/b.tex" } },
            { "rename": { "pathname": "figures/f1.png", "newPathname": "figures/fig1.png" } },
            { "rename": { "pathname": "sections/a.tex", "newPathname": "sections/intro.tex" } },
            { "add": { "pathname": "figures/f2.pdf" } },
        ]),
    );
    lab.co_author(
        |files| {
            files.insert(
                "refs.bib".into(),
                b"@article{k, title={T}}\n@book{b, title={B}}\n".to_vec(),
            );
        },
        &["refs.bib"],
        json!([]),
    );

    let result = lab.sync();
    assert_eq!(lab.downloads(), 0);
    assert_eq!(
        result.pulled,
        ["figures/f2.pdf", "figures/f3.png", "figures/fig1.png", "refs.bib", "sections/intro.tex"]
    );
    assert_eq!(result.deleted_local, ["figures/f1.png", "sections/a.tex", "sections/b.tex"]);
    assert!(result.pushed.is_empty() && result.conflicts.is_empty());
    lab.assert_matches_overleaf();
    // Only what changed came over; main.tex never did.
    let mut fetched = lab.files_fetched();
    fetched.sort();
    assert_eq!(fetched, ["figures/f2.pdf", "figures/f3.png", "figures/fig1.png"]);
    let mut joined = lab.docs_joined();
    joined.sort();
    let mut expected = vec![entity_id("refs.bib"), entity_id("sections/intro.tex")];
    expected.sort();
    assert_eq!(joined, expected);
}

/// The merge rules do not care where Overleaf's copy came from: an agent's
/// edit and a co-author's to other paragraphs combine, and go up as
/// operations; overlapping ones still make a conflict, with nothing sent.
#[test]
fn local_edits_still_merge_three_ways_with_a_fetched_change() {
    let lab = lab();
    let theirs = "\\documentclass{article}\n\nIntro.\n\nMiddle.\n\nEnd, by the co-author.\n";
    lab.co_author(
        |files| {
            files.insert("main.tex".into(), theirs.into());
        },
        &["main.tex"],
        json!([]),
    );
    let agents = "\\documentclass{article}\n\nIntro, by the agent.\n\nMiddle.\n\nEnd.\n";
    fs::write(disk_path(&lab.root, "main.tex"), agents).unwrap();

    let result = lab.sync();
    assert_eq!(lab.downloads(), 0);
    assert_eq!(
        (result.merged.as_slice(), result.pushed.as_slice()),
        (&["main.tex".to_string()][..], &["main.tex".to_string()][..])
    );
    let merged =
        "\\documentclass{article}\n\nIntro, by the agent.\n\nMiddle.\n\nEnd, by the co-author.\n";
    assert_eq!(text(&lab.root, "main.tex"), merged);
    assert!(lab.server.uploads().is_empty(), "a document goes up as operations");
    assert_eq!(sent_updates(&lab.live).len(), 1);

    // Both sides on the same line: markers here, nothing sent.
    let lab = lab_with(&paper(), |_| {});
    let theirs = "\\documentclass{article}\n\nIntro, theirs.\n\nMiddle.\n\nEnd.\n";
    lab.co_author(
        |files| {
            files.insert("main.tex".into(), theirs.into());
        },
        &["main.tex"],
        json!([]),
    );
    fs::write(disk_path(&lab.root, "main.tex"), agents).unwrap();
    let result = lab.sync();
    assert_eq!(lab.downloads(), 0);
    assert_eq!(result.conflicts.len(), 1);
    assert!(result.pushed.is_empty() && sent_updates(&lab.live).is_empty());
}

/// An upload leaves the version unknown, which used to make the very next
/// sync download the whole project to check it. The history names what went
/// up, so that is all it fetches.
#[test]
fn the_sync_after_an_upload_fetches_only_what_went_up() {
    let lab = lab();
    let figure = b"\x89PNG drawn by the agent".to_vec();
    fs::write(disk_path(&lab.root, "figures/new.png"), &figure).unwrap();
    let result = lab.sync();
    assert_eq!(result.pushed, ["figures/new.png"]);
    let state = load_state(&lab.root).unwrap();
    assert_eq!(state.remote_version, None);
    assert_eq!(state.unsettled, Some(BTreeSet::from(["figures/new.png".to_string()])));
    // What Overleaf did with the upload.
    lab.co_author(
        |files| {
            files.insert("figures/new.png".into(), figure.clone());
        },
        &[],
        json!([{ "add": { "pathname": "figures/new.png" } }]),
    );

    let result = lab.sync();
    assert!(result.pulled.is_empty() && result.pushed.is_empty());
    assert_eq!(lab.downloads(), 0);
    assert_eq!(lab.files_fetched(), ["figures/new.png"]);
    lab.assert_matches_overleaf();
}

/// The download stays for whatever the history or the fetch cannot vouch
/// for, and brings the same result.
#[test]
fn the_project_download_stands_in_wherever_a_fetch_cannot_be_trusted() {
    let edited = "\\section{A}\nAlpha, edited.\n";
    let edit_a = move |files: &mut BTreeMap<String, Vec<u8>>| {
        files.insert("sections/a.tex".into(), edited.into());
    };
    let tampered = format!("/project/proj-1/file/{}", entity_id("figures/f1.png"));
    let tampered: &'static str = Box::leak(tampered.into_boxed_str());
    type Setup = Box<dyn Fn(&Lab)>;
    let cases: Vec<(&str, Setup)> = vec![
        (
            "the live channel cannot be reached",
            Box::new(move |lab| lab.co_author(edit_a, &["sections/a.tex"], json!([]))),
        ),
        (
            "the history does not reach the version",
            Box::new(move |lab| {
                lab.co_author(edit_a, &["sections/a.tex"], json!([]));
                lab.shared.lock().unwrap().version += 1;
            }),
        ),
        (
            "the last sync's table was not exact",
            Box::new(move |lab| {
                lab.co_author(edit_a, &["sections/a.tex"], json!([]));
                edit_state(&lab.root, |state| state.unsettled = None);
            }),
        ),
        (
            "a file left the tree with no update saying so",
            Box::new(move |lab| {
                lab.co_author(
                    |files| {
                        edit_a(files);
                        files.remove("figures/f2.pdf");
                    },
                    &["sections/a.tex"],
                    json!([]),
                );
            }),
        ),
        (
            "a fetched file does not match its hash",
            Box::new(move |lab| {
                lab.co_author(
                    |files| {
                        edit_a(files);
                        files.insert("figures/f1.png".into(), b"\x89PNG redrawn".to_vec());
                    },
                    &["sections/a.tex"],
                    json!([{ "add": { "pathname": "figures/f1.png" } }]),
                );
            }),
        ),
    ];
    for (case, setup) in cases {
        let unreachable = case.starts_with("the live channel");
        let tamper = case.contains("hash");
        let lab = lab_with(&paper(), |mock| {
            if unreachable {
                mock.realtime = None;
            }
            if tamper {
                mock.routes.push(("GET", tampered, 200, "not the figure".into()));
            }
        });
        setup(&lab);
        let result = lab.sync();
        assert_eq!(lab.downloads(), 1, "{case}");
        assert!(
            result.pulled.contains(&"sections/a.tex".to_string()),
            "{case}: {:?}",
            result.pulled
        );
        assert_eq!(text(&lab.root, "sections/a.tex"), edited, "{case}");
        lab.assert_matches_overleaf();
    }
}

/// The agreed copy of a figure is checked against Overleaf's hash for it,
/// so one replaced under the same name arrives even where the history
/// missed it.
#[test]
fn a_figure_replaced_without_the_history_naming_it_is_caught_by_its_hash() {
    let lab = lab();
    lab.co_author(
        |files| {
            files.insert("sections/a.tex".into(), b"\\section{A}\nAlpha, edited.\n".to_vec());
            files.insert("figures/f2.pdf".into(), b"%PDF-1.5 quietly replaced".to_vec());
        },
        &["sections/a.tex"],
        json!([]),
    );
    let result = lab.sync();
    assert_eq!(lab.downloads(), 0);
    assert_eq!(result.pulled, ["figures/f2.pdf", "sections/a.tex"]);
    assert_eq!(lab.files_fetched(), ["figures/f2.pdf"]);
    lab.assert_matches_overleaf();
}

/// A folder operation names only the folder, so a document still at its
/// agreed path may hold another document's text now: deleting `sections/`
/// and renaming `sections_new/` into its place left `sections/a.tex` with the
/// old text here while Overleaf held the new.
#[test]
fn a_folder_replaced_by_another_brings_the_new_folders_documents() {
    let mut files = paper();
    files.push(("sections_new/a.tex".into(), b"\\section{A}\nAlpha, rewritten.\n".to_vec()));
    let lab = lab_with(&files, |_| {});
    lab.co_author(
        |files| {
            files.remove("sections/a.tex");
            files.remove("sections/b.tex");
            let rewritten = files.remove("sections_new/a.tex").unwrap();
            files.insert("sections/a.tex".into(), rewritten);
        },
        &[],
        json!([
            { "remove": { "pathname": "sections" } },
            { "rename": { "pathname": "sections_new", "newPathname": "sections" } },
        ]),
    );

    let result = lab.sync();
    assert_eq!(result.pulled, ["sections/a.tex"]);
    assert_eq!(result.deleted_local, ["sections/b.tex", "sections_new/a.tex"]);
    assert!(result.pushed.is_empty() && result.conflicts.is_empty());
    lab.assert_matches_overleaf();
}

/// Each fetch is a round trip of its own, where the download is one round
/// trip and the project's bytes, so a change touching more files than the
/// project's size pays for takes the one download instead: one fetch per
/// 320 KiB of the agreed copy, never fewer than 8 nor more than 40.
#[test]
fn a_change_too_wide_for_the_projects_size_takes_the_download() {
    let mib = 1024 * 1024;
    // (case, bytes of figure added to the paper, chapters edited, downloaded)
    let cases = [
        ("a small project, more than 8 changed", 0, 10, true),
        ("a 4 MiB project pays for 12", 4 * mib, 10, false),
        ("never more than 40", 16 * mib, 45, true),
    ];
    for (case, figure, edited, downloaded) in cases {
        let chapters: Vec<String> = (0..edited).map(|n| format!("chapters/c{n:02}.tex")).collect();
        let mut files = paper();
        files.push(("figures/big.png".into(), vec![7; figure]));
        files.extend(chapters.iter().map(|path| (path.clone(), format!("{path}\n").into_bytes())));
        let lab = lab_with(&files, |_| {});
        let named: Vec<&str> = chapters.iter().map(String::as_str).collect();
        lab.co_author(
            |files| {
                for path in &chapters {
                    files.insert(path.clone(), b"Rewritten on Overleaf.\n".to_vec());
                }
            },
            &named,
            json!([]),
        );

        let result = lab.sync();
        assert_eq!(lab.downloads(), usize::from(downloaded), "{case}");
        let joined = if downloaded { 0 } else { edited };
        assert_eq!(lab.docs_joined().len(), joined, "{case}");
        assert_eq!(result.pulled, chapters, "{case}");
        lab.assert_matches_overleaf();
    }
}

/// Only the project download passes the gate that holds downloads to the
/// gap between them; fetching what changed is the editor's own traffic, so a
/// fetch-only sync right after a download is not held back, ahead of the
/// lease or under it.
#[test]
fn only_the_project_download_passes_the_gap_between_downloads() {
    let lab = lab();
    let gated = AtomicUsize::new(0);
    let gate = || {
        gated.fetch_add(1, Ordering::SeqCst);
    };
    let edit = |body: &'static str| {
        move |files: &mut BTreeMap<String, Vec<u8>>| {
            files.insert("sections/a.tex".into(), body.into());
        }
    };
    let sync_under_lease = || {
        let synced = sync_prefetched(&lab.config, &lab.root, NO_LIVE, None, None, Some(&gate));
        synced.unwrap().expect("a sync")
    };

    // A history short of the version: only the download can tell.
    lab.co_author(edit("\\section{A}\nOnce.\n"), &["sections/a.tex"], json!([]));
    lab.shared.lock().unwrap().version += 1;
    let read = prefetch(&lab.config, &lab.root, NO_LIVE, None, &gate, &|_, _| {}).unwrap();
    assert!(read.is_some());
    assert_eq!((lab.downloads(), gated.load(Ordering::SeqCst)), (1, 1));
    sync_under_lease();
    assert_eq!((lab.downloads(), gated.load(Ordering::SeqCst)), (2, 2));

    lab.co_author(edit("\\section{A}\nTwice.\n"), &["sections/a.tex"], json!([]));
    let read = prefetch(&lab.config, &lab.root, NO_LIVE, None, &gate, &|_, _| {}).unwrap();
    assert!(read.is_some());
    sync_under_lease();
    assert_eq!((lab.downloads(), gated.load(Ordering::SeqCst)), (2, 2), "fetched, not gated");
    lab.assert_matches_overleaf();
}

/// The download is most of a sync's time, and most syncs run because the
/// project's version moved without any file a sync handles changing. When
/// Overleaf's history proves that, the copy already agreed on stands in for
/// the download; anything it cannot prove means downloading after all. This
/// mock has no live channel, so nothing can be fetched on its own either.
#[test]
fn a_sync_downloads_the_project_only_when_overleafs_history_cannot_rule_out_a_change() {
    let base: Files = &[
        ("fig.png", b"\x89PNG agreed"),
        ("live.tex", b"live body"),
        ("main.tex", b"main body"),
        ("notes.tex", b"notes body"),
    ];
    let edit =
        |from: i64, paths: &[&str]| json!({ "fromV": from, "toV": from + 1, "pathnames": paths });
    let moved_live = edit(40, &["live.tex"]);
    let renamed = json!({ "fromV": 40, "toV": 41, "pathnames": [],
        "project_ops": [{ "rename": { "pathname": "live.tex", "newPathname": "live2.tex" } }] });
    let live: BTreeSet<String> = ["live.tex".to_string()].into();
    let exact = || Some(BTreeSet::new());
    let left_on_base = || Some(BTreeSet::from(["notes.tex".to_string()]));
    let main: (&str, &[u8]) = ("main.tex", b"main edited");
    let figure: (&str, &[u8]) = ("fig.png", b"\x89PNG new");
    // (case, versions, history, a local edit, how exactly the last sync's
    // table matched Overleaf, downloaded)
    type Case<'a> = (
        &'a str,
        Vec<i64>,
        Vec<Value>,
        Option<(&'a str, &'a [u8])>,
        Option<BTreeSet<String>>,
        bool,
    );
    let cases: &[Case] = &[
        ("unchanged, nothing to do", vec![40], vec![], None, exact(), false),
        ("unchanged, an edit to send", vec![40], vec![], Some(main), exact(), false),
        ("only a live document edited", vec![41], vec![moved_live.clone()], None, exact(), false),
        (
            "a file edited on Overleaf",
            vec![41],
            vec![edit(40, &["notes.tex"])],
            None,
            exact(),
            true,
        ),
        ("the tree changed", vec![41], vec![renamed], None, exact(), true),
        ("history short of the version", vec![42], vec![moved_live], None, exact(), true),
        ("no version to compare", vec![], vec![], None, exact(), true),
        ("an edited figure has no base copy", vec![40], vec![], Some(figure), exact(), true),
        ("the last sync's table was not exact", vec![40], vec![], None, None, true),
        (
            "a document left on its base is no longer live",
            vec![40],
            vec![],
            None,
            left_on_base(),
            true,
        ),
    ];
    for (case, versions, history, edited, unsettled, downloaded) in cases {
        let mock =
            Mock { versions: versions.clone(), history: history.clone(), ..Mock::project(base) };
        let server = mock.serve();
        let (config, root) = linked(&server, base, base);
        edit_state(&root, |state| {
            state.remote_version = Some(40);
            state.unsettled = unsettled.clone();
        });
        if let Some((rel, data)) = edited {
            fs::write(disk_path(&root, rel), data).unwrap();
        }
        let result = sync(&config, &root, &live, None).unwrap();
        assert_eq!(downloads(&server) == 1, *downloaded, "{case}");
        // The upload token is a page of every project; only an upload needs it.
        assert_eq!(dashboards(&server), usize::from(edited.is_some()), "{case}");
        let pushed: Vec<&str> = edited.iter().map(|(rel, _)| *rel).collect();
        assert_eq!(result.pushed, pushed, "{case}");
        assert!(result.pulled.is_empty() && result.merged.is_empty(), "{case}");
        // The same agreed copy is recorded either way.
        let files = state_files(&root);
        for (rel, data) in base.iter().filter(|(rel, _)| !pushed.contains(rel)) {
            assert_eq!(files.get(*rel), Some(&sha256_hex(data)), "{case}: {rel}");
        }
        if let Some((rel, data)) = edited {
            assert_eq!(files.get(*rel), Some(&sha256_hex(data)), "{case}: {rel}");
            assert!(server.uploads()[0]
                .body_text()
                .contains(&String::from_utf8_lossy(data).into_owned()));
        }
    }
}

// ---- the audit's project, over the audit's link ---------------------------------

/// Shaped like the captain's paper in the audit: 272 files, 29.6 MB, nearly
/// all of it figures.
fn audit_project() -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<(String, Vec<u8>)> = (0..60)
        .map(|n| {
            let body = format!("\\section{{Part {n}}}\n{}", "Words of the paper. ".repeat(300));
            (format!("sections/s{n:02}.tex"), body.into_bytes())
        })
        .collect();
    files.push(("main.tex".into(), b"\\documentclass{article}\n".to_vec()));
    let entry = "@article{key, title={A title}, author={An Author}, year={2020}}\n";
    files.push(("refs.bib".into(), entry.repeat(7_500).into_bytes()));
    for n in 0..210u32 {
        // Figures do not compress, so the zip does not shrink them either.
        let figure = (0..136 * 1024u32).map(|i| ((i ^ n).wrapping_mul(2_654_435_761) >> 13) as u8);
        files.push((format!("figures/fig{n:03}.pdf"), figure.collect()));
    }
    files
}

/// The captain's link as the audit measured it: the 29.6 MB download took
/// 22.2 s, and every request pays a round trip.
const LINK_BYTES_PER_SEC: f64 = 29_593_259.0 / 22.155;
const ROUND_TRIP: std::time::Duration = std::time::Duration::from_millis(250);

/// Run with `NO_PROXY=127.0.0.1 cargo test --lib overleaf::sync::tests::changes::bench
/// -- --ignored --nocapture`. Prints each sync's wide event and the mock's
/// request log; `F4_BENCH_LOG` names a file to write the log to as well.
#[test]
#[ignore = "takes a minute over the modelled link; run it by name"]
fn bench_the_audits_project_over_the_audits_link() {
    let mut log = String::new();
    for (scenario, fetch) in [
        ("a co-author's edit to one section", true),
        ("a co-author's edit to one section", false),
        ("the check after an agent's upload of 6 sections", true),
        ("the check after an agent's upload of 6 sections", false),
        ("a co-author's new figure", true),
        ("a co-author's new figure", false),
    ] {
        let files = audit_project();
        let shared_for_hook: Arc<Mutex<Option<Arc<Mutex<SharedProject>>>>> = Default::default();
        let hook_shared = Arc::clone(&shared_for_hook);
        let lab = lab_with(&files, |mock| {
            if !fetch {
                // What every one of these syncs did before: the download.
                mock.realtime = None;
            }
            mock.on_request = Some(Box::new(move |_, url| {
                let shared = hook_shared.lock().unwrap().clone();
                let Some(shared) = shared else { return };
                let shared = shared.lock().unwrap();
                let bytes = if url.ends_with("/download/zip") {
                    shared.files.values().map(Vec::len).sum::<usize>()
                } else if let Some(id) = url.strip_prefix("/project/proj-1/file/") {
                    (shared.files.iter())
                        .find(|(path, _)| entity_id(path) == id)
                        .map_or(0, |f| f.1.len())
                } else {
                    0
                };
                drop(shared);
                let transfer =
                    std::time::Duration::from_secs_f64(bytes as f64 / LINK_BYTES_PER_SEC);
                std::thread::sleep(ROUND_TRIP + transfer);
            }));
        });
        *shared_for_hook.lock().unwrap() = Some(Arc::clone(&lab.shared));
        if scenario.contains("upload") {
            let sections: Vec<String> = (2..8).map(|n| format!("sections/s{n:02}.tex")).collect();
            for path in &sections {
                let mut text = files.iter().find(|f| f.0 == *path).unwrap().1.clone();
                text.extend_from_slice(b"\nRevised by the agent.\n");
                fs::write(disk_path(&lab.root, path), &text).unwrap();
            }
            // Sent while the realtime mock is up (fetch) or by upload
            // (download), then what Overleaf holds after it.
            lab.sync();
            let local = read_local_files(&lab.root).unwrap().files;
            let mut shared = lab.shared.lock().unwrap();
            for path in &sections {
                shared.files.insert(path.clone(), local[path].clone());
            }
            let named: Vec<&str> = sections.iter().map(String::as_str).collect();
            shared.update(&named, json!([]));
        } else if scenario.contains("figure") {
            lab.co_author(
                |files| {
                    files.insert("figures/new.png".into(), vec![7u8; 300 * 1024]);
                },
                &[],
                json!([{ "add": { "pathname": "figures/new.png" } }]),
            );
        } else {
            lab.co_author(
                |files| {
                    let text = files.get_mut("sections/s01.tex").unwrap();
                    text.extend_from_slice(b"\nA sentence the co-author wrote.\n");
                },
                &["sections/s01.tex"],
                json!([]),
            );
        }
        let (before, joined_before) = (lab.server.recorded().len(), lab.docs_joined().len());
        let (handshakes_before, frames_before) = {
            let live = lab.live.lock().unwrap();
            (live.requests.len(), live.frames.len())
        };
        let started = std::time::Instant::now();
        let (result, capture) = crate::wide_event::tests::capture(|| {
            let operation =
                crate::wide_event::Operation::start("overleaf.sync", classify_sync_error);
            operation.run_sync(|| sync(&lab.config, &lab.root, NO_LIVE, None)).unwrap()
        });
        let took = started.elapsed();
        let event = capture.events().pop().unwrap();
        let joins = lab.docs_joined().len() - joined_before;
        let path = if fetch { "fetch only what changed" } else { "project download (before)" };
        let bytes = match event["download"].as_str() {
            Some("full") => event["remote_bytes"].as_u64().unwrap(),
            _ => event["fetched_bytes"].as_u64().unwrap_or(0),
        };
        let line = format!(
            "{scenario:<48} {path:<26} {:>6.2} s  {:>10} bytes in  download={} fetched_files={} docs_joined={joins} pulled={:?}\n",
            took.as_secs_f64(),
            bytes,
            event["download"],
            event["fetched_files"],
            result.pulled,
        );
        print!("{line}");
        log.push_str(&line);
        for request in &lab.server.recorded()[before..] {
            log.push_str(&format!("    {} {}\n", request.method, request.url));
        }
        // The live channel's side: its handshake requests, then each event
        // sent over the socket, by name and first argument.
        let live = lab.live.lock().unwrap();
        for (url, ..) in &live.requests[handshakes_before..] {
            log.push_str(&format!("    live GET {url}\n"));
        }
        for frame in &live.frames[frames_before..] {
            let Some(event) = frame.split_once("{\"name\":\"").map(|(_, rest)| rest) else {
                continue;
            };
            let name = event.split('"').next().unwrap_or_default();
            let arg = event.split("\"args\":[").nth(1).unwrap_or_default();
            let arg = arg.split([',', ']']).next().unwrap_or_default();
            log.push_str(&format!("    live emit {name}({arg})\n"));
        }
        drop(live);
        lab.assert_matches_overleaf();
    }
    println!("{log}");
    if let Ok(out) = std::env::var("F4_BENCH_LOG") {
        fs::write(out, log).unwrap();
    }
}
