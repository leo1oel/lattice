//! Revision rounds: asking the agent to revise the passages the writer
//! annotated, and the writer's decision on each proposal, as the Tauri app
//! does (`src/app/annotation-rounds.ts`).
//!
//! A round asks about the annotations `revise` names, each in its own text
//! task (`crate::agent::text_task`), three at a time so one stays free for a
//! proofread: every open one from the panel's Revise, only the new one from
//! a note's Save and revise now; asking again while a round still has
//! proposals waiting adds to that round. Each answer is saved with its
//! annotation as it arrives: a proposal, or the agent's question, which the
//! writer answers in the panel. Proposals are accepted or rejected in the
//! editor (`editor_panel/annotation_review.rs`), and nothing reaches a file
//! until accepted.
//!
//! Every round is a version: it keeps the text of each file it touches from
//! before its first answer, and once no proposal is waiting it settles,
//! keeping their text after it too and recording the round in the project
//! history (lattice-core's `save_annotation_round`).
//!
//! One per window, for its project; the work runs in the background and the
//! surfaces that show it (the panel, the review card) read it.

use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
};

use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Task, WeakEntity};
use lattice_core::{
    models::FileChange,
    project::{self, AnnotationRevision, AnnotationRound, EditorComment},
};
use lattice_editor::annotation_revision::{self as revision, Answer};
use lattice_i18n::t;

use super::{model, store};
use crate::{
    agent::text_task::{self, TextTask},
    editor_panel::EditorPanel,
};

/// Text tasks the agent service runs at once is four; one stays free for a
/// proofread.
const CONCURRENT_REVISIONS: usize = 3;

/// What the rounds read from the window, which the window keeps up to
/// date (`set_host`): the project's folder and its open editors, whose
/// buffers hold a file's live text. Pushed rather than asked for, since the
/// window calls the rounds in its own updates, where it cannot be read.
#[derive(Default)]
pub struct RoundsHost {
    pub project: Option<PathBuf>,
    pub editors: Vec<WeakEntity<EditorPanel>>,
}

/// What the rounds ask of the window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoundsEvent {
    /// Open the annotation's file and its proposal's card under the passage.
    Review(String),
    /// The review ended: its card leaves the editor.
    CloseReview,
    /// Show the Annotations panel.
    OpenPanel,
}

/// Where an accepted proposal now stands in its file, as the editor applied
/// it (UTF-16 offsets, as the file keeps them).
#[derive(Clone, Debug)]
pub struct Accepted {
    pub from: u32,
    pub to: u32,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
}

/// What a retry tells the agent beyond the note.
#[derive(Clone, Debug, Default)]
struct Extra {
    guidance: Option<String>,
    rejected: Option<String>,
}

struct Job {
    root: PathBuf,
    id: String,
    round: u32,
    extra: Extra,
    ticket: u64,
}

pub struct AnnotationRounds {
    host: RoundsHost,
    /// Annotations the agent is answering now, by the ticket of their task.
    running: HashMap<String, u64>,
    tickets: u64,
    queue: VecDeque<Job>,
    active: HashMap<u64, Task<()>>,
    /// Each open round's files from before its first answer.
    baselines: HashMap<u32, BTreeMap<String, Option<String>>>,
    settling: Option<u32>,
    /// The proposal under review in the editor.
    review: Option<String>,
    /// The e2e scenario's stand-in for the agent's replies.
    scripted: Option<String>,
}

impl EventEmitter<RoundsEvent> for AnnotationRounds {}

/// The open round: the last one that has not settled.
fn open_round(rounds: &[AnnotationRound]) -> Option<&AnnotationRound> {
    rounds.last().filter(|round| round.settled_at.is_none())
}

fn state(comment: &EditorComment) -> Option<&str> {
    comment.revision.as_ref().map(|revision| revision.state.as_str())
}

/// A local annotation the agent can be asked about now.
pub fn revisable(comment: &EditorComment, running: &dyn Fn(&str) -> bool) -> bool {
    if comment.number == 0 || comment.resolved || running(&comment.id) {
        return false;
    }
    match comment.revision.as_ref() {
        Some(revision) if revision.state == "proposed" => false,
        // A question waits for its answer.
        Some(revision) if revision.state == "asked" => {
            revision.answer.as_deref().is_some_and(|answer| !answer.trim().is_empty())
        }
        _ => true,
    }
}

/// Proposals still waiting for the writer, in the order the review walks
/// them: by file, then place, then number.
pub fn pending_proposals(annotations: &[&EditorComment]) -> Vec<EditorComment> {
    let mut proposals: Vec<EditorComment> = annotations
        .iter()
        .filter(|comment| !comment.resolved && state(comment) == Some("proposed"))
        .map(|comment| (*comment).clone())
        .collect();
    proposals.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.from.cmp(&right.from))
            .then(left.number.cmp(&right.number))
    });
    proposals
}

/// The open round's progress: its number, how many annotations it asked
/// about, how many are answered and how many still run.
pub fn round_progress(
    rounds: &[AnnotationRound],
    annotations: &[&EditorComment],
    running: &dyn Fn(&str) -> bool,
) -> Option<(u32, usize, usize, usize)> {
    let round = open_round(rounds)?;
    let ids: Vec<&String> = round.outcomes.keys().collect();
    let answered = annotations
        .iter()
        .filter(|comment| {
            ids.contains(&&comment.id)
                && !running(&comment.id)
                && comment.revision.as_ref().is_some_and(|revision| revision.round == round.number)
        })
        .count();
    let still = ids.iter().filter(|id| running(id)).count();
    Some((round.number, ids.len(), answered, still))
}

impl AnnotationRounds {
    pub fn new(host: RoundsHost) -> Self {
        Self {
            host,
            running: HashMap::new(),
            tickets: 0,
            queue: VecDeque::new(),
            active: HashMap::new(),
            baselines: HashMap::new(),
            settling: None,
            review: None,
            scripted: None,
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.running.contains_key(id)
    }

    /// Answer the next asks with `reply` instead of the agent (the e2e
    /// scenario's stand-in).
    pub fn script_reply(&mut self, reply: Option<String>) {
        self.scripted = reply;
    }

    fn root(&self, _: &App) -> Option<PathBuf> {
        self.host.project.clone()
    }

    /// What the window has open now.
    pub fn set_host(&mut self, host: RoundsHost, cx: &mut Context<Self>) {
        let switched = host.project != self.host.project;
        self.host = host;
        if switched {
            self.running.clear();
            self.queue.clear();
            self.active.clear();
            self.baselines.clear();
            self.settling = None;
            self.close_review(cx);
            cx.notify();
        }
    }

    /// `path`'s live text, when an editor has it open.
    fn live_source(&self, path: &str, cx: &App) -> Option<String> {
        self.host
            .editors
            .iter()
            .filter_map(WeakEntity::upgrade)
            .find(|editor| editor.read(cx).relative() == path)
            .map(|editor| editor.read(cx).text(cx))
    }

    fn notes<'a>(root: &Path, cx: &'a App) -> Vec<&'a EditorComment> {
        store::try_store(cx).map_or_else(Vec::new, |store| store.read(cx).annotations(root))
    }

    fn find(root: &Path, id: &str, cx: &App) -> Option<EditorComment> {
        store::try_store(cx)?.read(cx).get(root, id).cloned()
    }

    /// A file's current text: the open buffer when an editor has it, else
    /// the disk.
    fn read_source(&self, root: &Path, path: &str, cx: &App) -> Option<String> {
        self.live_source(path, cx).or_else(|| std::fs::read_to_string(root.join(path)).ok())
    }

    /// Change `id`'s revision and its outcome in its round together.
    fn record(
        &self,
        root: &Path,
        id: &str,
        revision: AnnotationRevision,
        change: impl FnOnce(&mut EditorComment),
        cx: &mut App,
    ) {
        let id = id.to_string();
        let store = store::store(cx);
        store.update(cx, |store, cx| {
            store.commit(
                root,
                move |notes| {
                    let Some(comment) = notes.annotations.iter_mut().find(|item| item.id == id)
                    else {
                        return false;
                    };
                    if let Some(round) = notes.rounds.iter_mut().find(|round| round.number == revision.round) {
                        round.outcomes.insert(id.clone(), revision.state.clone());
                    }
                    change(comment);
                    comment.revision = Some(revision);
                    comment.updated_at = model::now();
                    true
                },
                cx,
            );
        });
    }

    /// The open round, or a new one; `ids` join it.
    fn join_round(root: &Path, ids: &[String], cx: &mut App) -> u32 {
        let mut number = 0;
        let ids = ids.to_vec();
        let store = store::store(cx);
        store.update(cx, |store, cx| {
            store.commit(
                root,
                |notes| {
                    let open = open_round(&notes.rounds).map(|round| round.number);
                    number = open.unwrap_or_else(|| notes.rounds.last().map_or(0, |round| round.number) + 1);
                    if open.is_none() {
                        notes.rounds.push(AnnotationRound {
                            number,
                            started_at: model::now(),
                            settled_at: None,
                            outcomes: BTreeMap::new(),
                            history_id: None,
                        });
                    }
                    let round = notes.rounds.last_mut().expect("the round just found or made");
                    // Present in the round from the start; the answer
                    // replaces it.
                    for id in &ids {
                        round.outcomes.entry(id.clone()).or_insert_with(|| "failed".into());
                    }
                    true
                },
                cx,
            );
        });
        number
    }

    /// Keep `round`'s files from before its first answer, adding `paths` it
    /// had not touched.
    fn keep_baseline(&mut self, root: &Path, round: u32, paths: &[String], cx: &mut Context<Self>) {
        let baseline = self.baselines.entry(round).or_insert_with(|| {
            // A round left open by an earlier session kept its baseline on
            // disk.
            project::read_annotation_round(root, round)
                .unwrap_or_default()
                .into_iter()
                .map(|file| (file.path, file.before))
                .collect()
        });
        let added: Vec<&String> = paths.iter().filter(|path| !baseline.contains_key(*path)).collect();
        if added.is_empty() {
            return;
        }
        for path in added {
            let before = self.read_source(root, path, cx);
            self.baselines.get_mut(&round).expect("kept above").insert(path.clone(), before);
        }
        let files: Vec<FileChange> = self.baselines[&round]
            .iter()
            .map(|(path, before)| FileChange { path: path.clone(), before: before.clone(), after: None })
            .collect();
        let root = root.to_path_buf();
        cx.spawn(async move |_, cx| {
            let saved = cx
                .background_spawn(async move { project::save_annotation_round(&root, round, files, false) })
                .await;
            if let Err(error) = saved {
                cx.update(|cx| crate::notices::error(t!("Annotations"), error, cx));
            }
        })
        .detach();
    }

    /// Settle the open round once nothing in it is running or waiting for
    /// the writer: keep its files' text as it left them, and record it as
    /// one project-history entry.
    fn settle(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let Some(notes) = store::try_store(cx).and_then(|store| store.read(cx).notes(&root).cloned()) else {
            return;
        };
        let Some(round) = open_round(&notes.rounds).cloned() else {
            return;
        };
        if self.settling == Some(round.number) || round.outcomes.keys().any(|id| self.is_running(id)) {
            return;
        }
        let waiting = notes.annotations.iter().any(|comment| {
            round.outcomes.contains_key(&comment.id)
                && !comment.resolved
                && comment
                    .revision
                    .as_ref()
                    .is_some_and(|revision| revision.round == round.number && revision.state == "proposed")
        });
        if waiting {
            return;
        }
        let store = store::store(cx);
        // A round the agent answered nothing in is no version; its notes say
        // why on their cards.
        if round.outcomes.values().all(|outcome| outcome == "failed") {
            self.baselines.remove(&round.number);
            store.update(cx, |store, cx| {
                store.commit(
                    &root,
                    |notes| {
                        notes.rounds.retain(|item| item.number != round.number);
                        true
                    },
                    cx,
                );
            });
            return;
        }
        self.settling = Some(round.number);
        let baseline = self.baselines.remove(&round.number).unwrap_or_else(|| {
            project::read_annotation_round(&root, round.number)
                .unwrap_or_default()
                .into_iter()
                .map(|file| (file.path, file.before))
                .collect()
        });
        let files: Vec<FileChange> = baseline
            .into_iter()
            .map(|(path, before)| {
                let after = self.read_source(&root, &path, cx);
                FileChange { path, before, after }
            })
            .collect();
        let accepted = round.outcomes.values().any(|outcome| outcome == "accepted");
        let number = round.number;
        cx.spawn(async move |this, cx| {
            let written = root.clone();
            let saved = cx
                .background_spawn(async move { project::save_annotation_round(&written, number, files, true) })
                .await;
            this.update(cx, |this, cx| {
                this.settling = None;
                let history = match saved {
                    Ok(history) => history,
                    Err(error) => {
                        crate::notices::error(t!("Annotations"), error, cx);
                        return;
                    }
                };
                store::store(cx).update(cx, |store, cx| {
                    store.commit(
                        &root,
                        |notes| {
                            let Some(item) = notes.rounds.iter_mut().find(|item| item.number == number) else {
                                return false;
                            };
                            item.settled_at = Some(model::now());
                            item.history_id = history.clone();
                            true
                        },
                        cx,
                    );
                });
                if accepted {
                    crate::notices::show(
                        crate::notices::Notice::new(
                            lattice_ui::components::ToastLevel::Info,
                            t!("Annotations"),
                        )
                        .detail(t!("Round {number} is saved as a version", number = number))
                        .key(format!("annotation-round-settled:{number}")),
                        cx,
                    );
                }
            })
            .ok();
        })
        .detach();
    }

    fn failure(error: &text_task::Failure) -> String {
        match error {
            text_task::Failure::Unavailable => t!(
                "This version of the agent runtime cannot revise annotations yet. Update Lattice to use revisions."
            )
            .to_string(),
            text_task::Failure::Failed(detail) if detail.is_empty() => {
                t!("The agent could not revise this passage.").to_string()
            }
            text_task::Failure::Failed(detail) => {
                t!("The agent could not revise this passage: {detail}", detail = detail)
            }
        }
    }

    /// Record that the agent could not answer about `id`, and why.
    fn fail(&self, root: &Path, id: &str, round: u32, error: String, cx: &mut App) {
        let revision = AnnotationRevision {
            round,
            state: "failed".into(),
            original: None,
            text: None,
            reason: None,
            question: None,
            answer: None,
            error: Some(error),
        };
        self.record(root, id, revision, |_| {}, cx);
    }

    /// Ask the agent about one annotation in its round.
    fn ask(&mut self, job: Job, cx: &mut Context<Self>) -> Task<()> {
        let Job { root, id, round, extra, ticket } = job;
        let Some(comment) = Self::find(&root, &id, cx) else {
            return Task::ready(());
        };
        let source = self.read_source(&root, &comment.path, cx);
        let Some((source, range)) = source.and_then(|source| {
            let range = model::anchor_of(&source, &comment)?;
            Some((source, range))
        }) else {
            self.fail(
                &root,
                &id,
                round,
                t!("The annotated text changed or moved. Select it again and annotate it to ask about it.")
                    .to_string(),
                cx,
            );
            return Task::ready(());
        };
        let passage = source[range.clone()].to_string();
        if !revision::within_max_length(&passage) {
            let limit = revision::MAX_LENGTH.to_string();
            self.fail(
                &root,
                &id,
                round,
                t!("Annotate at most {limit} characters for the agent to revise.", limit = limit),
                cx,
            );
            return Task::ready(());
        }
        let intent = comment.intent.as_deref().and_then(revision::Intent::parse);
        let citations = (intent == Some(revision::Intent::Cite)).then(|| {
            project::citations(&root)
                .map(|index| {
                    index
                        .citations
                        .into_iter()
                        .map(|citation| revision::Citation {
                            key: citation.key,
                            title: Some(citation.title).filter(|title| !title.is_empty()),
                        })
                        .collect()
                })
                .unwrap_or_default()
        });
        let previous = comment.revision.clone();
        let (before, after) = revision::context(&source, range.start, range.end);
        let request = revision::Request {
            path: comment.path.clone(),
            line: source[..range.start].matches('\n').count() + 1,
            note: comment.body.clone(),
            intent,
            passage: passage.clone(),
            before,
            after,
            question: previous.as_ref().and_then(|revision| revision.question.clone()),
            answer: previous.as_ref().and_then(|revision| revision.answer.clone()),
            // A proposal turned down earlier is what not to propose again.
            rejected: extra.rejected.or_else(|| {
                previous
                    .as_ref()
                    .filter(|revision| revision.state == "rejected")
                    .and_then(|revision| revision.text.clone())
            }),
            guidance: extra.guidance,
            language: if lattice_i18n::locale().is_chinese() {
                "Simplified Chinese".into()
            } else {
                "English".into()
            },
            citations,
        };
        let prompt = revision::prompt(&request);
        let (task, answer) = match self.scripted.clone() {
            Some(reply) => {
                let timer = cx.background_executor().clone();
                (
                    None,
                    cx.background_executor().spawn(async move {
                        timer.timer(std::time::Duration::from_millis(300)).await;
                        Ok(text_task::Answer { text: reply, model: None })
                    }),
                )
            }
            None => {
                let mut task = TextTask::start(root.clone(), prompt, cx);
                let answer = task.answer();
                (Some(task), answer)
            }
        };
        cx.spawn(async move |this, cx| {
            let answered = answer.await;
            drop(task);
            this.update(cx, |this, cx| {
                // A newer ask for the annotation replaced this one.
                if this.running.get(&id) != Some(&ticket) {
                    return;
                }
                let revision = match answered {
                    Ok(answer) => match revision::parse_answer(&answer.text, &passage) {
                        Some(Answer::Revision { text, reason }) => AnnotationRevision {
                            round,
                            state: "proposed".into(),
                            original: Some(passage.clone()),
                            text: Some(text),
                            reason: Some(reason).filter(|reason| !reason.trim().is_empty()),
                            question: None,
                            answer: None,
                            error: None,
                        },
                        Some(Answer::Question(question)) => AnnotationRevision {
                            round,
                            state: "asked".into(),
                            original: None,
                            text: None,
                            reason: None,
                            question: Some(question),
                            answer: None,
                            error: None,
                        },
                        None => {
                            let error = t!("The agent's reply held neither a revision nor a question.");
                            this.fail(&root, &id, round, error.to_string(), cx);
                            return;
                        }
                    },
                    Err(error) => {
                        this.fail(&root, &id, round, Self::failure(&error), cx);
                        return;
                    }
                };
                this.record(&root, &id, revision, |_| {}, cx);
            })
            .ok();
        })
    }

    /// Run queued asks while fewer than the limit are running.
    fn pump(&mut self, cx: &mut Context<Self>) {
        while self.active.len() < CONCURRENT_REVISIONS {
            let Some(job) = self.queue.pop_front() else {
                break;
            };
            let (id, ticket) = (job.id.clone(), job.ticket);
            let ask = self.ask(job, cx);
            let done = cx.spawn(async move |this, cx| {
                ask.await;
                this.update(cx, |this, cx| {
                    this.active.remove(&ticket);
                    if this.running.get(&id) == Some(&ticket) {
                        this.running.remove(&id);
                    }
                    cx.notify();
                    this.settle(cx);
                    this.pump(cx);
                })
                .ok();
            });
            self.active.insert(ticket, done);
        }
        cx.notify();
    }

    /// Ask about `ids` in the open round (a new one when none is open).
    fn start(&mut self, ids: Vec<String>, extra: impl Fn(&str) -> Extra, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        if ids.is_empty() {
            return;
        }
        let round = Self::join_round(&root, &ids, cx);
        let paths: Vec<String> = Self::notes(&root, cx)
            .into_iter()
            .filter(|comment| ids.contains(&comment.id))
            .map(|comment| comment.path.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        // The first answer may not land before the baseline holds the text
        // it changes: the baseline is read here, before any ask.
        self.keep_baseline(&root, round, &paths, cx);
        for id in ids {
            self.tickets += 1;
            let ticket = self.tickets;
            // A newer ask replaces one under way.
            self.queue.retain(|job| job.id != id);
            self.running.insert(id.clone(), ticket);
            let extra = extra(&id);
            self.queue.push_back(Job { root: root.clone(), id, round, extra, ticket });
        }
        self.pump(cx);
    }

    /// Ask the agent to revise `scope` (every open annotation for `None`),
    /// and show the panel.
    pub fn revise(&mut self, scope: Option<Vec<String>>, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let running = |id: &str| self.running.contains_key(id);
        let ids: Vec<String> = Self::notes(&root, cx)
            .into_iter()
            .filter(|comment| {
                revisable(comment, &running)
                    && scope.as_ref().is_none_or(|scope| scope.contains(&comment.id))
            })
            .map(|comment| comment.id.clone())
            .collect();
        self.start(ids, |_| Extra::default(), cx);
        cx.emit(RoundsEvent::OpenPanel);
    }

    /// How many annotations a round would ask about now.
    pub fn revisable_count(&self, cx: &App) -> usize {
        let Some(root) = self.root(cx) else {
            return 0;
        };
        let running = |id: &str| self.running.contains_key(id);
        Self::notes(&root, cx)
            .into_iter()
            .filter(|comment| revisable(comment, &running))
            .count()
    }

    /// Turn down `id`'s proposal and ask again, with what the writer wants
    /// instead.
    pub fn retry(&mut self, id: &str, guidance: &str, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let Some(comment) = Self::find(&root, id, cx).filter(|comment| !comment.resolved) else {
            return;
        };
        let rejected = comment
            .revision
            .filter(|revision| revision.state == "proposed")
            .and_then(|revision| revision.text);
        let guidance = Some(guidance.trim().to_string()).filter(|guidance| !guidance.is_empty());
        self.start(
            vec![id.to_string()],
            move |_| Extra { guidance: guidance.clone(), rejected: rejected.clone() },
            cx,
        );
    }

    /// The writer's answer to the agent's question, then a revision that
    /// reads it.
    pub fn answer(&mut self, id: &str, text: &str, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let Some(revision) = Self::find(&root, id, cx)
            .and_then(|comment| comment.revision)
            .filter(|revision| revision.state == "asked")
        else {
            return;
        };
        if text.trim().is_empty() {
            return;
        }
        let answered = AnnotationRevision { answer: Some(text.trim().to_string()), ..revision };
        self.record(&root, id, answered, |_| {}, cx);
        self.start(vec![id.to_string()], |_| Extra::default(), cx);
    }

    /// Accept `id`'s proposal as the editor applied it, then review the next
    /// one waiting.
    pub fn accepted(&mut self, id: &str, applied: Accepted, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let Some(revision) = Self::find(&root, id, cx)
            .and_then(|comment| comment.revision)
            .filter(|revision| revision.state == "proposed")
        else {
            return;
        };
        let next = self.neighbour(Some(id), 1, cx);
        self.record(
            &root,
            id,
            AnnotationRevision { state: "accepted".into(), ..revision },
            move |comment| {
                comment.from = applied.from;
                comment.to = applied.to;
                comment.quote = applied.quote;
                comment.prefix = applied.prefix;
                comment.suffix = applied.suffix;
                comment.resolved = true;
            },
            cx,
        );
        self.decided(next, cx);
    }

    /// Keep `id`'s passage, then review the next proposal waiting.
    pub fn rejected(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let Some(revision) = Self::find(&root, id, cx)
            .and_then(|comment| comment.revision)
            .filter(|revision| revision.state == "proposed")
        else {
            return;
        };
        let next = self.neighbour(Some(id), 1, cx);
        self.record(&root, id, AnnotationRevision { state: "rejected".into(), ..revision }, |_| {}, cx);
        self.decided(next, cx);
    }

    fn decided(&mut self, next: Option<String>, cx: &mut Context<Self>) {
        match next {
            Some(next) => self.open_review(&next, cx),
            None => self.close_review(cx),
        }
        self.settle(cx);
    }

    /// Open `id`'s proposal in the editor, its card under the passage.
    pub fn open_review(&mut self, id: &str, cx: &mut Context<Self>) {
        self.review = Some(id.to_string());
        cx.emit(RoundsEvent::Review(id.to_string()));
        cx.notify();
    }

    pub fn close_review(&mut self, cx: &mut Context<Self>) {
        if self.review.take().is_some() {
            cx.emit(RoundsEvent::CloseReview);
            cx.notify();
        }
    }

    /// The next (or previous) waiting proposal after `id`, wrapping; none
    /// when there is none.
    pub fn neighbour(&self, id: Option<&str>, step: isize, cx: &App) -> Option<String> {
        let root = self.root(cx)?;
        let proposals = pending_proposals(&Self::notes(&root, cx));
        if proposals.is_empty() {
            return None;
        }
        let count = proposals.len() as isize;
        let Some(index) = id.and_then(|id| proposals.iter().position(|comment| comment.id == id)) else {
            let first = if step > 0 { 0 } else { proposals.len() - 1 };
            return Some(proposals[first].id.clone());
        };
        let next = &proposals[((index as isize + step + count) % count) as usize];
        (Some(next.id.as_str()) != id).then(|| next.id.clone())
    }

    /// Review the proposal before or after `id`.
    pub fn navigate(&mut self, id: &str, step: isize, cx: &mut Context<Self>) {
        if let Some(next) = self.neighbour(Some(id), step, cx) {
            self.open_review(&next, cx);
        }
    }

    /// Where `id` stands among the waiting proposals, and how many wait.
    pub fn position(&self, id: &str, cx: &App) -> (Option<usize>, usize) {
        let Some(root) = self.root(cx) else {
            return (None, 0);
        };
        let proposals = pending_proposals(&Self::notes(&root, cx));
        (proposals.iter().position(|comment| comment.id == id), proposals.len())
    }
}

/// The window's rounds.
pub fn new(cx: &mut App) -> Entity<AnnotationRounds> {
    cx.new(|_| AnnotationRounds::new(RoundsHost::default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, number: u32, path: &str, from: u32, state: Option<&str>) -> EditorComment {
        let mut comment: EditorComment = serde_json::from_value(serde_json::json!({
            "id": id, "number": number, "path": path, "from": from, "to": from + 4,
            "quote": "text", "body": "note", "authorId": "a", "authorName": "A",
            "createdAt": "1", "updatedAt": "1"
        }))
        .unwrap();
        comment.revision = state.map(|state| AnnotationRevision {
            round: 1,
            state: state.into(),
            original: None,
            text: None,
            reason: None,
            question: None,
            answer: None,
            error: None,
        });
        comment
    }

    // annotation-rounds.ts's `revisable`: a numbered, open note with no
    // proposal waiting and no unanswered question.
    #[test]
    fn what_a_round_asks_about() {
        let none = |_: &str| false;
        assert!(revisable(&note("a", 1, "a.tex", 0, None), &none));
        assert!(!revisable(&note("a", 0, "a.tex", 0, None), &none));
        assert!(!revisable(&note("a", 1, "a.tex", 0, Some("proposed")), &none));
        assert!(!revisable(&note("a", 1, "a.tex", 0, Some("asked")), &none));
        assert!(revisable(&note("a", 1, "a.tex", 0, Some("rejected")), &none));
        assert!(!revisable(&note("a", 1, "a.tex", 0, None), &|id| id == "a"));
        let mut answered = note("a", 1, "a.tex", 0, Some("asked"));
        answered.revision.as_mut().unwrap().answer = Some("yes".into());
        assert!(revisable(&answered, &none));
    }

    #[test]
    fn proposals_are_walked_by_file_then_place() {
        let notes = [
            note("c", 3, "b.tex", 0, Some("proposed")),
            note("b", 2, "a.tex", 9, Some("proposed")),
            note("a", 1, "a.tex", 2, Some("proposed")),
            note("d", 4, "a.tex", 1, Some("rejected")),
        ];
        let refs: Vec<&EditorComment> = notes.iter().collect();
        let order: Vec<String> = pending_proposals(&refs).into_iter().map(|comment| comment.id).collect();
        assert_eq!(order, ["a", "b", "c"]);
    }
}
