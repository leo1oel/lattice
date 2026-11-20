//! The Agent in a window of its own (#1202, `agent/window.rs`): Open in
//! separate window moves the Agent's page, as it is, into a window of its
//! own; typing and ⌘V there reach the page and never the .tex editor in the
//! workspace, which still takes its own keys; closing the window brings the
//! page back, still not built again, and the window opens again where it
//! was left.

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AnyWindowHandle, AsyncApp, Bounds, Entity, Pixels};
use lattice_webview::Island;
use serde_json::{Value, json};

use super::{Run, Steps};
use crate::{editor_panel::EditorPanel, native};

/// A field in a child frame of the page's own origin, over it, whose focus
/// and presses the page's main frame never hears of, as Synara's composer.
const COMPOSER: &str = "(() => { const f = document.createElement('iframe'); f.id = 'lata62'; \
     f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;background:white'; \
     document.body.append(f); \
     f.contentDocument.body.innerHTML = '<textarea style=\"width:90%;height:90%\"></textarea>'; \
     return true; })()";
const COMPOSER_TEXT: &str = "(() => { const f = document.getElementById('lata62'); \
     return f ? f.contentDocument.querySelector('textarea').value : null; })()";
/// A mark the page keeps only while it is not loaded again.
const MARK: &str = "(() => { window.__lattice_kept = 'kept'; return true; })()";
const MARKED: &str = "(() => window.__lattice_kept || null)()";

impl Run {
    async fn agent_window(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        // A window opened in front activates the app.
        let _foreground = self.foreground(cx, "the Agent's own window").await?;
        let main = self.open(cx, &root.join("main.tex"), Some(1))?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.show_view("agent", true, window, cx))
        })?;
        let panel = cx.update(|cx| self.shell.read(cx).agent.panel.clone());
        let surface = cx.update(|cx| panel.read(cx).surface().clone());
        let Some(island) = cx.update(|cx| surface.read(cx).island().cloned()) else {
            steps.check(
                "Agent: Open in separate window moves the page, as it is, into a window of its own",
                false,
                json!({ "reason": "no island: the island pages are not built" }),
            );
            return Ok(());
        };
        let drawn = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| surface.read(cx).is_drawn())
            .await;
        let marked = self.evaluate(cx, &island, MARK).await;
        let builds = cx.update(|cx| island.read(cx).stats().builds);
        let windows = cx.update(|cx| cx.windows().len());
        let home = self.window;

        // Out: the page moves into the new window, not built again.
        cx.update(|cx| panel.update(cx, |panel, cx| panel.detach(cx)));
        let opened = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                cx.windows().len() == windows + 1
                    && panel.read(cx).window_handle().is_some_and(|handle| {
                        island.read(cx).window().window_id() == handle.window_id()
                    })
                    && island.read(cx).native_visible(cx)
            })
            .await;
        let agent_window = cx.update(|cx| panel.read(cx).window_handle());
        self.pause(cx, Duration::from_millis(400)).await;
        let out = self.page_facts(cx, &island, agent_window).await;
        let kept_out = self.evaluate(cx, &island, MARKED).await;
        let remembered_open = crate::agent::window::is_open(root);
        steps.check(
            "Agent: Open in separate window moves the page, as it is, into a window of its own, and the project remembers it there",
            drawn
                && marked == true
                && opened
                && kept_out == "kept"
                && out["builds"] == builds
                && out["fills"] == true
                && remembered_open,
            json!({ "drawn": drawn, "opened": opened, "kept": kept_out, "builds_before": builds, "page": out, "remembered_open": remembered_open }),
        );
        let Some(agent_window) = agent_window.filter(|_| opened) else {
            return Ok(());
        };

        // Fresh, its page never clicked: ⌘K still reaches the window's own
        // handler and opens the workspace's palette in front.
        let agent_native = agent_window.update(cx, |_, window, _| native::native(window))??;
        native::bring_to_front(agent_native);
        native::send_key(agent_native, 'k', true)?;
        let shell = self.shell.clone();
        let palette = self
            .wait_for(cx, Duration::from_secs(3), move |_, cx| {
                shell.read(cx).palette_view().is_some()
            })
            .await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx))
        })?;
        steps.check(
            "Agent: in its own window, before its page is ever clicked, ⌘K opens the workspace's palette in front",
            palette,
            json!({ "palette": palette }),
        );
        self.agent_window_keys(cx, steps, &main, &island, agent_window).await?;

        // Moved, the window's place is kept once it rests, with its display,
        // before anything closes it.
        native::move_window_by(agent_window.update(cx, |_, window, _| native::native(window))??, 40., 30.);
        let moved = agent_window.update(cx, |_, window, _| placed(window))?;
        let kept_moved = self
            .wait_for(cx, Duration::from_secs(3), |_, _| {
                crate::agent::window::frame(root)
                    .is_some_and(|kept| same_frame(&kept, moved) && kept.display.is_some())
            })
            .await;
        steps.check(
            "Agent: its window's place is kept once a move rests, with the display it is on",
            kept_moved,
            json!({ "moved": format!("{moved:?}"), "kept": format!("{:?}", crate::agent::window::frame(root)) }),
        );

        // Closing the window: the page comes back, still not built again,
        // and the window's frame is kept for the project.
        let frame = agent_window.update(cx, |_, window, _| placed(window))?;
        native::request_close(agent_window.update(cx, |_, window, _| native::native(window))??);
        let docked = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                cx.windows().len() == windows
                    && !panel.read(cx).is_detached()
                    && island.read(cx).window().window_id() == home.window_id()
                    && island.read(cx).native_visible(cx)
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        let back = self.page_facts(cx, &island, Some(home)).await;
        let workspace_keyboard = self.native(cx)?.view_has_keyboard();
        let kept_back = self.evaluate(cx, &island, MARKED).await;
        let (open_after, kept_frame) = (
            crate::agent::window::is_open(root),
            crate::agent::window::frame(root),
        );
        steps.check(
            "Agent: closing its window brings the page back to the panel as it was, and the project keeps where the window was",
            docked
                && workspace_keyboard
                && kept_back == "kept"
                && back["builds"] == builds
                && back["fills"] == true
                && !open_after
                && kept_frame.as_ref().is_some_and(|kept| same_frame(kept, frame)),
            json!({ "docked": docked, "workspace_keyboard": workspace_keyboard, "kept": kept_back, "page": back, "open": open_after, "frame": format!("{frame:?}"), "kept_frame": format!("{kept_frame:?}") }),
        );

        // Out again: where it was left.
        cx.update(|cx| panel.update(cx, |panel, cx| panel.detach(cx)));
        let reopened = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                cx.windows().len() == windows + 1 && island.read(cx).window().window_id() != home.window_id()
            })
            .await;
        let again = cx.update(|cx| panel.read(cx).window_handle());
        let frame_again = match again {
            Some(handle) => handle
                .update(cx, |_, window, _| placed(window))
                .ok(),
            None => None,
        };
        // As the panel's Return to workspace does: inside the workspace
        // window's own update, which closes the Agent's window from there.
        self.with_window(cx, |_, _, cx| panel.update(cx, |panel, cx| panel.dock(true, cx)))?;
        let returned = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                cx.windows().len() == windows
                    && island.read(cx).window().window_id() == home.window_id()
            })
            .await;
        let builds_end = cx.update(|cx| island.read(cx).stats().builds);
        steps.check(
            "Agent: its window opens again where it was left, and Return to workspace brings the page back without a reload",
            reopened
                && frame_again.is_some_and(|again| same_frame_bounds(again, frame))
                && returned
                && builds_end == builds,
            json!({ "reopened": reopened, "frame": format!("{frame:?}"), "again": format!("{frame_again:?}"), "returned": returned, "builds": builds_end }),
        );

        // Left where no display reaches now (a display unplugged since): it
        // opens at its default place instead, on screen.
        crate::agent::window::update(root, |remembered| {
            remembered.frame = Some(crate::pdf::preferences::WindowFrame {
                x: -5000.,
                y: 100.,
                width: 480.,
                height: 760.,
                display: Some("a display unplugged since".into()),
            })
        });
        cx.update(|cx| panel.update(cx, |panel, cx| panel.detach(cx)));
        let out_again = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                cx.windows().len() == windows + 1 && panel.read(cx).is_detached()
            })
            .await;
        let shown = match cx.update(|cx| panel.read(cx).window_handle()) {
            Some(handle) => handle
                .update(cx, |_, window, cx| {
                    let bounds = window.window_bounds().get_bounds();
                    let screen = window.display(cx).map(|display| display.bounds());
                    (format!("{bounds:?}"), screen.is_some_and(|screen| crate::window_place::reaches(bounds, screen)))
                })
                .ok(),
            None => None,
        };
        // ⌘⇧W in that fresh window, its page never clicked, takes it back.
        if let Some(handle) = cx.update(|cx| panel.read(cx).window_handle()) {
            let agent_native = handle.update(cx, |_, window, _| native::native(window))??;
            native::bring_to_front(agent_native);
            native::send_chord(agent_native, 'w', true, false, true)?;
        }
        let docked_again = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                cx.windows().len() == windows && island.read(cx).window().window_id() == home.window_id()
            })
            .await;
        // The workspace window takes the app forward again as it closes:
        // still within this foreground section.
        self.pause(cx, Duration::from_millis(400)).await;
        steps.check(
            "Agent: a window left where no display reaches opens at its default place, on screen, and ⌘⇧W there brings the Agent back",
            out_again && shown.as_ref().is_some_and(|(_, on_screen)| *on_screen) && docked_again,
            json!({ "opened": out_again, "shown": format!("{shown:?}"), "docked": docked_again }),
        );

        // ⌘W in a fresh window does the same, as Close Tab in the workspace.
        cx.update(|cx| panel.update(cx, |panel, cx| panel.detach(cx)));
        let out_last = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                cx.windows().len() == windows + 1 && panel.read(cx).is_detached()
            })
            .await;
        if let Some(handle) = cx.update(|cx| panel.read(cx).window_handle()) {
            let agent_native = handle.update(cx, |_, window, _| native::native(window))??;
            native::bring_to_front(agent_native);
            native::send_key(agent_native, 'w', true)?;
        }
        let closed_by_key = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                cx.windows().len() == windows && island.read(cx).window().window_id() == home.window_id()
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        steps.check(
            "Agent: ⌘W in its own window, before its page is ever clicked, brings the Agent back to the workspace",
            out_last && closed_by_key,
            json!({ "opened": out_last, "docked": closed_by_key }),
        );
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.show_view("agent", false, window, cx))
        })?;
        Ok(())
    }

    /// In the Agent's window, a click in the composer, typing and ⌘V reach
    /// the page and leave the .tex editor alone; the editor, in the
    /// workspace, then takes its own keys.
    async fn agent_window_keys(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        main: &Entity<EditorPanel>,
        island: &Entity<Island>,
        agent_window: AnyWindowHandle,
    ) -> Result<()> {
        const STEP: &str = "Agent: in its own window, typing and ⌘V go to the composer and never to the .tex editor, which still takes its own keys";
        let _foreground = self.foreground(cx, "the Agent's window takes the keyboard").await?;
        let editor_text = |cx: &mut AsyncApp| cx.update(|cx| main.read(cx).editor().read(cx).text(cx));
        let before = editor_text(cx);
        let framed = self.evaluate(cx, island, COMPOSER).await;
        let agent_native = agent_window.update(cx, |_, window, _| native::native(window))??;
        native::bring_to_front(agent_native);
        let key = self
            .wait_for(cx, Duration::from_secs(2), |_, cx| {
                agent_window
                    .update(cx, |_, window, _| window.is_window_active())
                    .unwrap_or(false)
            })
            .await;
        let bounds = cx
            .update(|cx| island.read(cx).bounds(cx))
            .context("the Agent's page has no bounds")?;
        native::send_click(agent_native, bounds.center())?;
        let in_page = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| island.read(cx).page_focused())
            .await;
        for character in ['l', 'a', 't', 't'] {
            native::send_key(agent_native, character, false)?;
        }
        // WebKit takes typed keys in turn, after the paste would be done.
        for _ in 0..30 {
            if self.evaluate(cx, island, COMPOSER_TEXT).await == "latt" {
                break;
            }
            self.pause(cx, Duration::from_millis(100)).await;
        }
        cx.update(|cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(" pasted".into())));
        native::send_key_equivalent(agent_native, 'v')?;
        self.pause(cx, Duration::from_millis(600)).await;
        let composer = self.evaluate(cx, island, COMPOSER_TEXT).await;
        let untouched = editor_text(cx) == before;

        // The workspace again: its editor takes its keys.
        native::bring_to_front(self.native(cx)?);
        let editor = main.clone();
        self.with_window(cx, move |_, window, cx| {
            let handle = gpui::Focusable::focus_handle(editor.read(cx).editor().read(cx), cx);
            window.focus(&handle, cx);
        })?;
        // The workspace's own first responder is GPUI's view; the page keeps
        // the Agent window's, which is that window's alone.
        let workspace = self.native(cx)?;
        let gpui_keyboard = self
            .wait_for(cx, Duration::from_secs(3), |_, _| workspace.view_has_keyboard())
            .await;
        native::send_key(self.native(cx)?, 'q', false)?;
        let typed = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                main.read(cx).editor().read(cx).text(cx) != before
            })
            .await;
        native::send_key(self.native(cx)?, 'z', true)?;
        let undone = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                main.read(cx).editor().read(cx).text(cx) == before
            })
            .await;
        steps.check(
            STEP,
            framed == true
                && key
                && in_page
                && composer == "latt pasted"
                && untouched
                && gpui_keyboard
                && typed
                && undone,
            json!({ "framed": framed, "key": key, "in_page": in_page, "composer": composer, "editor_untouched": untouched, "gpui_keyboard": gpui_keyboard, "editor_typed": typed, "undone": undone }),
        );
        Ok(())
    }

    /// The page's builds, and whether its view fills the window it is in.
    async fn page_facts(
        &self,
        cx: &mut AsyncApp,
        island: &Entity<Island>,
        window: Option<AnyWindowHandle>,
    ) -> Value {
        let (builds, bounds, frame) = cx.update(|cx| {
            let island = island.read(cx);
            (island.stats().builds, island.bounds(cx), island.native_frame(cx))
        });
        let viewport = window.and_then(|handle| {
            handle
                .update(cx, |_, window, _| window.viewport_size())
                .ok()
        });
        let fills = match (bounds, frame) {
            (Some(bounds), Some(frame)) => {
                (f32::from(bounds.size.width) - f32::from(frame.size.width)).abs() <= 1.
                    && f32::from(bounds.size.width) > 200.
            }
            _ => false,
        };
        json!({
            "builds": builds,
            "fills": fills,
            "bounds": format!("{bounds:?}"),
            "native": format!("{frame:?}"),
            "viewport": format!("{viewport:?}"),
        })
    }
}

/// Where the window is and the size of what it shows.
fn placed(window: &gpui::Window) -> Bounds<Pixels> {
    Bounds {
        origin: window.window_bounds().get_bounds().origin,
        size: window.viewport_size(),
    }
}

fn same_frame(kept: &crate::pdf::preferences::WindowFrame, bounds: Bounds<Pixels>) -> bool {
    (kept.x - f32::from(bounds.origin.x)).abs() <= 1.
        && (kept.y - f32::from(bounds.origin.y)).abs() <= 1.
        && (kept.width - f32::from(bounds.size.width)).abs() <= 1.
        && (kept.height - f32::from(bounds.size.height)).abs() <= 1.
}

fn same_frame_bounds(a: Bounds<Pixels>, b: Bounds<Pixels>) -> bool {
    (f32::from(a.origin.x) - f32::from(b.origin.x)).abs() <= 1.
        && (f32::from(a.origin.y) - f32::from(b.origin.y)).abs() <= 1.
        && (f32::from(a.size.width) - f32::from(b.size.width)).abs() <= 1.
        && (f32::from(a.size.height) - f32::from(b.size.height)).abs() <= 1.
}

/// This file's registration as the e2e module `agent_window` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 91,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/agent.rs",
        "gpui/crates/lattice-gpui/src/agent/window.rs",
        "gpui/crates/lattice-webview/src/island",
        "gpui/patches/gpui-webview",
        "gpui/patches/gpui-webview-move-window.diff",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.agent_window(cx, steps, &fixture.root)),
};
