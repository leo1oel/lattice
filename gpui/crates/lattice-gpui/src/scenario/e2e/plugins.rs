#![cfg(target_os = "macos")]
//! The e2e checks of plugins (docs/plugins.md, gpui/docs/plugins.md): a
//! fixture plugin written to a folder under the scratch HOME is installed
//! from Settings › Plugins, listed off, and turned on through the
//! confirmation that lists what it may access; its commands then lead the
//! palette's Plugins section; a command that asks for text takes it in the
//! palette and returns items, whose second action copies; a command without
//! input returns diagnostics grouped by file, and Return on one opens its
//! file at its line; a message renders; a plugin's own error shows
//! inline; and Add to bibliography asks in the palette before it writes.
//! With `LATTICE_E2E_SHOTS` it then takes the Tauri app's states
//! (`plugin_shots.rs`). Plugins run only on macOS, so the module does too.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use lattice_settings::SettingsTab;
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

const MANIFEST: &str = r#"schema = 1
id = "dev.lattice.e2e"
name = "Fixture"
version = "1.0.0"
api = 1
license = "MIT"
description = "Commands the e2e scenario runs."
runtime = "node"
main = "main.js"

[permissions]
project-read = ["context"]

[[commands]]
id = "find"
title = "Find…"
description = "Search the fixture's references."
input = { kind = "text", placeholder = "Title or citation key" }

[[commands]]
id = "check"
title = "Check bibliography"
description = "Report problems in two files."

[[commands]]
id = "notes"
title = "Notes"

[[commands]]
id = "fail"
title = "Fail"

[[commands]]
id = "add"
title = "Suggest a reference"
"#;

const MAIN_JS: &str = r#"
function send(m) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); }
function reply(id, result) { send({ id, result }); }
function run(id, { command, input, context }) {
  switch (command) {
    case 'find':
      send({ method: 'progress', params: { message: 'Searching the library…' } });
      return setTimeout(() => reply(id, { kind: 'items', summary: '2 references for “' + input + '”', items: [
        { id: 'knuth', title: 'Literate Programming', subtitle: 'Knuth · 1984', detail: 'Active file: ' + (context.project.activeFile || 'none'),
          badges: ['In bibliography'], actions: [{ type: 'reveal', file: 'main.tex', line: 2 }, { type: 'copy', text: 'knuth84', title: 'Copy key' }] },
        { id: 'lamport', title: 'LaTeX: A Document Preparation System', subtitle: 'Lamport · 1994',
          actions: [{ type: 'insertCitation', key: 'lamport94' }, { type: 'openUrl', url: 'https://example.org/lamport' }] },
      ] }), 400);
    case 'check':
      return reply(id, { kind: 'diagnostics', summary: '3 problems', items: [
        { id: 'd1', file: 'references.bib', line: 3, severity: 'warning', code: 'missing-field', message: 'Entry has no year',
          fixes: [{ type: 'copy', text: 'year = {1984}', title: 'Copy field' }] },
        { id: 'd2', file: 'main.tex', line: 4, severity: 'error', code: 'undefined-key', message: 'Undefined citation key' },
        { id: 'd3', file: 'references.bib', line: 5, severity: 'info', code: 'style', message: 'Title is not in braces' },
      ] });
    case 'notes':
      return reply(id, { kind: 'message', markdown: '# Notes\n\nSome **bold** text and a [link](https://example.org).\n\n- one\n- two\n\n<b>raw</b>' });
    case 'add':
      return reply(id, { kind: 'items', items: [{ id: 'k', title: 'Structured Programming', actions: [
        { type: 'addBibEntry', bibtex: '@book{dijkstra72,\n  title = {Structured Programming},\n  year = {1972}\n}' }] }] });
    case 'fail':
      return send({ id, error: { code: -32000, message: 'Zotero is not running' } });
  }
}
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') reply(m.id, { apiLevel: 1 });
    else if (m.method === 'command/run') run(m.id, m.params);
    else if (m.method === '$/cancelRequest') send({ id: m.params.id, error: { code: -32800, message: 'cancelled' } });
  }
});
"#;

type State = Option<(&'static str, Vec<(String, String)>)>;

impl Run {
    fn plugin_state_now(&self, cx: &mut AsyncApp) -> State {
        cx.update(|cx| {
            let palette = self.shell.read(cx).palette_view()?;
            palette.read(cx).plugin_state()
        })
    }

    pub(super) async fn plugin_done(&self, cx: &mut AsyncApp) -> State {
        self.wait_for(cx, Duration::from_secs(20), |shell, cx| {
            shell
                .read(cx)
                .palette_view()
                .and_then(|palette| palette.read(cx).plugin_state())
                .is_some_and(|(step, _)| step == "done")
        })
        .await;
        self.plugin_state_now(cx)
    }

    pub(super) async fn plugin_shot(&self, cx: &mut AsyncApp, name: &str) {
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return;
        }
        self.pause(cx, Duration::from_millis(400)).await;
        self.snapshot(cx, name).await;
    }

    /// Open the palette, find `label` and choose it.
    async fn run_plugin_row(&self, cx: &mut AsyncApp, label: &str) -> Result<bool> {
        self.open_palette_now(cx)?;
        self.palette_type(cx, "Fixture")?;
        self.pause(cx, Duration::from_millis(100)).await;
        self.palette_run(cx, label)
    }

    async fn install_fixture_plugin(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<bool> {
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default();
        let folder = home.join("plugin-fixture");
        std::fs::create_dir_all(&folder)?;
        std::fs::write(folder.join("lattice-plugin.toml"), MANIFEST)?;
        std::fs::write(folder.join("main.js"), MAIN_JS)?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_settings(Some(SettingsTab::Plugins), window, cx)
            })
        })?;
        let drawn = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                let pane = shell.read(cx).settings.as_ref().and_then(|s| s.read(cx).plugins_pane());
                pane.is_some_and(|pane| !pane.read(cx).is_busy())
            })
            .await;
        let pane = cx.update(|cx| {
            self.shell
                .read(cx)
                .settings
                .as_ref()
                .and_then(|settings| settings.read(cx).plugins_pane())
        });
        let Some(pane) = pane.filter(|_| drawn) else {
            steps.check("Settings › Plugins draws its page", false, json!({}));
            return Ok(false);
        };
        {
            let (pane, folder) = (pane.clone(), folder.clone());
            self.with_window(cx, move |_, window, cx| {
                pane.update(cx, |pane, cx| pane.install_folder(folder, window, cx))
            })?;
        }
        let listed = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                let pane = pane.read(cx);
                !pane.is_busy() && !pane.listed().is_empty()
            })
            .await;
        let plugins = cx.update(|cx| pane.read(cx).listed());
        steps.check(
            "a plugin installed from a folder is listed in Settings › Plugins, off",
            listed
                && plugins
                    .first()
                    .is_some_and(|plugin| plugin.id == "dev.lattice.e2e" && !plugin.enabled),
            json!({ "plugins": plugins.iter().map(|p| (&p.id, p.enabled)).collect::<Vec<_>>(),
                    "error": cx.update(|cx| pane.read(cx).install_error()) }),
        );
        let Some(plugin) = plugins.first().cloned() else {
            return Ok(false);
        };
        self.plugin_shot(cx, "plugins-settings").await;
        {
            let (pane, plugin) = (pane.clone(), plugin.clone());
            self.with_window(cx, move |_, window, cx| {
                pane.update(cx, |pane, cx| pane.set_enabled(&plugin, true, window, cx))
            })?;
        }
        self.pause(cx, Duration::from_millis(100)).await;
        let (question, list) = cx.update(|cx| {
            let host = crate::confirm::install(cx).read(cx);
            (host.question(), host.question_list())
        });
        steps.check(
            "turning a plugin on first asks, listing what it may access in plain words",
            question.as_deref() == Some("Turn on Fixture?")
                && list
                    .iter()
                    .any(|line| line.as_ref() == "Read the open file, selection and cursor"),
            json!({ "question": question.map(|q| q.to_string()), "list": list.iter().map(|l| l.to_string()).collect::<Vec<_>>() }),
        );
        self.plugin_shot(cx, "plugins-confirm").await;
        self.with_window(cx, |_, window, cx| {
            crate::confirm::install(cx).update(cx, |host, cx| host.accept(window, cx))
        })?;
        let enabled = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                let pane = pane.read(cx);
                !pane.is_busy() && pane.listed().first().is_some_and(|plugin| plugin.enabled)
            })
            .await;
        let commands = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                crate::plugins::commands(cx).len() == 5
            })
            .await;
        steps.check(
            "a plugin turned on lists its commands for the palette",
            enabled && commands,
            json!({ "enabled": enabled, "commands": commands }),
        );
        self.with_window(cx, |shell, _, cx| shell.update(cx, |shell, cx| shell.close_settings(cx)))?;
        Ok(enabled && commands)
    }

    async fn plugins_checks(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        if !self.install_fixture_plugin(cx, steps).await? {
            return Ok(());
        }
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;

        // The palette's Plugins section.
        self.open_palette_now(cx)?;
        let rows = self.palette_rows_now(cx);
        let plugin_rows: Vec<&(String, String, Option<String>)> =
            rows.iter().filter(|(group, _, _)| group == "Plugins").collect();
        steps.check(
            "an empty palette lists the plugin's commands last, under Plugins, with their descriptions",
            plugin_rows.len() == 5
                && plugin_rows[0].1 == "Fixture: Find…"
                && plugin_rows[0].2.as_deref() == Some("Search the fixture's references.")
                && rows.last().is_some_and(|(group, _, _)| group == "Plugins"),
            json!({ "plugins": plugin_rows }),
        );
        self.palette_type(cx, "fixture check")?;
        let found = self.palette_rows_now(cx);
        steps.check(
            "a typed query finds a plugin command",
            found.first().is_some_and(|(_, label, _)| label == "Fixture: Check bibliography"),
            json!({ "found": found }),
        );
        self.palette_type(cx, "Fixture")?;
        self.plugin_shot(cx, "plugins-palette").await;

        // Input, items and an action.
        self.palette_run(cx, "Fixture: Find…")?;
        let asking = self.plugin_state_now(cx);
        self.plugin_shot(cx, "plugins-input").await;
        self.with_window(cx, |shell, window, cx| {
            if let Some(palette) = shell.read(cx).palette_view() {
                palette.update(cx, |palette, cx| palette.plugin_submit("knuth", window, cx));
            }
        })?;
        self.pause(cx, Duration::from_millis(150)).await;
        let running = self.plugin_state_now(cx);
        self.plugin_shot(cx, "plugins-running").await;
        let items = self.plugin_done(cx).await;
        steps.check(
            "a command that asks for text takes it in the palette, shows its progress, then its items",
            asking.as_ref().is_some_and(|(step, _)| *step == "input")
                && running.as_ref().is_some_and(|(step, _)| *step == "running")
                && items.as_ref().is_some_and(|(_, rows)| {
                    rows.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>()
                        == ["Literate Programming", "LaTeX: A Document Preparation System"]
                }),
            json!({ "asking": asking, "running": running, "items": items }),
        );
        self.plugin_shot(cx, "plugins-items").await;
        let acted = self.with_window(cx, |shell, window, cx| {
            shell.read(cx).palette_view().is_some_and(|palette| {
                palette.update(cx, |palette, cx| {
                    palette.plugin_act_on("Literate Programming", Some(1), window, cx)
                })
            })
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let copied = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
        let closed = cx.update(|cx| self.shell.read(cx).palette_view().is_none());
        steps.check(
            "an item's other action (Copy) runs from its button and the palette closes",
            acted && copied.as_deref() == Some("knuth84") && closed,
            json!({ "copied": copied, "closed": closed }),
        );

        // Diagnostics, grouped, and Return on one.
        self.run_plugin_row(cx, "Fixture: Check bibliography").await?;
        let diagnostics = self.plugin_done(cx).await;
        let shown: Vec<(String, String)> = diagnostics.clone().map(|(_, rows)| rows).unwrap_or_default();
        let expected = [
            ("file", "references.bib"),
            ("diagnostic", "Entry has no year"),
            ("diagnostic", "Title is not in braces"),
            ("file", "main.tex"),
            ("diagnostic", "Undefined citation key"),
        ];
        steps.check(
            "diagnostics are grouped by file, in the order the files first appear",
            shown.len() == expected.len()
                && shown.iter().zip(expected).all(|((kind, text), (k, t))| kind == k && text == t),
            json!({ "rows": shown }),
        );
        self.plugin_shot(cx, "plugins-diagnostics").await;
        let acted = self.with_window(cx, |shell, window, cx| {
            shell.read(cx).palette_view().is_some_and(|palette| {
                palette.update(cx, |palette, cx| {
                    palette.plugin_act_on("Undefined citation key", None, window, cx)
                })
            })
        })?;
        self.pause(cx, Duration::from_millis(400)).await;
        let place = cx.update(|cx| {
            self.shell.read(cx).active_editor().map(|editor| {
                let editor = editor.read(cx);
                (editor.relative().to_string(), editor.cursor().0)
            })
        });
        steps.check(
            "Return on a diagnostic opens its file at its line",
            acted && place.as_ref().is_some_and(|(file, line)| file == "main.tex" && *line == 4),
            json!({ "place": place }),
        );

        // A message, and the plugin's own error.
        self.run_plugin_row(cx, "Fixture: Notes").await?;
        let message = self.plugin_done(cx).await;
        steps.check(
            "a message result renders its Markdown",
            message.as_ref().is_some_and(|(_, rows)| {
                rows.first().is_some_and(|(kind, text)| kind == "message" && text.contains("# Notes"))
            }),
            json!({ "message": message }),
        );
        self.plugin_shot(cx, "plugins-message").await;
        self.run_plugin_row(cx, "Fixture: Fail").await?;
        let failed = self.plugin_done(cx).await;
        steps.check(
            "a plugin's own error shows inline in the palette, in its words",
            failed.as_ref().is_some_and(|(_, rows)| {
                rows.first().is_some_and(|(kind, text)| kind == "error" && text == "Zotero is not running")
            }),
            json!({ "failed": failed }),
        );
        self.plugin_shot(cx, "plugins-error").await;

        // A bibliography entry is written only once the writer confirms it.
        let bib = root.join("references.bib");
        let before = std::fs::read_to_string(&bib).unwrap_or_default();
        self.run_plugin_row(cx, "Fixture: Suggest a reference").await?;
        self.plugin_done(cx).await;
        self.with_window(cx, |shell, window, cx| {
            if let Some(palette) = shell.read(cx).palette_view() {
                palette.update(cx, |palette, cx| {
                    palette.plugin_act_on("Structured Programming", None, window, cx);
                });
            }
        })?;
        let asked = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .palette_view()
                    .and_then(|palette| palette.read(cx).plugin_state())
                    .is_some_and(|(step, _)| step == "confirm")
            })
            .await;
        let question = self
            .plugin_state_now(cx)
            .and_then(|(_, rows)| rows.first().map(|(_, text)| text.clone()));
        let untouched = std::fs::read_to_string(&bib).unwrap_or_default() == before;
        self.plugin_shot(cx, "plugins-bib-confirm").await;
        self.with_window(cx, |shell, window, cx| {
            if let Some(palette) = shell.read(cx).palette_view() {
                palette.update(cx, |palette, cx| palette.plugin_confirm_accept(window, cx));
            }
        })?;
        let written = self
            .wait_for(cx, Duration::from_secs(10), |_, _| {
                std::fs::read_to_string(&bib).is_ok_and(|text| text.contains("@book{dijkstra72,"))
            })
            .await;
        self.pause(cx, Duration::from_millis(200)).await;
        let after = std::fs::read_to_string(&bib).unwrap_or_default();
        let closed = cx.update(|cx| self.shell.read(cx).palette_view().is_none());
        steps.check(
            "Add to bibliography asks in the palette with the entry, and writes it only once the writer confirms, keeping the file's entries",
            asked
                && untouched
                && question.as_deref() == Some("Add this entry to references.bib?")
                && written
                && closed
                && after.starts_with(before.trim_end()),
            json!({ "asked": asked, "question": question, "untouched": untouched, "written": written, "closed": closed }),
        );
        std::fs::write(&bib, &before)?;
        self.with_window(cx, |shell, window, cx| shell.update(cx, |shell, cx| shell.close_overlays(window, cx)))?;
        if std::env::var_os("LATTICE_E2E_SHOTS").is_some() {
            self.plugin_parity_shots(cx, root).await?;
        }
        Ok(())
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 98,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/plugins",
        "gpui/crates/lattice-gpui/src/shell/palette/plugin",
        "gpui/crates/lattice-gpui/src/shell/plugin_actions.rs",
        "gpui/crates/lattice-gpui/src/settings/plugins_pane",
        "src-tauri/lattice-core/src/plugins",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.plugins_checks(cx, steps, &fixture.root)),
};
