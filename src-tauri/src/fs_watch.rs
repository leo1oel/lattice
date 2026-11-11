//! Project filesystem watcher.
//!
//! `notify` (FSEvents) reports changes, a debounce thread coalesces bursts,
//! and one `project-fs-changed` event tells every window showing that root to
//! refresh, instead of the frontend polling `refresh_project` + `git_status`.
//! The frontend keeps a slow fallback poll as a safety net.
//!
//! `.research/` churn is filtered out: app state writes (history, FTS
//! indexes, caches, the paper library) fire on every save and are invisible to
//! the project tree anyway (`scan_tree` excludes them). `.git/` events stay:
//! they are how commits and stages reach the source-control badge without
//! polling. So are reports about a folder itself that change no file in it
//! (`folder_echo`).

use notify::event::{CreateKind, ModifyKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime};
use tauri::Emitter;

/// Quiet period before a burst of events becomes one refresh.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// The longest a steady stream of events waits before it is reported anyway,
/// so a folder written without pause (an experiment logging into the
/// project) still refreshes the windows now and then. Each report rescans
/// the whole project tree, so the cap is long: a tree lagging up to 30 s
/// behind a continuous stream is cheaper than a full rescan every few
/// seconds, and any quiet gap of `DEBOUNCE` still reports at once.
const MAX_BURST: Duration = Duration::from_secs(30);

struct WatchBatch {
    paths: Vec<PathBuf>,
    reconcile: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
    root: String,
    /// Project-relative paths when the watcher reported an exact set. `None`
    /// tells consumers to conservatively invalidate project-wide state.
    paths: Option<Vec<String>>,
}

#[derive(Clone, Serialize)]
struct ReopenedPayload {
    root: String,
}

/// Tell the window already showing `root` that it was asked to open the
/// project again, which a writer does after changing the folder elsewhere.
pub fn announce_reopened<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: &Path) {
    // Broadcast like `project-fs-changed`; each window filters by its root.
    let _ =
        app.emit("project-reopened", ReopenedPayload { root: root.to_string_lossy().to_string() });
}

/// Keeps the underlying watcher alive; dropping it stops the event stream,
/// which in turn ends the debounce thread once its channel disconnects.
pub struct ProjectWatcher {
    _watcher: RecommendedWatcher,
}

fn relevant(event: &Event, root: &Path) -> bool {
    event.paths.iter().any(|path| {
        let relative = match path.strip_prefix(root) {
            Ok(relative) => relative,
            // Outside the root (rename endpoints, watch-root parents): treat
            // as relevant rather than silently dropping a real change.
            Err(_) => return true,
        };
        !relative.starts_with(".research")
    })
}

/// A report about a folder itself that changed no file in it.
///
/// macOS reports the folder holding a file whenever a hard link to that file
/// is made from outside it. Google Drive, backing up ~/Documents, links each
/// changed file into its upload folder, so every build's output reached the
/// windows as the project root changing (which reads as "anything may have
/// changed") or as `section/` changing, either of which builds again: a paper
/// that failed to compile rebuilt every five seconds, each rebuild's output
/// linked again. A folder's metadata changing touches no file in it (renames
/// and removals have kinds of their own), and a folder that was there before
/// the watch began, `watching_since`, was not just created: FSEvents repeats a
/// folder's creation on its later reports. The files of a folder copied in
/// report themselves.
fn folder_echo(event: &Event, watching_since: SystemTime) -> bool {
    let every_path = |test: &dyn Fn(fs::Metadata) -> bool| {
        !event.paths.is_empty() && event.paths.iter().all(|path| fs::metadata(path).is_ok_and(test))
    };
    match event.kind {
        EventKind::Modify(ModifyKind::Metadata(_)) => every_path(&|metadata| metadata.is_dir()),
        EventKind::Create(CreateKind::Folder) => every_path(&|metadata| {
            metadata.is_dir() && metadata.created().is_ok_and(|born| born < watching_since)
        }),
        _ => false,
    }
}

/// What a watcher callback hands the debounce thread, or `None` to drop it.
fn batch_for(
    event: Result<Event, notify::Error>, root: &Path, watching_since: SystemTime,
) -> Option<WatchBatch> {
    match event {
        // The backend dropped events and asks for a rescan: the same as a
        // watcher error, for the index and for the windows. FSEvents names
        // the paths it lost; an inotify queue overflow names none.
        Ok(event) if event.need_rescan() && (event.paths.is_empty() || relevant(&event, root)) => {
            Some(WatchBatch { paths: Vec::new(), reconcile: true })
        }
        Ok(event) if folder_echo(&event, watching_since) => None,
        Ok(event) if relevant(&event, root) => {
            Some(WatchBatch { paths: event.paths, reconcile: false })
        }
        Ok(_) => None,
        Err(_) => Some(WatchBatch { paths: Vec::new(), reconcile: true }),
    }
}

/// Absorb the burst that began with `first`: keep taking batches from `recv`
/// until things go quiet for `DEBOUNCE` or the burst has run `MAX_BURST`.
/// `None` once the channel disconnects. `now` and `recv` are the clock and
/// the channel, passed in so a test can run the real timings on a fake clock.
fn drain_burst(
    first: WatchBatch, now: impl Fn() -> Instant,
    mut recv: impl FnMut(Duration) -> Result<WatchBatch, RecvTimeoutError>,
) -> Option<WatchBatch> {
    let WatchBatch { mut paths, mut reconcile } = first;
    let burst = now() + MAX_BURST;
    loop {
        let wait = DEBOUNCE.min(burst.saturating_duration_since(now()));
        match recv(wait) {
            Ok(batch) => {
                paths.extend(batch.paths);
                reconcile |= batch.reconcile;
                if now() >= burst {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => break,
            Err(RecvTimeoutError::Disconnected) => return None,
        }
    }
    Some(WatchBatch { paths, reconcile })
}

fn payload_paths(root: &Path, paths: &[PathBuf], reconcile: bool) -> Option<Vec<String>> {
    if reconcile || paths.is_empty() {
        return None;
    }
    let mut relative_paths = BTreeSet::new();
    for path in paths {
        let Ok(relative) = path.strip_prefix(root) else {
            return None;
        };
        if relative.as_os_str().is_empty() {
            return None;
        }
        relative_paths.insert(
            relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
        );
    }
    (!relative_paths.is_empty()).then(|| relative_paths.into_iter().collect())
}

pub fn spawn<R: tauri::Runtime>(
    app: tauri::AppHandle<R>, root: PathBuf,
) -> Result<ProjectWatcher, String> {
    let (sender, receiver) = mpsc::channel::<WatchBatch>();
    let filter_root = root.clone();
    let watching_since = SystemTime::now();
    let mut watcher = notify::recommended_watcher(move |event: Result<Event, notify::Error>| {
        if let Some(batch) = batch_for(event, &filter_root, watching_since) {
            let _ = sender.send(batch);
        }
    })
    .map_err(|error| error.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|error| error.to_string())?;

    std::thread::spawn(move || {
        let reconcile_index = || {
            if let Err(error) = crate::fts::reconcile(&root) {
                eprintln!("Could not reconcile the project search index: {error}");
            }
        };
        // Reconcile an existing index once after attaching the watcher. This
        // catches edits made while the project was closed without delaying
        // either project open or the first search.
        reconcile_index();
        // After that the index follows the watcher's reports. A whole-project
        // reconcile runs again only when the watcher says it lost events (an
        // error, a backend rescan): on a timer it rescanned every file of a
        // large project each minute while nothing changed.
        loop {
            let Ok(first) = receiver.recv() else { return };
            let Some(WatchBatch { paths, reconcile }) =
                drain_burst(first, Instant::now, |wait| receiver.recv_timeout(wait))
            else {
                return;
            };
            let changed_paths = payload_paths(&root, &paths, reconcile);
            let update = if reconcile {
                crate::fts::reconcile(&root)
            } else {
                crate::fts::update_paths(&root, &paths)
            };
            if let Err(error) = update {
                eprintln!("Could not update the project search index: {error}");
            }
            // Broadcast; each window filters by its own project root.
            let _ = app.emit(
                "project-fs-changed",
                FsChangedPayload { root: root.to_string_lossy().to_string(), paths: changed_paths },
            );
        }
    });

    Ok(ProjectWatcher { _watcher: watcher })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{MetadataKind, RemoveKind, RenameMode};

    /// The watcher on `root` with the reports it sends the windows, once the
    /// stream has attached and anything from creating the fixture has passed.
    fn watched(
        root: &Path,
    ) -> (tauri::App<tauri::test::MockRuntime>, ProjectWatcher, mpsc::Receiver<serde_json::Value>)
    {
        use tauri::Listener;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (sender, reports) = mpsc::channel::<serde_json::Value>();
        app.handle().listen("project-fs-changed", move |event| {
            let _ = sender.send(serde_json::from_str(event.payload()).unwrap());
        });
        let watcher = spawn(app.handle().clone(), root.to_path_buf()).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        while reports.recv_timeout(DEBOUNCE * 2).is_ok() {}
        (app, watcher, reports)
    }

    /// Folders that arrive from outside the project, copied the way Finder
    /// or `cp -R` copies them and moved in whole, each reach the windows as a
    /// coalesced report naming the new folder.
    #[test]
    fn reports_folders_copied_or_moved_in_from_outside() {
        let project = crate::test_support::TempDir::new("watch-arrivals");
        let outside = crate::test_support::TempDir::new("watch-arrivals-outside");
        project.write("main.tex", "\\documentclass{article}");
        let root = project.canonicalize().unwrap();
        let (_app, _watcher, reports) = watched(&root);
        // A report naming any of `paths`.
        let reported = |paths: &[&str]| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while let Ok(report) =
                reports.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                assert_eq!(report["root"], root.to_string_lossy().as_ref());
                // No paths (FSEvents asked for a rescan) covers every one.
                let Some(names) = report["paths"].as_array() else { return true };
                if names.iter().any(|name| paths.iter().any(|path| name == path)) {
                    return true;
                }
            }
            false
        };

        outside.write("figures/plots/loss.png", b"\x89PNG");
        outside.write("figures/table.tex", "\\begin{tabular}");
        std::fs::create_dir_all(root.join("figures/plots")).unwrap();
        for file in ["figures/plots/loss.png", "figures/table.tex"] {
            std::fs::copy(outside.join(file), root.join(file)).unwrap();
        }
        // FSEvents names every file the copy wrote. inotify watches a new
        // folder only once it is reported, so a copy that fills it first can
        // arrive as the folder alone, which still rescans the tree.
        let copied: &[&str] = if cfg!(target_os = "macos") {
            &["figures/plots/loss.png"]
        } else {
            &["figures/plots/loss.png", "figures/plots", "figures"]
        };
        assert!(reported(copied), "a copied folder went unreported");

        outside.write("appendix/proofs.tex", "proof");
        std::fs::rename(outside.join("appendix"), root.join("appendix")).unwrap();
        assert!(reported(&["appendix"]), "a moved-in folder went unreported");
    }

    /// Google Drive's backup of ~/Documents hard-links each changed file into
    /// its upload folder, and macOS reports the folder holding the file: the
    /// project root, which reads as "anything may have changed", and
    /// `section`. Every build of a paper rebuilt it again (`folder_echo`).
    #[test]
    fn a_hard_link_made_from_outside_the_project_reaches_no_window() {
        let project = crate::test_support::TempDir::new("watch-hard-links");
        let uploads = crate::test_support::TempDir::new("watch-hard-links-uploads");
        project.write("main.aux", "\\relax");
        project.write("section/intro.aux", "\\relax");
        let root = project.canonicalize().unwrap();
        let (_app, _watcher, reports) = watched(&root);

        std::fs::hard_link(root.join("main.aux"), uploads.join("1")).unwrap();
        std::fs::hard_link(root.join("section/intro.aux"), uploads.join("2")).unwrap();
        // inotify names the linked files themselves, which are build output.
        while let Ok(report) = reports.recv_timeout(Duration::from_secs(2)) {
            let names = report["paths"].as_array().expect("a report naming no path rebuilds");
            for name in names {
                assert!(name == "main.aux" || name == "section/intro.aux", "{report}");
            }
        }
        // The watcher is still reporting changes to files.
        project.write("main.tex", "\\documentclass{article}");
        let report =
            reports.recv_timeout(Duration::from_secs(10)).expect("main.tex went unreported");
        assert_eq!(report["paths"], serde_json::json!(["main.tex"]));
    }

    #[test]
    fn a_folders_own_metadata_or_repeated_creation_is_not_a_change() {
        let project = crate::test_support::TempDir::new("watch-folder-echo");
        project.write("section/intro.tex", "Intro");
        let root = project.canonicalize().unwrap();
        let since = SystemTime::now();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::create_dir(root.join("appendix")).unwrap();
        let kept = |kind: EventKind, path: &str| {
            let mut event = Event::new(kind);
            event.paths = vec![if path.is_empty() { root.clone() } else { root.join(path) }];
            batch_for(Ok(event), &root, since).is_some()
        };
        let metadata = EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any));
        assert!(!kept(metadata, ""), "the project root's own metadata");
        assert!(!kept(metadata, "section"));
        assert!(!kept(EventKind::Create(CreateKind::Folder), "section"), "made before the watch");
        // A file's metadata (a touch, a chmod) still counts, and so does a
        // folder made since, renamed or removed.
        assert!(kept(metadata, "section/intro.tex"));
        assert!(kept(EventKind::Create(CreateKind::Folder), "appendix"));
        assert!(kept(EventKind::Modify(ModifyKind::Name(RenameMode::Any)), "section"));
        assert!(kept(EventKind::Remove(RemoveKind::Folder), "chapters"));
    }

    fn event_for(paths: Vec<PathBuf>) -> Event {
        let mut event = Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any));
        event.paths = paths;
        event
    }

    #[test]
    fn filters_app_private_state_but_keeps_project_and_git_paths() {
        let root = PathBuf::from("/tmp/project");
        for (paths, expected) in [
            (&["main.tex"][..], true),
            (&[".git/index"], true),
            (&[".research/history/x.json"], false),
            (&[".research/papers/2401.00001/paper.md"], false),
            // Mixed bursts stay relevant if any path matters.
            (&[".research/cache/fts.sqlite", "notes.md"], true),
        ] {
            let event = event_for(paths.iter().map(|path| root.join(path)).collect());
            assert_eq!(relevant(&event, &root), expected, "{paths:?}");
        }
    }

    #[test]
    fn rescans_when_the_backend_lost_events_even_without_paths() {
        use notify::event::{EventKind, Flag};
        let root = PathBuf::from("/tmp/project");
        let rescan = |paths: &[&str]| {
            let mut event = Event::new(EventKind::Other).set_flag(Flag::Rescan);
            event.paths = paths.iter().map(|path| root.join(path)).collect();
            batch_for(Ok(event), &root, SystemTime::now()).map(|batch| batch.reconcile)
        };
        // inotify reports a queue overflow as a rescan naming no path.
        assert_eq!(rescan(&[]), Some(true));
        assert_eq!(rescan(&["figures"]), Some(true));
        // Lost events only under app-private state leave the project alone.
        assert_eq!(rescan(&[".research/cache"]), None);
        let error = notify::Error::generic("watch failed");
        assert_eq!(
            batch_for(Err(error), &root, SystemTime::now()).map(|batch| batch.reconcile),
            Some(true)
        );
    }

    /// Drive `drain_burst` with the real timings on a fake clock: a batch
    /// arrives `gap` after the previous one, for ever. Returns how long the
    /// burst was held and how many paths it reported.
    fn drain_with_arrivals_every(gap: Duration) -> (Duration, usize) {
        use std::cell::Cell;
        let start = Instant::now();
        let clock = Cell::new(start);
        let first =
            WatchBatch { paths: vec![PathBuf::from("/tmp/project/log.txt")], reconcile: false };
        let drained = drain_burst(
            first,
            || clock.get(),
            |wait| {
                if gap <= wait {
                    clock.set(clock.get() + gap);
                    Ok(WatchBatch {
                        paths: vec![PathBuf::from("/tmp/project/log.txt")],
                        reconcile: false,
                    })
                } else {
                    clock.set(clock.get() + wait);
                    Err(RecvTimeoutError::Timeout)
                }
            },
        )
        .unwrap();
        (clock.get() - start, drained.paths.len())
    }

    #[test]
    fn holds_a_steady_stream_for_thirty_seconds_and_flushes_after_a_quiet_gap() {
        // An experiment logging every 200 ms never pauses for the 300 ms
        // debounce: it is reported once 30 s have passed, not before.
        let (held, paths) = drain_with_arrivals_every(Duration::from_millis(200));
        assert!(held >= Duration::from_secs(30), "reported after {held:?}");
        assert!(held < Duration::from_millis(30_200), "held for {held:?}");
        assert_eq!(paths, 151);
        // A write followed by a pause is reported once the debounce runs out.
        let (held, paths) = drain_with_arrivals_every(Duration::from_millis(400));
        assert_eq!(held, Duration::from_millis(300));
        assert_eq!(paths, 1);
    }

    #[test]
    fn stops_draining_when_the_watcher_is_gone() {
        let first = WatchBatch { paths: Vec::new(), reconcile: false };
        assert!(drain_burst(first, Instant::now, |_| Err(RecvTimeoutError::Disconnected)).is_none());
    }

    #[test]
    fn reports_sorted_deduplicated_project_relative_paths() {
        let root = PathBuf::from("/tmp/project");
        let chart = root.join("images/chart.png");
        let exact = [chart.clone(), root.join("main.md"), chart];
        assert_eq!(
            payload_paths(&root, &exact, false),
            Some(vec!["images/chart.png".into(), "main.md".into()])
        );
        // Not an exact set: a reconcile, the root itself, or a path outside it.
        assert_eq!(payload_paths(&root, &exact, true), None);
        assert_eq!(payload_paths(&root, std::slice::from_ref(&root), false), None);
        assert_eq!(payload_paths(&root, &[PathBuf::from("/tmp/other/main.md")], false), None);
    }
}
