//! `pdf-shots`: the PDF viewer's states, captured one after another for a
//! look review against the Tauri app: at rest, Find with a query and its
//! hits, the narrow toolbar's ⋯ menu, the Outline, a selection, dark pages,
//! the wide toolbar, the panel while the PDF is in its own window (and that
//! window), and the empty state.
//!
//! `LATTICE_SHOT_DIR` names the folder the PNGs go to (default `pdf-shots`);
//! `LATTICE_APPEARANCE=light|dark` fixes the appearance. Like `shot`, it
//! draws and reads its frames back itself in a build with the
//! `offscreen-shots` feature.

use std::{path::PathBuf, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity, Pixels, Point, point, px};
use gpui_kit::component::dock::DockPlacement;
use serde_json::{Value, json};

use super::{Run, sleep};
use crate::{native, pdf::PdfView};

impl Run {
    pub(super) async fn pdf_shots(&self, cx: &mut AsyncApp) -> Result<Value> {
        native::order_front(self.native(cx)?);
        self.park_pointer(cx)?;
        let shown = self.wait_for_pdf(cx).await;
        let dir =
            PathBuf::from(std::env::var("LATTICE_SHOT_DIR").unwrap_or_else(|_| "pdf-shots".into()));
        std::fs::create_dir_all(&dir)?;
        let mut shots = Vec::new();
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());

        sleep(cx, Duration::from_millis(1500)).await;
        shots.push(self.snap(cx, &dir, "rest").await?);

        // Find, with a query that hits the first page; then in narrower
        // panels, where the toolbar folds for the query.
        self.update_view(cx, &view, |view, window, cx| {
            view.show_query("attention", window, cx)
        })?;
        sleep(cx, Duration::from_millis(1500)).await;
        shots.push(self.snap(cx, &dir, "find").await?);
        let width = cx.update(|cx| {
            self.shell
                .read(cx)
                .dock_area()
                .read(cx)
                .dock_size(DockPlacement::Right)
        });
        for (name, size) in [("find-fold-controls", 416.), ("find-fold-search", 360.)] {
            self.with_window(cx, |shell, window, cx| {
                let area = shell.read(cx).dock_area().clone();
                area.update(cx, |area, cx| {
                    area.set_dock_size(DockPlacement::Right, px(size), window, cx)
                });
            })?;
            sleep(cx, Duration::from_millis(800)).await;
            shots.push(self.snap(cx, &dir, name).await?);
        }
        if let Some(width) = width {
            self.with_window(cx, |shell, window, cx| {
                let area = shell.read(cx).dock_area().clone();
                area.update(cx, |area, cx| {
                    area.set_dock_size(DockPlacement::Right, width, window, cx)
                });
            })?;
        }
        self.update_view(cx, &view, |view, window, cx| view.clear_find(window, cx))?;
        sleep(cx, Duration::from_millis(500)).await;

        // The narrow toolbar's ⋯ and the Outline, opened with clicks.
        let toolbar = cx.update(|cx| toolbar_points(view.read(cx)));
        if let Some((outline, overflow)) = toolbar {
            self.click(cx, overflow).await?;
            sleep(cx, Duration::from_millis(600)).await;
            shots.push(self.snap(cx, &dir, "overflow-menu").await?);
            self.click(cx, overflow).await?;
            sleep(cx, Duration::from_millis(400)).await;
            self.click(cx, outline).await?;
            sleep(cx, Duration::from_millis(600)).await;
            shots.push(self.snap(cx, &dir, "outline").await?);
            self.click(cx, outline).await?;
            sleep(cx, Duration::from_millis(400)).await;
        }
        self.park_pointer(cx)?;

        // A selection: the first lines of the page's text.
        self.update_view(cx, &view, |view, _, cx| {
            let end = view
                .page_text(0)
                .map_or(0, |text| text.chars.len().min(400));
            view.select((0, 0), (0, end), cx);
        })?;
        sleep(cx, Duration::from_millis(500)).await;
        shots.push(self.snap(cx, &dir, "selection").await?);
        self.update_view(cx, &view, |view, _, cx| view.select((0, 0), (0, 0), cx))?;

        self.update_view(cx, &view, |view, _, cx| view.toggle_dark_pages(cx))?;
        sleep(cx, Duration::from_millis(1500)).await;
        shots.push(self.snap(cx, &dir, "dark-pages").await?);
        self.update_view(cx, &view, |view, _, cx| view.toggle_dark_pages(cx))?;

        // The wide toolbar: a PDF panel wider than 640px.
        self.with_window(cx, |shell, window, cx| {
            let area = shell.read(cx).dock_area().clone();
            area.update(cx, |area, cx| {
                area.set_dock_size(DockPlacement::Right, px(760.), window, cx)
            });
        })?;
        sleep(cx, Duration::from_millis(1500)).await;
        shots.push(self.snap(cx, &dir, "wide-toolbar").await?);

        // In its own window: the panel's way back, and the window.
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.detach(window, cx));
        })?;
        sleep(cx, Duration::from_millis(1500)).await;
        // The panel's dock closes as the PDF leaves; open it to see the panel.
        self.with_window(cx, |shell, window, cx| {
            let area = shell.read(cx).dock_area().clone();
            if !area.read(cx).is_dock_open(DockPlacement::Right) {
                area.update(cx, |area, cx| {
                    area.toggle_dock(DockPlacement::Right, window, cx)
                });
            }
        })?;
        sleep(cx, Duration::from_millis(800)).await;
        shots.push(self.snap(cx, &dir, "in-window-panel").await?);
        let handle = cx.update(|cx| self.shell.read(cx).pdf().read(cx).window_handle());
        if let Some(_handle) = handle {
            let out = dir.join("separate-window.png");
            #[cfg(feature = "offscreen-shots")]
            for _ in 0..12 {
                _handle.update(cx, |_, window, cx| {
                    window.refresh();
                    let _ = window.draw(cx);
                })?;
                sleep(cx, Duration::from_millis(250)).await;
            }
            #[cfg(feature = "offscreen-shots")]
            {
                let image = _handle.update(cx, |_, window, _| window.render_to_image())??;
                image.save(&out)?;
            }
            shots.push(out.display().to_string());
        }
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.dock(true, window, cx));
        })?;
        sleep(cx, Duration::from_millis(800)).await;

        // No PDF yet.
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.close(window, cx));
        })?;
        sleep(cx, Duration::from_millis(600)).await;
        shots.push(self.snap(cx, &dir, "empty").await?);

        Ok(json!({ "pdf_shown": shown, "shots": shots }))
    }

    async fn snap(&self, cx: &mut AsyncApp, dir: &std::path::Path, name: &str) -> Result<String> {
        let out = dir.join(format!("{name}.png"));
        let out = out
            .to_str()
            .context("a shot path that is not UTF-8")?
            .to_string();
        self.capture(cx, &out).await?;
        Ok(out)
    }

    async fn click(&self, cx: &mut AsyncApp, at: Point<Pixels>) -> Result<()> {
        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Down, at)?;
        sleep(cx, Duration::from_millis(40)).await;
        native::send_mouse(native, native::Mouse::Up, at)?;
        Ok(())
    }

    fn update_view<R>(
        &self,
        cx: &mut AsyncApp,
        view: &Entity<PdfView>,
        f: impl FnOnce(&mut PdfView, &mut gpui::Window, &mut gpui::Context<PdfView>) -> R,
    ) -> Result<R> {
        let view = view.clone();
        self.with_window(cx, move |_, window, cx| {
            view.update(cx, |view, cx| f(view, window, cx))
        })
    }
}

/// Where the narrow toolbar's Outline button and ⋯ are, from the pages'
/// viewport (8px inside the panel, under the 40px toolbar).
fn toolbar_points(view: &PdfView) -> Option<(Point<Pixels>, Point<Pixels>)> {
    let pages = view.viewport_bounds();
    if pages.size.width <= px(0.) {
        return None;
    }
    let (left, right) = (pages.left() - px(8.), pages.right() + px(8.));
    let y = pages.top() - px(8. + 20.);
    // 6px in, the page controls (24 + 1 + 44 + 1 + 24), the gap.
    let outline = point(left + px(6. + 94. + 4. + 12.), y);
    let overflow = point(right - px(6. + 12.), y);
    Some((outline, overflow))
}
