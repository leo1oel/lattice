//! The Agent's page on the project's annotations, through the window's own
//! store (`agent/surface/annotations.rs`), the file's one writer:
//!
//! - the page reads what the store holds;
//! - a note written natively after the page read the list reaches the page;
//! - a change the page sends from what it read before that note (its
//!   proposal on its own note) keeps the native note, in the store and on
//!   disk;
//! - the page has no way left to save a whole copy over the file.
//!
//! The project's annotations are put back afterwards.

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

        // The page saves its own note, from what it read before that note.
        let page_note = serde_json::to_value(note("e2e-agent", "the Agent's proposal"))?;
        let call = format!(
            "window.__TAURI_INTERNALS__.invoke('change_annotations', {{ projectRoot: {}, upsert: [{page_note}] }})",
            json!(root.to_string_lossy())
        );
        let saved = self
            .agent_call(cx, &island, &call, Duration::from_secs(10))
            .await;
        let on_disk = self
            .wait_for(cx, Duration::from_secs(5), |_, _| {
                project::read_annotations(root).is_ok_and(|read| {
                    let ids: Vec<_> = read.annotations.iter().map(|note| note.id.as_str()).collect();
                    ids.contains(&"e2e-native") && ids.contains(&"e2e-agent")
                })
            })
            .await;
        steps.check(
            "a note written natively after the page loaded survives a page save, in the store and on disk",
            ids(&saved["ok"]).iter().any(|id| id == "e2e-native")
                && ids(&saved["ok"]).iter().any(|id| id == "e2e-agent")
                && on_disk,
            json!({ "saved": saved, "onDisk": on_disk }),
        );

        // No whole-copy save is left for a page.
        let whole = format!(
            "window.__TAURI_INTERNALS__.invoke('save_annotations', {{ projectRoot: {}, annotations: [], rounds: [], save: 0 }})",
            json!(root.to_string_lossy())
        );
        let refused = self
            .agent_call(cx, &island, &whole, Duration::from_secs(10))
            .await;
        let kept = project::read_annotations(root)
            .is_ok_and(|read| read.annotations.iter().any(|note| note.id == "e2e-native"));
        steps.check(
            "the page cannot save a whole copy of the annotations over the file",
            refused.get("error").is_some() && kept,
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
        "gpui/islands/agent/annotation-change.ts",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.agent_annotations(cx, steps, &fixture.root)),
};
