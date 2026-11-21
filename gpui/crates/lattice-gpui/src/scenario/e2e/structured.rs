//! The structured documents (`crate::structured`), on the tutorial
//! template's own board, spreadsheet and deck, copied into the scratch
//! project:
//!
//! - a `.lattice-sheet` opens in the spreadsheet island (Univer drawn, the
//!   Tauri app's root attributes for the theme), alone in its panel; a word
//!   typed into a cell with native keys reaches the file on disk through the
//!   panel's save; the page's Excel export reaches lattice-core's checks; a
//!   question the page asks is GPUI's confirm dialog, drawn above the page
//!   (the queued overlay check: a deferred sheet over an island), and its
//!   answer goes back to the page; hidden past the (shortened) hibernation
//!   delay it is torn down, and comes back drawn with the edit;
//! - an `.excalidraw` opens in the native board in the host's theme; a shape
//!   taken out of the file on disk leaves the board; a rectangle drawn with native
//!   input, its tab closed at once (inside the board's 300 ms debounce), is
//!   in the file once the tab has gone;
//! - an Open Slide deck opens in the slides island, which either frames the
//!   runtime or, in a build without the staged runtime, says Open Slide could
//!   not start, rather than loading forever.

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity, point, px};
use lattice_ui::{Appearance, LatticeTheme};
use lattice_webview::{Island, IslandState};
use serde_json::{Value, json};

use super::{Run, Steps};
use crate::{editor_panel::EditorPanel, native};

pub(super) const BOARD: &str =
    include_str!("../../../../../../src-tauri/templates/tutorial/attention-map.excalidraw");
pub(super) const SHEET: &str =
    include_str!("../../../../../../src-tauri/templates/tutorial/attention-results.lattice-sheet");
const DECK: &str = include_str!(
    "../../../../../../src-tauri/templates/tutorial/slides/understanding-attention/index.tsx"
);

/// How many live elements an `.excalidraw` holds.
pub(super) fn shape_count(text: &str) -> usize {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|file| {
            file["elements"].as_array().map(|elements| {
                elements
                    .iter()
                    .filter(|element| element["isDeleted"] != true)
                    .count()
            })
        })
        .unwrap_or(0)
}

impl Run {
    pub(super) async fn structured_islands(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        cx.update(|cx| lattice_webview::set_hibernate_after(Some(Duration::from_millis(1500)), cx));
        self.sheet_island(cx, steps, root).await?;
        self.native_board(cx, steps, root).await?;
        self.deck_island(cx, steps, root).await?;
        cx.update(|cx| lattice_webview::set_hibernate_after(None, cx));
        Ok(())
    }

    /// Open `path` and wait for its structured document's page to draw.
    pub(super) async fn open_structured(
        &self,
        cx: &mut AsyncApp,
        path: &Path,
        timeout: Duration,
    ) -> Result<Option<(Entity<EditorPanel>, Entity<Island>)>> {
        let panel = self.open(cx, path, None)?;
        let island = cx.update(|cx| {
            panel
                .read(cx)
                .structured()
                .and_then(|document| document.read(cx).island().cloned())
        });
        let Some(island) = island else {
            return Ok(None);
        };
        self.wait_for(cx, timeout, |_, cx| {
            panel
                .read(cx)
                .structured()
                .is_some_and(|document| document.read(cx).is_drawn())
        })
        .await;
        Ok(Some((panel, island)))
    }

    /// Run `script`, which sets `window.__e2e` when its promise settles, and
    /// wait for that value.
    async fn settle(&self, cx: &mut AsyncApp, island: &Entity<Island>, script: &str) -> Value {
        self.evaluate(cx, island, &format!("window.__e2e = null; {script}; null"))
            .await;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(8) {
            let value = self.evaluate(cx, island, "window.__e2e").await;
            if !value.is_null() {
                return value;
            }
            self.pause(cx, Duration::from_millis(100)).await;
        }
        Value::Null
    }

    async fn sheet_island(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let path = root.join("e2e-results.lattice-sheet");
        std::fs::write(&path, SHEET)?;
        let Some((panel, island)) = self
            .open_structured(cx, &path, Duration::from_secs(40))
            .await?
        else {
            steps.check(
                "a .lattice-sheet opens in the spreadsheet island",
                false,
                json!({}),
            );
            return Ok(());
        };
        let drawn = cx.update(|cx| {
            panel
                .read(cx)
                .structured()
                .is_some_and(|document| document.read(cx).is_drawn())
        });
        let facts = self
            .evaluate(
                cx,
                &island,
                "JSON.stringify({ canvas: !!document.querySelector('.spreadsheet-univer-host canvas'), \
                 error: !!document.querySelector('.spreadsheet-editor-error'), \
                 theme: document.documentElement.dataset.theme || null, \
                 tint: document.documentElement.dataset.tint || null, \
                 accent: document.documentElement.dataset.accent || null, \
                 ground: getComputedStyle(document.querySelector('.spreadsheet-editor-root')).backgroundColor })",
            )
            .await;
        let (state, visible) = cx.update(|cx| {
            let island = island.read(cx);
            (island.state().clone(), island.native_visible(cx))
        });
        steps.check(
            "a .lattice-sheet opens in the spreadsheet island: Univer drawn, alone in its panel, in the Tauri app's theme attributes",
            drawn
                && state == IslandState::Ready
                && visible
                && facts["canvas"] == true
                && facts["error"] == false
                && facts["theme"] == "light"
                && facts["tint"].is_string()
                && facts["accent"].is_string(),
            json!({ "drawn": drawn, "state": format!("{state:?}"), "visible": visible, "page": facts }),
        );

        self.island_shot(cx, "sheet-island").await?;

        // A word typed into a cell, with native keys, reaches the file; the
        // arrows' characters an input method commits mid-word (U+F700–U+F703)
        // do not.
        let typed = match cx.update(|cx| island.read(cx).bounds(cx)) {
            Some(bounds) => {
                let native = self.native(cx)?;
                native::send_click(native, bounds.center())?;
                self.wait_for(cx, Duration::from_secs(3), |_, cx| {
                    island.read(cx).page_focused()
                })
                .await;
                self.pause(cx, Duration::from_millis(300)).await;
                for character in "quo".chars() {
                    native::send_key(native, character, false)?;
                    self.pause(cx, Duration::from_millis(40)).await;
                }
                cx.update(|cx| {
                    island
                        .read(cx)
                        .insert_text("\u{F700}\u{F701}\u{F702}\u{F703}", cx)
                });
                for character in "kka\n".chars() {
                    native::send_key(native, character, false)?;
                    self.pause(cx, Duration::from_millis(40)).await;
                }
                self.wait_for(cx, Duration::from_secs(10), |_, _| {
                    std::fs::read_to_string(&path).is_ok_and(|text| text.contains("quokka"))
                })
                .await
            }
            None => false,
        };
        let saved = std::fs::read_to_string(&path).unwrap_or_default();
        let parses = serde_json::from_str::<Value>(&saved).is_ok();
        let arrows = saved.contains(|c| ('\u{F700}'..='\u{F703}').contains(&c));
        steps.check(
            "a word typed into a cell with native keys, an input method's arrow characters committed mid-word, is saved to the .lattice-sheet as that word alone, which stays valid JSON",
            typed && parses && !arrows,
            json!({ "typed": typed, "parses": parses, "arrows": arrows }),
        );

        // The page's Excel export reaches lattice-core's checks: bytes that
        // are not a workbook are refused, and nothing is written.
        let destination = root.join("e2e-export.xlsx");
        let refused = self
            .settle(
                cx,
                &island,
                &format!(
                    "window.__TAURI_INTERNALS__.invoke('save_xlsx', new Uint8Array([1, 2, 3]).buffer, \
                     {{ headers: {{ 'x-xlsx-destination': btoa({destination:?}) }} }})\
                     .then((saved) => {{ window.__e2e = 'saved:' + saved; }}, (error) => {{ window.__e2e = 'refused:' + error.message; }})",
                    destination = destination.to_string_lossy()
                ),
            )
            .await;
        steps.check(
            "the sheet's Excel export reaches lattice-core, which refuses bytes that are not a workbook",
            refused.as_str().is_some_and(|text| text.starts_with("refused:"))
                && !destination.exists(),
            json!({ "answer": refused }),
        );

        self.confirm_over_island(cx, steps, &island).await?;
        self.island_interface_zoom(cx, steps, &island, "the spreadsheet")
            .await?;

        // Hidden past the delay: torn down, and back with the edit.
        self.open(cx, &root.join("chapters/intro.tex"), None)?;
        let hibernated = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                *island.read(cx).state() == IslandState::Hibernated
            })
            .await;
        let reopened = self.open(cx, &path, None)?;
        let woke = self
            .wait_for(cx, Duration::from_secs(40), |_, cx| {
                reopened
                    .read(cx)
                    .structured()
                    .is_some_and(|document| document.read(cx).is_drawn())
            })
            .await;
        let builds = cx.update(|cx| island.read(cx).stats().builds);
        let buffer_kept = cx.update(|cx| {
            reopened
                .read(cx)
                .editor()
                .read(cx)
                .text(cx)
                .contains("quokka")
        });
        steps.check(
            "the sheet hidden past the delay hibernates, and is drawn again with its edit when shown",
            hibernated && woke && reopened == panel && builds == 2 && buffer_kept,
            json!({ "hibernated": hibernated, "woke": woke, "builds": builds, "buffer_kept": buffer_kept }),
        );
        self.close_panel(cx, &panel).await?;
        Ok(())
    }

    /// A question the page asks (`confirmAction`) is GPUI's confirm dialog,
    /// drawn above the page, and the page gets the answer.
    async fn confirm_over_island(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        island: &Entity<Island>,
    ) -> Result<()> {
        let before = self.window_capture(cx).await?;
        self.evaluate(
            cx,
            island,
            "window.__e2e = null; window.latticeHost.request('island:confirm', \
             { title: 'Island question', message: 'Asked by the page.', confirmLabel: 'Go on' })\
             .then((answer) => { window.__e2e = answer; }); null",
        )
        .await;
        let host = cx.update(crate::confirm::install);
        let asked = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                host.read(cx).question().as_deref() == Some("Island question")
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        let during = self.window_capture(cx).await?;
        let answered = self.with_window(cx, {
            let host = host.clone();
            move |_, window, cx| host.update(cx, |host, cx| host.accept(window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let answer = self.evaluate(cx, island, "window.__e2e").await;
        // The dialog's card, title and buttons over the window's middle:
        // pixels there change strongly once it is drawn above the page.
        let changed = match (&before, &during) {
            (Some(before), Some(during)) if before.dimensions() == during.dimensions() => {
                let (width, height) = before.dimensions();
                let mut changed = 0usize;
                for y in height * 3 / 8..height * 5 / 8 {
                    for x in width / 3..width * 2 / 3 {
                        let (a, b) = (before.get_pixel(x, y).0, during.get_pixel(x, y).0);
                        let delta = (0..3)
                            .map(|channel| (i32::from(a[channel]) - i32::from(b[channel])).abs())
                            .max()
                            .unwrap_or(0);
                        changed += usize::from(delta > 40);
                    }
                }
                Some(changed)
            }
            _ => None,
        };
        let covered = changed.map(|changed| changed > 200);
        steps.check(
            "a question the page asks is GPUI's confirm dialog, drawn above the page, and the page gets the answer",
            asked && answered && answer == "confirm" && covered != Some(false),
            json!({
                "asked": asked,
                "answer": answer,
                "covered": covered.map_or(json!("skipped: the screen could not be captured"), Value::Bool),
                "changed_pixels": changed,
            }),
        );
        Ok(())
    }

    /// The window as the screen composes it; `None` where the screen cannot
    /// be captured (locked, or no permission).
    async fn window_capture(&self, cx: &mut AsyncApp) -> Result<Option<image::RgbaImage>> {
        let number = native::window_number(self.native(cx)?);
        native::order_front(self.native(cx)?);
        self.pause(cx, Duration::from_millis(200)).await;
        let out =
            std::env::temp_dir().join(format!("lattice-structured-{}.png", std::process::id()));
        let captured = std::process::Command::new("screencapture")
            .args(["-x", "-o", &format!("-l{number}")])
            .arg(&out)
            .status()
            .is_ok_and(|status| status.success());
        let image = captured
            .then(|| image::open(&out).ok())
            .flatten()
            .map(|image| image.to_rgba8());
        std::fs::remove_file(&out).ok();
        Ok(image)
    }

    /// Save the window as the screen composes it to `LATTICE_E2E_SHOTS`, for
    /// the look review beside the parity report (whose offscreen frame has
    /// no page in it).
    pub(super) async fn island_shot(&self, cx: &mut AsyncApp, name: &str) -> Result<()> {
        let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") else {
            return Ok(());
        };
        for appearance in [Appearance::Light, Appearance::Dark] {
            cx.update(|cx| LatticeTheme::set_appearance(appearance, cx));
            self.pause(cx, Duration::from_millis(1500)).await;
            if let Some(image) = self.window_capture(cx).await? {
                let theme = if appearance == Appearance::Dark {
                    "dark"
                } else {
                    "light"
                };
                image
                    .save(Path::new(&dir).join(format!("{name}-{theme}.png")))
                    .ok();
            }
        }
        cx.update(|cx| LatticeTheme::set_appearance(Appearance::Light, cx));
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }

    async fn native_board(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let path = root.join("e2e-map.excalidraw");
        std::fs::write(&path, BOARD)?;
        let panel = self.open(cx, &path, None)?;
        let board = cx.update(|cx| {
            panel
                .read(cx)
                .structured()
                .and_then(|document| document.read(cx).board().cloned())
        });
        let Some(board) = board else {
            steps.check("an .excalidraw opens in the native board", false, json!({}));
            return Ok(());
        };
        let shapes_on_board = |cx: &mut AsyncApp| {
            cx.update(|cx| board.read(cx).scene.non_deleted_elements().count() as u64)
        };
        // The board follows the app's theme when it draws: its canvas is the
        // editor sheet's color, and dark mode its own.
        self.pause(cx, Duration::from_millis(500)).await;
        let drawn_shapes = shapes_on_board(cx);
        let ground = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                use lattice_ui::ActiveLattice as _;
                (lattice_board::theme::dark(), lattice_board::theme::canvas() == cx.palette().editor)
            })
        };
        let light = ground(cx);
        cx.update(|cx| LatticeTheme::set_appearance(Appearance::Dark, cx));
        self.pause(cx, Duration::from_millis(500)).await;
        let dark = ground(cx);
        cx.update(|cx| LatticeTheme::set_appearance(Appearance::Light, cx));
        steps.check(
            "an .excalidraw opens in the native board with its shapes, and follows the host's light and dark",
            drawn_shapes > 0 && light == (false, true) && dark == (true, true),
            json!({ "shapes": drawn_shapes, "light": [light.0, light.1], "dark": [dark.0, dark.1] }),
        );

        self.island_shot(cx, "board-native").await?;

        // A shape taken out of the file on disk leaves the board. The edit
        // waits for a clean buffer: an edit on disk reloads only a clean
        // buffer, and merges into an edited one on its next save.
        let clean = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                !panel.read(cx).is_dirty(cx)
            })
            .await;
        self.pause(cx, Duration::from_millis(500)).await;
        let mut file: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        // One no other element is inside or bound to, so it leaves alone.
        let removed = file["elements"].as_array_mut().and_then(|elements| {
            let held: Vec<String> = elements
                .iter()
                .flat_map(|element| [&element["containerId"], &element["frameId"]])
                .filter_map(|id| id.as_str().map(str::to_string))
                .collect();
            let index = elements.iter().position(|element| {
                element["containerId"].is_null()
                    && element["id"]
                        .as_str()
                        .is_some_and(|id| !held.iter().any(|holder| holder == id))
            })?;
            Some(elements.remove(index))
        });
        let before = shapes_on_board(cx);
        std::fs::write(&path, serde_json::to_string(&file)?)?;
        let mut after = before;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            after = shapes_on_board(cx);
            if after < before {
                break;
            }
            self.pause(cx, Duration::from_millis(250)).await;
        }
        steps.check(
            "a shape taken out of the .excalidraw on disk leaves the board",
            removed.is_some() && after < before,
            json!({ "clean_first": clean, "before": before, "after": after, "removed": removed.map(|element| element["id"].clone()) }),
        );

        // Pen strokes in quick succession, as a writer sketches: each a
        // native press, 40 drags 16 ms apart and a release, 120 ms between
        // strokes, eight rows so later strokes start on earlier ones. Every
        // stroke is an element of its own.
        let bounds = cx.update(|cx| board.read(cx).bounds());
        let native = self.native(cx)?;
        let center = bounds.center();
        native::send_click(native, point(center.x, center.y + px(120.)))?;
        self.pause(cx, Duration::from_millis(300)).await;
        native::send_key(native, 'p', false)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let before_strokes = shapes_on_board(cx);
        let strokes = 24;
        for stroke in 0..strokes {
            let from = point(
                center.x - px(200.),
                center.y - px(160.) + px((stroke % 8) as f32 * 40.),
            );
            native::send_mouse(native, native::Mouse::Down, from)?;
            for step in 1..=40 {
                let wobble = ((step as f32) * 0.5).sin() * 14.;
                native::send_mouse(
                    native,
                    native::Mouse::Dragged,
                    point(from.x + px(step as f32 * 10.), from.y + px(wobble)),
                )?;
                self.pause(cx, Duration::from_millis(16)).await;
            }
            native::send_mouse(native, native::Mouse::Up, point(from.x + px(400.), from.y))?;
            self.pause(cx, Duration::from_millis(120)).await;
        }
        self.pause(cx, Duration::from_millis(300)).await;
        let drawn = shapes_on_board(cx) - before_strokes;
        steps.check(
            "pen strokes drawn in quick succession with native input are an element each",
            drawn == strokes,
            json!({ "strokes": strokes, "elements_added": drawn }),
        );
        native::send_key(native, 'v', false)?;
        self.pause(cx, Duration::from_millis(200)).await;

        // A rectangle drawn with native input; the tab closed at once.
        let on_disk = shape_count(&std::fs::read_to_string(&path)?);
        let bounds = cx.update(|cx| board.read(cx).bounds());
        let native = self.native(cx)?;
        let center = bounds.center();
        native::send_click(native, point(center.x, center.y + px(120.)))?;
        self.pause(cx, Duration::from_millis(300)).await;
        native::send_key(native, 'r', false)?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.native_drag(
            cx,
            point(center.x - px(60.), center.y + px(60.)),
            point(center.x + px(60.), center.y + px(160.)),
        )
        .await?;
        let on_board = shapes_on_board(cx);
        self.close_panel(cx, &panel).await?;
        let saved = self
            .wait_for(cx, Duration::from_secs(8), |_, _| {
                std::fs::read_to_string(&path).is_ok_and(|text| shape_count(&text) > on_disk)
            })
            .await;
        steps.check(
            "a rectangle drawn with native input on the board is in the .excalidraw after its tab closes at once",
            saved,
            json!({ "saved": saved, "shapes_before": on_disk, "on_board_before_close": on_board,
                    "shapes_after": std::fs::read_to_string(&path).map(|text| shape_count(&text)).ok() }),
        );
        Ok(())
    }

    async fn deck_island(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let deck = root.join("slides/e2e-deck/index.tsx");
        std::fs::create_dir_all(deck.parent().unwrap())?;
        std::fs::write(&deck, DECK)?;
        let Some((panel, island)) = self
            .open_structured(cx, &deck, Duration::from_secs(20))
            .await?
        else {
            steps.check(
                "an Open Slide deck opens in the slides island",
                false,
                json!({}),
            );
            return Ok(());
        };
        // The runtime starts (up to lattice-core's 30 s), or says it cannot.
        // A frame whose navigation the island refused stays on its own
        // about:blank, which the page can read; one that reached the
        // runtime's origin is cross-origin, and reading it throws.
        let facts_script = "(() => { const frame = document.querySelector('.open-slide-frame'); \
             let loaded = false; \
             if (frame) { try { void frame.contentWindow.location.href; } catch { loaded = true; } } \
             return JSON.stringify({ frame: !!frame, loaded, \
               status: document.querySelector('.open-slide-status')?.textContent || null }); })()";
        let mut facts = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(45) {
            facts = self.evaluate(cx, &island, facts_script).await;
            let starting = facts["status"]
                .as_str()
                .is_some_and(|status| status.contains("Starting"));
            if facts["loaded"] == true || (facts["status"].is_string() && !starting) {
                break;
            }
            self.pause(cx, Duration::from_millis(300)).await;
        }
        self.island_shot(cx, "deck-island").await?;
        let framed = facts["loaded"] == true;
        let explained = facts["status"]
            .as_str()
            .is_some_and(|status| status.contains("Open Slide could not start"));
        steps.check(
            "an Open Slide deck opens in the slides island: the runtime's origin loaded in its frame, or, without the staged runtime, said to be unable to start",
            framed || explained,
            json!({ "page": facts, "rejected": cx.update(|cx| island.read(cx).stats().rejected) }),
        );
        self.close_panel(cx, &panel).await?;
        Ok(())
    }
}

/// This file's registration as the e2e module `structured` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 70,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/structured",
        "gpui/crates/lattice-gpui/src/editor_panel/structured_view.rs",
        "gpui/crates/lattice-webview/",
        "gpui/islands/",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.structured_islands(cx, steps, &fixture.root)),
};
