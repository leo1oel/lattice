//! A sync that downloads before it takes the project's lease (#670): the
//! download is used when it still fits the link, and taken again when not.

use super::*;
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

    let result = sync_prefetched(&config, &root, NO_LIVE, None, prefetched).unwrap();
    assert_eq!(result.pushed, vec!["sections/new.tex"]);
    // The question about Overleaf's copy comes from this very sync.
    assert_eq!(result.skipped_remote_deletes, vec!["sections/s07.tex"]);
    assert_eq!(downloads(&server), 1, "the sync used the download it read ahead");
    assert_eq!(remote_version(&root), None, "an upload leaves the version to verify");
}

#[test]
fn a_download_the_link_moved_past_meanwhile_is_taken_again() {
    let files = project();
    let files = as_files(&files);
    // A document typed in over the live channel and then left: Overleaf has
    // the newer text, and the checkpoint on leaving records it as agreed.
    let newer = b"\\section{S1, newer}\n".as_slice();
    let mut after: Vec<(&str, &[u8])> = files.clone();
    after[0].1 = newer;
    let later_zip = Some(build_zip(&after));
    let server = Mock { later_zip, ..Mock::project(&files) }.serve();
    let (config, root) = linked(&server, &files, &files);
    let prefetched = prefetch(&config, &root, NO_LIVE, None, &|_, _| {}).unwrap();
    fs::write(disk_path(&root, "sections/s01.tex"), newer).unwrap();
    edit_state(&root, |state| {
        state.files.insert("sections/s01.tex".into(), sha256_hex(newer));
    });

    let result = sync_prefetched(&config, &root, NO_LIVE, None, prefetched).unwrap();
    // Compared against the table, the download read ahead has Overleaf
    // putting the old text back, and the sync would have pulled it.
    assert_eq!(downloads(&server), 2, "the stale download was set aside");
    assert!(result.pulled.is_empty() && result.pushed.is_empty(), "{result:?}");
    assert_eq!(read_local(&root, "sections/s01.tex").unwrap(), newer);
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

    let result = sync_prefetched(&config, &root, &live, None, prefetched).unwrap();
    assert_eq!(downloads(&server), 1);
    assert!(result.pushed.is_empty() && result.pulled.is_empty());
}
