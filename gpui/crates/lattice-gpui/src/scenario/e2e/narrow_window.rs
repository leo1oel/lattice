//! The e2e checks for a narrow window, as the Tauri app gives way in one
//! (`trellis-titlebar.tsx`'s folds, `trellis.css`'s container queries and
//! its `[data-tools="icon"]` header): at the 1015px CI runner's width and at
//! the window's least, in light and dark and in English and Simplified
//! Chinese, with a hidden panel's chip in the titlebar, no part of the
//! titlebar is drawn over another or past the window's edge, and the build
//! chip keeps to its strip, its mark alone whenever the strip is short of
//! room for its tools' labels. Then, with four documents in the strip, the
//! window narrows from the CI width to its least: the strip goes from the
//! chip with its label to its mark alone (which it had skipped, dropping
//! the chip at once) and then to the ⋯ menu's Build, and nothing in the
//! titlebar overlaps at any width on the way.
//!
//! With `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the window at each look.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Bounds, Entity, Pixels, px, size};
use lattice_settings::InterfaceLanguage;
use lattice_ui::{Appearance, LatticeTheme};
use serde_json::{Value, json};

use super::{super::Run, Steps};
use crate::{editor_panel::EditorPanel, settings};

/// The CI runner's window, and the window's least width (`Shell`'s
/// `window_min_size`).
const WIDTHS: [f32; 2] = [1015., 720.];
/// The build chip with its mark alone: 8px, the 13px mark, 8px.
const CHIP_ICON: f32 = 29.;

/// What one look at the titlebar and the build chip saw.
struct Look {
    apart: bool,
    inside: bool,
    chip_fits: bool,
    detail: Value,
}

impl Run {
    /// `narrow-window`: the narrow-window checks alone, on the e2e fixture.
    pub(in crate::scenario) async fn narrow_window_alone(
        &self,
        cx: &mut AsyncApp,
    ) -> Result<Value> {
        let mut steps = Steps::new(self);
        let root = self.root(cx).await?;
        self.pause(cx, Duration::from_millis(800)).await;
        self.narrow_window(cx, &mut steps, &root).await?;
        steps.check_foreground(self);
        let passed = steps.0.iter().all(|step| step["passed"] == true);
        Ok(json!({ "scenario": "narrow-window", "passed": passed, "steps": steps.0 }))
    }

    pub(super) async fn narrow_window(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let before = self.with_window(cx, |_, window, _| window.viewport_size())?;
        let result = self.narrow_window_steps(cx, steps, root).await;
        std::fs::remove_dir_all(root.join("narrow-window")).ok();
        // Back to the window and the look the later steps expect.
        cx.update(|cx| {
            LatticeTheme::set_appearance(Appearance::Light, cx);
            settings::update_appearance(cx, |a| a.interface_language = InterfaceLanguage::En);
        });
        self.resize_to(cx, f32::from(before.width), f32::from(before.height))
            .await
            .ok();
        if let Err(error) = result {
            steps.check(
                "a narrow window's titlebar and build chip",
                false,
                json!({ "error": format!("{error:#}") }),
            );
        }
        Ok(())
    }

    async fn narrow_window_steps(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        lattice_ui::parity::enable();
        // Four documents in main.tex's strip, main.tex in front, so the
        // strip passes through each of its tools' states as the window
        // narrows.
        let scratch = root.join("narrow-window");
        std::fs::create_dir_all(&scratch)?;
        let mut others = Vec::new();
        let mut paths = vec![root.join("chapters/intro.tex")];
        for name in ["notes.tex", "draft.tex"] {
            let path = scratch.join(name);
            std::fs::write(&path, format!("% {name}\n"))?;
            paths.push(path);
        }
        for path in paths {
            others.push(self.open(cx, &path, Some(1))?);
            self.pause(cx, Duration::from_millis(200)).await;
        }
        let editor = self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let panel = cx
            .update(|cx| {
                let shell = self.shell.read(cx);
                let view = shell.view_of_editor(&editor)?;
                let doc = shell.document(cx);
                trellis::model::panel_of_view(&doc, &view).map(|panel| panel.id.clone())
            })
            .context("main.tex is in no panel")?;
        // A hidden panel puts its chip in the titlebar, which counts as
        // content to fit and shrinks last.
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| shell.hide_view("papers", cx))
        })?;
        self.frame_after_input(cx).await?;
        let hidden = cx.update(|cx| self.shell.read(cx).hidden_panels(cx));
        let height =
            self.with_window(cx, |_, window, _| f32::from(window.viewport_size().height))?;

        let looks = [
            (
                "light, English",
                Appearance::Light,
                InterfaceLanguage::En,
                "light",
            ),
            (
                "dark, English",
                Appearance::Dark,
                InterfaceLanguage::En,
                "dark",
            ),
            (
                "light, Simplified Chinese",
                Appearance::Light,
                InterfaceLanguage::ZhCn,
                "zh-light",
            ),
            (
                "dark, Simplified Chinese",
                Appearance::Dark,
                InterfaceLanguage::ZhCn,
                "zh-dark",
            ),
        ];
        for width in WIDTHS {
            let reached = self.resize_to(cx, width, height).await?;
            for (name, appearance, language, shot) in looks {
                cx.update(|cx| {
                    LatticeTheme::set_appearance(appearance, cx);
                    settings::update_appearance(cx, |a| a.interface_language = language);
                });
                self.settle_titlebar(cx).await?;
                self.narrow_shot(cx, &format!("narrow-{}-{shot}", width as u32))
                    .await;
                let look = self.look_at_titlebar(cx, &panel, &editor, reached)?;
                let mut detail = look.detail;
                detail["hidden_panels"] = json!(hidden.len());
                steps.check(
                    &format!(
                        "a {}px window ({name}): no part of the titlebar is drawn over another or past the window's edge, and the build chip keeps to its strip, its mark alone when the strip is short",
                        reached as u32
                    ),
                    look.apart && look.inside && look.chip_fits && !hidden.is_empty(),
                    detail,
                );
            }
        }

        // From the CI width to the least, in steps a third of the band the
        // strip keeps the chip's mark alone in (the chip's label, about
        // 53px of the panel, which narrows by about a third of the window).
        cx.update(|cx| {
            LatticeTheme::set_appearance(Appearance::Light, cx);
            settings::update_appearance(cx, |a| a.interface_language = InterfaceLanguage::En);
        });
        let mut sweep = Vec::new();
        let (mut apart, mut fits, mut icon_at) = (true, true, None);
        let mut width = WIDTHS[0];
        while width >= WIDTHS[1] {
            let reached = self.resize_to(cx, width, height).await?;
            let look = self.look_at_titlebar(cx, &panel, &editor, reached)?;
            apart &= look.apart && look.inside;
            fits &= look.chip_fits;
            let icon = look.detail["build_chip_icon_only"] == json!(true)
                && look.detail["build_chip"].is_array();
            if icon && icon_at.is_none() {
                icon_at = Some(reached);
                self.narrow_shot(cx, "narrow-sweep-chip-mark").await;
            }
            sweep.push(json!({
                "width": reached,
                "build_chip": look.detail["build_chip"],
                "icon_only": look.detail["build_chip_icon_only"],
                "documents_panel": look.detail["documents_panel"],
                "overlaps": look.detail["overlaps"],
                "outside": look.detail["outside"],
            }));
            width -= 15.;
        }
        steps.check(
            "narrowing the window from 1015px to its least with four documents in a strip: the build chip keeps its mark alone before the strip drops it, and nothing in the titlebar overlaps on the way",
            apart && fits && icon_at.is_some(),
            json!({ "icon_only_at": icon_at, "sweep": sweep }),
        );

        if let Some((panel, _)) = hidden.first() {
            let panel = panel.clone();
            self.with_window(cx, |shell, _, cx| {
                shell.update(cx, |shell, cx| shell.restore_panel(&panel, cx))
            })?;
        }
        for other in others {
            self.close_tab(cx, other)?;
        }
        Ok(())
    }

    /// Resize the window to `width` × `height` and wait for it to be laid
    /// out at that width; returns the width it reached (a screen narrower
    /// than asked keeps it narrower).
    async fn resize_to(&self, cx: &mut AsyncApp, width: f32, height: f32) -> Result<f32> {
        self.with_window(cx, |_, window, _| {
            window.resize(size(px(width), px(height)))
        })?;
        self.wait_for(cx, Duration::from_secs(3), |_, cx| {
            self.window
                .update(cx, |_, window, _| {
                    (f32::from(window.viewport_size().width) - width).abs() < 1.
                })
                .unwrap_or(false)
        })
        .await;
        self.settle_titlebar(cx).await?;
        self.with_window(cx, |_, window, _| f32::from(window.viewport_size().width))
    }

    /// Forget what the titlebar's and the chip's probes recorded, then draw
    /// until the folds have settled: the titlebar measures its edges on one
    /// frame and folds on the next.
    async fn settle_titlebar(&self, cx: &mut AsyncApp) -> Result<()> {
        lattice_ui::parity::forget("titlebar/");
        lattice_ui::parity::forget("build-chip");
        for _ in 0..3 {
            self.with_window(cx, |shell, _, cx| shell.update(cx, |_, cx| cx.notify()))?;
            self.frame_after_input(cx).await?;
        }
        self.pause(cx, Duration::from_millis(300)).await;
        self.frame_after_input(cx).await?;
        Ok(())
    }

    /// The titlebar's parts and the build chip as last drawn.
    fn look_at_titlebar(
        &self,
        cx: &mut AsyncApp,
        panel: &str,
        editor: &Entity<EditorPanel>,
        width: f32,
    ) -> Result<Look> {
        let regions = lattice_ui::parity::regions();
        let edges = |b: &Bounds<Pixels>| (f32::from(b.left()), f32::from(b.right()));
        let mut parts: Vec<(String, f32, f32)> = regions
            .iter()
            .filter(|(name, _)| name.starts_with("titlebar/"))
            .filter_map(|(name, region)| {
                let (l, r) = edges(&region.bounds?);
                Some((name.to_string(), l, r))
            })
            .collect();
        parts.sort_by(|a, b| a.1.total_cmp(&b.1));
        let mut overlaps = Vec::new();
        for pair in parts.windows(2) {
            if pair[0].2 > pair[1].1 + 0.5 {
                overlaps.push(json!([&pair[0].0, &pair[1].0, pair[0].2, pair[1].1]));
            }
        }
        let outside: Vec<&String> = parts
            .iter()
            .filter(|(_, l, r)| *l < -0.5 || *r > width + 0.5)
            .map(|(name, _, _)| name)
            .collect();
        let expected = [
            "titlebar/project",
            "titlebar/panels",
            "titlebar/search",
            "titlebar/tools",
        ];
        let missing: Vec<&str> = expected
            .into_iter()
            .filter(|name| !parts.iter().any(|(part, _, _)| part == name))
            .collect();

        let (list, card, icon_only) = cx.update(|cx| {
            let workspace = self.shell.read(cx).workspace().read(cx);
            let id = gpui_kit::component::dock::PanelId::from(editor.entity_id());
            (
                workspace.tab_list_bounds(panel),
                workspace.panel_bounds(panel),
                lattice_ui::dock::tools_icon_only(id, cx),
            )
        });
        let chip = regions.get("build-chip").and_then(|region| region.bounds);
        let chip_fits = match (chip, list) {
            // The strip's tools hidden for room: the ⋯ menu has Build.
            (None, _) => true,
            (Some(chip), Some(list)) => {
                let (l, r) = edges(&chip);
                let w = r - l;
                let after_tabs = l >= f32::from(list.right()) - 0.5;
                let shaped = if icon_only {
                    (w - CHIP_ICON).abs() < 1.
                } else {
                    w > CHIP_ICON + 10.
                };
                after_tabs && shaped && r <= width + 0.5
            }
            (Some(_), None) => false,
        };
        Ok(Look {
            apart: overlaps.is_empty(),
            inside: outside.is_empty() && missing.is_empty(),
            chip_fits,
            detail: json!({
                "width": width,
                "parts": parts,
                "overlaps": overlaps,
                "outside": outside,
                "missing": missing,
                "build_chip": chip.map(|b| [f32::from(b.left()), f32::from(b.right())]),
                "build_chip_icon_only": icon_only,
                "tab_list": list.map(|b| [f32::from(b.left()), f32::from(b.right())]),
                "documents_panel": card.map(|b| [f32::from(b.left()), f32::from(b.right())]),
            }),
        })
    }

    /// Save the window as `name`.png into `LATTICE_E2E_SHOTS`, when set.
    async fn narrow_shot(&self, cx: &mut AsyncApp, name: &str) {
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
