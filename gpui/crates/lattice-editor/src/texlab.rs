//! The project's TexLab language server, on `lattice-core`'s pool: the same
//! process management, start-failure classification and diagnostics mapping
//! the Tauri app's `texlab_diagnostics` command runs.
//!
//! TexLab keeps one document open, the one last synced, and publishes its
//! diagnostics whenever it likes: after a change, and later on its own (a
//! build's log, ChkTeX). `lattice-core` delivers them on TexLab's reader
//! thread; they come back here as [`TexlabEvent::Diagnostics`] for the
//! document they name. Syncing blocks on TexLab (a start takes up to a
//! second and a half), so it runs on the background executor, one at a
//! time: a sync that queues behind another replaces any older one waiting.
//! Dropping the service (closing the project) drops the pool, whose session
//! kills the TexLab process.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{AppContext as _, Context, EventEmitter, Task};
use lattice_core::{models::Diagnostic, texlab::TexlabPool};

/// What TexLab told about a document.
pub enum TexlabEvent {
    /// The diagnostics of `path` (project-relative), replacing any before.
    Diagnostics {
        path: String,
        diagnostics: Vec<Diagnostic>,
    },
}

pub struct TexlabService {
    root: PathBuf,
    pool: Arc<Mutex<TexlabPool>>,
    published: mpsc::UnboundedSender<(String, Vec<Diagnostic>)>,
    /// The sync to run once the one under way finishes.
    waiting: Option<(String, String)>,
    syncing: Option<Task<()>>,
    _receive: Task<()>,
}

impl EventEmitter<TexlabEvent> for TexlabService {}

impl TexlabService {
    pub fn new(root: PathBuf, cx: &mut Context<Self>) -> Self {
        let (published, mut received) = mpsc::unbounded::<(String, Vec<Diagnostic>)>();
        let receive = cx.spawn(async move |this, cx| {
            while let Some((path, diagnostics)) = received.next().await {
                if this
                    .update(cx, |_, cx| {
                        cx.emit(TexlabEvent::Diagnostics { path, diagnostics })
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            root,
            pool: Arc::default(),
            published,
            waiting: None,
            syncing: None,
            _receive: receive,
        }
    }

    /// Whether TexLab is installed where Lattice looks for it.
    pub fn available() -> bool {
        lattice_core::commands::available("texlab")
    }

    /// Give TexLab `text` as the document at `path` (project-relative), and
    /// have its diagnostics delivered from now on.
    pub fn sync(&mut self, path: String, text: String, cx: &mut Context<Self>) {
        if self.syncing.is_some() {
            self.waiting = Some((path, text));
            return;
        }
        let root = self.root.clone();
        let pool = self.pool.clone();
        let published = self.published.clone();
        self.syncing = Some(cx.spawn(async move |this, cx| {
            let relative = path.clone();
            let result = cx
                .background_spawn(async move {
                    let mut pool = pool
                        .lock()
                        .map_err(|_| "TexLab state is unavailable.".to_string())?;
                    pool.diagnostics(&root, &relative, &text, move |diagnostics| {
                        published.unbounded_send((path.clone(), diagnostics)).ok();
                    })
                })
                .await;
            if let Err(error) = result {
                log::debug!("TexLab did not sync: {error}");
            }
            this.update(cx, |this, cx| {
                this.syncing = None;
                if let Some((path, text)) = this.waiting.take() {
                    this.sync(path, text, cx);
                }
            })
            .ok();
        }));
    }
}
