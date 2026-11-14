//! The app's own warnings and errors in its log, as the Tauri app routes its
//! page's uncaught errors and `console.error`/`console.warn` there
//! (`src/telemetry/global-error-capture.ts`): every `log::error!`, and the
//! `log::warn!` of Lattice's own crates, reach Settings › Logs and the log
//! file, not only stderr. A worker thread's panic arrives the same way, from
//! the panic hook (`crate::crash`).
//!
//! A record can be logged on any thread, and the log is the main thread's,
//! so records wait in a channel the main thread drains. A record the
//! drain itself causes (the log logging) is dropped instead of looping, and
//! one logged again updates its entry rather than adding a copy, so a
//! warning in a loop is one entry.

use std::{
    cell::Cell,
    sync::{LazyLock, Mutex},
};

use futures::{
    StreamExt as _,
    channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded},
};
use gpui::App;
use lattice_i18n::t;

use super::{Level, NewEntry};

/// One record on its way to the log.
#[derive(Debug, PartialEq)]
pub struct Captured {
    pub level: Level,
    pub target: String,
    pub message: String,
}

type Channel = (
    UnboundedSender<Captured>,
    Mutex<Option<UnboundedReceiver<Captured>>>,
);

static CHANNEL: LazyLock<Channel> = LazyLock::new(|| {
    let (sender, receiver) = unbounded();
    (sender, Mutex::new(Some(receiver)))
});

thread_local! {
    /// Set while the drain logs, so the log's own records are not captured.
    static DRAINING: Cell<bool> = const { Cell::new(false) };
}

/// The longest title an entry takes from a record's first line.
const TITLE_CHARS: usize = 120;

/// Whether a record at `level` from `target` goes to the app's log: every
/// error, and the warnings of Lattice's own crates. The editor's and GPUI's
/// warnings are about Zed's own setup (a keymap entry naming an action this
/// app leaves out) and would bury the app's.
pub fn wanted(level: log::Level, target: &str) -> bool {
    match level {
        log::Level::Error => true,
        log::Level::Warn => target.starts_with("lattice") || target.starts_with("trellis"),
        _ => false,
    }
}

/// Hand a record to the log, from any thread.
pub fn capture(record: &log::Record) {
    if !wanted(record.level(), record.target()) || DRAINING.with(Cell::get) {
        return;
    }
    let level = match record.level() {
        log::Level::Error => Level::Error,
        _ => Level::Warning,
    };
    CHANNEL
        .0
        .unbounded_send(Captured {
            level,
            target: record.target().to_string(),
            message: record.args().to_string(),
        })
        .ok();
}

/// The entry a record makes: its first line as the title (clipped), the
/// whole record and where it came from as the detail.
pub fn entry(captured: &Captured) -> NewEntry {
    let first = captured.message.lines().next().unwrap_or_default().trim();
    let mut title: String = first.chars().take(TITLE_CHARS).collect();
    if first.chars().count() > TITLE_CHARS {
        title.push('…');
    }
    if title.is_empty() {
        title = t!("Unexpected error").to_string();
    }
    NewEntry {
        level: captured.level,
        source: t!("App").to_string(),
        title,
        detail: format!("{}\n{}", captured.message.trim(), captured.target),
        context: None,
    }
}

/// Start draining the records into the app's log; the ones logged before
/// it were kept.
pub fn install(cx: &mut App) {
    let Some(mut receiver) = CHANNEL
        .1
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    else {
        return;
    };
    cx.spawn(async move |cx| {
        while let Some(captured) = receiver.next().await {
            cx.update(|cx| {
                DRAINING.with(|draining| draining.set(true));
                let key = format!("captured:{}:{}", captured.target, captured.message);
                let log = super::global(cx);
                // A repeat updates its entry, moved to the front, as the
                // Tauri app collapses repeats by source and title.
                log.update(cx, |log, cx| {
                    log.add(entry(&captured), Some(&key), true, cx);
                });
                DRAINING.with(|draining| draining.set(false));
            });
        }
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_and_lattices_warnings_are_captured() {
        assert!(wanted(log::Level::Error, "editor"));
        assert!(wanted(log::Level::Warn, "lattice_gpui::shell"));
        assert!(wanted(log::Level::Warn, "lattice::panic"));
        assert!(!wanted(log::Level::Warn, "gpui::keymap"));
        assert!(!wanted(log::Level::Info, "lattice_gpui"));
    }

    #[test]
    fn an_entry_takes_its_title_from_the_first_line() {
        let captured = Captured {
            level: Level::Error,
            target: "lattice_gpui::shell".into(),
            message: "could not open the window\ncaused by: nope".into(),
        };
        let entry = entry(&captured);
        assert_eq!(entry.title, "could not open the window");
        assert_eq!(entry.source, "App");
        assert!(entry.detail.ends_with("lattice_gpui::shell"));
        let long = Captured {
            message: "x".repeat(200),
            ..captured
        };
        assert_eq!(super::entry(&long).title.chars().count(), TITLE_CHARS + 1);
    }
}
