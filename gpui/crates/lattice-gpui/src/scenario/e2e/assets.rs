//! The asset preview and the bibliographies' Delete, as a writer meets them
//! in the Project tree: an image opens in its viewer and zooms, a file it
//! cannot draw says so, a second `.bib` deletes after the same question as
//! any file, and the primary bibliography refuses with lattice-core's words.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

/// The test image's pixel size: small enough to sit unscaled on the stage.
const PLOT: (u32, u32) = (96, 64);

impl Run {
    pub(super) async fn asset_and_bib_steps(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        std::fs::create_dir_all(root.join("figures"))?;
        image::RgbaImage::from_fn(PLOT.0, PLOT.1, |x, y| {
            image::Rgba([(x * 2) as u8, (y * 3) as u8, 160, 255])
        })
        .save_with_format(root.join("figures/plot.png"), image::ImageFormat::Png)
        .context("could not write the test PNG")?;
        // An archive: binary to lattice-core's scan, a format no preview draws.
        std::fs::write(
            root.join("figures/data.zip"),
            b"PK\x03\x04\x14\x00\x00\x00\x08\x00",
        )?;
        std::fs::write(
            root.join("extra.bib"),
            "@article{extra2024,\n  title = {Another bibliography},\n  year = {2024}\n}\n",
        )?;
        cx.update(|cx| {
            if let Some(project) = self.shell.read(cx).project().cloned() {
                project.update(cx, |project, cx| project.rescan(cx));
            }
        });
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        self.wait_for(cx, Duration::from_secs(8), |_, cx| {
            let rows = tree.read(cx).row_paths(cx);
            ["figures/plot.png", "figures/data.zip", "extra.bib"]
                .iter()
                .all(|path| rows.iter().any(|row| row == path))
        })
        .await;

        // A PNG from the tree: its own tab, the image at its pixel size.
        let png = root.join("figures/plot.png");
        cx.update(|cx| {
            tree.update(cx, |_, cx| {
                cx.emit(crate::file_tree::FileTreeEvent::Open(png.clone()))
            })
        });
        let shown = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                shell.read(cx).asset_previews().iter().any(|panel| {
                    let panel = panel.read(cx);
                    panel.relative() == "figures/plot.png" && panel.image_sizes().is_some()
                })
            })
            .await;
        self.pause(cx, Duration::from_millis(200)).await;
        let preview = cx.update(|cx| {
            self.shell
                .read(cx)
                .asset_previews()
                .into_iter()
                .find(|panel| panel.read(cx).relative() == "figures/plot.png")
        });
        let (sizes, active) = cx.update(|cx| {
            (
                preview
                    .as_ref()
                    .and_then(|panel| panel.read(cx).image_sizes()),
                self.shell.read(cx).active_document(cx),
            )
        });
        let natural = sizes.map(|(natural, _)| (natural.width, natural.height));
        let drawn = sizes.map(|(_, drawn)| (drawn.width, drawn.height));
        let pixels = (PLOT.0 as f32, PLOT.1 as f32);
        steps.check(
            "a PNG opens from the tree in the image preview, at its pixel size, in front",
            shown
                && natural == Some(pixels)
                && drawn == Some(pixels)
                && active.as_deref() == Some("figures/plot.png"),
            json!({ "natural": natural, "drawn": drawn, "active": active }),
        );

        // Zoom in to 200%: the image is drawn at twice its fitted size.
        let zoomed = match &preview {
            Some(panel) => {
                cx.update(|cx| panel.update(cx, |panel, cx| panel.set_scale(2., cx)));
                self.pause(cx, Duration::from_millis(100)).await;
                cx.update(|cx| {
                    let panel = panel.read(cx);
                    (panel.scale(), panel.image_sizes().map(|(_, drawn)| drawn))
                })
            }
            None => (0., None),
        };
        steps.check(
            "the image preview zooms: 200% draws it at twice its size",
            zoomed.0 == 2.
                && zoomed
                    .1
                    .is_some_and(|drawn| drawn.width == pixels.0 * 2. && drawn.height == pixels.1 * 2.),
            json!({ "scale": zoomed.0, "drawn": zoomed.1.map(|drawn| (drawn.width, drawn.height)) }),
        );

        // A file the preview cannot draw shows the Tauri app's fallback.
        let archive = root.join("figures/data.zip");
        self.with_window(cx, move |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_path(archive, None, window, cx))
        })?;
        let fallback = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                shell.read(cx).asset_previews().iter().any(|panel| {
                    let panel = panel.read(cx);
                    panel.relative() == "figures/data.zip" && panel.unsupported()
                })
            })
            .await;
        steps.check(
            "a binary file the preview cannot draw says so, as the Tauri app's does",
            fallback,
            json!({}),
        );

        // Delete on a second bibliography asks first, as on any file.
        let notices = cx.update(crate::notices::install);
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        cx.update(|cx| tree.update(cx, |tree, cx| tree.ask_delete("extra.bib".into(), cx)));
        self.pause(cx, Duration::from_millis(200)).await;
        let question = cx.update(|cx| self.shell.read(cx).confirm().read(cx).question());
        let confirm = cx.update(|cx| self.shell.read(cx).confirm().clone());
        self.with_window(cx, |_, window, cx| {
            confirm.update(cx, |confirm, cx| confirm.accept(window, cx))
        })?;
        let deleted = self
            .wait_for(cx, Duration::from_secs(8), |_, _| {
                !root.join("extra.bib").exists()
            })
            .await;
        steps.check(
            "a .bib that is not the primary bibliography deletes after the same question",
            question.as_deref() == Some("Delete “extra.bib” from this project?") && deleted,
            json!({ "question": question }),
        );

        // Delete on the primary bibliography says why it is kept, and asks
        // nothing; the main document may go (only the bibliography is kept).
        let primary = cx.update(|cx| {
            self.shell
                .read(cx)
                .project()
                .map(|project| project.read(cx).manifest().primary_bibliography.clone())
                .unwrap_or_default()
        });
        cx.update(|cx| tree.update(cx, |tree, cx| tree.ask_delete(primary.clone(), cx)));
        self.pause(cx, Duration::from_millis(200)).await;
        let asked = cx.update(|cx| self.shell.read(cx).confirm().read(cx).question());
        let titles: Vec<String> = cx.update(|cx| {
            notices
                .read(cx)
                .titles()
                .into_iter()
                .map(|title| title.to_string())
                .collect()
        });
        let main_kept = cx.update(|cx| tree.read(cx).protected("main.tex", cx));
        steps.check(
            "the primary bibliography refuses Delete with the reason, and the main document is deletable",
            primary == "references.bib"
                && asked.is_none()
                && root.join(&primary).is_file()
                && titles
                    .iter()
                    .any(|title| title == "The primary bibliography cannot be deleted.")
                && !main_kept,
            json!({ "primary": primary, "asked": asked, "notices": titles, "main_protected": main_kept }),
        );
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        // The steps after these find the documents as they left them.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_asset_previews(window, cx))
        })?;
        Ok(())
    }
}

/// This file's registration as the e2e module `assets` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 40,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/assets.rs",
        "gpui/crates/lattice-gpui/src/asset_preview.rs",
        "gpui/crates/lattice-gpui/src/shell/assets.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.asset_and_bib_steps(cx, steps, &fixture.root)),
};
