//! A paper dragged from the Papers list into an editor (`papers/drag.rs`,
//! `editor_panel/papers.rs`, `gpui/islands/markdown/paper-drag.ts`), with a
//! saved paper in the library (a bundle and its entry written into the
//! scratch copy, as an import leaves them):
//!
//! - over a LaTeX source the drop caret goes after the word under the
//!   pointer, and let go there `~\citep{key}` goes in; dropped on a key of
//!   a `\citep{…}` the key joins its list instead (the Tauri app's
//!   `paper-drop.test.ts`);
//! - over a Markdown source it goes in at the pointer as an `@key` link to
//!   the paper's reading file;
//! - over the Markdown file's visual editor the page draws its drop cursor,
//!   and let go there the paper is an `@key` citation at the pointer;
//! - the visual editor's `@` menu lists the library's papers.
//!
//! The bibliography, the bundle and the files are put back afterwards. With
//! `LATTICE_E2E_SHOTS=DIR` it saves the drags in light and dark.

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity, Pixels, Point};
use serde_json::{Value, json};

use super::{Steps, drops::PointerStep};
use crate::{editor_panel::EditorPanel, papers::PapersPanel, scenario::Run};

const BUNDLE: &str = ".research/papers/1706.03762";
const ENTRY: &str = "\n@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  author = {Vaswani, Ashish and Shazeer, Noam},\n  journal = {NeurIPS},\n  year = {2017},\n  eprint = {1706.03762}\n}\n";
const PAPER: &str = "---\ntitle: Attention Is All You Need\n---\n\n# Attention Is All You Need\n\nWe propose the Transformer.\n";
const TITLE: &str = "Attention Is All You Need";
const LATEX: &str = "Prior work shows this.\nSee \\citep{knuth1984}.\n";
const LATEX_PATH: &str = "chapters/cite-drop.tex";
const NOTES: &str = "# Reading notes\n\nSome notes on attention.\n";
const NOTES_PATH: &str = "notes/paper-notes.md";
/// The paper's reading file from `notes/`.
const LINK: &str = "[@vaswani2017attention](../.research/papers/1706.03762/paper.md)";

impl Run {
    async fn paper_drag(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let bibliography = root.join("references.bib");
        let original = std::fs::read_to_string(&bibliography)
            .context("the e2e project needs references.bib")?;
        std::fs::create_dir_all(root.join(BUNDLE))?;
        std::fs::write(root.join(BUNDLE).join("paper.md"), PAPER)?;
        std::fs::create_dir_all(root.join("notes"))?;
        std::fs::write(root.join(LATEX_PATH), LATEX)?;
        std::fs::write(root.join(NOTES_PATH), NOTES)?;
        std::fs::write(&bibliography, format!("{original}{ENTRY}"))?;
        let papers = cx.update(|cx| self.shell.read(cx).papers().clone());

        let outcome = self.paper_drag_steps(cx, steps, root, &papers).await;
        std::fs::write(&bibliography, original)?;
        std::fs::remove_dir_all(root.join(BUNDLE)).ok();
        std::fs::remove_file(root.join(LATEX_PATH)).ok();
        std::fs::remove_dir_all(root.join("notes")).ok();
        outcome
    }

    async fn paper_drag_steps(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        papers: &Entity<PapersPanel>,
    ) -> Result<()> {
        let listed = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                papers
                    .read(cx)
                    .papers
                    .iter()
                    .any(|paper| paper.title == TITLE && paper.has_full_text)
            })
            .await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.show_view("papers", false, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(500)).await;
        if !listed {
            steps.check(
                "the library lists the saved paper to drag",
                false,
                json!({}),
            );
            return Ok(());
        }

        let tex = self.open(cx, &root.join(LATEX_PATH), Some(1))?;
        self.pause(cx, Duration::from_millis(400)).await;
        self.paper_drag_latex(cx, steps, papers, &tex).await?;

        let notes = self.open(cx, &root.join(NOTES_PATH), None)?;
        let drawn = self
            .wait_for(cx, Duration::from_secs(40), |_, cx| {
                notes
                    .read(cx)
                    .markdown_document()
                    .is_some_and(|document| document.read(cx).is_drawn())
            })
            .await;
        self.paper_drag_markdown_source(cx, steps, papers, &notes)
            .await?;
        if drawn {
            self.paper_drag_markdown_page(cx, steps, papers, &notes)
                .await?;
        } else {
            steps.check(
                "the Markdown file's visual editor is drawn for the paper's drop",
                false,
                json!({}),
            );
        }
        self.close_panel(cx, &notes).await?;
        self.close_panel(cx, &tex).await?;
        Ok(())
    }

    /// Drag the saved paper's row to `at`, holding it there: where the drop
    /// would go is checked, and a shot taken, before [`Run::paper_release`].
    async fn paper_hold(
        &self,
        cx: &mut AsyncApp,
        papers: &Entity<PapersPanel>,
        at: Point<Pixels>,
    ) -> Result<()> {
        let row = cx
            .update(|cx| papers.read(cx).row_bounds(TITLE, cx))
            .context("the paper's row is laid out")?
            .center();
        self.pointer(cx, PointerStep::Down, row).await?;
        self.pointer(
            cx,
            PointerStep::Move,
            row + gpui::point(gpui::px(12.), gpui::px(0.)),
        )
        .await?;
        self.pointer(cx, PointerStep::Move, at).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        Ok(())
    }

    async fn paper_release(&self, cx: &mut AsyncApp, at: Point<Pixels>) -> Result<()> {
        self.pointer(cx, PointerStep::Up, at).await
    }

    /// The point before byte `offset` of `editor`'s text.
    fn paper_point(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<EditorPanel>,
        offset: usize,
    ) -> Result<Point<Pixels>> {
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| editor.point_before(offset, window, cx))
        })?
        .context("the drop point is on screen")
    }

    /// Wait for `editor`'s text to be `expected`, and say what it was.
    async fn paper_text(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<EditorPanel>,
        expected: &str,
    ) -> String {
        self.wait_for(cx, Duration::from_secs(4), |_, cx| {
            editor.read(cx).text(cx) == expected
        })
        .await;
        cx.update(|cx| editor.read(cx).text(cx))
    }

    async fn paper_drag_latex(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &Entity<PapersPanel>,
        tex: &Entity<EditorPanel>,
    ) -> Result<()> {
        // Inside "work": the caret goes after it.
        let inside = LATEX.find("work").context("the word")? + 2;
        let after = LATEX.find(" shows").context("the word's end")?;
        let at = self.paper_point(cx, tex, inside)?;
        let expected_caret = self.paper_point(cx, tex, after)?;
        self.paper_hold(cx, papers, at).await?;
        let caret = cx.update(|cx| tex.read(cx).paper_drop_caret(cx));
        self.paper_shots(cx, "paper-drag-latex").await;
        self.paper_release(cx, at).await?;
        let cited = LATEX.replacen("work", "work~\\citep{vaswani2017attention}", 1);
        let text = self.paper_text(cx, tex, &cited).await;
        let caret_x = caret.map(|caret| f32::from(caret.left()));
        steps.check(
            "a paper dragged over a LaTeX source draws the drop caret after the word under the pointer, and goes in there as ~\\citep{key}",
            caret_x.is_some_and(|x| (x - f32::from(expected_caret.x)).abs() < 3.) && text == cited,
            json!({ "caret_x": caret_x, "expected_x": f32::from(expected_caret.x), "text": text }),
        );

        // On a key of a citation: the key joins its list, after it.
        let key = cited.find("knuth1984").context("the key")? + 7;
        let at = self.paper_point(cx, tex, key)?;
        self.paper_hold(cx, papers, at).await?;
        self.paper_release(cx, at).await?;
        let merged = cited.replacen("{knuth1984}", "{knuth1984, vaswani2017attention}", 1);
        let text = self.paper_text(cx, tex, &merged).await;
        steps.check(
            "a paper dropped on a key of a \\citep joins its key list",
            text == merged,
            json!({ "text": text }),
        );
        Ok(())
    }

    async fn paper_drag_markdown_source(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &Entity<PapersPanel>,
        notes: &Entity<EditorPanel>,
    ) -> Result<()> {
        let end = NOTES.find("attention.").context("the word")? + "attention".len();
        let at = self.paper_point(cx, notes, end)?;
        self.paper_hold(cx, papers, at).await?;
        let caret = cx.update(|cx| notes.read(cx).paper_drop_caret(cx).is_some());
        self.paper_shots(cx, "paper-drag-markdown-source").await;
        self.paper_release(cx, at).await?;
        let mut expected = NOTES.to_string();
        expected.insert_str(end, LINK);
        let text = self.paper_text(cx, notes, &expected).await;
        steps.check(
            "a paper dropped into a Markdown source goes in at the pointer as an @key link to its reading file",
            caret && text == expected,
            json!({ "caret": caret, "text": text }),
        );
        Ok(())
    }

    async fn paper_drag_markdown_page(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        papers: &Entity<PapersPanel>,
        notes: &Entity<EditorPanel>,
    ) -> Result<()> {
        let island = cx
            .update(|cx| {
                notes
                    .read(cx)
                    .markdown_document()
                    .and_then(|document| document.read(cx).island().cloned())
            })
            .context("the visual editor's page")?;
        // The page has the source drop by now.
        self.pause(cx, Duration::from_millis(1500)).await;
        // After "notes" in the paragraph, in the page's pixels.
        let spot = self
            .evaluate(
                cx,
                &island,
                "(() => { const p = [...document.querySelectorAll('.lx-md-surface p')].find((node) => node.textContent.includes('Some notes')); \
                 if (!p) return JSON.stringify(null); const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); \
                 const text = walker.nextNode(); const at = text.textContent.indexOf(' on'); const range = document.createRange(); \
                 range.setStart(text, at); range.collapse(true); const rect = range.getBoundingClientRect(); \
                 return JSON.stringify({ x: rect.left + 1, y: rect.top + rect.height / 2 }); })()",
            )
            .await;
        let page = cx.update(|cx| island.read(cx).bounds(cx));
        let (Some(x), Some(y), Some(page)) = (spot["x"].as_f64(), spot["y"].as_f64(), page) else {
            steps.check(
                "a paper dropped on the visual editor is an @key citation at the pointer",
                false,
                json!({ "spot": spot, "page": format!("{page:?}") }),
            );
            return Ok(());
        };
        let at = page.origin + gpui::point(gpui::px(x as f32), gpui::px(y as f32));
        self.paper_hold(cx, papers, at).await?;
        let cursor = self
            .evaluate(
                cx,
                &island,
                "JSON.stringify(!!document.querySelector('.lx-md-drop-cursor'))",
            )
            .await;
        self.island_shot(cx, "paper-drag-markdown-page").await?;
        self.paper_release(cx, at).await?;
        let cited = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                notes.read(cx).text(cx).contains(&format!("notes{LINK} on"))
            })
            .await;
        let text = cx.update(|cx| notes.read(cx).text(cx));
        steps.check(
            "over the visual editor a paper draws the page's drop cursor, and let go is an @key citation at the pointer",
            cursor == Value::Bool(true) && cited,
            json!({ "cursor": cursor, "text": text }),
        );

        // The `@` menu offers the library's papers.
        let typed = self.markdown_type(cx, &island, " @attention").await?;
        let mut menu = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(4) {
            menu = self
                .evaluate(
                    cx,
                    &island,
                    "JSON.stringify({ options: [...document.querySelectorAll('.lx-md-menu.is-citations .lx-md-menu-option')].map((node) => node.textContent), \
                     empty: document.querySelector('.lx-md-menu.is-citations .lx-md-menu-empty')?.textContent ?? null })",
                )
                .await;
            if menu["options"]
                .as_array()
                .is_some_and(|options| !options.is_empty())
            {
                break;
            }
            self.pause(cx, Duration::from_millis(200)).await;
        }
        self.island_shot(cx, "paper-drag-markdown-menu").await?;
        let offered = menu["options"].as_array().is_some_and(|options| {
            options
                .iter()
                .any(|option| option.as_str().is_some_and(|text| text.contains(TITLE)))
        });
        steps.check(
            "the visual editor's @ menu lists the library's papers",
            offered,
            json!({ "typed": typed, "menu": menu }),
        );
        Ok(())
    }

    /// The window offscreen (no page in it), light and dark, while the drag
    /// is held.
    async fn paper_shots(&self, cx: &mut AsyncApp, name: &str) {
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return;
        }
        use lattice_ui::{Appearance, LatticeTheme};
        for (appearance, suffix) in [(Appearance::Light, "light"), (Appearance::Dark, "dark")] {
            cx.update(|cx| LatticeTheme::set_appearance(appearance, cx));
            self.insert_shot(cx, &format!("{name}-{suffix}")).await;
        }
        cx.update(|cx| LatticeTheme::set_appearance(Appearance::Light, cx));
    }
}

/// This file's registration as the e2e module `paper_drag` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 53,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/papers/drag",
        "gpui/crates/lattice-gpui/src/papers/drag.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/papers.rs",
        "gpui/crates/lattice-gpui/src/structured/markdown_host.rs",
        "gpui/islands/markdown/",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.paper_drag(cx, steps, &fixture.root)),
};
