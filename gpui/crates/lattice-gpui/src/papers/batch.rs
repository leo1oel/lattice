//! Add papers' batch (`add-papers-queue.ts`), kept by the Papers panel so it
//! outlives the sheet: the writer can close it and keep writing while the
//! rest arrive. Papers import one after another through lattice-core's
//! `import_reference`; Stop lets the paper being imported finish and adds
//! none of the rest. A batch whose project closed is dropped.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use gpui::{AppContext as _, Context, Task};
use lattice_core::papers::{self as core_papers, HistoryMode};

use super::PapersPanel;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemState {
    Waiting,
    Adding,
    Added,
    Failed,
    Cancelled,
}

/// One paper in the batch, as it moves through the import.
#[derive(Clone, Debug)]
pub struct BatchItem {
    pub id: String,
    /// What the import is given: an identifier, a resolved record's BibTeX,
    /// or a pasted entry.
    pub input: String,
    /// What its row names it by.
    pub label: String,
    pub state: ItemState,
    pub citation_key: Option<String>,
    /// Why it failed, or what was added without its full text.
    pub note: Option<String>,
}

/// What a batch is given for each paper.
#[derive(Clone, Debug)]
pub struct BatchRequest {
    pub id: String,
    pub input: String,
    pub label: String,
}

#[derive(Default)]
pub struct Batch {
    pub items: Vec<BatchItem>,
    pub running: bool,
    stop: Option<Arc<AtomicBool>>,
    _task: Option<Task<()>>,
}

impl Batch {
    pub fn adding(&self) -> bool {
        self.items
            .iter()
            .any(|item| matches!(item.state, ItemState::Waiting | ItemState::Adding))
    }
}

/// The converter's stderr ends with its one meaningful "Error: …" line.
fn failure_line(error: &str) -> Option<String> {
    error
        .trim()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .last()
        .map(|line| line.trim_start_matches("Error:").trim().to_string())
}

impl PapersPanel {
    /// Import `requests` one at a time; nothing starts while an import (the
    /// box's or another batch) holds the pipeline.
    pub(crate) fn run_batch(&mut self, requests: Vec<BatchRequest>, cx: &mut Context<Self>) {
        if self.batch.running || self.importing.is_some() || requests.is_empty() {
            return;
        }
        let Some(root) = self.root.clone() else {
            return;
        };
        let stop = Arc::new(AtomicBool::new(false));
        self.batch.items = requests
            .iter()
            .map(|request| BatchItem {
                id: request.id.clone(),
                input: request.input.clone(),
                label: request.label.clone(),
                state: ItemState::Waiting,
                citation_key: None,
                note: None,
            })
            .collect();
        self.batch.running = true;
        self.batch.stop = Some(stop.clone());
        let started_in = root.clone();
        self.batch._task = Some(cx.spawn(async move |this, cx| {
            for request in requests {
                let current = this
                    .update(cx, |this, _| {
                        this.root.as_deref() == Some(started_in.as_path())
                    })
                    .unwrap_or(false);
                // The project it was adding to closed: its rows belong to no
                // open sheet. Drop them.
                if !current {
                    this.update(cx, |this, cx| {
                        this.batch = Batch::default();
                        cx.notify();
                    })
                    .ok();
                    return;
                }
                let stopped = stop.load(Ordering::Acquire);
                this.update(cx, |this, cx| {
                    if let Some(item) = this
                        .batch
                        .items
                        .iter_mut()
                        .find(|item| item.id == request.id)
                    {
                        item.state = if stopped {
                            ItemState::Cancelled
                        } else {
                            ItemState::Adding
                        };
                    }
                    cx.notify();
                })
                .ok();
                if stopped {
                    continue;
                }
                // Stop lets this paper finish: its import is never cancelled.
                let (root, input) = (root.clone(), request.input.clone());
                let cancel = AtomicBool::new(false);
                let result = cx
                    .background_spawn(async move {
                        core_papers::import_reference(
                            &root,
                            &input,
                            HistoryMode::Record,
                            &|_| {},
                            &cancel,
                        )
                    })
                    .await;
                this.update(cx, |this, cx| {
                    let Some(item) = this
                        .batch
                        .items
                        .iter_mut()
                        .find(|item| item.id == request.id)
                    else {
                        return;
                    };
                    match result {
                        Ok(imported) if imported.cancelled && imported.citation_key.is_none() => {
                            item.state = ItemState::Cancelled;
                        }
                        Ok(imported) => {
                            item.state = ItemState::Added;
                            item.note = imported.fetch_error.as_deref().and_then(failure_line);
                            if let Some(key) = &imported.citation_key {
                                this.just_added.insert(key.clone());
                            }
                            item.citation_key = imported.citation_key;
                        }
                        Err(error) => {
                            item.state = ItemState::Failed;
                            item.note = Some(error);
                        }
                    }
                    this.reload(cx);
                    cx.notify();
                })
                .ok();
            }
            this.update(cx, |this, cx| {
                this.batch.running = false;
                this.batch.stop = None;
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Stop the batch after the paper being imported; the rest are not
    /// added.
    pub(crate) fn stop_batch(&mut self, cx: &mut Context<Self>) {
        if let Some(stop) = &self.batch.stop {
            stop.store(true, Ordering::Release);
        }
        cx.notify();
    }

    /// Forget a finished batch; one still running keeps its rows for the
    /// next opening.
    pub(crate) fn clear_batch(&mut self, cx: &mut Context<Self>) {
        if !self.batch.running {
            self.batch.items.clear();
            cx.notify();
        }
    }
}
