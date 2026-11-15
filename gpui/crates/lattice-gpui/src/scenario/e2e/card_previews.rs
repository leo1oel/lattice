//! The e2e checks of the source editor's card previews
//! (`lattice_editor::latex::preview_cards`, drawn through `card_previews.rs`
//! and the math island's page), against what the Tauri app's cards show
//! (`src/editor/latex/latex-hover-cards.ts`):
//!
//! - a figure label's card shows the figure's image, and resting on an
//!   `\includegraphics` path opens a card of the figure alone; an EPS figure
//!   says it has no preview;
//! - an equation label's card shows the equation set by KaTeX, with the
//!   project's own macros, and a formula KaTeX cannot set keeps its source
//!   (`equationHtml` returns null for it);
//! - the last build's `.aux` numbers a label (main.tex's `sec:method`, which
//!   follows the introduction's section, is section 2 on page 1).
//!
//! The figure, the equation and their labels are written into the scratch
//! project for this module and taken out after. With `LATTICE_E2E_SHOTS=DIR`
//! (macOS) the figure, equation and graphics-path cards are saved there in
//! the light and dark appearances.

use std::{path::Path, time::Duration, time::Instant};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity, point, px};
use lattice_editor::{
    LatticeEditor,
    latex::previews::{self, Figure, MacroSources, MathRequest, Preview},
};
use lattice_ui::ActiveLattice as _;
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, native, scenario::Run};

/// The chapter this module writes, and the files it shows.
const CHAPTER: &str = "previews.tex";
const FIGURE: &str = "figures/curve.png";
const VECTOR: &str = "figures/sketch.eps";
const SOURCE: &str = r"\newcommand{\area}{\mathcal{A}}
\section{Previews}
\begin{figure}
  \centering
  \includegraphics[width=0.6\linewidth]{figures/curve}
  \caption{A plotted curve.}
  \label{fig:curve}
\end{figure}
\begin{equation}
  \area = \int_0^1 x^2\,dx = \frac{1}{3} \label{eq:area}
\end{equation}
\begin{figure}
  \includegraphics{figures/sketch.eps}
  \caption{A sketch.}
  \label{fig:sketch}
\end{figure}
See Figure~\ref{fig:curve}, Equation~\eqref{eq:area} and Figure~\ref{fig:sketch}.
";

/// A 320 by 160 picture: a dark curve over a pale grid.
fn curve_png() -> Result<Vec<u8>> {
    let mut picture = image::RgbaImage::from_pixel(320, 160, image::Rgba([250, 250, 252, 255]));
    for (x, y, pixel) in picture.enumerate_pixels_mut() {
        if x % 40 == 0 || y % 40 == 0 {
            *pixel = image::Rgba([220, 224, 232, 255]);
        }
        let curve = 150. - 140. * (x as f32 / 320.).powi(2);
        if (y as f32 - curve).abs() < 2.5 {
            *pixel = image::Rgba([40, 90, 200, 255]);
        }
    }
    let mut png = Vec::new();
    picture.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
    Ok(png)
}

/// A picture's pixels (BGRA; the order is the same for what is read here).
fn pixels(picture: &gpui::RenderImage) -> Vec<[u8; 4]> {
    picture
        .as_bytes(0)
        .unwrap_or_default()
        .as_chunks::<4>()
        .0
        .to_vec()
}

/// How much of a picture is inked: the share of its pixels that are not clear.
fn inked_share(picture: &gpui::RenderImage) -> f32 {
    let pixels = pixels(picture);
    pixels.iter().filter(|pixel| pixel[3] > 64).count() as f32 / pixels.len().max(1) as f32
}

/// The mean lightness (0 to 1) of a picture's solid pixels: its ink's.
fn ink_lightness(picture: &gpui::RenderImage) -> f32 {
    let solid: Vec<f32> = pixels(picture)
        .iter()
        .filter(|pixel| pixel[3] > 200)
        .map(|pixel| (pixel[0] as f32 + pixel[1] as f32 + pixel[2] as f32) / (3. * 255.))
        .collect();
    solid.iter().sum::<f32>() / solid.len().max(1) as f32
}

impl Run {
    pub(super) async fn card_previews(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let _front = self.focused(cx, "card_previews").await?;
        std::fs::create_dir_all(root.join("figures"))?;
        std::fs::write(root.join(FIGURE), curve_png()?)?;
        std::fs::write(
            root.join(VECTOR),
            "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n",
        )?;
        std::fs::write(root.join(CHAPTER), SOURCE)?;
        let result = self.card_preview_checks(cx, steps, root).await;
        for file in [CHAPTER, FIGURE, VECTOR] {
            std::fs::remove_file(root.join(file)).ok();
        }
        std::fs::remove_dir(root.join("figures")).ok();
        self.card_park(cx)?;
        result
    }

    async fn card_preview_checks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        // The build's numbers, read from the `.aux` the smoke flow's build wrote.
        let main = self.open(cx, &root.join("main.tex"), Some(8))?;
        let numbered = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).project().is_some_and(|project| {
                    project
                        .read(cx)
                        .index()
                        .read(cx)
                        .compiled_label("sec:method")
                        .is_some()
                })
            })
            .await;
        let compiled = cx.update(|cx| {
            self.shell.read(cx).project().and_then(|project| {
                project
                    .read(cx)
                    .index()
                    .read(cx)
                    .compiled_label("sec:method")
                    .cloned()
            })
        });
        steps.check(
            "the last build's .aux numbers a label for its card (sec:method: section 2, page 1)",
            numbered
                && compiled
                    .as_ref()
                    .is_some_and(|label| label.number == "2" && label.page == "1"),
            json!({ "compiled": compiled.map(|label| [label.number, label.page]) }),
        );
        let main_lattice = self.lattice_of(cx, &main);
        let (_, label) = self
            .text_point(cx, &main, &main_lattice, "sec:method}.", 4)
            .await?;
        self.hover_at(cx, label.center()).await?;
        self.wait_for_card(cx, &main_lattice, "reference").await;
        self.adapter_shot(cx, "card-previews-number").await;
        self.card_park(cx)?;

        let panel = self.open(cx, &root.join(CHAPTER), Some(1))?;
        let lattice = self.lattice_of(cx, &panel);
        // The index reads the new chapter, its figures and its macro.
        cx.update(|cx| {
            let index = self
                .shell
                .read(cx)
                .project()
                .map(|project| project.read(cx).index().clone());
            if let Some(index) = index {
                index.update(cx, |index, cx| index.refresh(cx));
            }
        });
        let indexed = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).project().is_some_and(|project| {
                    let index = project.read(cx).index().read(cx);
                    index
                        .reference("fig:curve")
                        .is_some_and(|reference| reference.image_path.as_deref() == Some(FIGURE))
                        && index.paths().iter().any(|path| path == VECTOR)
                        && index
                            .macro_sources()
                            .sources
                            .iter()
                            .any(|source| source.contains("\\area"))
                })
            })
            .await;
        steps.check(
            "the index has the figure's graphic, the project's files and its TeX sources",
            indexed,
            json!({}),
        );

        self.figure_cards(cx, steps, root, &panel, &lattice).await?;
        self.equation_card(cx, steps, &panel, &lattice).await?;
        Ok(())
    }

    fn lattice_of(&self, cx: &mut AsyncApp, panel: &Entity<EditorPanel>) -> Entity<LatticeEditor> {
        cx.update(|cx| panel.read(cx).lattice_editor().clone())
    }

    async fn figure_cards(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<()> {
        let figure = root.join(FIGURE);
        let editor = lattice.downgrade();
        // A label's card, then the path's.
        for (needle, card, shot) in [
            ("fig:curve},", "reference", "figure-card"),
            ("figures/curve}", "graphics", "graphics-path-card"),
        ] {
            let (_, at) = self.text_point(cx, panel, lattice, needle, 4).await?;
            self.hover_at(cx, at.center()).await?;
            let shown = self.wait_for_card(cx, lattice, card).await.is_some();
            let read = self
                .wait_for(cx, Duration::from_secs(5), |_, cx| {
                    matches!(
                        previews::figure(&figure, &editor, cx),
                        Some(Preview::Ready(Figure::Shown(_)))
                    )
                })
                .await;
            self.card_looks(cx, shot).await;
            steps.check(
                &format!("resting on {needle} opens the {card} card with the figure's image"),
                shown && read,
                json!({ "shown": shown, "read": read }),
            );
            self.card_park(cx)?;
            self.pause(cx, Duration::from_millis(400)).await;
        }
        let vector = root.join(VECTOR);
        let unavailable = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                matches!(
                    previews::figure(&vector, &editor, cx),
                    Some(Preview::Ready(Figure::Unavailable))
                )
            })
            .await;
        steps.check(
            "an EPS figure has no preview, as the Tauri app's card says",
            unavailable,
            json!({}),
        );
        Ok(())
    }

    async fn equation_card(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
    ) -> Result<()> {
        let editor = lattice.downgrade();
        let macros = cx.update(|cx| {
            self.shell
                .read(cx)
                .project()
                .map(|project| project.read(cx).index().read(cx).macro_sources().clone())
                .unwrap_or_default()
        });
        let request = |tex: &str, macros: &MacroSources, cx: &mut gpui::App| MathRequest {
            tex: tex.to_string(),
            display: true,
            size: px(13.),
            color: cx.palette().text,
            macros: macros.clone(),
        };
        // Set as a card would, timed cold (the page loads) and again (kept).
        let area = r"\area = \int_0^1 x^2\,dx = \frac{1}{3} \label{eq:area}";
        let started = Instant::now();
        let mut picture = None;
        self.wait_for(cx, Duration::from_secs(15), |_, cx| {
            let wanted = request(area, &macros, cx);
            match previews::math(&wanted, &editor, cx) {
                Some(Preview::Ready(found)) => {
                    picture = Some(found);
                    true
                }
                _ => false,
            }
        })
        .await;
        let first = started.elapsed();
        let started = Instant::now();
        let kept = cx.update(|cx| {
            let wanted = request(area, &macros, cx);
            matches!(
                previews::math(&wanted, &editor, cx),
                Some(Preview::Ready(Some(_)))
            )
        });
        let again = started.elapsed();
        let picture = picture.flatten();
        let ink = picture
            .as_ref()
            .map_or(0., |picture| inked_share(&picture.image));
        let size = picture
            .as_ref()
            .map(|picture| [f32::from(picture.width), f32::from(picture.height)]);
        steps.check(
            "KaTeX sets an equation with the project's macros, as a picture with ink, kept once set",
            picture.is_some() && kept && ink > 0.01 && size.is_some_and(|[w, h]| w > h && h > 10.),
            json!({ "first_ms": first.as_millis(), "kept_us": again.as_micros(), "ink": ink, "size": size }),
        );

        // KaTeX refuses an unknown macro and half-typed math: the card keeps
        // the source (`equationHtml` is null), as without the macros read.
        let refused = |tex: &'static str, macros: MacroSources| {
            let editor = editor.clone();
            move |_: &Entity<crate::shell::Shell>, cx: &mut gpui::App| {
                let wanted = request(tex, &macros, cx);
                matches!(
                    previews::math(&wanted, &editor, cx),
                    Some(Preview::Ready(None))
                )
            }
        };
        let unknown = self
            .wait_for(
                cx,
                Duration::from_secs(5),
                refused(r"\area = 1", MacroSources::default()),
            )
            .await;
        let half = self
            .wait_for(
                cx,
                Duration::from_secs(5),
                refused(r"\frac{1", macros.clone()),
            )
            .await;
        // In the dark appearance the card's ink is light, and so is the picture's.
        let mut inks = Vec::new();
        for appearance in [lattice_ui::Appearance::Light, lattice_ui::Appearance::Dark] {
            cx.update(|cx| lattice_ui::LatticeTheme::set_appearance(appearance, cx));
            let mut drawn = None;
            self.wait_for(cx, Duration::from_secs(5), |_, cx| {
                let wanted = request(area, &macros, cx);
                match previews::math(&wanted, &editor, cx) {
                    Some(Preview::Ready(Some(picture))) => {
                        drawn = Some((ink_lightness(&picture.image), wanted.color.l));
                        true
                    }
                    _ => false,
                }
            })
            .await;
            inks.push(drawn);
        }
        cx.update(|cx| lattice_ui::LatticeTheme::set_appearance(lattice_ui::Appearance::Light, cx));
        let follows = matches!(
            inks.as_slice(),
            [Some((light, _)), Some((dark, _))] if *light < 0.35 && *dark > 0.65
        );
        steps.check(
            "an equation is set in the card's ink: dark in the light appearance, light in the dark",
            follows,
            json!({ "inks": inks }),
        );
        steps.check(
            "math KaTeX cannot set (an unknown macro, half-typed) keeps its source",
            unknown && half,
            json!({ "unknown": unknown, "half": half }),
        );

        // The `\eqref` in the closing sentence.
        let (_, at) = self
            .text_point(cx, panel, lattice, "eq:area} and", 4)
            .await
            .context("the \\eqref")?;
        self.hover_at(cx, at.center()).await?;
        let shown = self.wait_for_card(cx, lattice, "reference").await.is_some();
        self.card_looks(cx, "equation-card").await;
        steps.check(
            "resting on an \\eqref opens the equation's card",
            shown,
            json!({}),
        );
        self.card_park(cx)?;
        Ok(())
    }

    /// The card as it looks now, light and dark: the pointer stays, so the
    /// card stays, and its pictures are set again in the dark ink.
    async fn card_looks(&self, cx: &mut AsyncApp, name: &str) {
        use lattice_ui::{Appearance, LatticeTheme};
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return;
        }
        for (appearance, look) in [(Appearance::Dark, "dark"), (Appearance::Light, "light")] {
            cx.update(|cx| LatticeTheme::set_appearance(appearance, cx));
            // The dark picture is set and drawn.
            self.pause(cx, Duration::from_millis(600)).await;
            self.adapter_shot(cx, &format!("{name}-{look}")).await;
        }
        cx.update(|cx| LatticeTheme::set_appearance(Appearance::Light, cx));
        self.pause(cx, Duration::from_millis(300)).await;
    }

    fn card_park(&self, cx: &mut AsyncApp) -> Result<()> {
        let corner = self.with_window(cx, |_, window, _| {
            let size = window.viewport_size();
            point(size.width - px(4.), size.height - px(4.))
        })?;
        native::send_mouse(self.native(cx)?, native::Mouse::Moved, corner)
    }
}

/// This file's registration as the e2e module `card_previews` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 114,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-editor/src/latex/preview_cards.rs",
        "gpui/crates/lattice-editor/src/latex/previews.rs",
        "gpui/crates/lattice-editor/src/latex/compiled_labels.rs",
        "gpui/crates/lattice-editor/src/latex/graphics.rs",
        "gpui/crates/lattice-gpui/src/card_previews.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/card_context.rs",
        "gpui/islands/math",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.card_previews(cx, steps, &fixture.root)),
};
