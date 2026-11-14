//! The Agent (`crate::agent`): Synara's panel and its Git workspace, each
//! the Agent island's page, the Tauri app's own Synara host.
//!
//! - shown, the Agent panel builds its island, its page loads and draws
//!   (on its sidebar ground, in the host's theme), and asks lattice-core's
//!   supervisor for the runtime: a scratch run has no Synara service staged,
//!   so the page shows the Tauri app's loading surface with what stopped it
//!   (or, with one staged and on macOS, the Agent's frame);
//! - the page is told of the editor in front, its caret and its selection,
//!   the inputs of its host context;
//! - hidden past the hibernation delay, its page and its turns stay;
//! - the backend commands it may invoke reach only the panel's project, and
//!   the bibliography takes only lattice-core's closed mutations, a removal
//!   previewed before anything is written;
//! - the titlebar's Git button opens the Git workspace as a tool panel, with
//!   its Changes / Pull requests header, and its close button closes it.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use lattice_ui::ActiveLattice as _;
use lattice_webview::IslandState;
use serde_json::json;

use super::{Run, Steps};
use crate::{agent::commands, native};

/// What the page shows: the loading surface's text and state, the frame,
/// the theme the bridge set and the shell's ground.
const PAGE_FACTS: &str = "(() => { const loading = document.querySelector('.synara-loading-surface'); \
     const shell = document.querySelector('.synara-frame-shell'); \
     return JSON.stringify({ host: typeof window.latticeHost, \
     loading: loading ? loading.textContent.trim().slice(0, 300) : null, \
     frame: !!document.querySelector('iframe.synara-poc-frame'), \
     ready: !!(shell && shell.dataset.ready), \
     ground: shell ? getComputedStyle(shell).backgroundColor : null, \
     theme: document.documentElement.dataset.theme || null }); })()";

const GIT_FACTS: &str = "(() => { const header = document.querySelector('.agent-git-workspace-header'); \
     return JSON.stringify({ header: !!header, \
     tabs: header ? [...header.querySelectorAll('[role=tab]')].map((tab) => tab.textContent.trim()) : [], \
     close: !!document.querySelector('.agent-git-workspace-close') }); })()";

/// Settings › Providers' page: Synara's settings frame, or the Tauri app's
/// loading surface while the runtime is missing or starting.
const SETTINGS_FACTS: &str = "(() => JSON.stringify({ \
     frame: !!document.querySelector('.synara-settings-frame[src*=\"/settings\"]'), \
     loading: !!document.querySelector('.synara-settings-state .synara-loading-surface') }))()";

impl Run {
    pub(super) async fn agent_islands(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        cx.update(|cx| lattice_webview::set_hibernate_after(Some(Duration::from_millis(1500)), cx));
        let main = self.open(cx, &root.join("main.tex"), Some(1))?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.show_view("agent", true, window, cx))
        })?;
        let surface = cx.update(|cx| self.shell.read(cx).agent.panel.read(cx).surface().clone());
        let island = cx.update(|cx| surface.read(cx).island().cloned());
        let Some(island) = island else {
            steps.check(
                "the Agent panel hosts the Agent island",
                false,
                json!({ "reason": "no island: the island pages are not built" }),
            );
            return Ok(());
        };
        let drawn = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                surface.read(cx).is_drawn()
            })
            .await;
        // The page asks for the runtime, which answers missing or ready.
        let mut facts = self.evaluate(cx, &island, PAGE_FACTS).await;
        for _ in 0..60 {
            if facts["loading"]
                .as_str()
                .is_some_and(|text| text.contains("missing") || text.contains("unavailable"))
                || facts["frame"] == true
            {
                break;
            }
            self.pause(cx, Duration::from_millis(250)).await;
            facts = self.evaluate(cx, &island, PAGE_FACTS).await;
        }
        // A frame (a runtime staged beside the app) must say it is ready:
        // Synara and the page then speak across the island's origin.
        if facts["frame"] == true {
            for _ in 0..160 {
                if facts["ready"] == true {
                    break;
                }
                self.pause(cx, Duration::from_millis(250)).await;
                facts = self.evaluate(cx, &island, PAGE_FACTS).await;
            }
        }
        let (state, stats, root_shown) = cx.update(|cx| {
            let island = island.read(cx);
            (
                island.state().clone(),
                island.stats().clone(),
                surface.read(cx).root().map(Path::to_path_buf),
            )
        });
        let chrome = cx.update(|cx| {
            let rgba = gpui::Rgba::from(cx.palette().chrome);
            format!(
                "rgb({}, {}, {})",
                (rgba.r * 255.).round(),
                (rgba.g * 255.).round(),
                (rgba.b * 255.).round()
            )
        });
        let theme = cx.update(|cx| {
            if cx.palette().is_dark() {
                "dark"
            } else {
                "light"
            }
        });
        steps.check(
            "shown, the Agent panel's island loads the Tauri app's Synara host, on its sidebar ground in the host's theme, and the runtime's state reaches it",
            drawn
                && state == IslandState::Ready
                && stats.builds == 1
                && root_shown.as_deref() == Some(root)
                && facts["host"] == "object"
                && facts["theme"] == theme
                && facts["ground"].as_str() == Some(chrome.as_str())
                && (facts["ready"] == true
                    || (facts["frame"] == false
                        && facts["loading"].as_str().is_some_and(|text| !text.is_empty()))),
            json!({ "drawn": drawn, "state": format!("{state:?}"), "stats": stats, "page": facts, "chrome": chrome }),
        );

        self.agent_shot(cx, "agent-panel").await?;

        // The editor in front and its selection, for the host context.
        self.with_window(cx, |_, window, cx| {
            main.update(cx, |main, cx| {
                main.editor().update(cx, |editor, cx| {
                    editor.select_all(&editor::actions::SelectAll, window, cx)
                })
            })
        })?;
        let told = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["activeFile"] == "main.tex"
                    && workspace["selectionSource"] == "editor"
                    && workspace["selection"]
                        .as_str()
                        .is_some_and(|text| text.contains("\\documentclass"))
            })
            .await;
        let workspace = cx.update(|cx| surface.read(cx).workspace().clone());
        steps.check(
            "the Agent is told of the editor in front, its caret and its selection with its lines",
            told && workspace["selectionLines"]["start"] == 1,
            json!({
                "activeFile": workspace["activeFile"],
                "editorPosition": workspace["editorPosition"],
                "selectionLines": workspace["selectionLines"],
            }),
        );

        // Hidden past the hibernation delay, the page and its turns stay.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.toggle_view("agent", window, cx))
        })?;
        self.pause(cx, Duration::from_millis(2500)).await;
        let (state, stats, visible) = cx.update(|cx| {
            let island = island.read(cx);
            (
                island.state().clone(),
                island.stats().clone(),
                island.native_visible(cx),
            )
        });
        steps.check(
            "hidden past the hibernation delay, the Agent's page stays, unlike a document's",
            state == IslandState::Ready && stats.hibernations == 0 && !visible,
            json!({ "state": format!("{state:?}"), "stats": stats, "visible": visible }),
        );
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.show_view("agent", true, window, cx))
        })?;

        // The brokers: only the panel's project, only the closed mutations.
        // Another folder, as another window's project would be.
        let elsewhere = root.with_file_name(format!(
            "{}-elsewhere",
            root.file_name()
                .map(|name| name.to_string_lossy())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&elsewhere)?;
        let ask = |command: &'static str, args: serde_json::Value| {
            let root = root.to_path_buf();
            move |cx: &mut gpui::App| commands::invoke(&root, command, &json!({ "args": args }), cx)
        };
        let other_root = elsewhere.to_string_lossy().into_owned();
        let own_root = root.to_string_lossy().into_owned();
        let refused = cx
            .update(ask(
                "remove_reference",
                json!({ "key": "knuth1984", "citationMode": "remove", "projectRoot": other_root }),
            ))
            .await;
        let forged = cx
            .update(ask(
                "agent_bibliography_mutation",
                json!({ "projectRoot": own_root, "mutation": { "action": "write_bib", "text": "@misc{x}" } }),
            ))
            .await;
        let preview = cx
            .update(ask(
                "remove_reference",
                json!({ "key": "knuth1984", "citationMode": "preview", "projectRoot": own_root }),
            ))
            .await;
        let bib = std::fs::read_to_string(root.join("references.bib")).unwrap_or_default();
        steps.check(
            "the Agent's bibliography brokers reach only the panel's project and only lattice-core's closed mutations; a removal is previewed first",
            refused.is_err()
                && forged.is_err()
                && preview
                    .as_ref()
                    .is_ok_and(|preview| preview["key"] == "knuth1984")
                && bib.contains("@book{knuth1984"),
            json!({
                "elsewhere": refused.err(),
                "forged": forged.err(),
                "preview": preview.as_ref().ok().map(|preview| &preview["key"]),
            }),
        );

        // The composer's width holds the panel open; the page's Provider
        // settings open Settings on Providers.
        self.evaluate(
            cx,
            &island,
            "(() => { window.latticeHost.post('agent:minimum-width', { width: 412 }); \
             window.latticeHost.post('agent:open-settings', { target: 'provider-binary-paths' }); \
             return 'true'; })()",
        )
        .await;
        let held = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                shell
                    .read(cx)
                    .view_min_size("agent", cx)
                    .is_some_and(|size| size.width == 412.)
            })
            .await;
        let providers = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                shell.read(cx).settings.as_ref().is_some_and(|dialog| {
                    dialog.read(cx).tab() == lattice_settings::SettingsTab::Agent
                })
            })
            .await;
        let min_size = cx.update(|cx| self.shell.read(cx).view_min_size("agent", cx));
        steps.check(
            "the composer's reported width becomes the Agent panel's minimum, and Provider settings opens Settings on Providers",
            held && providers,
            json!({ "min_size": min_size.map(|size| size.width), "providers": providers }),
        );
        // Settings › Providers is Synara's own page, the island's `settings`
        // surface: its loading surface without a runtime, its frame with one.
        let settings = cx.update(|cx| self.shell.read(cx).agent.settings.clone());
        let settings_drawn = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                settings.read(cx).is_drawn()
            })
            .await;
        let settings_island = cx.update(|cx| settings.read(cx).island().cloned());
        let mut settings_facts = serde_json::Value::Null;
        if let Some(island) = &settings_island {
            for _ in 0..80 {
                settings_facts = self.evaluate(cx, island, SETTINGS_FACTS).await;
                if settings_facts["frame"] == true || settings_facts["loading"] == true {
                    break;
                }
                self.pause(cx, Duration::from_millis(250)).await;
            }
        }
        let settings_shown = cx.update(|cx| {
            settings_island
                .as_ref()
                .is_some_and(|island| island.read(cx).is_active())
        });
        steps.check(
            "Settings › Providers hosts Synara's settings page in the Agent island's settings surface",
            settings_drawn
                && settings_shown
                && (settings_facts["frame"] == true || settings_facts["loading"] == true),
            json!({ "drawn": settings_drawn, "shown": settings_shown, "page": settings_facts }),
        );
        cx.update(|cx| self.shell.update(cx, |shell, cx| shell.close_settings(cx)));
        let settings_hidden = match &settings_island {
            Some(island) => {
                let island = island.clone();
                self.wait_for(cx, Duration::from_secs(3), move |_, cx| {
                    !island.read(cx).is_active()
                })
                .await
            }
            None => false,
        };
        steps.check(
            "closing Settings takes the Providers page off screen",
            settings_hidden,
            json!({}),
        );

        // The Git workspace, from the titlebar's Git button.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_git(None, window, cx))
        })?;
        let git = cx.update(|cx| self.shell.read(cx).agent.git.read(cx).surface().clone());
        let git_island = cx.update(|cx| git.read(cx).island().cloned());
        let git_drawn = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| git.read(cx).is_drawn())
            .await;
        let git_facts = match &git_island {
            Some(island) => self.evaluate(cx, island, GIT_FACTS).await,
            None => serde_json::Value::Null,
        };
        let on_screen = cx.update(|cx| self.shell.read(cx).view_on_screen("git", cx));
        steps.check(
            "the titlebar's Git button opens the Git workspace as a tool panel, with its Changes and Pull requests tabs",
            git_drawn
                && on_screen
                && git_facts["header"] == true
                && git_facts["tabs"].as_array().is_some_and(|tabs| tabs.len() == 2)
                && git_facts["close"] == true,
            json!({ "drawn": git_drawn, "on_screen": on_screen, "page": git_facts }),
        );
        self.agent_shot(cx, "git-workspace").await?;
        if let Some(island) = &git_island {
            self.evaluate(
                cx,
                island,
                "(() => { document.querySelector('.agent-git-workspace-close').click(); return 'true'; })()",
            )
            .await;
        }
        let closed = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                !shell.read(cx).view_on_screen("git", cx)
            })
            .await;
        steps.check(
            "the Git workspace's close button closes its tool panel",
            closed,
            json!({}),
        );
        cx.update(|cx| lattice_webview::set_hibernate_after(None, cx));
        Ok(())
    }

    /// The window as composited, page included, into `LATTICE_E2E_SHOTS`
    /// when it names a folder (the look review's side-by-sides).
    async fn agent_shot(&self, cx: &mut AsyncApp, name: &str) -> Result<()> {
        let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") else {
            return Ok(());
        };
        let out = Path::new(&dir).join(format!("{name}.png"));
        let number = native::window_number(self.native(cx)?);
        native::order_front(self.native(cx)?);
        self.pause(cx, Duration::from_millis(600)).await;
        let _ = std::process::Command::new("screencapture")
            .args(["-x", "-o", &format!("-l{number}")])
            .arg(&out)
            .status();
        Ok(())
    }
}
