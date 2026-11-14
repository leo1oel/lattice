//! What the app does when it crashes, as the Tauri app does
//! (`src/telemetry/crash-save.ts`, `root-error-boundary.tsx`, and the panic
//! hook in `src-tauri/src/lib.rs`).
//!
//! A panic is logged first, as the Tauri app's hook logs it (`lattice::panic`).
//! A panic on the main thread has its entry written to the app's log file at
//! once, since the process may not live to flush the log's own queue: it
//! ends the app (GPUI's callbacks from AppKit cannot unwind), so before it
//! does, the open edits are written, as the Tauri app's crash page writes
//! them while the crashed tree is still mounted: autosave waits for a pause
//! in typing, so the last second of work lives only in the editors.
//!
//! The main thread is the one panicking and holds the app, so the hook
//! cannot ask an editor for its text: each editor hands its text here as it
//! changes ([`note`]), a rope that costs a reference count to keep, with the
//! text it was last saved as, so the crash save merges with an outside edit
//! as a save does. The hook writes each through the same transaction as a
//! save, giving up on the rest after [`CRASH_SAVE_TIMEOUT`].
//!
//! The Tauri app then shows its crash page ("Lattice couldn’t open this
//! window", Restart and Copy error details). Here the process is gone by
//! then, so the hook leaves a note in the state folder and the next launch
//! says what happened, with the error's details to copy and the report to
//! file ([`announce_previous_crash`]).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, OnceLock},
    thread::ThreadId,
    time::{Duration, Instant},
};

use gpui::{App, ClipboardItem, EntityId};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;
use serde::{Deserialize, Serialize};

use crate::{
    app_log::{self, Level, NewEntry},
    notices::{self, Notice, NoticeAction},
};

/// A crash save gives up on the documents left after this long
/// (`CRASH_SAVE_TIMEOUT_MS`): the app must end even when a write hangs.
pub const CRASH_SAVE_TIMEOUT: Duration = Duration::from_secs(3);

/// The note a crash leaves for the next launch, in the state folder.
const NOTE_FILE: &str = "crash.json";

/// One editor's unsaved text, as it last changed.
struct OpenEdit {
    root: PathBuf,
    relative: String,
    /// The buffer's text, read only when a crash writes it.
    text: Box<dyn Fn() -> String + Send>,
    /// What the editor last saved, the base a save merges against.
    base: String,
}

static OPEN_EDITS: LazyLock<Mutex<HashMap<EntityId, OpenEdit>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Where the hook writes, set once at startup.
struct Places {
    /// The state folder (`None`: a run that keeps nothing).
    state: Option<PathBuf>,
    main: ThreadId,
}

static PLACES: OnceLock<Places> = OnceLock::new();

/// What a crash left behind for the next launch.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CrashNote {
    /// ISO 8601 in UTC, as the log writes it.
    pub timestamp: String,
    /// The panic's message and where it was raised.
    pub detail: String,
    /// The documents the crash save wrote, and the ones it could not.
    pub saved: Vec<String>,
    pub failed: Vec<String>,
}

/// Install the panic hook, before anything else runs: `state` is the folder
/// the app's log and the crash note are written in. The default hook still
/// prints the panic and its backtrace after it.
pub fn install(state: Option<PathBuf>) {
    if PLACES
        .set(Places {
            state,
            main: std::thread::current().id(),
        })
        .is_err()
    {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        on_panic(&info.to_string());
        previous(info);
    }));
}

fn on_panic(detail: &str) {
    log::error!(target: "lattice::panic", "{detail}");
    let Some(places) = PLACES.get() else {
        return;
    };
    let timestamp = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    // A worker thread's panic ends only that thread; the app goes on, the
    // editors keep their edits, and the log takes the record above.
    if std::thread::current().id() != places.main {
        return;
    }
    if let Some(state) = &places.state {
        write_log_line(state, &timestamp, detail);
    }
    let (saved, failed) = save_open_edits(Instant::now() + CRASH_SAVE_TIMEOUT);
    if let Some(state) = &places.state {
        let note = CrashNote {
            timestamp,
            detail: app_log::redact(detail),
            saved,
            failed,
        };
        if let Ok(text) = serde_json::to_string(&note) {
            std::fs::create_dir_all(state).ok();
            std::fs::write(state.join(NOTE_FILE), text).ok();
        }
    }
}

/// The panic as one entry of the app's log file, written now: the log's own
/// queue flushes on a background task the crash may not wait for.
fn write_log_line(state: &Path, timestamp: &str, detail: &str) {
    use std::io::Write as _;
    let entry = app_log::Entry {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: timestamp.to_string(),
        level: Level::Error,
        source: t!("UI").to_string(),
        title: t!("Lattice UI crashed").to_string(),
        detail: app_log::redact(detail),
        context: None,
    };
    let folder = state.join("logs");
    if std::fs::create_dir_all(&folder).is_err() {
        return;
    }
    if let (Ok(line), Ok(mut file)) = (
        serde_json::to_string(&entry),
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(folder.join("lattice.log")),
    ) {
        writeln!(file, "{line}").ok();
    }
}

/// Write every open edit, as a save writes it (merging with an outside edit
/// since the last save), until `deadline`: the documents written, and the
/// ones that were not.
fn save_open_edits(deadline: Instant) -> (Vec<String>, Vec<String>) {
    // The main thread may have been inside `note` when it panicked: then the
    // lock is its own and never comes free, and nothing is written.
    let edits = match OPEN_EDITS.try_lock() {
        Ok(edits) => edits,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return (Vec::new(), Vec::new()),
    };
    let mut saved = Vec::new();
    let mut failed = Vec::new();
    let mut edits: Vec<&OpenEdit> = edits.values().collect();
    edits.sort_by(|a, b| (&a.root, &a.relative).cmp(&(&b.root, &b.relative)));
    for edit in edits {
        if Instant::now() >= deadline {
            failed.push(edit.relative.clone());
            continue;
        }
        let text = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (edit.text)()));
        let written = text.ok().filter(|text| *text != edit.base).map(|text| {
            lattice_core::project::apply_editor_transaction(
                &edit.root,
                edit.relative.clone(),
                text,
                Some(edit.base.clone()),
                None,
            )
        });
        match written {
            None => {}
            Some(Ok(_)) => saved.push(edit.relative.clone()),
            Some(Err(error)) => {
                log::error!(target: "lattice::panic", "could not save {}: {error}", edit.relative);
                failed.push(edit.relative.clone());
            }
        }
    }
    (saved, failed)
}

/// The editors whose release forgets their edits.
static WATCHED: LazyLock<Mutex<std::collections::HashSet<EntityId>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// `editor`'s buffer changed, or was saved: [`note`] it, and forget it when
/// the editor goes.
pub fn note_editor(
    editor: &crate::editor_panel::EditorPanel,
    cx: &mut gpui::Context<crate::editor_panel::EditorPanel>,
) {
    let id = cx.entity_id();
    let root = editor.project_root(cx);
    let buffer = editor.editor().read(cx).buffer().read(cx).as_singleton();
    let Some(buffer) = buffer else {
        return;
    };
    note(
        id,
        &root,
        editor.relative(),
        buffer.read(cx),
        editor.saved_text(),
    );
    let first = WATCHED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(id);
    if first {
        cx.on_release(move |_, _| {
            forget(id);
            WATCHED
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id);
        })
        .detach();
    }
}

/// The documents a crash would write now, for a scenario.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn open_edit_paths() -> Vec<String> {
    let edits = OPEN_EDITS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut paths: Vec<String> = edits.values().map(|edit| edit.relative.clone()).collect();
    paths.sort();
    paths
}

/// Run the crash save as the panic hook runs it, without a crash, for a
/// scenario: the documents written, and the ones that were not.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn save_open_edits_now() -> (Vec<String>, Vec<String>) {
    save_open_edits(Instant::now() + CRASH_SAVE_TIMEOUT)
}

/// An editor's text changed (or was saved): keep what a crash would write,
/// or forget it once the buffer is clean.
pub fn note(editor: EntityId, root: &Path, relative: &str, buffer: &language::Buffer, base: &str) {
    let mut edits = OPEN_EDITS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !buffer.is_dirty() {
        edits.remove(&editor);
        return;
    }
    let rope = buffer.as_rope().clone();
    let base = match edits.remove(&editor) {
        // The base changes only on a save or a load; the copy is kept.
        Some(kept) if kept.base == base && kept.relative == relative => kept.base,
        _ => base.to_string(),
    };
    edits.insert(
        editor,
        OpenEdit {
            root: root.to_path_buf(),
            relative: relative.to_string(),
            text: Box::new(move || rope.to_string()),
            base,
        },
    );
}

/// The editor closed: nothing of its is left to write.
pub fn forget(editor: EntityId) {
    OPEN_EDITS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&editor);
}

/// The note a crash left in `state`, taken so it is told once.
pub fn take_note(state: &Path) -> Option<CrashNote> {
    let path = state.join(NOTE_FILE);
    let text = std::fs::read_to_string(&path).ok()?;
    std::fs::remove_file(&path).ok();
    serde_json::from_str(&text).ok()
}

/// What the notice after a crash says about the open edits.
pub fn saved_summary(note: &CrashNote) -> String {
    match (note.saved.len(), note.failed.len()) {
        (_, 0) => t!("Your project files are safe").to_string(),
        (_, failed) => t!(
            "{count} documents could not be saved before Lattice quit: {paths}",
            count = failed,
            paths = note.failed.join(", ")
        ),
    }
}

/// On the launch after a crash: put the panic in the app's log (its file
/// has it already; Settings › Logs lists what the log keeps) and say what
/// happened, with the error's details to copy and Report a Problem….
pub fn announce_previous_crash(cx: &mut App) {
    let Some(note) = PLACES
        .get()
        .and_then(|places| places.state.as_deref())
        .and_then(take_note)
    else {
        return;
    };
    show_crash_notice(note, cx);
}

pub fn show_crash_notice(note: CrashNote, cx: &mut App) {
    let details = note.detail.clone();
    app_log::global(cx).update(cx, |log, cx| {
        log.add_written(
            NewEntry {
                level: Level::Error,
                source: t!("UI").to_string(),
                title: t!("Lattice UI crashed").to_string(),
                detail: note.detail.clone(),
                context: None,
            },
            cx,
        );
    });
    notices::show(
        Notice::new(
            if note.failed.is_empty() {
                ToastLevel::Warning
            } else {
                ToastLevel::Error
            },
            t!("Lattice quit unexpectedly"),
        )
        .source(t!("UI"))
        .detail(saved_summary(&note))
        .key("lattice-crash")
        .persistent()
        .action(NoticeAction::new(t!("Copy error details"), move |_, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(details.clone()));
            notices::dismiss("lattice-crash", cx);
        }))
        .action(NoticeAction::new(t!("Report a problem"), |_, cx| {
            notices::dismiss("lattice-crash", cx);
            crate::help::report::report_problem(cx);
        })),
        cx,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_is_read_once() {
        let state = tempfile::tempdir().unwrap();
        let note = CrashNote {
            timestamp: "2026-11-14T01:02:03.004Z".into(),
            detail: "panicked at src/shell.rs:1:1:\nboom".into(),
            saved: vec!["main.tex".into()],
            failed: Vec::new(),
        };
        std::fs::write(
            state.path().join(NOTE_FILE),
            serde_json::to_string(&note).unwrap(),
        )
        .unwrap();
        assert_eq!(take_note(state.path()), Some(note));
        assert_eq!(take_note(state.path()), None);
    }

    #[test]
    fn the_summary_names_what_could_not_be_saved() {
        let mut note = CrashNote {
            timestamp: String::new(),
            detail: String::new(),
            saved: vec!["main.tex".into()],
            failed: Vec::new(),
        };
        assert_eq!(saved_summary(&note), "Your project files are safe");
        note.failed = vec!["a.tex".into(), "b.tex".into()];
        assert_eq!(
            saved_summary(&note),
            "2 documents could not be saved before Lattice quit: a.tex, b.tex"
        );
    }

    #[test]
    fn a_crash_save_writes_only_unsaved_text_and_merges_with_the_disk() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("main.tex"), "one\ntwo\n").unwrap();
        std::fs::write(project.path().join("clean.tex"), "same\n").unwrap();
        let mut edits = OPEN_EDITS.lock().unwrap();
        edits.clear();
        let id = |n: u64| EntityId::from(n);
        edits.insert(
            id(1),
            OpenEdit {
                root: project.path().into(),
                relative: "main.tex".into(),
                text: Box::new(|| "one\ntwo\nthree\n".into()),
                base: "one\ntwo\n".into(),
            },
        );
        edits.insert(
            id(2),
            OpenEdit {
                root: project.path().into(),
                relative: "clean.tex".into(),
                text: Box::new(|| "same\n".into()),
                base: "same\n".into(),
            },
        );
        drop(edits);
        let (saved, failed) = save_open_edits(Instant::now() + CRASH_SAVE_TIMEOUT);
        assert_eq!(saved, vec!["main.tex".to_string()]);
        assert!(failed.is_empty());
        assert_eq!(
            std::fs::read_to_string(project.path().join("main.tex")).unwrap(),
            "one\ntwo\nthree\n"
        );
        let (_, failed) = save_open_edits(Instant::now());
        assert_eq!(failed.len(), 2, "past the deadline nothing more is written");
        OPEN_EDITS.lock().unwrap().clear();
    }
}
