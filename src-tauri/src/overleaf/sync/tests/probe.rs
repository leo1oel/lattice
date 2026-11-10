//! The probe: which remote version it reports after a sync, and the one
//! client it keeps between polls.

use super::*;
use crate::overleaf::sync::probe::PROBE_CLIENT_BUILDS;

#[test]
fn repeated_probes_share_one_client() {
    let server = Mock { versions: vec![7], ..Mock::project(&[("main.tex", b"x")]) }.serve();
    let (config, root) = linked(&server, &[("main.tex", b"x")], &[("main.tex", b"x")]);
    for _ in 0..3 {
        let probed = probe(&config, &root, None).unwrap();
        assert_eq!(probed.remote_version, Some(7));
    }
    let builds = PROBE_CLIENT_BUILDS.lock().unwrap().get(&server.base).copied();
    assert_eq!(builds, Some(1));
}

#[test]
fn overleaf_sync_records_only_a_remote_version_that_precedes_its_snapshot() {
    // - "recheck fails": /updates answers 404 while the download succeeds, an
    //   intermittent best-effort history failure; the saved 42 survives, but a
    //   successful probe made immediately before the sync is stronger evidence
    //   and becomes the new baseline.
    // - "pull": the zip contains version 11 and a collaborator reaches 12
    //   while the sync is finishing. Recording 12 would make the next probe
    //   say the stale local copy is current.
    // - "push": the first two reads prove the remote stayed at 11 until
    //   upload, but the server does not say which version belongs to that
    //   upload, so a later 12 must be verified rather than silently claimed.
    let (base, edited) = (b"base body".as_slice(), b"edited".as_slice());
    for (label, versions, remote, local, observed, recorded, moved, next) in [
        ("recheck fails", vec![], base, base, None, Some(42), (0, 0), None),
        ("recheck fails after a probe", vec![], base, base, Some(43), Some(43), (0, 0), None),
        ("pull", vec![11, 12], edited, base, None, Some(11), (1, 0), Some(12)),
        ("push", vec![11, 11, 12], base, edited, None, None, (0, 1), Some(12)),
    ] {
        let server = Mock { versions, ..Mock::project(&[("main.tex", remote)]) }.serve();
        let (config, root) = linked(&server, &[("main.tex", local)], &[("main.tex", base)]);
        edit_state(&root, |state| state.remote_version = Some(42));
        let result = sync(&config, &root, NO_LIVE, observed).unwrap();
        assert_eq!((result.pulled.len(), result.pushed.len()), moved, "{label}");
        assert_eq!(remote_version(&root), recorded, "{label}");
        if let Some(next) = next {
            let probed = probe(&config, &root, None).unwrap();
            assert_eq!((probed.changed, probed.remote_version), (true, Some(next)), "{label}");
        }
    }
}
