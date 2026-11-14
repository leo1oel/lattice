//! The Agent's work on the window's documents (`shell/agent_documents.rs`),
//! asked from the Agent island's page as its own modules ask
//! (`gpui/islands/agent/documents.ts`), on the tutorial's board and sheet:
//!
//! - a canvas tool call goes to the board shown in front, where the Tauri
//!   app's tldraw adapter runs it: its listing is the board's shapes, and a
//!   shape it deletes leaves the panel's text;
//! - a range read goes to the open sheet it names and is read from its open
//!   document; one naming a sheet that is not open is the page's to run
//!   (`local`);
//! - a board the Agent creates is created, opened, and answered with its path
//!   once its editor has registered with the canvas tools;
//! - the page reads the project's papers (`list_papers`) and annotations
//!   (`list_annotations`) through its owner.

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use lattice_webview::Island;
use serde_json::{Value, json};

use super::{
    Run, Steps,
    structured::{BOARD, SHEET, shape_count},
};

impl Run {
    /// Run `call`, a promise expression in the Agent's page, and wait at most
    /// `timeout` for what it settles to: `{ ok }` or `{ error }`.
    async fn agent_call(
        &self,
        cx: &mut AsyncApp,
        island: &Entity<Island>,
        call: &str,
        timeout: Duration,
    ) -> Value {
        self.evaluate(
            cx,
            island,
            &format!(
                "window.__e2eAgent = null; Promise.resolve().then(() => {call}).then(\
                 (ok) => {{ window.__e2eAgent = JSON.stringify({{ ok }}); }}, \
                 (error) => {{ window.__e2eAgent = JSON.stringify({{ error: String(error && error.message || error) }}); }}); null"
            ),
        )
        .await;
        let started = std::time::Instant::now();
        while started.elapsed() < timeout {
            let value = self.evaluate(cx, island, "window.__e2eAgent").await;
            // `evaluate` hands back the page's JSON already parsed.
            match value {
                Value::Null => {}
                Value::String(text) => {
                    return serde_json::from_str(&text).unwrap_or(Value::String(text));
                }
                value => return value,
            }
            self.pause(cx, Duration::from_millis(100)).await;
        }
        Value::Null
    }

    pub(super) async fn agent_documents(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        agent: &Entity<Island>,
    ) -> Result<()> {
        let tool = |family: &str, id: &str, action: &str, args: Value| {
            let request = json!({
                "type": format!("synara:{family}-tool-request"),
                "version": 1,
                "id": id,
                "action": action,
                "args": args,
            });
            format!(
                "window.latticeHost.request('agent:document-tool', {{ family: '{family}', \
                 request: {{ ...{request}, expiresAt: Date.now() + 20000 }} }})"
            )
        };

        // A canvas call on the board in front.
        let board_path = root.join("e2e-agent-map.tldr");
        std::fs::write(&board_path, BOARD)?;
        let board = self
            .open_structured(cx, &board_path, Duration::from_secs(40))
            .await?;
        let listing = self
            .agent_call(
                cx,
                agent,
                &tool("canvas", "e2e-list", "list", json!({ "limit": 20 })),
                Duration::from_secs(10),
            )
            .await;
        let envelope = &listing["ok"]["result"];
        let shapes = envelope["result"]["shapes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        steps.check(
            "a canvas tool call from the Agent's page runs on the board in front, whose listing is the board's shapes",
            board.is_some()
                && envelope["type"] == "lattice:canvas-tool-result"
                && envelope["id"] == "e2e-list"
                && envelope["ok"] == true
                && envelope["result"]["total"].as_u64() == Some(shape_count(BOARD) as u64)
                && !shapes.is_empty(),
            json!({ "opened": board.is_some(), "answer": listing }),
        );
        if let (Some((panel, _)), Some(first)) = (
            &board,
            shapes.first().and_then(|shape| shape["id"].as_str()),
        ) {
            let deleted = self
                .agent_call(
                    cx,
                    agent,
                    &tool("canvas", "e2e-delete", "delete", json!({ "ids": [first] })),
                    Duration::from_secs(10),
                )
                .await;
            let panel = panel.clone();
            let left = self
                .wait_for(cx, Duration::from_secs(5), |_, cx| {
                    shape_count(&panel.read(cx).editor().read(cx).text(cx))
                        == shape_count(BOARD) - 1
                })
                .await;
            steps.check(
                "a shape the Agent deletes leaves the board, and the panel's text with it",
                deleted["ok"]["result"]["ok"] == true && left,
                json!({ "answer": deleted, "left": left }),
            );
        }

        // A range read on the open sheet it names; a closed one stays local.
        let sheet_path = root.join("e2e-agent-results.lattice-sheet");
        std::fs::write(&sheet_path, SHEET)?;
        let sheet = self
            .open_structured(cx, &sheet_path, Duration::from_secs(40))
            .await?;
        let read = self
            .agent_call(
                cx,
                agent,
                &tool(
                    "spreadsheet",
                    "e2e-read",
                    "read",
                    json!({ "path": "e2e-agent-results.lattice-sheet", "range": "A1:B2" }),
                ),
                Duration::from_secs(10),
            )
            .await;
        let closed = self
            .agent_call(
                cx,
                agent,
                &tool(
                    "spreadsheet",
                    "e2e-closed",
                    "read",
                    json!({ "path": "nowhere.lattice-sheet", "range": "A1" }),
                ),
                Duration::from_secs(10),
            )
            .await;
        steps.check(
            "a range read goes to the open sheet it names, and one naming a sheet that is not open is the Agent page's to run",
            sheet.is_some()
                && read["ok"]["result"]["type"] == "lattice:spreadsheet-tool-result"
                && read["ok"]["result"]["ok"] == true
                && closed["ok"]["local"] == true,
            json!({ "read": read, "closed": closed }),
        );

        // A board the Agent creates.
        let created = self
            .agent_call(
                cx,
                agent,
                "window.latticeHost.request('agent:create-document', { path: 'e2e-agent-made.tldr', \
                 documentType: 'board', expiresAt: Date.now() + 30000 })",
                Duration::from_secs(35),
            )
            .await;
        let made = root.join("e2e-agent-made.tldr");
        let front = cx.update(|cx| self.shell.read(cx).active_editor_path(cx));
        let refused = self
            .agent_call(
                cx,
                agent,
                "window.latticeHost.request('agent:create-document', { path: 'e2e-agent.tex', \
                 documentType: 'board', expiresAt: Date.now() + 30000 })",
                Duration::from_secs(5),
            )
            .await;
        steps.check(
            "a board the Agent creates is created, opened in front, and answered with its path once its editor has registered; anything but a board or sheet is refused",
            created["ok"] == "e2e-agent-made.tldr"
                && made.is_file()
                && front.as_deref().is_some_and(|path| path.ends_with("e2e-agent-made.tldr"))
                && refused["error"].is_string()
                && !root.join("e2e-agent.tex").exists(),
            json!({ "created": created, "front": front, "refused": refused }),
        );

        // The project's papers and annotations, read by the page.
        let papers = self
            .agent_call(
                cx,
                agent,
                "window.__TAURI_INTERNALS__.invoke('list_papers')",
                Duration::from_secs(10),
            )
            .await;
        let annotations = self
            .agent_call(
                cx,
                agent,
                "window.__TAURI_INTERNALS__.invoke('list_annotations')",
                Duration::from_secs(10),
            )
            .await;
        let keys: Vec<_> = papers["ok"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|paper| paper["citationKey"].as_str())
            .collect();
        steps.check(
            "the Agent's page reads the project's paper library and annotations through its owner",
            keys.contains(&"knuth1984") && annotations["ok"]["annotations"].is_array(),
            json!({ "papers": keys, "annotations": annotations }),
        );

        for path in [board_path, sheet_path, made] {
            let panel = cx.update(|cx| {
                self.shell.update(cx, |shell, cx| {
                    shell.open_editor(&path.canonicalize().unwrap_or(path.clone()), cx)
                })
            });
            if let Some(panel) = panel {
                self.close_panel(cx, &panel).await?;
            }
        }
        Ok(())
    }
}
