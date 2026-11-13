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

use lattice_i18n::t;

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
    /// A Zotero paper's PDF attachment and annotations, and the paper
    /// Papers already holds of it.
    pub zotero: Option<ZoteroExtras>,
}

#[derive(Clone, Debug, Default)]
pub struct ZoteroExtras {
    /// Its PDF attachment's item key.
    pub pdf: Option<String>,
    /// The citation key of the paper Papers holds: nothing is imported, it
    /// only gains what it lacks.
    pub existing: Option<String>,
    /// Its Zotero item key, when its PDFs hold annotations.
    pub annotations: Option<String>,
    /// The library's folder, when the writer chose it.
    pub data_dir: Option<String>,
}

/// What the Zotero part of an import came to.
struct ZoteroOutcome {
    /// Where the annotations went, or why they could not be added.
    note: Option<String>,
    /// The PDF was attached (the full text the import lacked is there now),
    /// or why it could not be: that stands in for the import's own fetch
    /// error, as `use-reference-import.ts` has it.
    attached: Option<Result<(), String>>,
}

/// Attach a Zotero paper's PDF when Papers has none of it, and add its
/// annotations to its note (`use-reference-import.ts` `addPapers`). The
/// citation stands either way, so what fails here is the row's note.
type Annotations = std::collections::HashMap<String, Vec<lattice_core::zotero::ZoteroAnnotation>>;

fn bring_from_zotero<'a>(
    root: &std::path::Path,
    key: &str,
    extras: &ZoteroExtras,
    fresh_without_text: bool,
    annotations: impl Fn() -> Result<&'a Annotations, String>,
    labels: &super::zotero::notes::Labels,
    words: &ZoteroWords,
) -> ZoteroOutcome {
    let paper_of = || {
        core_papers::list_papers(root).ok().and_then(|papers| {
            papers.into_iter().find(|paper| {
                paper
                    .citation_key
                    .as_deref()
                    .is_some_and(|own| own.eq_ignore_ascii_case(key))
            })
        })
    };
    let mut outcome = ZoteroOutcome {
        note: None,
        attached: None,
    };
    if let Some(pdf) = &extras.pdf {
        let needs = if extras.existing.is_some() {
            paper_of().is_some_and(|paper| super::model::keeps_no_pdf(&paper))
        } else {
            fresh_without_text
        };
        if needs {
            outcome.attached = Some(
                lattice_core::zotero::attachment_path(pdf)
                    .and_then(|path| core_papers::attach_pdf_file(root, key, &path))
                    .map(|_| ()),
            );
        }
    }
    let Some(item) = &extras.annotations else {
        return outcome;
    };
    let added = annotations().and_then(|read| {
        let list = read.get(item).map(Vec::as_slice).unwrap_or(&[]);
        if list.is_empty() {
            return Ok(None);
        }
        let Some(paper) = paper_of() else {
            return Ok(None);
        };
        super::zotero::notes::add_annotations(root, &paper, list, labels).map(Some)
    });
    outcome.note = match added {
        Ok(None) => None,
        Ok(Some((path, 0))) => Some(words.already.replace("{path}", &path)),
        Ok(Some((path, 1))) => Some(words.one.replace("{path}", &path)),
        Ok(Some((path, added))) => Some(
            words
                .many
                .replace("{added}", &added.to_string())
                .replace("{path}", &path),
        ),
        Err(problem) => Some(words.failed.replace("{problem}", &problem)),
    };
    outcome
}

/// The notes a Zotero import leaves on its row, in the interface language.
#[derive(Clone)]
struct ZoteroWords {
    already: String,
    one: String,
    many: String,
    failed: String,
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
        .rfind(|line| !line.trim().is_empty())
        .map(|line| line.trim_start_matches("Error:").trim().to_string())
}

impl PapersPanel {
    /// Import `requests` one at a time; nothing starts while an import (the
    /// box's or another batch) holds the pipeline. False when it did not
    /// start.
    pub(crate) fn run_batch(
        &mut self,
        requests: Vec<BatchRequest>,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.batch.running || self.importing.is_some() || requests.is_empty() {
            return false;
        }
        let Some(root) = self.root.clone() else {
            return false;
        };
        let stop = Arc::new(AtomicBool::new(false));
        // One read of Zotero's annotations for the whole batch, made when the
        // first paper with some needs it; every item comes from one library.
        let wanted: Vec<String> = requests
            .iter()
            .filter_map(|request| request.zotero.as_ref()?.annotations.clone())
            .collect();
        let data_dir = requests
            .iter()
            .find_map(|request| request.zotero.as_ref()?.data_dir.clone());
        let annotations_read: Arc<std::sync::OnceLock<Result<Annotations, String>>> =
            Arc::new(std::sync::OnceLock::new());
        let labels = super::zotero::notes::Labels {
            heading: t!("Zotero annotations").to_string(),
            page: t!("p. {page}").to_string(),
        };
        let words = ZoteroWords {
            already: t!("Annotations already in {path}").to_string(),
            one: t!("1 annotation in {path}").to_string(),
            many: t!("{added} annotations in {path}").to_string(),
            failed: t!("Could not add the annotations: {problem}").to_string(),
        };
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
                let zotero = request.zotero.clone();
                let (wanted, data_dir, read) =
                    (wanted.clone(), data_dir.clone(), annotations_read.clone());
                let (labels, words) = (labels.clone(), words.clone());
                let result = cx
                    .background_spawn(async move {
                        let cancel = AtomicBool::new(false);
                        // A paper Papers holds is not imported again.
                        let imported =
                            match zotero.as_ref().and_then(|extras| extras.existing.clone()) {
                                Some(key) => Ok(core_papers::ImportResult {
                                    arxiv_id: String::new(),
                                    title: String::new(),
                                    paper_path: String::new(),
                                    citation_key: Some(key),
                                    citation_output: String::new(),
                                    already_imported: true,
                                    fetch_error: None,
                                    cancelled: false,
                                }),
                                None => core_papers::import_reference(
                                    &root,
                                    &input,
                                    HistoryMode::Record,
                                    core_papers::FullText::Save,
                                    &|_| {},
                                    &cancel,
                                ),
                            };
                        let (Ok(mut imported), Some(extras)) = (imported.clone(), zotero) else {
                            return imported.map(|imported| (imported, None));
                        };
                        let Some(key) = imported
                            .citation_key
                            .clone()
                            .filter(|_| !imported.cancelled)
                        else {
                            return Ok((imported, None));
                        };
                        let fresh_without_text =
                            !imported.already_imported && imported.paper_path.is_empty();
                        let annotations = || {
                            read.get_or_init(|| {
                                lattice_core::zotero::annotations(data_dir.as_deref(), &wanted)
                            })
                            .as_ref()
                            .map_err(Clone::clone)
                        };
                        let outcome = bring_from_zotero(
                            &root,
                            &key,
                            &extras,
                            fresh_without_text,
                            annotations,
                            &labels,
                            &words,
                        );
                        if let Some(attached) = outcome.attached {
                            imported.fetch_error = attached.err();
                        }
                        Ok((imported, outcome.note))
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
                        Ok((imported, _))
                            if imported.cancelled && imported.citation_key.is_none() =>
                        {
                            item.state = ItemState::Cancelled;
                        }
                        Ok((imported, zotero_note)) => {
                            item.state = ItemState::Added;
                            // What failed first, then where the annotations
                            // went: neither hides the other.
                            let notes: Vec<String> = [
                                imported.fetch_error.as_deref().and_then(failure_line),
                                zotero_note,
                            ]
                            .into_iter()
                            .flatten()
                            .collect();
                            item.note = (!notes.is_empty()).then(|| notes.join(" · "));
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
        true
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
