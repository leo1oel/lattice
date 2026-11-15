//! The e2e checks of the live math preview
//! (`lattice_editor::latex::math_preview` on the adapter's caret card),
//! against the Tauri app's (`src/editor/latex/math-preview.ts` and its
//! `math-preview.test.ts`), typed with native keys in a scratch chapter:
//!
//! - with the caret in inline math, a card above the formula shows KaTeX's
//!   picture of it, and typing updates the picture (each keystroke timed
//!   from the key to the frame that shows it), and a burst of keys with no
//!   pause between ends on the last one's picture;
//! - half-typed math keeps the last good picture, dimmed, and loses the dim
//!   once the math is whole again;
//! - in an `align`, the card is display math set with the project's macro,
//!   above the environment's first line;
//! - Escape puts it away until the caret leaves the formula, the caret
//!   outside math shows none, and the editor losing the keyboard hides it.
//!
//! With `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the card over the inline
//! and the display math in the light and dark appearances.

use std::{
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity};
use lattice_editor::{
    LatticeEditor,
    latex::math_preview::{MathPreview, Shown},
};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

const CHAPTER: &str = "math-preview.tex";
const SOURCE: &str = r"\newcommand{\area}{\mathcal{A}}
\section{Math preview}
Energy $E = mc^2$ is the line typed in.

Some prose comes before the display math, so it has room above it.
\begin{align}
  a &= \int_0^1 x^2\,dx \\
  b &= \area
\end{align}
After the math.
";
/// The inline formula once the keys are typed into it.
const TYPED: &str = "E = mc^2+1+x_3";

/// What the editor's math preview holds, and whether the editor drew it.
fn preview(lattice: &Entity<LatticeEditor>, cx: &gpui::App) -> (Option<Shown>, bool) {
    let lattice = lattice.read(cx);
    let shown = lattice.caret_card_provider().and_then(|provider| {
        provider
            .as_any()
            .downcast_ref::<MathPreview>()
            .and_then(MathPreview::shown)
    });
    (shown, lattice.shown_caret_card(cx).is_some())
}

impl Run {
    pub(super) async fn math_preview(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let _front = self.focused(cx, "math_preview").await?;
        std::fs::write(root.join(CHAPTER), SOURCE)?;
        let result = self.math_preview_checks(cx, steps, root).await;
        std::fs::remove_file(root.join(CHAPTER)).ok();
        result
    }

    /// Wait, drawing frames, until what the preview holds and whether it is
    /// drawn are as `want` says; how long that took (`None`: never).
    async fn preview_until(
        &self,
        cx: &mut AsyncApp,
        lattice: &Entity<LatticeEditor>,
        want: impl Fn(&(Option<Shown>, bool)) -> bool,
        timeout: Duration,
    ) -> Option<Duration> {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if cx.update(|cx| want(&preview(lattice, cx))) {
                return Some(started.elapsed());
            }
            self.pump_frame(cx);
            cx.background_executor()
                .timer(Duration::from_millis(1))
                .await;
        }
        None
    }

    async fn math_preview_checks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let panel = self.open(cx, &root.join(CHAPTER), Some(1))?;
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());
        // The index reads the new chapter's macro.
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
        self.wait_for(cx, Duration::from_secs(10), |shell, cx| {
            shell.read(cx).project().is_some_and(|project| {
                project
                    .read(cx)
                    .index()
                    .read(cx)
                    .macro_sources()
                    .sources
                    .iter()
                    .any(|source| source.contains("\\area"))
            })
        })
        .await;

        // Inline math: the caret after `mc^2`.
        let text = self.editor_text(cx, &panel);
        let caret = text.find("mc^2$").context("the inline math")? + 4;
        self.select(cx, &panel, caret, caret)?;
        let shows = |source: &'static str| {
            move |(shown, drawn): &(Option<Shown>, bool)| {
                *drawn
                    && shown
                        .as_ref()
                        .is_some_and(|shown| shown.source == source && !shown.stale)
            }
        };
        let first = self
            .preview_until(cx, &lattice, shows("E = mc^2"), Duration::from_secs(15))
            .await;
        let inline_above = self.card_above(cx, &panel, &lattice, "$E = mc^2$").await;
        steps.check(
            "with the caret in inline math, a card above it shows KaTeX's picture of the formula",
            first.is_some() && inline_above.is_some_and(|(above, _)| above),
            json!({ "first_ms": first.map(|wait| wait.as_millis()), "placement": inline_above }),
        );
        self.math_preview_looks(cx, "math-preview-inline").await;

        // Typed with native keys: each keystroke's picture, timed.
        let mut waits = Vec::new();
        for (key, source) in [('+', "E = mc^2+"), ('1', "E = mc^2+1")] {
            self.press(cx, key, false).await?;
            let wait = self
                .preview_until(cx, &lattice, shows(source), Duration::from_secs(5))
                .await;
            waits.push(wait.map(|wait| wait.as_secs_f64() * 1000.));
        }
        // Keys typed with no pause between: the card ends on the last.
        let started = Instant::now();
        self.type_text(cx, "+x_3").await?;
        let burst = self
            .preview_until(cx, &lattice, shows(TYPED), Duration::from_secs(5))
            .await
            .map(|_| started.elapsed().as_secs_f64() * 1000.);
        steps.check(
            "typing in the formula updates the card's picture as it is typed, and a burst of keys ends on the last",
            waits.iter().all(Option::is_some) && burst.is_some(),
            json!({ "keystroke_ms": waits, "burst_of_4_ms": burst }),
        );

        // Half-typed: `\frac{` cannot be set; the last good picture stays, dimmed.
        let before = self.editor_text(cx, &panel);
        self.type_text(cx, "\\frac{").await?;
        let dimmed = self
            .preview_until(
                cx,
                &lattice,
                |(shown, drawn)| {
                    *drawn
                        && shown
                            .as_ref()
                            .is_some_and(|shown| shown.stale && shown.source == TYPED)
                },
                Duration::from_secs(5),
            )
            .await;
        let typed = self.editor_text(cx, &panel);
        let caret = before.find("$ is the line").context("the typed math")?;
        self.with_window(cx, |_, window, cx| {
            panel.update(cx, |panel, cx| {
                panel.replace_range(0, typed.len(), &before, caret, window, cx)
            })
        })?;
        let whole = self
            .preview_until(cx, &lattice, shows(TYPED), Duration::from_secs(5))
            .await;
        steps.check(
            "half-typed math keeps the last good picture, dimmed, and loses the dim once whole",
            dimmed.is_some() && whole.is_some(),
            json!({ "dimmed": dimmed.is_some(), "whole": whole.is_some(), "typed": typed }),
        );

        // Escape puts it away, and typing in the formula leaves it away.
        if cx.update(|cx| {
            panel
                .read(cx)
                .editor()
                .read(cx)
                .has_visible_completions_menu()
        }) {
            self.press(cx, '\u{1b}', false).await?;
        }
        self.press(cx, '\u{1b}', false).await?;
        let away = self
            .preview_until(cx, &lattice, |(_, drawn)| !drawn, Duration::from_secs(2))
            .await;
        self.press(cx, 'z', false).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let still_away = cx.update(|cx| !preview(&lattice, cx).1);

        // Another formula: display math with the project's macro, above
        // the environment's first line.
        let text = self.editor_text(cx, &panel);
        let caret = text.find("b &= \\area").context("the align")? + 10;
        self.reveal(cx, &panel, "b &= \\area").await?;
        self.select(cx, &panel, caret, caret)?;
        let display = self
            .preview_until(
                cx,
                &lattice,
                |(shown, drawn)| {
                    *drawn
                        && shown.as_ref().is_some_and(|shown| {
                            shown.display && shown.source.contains("\\area") && !shown.stale
                        })
                },
                Duration::from_secs(10),
            )
            .await;
        let display_above = self
            .card_above(cx, &panel, &lattice, "\\begin{align}")
            .await;
        steps.check(
            "Escape puts the card away until the caret leaves the formula; in an align it shows display math with the project's macro above the environment",
            away.is_some()
                && still_away
                && display.is_some()
                && display_above.is_some_and(|(above, _)| above),
            json!({
                "away": away.is_some(),
                "still_away": still_away,
                "display": display.is_some(),
                "placement": display_above,
            }),
        );
        self.math_preview_looks(cx, "math-preview-display").await;

        // Back in the inline formula it shows again; outside math, none;
        // with the keyboard elsewhere, none.
        let text = self.editor_text(cx, &panel);
        let caret = text.find("mc^2").context("the inline math")? + 2;
        self.select(cx, &panel, caret, caret)?;
        let again = self
            .preview_until(
                cx,
                &lattice,
                |(shown, drawn)| *drawn && shown.as_ref().is_some_and(|shown| !shown.display),
                Duration::from_secs(5),
            )
            .await;
        let caret = text.find("After the math").context("the prose")? + 3;
        self.select(cx, &panel, caret, caret)?;
        let outside = self
            .preview_until(cx, &lattice, |(_, drawn)| !drawn, Duration::from_secs(2))
            .await;
        let caret = text.find("mc^2").context("the inline math")? + 2;
        self.select(cx, &panel, caret, caret)?;
        self.preview_until(cx, &lattice, |(_, drawn)| *drawn, Duration::from_secs(5))
            .await;
        self.with_window(cx, |_, window, cx| window.blur(cx))?;
        let blurred = self
            .preview_until(cx, &lattice, |(_, drawn)| !drawn, Duration::from_secs(2))
            .await;
        steps.check(
            "the card shows again in a formula Escape had left, and hides outside math and while the editor lacks the keyboard",
            again.is_some() && outside.is_some() && blurred.is_some(),
            json!({
                "again": again.is_some(),
                "outside": outside.is_some(),
                "blurred": blurred.is_some(),
            }),
        );

        // The chapter as it was, so closing it asks nothing.
        self.with_window(cx, |_, window, cx| {
            panel.update(cx, |panel, cx| {
                let len = panel.text_and_caret(cx).0.len();
                panel.replace_range(0, len, SOURCE, 0, window, cx)
            })
        })?;
        Ok(())
    }

    /// Whether the card drawn last frame stands above the line `needle`
    /// starts on, and the gap between them.
    async fn card_above(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
        needle: &str,
    ) -> Option<(bool, f32)> {
        // The card opens unseen for a frame, to learn its size.
        self.pause(cx, Duration::from_millis(100)).await;
        let (_, line) = self.text_point(cx, panel, lattice, needle, 0).await.ok()?;
        let card = cx.update(|cx| lattice.read(cx).painted().caret_card)?;
        let gap = f32::from(line.top() - card.bottom());
        Some(((0. ..=8.).contains(&gap), gap))
    }

    /// The window with the card, light and dark, under `LATTICE_E2E_SHOTS`.
    async fn math_preview_looks(&self, cx: &mut AsyncApp, name: &str) {
        use lattice_ui::{Appearance, LatticeTheme};
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return;
        }
        for (appearance, look) in [(Appearance::Dark, "dark"), (Appearance::Light, "light")] {
            cx.update(|cx| LatticeTheme::set_appearance(appearance, cx));
            // The picture is set again in the appearance's ink.
            self.pause(cx, Duration::from_millis(600)).await;
            self.adapter_shot(cx, &format!("{name}-{look}")).await;
        }
        cx.update(|cx| LatticeTheme::set_appearance(Appearance::Light, cx));
        self.pause(cx, Duration::from_millis(300)).await;
    }
}

/// This file's registration as the e2e module `math_preview` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 115,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-editor/src/latex/math_preview.rs",
        "gpui/crates/lattice-editor/src/caret_card.rs",
        "gpui/crates/lattice-editor/src/adapter/caret_card.rs",
        "gpui/crates/lattice-gpui/src/card_previews.rs",
        "gpui/islands/math",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.math_preview(cx, steps, &fixture.root)),
};
