//! The Agent's page on the project's annotations, through the window's own
//! store and revision rounds (`agent/surface/annotations.rs`,
//! `annotations/rounds/agent_tools.rs`):
//!
//! - the page reads what the store holds;
//! - a note written natively after the page read the list reaches the page;
//! - the Agent's proposal on that note, from the page, is recorded into the
//!   open round, and every note written natively since the page loaded is
//!   kept, in the store and on disk;
//! - its question on another note joins the same round;
//! - the page has no way left to write the annotations itself.
//!
//! The project's annotations and rounds are put back afterwards.

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use lattice_core::project::{self, EditorComment};
use serde_json::{Value, json};

use super::Steps;
use crate::{annotations::store, scenario::Run};

const LISTEN: &str = "(() => { if (!window.latticeHost) return false; \
     if (!window.__e2eNotes) { window.__e2eNotes = []; \
       window.latticeHost.on('agent:annotations', (p) => window.__e2eNotes.push(p)); } \
     return true; })()";
const HEARD: &str = "JSON.stringify((window.__e2eNotes || []).at(-1) || null)";

fn note(id: &str, body: &str) -> EditorComment {
    serde_json::from_value(json!({
        "id": id, "path": "main.tex", "from": 0, "to": 9, "quote": "\\document",
        "body": body, "authorId": "e2e", "authorName": "E2E",
        "createdAt": "2026-11-15T00:00:00Z", "updatedAt": "2026-11-15T00:00:00Z",
    }))
    .expect("a note parses")
}

fn ids(notes: &Value) -> Vec<String> {
    notes["annotations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|note| note["id"].as_str().map(str::to_string))
        .collect()
}

impl Run {
    pub(super) async fn agent_annotations(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let original = project::read_annotations(root).ok();
        let rounds_dir = root.join(".research/annotation-rounds");
        let rounds_existed = rounds_dir.exists();
        let outcome = self.agent_annotations_steps(cx, steps, root).await;
        // Put the notes back through the store, so it holds what the file does.
        let store = cx.update(store::store);
        let restore = original.unwrap_or(project::Annotations {
            annotations: Vec::new(),
            rounds: Vec::new(),
        });
        cx.update(|cx| {
            store.update(cx, |store, cx| {
                store.commit(
                    root,
                    |notes| {
                        notes.annotations = restore.annotations;
                        notes.rounds = restore.rounds;
                        true
                    },
                    cx,
                )
            })
        });
        if !rounds_existed {
            std::fs::remove_dir_all(&rounds_dir).ok();
        }
        outcome
    }

    async fn agent_annotations_steps(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.show_view("agent", true, window, cx))
        })?;
        let surface = cx.update(|cx| self.shell.read(cx).agent.panel.read(cx).surface().clone());
        let Some(island) = cx.update(|cx| surface.read(cx).island().cloned()) else {
            steps.check(
                "the Agent panel hosts the Agent island",
                false,
                json!({ "reason": "no island: the island pages are not built" }),
            );
            return Ok(());
        };
        self.wait_for(cx, Duration::from_secs(20), |_, cx| surface.read(cx).is_drawn())
            .await;
        let listening = self.evaluate(cx, &island, LISTEN).await == Value::Bool(true);
        let store = cx.update(store::store);
        self.wait_for(cx, Duration::from_secs(10), |_, cx| store.read(cx).loaded(root))
            .await;

        // The page reads what the store holds.
        let read = self
            .agent_call(
                cx,
                &island,
                "window.__TAURI_INTERNALS__.invoke('list_annotations')",
                Duration::from_secs(10),
            )
            .await;
        let held: Vec<String> = cx.update(|cx| {
            store
                .read(cx)
                .notes(root)
                .map(|notes| notes.annotations.iter().map(|note| note.id.clone()).collect())
                .unwrap_or_default()
        });
        steps.check(
            "the Agent's page reads the annotations the window's store holds",
            listening && ids(&read["ok"]) == held,
            json!({ "listening": listening, "read": read, "held": held }),
        );

        // A note written natively, after the page read the list.
        let added = cx.update(|cx| {
            store.update(cx, |store, cx| {
                store.add(root, note("e2e-native", "written in the Annotations panel"), cx)
            })
        });
        let mut heard = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            heard = self.evaluate(cx, &island, HEARD).await;
            if ids(&heard).iter().any(|id| id == "e2e-native") {
                break;
            }
            self.pause(cx, Duration::from_millis(100)).await;
        }
        steps.check(
            "a note written natively after the page loaded reaches the page",
            added.is_some() && ids(&heard).iter().any(|id| id == "e2e-native"),
            json!({ "added": added, "heard": heard }),
        );

        // A second native note, then the Agent's tools on both, from the page.
        cx.update(|cx| {
            store.update(cx, |store, cx| {
                store.add(root, note("e2e-second", "is this the right result?"), cx)
            })
        });
        let tool = |mut call: Value| {
            call["projectRoot"] = json!(root.to_string_lossy());
            format!("window.__TAURI_INTERNALS__.invoke('record_annotation_tool', {call})")
        };
        let proposed = self
            .agent_call(
                cx,
                &island,
                &tool(json!({ "annotationId": "e2e-native", "action": "propose",
                              "text": "\\documentclass{article}", "reason": "the full line" })),
                Duration::from_secs(10),
            )
            .await;
        let asked = self
            .agent_call(
                cx,
                &island,
                &tool(json!({ "annotationId": "e2e-second", "action": "ask",
                              "question": "Which theorem do you mean?" })),
                Duration::from_secs(10),
            )
            .await;
        let state_of = |read: &project::Annotations, id: &str| {
            read.annotations
                .iter()
                .find(|note| note.id == id)
                .and_then(|note| note.revision.as_ref().map(|revision| (revision.state.clone(), revision.round)))
        };
        let recorded = self
            .wait_for(cx, Duration::from_secs(5), |_, _| {
                project::read_annotations(root).is_ok_and(|read| {
                    let open = read.rounds.last().filter(|round| round.settled_at.is_none());
                    matches!(
                        (state_of(&read, "e2e-native"), state_of(&read, "e2e-second"), open),
                        (Some((proposed, a)), Some((asked, b)), Some(round))
                            if proposed == "proposed" && asked == "asked" && a == b && round.number == a
                                && round.outcomes.get("e2e-native").map(String::as_str) == Some("proposed")
                                && round.outcomes.get("e2e-second").map(String::as_str) == Some("asked")
                    )
                })
            })
            .await;
        let on_disk = project::read_annotations(root).ok();
        steps.check(
            "the Agent's proposal and question, from the page, are recorded into the open round",
            proposed.get("error").is_none() && asked.get("error").is_none() && recorded,
            json!({ "proposed": proposed, "asked": asked,
                    "rounds": on_disk.as_ref().map(|read| serde_json::to_value(&read.rounds).unwrap_or_default()) }),
        );
        let kept = on_disk.as_ref().is_some_and(|read| {
            ["e2e-native", "e2e-second"]
                .iter()
                .all(|id| read.annotations.iter().any(|note| note.id == *id))
        });
        steps.check(
            "notes written natively after the page loaded survive the Agent's tools, in the store and on disk",
            kept && held.iter().all(|id| on_disk.as_ref().is_some_and(|read| read.annotations.iter().any(|note| &note.id == id))),
            json!({ "kept": kept, "before": held }),
        );

        // No write of its own is left for a page.
        let mut refused = Vec::new();
        for call in [
            "save_annotations', { annotations: [], rounds: [], save: 0 }",
            "change_annotations', { remove: ['e2e-native'] }",
        ] {
            let (command, args) = call.split_once("', ").unwrap_or_default();
            let script = format!(
                "window.__TAURI_INTERNALS__.invoke('{command}', Object.assign({args}, {{ projectRoot: {} }}))",
                json!(root.to_string_lossy())
            );
            refused.push(self.agent_call(cx, &island, &script, Duration::from_secs(10)).await);
        }
        let kept = project::read_annotations(root)
            .is_ok_and(|read| read.annotations.iter().any(|note| note.id == "e2e-native"));
        steps.check(
            "the page cannot write the annotations itself",
            refused.iter().all(|answer| answer.get("error").is_some()) && kept,
            json!({ "refused": refused, "kept": kept }),
        );
        Ok(())
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 34,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/agent/surface/annotations.rs",
        "gpui/crates/lattice-gpui/src/annotations/store.rs",
        "gpui/islands/agent/library.ts",
        "gpui/islands/agent/annotation-tools.ts",
        "gpui/crates/lattice-gpui/src/annotations/rounds/agent_tools.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.agent_annotations(cx, steps, &fixture.root)),
};
