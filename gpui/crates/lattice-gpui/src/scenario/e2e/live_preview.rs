//! The LuaLaTeX live preview, end to end, as a writer meets it: the project
//! switched to LuaLaTeX downloads the pinned rtex (lattice-core verifies it)
//! into the scratch HOME and starts it, the pill says each stage, a LuaLaTeX
//! build gives the base PDF, typing into a paragraph paints it over its page
//! within moments, the save's build waits for the pause and runs quietly (no
//! spinner on the Build button), its PDF takes over and the paint goes, and
//! Settings' switch turns it off. The project's engine and text are put back
//! after.

use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
use gpui::{App, AsyncApp, Entity};
use lattice_core::project::{self, ManifestSettings};
use serde_json::json;

use super::{super::Run, Steps};
use crate::{
    build_panel::ChipState,
    live_preview::{LivePreview, Phase, State, status},
    pdf::PdfView,
};

/// The first download, the preamble loaded into LuaLaTeX and the first
/// whole-document layout, on a cold machine.
const STARTS_WITHIN: Duration = Duration::from_secs(180);

/// What the live layer of the live PDF holds now: the pages drawn, and in
/// the first one's image the share of pixels the layer covers (opaque) and
/// of those that are ink rather than paper.
fn layer_state(view: &Entity<PdfView>, cx: &App) -> (Vec<usize>, u64, f32, f32) {
    let view = view.read(cx);
    let Some(layer) = view.live_layer() else {
        return (Vec::new(), 0, 0., 0.);
    };
    let pages = layer.drawn_pages();
    let (mut covered, mut ink, mut total) = (0u64, 0u64, 0u64);
    if let Some(bytes) = pages
        .first()
        .and_then(|page| layer.image(*page))
        .and_then(|image| image.as_bytes(0).map(<[u8]>::to_vec))
    {
        for pixel in bytes.chunks_exact(4) {
            total += 1;
            if pixel[3] > 0 {
                covered += 1;
                if pixel[0] < 128 && pixel[1] < 128 && pixel[2] < 128 {
                    ink += 1;
                }
            }
        }
    }
    let share = |n: u64| {
        if total == 0 {
            0.
        } else {
            n as f32 / total as f32
        }
    };
    let ink_share = if covered == 0 {
        0.
    } else {
        ink as f32 / covered as f32
    };
    (pages, layer.draws, share(covered), ink_share)
}

fn state_name(preview: &LivePreview) -> String {
    match preview.state() {
        State::Off => "off".into(),
        State::Downloading(_) => "downloading".into(),
        State::Starting => "starting".into(),
        State::Running => format!(
            "running:{:?}",
            preview.snapshot().map(|snapshot| snapshot.phase)
        ),
        State::Failed(message) => format!("failed: {message}"),
        State::Unavailable => "unavailable".into(),
        State::DownloadFailed(message) => format!("download failed: {message}"),
    }
}

impl Run {
    /// The live preview alone (`--scenario live-preview`), for work on it:
    /// the e2e scenario runs it too.
    pub(in crate::scenario) async fn live_preview_scenario(
        &self,
        cx: &mut AsyncApp,
    ) -> Result<serde_json::Value> {
        let mut steps = Steps::new(self);
        let root = self.root(cx).await?;
        // The shots find the pill by its probe.
        if std::env::var_os("LATTICE_E2E_SHOTS").is_some() {
            lattice_ui::parity::enable();
        }
        self.pause(cx, Duration::from_millis(800)).await;
        // The PDF a writer has before switching, as in the e2e run.
        self.build(cx).await?;
        self.live_preview(cx, &mut steps, &root).await?;
        let passed = steps.0.iter().all(|step| step["passed"] == true);
        Ok(json!({ "scenario": "live-preview", "passed": passed, "steps": steps.0 }))
    }

    pub(super) async fn live_preview(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &std::path::Path,
    ) -> Result<()> {
        let project = cx
            .update(|cx| self.shell.read(cx).project().cloned())
            .context("a project is open")?;
        let preview = cx.update(|cx| self.shell.read(cx).live_preview.clone());
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        let engine = cx.update(|cx| project.read(cx).manifest().engine.clone());
        let chapter = root.join("chapters/intro.tex");
        let original = std::fs::read_to_string(&chapter)?;

        // A pdfLaTeX project offers no live preview, and runs none.
        let offered = cx.update(|cx| preview.read(cx).available());
        steps.check(
            "a pdfLaTeX project is offered no live preview",
            !offered && cx.update(|cx| *preview.read(cx).state() == State::Off),
            json!({ "engine": engine }),
        );

        // Settings › Editor & builds › Compile engine: LuaLaTeX.
        project::update_manifest_settings(
            root,
            ManifestSettings {
                engine: Some("lualatex".into()),
                ..ManifestSettings::default()
            },
        )
        .map_err(anyhow::Error::msg)?;
        cx.update(|cx| project.update(cx, |project, cx| project.reload_manifest(cx)));

        // Not a Mac, or no working LuaLaTeX: no rtex and no pill.
        self.wait_for(cx, Duration::from_secs(30), |_, cx| {
            let preview = preview.read(cx);
            *preview.state() == State::Unavailable
                || preview
                    .install_status()
                    .is_some_and(|install| install.supported() && install.lualatex())
        })
        .await;
        if cx.update(|cx| *preview.read(cx).state() == State::Unavailable) {
            let install = cx.update(|cx| {
                preview
                    .read(cx)
                    .install_status()
                    .map(|install| (install.supported(), install.lualatex()))
            });
            let quiet = cx.update(|cx| status::status(preview.read(cx)).is_none());
            steps.check(
                "where rtex cannot run, a LuaLaTeX project shows no live preview pill",
                quiet && install.is_some_and(|(supported, lualatex)| !supported || !lualatex),
                json!({ "install": format!("{install:?}") }),
            );
            return self.restore_engine(cx, &project, root, &engine).await;
        }

        // The download, the start and the first layout, each said by the pill.
        let mut seen: Vec<String> = Vec::new();
        let mut pills: Vec<String> = Vec::new();
        let mut sample = |preview: &LivePreview| {
            let name = state_name(preview);
            if seen.last() != Some(&name) {
                seen.push(name);
            }
            if let Some(pill) = status::status(preview) {
                let label = pill.label.to_string();
                if pills.last() != Some(&label) {
                    pills.push(label);
                }
            }
        };
        let started = Instant::now();
        let mut busy_bounds = None;
        if std::env::var_os("LATTICE_E2E_SHOTS").is_some() {
            self.wait_for(cx, Duration::from_secs(30), |_, cx| {
                sample(preview.read(cx));
                matches!(preview.read(cx).state(), State::Downloading(share) if *share > 0.)
            })
            .await;
            self.snapshot(cx, "live-preview-downloading").await;
            busy_bounds = lattice_ui::parity::regions()
                .get("live-preview-status")
                .and_then(|region| region.bounds)
                .map(|bounds| format!("{bounds:?}"));
        }
        let live = self
            .wait_for(cx, STARTS_WITHIN, |_, cx| {
                let preview = preview.read(cx);
                sample(preview);
                preview
                    .snapshot()
                    .is_some_and(|snapshot| snapshot.phase == Phase::Live)
            })
            .await;
        drop(sample);
        let installed = cx.update(|cx| {
            preview
                .read(cx)
                .install_status()
                .is_some_and(|install| install.installed())
        });
        steps.check(
            "a LuaLaTeX project downloads rtex, starts it and lays the document out, the pill saying each stage",
            live && installed && seen.iter().any(|state| state == "downloading"),
            json!({ "seconds": started.elapsed().as_secs_f32(), "states": seen, "pills": pills, "busy_pill_bounds": busy_bounds }),
        );
        if !live {
            return self.restore_engine(cx, &project, root, &engine).await;
        }

        // The base PDF: a LuaLaTeX build of the files as they are.
        let (built, took) = self.build(cx).await?;
        let settled = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                preview.read(cx).is_live() && preview.read(cx).overlays() == 0
            })
            .await;
        let (pages, _, _, _) = cx.update(|cx| layer_state(&view, cx));
        let pill = cx.update(|cx| status::status(preview.read(cx)).map(|pill| pill.tone));
        self.snapshot(cx, "live-preview-live").await;
        if let Some(pill) = lattice_ui::parity::regions()
            .get("live-preview-status")
            .and_then(|region| region.bounds)
        {
            self.rest_pointer(cx, pill.center()).await?;
            self.snapshot(cx, "live-preview-tooltip").await;
            self.rest_pointer(cx, gpui::point(gpui::px(4.), gpui::px(4.)))
                .await?;
        }
        steps.check(
            "a LuaLaTeX build gives the base PDF, every page the PDF's own and the pill only its dot",
            built && settled && pages.is_empty() && pill == Some(status::Tone::Live),
            json!({
                "seconds": took.as_secs_f32(),
                "layer_pages": pages,
                "pill": format!("{pill:?}"),
                // Recorded in a parity or shots run only.
                "pill_bounds": lattice_ui::parity::regions()
                    .get("live-preview-status")
                    .and_then(|region| region.bounds)
                    .map(|bounds| format!("{bounds:?}")),
            }),
        );

        // The separate window shows the paper's own PDF, as the Tauri app's
        // does (project-pdf-panel.tsx): the live layer stays with the panel,
        // and is still there once the PDF returns to the workspace. The
        // typing step below then shows it still paints.
        let pdf = cx.update(|cx| self.shell.read(cx).pdf().clone());
        self.with_window(cx, |_, window, cx| {
            pdf.update(cx, |pdf, cx| pdf.detach(window, cx));
        })?;
        let detached = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).pdf().read(cx).in_window()
            })
            .await;
        let window_layer = cx.update(|cx| {
            let pdf = pdf.read(cx);
            pdf.in_window() && pdf.live_view().read(cx).live_layer().is_some()
        });
        self.with_window(cx, |_, window, cx| {
            pdf.update(cx, |pdf, cx| pdf.dock(true, window, cx));
        })?;
        let docked = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                !shell.read(cx).pdf().read(cx).in_window()
            })
            .await;
        let panel_layer = cx.update(|cx| {
            let pdf = pdf.read(cx);
            pdf.live_view() == &view && view.read(cx).live_layer().is_some()
        });
        steps.check(
            "Open in separate window shows the PDF without the live layer, and the panel keeps it on return",
            detached && !window_layer && docked && panel_layer,
            json!({
                "detached": detached,
                "window_has_live_layer": window_layer,
                "docked": docked,
                "panel_has_live_layer": panel_layer,
            }),
        );
        self.pause(cx, Duration::from_millis(500)).await;

        // Typing into a paragraph paints it over its page.
        let editor = self.open(cx, &chapter, Some(2))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let before = cx.update(|cx| preview.read(cx).received("ParagraphUpdate"));
        // Before the typing's save can start a quiet build.
        let quiet_before = cx.update(|cx| self.shell.read(cx).build_panel().read(cx).quiet_runs());
        let typed_at = Instant::now();
        self.type_text(cx, "Typed live ").await?;
        let painted = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                preview.read(cx).received("ParagraphUpdate") > before
                    && !layer_state(&view, cx).0.is_empty()
            })
            .await;
        let latency = typed_at.elapsed();
        self.pause(cx, Duration::from_millis(300)).await;
        let (pages, draws, covered, ink) = cx.update(|cx| layer_state(&view, cx));
        self.snapshot(cx, "live-preview-typed").await;
        steps.check(
            "typing into a paragraph paints it over its page, a band of paper and ink over the PDF",
            painted && covered > 0.001 && covered < 0.6 && ink > 0.005,
            json!({
                "seconds": latency.as_secs_f32(),
                "pages": pages,
                "draws": draws,
                "covered": covered,
                "ink_of_covered": ink,
                "paragraph_updates": cx.update(|cx| preview.read(cx).received("ParagraphUpdate")),
            }),
        );

        // The save's build waits for the pause in typing, then runs quietly.
        let saved = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                !editor.read(cx).is_dirty(cx)
            })
            .await;
        let saved_at = Instant::now();
        self.pause(cx, Duration::from_millis(1_500)).await;
        let held = cx.update(|cx| !self.shell.read(cx).building());
        self.snapshot(cx, "live-preview-held").await;
        let mut chip_spun = false;
        let quiet_ran = self
            .wait_for(cx, Duration::from_secs(40), |shell, cx| {
                let shell = shell.read(cx);
                let panel = shell.build_panel().read(cx);
                chip_spun |= matches!(panel.chip(), ChipState::Running(_));
                panel.quiet_runs() > quiet_before && !shell.building()
            })
            .await;
        let waited = saved_at.elapsed();
        let handed_over = self
            .wait_for(cx, Duration::from_secs(30), |_, cx| {
                preview.read(cx).overlays() == 0 && layer_state(&view, cx).0.is_empty()
            })
            .await;
        steps.check(
            "the save's build waits for typing to pause and runs quietly, and its PDF takes the edit over",
            saved && held && quiet_ran && !chip_spun && handed_over,
            json!({
                "held_after_save": held,
                "seconds_to_quiet_build_end": waited.as_secs_f32(),
                "chip_spun": chip_spun,
                "handed_over": handed_over,
            }),
        );

        // Settings' switch turns it off for the project, and the pill goes.
        cx.update(|cx| preview.update(cx, |preview, cx| preview.set_enabled(false, cx)));
        let off = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                *preview.read(cx).state() == State::Off
                    && status::status(preview.read(cx)).is_none()
            })
            .await;
        let remembered = cx.update(|cx| {
            crate::settings::get(cx)
                .live_preview
                .get(&root.to_string_lossy().into_owned())
                .copied()
        });
        steps.check(
            "Settings' switch turns the live preview off for the project, and it stays off",
            off && remembered == Some(false),
            json!({ "remembered": remembered }),
        );
        cx.update(|cx| {
            crate::settings::update(cx, |settings| {
                settings
                    .live_preview
                    .remove(&root.to_string_lossy().into_owned());
            })
        });

        std::fs::write(&chapter, &original)?;
        self.wait_for(cx, Duration::from_secs(8), |_, cx| {
            !editor
                .read(cx)
                .editor()
                .read(cx)
                .text(cx)
                .contains("Typed live")
        })
        .await;
        self.restore_engine(cx, &project, root, &engine).await
    }

    /// Move the pointer to `position` and rest it there (a tooltip shows).
    async fn rest_pointer(
        &self,
        cx: &mut AsyncApp,
        position: gpui::Point<gpui::Pixels>,
    ) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            window.dispatch_event(
                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                    position,
                    pressed_button: None,
                    modifiers: gpui::Modifiers::default(),
                }),
                cx,
            );
        })?;
        self.pause(cx, Duration::from_millis(900)).await;
        Ok(())
    }

    async fn restore_engine(
        &self,
        cx: &mut AsyncApp,
        project: &Entity<crate::project::Project>,
        root: &std::path::Path,
        engine: &str,
    ) -> Result<()> {
        project::update_manifest_settings(
            root,
            ManifestSettings {
                engine: Some(engine.to_string()),
                ..ManifestSettings::default()
            },
        )
        .map_err(anyhow::Error::msg)?;
        cx.update(|cx| project.update(cx, |project, cx| project.reload_manifest(cx)));
        self.pause(cx, Duration::from_millis(300)).await;
        Ok(())
    }
}

/// This file's registration as the e2e module `live_preview` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 80,
    needs: &[],
    setup: false,
    covers: &["gpui/crates/lattice-gpui/src/live_preview"],
    run: |run, cx, steps, fixture| Box::pin(run.live_preview(cx, steps, &fixture.root)),
};
