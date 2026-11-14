//! The e2e checks for a documents strip with more tabs than room, as the
//! Tauri app's strip behaves (trellis.css, the Trellis patch's planHeader and
//! revealTab): every tab keeps its minimum and none is drawn over another, in
//! light and dark and in English and Simplified Chinese, the strip scrolls
//! instead and shows the selected tab whole; and a wheel over a strip scrolls
//! it, or does nothing when it fits, and never puts up the free navigator's
//! "Release to focus" ring or moves the camera.
//!
//! With `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the window at each look.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Bounds, Entity, Pixels, px};
use lattice_settings::InterfaceLanguage;
use lattice_ui::{Appearance, LatticeTheme};
use serde_json::{Value, json};

use super::{super::Run, Steps};
use crate::{editor_panel::EditorPanel, native, settings};

/// Enough documents that even at their floor they are wider than any
/// documents panel the e2e window lays out.
const FILES: usize = 24;

/// What one look at the documents strip saw.
struct Look {
    /// No two tabs, as drawn, share a pixel column, and each tab is drawn
    /// inside its slot in the list.
    apart: bool,
    /// Every document tab is at least its floor wide.
    wide_enough: bool,
    /// The tabs at rest are wider than the list, so it scrolls.
    overflows: bool,
    /// The selected tab shows whole inside the list.
    selected_shown: bool,
    detail: Value,
}

impl Run {
    pub(super) async fn tab_strip(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let dir = root.join("tab-strip");
        let result = self.tab_strip_steps(cx, steps, &dir).await;
        std::fs::remove_dir_all(&dir).ok();
        if let Err(error) = result {
            steps.check(
                "a strip with more documents than room",
                false,
                json!({ "error": format!("{error:#}") }),
            );
        }
        Ok(())
    }

    async fn tab_strip_steps(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        dir: &Path,
    ) -> Result<()> {
        // The tab probes (`tab/<title>`) record each tab as drawn, not its
        // slot in the list: a slot that shrank under its tab left the tab
        // overflowing onto its neighbours.
        lattice_ui::parity::enable();
        std::fs::create_dir_all(dir)?;
        let titles: Vec<String> = (1..=FILES).map(|i| format!("strip-{i:02}.tex")).collect();
        let mut editors: Vec<Entity<EditorPanel>> = Vec::new();
        for title in &titles {
            let path = dir.join(title);
            std::fs::write(&path, format!("% {title}\n"))?;
            editors.push(self.open(cx, &path, Some(1))?);
            self.pause(cx, Duration::from_millis(40)).await;
        }
        self.pause(cx, Duration::from_millis(600)).await;
        let panel = cx
            .update(|cx| {
                let shell = self.shell.read(cx);
                let view = shell.view_of_editor(editors.last()?)?;
                let doc = shell.document(cx);
                trellis::model::panel_of_view(&doc, &view).map(|panel| panel.id.clone())
            })
            .context("the documents are in no panel")?;

        let looks = [
            (
                "light, English",
                Appearance::Light,
                InterfaceLanguage::En,
                "tab-strip-many-light",
            ),
            (
                "dark, English",
                Appearance::Dark,
                InterfaceLanguage::En,
                "tab-strip-many-dark",
            ),
            (
                "light, Simplified Chinese",
                Appearance::Light,
                InterfaceLanguage::ZhCn,
                "tab-strip-many-zh-light",
            ),
            (
                "dark, Simplified Chinese",
                Appearance::Dark,
                InterfaceLanguage::ZhCn,
                "tab-strip-many-zh-dark",
            ),
        ];
        for (name, appearance, language, shot) in looks {
            cx.update(|cx| {
                LatticeTheme::set_appearance(appearance, cx);
                settings::update_appearance(cx, |a| a.interface_language = language);
            });
            self.frame_after_input(cx).await?;
            self.pause(cx, Duration::from_millis(400)).await;
            self.frame_after_input(cx).await?;
            self.tab_strip_shot(cx, shot).await;
            let look = self.look_at_strip(cx, &panel, &titles)?;
            steps.check(
                &format!(
                    "{FILES} open documents ({name}): no tab is drawn over another, each keeps its minimum, and the strip scrolls with the selected tab whole"
                ),
                look.apart && look.wide_enough && look.overflows && look.selected_shown,
                look.detail,
            );
        }
        cx.update(|cx| {
            LatticeTheme::set_appearance(Appearance::Light, cx);
            settings::update_appearance(cx, |a| a.interface_language = InterfaceLanguage::En);
        });
        self.frame_after_input(cx).await?;

        // Over the strip that overflows: the wheel scrolls its tabs.
        let (scrolled, mut detail) = self.wheel_over_strip(cx, &panel, 160).await?;
        self.tab_strip_shot(cx, "tab-strip-after-wheel").await;
        let moved = detail["scroll_moved"].as_bool() == Some(true);
        let quiet = detail["release_to_focus"].as_bool() == Some(false)
            && detail["framed_kept"].as_bool() == Some(true);
        detail["scrolled"] = json!(scrolled);
        steps.check(
            "a wheel over a strip that overflows scrolls its tabs, with no \"Release to focus\" and the camera still",
            moved && quiet,
            detail,
        );

        for editor in editors {
            self.close_tab(cx, editor)?;
        }
        self.pause(cx, Duration::from_millis(400)).await;
        self.frame_after_input(cx).await?;
        // Over a strip that fits: the wheel does nothing.
        let (_, detail) = self.wheel_over_strip(cx, &panel, 160).await?;
        let still = detail["scroll_moved"].as_bool() == Some(false)
            && detail["release_to_focus"].as_bool() == Some(false)
            && detail["framed_kept"].as_bool() == Some(true);
        self.tab_strip_shot(cx, "tab-strip-fits-after-wheel").await;
        steps.check(
            "a wheel over a strip that fits does nothing: no \"Release to focus\", no scroll, the camera still",
            still,
            detail,
        );
        Ok(())
    }

    /// The documents strip as last drawn.
    fn look_at_strip(&self, cx: &mut AsyncApp, panel: &str, titles: &[String]) -> Result<Look> {
        let (slots, list) = cx.update(|cx| {
            let workspace = self.shell.read(cx).workspace().read(cx);
            (
                workspace.tab_bounds(panel),
                workspace.tab_list_bounds(panel),
            )
        });
        let list = list.context("the documents strip was not drawn")?;
        let regions = lattice_ui::parity::regions();
        let drawn: Vec<(String, Bounds<Pixels>)> = titles
            .iter()
            .filter_map(|title| {
                regions
                    .get(format!("tab/{title}").as_str())
                    .and_then(|region| region.bounds)
                    .map(|bounds| (title.clone(), bounds))
            })
            .collect();
        let edges = |b: &Bounds<Pixels>| (f32::from(b.left()), f32::from(b.right()));
        let mut overlaps = Vec::new();
        let mut slot_edges: Vec<(f32, f32)> = slots.iter().map(|(_, b)| edges(b)).collect();
        slot_edges.sort_by(|a, b| a.0.total_cmp(&b.0));
        for pair in slot_edges.windows(2) {
            if pair[0].1 > pair[1].0 + 0.5 {
                overlaps.push(json!({ "slots": [pair[0], pair[1]] }));
            }
        }
        let mut tab_edges: Vec<(String, f32, f32)> = drawn
            .iter()
            .map(|(title, b)| {
                let (l, r) = edges(b);
                (title.clone(), l, r)
            })
            .collect();
        tab_edges.sort_by(|a, b| a.1.total_cmp(&b.1));
        for pair in tab_edges.windows(2) {
            if pair[0].2 > pair[1].1 + 0.5 {
                overlaps.push(
                    json!({ "tabs": [&pair[0].0, &pair[1].0], "edges": [pair[0].2, pair[1].1] }),
                );
            }
        }
        // Each tab inside a slot: the slot whose left edge is the tab's.
        let outside: Vec<&String> = drawn
            .iter()
            .filter(|(_, tab)| {
                let (l, r) = edges(tab);
                !slots.iter().any(|(_, slot)| {
                    let (sl, sr) = edges(slot);
                    (sl - l).abs() <= 0.5 && r <= sr + 0.5
                })
            })
            .map(|(title, _)| title)
            .collect();
        let floor = f32::from(lattice_ui::dock::strip::DOCUMENT_TAB_FLOOR);
        let narrow: Vec<(&String, f32)> = drawn
            .iter()
            .map(|(title, b)| (title, f32::from(b.size.width)))
            .filter(|(_, w)| *w < floor - 0.5)
            .collect();
        let widths: f32 = slots.iter().map(|(_, b)| f32::from(b.size.width)).sum();
        // The document opened last is the one selected.
        let selected_bounds = titles
            .last()
            .and_then(|title| drawn.iter().find(|(t, _)| t == title))
            .map(|(_, b)| *b);
        let selected_shown = selected_bounds.is_some_and(|b| {
            b.left() >= list.left() - px(0.5) && b.right() <= list.right() + px(0.5)
        });
        Ok(Look {
            apart: overlaps.is_empty() && outside.is_empty() && drawn.len() == titles.len(),
            wide_enough: narrow.is_empty(),
            overflows: widths > f32::from(list.size.width),
            selected_shown,
            detail: json!({
                "tabs": slots.len(),
                "probed": drawn.len(),
                "list": [f32::from(list.left()), f32::from(list.right())],
                "tab_widths": widths,
                "overlaps": overlaps,
                "outside_slot": outside,
                "under_floor": narrow,
                "floor": floor,
                "selected": selected_bounds.map(|b| [f32::from(b.left()), f32::from(b.right())]),
            }),
        })
    }

    /// Native wheel events over the middle of a panel's tab list, a frame
    /// drawn after each. Returns whether the list's scroll moved, and the
    /// step's detail: the scroll before and after, whether any frame put up
    /// "Release to focus", and whether the camera kept its framing once a
    /// wheel gesture would have settled.
    async fn wheel_over_strip(
        &self,
        cx: &mut AsyncApp,
        panel: &str,
        dy: i32,
    ) -> Result<(bool, Value)> {
        let read = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                let workspace = self.shell.read(cx).workspace().read(cx);
                (
                    workspace.tab_list_bounds(panel),
                    workspace.tab_list_scroll(panel).map(f32::from),
                    workspace.engine().framed().map(str::to_string),
                    workspace.shows_release_to_focus(),
                )
            })
        };
        let (list, before, framed, _) = read(cx);
        let list = list.context("the strip's list was not drawn")?;
        let at = list.center();
        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Moved, at)?;
        self.frame_after_input(cx).await?;
        let mut ring = false;
        for _ in 0..4 {
            native::send_wheel(native, at, dy)?;
            self.frame_after_input(cx).await?;
            ring |= read(cx).3;
        }
        // Past the free navigator's wheel settle (180ms), when a wheel that
        // zoomed the camera would frame what fits it best.
        self.pause(cx, Duration::from_millis(500)).await;
        self.frame_after_input(cx).await?;
        let (_, after, framed_after, ring_after) = read(cx);
        ring |= ring_after;
        let moved = match (before, after) {
            (Some(b), Some(a)) => (a - b).abs() > 1.,
            _ => false,
        };
        Ok((
            moved,
            json!({
                "at": [f32::from(at.x), f32::from(at.y)],
                "scroll_before": before,
                "scroll_after": after,
                "scroll_moved": moved,
                "release_to_focus": ring,
                "framed_before": framed,
                "framed_after": framed_after,
                "framed_kept": framed == framed_after,
            }),
        ))
    }

    /// Save the window as `name`.png into `LATTICE_E2E_SHOTS`, when set.
    async fn tab_strip_shot(&self, cx: &mut AsyncApp, name: &str) {
        #[cfg(target_os = "macos")]
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            let out = Path::new(&dir).join(format!("{name}.png"));
            if let Err(error) = self.capture(cx, &out.to_string_lossy()).await {
                log::warn!("e2e shot {name}: {error:#}");
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (cx, name);
    }
}

/// This file's registration as the e2e module `tab_strip` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 100,
    needs: &[],
    setup: false,
    covers: &["gpui/crates/lattice-gpui/src/editor_panel/strip.rs"],
    run: |run, cx, steps, fixture| Box::pin(run.tab_strip(cx, steps, &fixture.root)),
};
