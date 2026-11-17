#![cfg(target_os = "macos")]
//! Screenshots of plugins to set beside the Tauri app's
//! (`tools/perf-bench/bench-plugins.ts`, whose states the Tauri lane took
//! at 1280×820): three plugins written as the bench's (Zotero search with a
//! text input and items, Bib check with diagnostics, Crossref lookup off,
//! then asking for more), and each state taken in light and dark as
//! `<state>-<theme>-en-1280.png` under `LATTICE_E2E_SHOTS`. Only a shot
//! run takes them; the checks are `plugins.rs`'s.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, px, size};
use lattice_settings::{SettingsTab, ThemePreference};

use crate::scenario::Run;

/// The bench's runs: a progress line, then the answer 12 s later so the
/// progress row can be taken (the bench waits 1.5 s, but a shot here takes
/// several seconds to settle).
const MAIN_JS: &str = r#"
function send(m) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); }
function reply(id, result) { send({ id, result }); }
function result(command, input) {
  if (command === 'search') {
    const query = input || 'attention';
    return { kind: 'items', summary: '3 items for “' + query + '”', items: [
      { id: '1', title: 'Attention Is All You Need', subtitle: 'Vaswani, Shazeer, Parmar et al. · 2017', detail: 'Advances in Neural Information Processing Systems 30',
        badges: ['In bibliography'], actions: [{ type: 'insertCitation', key: 'vaswani2017attention' }, { type: 'copy', text: 'vaswani2017attention', title: 'Copy key' }] },
      { id: '2', title: 'Neural Machine Translation by Jointly Learning to Align and Translate', subtitle: 'Bahdanau, Cho, Bengio · 2015', detail: 'ICLR 2015',
        badges: [], actions: [{ type: 'addBibEntry', bibtex: '@inproceedings{bahdanau2015neural,\n  title = {Neural Machine Translation by Jointly Learning to Align and Translate},\n  author = {Bahdanau, Dzmitry and Cho, Kyunghyun and Bengio, Yoshua},\n  booktitle = {ICLR},\n  year = {2015}\n}', title: 'Add and cite' },
          { type: 'openUrl', url: 'https://arxiv.org/abs/1409.0473' }] },
      { id: '3', title: 'Effective Approaches to Attention-based Neural Machine Translation', subtitle: 'Luong, Pham, Manning · 2015', badges: ['Preprint'],
        actions: [{ type: 'addBibEntry', bibtex: '@article{luong2015effective,\n  title = {Effective Approaches to Attention-based Neural Machine Translation},\n  author = {Luong, Minh-Thang and Pham, Hieu and Manning, Christopher D.},\n  year = {2015}\n}' }] },
    ] };
  }
  if (command === 'check') {
    return { kind: 'diagnostics', summary: '3 problems in 2 files', items: [
      { id: 'a', file: 'references.bib', line: 12, severity: 'error', code: 'duplicate-key', message: 'The key vaswani2017attention is defined twice (also on line 48).', fixes: [] },
      { id: 'b', file: 'references.bib', line: 31, severity: 'warning', code: 'missing-field', message: '@article is missing the journal field.',
        fixes: [{ type: 'reveal', file: 'references.bib', line: 31, title: 'Show entry' }] },
      { id: 'c', file: 'chapters/related.bib', line: 4, severity: 'info', code: 'arxiv-published', message: 'This preprint has a published version (ICLR 2015).', fixes: [] },
    ] };
  }
  return { kind: 'message', summary: 'Entry complete', markdown: 'Filled **3 fields** from [Crossref](https://www.crossref.org).' };
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
    else if (m.method === 'command/run') {
      const { command, input } = m.params;
      send({ method: 'progress', params: { message: command === 'search' ? 'Asking Zotero…' : 'Reading references.bib…' } });
      setTimeout(() => reply(m.id, result(command, input)), 12000);
    } else if (m.method === '$/cancelRequest') send({ id: m.params.id, error: { code: -32800, message: 'cancelled' } });
  }
});
"#;

/// A plugin's manifest: its folder name, id, name, version, description,
/// licence, permissions (as `[permissions]` lines) and commands.
struct Plugin {
    folder: &'static str,
    id: &'static str,
    manifest: &'static str,
}

const ZOTERO: Plugin = Plugin {
    folder: "zotero-search",
    id: "dev.lattice.zotero-search",
    manifest: r#"schema = 1
id = "dev.lattice.zotero-search"
name = "Zotero search"
version = "0.1.0"
api = 1
license = "MIT"
description = "Search your Zotero library and cite from it."
runtime = "node"
main = "main.js"

[permissions]
project-read = ["bibliography"]
network-local = [23119]

[[commands]]
id = "search"
title = "Search Zotero…"
description = "Find an item and cite it."
input = { kind = "text", placeholder = "Title, author or citation key" }
"#,
};

const CHECK: Plugin = Plugin {
    folder: "bib-check",
    id: "dev.lattice.bib-check",
    manifest: r#"schema = 1
id = "dev.lattice.bib-check"
name = "Bib check"
version = "0.1.0"
api = 1
license = "MIT"
description = "Find duplicate keys and missing fields in the project's .bib files."
runtime = "node"
main = "main.js"

[permissions]
project-read = ["context", "bibliography"]

[[commands]]
id = "check"
title = "Check bibliography"
description = "Duplicate keys, DOIs and missing fields."
"#,
};

/// Crossref lookup as installed: off, asking for a network origin and a
/// secret.
const CROSSREF: Plugin = Plugin {
    folder: "crossref-lookup",
    id: "org.example.crossref-lookup",
    manifest: r#"schema = 1
id = "org.example.crossref-lookup"
name = "Crossref lookup"
version = "0.2.1"
api = 1
license = "Apache-2.0"
description = "Complete entries from Crossref by DOI."
runtime = "node"
main = "main.js"

[permissions]
project-read = ["context"]
network = ["https://api.crossref.org"]
secrets = ["mailto"]

[[commands]]
id = "complete"
title = "Complete entry"
"#,
};

impl Run {
    /// Write `plugin` under the scratch HOME and install it afresh.
    fn bench_plugin(&self, cx: &mut AsyncApp, plugin: &Plugin, manifest: &str) -> Result<()> {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default();
        let folder = home.join("bench-plugins").join(plugin.folder);
        std::fs::create_dir_all(&folder)?;
        std::fs::write(folder.join("lattice-plugin.toml"), manifest)?;
        std::fs::write(folder.join("main.js"), MAIN_JS)?;
        let host = cx.update(crate::plugins::host);
        let _ = host.remove(plugin.id);
        host.install_folder(&folder).map_err(anyhow::Error::msg)?;
        Ok(())
    }

    fn rewrite_manifest(&self, plugin: &Plugin, manifest: &str) -> Result<()> {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default();
        std::fs::write(
            home.join("bench-plugins")
                .join(plugin.folder)
                .join("lattice-plugin.toml"),
            manifest,
        )?;
        Ok(())
    }

    async fn bench_shot(&self, cx: &mut AsyncApp, state: &str, theme: &str) {
        self.pause(cx, Duration::from_millis(500)).await;
        self.snapshot(cx, &format!("{state}-{theme}-en-1280")).await;
    }

    async fn settings_pane_ready(
        &self,
        cx: &mut AsyncApp,
    ) -> Option<gpui::Entity<crate::settings::plugins_pane::PluginsPane>> {
        self.wait_for(cx, Duration::from_secs(10), |shell, cx| {
            let pane = shell
                .read(cx)
                .settings
                .as_ref()
                .and_then(|settings| settings.read(cx).plugins_pane());
            pane.is_some_and(|pane| !pane.read(cx).is_busy())
        })
        .await;
        cx.update(|cx| {
            self.shell
                .read(cx)
                .settings
                .as_ref()
                .and_then(|settings| settings.read(cx).plugins_pane())
        })
    }

    /// Every state, in `theme`.
    async fn bench_states(&self, cx: &mut AsyncApp, root: &Path, theme: &str) -> Result<()> {
        let host = cx.update(crate::plugins::host);
        let _ = host.remove("dev.lattice.e2e");
        for plugin in [&ZOTERO, &CHECK, &CROSSREF] {
            self.bench_plugin(cx, plugin, plugin.manifest)?;
        }
        host.set_enabled(ZOTERO.id, true).map_err(anyhow::Error::msg)?;
        host.set_enabled(CHECK.id, true).map_err(anyhow::Error::msg)?;
        cx.update(crate::plugins::refresh).await;
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;

        // The palette, a query, the input step, the progress row, items.
        self.open_palette_now(cx)?;
        self.palette_type(cx, "search")?;
        self.bench_shot(cx, "palette", theme).await;
        self.palette_run(cx, "Zotero search: Search Zotero…")?;
        self.with_window(cx, |shell, window, cx| {
            if let Some(palette) = shell.read(cx).palette_view() {
                palette.update(cx, |palette, cx| palette.plugin_type("attention", window, cx));
            }
        })?;
        self.bench_shot(cx, "input", theme).await;
        self.with_window(cx, |shell, window, cx| {
            if let Some(palette) = shell.read(cx).palette_view() {
                palette.update(cx, |palette, cx| palette.plugin_submit("attention", window, cx));
            }
        })?;
        self.bench_shot(cx, "progress", theme).await;
        self.plugin_done(cx).await;
        self.bench_shot(cx, "items", theme).await;

        // Add and cite: the entry, asked about in the palette.
        self.with_window(cx, |shell, window, cx| {
            if let Some(palette) = shell.read(cx).palette_view() {
                palette.update(cx, |palette, cx| {
                    palette.plugin_act_on(
                        "Neural Machine Translation by Jointly Learning to Align and Translate",
                        None,
                        window,
                        cx,
                    );
                });
            }
        })?;
        self.wait_for(cx, Duration::from_secs(5), |shell, cx| {
            shell
                .read(cx)
                .palette_view()
                .and_then(|palette| palette.read(cx).plugin_state())
                .is_some_and(|(step, _)| step == "confirm")
        })
        .await;
        self.bench_shot(cx, "confirm", theme).await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx))
        })?;

        // Diagnostics.
        self.open_palette_now(cx)?;
        self.palette_type(cx, "Bib check")?;
        self.pause(cx, Duration::from_millis(100)).await;
        self.palette_run(cx, "Bib check: Check bibliography")?;
        self.plugin_done(cx).await;
        self.bench_shot(cx, "diagnostics", theme).await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx))
        })?;

        // Settings › Plugins, turning Crossref lookup on, and its update.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_settings(Some(SettingsTab::Plugins), window, cx)
            })
        })?;
        let Some(pane) = self.settings_pane_ready(cx).await else {
            return Ok(());
        };
        self.with_window(cx, |_, window, cx| pane.update(cx, |pane, cx| pane.reload(window, cx)))?;
        self.settings_pane_ready(cx).await;
        self.bench_shot(cx, "settings", theme).await;
        let crossref = cx.update(|cx| {
            pane.read(cx)
                .listed()
                .into_iter()
                .find(|plugin| plugin.id == CROSSREF.id)
        });
        if let Some(crossref) = crossref {
            self.with_window(cx, |_, window, cx| {
                pane.update(cx, |pane, cx| pane.set_enabled(&crossref, true, window, cx))
            })?;
            self.bench_shot(cx, "permissions", theme).await;
            cx.update(|cx| crate::confirm::install(cx).update(cx, |host, cx| host.dismiss(cx)));
        }
        // Turned on with what it asked for before; its update asks for more.
        self.rewrite_manifest(
            &CROSSREF,
            &CROSSREF
                .manifest
                .replace("network = [\"https://api.crossref.org\"]\nsecrets = [\"mailto\"]\n", ""),
        )?;
        host.set_enabled(CROSSREF.id, true).map_err(anyhow::Error::msg)?;
        self.rewrite_manifest(&CROSSREF, &CROSSREF.manifest.replace("0.2.1", "0.3.0"))?;
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default();
        host.install_folder(&home.join("bench-plugins").join(CROSSREF.folder))
            .map_err(anyhow::Error::msg)?;
        self.with_window(cx, |_, window, cx| pane.update(cx, |pane, cx| pane.reload(window, cx)))?;
        self.settings_pane_ready(cx).await;
        self.with_window(cx, |shell, _, cx| {
            if let Some(settings) = shell.read(cx).settings.clone() {
                settings.update(cx, |settings, cx| settings.scroll_to_end(cx));
            }
        })?;
        self.bench_shot(cx, "review", theme).await;
        self.with_window(cx, |shell, _, cx| shell.update(cx, |shell, cx| shell.close_settings(cx)))?;
        Ok(())
    }

    /// The Tauri app's plugin states, at its size, in light and dark.
    pub(super) async fn plugin_parity_shots(&self, cx: &mut AsyncApp, root: &Path) -> Result<()> {
        let theme_before = cx.update(|cx| crate::settings::get(cx).theme_preference);
        self.with_window(cx, |_, window, _| window.resize(size(px(1280.), px(820.))))?;
        for (preference, theme) in [
            (ThemePreference::Light, "light"),
            (ThemePreference::Dark, "dark"),
        ] {
            cx.update(|cx| crate::settings::update(cx, |settings| settings.theme_preference = preference));
            self.pause(cx, Duration::from_millis(600)).await;
            self.bench_states(cx, root, theme).await?;
        }
        cx.update(|cx| crate::settings::update(cx, |settings| settings.theme_preference = theme_before));
        Ok(())
    }
}
