//! Add papers' batch (`add-papers-queue.ts`), kept by the Papers panel so it
//! outlives the sheet: the writer can close it and keep writing while the
//! rest arrive. Papers import four at a time through lattice-core's
//! `import_reference`, each committing as it resolves; Stop lets the papers
//! under way finish and adds none of the rest, and a failed one can be
//! tried again. A batch whose project closed is dropped.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, atomic::AtomicBool},
};

use gpui::{AppContext as _, Context, Task};
use lattice_core::papers::{self as core_papers, HistoryMode};

use lattice_i18n::t;

use super::{PapersPanel, model::ReferenceKind};

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
    /// What its row names it by, the kind its chip reads and its byline,
    /// as the card showed them when the batch started.
    pub label: String,
    pub kind: ReferenceKind,
    pub byline: String,
    pub state: ItemState,
    pub citation_key: Option<String>,
    /// The title the import found, and whether Papers held it already.
    pub title: Option<String>,
    pub already_imported: bool,
    /// Why it failed, or what was added without its full text.
    pub note: Option<String>,
}

/// What a batch is given for each paper.
#[derive(Clone, Debug)]
pub struct BatchRequest {
    pub id: String,
    pub input: String,
    pub label: String,
    pub kind: ReferenceKind,
    pub byline: String,
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

/// What every paper of a running batch is imported with: a failed one is
/// tried again with the same.
struct Run {
    root: std::path::PathBuf,
    wanted: Vec<String>,
    data_dir: Option<String>,
    annotations: Arc<std::sync::OnceLock<Result<Annotations, String>>>,
    labels: super::zotero::notes::Labels,
    words: ZoteroWords,
}

/// How many papers import at once: enough to hide each lookup's latency,
/// few enough not to flood the services (`ADDS_AT_ONCE`).
const ADDS_AT_ONCE: usize = 4;

#[derive(Default)]
pub struct Batch {
    pub items: Vec<BatchItem>,
    /// Papers waiting or under way.
    pub running: bool,
    run: Option<Arc<Run>>,
    requests: HashMap<String, BatchRequest>,
    pending: VecDeque<String>,
    tasks: HashMap<String, Task<()>>,
}

impl Batch {
    pub fn adding(&self) -> bool {
        self.items
            .iter()
            .any(|item| matches!(item.state, ItemState::Waiting | ItemState::Adding))
    }

    fn item(&mut self, id: &str) -> Option<&mut BatchItem> {
        self.items.iter_mut().find(|item| item.id == id)
    }
}

/// The converter's stderr ends with its one meaningful "Error: …" line.
pub(super) fn failure_line(error: &str) -> Option<String> {
    error
        .trim()
        .lines()
        .rfind(|line| !line.trim().is_empty())
        .map(|line| line.trim_start_matches("Error:").trim().to_string())
}

/// One paper's import, and where its Zotero annotations went.
fn import_one(
    run: &Run,
    request: &BatchRequest,
) -> Result<(core_papers::ImportResult, Option<String>), String> {
    let cancel = AtomicBool::new(false);
    // A paper Papers holds is not imported again.
    let imported = match request
        .zotero
        .as_ref()
        .and_then(|extras| extras.existing.clone())
    {
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
            &run.root,
            &request.input,
            HistoryMode::Record,
            core_papers::FullText::Save,
            &|_| {},
            &cancel,
        ),
    };
    let (Ok(mut imported), Some(extras)) = (imported.clone(), request.zotero.as_ref()) else {
        return imported.map(|imported| (imported, None));
    };
    let Some(key) = imported
        .citation_key
        .clone()
        .filter(|_| !imported.cancelled)
    else {
        return Ok((imported, None));
    };
    let fresh_without_text = !imported.already_imported && imported.paper_path.is_empty();
    let annotations = || {
        run.annotations
            .get_or_init(|| lattice_core::zotero::annotations(run.data_dir.as_deref(), &run.wanted))
            .as_ref()
            .map_err(Clone::clone)
    };
    let outcome = bring_from_zotero(
        &run.root,
        &key,
        extras,
        fresh_without_text,
        annotations,
        &run.labels,
        &run.words,
    );
    if let Some(attached) = outcome.attached {
        imported.fetch_error = attached.err();
    }
    Ok((imported, outcome.note))
}

impl PapersPanel {
    /// Import `requests`, a few at a time, each committing as it resolves;
    /// nothing starts while an import (the box's or another batch) holds the
    /// pipeline. False when it did not start.
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
        // One read of Zotero's annotations for the whole batch, made when the
        // first paper with some needs it; every item comes from one library.
        let wanted: Vec<String> = requests
            .iter()
            .filter_map(|request| request.zotero.as_ref()?.annotations.clone())
            .collect();
        let data_dir = requests
            .iter()
            .find_map(|request| request.zotero.as_ref()?.data_dir.clone());
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
        self.just_added.clear();
        self.batch = Batch {
            items: requests
                .iter()
                .map(|request| BatchItem {
                    id: request.id.clone(),
                    input: request.input.clone(),
                    label: request.label.clone(),
                    kind: request.kind,
                    byline: request.byline.clone(),
                    state: ItemState::Waiting,
                    citation_key: None,
                    title: None,
                    already_imported: false,
                    note: None,
                })
                .collect(),
            running: true,
            run: Some(Arc::new(Run {
                root,
                wanted,
                data_dir,
                annotations: Arc::default(),
                labels,
                words,
            })),
            pending: requests.iter().map(|request| request.id.clone()).collect(),
            requests: requests
                .into_iter()
                .map(|request| (request.id.clone(), request))
                .collect(),
            tasks: HashMap::new(),
        };
        self.pump(cx);
        true
    }

    /// Start waiting papers while there is room; a batch whose project
    /// closed is dropped, its rows belonging to no open sheet.
    fn pump(&mut self, cx: &mut Context<Self>) {
        let Some(run) = self.batch.run.clone() else {
            return;
        };
        if self.root.as_deref() != Some(run.root.as_path()) {
            self.batch = Batch::default();
            cx.notify();
            return;
        }
        while self.batch.tasks.len() < ADDS_AT_ONCE {
            let Some(id) = self.batch.pending.pop_front() else {
                break;
            };
            let Some(request) = self.batch.requests.get(&id).cloned() else {
                continue;
            };
            if let Some(item) = self.batch.item(&id) {
                item.state = ItemState::Adding;
                item.note = None;
            }
            let job_run = run.clone();
            let job = cx.background_spawn(async move { import_one(&job_run, &request) });
            let (task_id, task_run) = (id.clone(), run.clone());
            let task = cx.spawn(async move |this, cx| {
                let result = job.await;
                this.update(cx, |this, cx| {
                    if !this
                        .batch
                        .run
                        .as_ref()
                        .is_some_and(|run| Arc::ptr_eq(run, &task_run))
                    {
                        return;
                    }
                    this.batch.tasks.remove(&task_id);
                    this.settle_item(&task_id, result);
                    this.reload(cx);
                    this.pump(cx);
                })
                .ok();
            });
            self.batch.tasks.insert(id, task);
        }
        self.batch.running = !self.batch.tasks.is_empty() || !self.batch.pending.is_empty();
        cx.notify();
    }

    fn settle_item(
        &mut self,
        id: &str,
        result: Result<(core_papers::ImportResult, Option<String>), String>,
    ) {
        let Some(item) = self.batch.items.iter_mut().find(|item| item.id == id) else {
            return;
        };
        match result {
            Ok((imported, _)) if imported.cancelled && imported.citation_key.is_none() => {
                item.state = ItemState::Cancelled;
            }
            Ok((imported, zotero_note)) => {
                item.state = ItemState::Added;
                item.title = Some(imported.title.clone()).filter(|title| !title.trim().is_empty());
                item.already_imported = imported.already_imported;
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
                if !imported.already_imported {
                    if let Some(key) = &imported.citation_key {
                        self.just_added.insert(key.clone());
                    }
                    if !imported.arxiv_id.is_empty() {
                        self.just_added.insert(imported.arxiv_id.clone());
                    }
                }
                item.citation_key = imported.citation_key;
            }
            Err(error) => {
                item.state = ItemState::Failed;
                item.note = Some(error);
            }
        }
    }

    /// Stop the batch: the papers under way finish, none of the rest are
    /// added.
    pub(crate) fn stop_batch(&mut self, cx: &mut Context<Self>) {
        for id in std::mem::take(&mut self.batch.pending) {
            if let Some(item) = self.batch.item(&id) {
                item.state = ItemState::Cancelled;
            }
        }
        self.batch.running = !self.batch.tasks.is_empty();
        cx.notify();
    }

    /// Try a failed paper of the batch again, with what the batch ran with
    /// (`retryAddItem`).
    pub(crate) fn retry_batch_item(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.batch.run.is_none() || self.batch.pending.iter().any(|waiting| waiting == id) {
            return;
        }
        let Some(item) = self
            .batch
            .item(id)
            .filter(|item| item.state == ItemState::Failed)
        else {
            return;
        };
        item.state = ItemState::Waiting;
        item.note = None;
        self.batch.pending.push_back(id.to_string());
        self.pump(cx);
    }

    /// Forget a finished batch; one still running keeps its rows for the
    /// next opening.
    pub(crate) fn clear_batch(&mut self, cx: &mut Context<Self>) {
        if !self.batch.running {
            self.batch = Batch::default();
            cx.notify();
        }
    }
}
