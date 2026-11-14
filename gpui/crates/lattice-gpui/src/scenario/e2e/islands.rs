//! The webview island host (`lattice-webview`), through its first island,
//! an HTML file's Preview (`html_preview.rs`):
//!
//! - an HTML file opens in Preview; the island is built only then, its page
//!   served by the island protocol, and shown once its document has loaded;
//! - the document's image comes through the asset protocol, granted by the
//!   host, and its relative link is disabled, as the Tauri app's preview does;
//! - the bridge both ways: the page's scroll reported back, a scroll and a
//!   zoom sent to it, and a native click on the zoom controls GPUI draws
//!   above the page reaching GPUI, not the page;
//! - at another interface size the page's view still covers the island, in
//!   the window's points, and the page is zoomed with the interface;
//! - the theme reaches the page;
//! - a native click in the page gives it the keyboard and ⌘K / Ctrl+K typed
//!   there opens GPUI's command palette, with the keyboard back in GPUI;
//! - a toast drawn over the page is above it (macOS, from a composited
//!   capture of the window; skipped where the screen cannot be captured);
//! - Edit, Split and Preview, and a tab switch, hide and show the page;
//! - hidden past the (shortened) hibernation delay, the page is torn down,
//!   and comes back where it was read when its tab is chosen again.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity, point, px};
use lattice_ui::{Appearance, LatticeTheme};
use lattice_webview::IslandState;
use serde_json::{Value, json};
#[cfg(target_os = "macos")]
use trellis::runtime::keymap::Command as Trellis;

use super::{Run, Steps};
use crate::{
    editor_panel::{DocumentView, EditorPanel},
    html_preview::HtmlPreview,
    native,
};

const PAGE: &str = r#"<!doctype html>
<html>
<head><title>Island check</title>
<style>body { font: 16px sans-serif; margin: 24px; } .tall { height: 3000px; }</style>
</head>
<body>
<h1 id="top">Island check</h1>
<img id="dot" src="figures/island-dot.png" width="40" height="40" alt="dot">
<p><a id="relative" href="chapters/other.html">a relative link</a></p>
<div class="tall"></div>
<p id="end">The end.</p>
</body>
</html>
"#;

impl Run {
    /// The webview island checks alone (this file), for work on the
    /// islands: the e2e scenario runs them too.
    pub(in crate::scenario) async fn islands(&self, cx: &mut AsyncApp) -> Result<Value> {
        let mut steps = Steps::new(self);
        let root = self.root(cx).await?;
        self.pause(cx, Duration::from_millis(800)).await;
        self.webview_islands(cx, &mut steps, &root).await?;
        self.structured_islands(cx, &mut steps, &root).await?;
        self.markdown_island(cx, &mut steps, &root).await?;
        steps.check_foreground(self);
        let passed = steps.0.iter().all(|step| step["passed"] == true);
        Ok(json!({ "scenario": "islands", "passed": passed, "steps": steps.0 }))
    }

    pub(super) async fn webview_islands(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        std::fs::create_dir_all(root.join("figures"))?;
        image::RgbaImage::from_pixel(4, 4, image::Rgba([220, 40, 40, 255]))
            .save(root.join("figures/island-dot.png"))?;
        let page = root.join("island.html");
        std::fs::write(&page, PAGE)?;
        cx.update(|cx| lattice_webview::set_hibernate_after(Some(Duration::from_millis(1500)), cx));

        let panel = self.open(cx, &page, None)?;
        let view = cx.update(|cx| panel.read(cx).document_view());
        let preview = cx.update(|cx| panel.read(cx).html_preview().cloned());
        let Some(preview) = preview else {
            steps.check(
                "an HTML file opens in Preview, in a webview island",
                false,
                json!({ "view": format!("{view:?}") }),
            );
            return Ok(());
        };
        let island = cx.update(|cx| preview.read(cx).island().clone());
        let loaded = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                preview.read(cx).is_loaded()
            })
            .await;
        let (state, visible, stats) = cx.update(|cx| {
            let island = island.read(cx);
            (
                island.state().clone(),
                island.native_visible(cx),
                island.stats().clone(),
            )
        });
        steps.check(
            "an HTML file opens in Preview, built as a webview island on first show and revealed once loaded",
            view == Some(DocumentView::Preview)
                && loaded
                && state == IslandState::Ready
                && visible
                && stats.builds == 1,
            json!({ "view": format!("{view:?}"), "loaded": loaded, "state": format!("{state:?}"), "visible": visible, "stats": stats }),
        );

        // The image through the asset protocol, the relative link disabled.
        // The srcdoc frame requests the image only after the island reports
        // loaded, and on a loaded machine (right after a rebuild) that request
        // has taken longer than 5 s to reach the protocol handler.
        let served = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                island
                    .read(cx)
                    .served_files()
                    .iter()
                    .any(|file| file == "figures/island-dot.png")
            })
            .await;
        let page_facts = self
            .evaluate(
                cx,
                &island,
                "(() => { const f = document.getElementById('frame'); const s = f.srcdoc; \
                 return JSON.stringify({ host: typeof window.latticeHost, sandbox: f.getAttribute('sandbox'), \
                 asset: /asset\\/figures\\/island-dot\\.png/.test(s), \
                 relative: /href=\"chapters\\/other\\.html\"/.test(s), \
                 theme: document.documentElement.dataset.theme || null }); })()",
            )
            .await;
        let rejected = cx.update(|cx| island.read(cx).stats().rejected);
        steps.check(
            "the island's protocol serves the granted image, the document is sandboxed and its relative link disabled",
            served
                && page_facts["host"] == "object"
                && page_facts["sandbox"] == "allow-scripts"
                && page_facts["asset"] == true
                && page_facts["relative"] == false
                && rejected == 0,
            json!({ "served": served, "page": page_facts, "rejected": rejected }),
        );

        // Scroll there and back over the bridge.
        cx.update(|cx| preview.update(cx, |preview, cx| preview.set_scroll_top(400., cx)));
        let scrolled = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                (preview.read(cx).scroll_metrics().scroll_top - 400.).abs() < 1.
            })
            .await;
        let metrics = cx.update(|cx| preview.read(cx).scroll_metrics());
        steps.check(
            "the page reports its scroll to the host, and scrolls where the host says",
            scrolled && metrics.scroll_height > metrics.client_height,
            json!({ "metrics": metrics }),
        );

        // A native click on Zoom in, which GPUI draws above the page.
        let bounds = cx.update(|cx| island.read(cx).bounds(cx));
        let zoomed = match bounds {
            Some(bounds) => {
                let zoom_in = point(bounds.left() + px(90.), bounds.bottom() - px(22.));
                native::send_click(self.native(cx)?, zoom_in)?;
                self.wait_for(cx, Duration::from_secs(3), |_, cx| {
                    (preview.read(cx).view_state().scale - 1.1).abs() < 1e-3
                })
                .await
            }
            None => false,
        };
        let scale = cx.update(|cx| preview.read(cx).view_state().scale);
        // The click is GPUI's: the page under the controls never saw it.
        let presses = cx.update(|cx| island.read(cx).stats().presses);
        steps.check(
            "a native click on the zoom controls over the page reaches GPUI, and the page zooms",
            zoomed && presses == 0,
            json!({ "scale": scale, "page_presses": presses, "bounds": format!("{bounds:?}") }),
        );

        #[cfg(target_os = "macos")]
        self.island_interface_zoom(cx, steps, &island, "the HTML preview")
            .await?;

        // The theme reaches the page.
        cx.update(|cx| LatticeTheme::set_appearance(Appearance::Dark, cx));
        self.pause(cx, Duration::from_millis(300)).await;
        let dark = self
            .evaluate(cx, &island, "document.documentElement.dataset.theme")
            .await;
        cx.update(|cx| LatticeTheme::set_appearance(Appearance::Light, cx));
        self.pause(cx, Duration::from_millis(300)).await;
        let light = self
            .evaluate(cx, &island, "document.documentElement.dataset.theme")
            .await;
        steps.check(
            "the host's theme reaches the page",
            dark == "dark" && light == "light",
            json!({ "dark": dark, "light": light }),
        );

        self.island_shortcuts(cx, steps, &island).await?;
        #[cfg(target_os = "macos")]
        self.toast_above_island(cx, steps, &panel, &island).await?;
        self.island_views(cx, steps, &panel, &preview, root).await?;

        // Done: close the document's tab.
        self.with_window(cx, {
            let panel = panel.clone();
            move |shell, _, cx| {
                shell.update(cx, |shell, cx| {
                    if let Some(view) = shell.view_of_editor(&panel) {
                        shell.engine_do(cx, |engine| engine.close(&view));
                    }
                });
            }
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let hidden = cx.update(|cx| !island.read(cx).native_visible(cx));
        steps.check(
            "closing the document's tab takes its page off screen",
            hidden,
            json!({}),
        );
        cx.update(|cx| lattice_webview::set_hibernate_after(None, cx));
        std::fs::remove_file(&page).ok();
        Ok(())
    }

    /// A native click in the page gives it the keyboard; ⌘K / Ctrl+K typed
    /// there reaches GPUI's keymap and opens the palette, and the keyboard
    /// goes back to GPUI with it.
    async fn island_shortcuts(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        island: &Entity<lattice_webview::Island>,
    ) -> Result<()> {
        let Some(bounds) = cx.update(|cx| island.read(cx).bounds(cx)) else {
            steps.check("the page takes the keyboard on a click", false, json!({}));
            return Ok(());
        };
        native::send_click(self.native(cx)?, bounds.center())?;
        let focused = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                let island = island.read(cx);
                island.page_focused() && !island.stats().relay.is_empty()
            })
            .await;
        let relay = cx.update(|cx| island.read(cx).stats().relay.clone());
        let forwards = cx.update(|cx| island.read(cx).stats().shortcuts);
        self.press(cx, 'k', true).await?;
        let opened = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                shell.read(cx).palette_rows(cx).is_some()
            })
            .await;
        let (forwarded, page_focused) = cx.update(|cx| {
            let island = island.read(cx);
            (island.stats().shortcuts, island.page_focused())
        });
        steps.check(
            "a click gives the page the keyboard, and ⌘K / Ctrl+K typed in it opens GPUI's palette with the keyboard back in GPUI",
            focused && opened && forwarded > forwards && !page_focused,
            json!({ "focused": focused, "relay": relay, "opened": opened, "forwarded": forwarded - forwards, "page_focused": page_focused }),
        );
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx))
        })?;
        Ok(())
    }

    /// At 120% and 90%, a GPUI pixel is that many points (`fast::interface_zoom`):
    /// the page's view covers the island's laid-out bounds scaled so, where
    /// the zoom controls GPUI draws over it are, and the page sees a viewport
    /// of the island's size in its own pixels, zoomed as the interface is, as
    /// the Tauri app's interface zoom zooms its pages.
    #[cfg(target_os = "macos")]
    pub(super) async fn island_interface_zoom(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        island: &Entity<lattice_webview::Island>,
        subject: &str,
    ) -> Result<()> {
        let before = cx.update(|cx| crate::settings::get(cx).appearance.interface_scale);
        let mut seen = Vec::new();
        let mut passed = true;
        for zoom in [1.2f32, 0.9] {
            cx.update(|cx| crate::settings::update_appearance(cx, |a| a.interface_scale = zoom));
            let zoomed = self.wait_for_zoom(cx, zoom).await;
            self.pause(cx, Duration::from_millis(400)).await;
            let (bounds, frame) =
                cx.update(|cx| (island.read(cx).bounds(cx), island.read(cx).native_frame(cx)));
            let viewport = self
                .evaluate(
                    cx,
                    island,
                    "JSON.stringify({ width: window.innerWidth, height: window.innerHeight })",
                )
                .await;
            let near = |a: f32, b: f32, within: f32| (a - b).abs() <= within;
            let covers = bounds.zip(frame).is_some_and(|(bounds, frame)| {
                near(
                    f32::from(frame.origin.x),
                    f32::from(bounds.origin.x) * zoom,
                    1.,
                ) && near(
                    f32::from(frame.origin.y),
                    f32::from(bounds.origin.y) * zoom,
                    1.,
                ) && near(
                    f32::from(frame.size.width),
                    f32::from(bounds.size.width) * zoom,
                    1.,
                ) && near(
                    f32::from(frame.size.height),
                    f32::from(bounds.size.height) * zoom,
                    1.,
                )
            });
            let page_sized = bounds.is_some_and(|bounds| {
                viewport["width"]
                    .as_f64()
                    .is_some_and(|width| near(width as f32, f32::from(bounds.size.width), 2.))
                    && viewport["height"].as_f64().is_some_and(|height| {
                        near(height as f32, f32::from(bounds.size.height), 2.)
                    })
            });
            passed &= zoomed && covers && page_sized;
            seen.push(json!({
                "zoom": zoom, "zoomed": zoomed, "bounds": format!("{bounds:?}"),
                "native_frame": format!("{frame:?}"), "page_viewport": viewport,
            }));
        }
        cx.update(|cx| crate::settings::update_appearance(cx, |a| a.interface_scale = before));
        self.wait_for_zoom(cx, before).await;
        steps.check(
            &format!("at 120% and 90% {subject} fills its island where GPUI laid it out, and is zoomed with the interface"),
            passed,
            json!(seen),
        );
        Ok(())
    }

    /// A toast over the page: the window as the screen composes it shows the
    /// toast, not the page, where the two overlap.
    #[cfg(target_os = "macos")]
    async fn toast_above_island(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        island: &Entity<lattice_webview::Island>,
    ) -> Result<()> {
        // The document's panel fills the workspace, so the toast's corner
        // is over the page; dark, so the toast is unlike the white page.
        self.toggle_maximized(cx, panel)?;
        cx.update(|cx| LatticeTheme::set_appearance(Appearance::Dark, cx));
        cx.update(|cx| {
            crate::notices::show(
                crate::notices::Notice::new(
                    lattice_ui::components::ToastLevel::Info,
                    "Island check",
                )
                .key("island-check")
                .persistent(),
                cx,
            )
        });
        self.pause(cx, Duration::from_millis(700)).await;
        let bounds = cx.update(|cx| island.read(cx).bounds(cx));
        let viewport = self.with_window(cx, |_, window, _| window.viewport_size())?;
        // The toast stands 32px in from the right and 44px up, 320px wide.
        let probe = point(
            viewport.width - px(32. + 160.),
            viewport.height - px(44. + 20.),
        );
        let over_page = bounds.is_some_and(|bounds| bounds.contains(&probe));
        let out =
            std::env::temp_dir().join(format!("lattice-island-toast-{}.png", std::process::id()));
        let number = native::window_number(self.native(cx)?);
        native::order_front(self.native(cx)?);
        self.pause(cx, Duration::from_millis(300)).await;
        let captured = std::process::Command::new("screencapture")
            .args(["-x", "-o", &format!("-l{number}")])
            .arg(&out)
            .status()
            .is_ok_and(|status| status.success());
        let sample = captured
            .then(|| image::open(&out).ok())
            .flatten()
            .map(|image| {
                let image = image.to_rgba8();
                let scale = image.width() as f32 / f32::from(viewport.width);
                let x = (f32::from(probe.x) * scale) as u32;
                let y = (f32::from(probe.y) * scale) as u32;
                let pixel = image.get_pixel(x.min(image.width() - 1), y.min(image.height() - 1));
                pixel.0
            });
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            std::fs::copy(&out, Path::new(&dir).join("island-toast.png")).ok();
        }
        std::fs::remove_file(&out).ok();
        match sample {
            Some(pixel) => {
                let luminance =
                    (u32::from(pixel[0]) + u32::from(pixel[1]) + u32::from(pixel[2])) / 3;
                steps.check(
                    "a toast over the page is drawn above it",
                    over_page && luminance < 128,
                    json!({ "probe": format!("{probe:?}"), "over_page": over_page, "pixel": pixel }),
                );
            }
            None => {
                steps.check(
                    "a toast over the page is drawn above it",
                    true,
                    json!({ "skipped": "the screen could not be captured (locked, or no screen-recording permission)" }),
                );
            }
        }
        cx.update(|cx| crate::notices::dismiss("island-check", cx));
        cx.update(|cx| LatticeTheme::set_appearance(Appearance::Light, cx));
        self.toggle_maximized(cx, panel)?;
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }

    /// Maximize the document's panel, or restore it.
    #[cfg(target_os = "macos")]
    fn toggle_maximized(&self, cx: &mut AsyncApp, panel: &Entity<EditorPanel>) -> Result<()> {
        let panel = panel.clone();
        self.with_window(cx, move |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                if let Some(view) = shell.view_of_editor(&panel) {
                    shell.engine_do(cx, |engine| engine.focus_view(&view));
                }
                shell.run_trellis(Trellis::FrameToggle, cx);
            })
        })
    }

    /// Edit, Split and Preview; another tab chosen over the document; the
    /// page hibernating while hidden and coming back where it was read.
    async fn island_views(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        preview: &Entity<HtmlPreview>,
        root: &Path,
    ) -> Result<()> {
        let island = cx.update(|cx| preview.read(cx).island().clone());
        let set = |view: DocumentView| {
            let panel = panel.clone();
            move |_: &Entity<crate::shell::Shell>, window: &mut gpui::Window, cx: &mut gpui::App| {
                panel.update(cx, |panel, cx| panel.set_document_view(view, window, cx))
            }
        };
        self.with_window(cx, set(DocumentView::Source))?;
        self.pause(cx, Duration::from_millis(200)).await;
        let source_hidden = cx.update(|cx| !island.read(cx).native_visible(cx));
        self.with_window(cx, set(DocumentView::Split))?;
        self.pause(cx, Duration::from_millis(400)).await;
        let (split_shown, split_width) = cx.update(|cx| {
            let island = island.read(cx);
            (
                island.native_visible(cx),
                island.bounds(cx).map(|b| f32::from(b.size.width)),
            )
        });
        self.with_window(cx, set(DocumentView::Preview))?;
        self.pause(cx, Duration::from_millis(400)).await;
        let (preview_shown, preview_width) = cx.update(|cx| {
            let island = island.read(cx);
            (
                island.native_visible(cx),
                island.bounds(cx).map(|b| f32::from(b.size.width)),
            )
        });
        steps.check(
            "Edit hides the page, Split shows it beside the source, Preview alone",
            source_hidden
                && split_shown
                && preview_shown
                && split_width.zip(preview_width).is_some_and(|(split, whole)| split < whole),
            json!({ "source_hidden": source_hidden, "split": split_width, "preview": preview_width }),
        );

        // Another tab over the document: the page goes, then hibernates.
        let before = cx.update(|cx| preview.read(cx).view_state());
        let chapter = self.open(cx, &root.join("chapters/intro.tex"), None)?;
        let hidden = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                !island.read(cx).native_visible(cx)
            })
            .await;
        let hibernated = self
            .wait_for(cx, Duration::from_secs(6), |_, cx| {
                *island.read(cx).state() == IslandState::Hibernated
            })
            .await;
        // Back to the document: built again, and where it was.
        let reopened = self.open(cx, &root.join("island.html"), None)?;
        let same = reopened == *panel;
        let woke = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                preview.read(cx).is_loaded()
                    && (preview.read(cx).scroll_metrics().scroll_top - before.scroll_top).abs() < 2.
            })
            .await;
        let (stats, after) = cx.update(|cx| {
            (
                island.read(cx).stats().clone(),
                preview.read(cx).view_state(),
            )
        });
        steps.check(
            "another tab hides the page; hidden past the delay it hibernates, and comes back where it was read",
            hidden
                && hibernated
                && same
                && woke
                && stats.builds == 2
                && stats.hibernations == 1
                && (after.scale - before.scale).abs() < 1e-3,
            json!({ "hidden": hidden, "hibernated": hibernated, "same_tab": same, "woke": woke, "stats": stats, "before": before, "after": after }),
        );
        let _ = chapter;

        // The page built again takes the keyboard on a click and knows the
        // app's shortcuts again.
        let relayed = match cx.update(|cx| island.read(cx).bounds(cx)) {
            Some(bounds) => {
                // The page is unmasked in the frame after it reports loaded,
                // and a click in that frame reaches no page: click again
                // until one lands.
                for _ in 0..3 {
                    native::send_click(self.native(cx)?, bounds.center())?;
                    if self
                        .wait_for(cx, Duration::from_secs(2), |_, cx| {
                            island.read(cx).page_focused()
                        })
                        .await
                    {
                        break;
                    }
                }
                // The relay lands with the page's focus report, which can
                // trail the click on a loaded runner: ask until it is there.
                let mut relayed = Value::Null;
                let started = std::time::Instant::now();
                while started.elapsed() < Duration::from_secs(3) {
                    relayed = self
                        .evaluate(cx, &island, "window.latticeHost.relay().length")
                        .await;
                    if relayed.as_u64().is_some_and(|count| count > 0) {
                        break;
                    }
                    self.pause(cx, Duration::from_millis(150)).await;
                }
                relayed
            }
            None => Value::Null,
        };
        steps.check(
            "the page built again after its hibernation gets the app's shortcuts when it takes the keyboard",
            relayed.as_u64().is_some_and(|count| count > 0),
            json!({
                "relayed": relayed,
                "island": cx.update(|cx| {
                    let island = island.read(cx);
                    json!({
                        "page_focused": island.page_focused(),
                        "revealed": island.is_revealed(),
                        "visible": island.native_visible(cx),
                        "state": format!("{:?}", island.state()),
                        "stats": island.stats(),
                    })
                }),
            }),
        );
        Ok(())
    }

    /// Evaluate `script` in the island's page; its value as JSON (a string
    /// the script built with `JSON.stringify` is parsed once more).
    pub(super) async fn evaluate(
        &self,
        cx: &mut AsyncApp,
        island: &Entity<lattice_webview::Island>,
        script: &str,
    ) -> Value {
        let receiver = cx.update(|cx| island.read(cx).evaluate(script, cx));
        let started = std::time::Instant::now();
        let mut receiver = receiver;
        loop {
            match receiver.try_recv() {
                Ok(Some(text)) => {
                    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                    return match &value {
                        Value::String(inner) => serde_json::from_str(inner).unwrap_or(value),
                        _ => value,
                    };
                }
                Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                    self.pause(cx, Duration::from_millis(50)).await;
                }
                _ => return Value::Null,
            }
        }
    }
}
