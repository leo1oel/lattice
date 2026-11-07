//! A sync that downloads before it takes the project's lease (#670): the
//! download is used when it still fits the link, and when not, the sync
//! turns it down without downloading under the lease, to be read again, up
//! to a bound.

use super::*;
use crate::overleaf::link::record_relocation;
use crate::overleaf_rt::EntityEntry;
use std::sync::atomic::{AtomicU64, Ordering};

/// A project shaped like the report: dozens of sources and a few figures
/// big enough that the download, not the sync, is what takes the time.
fn project() -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<(String, Vec<u8>)> = (1..=50)
        .map(|n| (format!("sections/s{n:02}.tex"), format!("\\section{{S{n}}}\n").into_bytes()))
        .collect();
    files.push(("main.tex".into(), b"\\documentclass{article}".to_vec()));
    for n in 1..=3 {
        files.push((format!("figures/f{n}.pdf"), vec![b'%'; 256 * 1024 + n]));
    }
    files
}

fn as_files(files: &[(String, Vec<u8>)]) -> Vec<(&str, &[u8])> {
    files.iter().map(|(path, bytes)| (path.as_str(), bytes.as_slice())).collect()
}

fn downloads(server: &MockServer) -> usize {
    (server.recorded().iter()).filter(|request| request.url.ends_with("/download/zip")).count()
}

#[test]
fn files_created_and_deleted_during_the_download_are_part_of_the_sync() {
    let files = project();
    let files = as_files(&files);
    let server = Mock { versions: vec![7], ..Mock::project(&files) }.serve();
    let (config, root) = linked(&server, &files, &files);
    let received = AtomicU64::new(0);
    let progress = |bytes: u64, _total: Option<u64>| received.store(bytes, Ordering::Relaxed);

    let prefetched = prefetch(&config, &root, NO_LIVE, None, &progress).unwrap();
    assert!(prefetched.is_some());
    assert_eq!(received.load(Ordering::Relaxed), Mock::project(&files).zip.len() as u64);
    // What the writer does meanwhile, now that it no longer waits for the
    // sync: one file deleted, one created.
    fs::remove_file(disk_path(&root, "sections/s07.tex")).unwrap();
    fs::write(disk_path(&root, "sections/new.tex"), "\\section{New}").unwrap();

    let result =
        sync_prefetched(&config, &root, NO_LIVE, None, prefetched, false).unwrap().unwrap();
    assert_eq!(result.pushed, vec!["sections/new.tex"]);
    // The question about Overleaf's copy comes from this very sync.
    assert_eq!(result.skipped_remote_deletes, vec!["sections/s07.tex"]);
    assert_eq!(downloads(&server), 1, "the sync used the download it read ahead");
    assert_eq!(remote_version(&root), None, "an upload leaves the version to verify");
}

#[test]
fn a_document_left_during_the_download_waits_for_the_next_sync() {
    let files = project();
    let files = as_files(&files);
    // A document typed in over the live channel and then left: Overleaf has
    // the newer text, and the checkpoint on leaving records it as agreed.
    let newer = b"\\section{S1, newer}\n".as_slice();
    let mut after: Vec<(&str, &[u8])> = files.clone();
    after[0].1 = newer;
    let later_zip = Some(build_zip(&after));
    let server = Mock { versions: vec![7], later_zip, ..Mock::project(&files) }.serve();
    let (config, root) = linked(&server, &files, &files);
    let prefetched = prefetch(&config, &root, NO_LIVE, None, &|_, _| {}).unwrap();
    fs::write(disk_path(&root, "sections/s01.tex"), newer).unwrap();
    edit_state(&root, |state| {
        state.files.insert("sections/s01.tex".into(), sha256_hex(newer));
    });

    // Compared against the table, the download read ahead has Overleaf
    // putting the old text back; the sync leaves that document alone.
    let result = sync_prefetched(&config, &root, NO_LIVE, None, prefetched, false).unwrap();
    let result = result.expect("the rest of the download still fits");
    assert_eq!(downloads(&server), 1);
    assert!(result.pulled.is_empty() && result.pushed.is_empty(), "{result:?}");
    assert_eq!(read_local(&root, "sections/s01.tex").unwrap(), newer);

    // The history has not moved, but the copy it vouches for is not the
    // table's for that document: the next sync downloads to see it.
    let result = sync(&config, &root, NO_LIVE, None).unwrap();
    assert_eq!(downloads(&server), 2);
    assert!(result.pulled.is_empty() && result.pushed.is_empty(), "{result:?}");
    assert_eq!(read_local(&root, "sections/s01.tex").unwrap(), newer);
}

#[test]
fn a_link_that_keeps_moving_costs_a_sync_three_downloads_at_most() {
    let files = project();
    let files = as_files(&files);
    let server = Mock::project(&files).serve();
    let (config, root) = linked(&server, &files, &files);
    // A file deleted here and on Overleaf during every download, which the
    // download read ahead still has.
    let mut rounds = 0;
    let meanwhile = || {
        rounds += 1;
        let path = format!("sections/s{rounds:02}.tex");
        fs::remove_file(disk_path(&root, &path)).unwrap();
        edit_state(&root, |state| {
            state.files.remove(&path);
        });
    };

    sync_meanwhile(&config, &root, NO_LIVE, None, meanwhile).unwrap();
    assert_eq!(rounds, READ_AHEAD_ROUNDS + 1);
    assert_eq!(downloads(&server), 3, "two reads ahead, then one under the lease");
}

#[test]
fn a_move_replayed_after_the_download_is_not_followed_by_a_download_under_the_lease() {
    let files = project();
    let files = as_files(&files);
    let mut moved: Vec<(&str, &[u8])> = files.clone();
    moved[0].0 = "sections/first.tex";
    let later_zip = Some(build_zip(&moved));
    let server = Mock { later_zip, ..Mock::project(&files) }.serve();
    let (config, root) = linked(&server, &files, &files);
    let prefetched = prefetch(&config, &root, NO_LIVE, None, &|_, _| {}).unwrap();
    assert!(prefetched.is_some());
    // Renamed while the download ran, then replayed once the lease is held.
    fs::rename(disk_path(&root, "sections/s01.tex"), disk_path(&root, "sections/first.tex"))
        .unwrap();
    record_relocation(&root, "sections/s01.tex", "sections/first.tex").unwrap();
    let tree = vec![EntityEntry {
        id: "s01-id".into(),
        path: "sections/s01.tex".into(),
        kind: "doc".into(),
    }];
    sync_relocations(&config, &root, Some(tree)).unwrap();

    let turned_down = sync_prefetched(&config, &root, NO_LIVE, None, prefetched, false).unwrap();
    assert!(turned_down.is_none(), "{turned_down:?}");
    assert_eq!(downloads(&server), 1, "no download while the lease is held");

    let prefetched = prefetch(&config, &root, NO_LIVE, None, &|_, _| {}).unwrap();
    let result =
        sync_prefetched(&config, &root, NO_LIVE, None, prefetched, false).unwrap().unwrap();
    assert_eq!(downloads(&server), 2);
    assert!(result.skipped_remote_deletes.is_empty(), "{result:?}");
    assert!(result.pushed.is_empty() && result.pulled.is_empty(), "{result:?}");
    assert!(server.uploads().is_empty());
}

#[test]
fn a_live_document_moving_on_meanwhile_keeps_the_download() {
    let files = project();
    let files = as_files(&files);
    let server = Mock::project(&files).serve();
    let (config, root) = linked(&server, &files, &files);
    let live: BTreeSet<String> = ["main.tex".to_string()].into();
    let prefetched = prefetch(&config, &root, &live, None, &|_, _| {}).unwrap();
    edit_state(&root, |state| {
        state.files.insert("main.tex".into(), sha256_hex(b"typed over the live channel"));
    });

    let result = sync_prefetched(&config, &root, &live, None, prefetched, false).unwrap().unwrap();
    assert_eq!(downloads(&server), 1);
    assert!(result.pushed.is_empty() && result.pulled.is_empty());
}
