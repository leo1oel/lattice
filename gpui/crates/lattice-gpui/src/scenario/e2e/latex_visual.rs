//! A `.tex` file's Visual view (`editor_panel/latex_view.rs`,
//! `structured/latex_visual.rs`, the `latex` island), on a document written
//! into the scratch project with a preamble, a section, bold text, inline
//! and display maths, a list and a citation:
//!
//! - choosing Visual in the strip's switch shows the island in place of the
//!   source, and the page draws the document as the Tauri app's Visual mode
//!   does: the preamble folded, the section as a heading, the bold run, the
//!   maths through KaTeX, the list's bullets and the citation as a chip;
//! - opening it writes nothing: the file on disk is the same bytes, and the
//!   buffer is clean;
//! - a jump to a line lands in the page, its caret there; a word typed
//!   there with native keys lands in the file as exactly that word; ⌘Z typed there undoes it through the buffer, and the
//!   file and the page are back to their first text;
//! - text put into the buffer (as the source, or an outside edit, would)
//!   reaches the page;
//! - the strip's Find there opens the page's own search panel, its query
//!   focused, and leaves the source's find bar (which Visual does not draw)
//!   closed;
//! - choosing Source again shows the source editor and hides the page.
//!
//! With `LATTICE_E2E_SHOTS=DIR` it saves the window as the screen composes
//! it, page included, in light and dark (`latex-visual-light.png`,
//! `latex-visual-dark.png`).

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use lattice_settings::LatexView;
use lattice_webview::{Island, IslandState};
use serde_json::{Value, json};

use super::{Run, Steps};
use crate::{
    editor_panel::{EditorPanel, choose_latex_view},
    native,
};

const PAPER: &str = "\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}

\\section{Visual notes}

Some prose with \\textbf{bold words} and $x^2 + y^2$ in it.

\\begin{equation}
  e^{i\\pi} + 1 = 0
\\end{equation}

\\begin{itemize}
  \\item first point
  \\item second point
\\end{itemize}

As argued before~\\cite{e2e-key}.

\\end{document}
";

/// What the page draws, as one JSON object.
const DRAWN: &str = "JSON.stringify({ \
    visual: !!document.querySelector('.source-editor .cm-editor.cm-latex-visual'), \
    preamble: !!document.querySelector('.cm-latex-visual .lx-tex-preamble'), \
    heading: [...document.querySelectorAll('.cm-latex-visual [class*=\"lx-tex-heading\"]')].map((node) => node.textContent).join('|'), \
    bold: document.querySelector('.cm-latex-visual .lx-tex-bold')?.textContent ?? null, \
    katex: document.querySelectorAll('.cm-latex-visual .katex').length, \
    markers: document.querySelectorAll('.cm-latex-visual .lx-tex-marker').length, \
    cite: !!document.querySelector('.cm-latex-visual .lx-tex-cite'), \
    text: document.querySelector('.cm-content')?.textContent ?? '', \
    theme: document.documentElement.dataset.theme || null })";

impl Run {
    pub(super) async fn latex_visual(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        // A save here would build e2e-visual.tex, a root document of its own,
        // and make it the project's live PDF in every window after, which the
        // smoke flow's later steps read as main.tex's. Builds wait for the
        // Build button while the module edits; the file is saved as ever.
        let builds = cx.update(|cx| crate::settings::get(cx).auto_build_mode);
        cx.update(|cx| {
            crate::settings::update(cx, |settings| {
                settings.auto_build_mode = lattice_settings::AutoBuildMode::Manual
            })
        });
        let path = root.join("e2e-visual.tex");
        let result = self.latex_visual_steps(cx, steps, &path).await;
        std::fs::remove_file(&path).ok();
        cx.update(|cx| crate::settings::update(cx, |settings| settings.auto_build_mode = builds));
        result
    }

    async fn latex_visual_steps(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        path: &Path,
    ) -> Result<()> {
        let path = path.to_path_buf();
        std::fs::write(&path, PAPER)?;
        let panel = self.open(cx, &path, None)?;
        cx.update(|cx| choose_latex_view(LatexView::Visual, cx));
        let island = self.latex_visual_drawn(cx, steps, &panel).await;
        if let Some(island) = island {
            self.latex_visual_shots(cx).await?;
            // Opening writes nothing.
            self.pause(cx, Duration::from_millis(1500)).await;
            let unchanged = std::fs::read_to_string(&path).is_ok_and(|text| text == PAPER);
            let clean = cx.update(|cx| !panel.read(cx).is_dirty(cx));
            steps.check(
                "opening a .tex file in its Visual view leaves the file's bytes and the buffer as they were",
                unchanged && clean,
                json!({ "unchanged": unchanged, "clean": clean }),
            );
            self.latex_visual_edit(cx, steps, &path, &panel, &island)
                .await?;
            self.latex_visual_follows(cx, steps, &panel, &island)
                .await?;
            self.latex_visual_find(cx, steps, &panel, &island).await?;
        }
        // The choice is every .tex file's: back to Source for the rest of the run.
        cx.update(|cx| choose_latex_view(LatexView::Source, cx));
        let back = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let panel = panel.read(cx);
                panel.latex_view(cx) == Some(LatexView::Source)
                    && panel
                        .latex_visual_document()
                        .and_then(|document| document.read(cx).island().cloned())
                        .is_none_or(|island| !island.read(cx).native_visible(cx))
            })
            .await;
        steps.check(
            "choosing Source again shows the source editor and hides the Visual view's page",
            back,
            json!({ "back": back }),
        );
        self.close_panel(cx, &panel).await?;
        Ok(())
    }

    /// Save the window, page included, in light and dark, into
    /// `LATTICE_E2E_SHOTS` when it is set; the theme is put back after.
    async fn latex_visual_shots(&self, cx: &mut AsyncApp) -> Result<()> {
        let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") else {
            return Ok(());
        };
        let before = cx.update(|cx| crate::settings::get(cx).theme_preference);
        for (name, theme) in [
            ("light", lattice_settings::ThemePreference::Light),
            ("dark", lattice_settings::ThemePreference::Dark),
        ] {
            cx.update(|cx| crate::settings::update(cx, |settings| settings.theme_preference = theme));
            self.pause(cx, Duration::from_millis(800)).await;
            let number = native::window_number(self.native(cx)?);
            native::order_front(self.native(cx)?);
            self.pause(cx, Duration::from_millis(300)).await;
            let out = Path::new(&dir).join(format!("latex-visual-{name}.png"));
            std::process::Command::new("screencapture")
                .args(["-x", "-o", &format!("-l{number}")])
                .arg(&out)
                .status()
                .ok();
        }
        cx.update(|cx| crate::settings::update(cx, |settings| settings.theme_preference = before));
        Ok(())
    }

    /// Wait for the Visual view's page, and check what it draws.
    async fn latex_visual_drawn(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
    ) -> Option<Entity<Island>> {
        let drawn = self
            .wait_for(cx, Duration::from_secs(40), |_, cx| {
                panel
                    .read(cx)
                    .latex_visual_document()
                    .is_some_and(|document| document.read(cx).is_drawn())
            })
            .await;
        let island = cx.update(|cx| {
            panel
                .read(cx)
                .latex_visual_document()
                .and_then(|document| document.read(cx).island().cloned())
        });
        let Some(island) = island.filter(|_| drawn) else {
            steps.check(
                "choosing Visual for a .tex file shows its Visual view drawn",
                false,
                json!({ "drawn": drawn }),
            );
            return None;
        };
        // KaTeX and the widgets draw once the editor has measured its viewport.
        let mut facts = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            facts = self.evaluate(cx, &island, DRAWN).await;
            if facts["katex"].as_u64().is_some_and(|count| count >= 2) && facts["cite"] == true {
                break;
            }
            self.pause(cx, Duration::from_millis(200)).await;
        }
        let (state, visible) = cx.update(|cx| {
            let island = island.read(cx);
            (island.state().clone(), island.native_visible(cx))
        });
        steps.check(
            "a .tex file's Visual view draws the document as the Tauri app's Visual mode does: the preamble folded, the section as a heading, the bold run, KaTeX's maths, the list's bullets and the citation as a chip",
            state == IslandState::Ready
                && visible
                && facts["visual"] == true
                && facts["preamble"] == true
                && facts["heading"]
                    .as_str()
                    .is_some_and(|heading| heading.contains("Visual notes"))
                && facts["bold"] == "bold words"
                && facts["katex"].as_u64().is_some_and(|count| count >= 2)
                && facts["markers"].as_u64().is_some_and(|count| count >= 2)
                && facts["cite"] == true
                && facts["theme"].is_string(),
            json!({ "state": format!("{state:?}"), "visible": visible, "page": facts }),
        );
        Some(island)
    }

    /// Jump to the prose's line, type a word there with native keys, then
    /// undo it with ⌘Z there.
    async fn latex_visual_edit(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        path: &Path,
        panel: &Entity<EditorPanel>,
        island: &Entity<Island>,
    ) -> Result<()> {
        let Some(bounds) = cx.update(|cx| island.read(cx).bounds(cx)) else {
            steps.check(
                "a word typed into the Visual view is saved",
                false,
                json!("no bounds"),
            );
            return Ok(());
        };
        let native = self.native(cx)?;
        native::send_click(native, bounds.center())?;
        self.wait_for(cx, Duration::from_secs(3), |_, cx| {
            island.read(cx).page_focused()
        })
        .await;
        // The prose is line 7: the jump puts the caret at its start.
        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| panel.update(cx, |panel, cx| panel.go_to_line(7, window, cx))
        })?;
        let mut placed = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(3) {
            placed = self
                .evaluate(
                    cx,
                    island,
                    "JSON.stringify(document.querySelector('.cm-activeLine')?.textContent ?? null)",
                )
                .await;
            if placed.as_str().is_some_and(|line| line.contains("Some prose")) {
                break;
            }
            self.pause(cx, Duration::from_millis(100)).await;
        }
        let caret = cx.update(|cx| panel.read(cx).cursor());
        steps.check(
            "a jump to a line lands in the Visual view, its caret on that line and the status bar's",
            placed.as_str().is_some_and(|line| line.contains("Some prose")) && caret.0 == 7,
            json!({ "line": placed, "caret": [caret.0, caret.1] }),
        );
        // A native click at the line's first character gives the page the
        // keyboard with the caret there.
        let rect = self
            .evaluate(
                cx,
                island,
                "JSON.stringify((() => { const r = document.querySelector('.cm-activeLine')?.getBoundingClientRect(); \
                 return r ? { x: r.left + 1, y: r.top + r.height / 2 } : null; })())",
            )
            .await;
        if let (Some(x), Some(y)) = (rect["x"].as_f64(), rect["y"].as_f64()) {
            let at = bounds.origin + gpui::point(gpui::px(x as f32), gpui::px(y as f32));
            native::send_click(native, at)?;
            self.wait_for(cx, Duration::from_secs(3), |_, cx| {
                island.read(cx).page_focused()
            })
            .await;
            self.pause(cx, Duration::from_millis(150)).await;
        }
        for character in "quokka ".chars() {
            native::send_key(native, character, false)?;
            self.pause(cx, Duration::from_millis(40)).await;
        }
        let expected = PAPER.replacen("Some prose", "quokka Some prose", 1);
        let saved = self
            .wait_for(cx, Duration::from_secs(10), |_, _| {
                std::fs::read_to_string(path).is_ok_and(|text| text.contains("quokka"))
            })
            .await;
        let text = std::fs::read_to_string(path).unwrap_or_default();
        steps.check(
            "a word typed into the Visual view with native keys is saved as exactly that word, every other byte of the file as it was",
            saved && text == expected,
            json!({ "placed": placed, "saved": saved, "text": if text == expected { Value::Null } else { json!(text) } }),
        );

        native::send_key(native, 'z', true)?;
        let undone = self
            .wait_for(cx, Duration::from_secs(10), |_, _| {
                std::fs::read_to_string(path).is_ok_and(|text| text == PAPER)
            })
            .await;
        // The page takes the buffer's text once the typing pause has passed.
        let mut page = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            page = self.evaluate(cx, island, DRAWN).await;
            if page["text"].as_str().is_some_and(|text| !text.contains("quokka")) {
                break;
            }
            self.pause(cx, Duration::from_millis(150)).await;
        }
        steps.check(
            "⌘Z typed in the Visual view undoes the word through the buffer: the file and the page are back as they were",
            undone && page["text"].as_str().is_some_and(|text| !text.contains("quokka")),
            json!({
                "undone": undone,
                "text": if undone { Value::Null } else { json!(std::fs::read_to_string(path).unwrap_or_default()) },
            }),
        );
        Ok(())
    }

    /// Text put into the buffer reaches the page.
    async fn latex_visual_follows(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        island: &Entity<Island>,
    ) -> Result<()> {
        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                // Before `\end{document}`: Visual mode draws nothing after it.
                let editor = panel.read(cx).editor().clone();
                editor.update(cx, |editor, cx| {
                    let text = editor.buffer().read(cx).snapshot(cx).text();
                    let at = text.find("\\end{document}").unwrap_or(text.len());
                    let at = editor::MultiBufferOffset(at);
                    editor.transact(window, cx, |editor, _, cx| {
                        editor.edit([(at..at, "Written in the source.\n\n")], cx)
                    });
                });
            }
        })?;
        let mut followed = false;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(6) {
            let page = self.evaluate(cx, island, DRAWN).await;
            followed = page["text"]
                .as_str()
                .is_some_and(|text| text.contains("Written in the source."));
            if followed {
                break;
            }
            self.pause(cx, Duration::from_millis(150)).await;
        }
        steps.check(
            "text put into the buffer reaches the Visual view",
            followed,
            json!({ "followed": followed }),
        );
        Ok(())
    }
}

impl Run {
    /// The strip's Find in the Visual view opens the page's own search
    /// panel, never the source's find bar, which Visual does not draw.
    async fn latex_visual_find(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        island: &Entity<Island>,
    ) -> Result<()> {
        const SEARCH: &str = "JSON.stringify({ \
            panel: !!document.querySelector('.cm-panel.cm-search'), \
            focused: document.activeElement?.closest?.('.cm-search') != null })";
        let focus = cx.update(|cx| {
            panel
                .read(cx)
                .latex_visual_document()
                .and_then(|document| document.read(cx).focus_handle(cx))
        });
        if let Some(focus) = focus {
            self.with_window(cx, move |_, window, cx| {
                focus.dispatch_action(&zed_actions::buffer_search::Deploy::find(), window, cx)
            })?;
        }
        let mut page = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            page = self.evaluate(cx, island, SEARCH).await;
            if page["panel"] == true && page["focused"] == true {
                break;
            }
            self.pause(cx, Duration::from_millis(150)).await;
        }
        let bar_open = cx.update(|cx| panel.read(cx).find_bar().read(cx).is_open());
        steps.check(
            "the strip's Find in the Visual view opens the page's own search panel with its query focused, and leaves the source's find bar closed",
            page["panel"] == true && page["focused"] == true && !bar_open,
            json!({ "page": page, "source_find_bar_open": bar_open }),
        );
        Ok(())
    }
}

/// This file's registration as the e2e module `latex_visual` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 82,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_panel/latex_view.rs",
        "gpui/crates/lattice-gpui/src/structured/latex_visual.rs",
        "gpui/islands/latex/",
        "src/editor/latex/visual/",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.latex_visual(cx, steps, &fixture.root)),
};
