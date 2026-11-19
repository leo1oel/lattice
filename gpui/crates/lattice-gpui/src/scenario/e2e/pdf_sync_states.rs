//! The PDF toolbar's states the Tauri app shows, end to end: Reveal cursor
//! in PDF waits and spins while a jump is located (in the panel and in the
//! PDF's own window, and disabled with the caret in a .bib file); focus mode
//! gives the PDF's place up to its own window and takes it back; the wheel
//! over the zoom value steps the zoom; a PDF of the project that fails to
//! load has no build hint; and a ⌘-double-click on a figure asks before it
//! opens the SVG it was drawn in.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::{pdf::PdfViewEvent, scenario::Run, shell::ForwardSync};

impl Run {
    pub(super) async fn pdf_states(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let reveal = |cx: &mut AsyncApp| {
            cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().read(cx).reveal_state())
        };
        let chapter = root.join("chapters/intro.tex");

        // Reveal cursor in PDF: enabled in a .tex file, waiting and
        // spinning from the jump's start until it lands, then enabled again.
        self.open(cx, &chapter, Some(3))?;
        self.pause(cx, Duration::from_millis(400)).await;
        let before = reveal(cx);
        let during = self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.forward_sync(&ForwardSync, window, cx));
            shell.read(cx).pdf().read(cx).live_view().read(cx).reveal_state()
        })?;
        self.snapshot(cx, "pdf-locating").await;
        let ended = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).pdf().read(cx).live_view().read(cx).reveal_state() == (false, false)
            })
            .await;
        steps.check(
            "PDF: Reveal cursor in PDF is disabled and spins while the jump is located, then comes back",
            before == (false, false) && during == (true, true) && ended,
            json!({ "before": before, "during": during, "ended": ended }),
        );

        // With the caret in a .bib file it waits; in its own window too.
        self.open(cx, &root.join("references.bib"), Some(1))?;
        self.pause(cx, Duration::from_millis(400)).await;
        let in_bib = reveal(cx);
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.detach(window, cx));
        })?;
        self.pause(cx, Duration::from_millis(800)).await;
        let detached = cx.update(|cx| self.shell.read(cx).pdf().read(cx).in_window());
        let window_bib = reveal(cx);
        self.open(cx, &chapter, Some(3))?;
        self.pause(cx, Duration::from_millis(400)).await;
        let window_tex = reveal(cx);
        let window_during = self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.forward_sync(&ForwardSync, window, cx));
            shell.read(cx).pdf().read(cx).live_view().read(cx).reveal_state()
        })?;
        let window_ended = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).pdf().read(cx).live_view().read(cx).reveal_state() == (false, false)
            })
            .await;
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.dock(true, window, cx));
        })?;
        self.pause(cx, Duration::from_millis(600)).await;
        steps.check(
            "PDF: in a .bib file Reveal cursor in PDF waits, and the PDF's own window shows the same waiting and locating",
            in_bib.0 && detached && window_bib.0 && window_tex == (false, false) && window_during == (true, true) && window_ended,
            json!({ "bib": in_bib, "detached": detached, "window_bib": window_bib, "window_tex": window_tex, "window_during": window_during, "window_ended": window_ended }),
        );

        self.focus_detach(cx, steps).await?;
        self.zoom_wheel(cx, steps).await?;
        self.file_pdf_failure(cx, steps, root).await?;
        self.figure_svg_asks(cx, steps, root).await
    }

    /// Focus mode with the PDF beside the document: its own window takes it
    /// out of focus mode's layout, and Return brings it back there.
    async fn focus_detach(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let pdf_before = cx.update(|cx| crate::shell::workspaces::Workspaces::global(cx).focus_pdf());
        let shown = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                let shell = self.shell.read(cx);
                (
                    shell.in_focus_mode(),
                    shell.workspace().read(cx).engine().placement_of("pdf")
                        != trellis::runtime::engine::ViewPlacement::Hidden,
                )
            })
        };
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.set_focus_mode(true, window, cx);
                shell.set_focus_pdf(true, window, cx);
            })
        })?;
        self.pause(cx, Duration::from_millis(500)).await;
        let before = shown(cx);
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.detach(window, cx));
        })?;
        self.pause(cx, Duration::from_millis(800)).await;
        let during = shown(cx);
        let kept = cx.update(|cx| crate::shell::workspaces::Workspaces::global(cx).focus_pdf());
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.dock(true, window, cx));
        })?;
        self.pause(cx, Duration::from_millis(800)).await;
        let after = shown(cx);
        self.snapshot(cx, "pdf-focus-returned").await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.set_focus_mode(false, window, cx))
        })?;
        cx.update(|cx| {
            crate::shell::workspaces::Workspaces::update(cx, |library| library.set_focus_pdf(pdf_before))
        });
        self.pause(cx, Duration::from_millis(400)).await;
        steps.check(
            "PDF: in focus mode its own window takes the PDF out of the layout, and Return to workspace shows it beside the document again",
            before == (true, true) && during == (true, false) && kept && after == (true, true),
            json!({ "before": before, "during": during, "focus_pdf_kept": kept, "after": after }),
        );
        Ok(())
    }

    /// The wheel over the zoom value: up zooms in a step, down zooms out
    /// (`stepZoom(deltaY < 0 ? 1 : -1)` in `use-pdf-zoom.ts`). The docked
    /// panel is narrow here and folds the value away, so this runs in the
    /// PDF's own window, whose toolbar shows it.
    async fn zoom_wheel(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        lattice_ui::parity::enable();
        // The fit the wheel leaves, put back after for the modules that follow.
        let fit_before = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().read(cx).fit());
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.detach(window, cx));
        })?;
        self.pause(cx, Duration::from_millis(800)).await;
        let handle = cx.update(|cx| self.shell.read(cx).pdf().read(cx).window_handle());
        let draw = |cx: &mut AsyncApp| {
            if let Some(handle) = handle {
                handle
                    .update(cx, |_, window, cx| {
                        window.refresh();
                        let _ = window.draw(cx);
                    })
                    .ok();
            }
        };
        let mut zoom = None;
        for _ in 0..10 {
            lattice_ui::parity::forget("pdf/zoom");
            draw(cx);
            self.pause(cx, Duration::from_millis(200)).await;
            zoom = lattice_ui::parity::regions().get("pdf/zoom").and_then(|region| region.bounds);
            if zoom.is_some() {
                break;
            }
        }
        let scale = |cx: &mut AsyncApp| cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().read(cx).scale());
        let start = scale(cx);
        let wheel = |cx: &mut AsyncApp, at: gpui::Point<gpui::Pixels>, dy: f32| {
            if let Some(handle) = handle {
                handle
                    .update(cx, move |_, window, cx| {
                        window.dispatch_event(
                            gpui::PlatformInput::Scroll(gpui::ScrollEvent {
                                position: at,
                                delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(dy))),
                                modifiers: gpui::Modifiers::default(),
                                touch_phase: gpui::TouchPhase::Moved,
                                source: gpui::ScrollSource::Pointer,
                            }),
                            cx,
                        );
                    })
                    .ok();
            }
        };
        let (mut up, mut down) = (start, start);
        if let Some(zoom) = zoom {
            wheel(cx, zoom.center(), 20.);
            self.pause(cx, Duration::from_millis(400)).await;
            up = scale(cx);
            draw(cx);
            wheel(cx, zoom.center(), -20.);
            self.pause(cx, Duration::from_millis(400)).await;
            down = scale(cx);
        }
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.dock(true, window, cx));
        })?;
        self.pause(cx, Duration::from_millis(600)).await;
        if let Some(mode) = fit_before {
            self.with_window(cx, move |shell, _, cx| {
                let view = shell.read(cx).pdf().read(cx).live_view().clone();
                view.update(cx, |view, cx| {
                    if view.fit() != Some(mode) {
                        view.apply_fit(mode, cx);
                    }
                });
            })?;
            self.pause(cx, Duration::from_millis(300)).await;
        }
        steps.check(
            "PDF: the wheel over the zoom value zooms in when turned up and out when turned down",
            zoom.is_some() && up > start && down < up,
            json!({ "probe": format!("{zoom:?}"), "start": start, "up": up, "down": down }),
        );
        Ok(())
    }

    /// A PDF of the project that does not load says so without "Try
    /// building the project again", which only a compiled PDF offers
    /// (`loadErrorHint`).
    async fn file_pdf_failure(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let broken = root.join("broken-check.pdf");
        std::fs::write(&broken, b"%PDF-1.4\nthis is not a PDF\n")?;
        self.open(cx, &broken, None).ok();
        let failed = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).file_pdf_tabs().iter().any(|tab| tab.read(cx).live_view().read(cx).load_failure().0.is_some())
            })
            .await;
        self.snapshot(cx, "pdf-file-load-failure").await;
        let failure = cx.update(|cx| {
            self.shell
                .read(cx)
                .file_pdf_tabs()
                .iter()
                .map(|tab| tab.read(cx).live_view().read(cx).load_failure())
                .find(|failure| failure.0.is_some())
        });
        let live = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().read(cx).load_failure().1);
        steps.check(
            "PDF: a project PDF that fails to load names the failure without the build hint, which the compiled PDF keeps",
            failed && failure.as_ref().is_some_and(|failure| !failure.1) && live,
            json!({ "failed": failed, "failure": failure.map(|f| (f.0.map(|m| m.to_string()), f.1)), "compiled_offers_build": live }),
        );
        std::fs::remove_file(&broken).ok();
        Ok(())
    }

    /// A figure drawn in an SVG: its entry names the drawing on its first
    /// line, SyncTeX names the `.pdf_tex` beside it, and a ⌘-double-click
    /// on it asks before opening the SVG; it is not answered here, so
    /// nothing outside the app opens.
    async fn figure_svg_asks(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let figures = root.join("figures-check");
        std::fs::create_dir_all(&figures)?;
        std::fs::write(figures.join("plot.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n")?;
        std::fs::write(
            figures.join("plot.tex"),
            "% editable-figure source: plot.svg\n\\input{figures-check/plot.pdf_tex}\n",
        )?;
        std::fs::write(figures.join("plot.pdf_tex"), "Figurewords drawn in the plot.\n")?;
        let document = root.join("figure-check.tex");
        std::fs::write(
            &document,
            "\\documentclass{article}\n\\begin{document}\n\\input{figures-check/plot.tex}\n\n\\end{document}\n",
        )?;
        self.open(cx, &document, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (built, _) = self.build(cx).await?;
        let shown = self
            .wait_for(cx, Duration::from_secs(30), |shell, cx| {
                let shell = shell.read(cx);
                shell.live_document() == Some("figure-check.tex") && shell.pdf().read(cx).page_count(cx) > 0
            })
            .await;
        let pdf = root.join("figure-check.pdf");
        let found = if pdf.is_file() { self.find_word_in(cx, &pdf, "Figurewords").await? } else { None };
        let host = cx.update(crate::confirm::install);
        let mut question = None;
        if let Some((page, (x, y), word)) = found.clone() {
            self.with_window(cx, move |shell, _, cx| {
                let view = shell.read(cx).pdf().read(cx).live_view().clone();
                view.update(cx, |_, cx| cx.emit(PdfViewEvent::SourceAt { page, x, y, word, figure: true }));
            })?;
            for _ in 0..25 {
                self.pause(cx, Duration::from_millis(200)).await;
                question = cx.update(|cx| host.read(cx).question().map(|q| q.to_string()));
                if question.is_some() {
                    break;
                }
            }
        }
        self.snapshot(cx, "pdf-figure-svg-ask").await;
        let asked = question.as_deref().is_some_and(|q| q.contains("plot.svg"));
        // Dismissed unanswered, so no browser opens.
        if question.is_some() {
            self.press(cx, '\u{1b}', false).await.ok();
            self.pause(cx, Duration::from_millis(300)).await;
        }
        let dismissed = cx.update(|cx| !host.read(cx).is_open());
        steps.check(
            "PDF: a ⌘-double-click on a figure drawn in an SVG asks before opening plot.svg",
            built && shown && found.is_some() && asked && dismissed,
            json!({ "built": built, "shown": shown, "found": found.is_some(), "question": question, "dismissed": dismissed }),
        );

        // main.tex built again takes the live PDF back.
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.build(cx).await?;
        self.wait_for(cx, Duration::from_secs(20), |shell, cx| shell.read(cx).live_document() == Some("main.tex"))
            .await;
        Ok(())
    }
}
