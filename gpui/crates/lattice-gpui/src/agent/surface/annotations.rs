//! The Agent's page on the project's annotations, through the window's own
//! store (`crate::annotations::store`), the one writer of
//! `.research/annotations.json` in the app. The Tauri app's Agent works on
//! its window's comments store (`use-editor-comments.ts`); here that store
//! is the native one:
//!
//! - `list_annotations` answers with what the store holds, once it has read
//!   the file;
//! - `change_annotations` applies the page's change, the annotations and
//!   rounds it added, changed or removed, by id to what the store holds now,
//!   so a note the Annotations panel wrote after the page last heard is
//!   kept, and answers with the result;
//! - every change the store makes, whoever made it, reaches the page
//!   (`agent:annotations`), so the revision rounds it runs see the notes
//!   and rounds as they are.

use std::time::Duration;

use gpui::{Context, Subscription};
use lattice_core::project::{AnnotationRound, EditorComment};
use lattice_i18n::t;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::SynaraSurface;
use crate::annotations::store::{self, Notes};

/// How long `list_annotations` waits for the store's first read.
const READ_WAIT: Duration = Duration::from_secs(15);

/// What the page was last told of the annotations, and the store it follows.
#[derive(Default)]
pub(super) struct PageAnnotations {
    told: Value,
    _store: Option<Subscription>,
}

/// The page's change (`change_annotations`): what it added or changed, and
/// what it removed, of the annotations (by id) and the rounds (by number).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Change {
    upsert: Vec<EditorComment>,
    remove: Vec<String>,
    rounds_upsert: Vec<AnnotationRound>,
    rounds_remove: Vec<u32>,
}

impl Change {
    /// Apply it to `notes`; whether anything changed.
    fn apply(self, notes: &mut Notes) -> bool {
        let mut changed = merge(&mut notes.annotations, self.upsert, |note| note.id.clone());
        let before = notes.annotations.len();
        notes
            .annotations
            .retain(|note| !self.remove.contains(&note.id));
        changed |= notes.annotations.len() != before;
        changed |= merge(&mut notes.rounds, self.rounds_upsert, |round| round.number);
        let before = notes.rounds.len();
        notes
            .rounds
            .retain(|round| !self.rounds_remove.contains(&round.number));
        changed | (notes.rounds.len() != before)
    }
}

/// Put each of `incoming` in place of the item with its key, or at the end.
fn merge<T, K: PartialEq>(items: &mut Vec<T>, incoming: Vec<T>, key: impl Fn(&T) -> K) -> bool {
    let changed = !incoming.is_empty();
    for item in incoming {
        match items.iter().position(|old| key(old) == key(&item)) {
            Some(at) => items[at] = item,
            None => items.push(item),
        }
    }
    changed
}

fn notes_value(notes: &Notes) -> Value {
    json!({ "annotations": notes.annotations, "rounds": notes.rounds })
}

fn field<T: DeserializeOwned + Default>(args: &Value, key: &str) -> Result<T, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(T::default()),
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|error| format!("Invalid {key}: {error}"))
        }
    }
}

impl SynaraSurface {
    /// Follow the store for the project now open, and tell the page what it
    /// holds (`set_project`).
    pub(super) fn follow_annotations(&mut self, cx: &mut Context<Self>) {
        self.annotations = PageAnnotations::default();
        let Some(root) = self.root.clone() else {
            return;
        };
        let store = store::store(cx);
        store.update(cx, |store, cx| store.ensure(&root, cx));
        self.annotations._store = Some(cx.observe(&store, |this, _, cx| this.tell_annotations(cx)));
        self.tell_annotations(cx);
    }

    /// Tell the page the store's annotations, when they changed since.
    fn tell_annotations(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let Some(store) = store::try_store(cx) else {
            return;
        };
        let store = store.read(cx);
        let Some(notes) = store.notes(&root).filter(|_| store.loaded(&root)) else {
            return;
        };
        let value = notes_value(notes);
        if value != self.annotations.told {
            self.annotations.told = value.clone();
            self.post("agent:annotations", value, cx);
        }
    }

    /// `list_annotations`: what the store holds, once it has read the file.
    pub(super) fn list_annotations(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            self.respond(id, Err("No project is open.".into()), cx);
            return;
        };
        let store = store::store(cx);
        store.update(cx, |store, cx| store.ensure(&root, cx));
        cx.spawn(async move |this, cx| {
            let started = std::time::Instant::now();
            let answer = loop {
                let state = store.read_with(cx, |store, _| {
                    if store.loaded(&root) {
                        Some(Ok(store.notes(&root).map(notes_value).unwrap_or_default()))
                    } else {
                        store.read_failure(&root).map(|error| Err(error.to_string()))
                    }
                });
                match state {
                    Some(answer) => break answer,
                    None if started.elapsed() < READ_WAIT => {
                        cx.background_executor().timer(Duration::from_millis(50)).await;
                    }
                    None => {
                        break Err(t!(
                            "This project's annotations are still being read. Try again in a moment."
                        )
                        .to_string());
                    }
                }
            };
            this.update(cx, |this, cx| this.respond(id, answer, cx)).ok();
        })
        .detach();
    }

    /// `change_annotations`: the page's change, applied by id to what the
    /// store holds now; answered with the result.
    pub(super) fn change_annotations(&mut self, id: u64, args: &Value, cx: &mut Context<Self>) {
        let answer = self.apply_change(args, cx);
        self.respond(id, answer, cx);
    }

    fn apply_change(&mut self, args: &Value, cx: &mut Context<Self>) -> Result<Value, String> {
        let root = self.root.clone().ok_or("No project is open.")?;
        let asked = args.get("projectRoot").and_then(Value::as_str);
        if asked.is_none_or(|asked| {
            !super::super::commands::same_root(std::path::Path::new(asked), &root)
        }) {
            return Err("The project changed before saving the annotations.".into());
        }
        let change = Change {
            upsert: field(args, "upsert")?,
            remove: field(args, "remove")?,
            rounds_upsert: field(args, "roundsUpsert")?,
            rounds_remove: field(args, "roundsRemove")?,
        };
        let store = store::store(cx);
        store.update(cx, |store, cx| {
            if let Some(error) = store.read_failure(&root) {
                return Err(t!(
                    "This project's annotations could not be read, so changes to them are not saved: {error}",
                    error = error
                )
                .to_string());
            }
            if !store.loaded(&root) {
                return Err(
                    t!("This project's annotations are still being read. Try again in a moment.")
                        .to_string(),
                );
            }
            store.commit(&root, |notes| change.apply(notes), cx);
            Ok(store.notes(&root).map(notes_value).unwrap_or_default())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, body: &str) -> EditorComment {
        serde_json::from_value(json!({
            "id": id, "path": "main.tex", "from": 0, "to": 4, "quote": "text", "body": body,
            "authorId": "writer", "authorName": "Writer",
            "createdAt": "2026-11-15T00:00:00Z", "updatedAt": "2026-11-15T00:00:00Z",
        }))
        .expect("a note parses")
    }

    fn round(number: u32) -> AnnotationRound {
        serde_json::from_value(json!({ "number": number, "startedAt": "2026-11-15T00:00:00Z" }))
            .expect("a round parses")
    }

    // The data loss this guards against: the page's copy predates a note
    // the Annotations panel added, and a whole-copy save would drop it.
    #[test]
    fn a_change_keeps_what_the_store_gained_since_the_page_last_heard() {
        let mut notes = Notes {
            annotations: vec![note("a", "old"), note("native", "written in the panel")],
            rounds: vec![round(1)],
        };
        let change = Change {
            upsert: vec![
                note("a", "revised by the Agent"),
                note("b", "the Agent's new note"),
            ],
            remove: vec![],
            rounds_upsert: vec![round(2)],
            rounds_remove: vec![],
        };
        assert!(change.apply(&mut notes));
        let ids: Vec<_> = notes
            .annotations
            .iter()
            .map(|note| note.id.as_str())
            .collect();
        assert_eq!(ids, ["a", "native", "b"]);
        assert_eq!(notes.annotations[0].body, "revised by the Agent");
        let rounds: Vec<_> = notes.rounds.iter().map(|round| round.number).collect();
        assert_eq!(rounds, [1, 2]);
    }

    #[test]
    fn a_removal_takes_only_what_it_names() {
        let mut notes = Notes {
            annotations: vec![note("a", "x"), note("b", "y")],
            rounds: vec![round(1), round(2)],
        };
        let change = Change {
            remove: vec!["a".into(), "gone".into()],
            rounds_remove: vec![1],
            ..Change::default()
        };
        assert!(change.apply(&mut notes));
        assert_eq!(notes.annotations.len(), 1);
        assert_eq!(notes.annotations[0].id, "b");
        assert_eq!(notes.rounds.len(), 1);
        assert!(!Change::default().apply(&mut notes));
    }
}
