//! The Agent's checkpoints (`crate::agent::checkpoints`,
//! `shell/agent_checkpoints.rs`), from snapshots as the Agent panel's page
//! relays them (`agent:history`), so no Synara runtime is needed:
//!
//! - a thread's first snapshot replays its history: its rows reach the
//!   History panel, able to undo, and nothing builds;
//! - a fresh checkpoint builds the PDF once it rests, and that build tells
//!   the turn how it went (`lattice:agent-compile-result`);
//! - another thread's snapshot leaves the first thread's rows unable to
//!   undo, and a row's Undo goes to the Agent's frame only for the open one;
//! - an Undo that put conflict markers back opens the resolver, its sides
//!   the current text and the text from before the Agent.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use lattice_ui::ActiveLattice as _;
use serde_json::{Value, json};

use super::Steps;
use crate::{
    agent::{SurfaceEvent, checkpoints},
    scenario::Run,
};

fn entry(id: &str, thread: &str, at: &str, path: &str) -> Value {
    json!({
        "id": id,
        "label": format!("Revise {path}"),
        "timestamp": at,
        "threadId": thread,
        "threadTitle": format!("Thread {thread}"),
        "turnId": format!("turn-{id}"),
        "turnCount": 2,
        "checkpointRef": format!("refs/lattice/checkpoints/{id}"),
        "files": [{ "path": path, "kind": "modified", "additions": 3, "deletions": 1 }],
    })
}

fn snapshot(thread: &str, entries: Vec<Value>) -> Value {
    json!({ "type": "lattice:project-history", "activeThreadId": thread, "entries": entries })
}

impl Run {
    /// Relay `snapshot` as the Agent panel's page does.
    fn agent_snapshot(&self, cx: &mut AsyncApp, snapshot: Value) {
        let Some(parsed) = checkpoints::parse_snapshot(&snapshot) else {
            return;
        };
        cx.update(|cx| {
            let surface = self.shell.read(cx).agent.panel.read(cx).surface().clone();
            surface.update(cx, |_, cx| cx.emit(SurfaceEvent::History(parsed)));
        });
    }

    pub(super) async fn agent_checkpoints(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        self.open(cx, &root.join("main.tex"), Some(1))?;
        let history = cx.update(|cx| self.shell.read(cx).history.clone());
        let sent = |run: &Run, cx: &mut AsyncApp| {
            cx.update(|cx| run.shell.read(cx).agent_checkpoint_messages().to_vec())
        };

        let a = entry("a", "one", "2026-11-14T10:00:00.000Z", "main.tex");
        self.agent_snapshot(cx, snapshot("one", vec![a.clone()]));
        self.pause(cx, Duration::from_millis(2_200)).await;
        let rows = cx.update(|cx| history.read(cx).agent_checkpoint_rows());
        steps.check(
            "a thread's first Agent snapshot puts its checkpoints in History, able to undo, and builds nothing",
            rows == vec![("a".to_string(), true)] && sent(self, cx).is_empty(),
            json!({ "rows": format!("{rows:?}"), "sent": sent(self, cx) }),
        );

        let b = entry("b", "one", "2026-11-14T10:01:00.000Z", "main.tex");
        self.agent_snapshot(cx, snapshot("one", vec![a.clone(), b.clone()]));
        let reported = self
            .wait_for(cx, Duration::from_secs(90), |shell, cx| {
                !shell.read(cx).agent_checkpoint_messages().is_empty()
            })
            .await;
        let messages = sent(self, cx);
        let result = messages.first().cloned().unwrap_or(Value::Null);
        steps.check(
            "a fresh Agent checkpoint builds the PDF once it rests, and the build tells its turn how it went",
            reported
                && messages.len() == 1
                && result["type"] == "lattice:agent-compile-result"
                && result["turnId"] == "turn-b"
                && result["checkpointRef"] == "refs/lattice/checkpoints/b"
                && result["rootDocument"] == "main.tex"
                && result["success"].is_boolean(),
            json!({ "messages": messages }),
        );

        let c = entry("c", "two", "2026-11-14T10:02:00.000Z", "main.tex");
        self.agent_snapshot(cx, snapshot("two", vec![c.clone()]));
        self.pause(cx, Duration::from_millis(300)).await;
        let rows = cx.update(|cx| {
            let mut rows = history.read(cx).agent_checkpoint_rows();
            rows.sort();
            rows
        });
        let before = sent(self, cx).len();
        cx.update(|cx| {
            history.update(cx, |history, cx| {
                history.restore_agent_checkpoint_for_scenario("a", cx);
                history.restore_agent_checkpoint_for_scenario("c", cx);
            })
        });
        self.pause(cx, Duration::from_millis(200)).await;
        let undos: Vec<Value> = sent(self, cx).into_iter().skip(before).collect();
        steps.check(
            "another thread's checkpoints stay in History but only the Agent's open thread undoes, through its frame",
            rows == vec![
                ("a".to_string(), false),
                ("b".to_string(), false),
                ("c".to_string(), true),
            ] && undos
                == vec![json!({
                    "type": "lattice:restore-agent-checkpoint",
                    "threadId": "two",
                    "turnCount": 2,
                })],
            json!({ "rows": format!("{rows:?}"), "undos": undos }),
        );

        // The rows as they look, for a change's evidence (light and dark by
        // `LATTICE_APPEARANCE`), when asked for.
        // Window captures are macOS-only (`scenario/shot.rs`).
        #[cfg(target_os = "macos")]
        if let Ok(dir) = std::env::var("LATTICE_E2E_EVIDENCE_DIR") {
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| shell.open_history(window, cx))
            })?;
            cx.update(|cx| {
                history.update(cx, |history, cx| {
                    history.open_agent_checkpoint_for_scenario("c", cx)
                })
            });
            self.pause(cx, Duration::from_millis(800)).await;
            let theme = cx.update(|cx| if cx.palette().is_dark() { "dark" } else { "light" });
            if let Err(error) = self
                .capture(cx, &format!("{dir}/agent-checkpoints-{theme}.png"))
                .await
            {
                log::warn!("agent checkpoints evidence: {error:#}");
            }
        }

        // Undo of a turn on a file a co-author has since edited: Synara keeps
        // both versions of the overlapping spot, marked.
        let marked = root.join("chapters/agent-undo.tex");
        std::fs::write(
            &marked,
            "Intro.\n<<<<<<< current\nTheir newer line.\n=======\nThe line before the agent.\n>>>>>>> before agent\n",
        )?;
        let second = root.join("chapters/agent-undo-2.tex");
        std::fs::write(
            &second,
            "<<<<<<< current\nTheir edit.\n=======\nThe agent's text.\n>>>>>>> before agent\n",
        )?;
        let d = entry("d", "two", "2026-11-14T10:03:00.000Z", "chapters/agent-undo.tex");
        let e = entry("e", "two", "2026-11-14T10:03:00.000Z", "chapters/agent-undo-2.tex");
        self.agent_snapshot(cx, snapshot("two", vec![c.clone(), d, e]));
        self.agent_snapshot(cx, snapshot("two", vec![c]));
        let opened = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                // The resolver reads the file before it has spots.
                shell
                    .read(cx)
                    .conflict
                    .as_ref()
                    .is_some_and(|(resolver, _)| resolver.read(cx).spots() > 0)
            })
            .await;
        let (agent_sides, spots) = cx.update(|cx| {
            self.shell
                .read(cx)
                .conflict
                .as_ref()
                .map(|(resolver, _)| {
                    let resolver = resolver.read(cx);
                    (resolver.is_agent_undo(), resolver.spots())
                })
                .unwrap_or_default()
        });
        steps.check(
            "an Undo that came back with conflict markers opens the resolver on the current text and the text from before the Agent",
            opened && agent_sides && spots == 1,
            json!({ "opened": opened, "agent_sides": agent_sides, "spots": spots }),
        );
        // The other file the Undo marked, opened later, is the Undo's too.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_conflict_resolver("chapters/agent-undo-2.tex".into(), false, window, cx)
            })
        })?;
        let later_sides = cx.update(|cx| {
            self.shell
                .read(cx)
                .conflict
                .as_ref()
                .is_some_and(|(resolver, _)| resolver.read(cx).is_agent_undo())
        });
        steps.check(
            "every file an Undo marked opens in the resolver as the Undo's",
            later_sides,
            json!({ "agent_sides": later_sides }),
        );
        cx.update(|cx| {
            self.shell.update(cx, |shell, cx| {
                shell.conflict = None;
                cx.notify();
            })
        });
        std::fs::remove_file(&marked).ok();
        std::fs::remove_file(&second).ok();
        Ok(())
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 30,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/agent/checkpoints.rs",
        "gpui/crates/lattice-gpui/src/shell/agent_checkpoints.rs",
        "gpui/crates/lattice-gpui/src/history/checkpoint_rows.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.agent_checkpoints(cx, steps, &fixture.root)),
};
