//! `parity`: the Main window (or, with `LATTICE_PARITY_SCREEN=settings`,
//! Settings over it) staged as the parity harness (`gpui/parity/`)
//! stages it in the Tauri app, captured, with the bounds and text styles of
//! its named regions (`lattice_ui::parity`).
//!
//! The harness opens a copy of the tutorial project with its PDF built, as
//! `design-system/screens/scenes.mjs` opens it on the mock backend. Here the
//! file sidebar is widened as the scene drags it (to the 329px Project card
//! the reference measures, which leaves the workspace's dot on, as the drag
//! does there), the pointer is parked in the bottom-right gutter, the PDF is
//! waited for, and
//! the build chip shows a clean 1.2 s build, as the mock backend's
//! `build=clean` stages it, so no TeX is needed. Then the window is
//! captured as `LATTICE_SHOT_OUT` (default `parity.png`) and the result
//! lists every region the probes recorded, in logical pixels.

use std::time::Duration;

use anyhow::Result;
use gpui::{App, AsyncApp, Entity, SharedString};
use language::{LanguageAwareStyling, Point};
use lattice_ui::{
    ActiveLattice as _, Appearance,
    parity::{self, Region, TextLook},
};
use serde_json::{Map, Value, json};
use settings::Settings as _;

use super::{Run, sleep};
use crate::{editor_panel::EditorPanel, native};
use theme::ActiveTheme as _;

/// The editor's first line as runs of text the way its highlighting splits
/// it, each with the weight its syntax style (or the buffer font) draws it in.
fn first_line_runs(editor: &Entity<EditorPanel>, base: f32, cx: &App) -> Vec<(String, f32)> {
    let Some(buffer) = editor
        .read(cx)
        .editor()
        .read(cx)
        .buffer()
        .read(cx)
        .as_singleton()
    else {
        return Vec::new();
    };
    let snapshot = buffer.read(cx).snapshot();
    let end = Point::new(0, snapshot.line_len(0));
    let syntax = cx.theme().syntax().clone();
    snapshot
        .chunks(
            Point::new(0, 0)..end,
            LanguageAwareStyling {
                tree_sitter: true,
                diagnostics: false,
            },
        )
        .filter(|chunk| !chunk.text.trim().is_empty())
        .map(|chunk| {
            let weight = chunk
                .syntax_highlight_id
                .and_then(|id| syntax.get(id))
                .and_then(|style| style.font_weight)
                .map_or(base, |weight| weight.0);
            (chunk.text.trim().to_string(), weight)
        })
        .collect()
}

/// The Project card's width once the scene has widened the sidebar.
const SIDEBAR_CARD: f32 = 329.;

impl Run {
    pub(super) async fn parity(&self, cx: &mut AsyncApp) -> Result<Value> {
        // The reference is the Tauri frontend in a browser, which is never
        // translucent (theme.css sets `data-glass` only over the native
        // window's vibrancy), so the window is opaque here too.
        cx.update(|cx| {
            crate::settings::update_appearance(cx, |appearance| {
                appearance.translucency = lattice_settings::Translucency::Off
            })
        });
        if std::env::var("LATTICE_PARITY_SCREEN").as_deref() == Ok("welcome") {
            return self.parity_welcome(cx).await;
        }
        native::order_front(self.native(cx)?);
        // The project opens on its own task and lays the window out as its
        // workspace has it, so the sidebar is widened only once that is done
        // (its PDF is shown), or the arrangement would put it back.
        let pdf_shown = self.wait_for_pdf(cx).await;
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                shell.set_view_width("project", SIDEBAR_CARD, cx)
            });
        })?;
        self.park_pointer(cx)?;
        self.with_window(cx, |shell, _, cx| {
            let build = shell.read(cx).build_panel().clone();
            build.update(cx, |build, cx| {
                build.stage_succeeded(Duration::from_millis(1200), cx)
            });
        })?;
        // The Settings screen: ⌘, over the window, on Appearance, with
        // nothing focused (the scene blurs the search Settings opens in).
        if std::env::var("LATTICE_PARITY_SCREEN").as_deref() == Ok("settings") {
            // The scene runs the page with `lang=en`, which the language
            // select shows as English rather than "Match system".
            cx.update(|cx| {
                crate::settings::update_appearance(cx, |appearance| {
                    appearance.interface_language = lattice_settings::InterfaceLanguage::En
                })
            });
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| {
                    shell.open_settings(Some(lattice_settings::SettingsTab::Appearance), window, cx)
                });
            })?;
            sleep(cx, Duration::from_millis(600)).await;
            self.with_window(cx, |_, window, cx| window.blur(cx))?;
        }
        // The Overleaf screens (`scenes.overleafPicker`,
        // `scenes.settingsOverleaf`), in English as the scenes run.
        let screen = std::env::var("LATTICE_PARITY_SCREEN").unwrap_or_default();
        if screen == "overleafPicker" || screen == "settingsOverleaf" {
            cx.update(|cx| {
                crate::settings::update_appearance(cx, |appearance| {
                    appearance.interface_language = lattice_settings::InterfaceLanguage::En
                })
            });
            self.parity_overleaf(cx, &screen).await?;
            self.park_pointer(cx)?;
        }
        // The History screens (`scenes.history`, `scenes.historyCompare`):
        // the paper's versions, History opened, and Compare… pressed.
        let history_loaded = if screen == "history" || screen == "historyCompare" {
            let loaded = self.parity_history(cx, screen == "historyCompare").await?;
            self.park_pointer(cx)?;
            Some(loaded)
        } else {
            None
        };
        // The submission screens (`scenes.todos`, `scenes.checklist`,
        // `scenes.arxivExport`).
        let submission_shown = if matches!(screen.as_str(), "todos" | "checklist" | "arxivExport") {
            let shown = self.parity_submission(cx, &screen).await?;
            self.park_pointer(cx)?;
            Some(shown)
        } else {
            None
        };
        // The HTML screen (`scenes.html`): the tutorial's HTML demo opened,
        // in Preview, once its page has loaded; the spreadsheet and board
        // screens (`scenes.sheet`, `scenes.board`): the tutorial's own, once
        // their island has drawn; the Markdown screen (`scenes.markdown`): the
        // tutorial's notes in Preview, once the visual editor has drawn.
        let html_loaded = match std::env::var("LATTICE_PARITY_SCREEN").as_deref() {
            Ok("html") => Some(self.parity_open_html(cx).await?),
            Ok("markdown") => Some(self.parity_open_markdown(cx).await?),
            Ok("sheet") => Some(
                self.parity_open_structured(cx, "attention-results.lattice-sheet")
                    .await?,
            ),
            Ok("board") => Some(
                self.parity_open_structured(cx, "attention-map.tldr")
                    .await?,
            ),
            _ => None,
        };
        // Page images, the editor's highlighting and the fonts settle.
        sleep(cx, Duration::from_millis(2500)).await;
        let out = std::env::var("LATTICE_SHOT_OUT").unwrap_or_else(|_| "parity.png".into());
        self.capture(cx, &out).await?;
        // The offscreen read-back has GPUI's frame only, without the page in
        // the HTML preview's webview: beside it, the window as the screen
        // composes it, for a look review (none on a locked screen).
        if html_loaded.is_some() {
            let composited = out.replace(".png", "-composited.png");
            // The screen composes only a window it shows.
            native::order_front(self.native(cx)?);
            sleep(cx, Duration::from_millis(600)).await;
            let number = native::window_number(self.native(cx)?);
            let saved = std::process::Command::new("screencapture")
                .args(["-x", "-o", &format!("-l{number}"), &composited])
                .status()
                .is_ok_and(|status| status.success());
            if !saved {
                log::warn!("no composited capture of the HTML screen (a locked screen?)");
            }
        }

        let (viewport, scale, appearance, ui_font) =
            self.with_window(cx, |shell, window, cx| {
                // Zed's editor styles its text from the settings and its syntax
                // theme, out of the probes' reach, so its region is recorded from
                // them: the first line's runs as its highlighting splits them
                // (a command, each brace, the argument), each in its weight.
                // The front document's editor, from the arrangement: the
                // shell's last-focused editor follows focus-in events, which
                // a window that is never the key window does not get.
                let front = shell.update(cx, |shell, cx| {
                    let path = shell.root(cx)?.join(shell.active_document(cx)?);
                    shell.open_editor(&path, cx)
                });
                let settings = theme_settings::ThemeSettings::get_global(cx);
                let size = f32::from(settings.buffer_font_size(cx));
                let look = |content: Option<SharedString>, weight: f32| TextLook {
                    content,
                    family: settings.buffer_font.family.clone(),
                    size,
                    weight,
                    line_height: size * settings.line_height(),
                };
                let base = settings.buffer_font.weight.0;
                let runs = front
                    .map(|editor| first_line_runs(&editor, base, cx))
                    .unwrap_or_default();
                let texts = if runs.is_empty() {
                    [(0, look(None, base))].into()
                } else {
                    runs.into_iter()
                        .enumerate()
                        .map(|(slot, (text, weight))| (slot, look(Some(text.into()), weight)))
                        .collect()
                };
                parity::record(
                    "editor/text",
                    Region {
                        bounds: None,
                        texts,
                    },
                );
                let lattice = cx.lattice();
                (
                    window.viewport_size(),
                    window.scale_factor(),
                    lattice.palette.appearance,
                    lattice.fonts.ui.clone(),
                )
            })?;

        let regions = regions_json();
        Ok(json!({
            "png": out,
            "viewport": { "width": f32::from(viewport.width), "height": f32::from(viewport.height) },
            "scale": scale,
            "theme": match appearance { Appearance::Light => "light", Appearance::Dark => "dark" },
            "uiFont": ui_font.as_ref(),
            "pdfShown": pdf_shown,
            "htmlLoaded": html_loaded,
            "historyLoaded": history_loaded,
            "submissionShown": submission_shown,
            "regions": regions,
        }))
    }
}

impl Run {
    /// Open the tutorial's HTML demo as the scene does, and wait for its
    /// preview's page; whether it loaded.
    async fn parity_open_html(&self, cx: &mut AsyncApp) -> Result<bool> {
        let Some(root) = cx.update(|cx| self.shell.read(cx).root(cx)) else {
            return Ok(false);
        };
        let panel = self.open(cx, &root.join("attention-demo.html"), None)?;
        let loaded = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                panel
                    .read(cx)
                    .html_preview()
                    .is_some_and(|preview| preview.read(cx).is_loaded())
            })
            .await;
        self.park_pointer(cx)?;
        Ok(loaded)
    }
}

impl Run {
    /// Open the tutorial's notes in Preview as the scene does, and wait for
    /// the visual editor to draw; whether it did.
    async fn parity_open_markdown(&self, cx: &mut AsyncApp) -> Result<bool> {
        let Some(root) = cx.update(|cx| self.shell.read(cx).root(cx)) else {
            return Ok(false);
        };
        let panel = self.open(cx, &root.join("notes.md"), None)?;
        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                panel.update(cx, |panel, cx| {
                    panel.set_document_view(crate::editor_panel::DocumentView::Preview, window, cx)
                })
            }
        })?;
        let drawn = self
            .wait_for(cx, Duration::from_secs(30), |_, cx| {
                panel
                    .read(cx)
                    .markdown_document()
                    .is_some_and(|document| document.read(cx).is_drawn())
            })
            .await;
        self.park_pointer(cx)?;
        Ok(drawn)
    }
}

impl Run {
    /// Open the tutorial's structured document `name` as the scene does, and
    /// wait for its island's page to draw; whether it did.
    async fn parity_open_structured(&self, cx: &mut AsyncApp, name: &str) -> Result<bool> {
        let Some(root) = cx.update(|cx| self.shell.read(cx).root(cx)) else {
            return Ok(false);
        };
        let panel = self.open(cx, &root.join(name), None)?;
        let drawn = self
            .wait_for(cx, Duration::from_secs(30), |_, cx| {
                panel
                    .read(cx)
                    .structured()
                    .is_some_and(|document| document.read(cx).is_drawn())
            })
            .await;
        self.park_pointer(cx)?;
        Ok(drawn)
    }
}

/// Every region the probes recorded, in logical pixels.
pub(super) fn regions_json() -> Map<String, Value> {
    let mut regions = Map::new();
    for (name, region) in parity::regions() {
        let bounds = region.bounds.map(|b| {
            json!({
                "x": f32::from(b.origin.x),
                "y": f32::from(b.origin.y),
                "w": f32::from(b.size.width),
                "h": f32::from(b.size.height),
            })
        });
        let texts: Vec<Value> = region
            .texts
            .values()
            .map(|t| {
                json!({
                    "content": t.content.as_deref(),
                    "family": t.family.as_ref(),
                    "size": t.size,
                    "weight": t.weight,
                    "lineHeight": t.line_height,
                })
            })
            .collect();
        regions.insert(
            name.to_string(),
            json!({ "bounds": bounds, "texts": texts }),
        );
    }
    regions
}
