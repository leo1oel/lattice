//! `parity`: the Main window staged as the parity harness (`gpui/parity/`)
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
use gpui::AsyncApp;
use lattice_ui::{
    ActiveLattice as _, Appearance,
    parity::{self, Region, TextLook},
};
use serde_json::{Map, Value, json};
use settings::Settings as _;

use super::{Run, sleep};
use crate::native;

/// The Project card's width once the scene has widened the sidebar.
const SIDEBAR_CARD: f32 = 329.;

impl Run {
    pub(super) async fn parity(&self, cx: &mut AsyncApp) -> Result<Value> {
        native::order_front(self.native(cx)?);
        self.with_window(cx, |shell, window, cx| {
            let area = shell.read(cx).dock_area().clone();
            area.update(cx, |area, cx| {
                area.set_dock_size(
                    gpui_kit::component::dock::DockPlacement::Left,
                    gpui::px(SIDEBAR_CARD + 6.),
                    window,
                    cx,
                )
            });
        })?;
        self.park_pointer(cx)?;
        let pdf_shown = self.wait_for_pdf(cx).await;
        self.with_window(cx, |shell, _, cx| {
            let build = shell.read(cx).build_panel().clone();
            build.update(cx, |build, cx| {
                build.stage_succeeded(Duration::from_millis(1200), cx)
            });
        })?;
        // Page images, the editor's highlighting and the fonts settle.
        sleep(cx, Duration::from_millis(2500)).await;
        let out = std::env::var("LATTICE_SHOT_OUT").unwrap_or_else(|_| "parity.png".into());
        self.capture(cx, &out).await?;

        let (viewport, scale, appearance, ui_font) = self.with_window(cx, |_, window, cx| {
            // Zed's editor styles its text from the settings, out of the
            // probes' reach, so its region is recorded from them.
            let settings = theme_settings::ThemeSettings::get_global(cx);
            let size = f32::from(settings.buffer_font_size(cx));
            parity::record(
                "editor/text",
                Region {
                    bounds: None,
                    texts: [(
                        0,
                        TextLook {
                            content: None,
                            family: settings.buffer_font.family.clone(),
                            size,
                            weight: settings.buffer_font.weight.0,
                            line_height: size * settings.line_height(),
                        },
                    )]
                    .into(),
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
        Ok(json!({
            "png": out,
            "viewport": { "width": f32::from(viewport.width), "height": f32::from(viewport.height) },
            "scale": scale,
            "theme": match appearance { Appearance::Light => "light", Appearance::Dark => "dark" },
            "uiFont": ui_font.as_ref(),
            "pdfShown": pdf_shown,
            "regions": regions,
        }))
    }
}
